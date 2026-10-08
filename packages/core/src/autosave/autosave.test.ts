import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import { Autosave, type AutosaveJournal, type SaveState } from './autosave.js';
import { encode, decode, escapesOutOfBand } from '../test-support.js';
const DEBOUNCE = 400;
const P = 'p/project.json';
const AMS = 'amsterdam-1625/project.json';

const microtasks = () => vi.advanceTimersByTimeAsync(0);

const FULL_JOURNAL: AutosaveJournal = {
	record: () => {
		throw new Error('the journal is full');
	},
	forget: () => undefined
};

const outcomeOf = (promise: Promise<unknown>) =>
	promise.then(
		() => 'resolved' as const,
		() => 'rejected' as const
	);

const watch = <T>(promise: Promise<T>) => {
	const seen: { value: T | 'still waiting' } = { value: 'still waiting' };
	void promise.then((value) => (seen.value = value));
	return seen;
};

describe('Autosave', () => {
	let store: MemoryProjectStore;
	let writes: string[];
	let autosave: Autosave;
	let states: SaveState[];
	let writeThrough: MemoryProjectStore['write'];
	const read = async (path = P) => decode(await store.read(path));

	beforeEach(() => {
		vi.useFakeTimers();
		store = new MemoryProjectStore();
		writes = [];
		writeThrough = store.write.bind(store);
		vi.spyOn(store, 'write').mockImplementation(async (path, bytes) => {
			writes.push(path);
			await writeThrough(path, bytes);
		});
		autosave = new Autosave(store, { debounceMs: DEBOUNCE });
		states = [];
		autosave.subscribe((state) => states.push(state));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const holdWrites = () => {
		let land = (): void => undefined;
		vi.spyOn(store, 'write').mockImplementation(
			(path) =>
				new Promise<void>((resolve) => {
					land = () => {
						writes.push(path);
						resolve();
					};
				})
		);
		return () => land();
	};

	const neverSettle = () =>
		vi.spyOn(store, 'write').mockImplementation(() => new Promise<never>(() => undefined));

	const journallingAutosave = () => {
		const journalled = new Map<string, Uint8Array>();
		const journalling = new Autosave(store, {
			debounceMs: DEBOUNCE,
			journal: {
				record: (path, bytes) => void journalled.set(path, bytes),
				forget: (path) => void journalled.delete(path)
			}
		});
		return { journalled, journalling };
	};

	const forgetThrows = (forgotten: string[] = []) =>
		new Autosave(store, {
			debounceMs: DEBOUNCE,
			journal: {
				record: () => undefined,
				forget: (path) => {
					forgotten.push(path);
					throw new Error('forget blew up');
				}
			}
		});

	describe('debouncing per file (rule 2)', () => {
		it('collapses two writes to the same path inside the window onto one timer and one write', async () => {
			autosave.queue(P, encode('first'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
			autosave.queue(P, encode('second'));
			expect(vi.getTimerCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			expect(writes).toEqual([P]);
			expect(await read()).toBe('second');
		});

		it('does not batch different paths together: each keeps its own deadline', async () => {
			autosave.queue(P, encode('a'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
			autosave.queue('p/annotations/one.geojson', encode('b'));

			await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
			expect(writes).toEqual([P]);

			await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
			expect(writes).toEqual([P, 'p/annotations/one.geojson']);
		});

		it('arms exactly one debounce, writes nothing before it closes, and none once it has landed', async () => {
			autosave.queue(P, encode('a'));
			expect(vi.getTimerCount()).toBe(1);

			await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
			expect(writes).toEqual([]);
			await vi.advanceTimersByTimeAsync(1);

			expect({ timers: vi.getTimerCount(), state: autosave.state }).toEqual({
				timers: 0,
				state: 'saved'
			});
		});
	});

	it('commits on gesture end immediately and cancels the pending debounce (rule 1)', async () => {
		autosave.queue('alignments/one.json', encode('mid-drag'));
		await autosave.commit('alignments/one.json', encode('pointer-up'));

		expect(writes).toEqual(['alignments/one.json']);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
		expect(writes).toEqual(['alignments/one.json']);
		expect(await read('alignments/one.json')).toBe('pointer-up');
	});

	describe('flushing (rule 3)', () => {
		it('writes everything pending, without waiting for any window to close', async () => {
			await autosave.flush();
			expect(writes).toEqual([]);
			expect(autosave.hasPendingWrite('a/project.json')).toBe(false);

			autosave.queue('a/project.json', encode('a'));
			autosave.queue('b/project.json', encode('b'));
			expect(autosave.hasPendingWrite('a/project.json')).toBe(true);
			await autosave.flush();

			expect(writes.sort()).toEqual(['a/project.json', 'b/project.json']);
			expect(autosave.hasPendingWrite('a/project.json')).toBe(false);
			expect(autosave.state).toBe('saved');
		});

		it('does not turn one failing write into a storm of retries', async () => {
			const write = vi.spyOn(store, 'write').mockRejectedValue(new Error('quota exceeded'));
			autosave.queue(P, encode('a'));

			await autosave.flush();

			expect(write).toHaveBeenCalledTimes(1);
			expect(autosave.state).toBe('unsaved');
		});
	});

	describe('surviving a store that rejects a write', () => {
		it('rejects to its caller, holds the bytes and does not spin on them or claim saved', async () => {
			const write = vi.spyOn(store, 'write').mockRejectedValue(new Error('quota exceeded'));

			await expect(autosave.commit(P, encode('a'))).rejects.toThrow('quota exceeded');

			expect(autosave.hasPendingWrite(P)).toBe(true);
			expect(autosave.state).toBe('unsaved');
			expect(autosave.lastError).toBeInstanceOf(Error);
			await vi.advanceTimersByTimeAsync(DEBOUNCE * 100);
			expect(write).toHaveBeenCalledTimes(1);
			expect(autosave.hasPendingWrite(P)).toBe(true);
		});

		it('keeps the bytes, so a later flush still has something to write', async () => {
			vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('quota exceeded'));
			await autosave.commit(P, encode('renamed')).catch(() => undefined);

			expect(autosave.hasPendingWrite(P)).toBe(true);
			await autosave.flush();

			expect(await read()).toBe('renamed');
			expect(autosave.state).toBe('saved');
			expect(autosave.lastError).toBeUndefined();
		});

		it('does not retry a refused write because an edit was queued behind it, but keeps the newest', async () => {
			const write = vi.spyOn(store, 'write').mockRejectedValue(new Error('the disk is full'));
			const failing = autosave.commit(P, encode('first')).catch(() => undefined);
			autosave.queue(P, encode('second'));
			await failing;

			await vi.advanceTimersByTimeAsync(DEBOUNCE * 100);

			expect({
				timers: vi.getTimerCount(),
				attempts: write.mock.calls.length,
				pending: autosave.hasPendingWrite(P),
				state: autosave.state
			}).toEqual({ timers: 0, attempts: 1, pending: true, state: 'unsaved' });
			write.mockImplementation(writeThrough);
			await autosave.flush();
			expect(await read()).toBe('second');
		});
	});

	describe('a write that reports success has been written', () => {
		const writesThatLandOnCommand = () => {
			const awaited: Promise<void>[] = [];
			const given: { path: string; text: string }[] = [];
			const outstanding: (() => void)[] = [];
			vi.spyOn(store, 'write').mockImplementation((path, bytes) => {
				writes.push(path);
				given.push({ path, text: decode(bytes) });
				let landed!: () => void;
				const landing = new Promise<void>((resolve) => {
					landed = resolve;
				});
				awaited.push(landing);
				outstanding.push(() => void writeThrough(path, bytes).then(landed, landed));
				return landing;
			});
			const land = () => outstanding.shift()?.();
			return { awaited, given, land };
		};

		const leftAlone = async (land: () => void) => {
			for (let pass = 0; pass < 10; pass += 1) {
				await vi.advanceTimersByTimeAsync(DEBOUNCE);
				land();
				await vi.advanceTimersByTimeAsync(0);
			}
		};

		it('writes bytes committed in the gap between a drain finishing and its bookkeeping', async () => {
			const { awaited, land } = writesThatLandOnCommand();
			autosave.queue(P, encode('one'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);
			expect(writes).toEqual([P]);
			let reported: 'waiting' | 'resolved' | 'rejected' = 'waiting';
			void awaited[0]
				?.then(() => outcomeOf(autosave.commit(P, encode('two'))))
				.then((outcome) => (reported = outcome));
			land();
			await vi.advanceTimersByTimeAsync(0);
			land();
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			expect(await read()).toBe('two');
			expect(writes).toEqual([P, P]);
			expect(reported).toBe('resolved');
			expect(autosave.hasPendingWrite(P)).toBe(false);
			expect(autosave.state).toBe('saved');
		});

		it('has something coming for bytes left pending by a debounce', async () => {
			const { land } = writesThatLandOnCommand();
			autosave.queue(P, encode('debounced'));
			expect(autosave.hasPendingWrite(P)).toBe(true);

			await leftAlone(land);

			expect(await read()).toBe('debounced');
			expect(autosave.hasPendingWrite(P)).toBe(false);
		});

		it('has something coming for bytes queued while a write is in flight', async () => {
			const { land } = writesThatLandOnCommand();
			void autosave.commit(P, encode('first')).catch(() => undefined);
			autosave.queue(P, encode('second'));
			expect(autosave.hasPendingWrite(P)).toBe(true);

			await leftAlone(land);

			expect(await read()).toBe('second');
			expect(autosave.hasPendingWrite(P)).toBe(false);
		});

		it('gives the store bytes committed as a drain was stopping, in the order they were made', async () => {
			const { awaited, given, land } = writesThatLandOnCommand();
			void autosave.commit(P, encode('first')).catch(() => undefined);
			void awaited[0]?.then(() => void autosave.commit(P, encode('last')).catch(() => undefined));

			await leftAlone(land);

			expect(given).toEqual([
				{ path: P, text: 'first' },
				{ path: P, text: 'last' }
			]);
			expect(await read()).toBe('last');
			expect(autosave.hasPendingWrite(P)).toBe(false);
			expect(autosave.state).toBe('saved');
		});

		it('lets a commit take back a path that was abandoned mid-write', async () => {
			const { given, land } = writesThatLandOnCommand();
			void autosave.commit(AMS, encode('v1')).catch(() => undefined);
			void autosave.abandon('amsterdam-1625/');
			const readopted = autosave.commit(AMS, encode('v2-READOPTED'));

			await leftAlone(land);

			await expect(readopted).resolves.toBeUndefined();
			expect(given).toEqual([
				{ path: AMS, text: 'v1' },
				{ path: AMS, text: 'v2-READOPTED' }
			]);
		});

		it('leaves nothing scheduled for a path it was told to abandon mid-write', async () => {
			const { land } = writesThatLandOnCommand();
			autosave.queue(AMS, encode('a rename mid-debounce'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);
			const abandoning = autosave.abandon('amsterdam-1625/');
			autosave.queue(AMS, encode('and another'));

			land();
			await vi.advanceTimersByTimeAsync(0);
			land();
			await expect(abandoning).resolves.toBe(true);

			expect(vi.getTimerCount()).toBe(0);
		});

		describe('a sweep cannot revert what a subscriber wrote while it was sweeping', () => {
			const onFirstSaving = (gesture: () => void) => {
				let done = false;
				autosave.subscribe((state) => {
					if (state !== 'saving' || done) return;
					done = true;
					gesture();
				});
			};

			it.each([
				{ sweep: 'flush', run: () => autosave.flush() },
				{ sweep: 'settled', run: () => expect(autosave.settled('p/')).resolves.toBe(true) }
			])(
				'does not let $sweep write back bytes a subscriber superseded mid-sweep',
				async ({ run }) => {
					autosave.queue('p/annotations/one.geojson', encode('a1'));
					autosave.queue(P, encode('b1'));
					let committed: 'resolved' | 'rejected' | 'waiting' = 'waiting';
					onFirstSaving(() => {
						void outcomeOf(autosave.commit(P, encode('b2-NEWER'))).then(
							(outcome) => (committed = outcome)
						);
					});

					await run();
					await vi.advanceTimersByTimeAsync(DEBOUNCE);

					expect({
						committed,
						onDisk: await read(),
						pending: autosave.hasPendingWrite(P),
						state: autosave.state,
						timers: vi.getTimerCount()
					}).toEqual({
						committed: 'resolved',
						onDisk: 'b2-NEWER',
						pending: false,
						state: 'saved',
						timers: 0
					});
				}
			);

			it.each([
				{
					gesture: 'commit',
					run: (autosave: Autosave) => outcomeOf(autosave.commit(P, encode('older'))),
					committed: 'resolved'
				},
				{
					gesture: 'queue',
					run: (autosave: Autosave) => autosave.queue(P, encode('older')),
					committed: undefined
				}
			])(
				'does not let $gesture revert an edit its own refusal handler made',
				async ({ run, committed }) => {
					let reentered = false;
					const refusing: Autosave = new Autosave(store, {
						debounceMs: DEBOUNCE,
						journal: FULL_JOURNAL,
						onJournalRefused: (problem) => {
							if (problem === null || reentered) return;
							reentered = true;
							void refusing.commit(P, encode('NEWER')).catch(() => undefined);
						}
					});

					const outcome = await run(refusing);
					await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);

					expect({
						committed: outcome,
						reentered,
						onDisk: await read(),
						pending: refusing.hasPendingWrite(P),
						state: refusing.state,
						timers: vi.getTimerCount()
					}).toEqual({
						committed,
						reentered: true,
						onDisk: 'NEWER',
						pending: false,
						state: 'saved',
						timers: 0
					});
				}
			);

			it('does not let flush resurrect a Project abandoned mid-sweep', async () => {
				autosave.queue('a/project.json', encode('a1'));
				autosave.queue(AMS, encode('b1'));
				onFirstSaving(() => void autosave.abandon('amsterdam-1625/'));

				await autosave.flush();

				expect({
					written: writes,
					stored: await store.list('amsterdam-1625/'),
					pending: autosave.hasPendingWrite(AMS)
				}).toEqual({ written: ['a/project.json'], stored: [], pending: false });
			});
		});

		it('still forgets a journal entry only for the exact bytes the store took', async () => {
			const { journalled, journalling } = journallingAutosave();
			const { land } = writesThatLandOnCommand();
			void journalling.commit(P, encode('first')).catch(() => undefined);
			journalling.queue(P, encode('second'));

			land();
			await vi.advanceTimersByTimeAsync(0);
			expect(decode(journalled.get(P) ?? new Uint8Array())).toBe('second');
			land();
			await vi.advanceTimersByTimeAsync(0);
			expect(journalled.size).toBe(0);
		});

		it('does not fail abandoning a Project because the journal would not forget it', async () => {
			const journalling = forgetThrows();
			journalling.queue(AMS, encode('a rename mid-debounce'));

			await expect(journalling.abandon('amsterdam-1625/')).resolves.toBe(true);

			expect(journalling.hasPendingWrite(AMS)).toBe(false);
		});

		it('does not fail a write the store took because the journal would not forget it', async () => {
			const forgotten: string[] = [];
			const journalling = forgetThrows(forgotten);

			const outcome = await outcomeOf(journalling.commit(P, encode('first')));

			expect({
				outcome,
				written: await read(),
				state: journalling.state,
				pending: journalling.hasPendingWrite(P),
				lastError: journalling.lastError,
				forgetWasTried: forgotten
			}).toEqual({
				outcome: 'resolved',
				written: 'first',
				state: 'saved',
				pending: false,
				lastError: undefined,
				forgetWasTried: [P]
			});
		});

		it('is not killed by a subscriber that throws while the indicator is announced', async () => {
			escapesOutOfBand();
			let willThrow = true;
			autosave.subscribe((state) => {
				if (state !== 'saving' || !willThrow) return;
				willThrow = false;
				throw new Error('a listener that could not cope');
			});

			const outcome = await outcomeOf(autosave.commit(P, encode('first')));

			expect({
				outcome,
				state: autosave.state,
				pending: autosave.hasPendingWrite(P),
				written: await read()
			}).toEqual({ outcome: 'resolved', state: 'saved', pending: false, written: 'first' });

			await expect(autosave.commit(P, encode('second'))).resolves.toBeUndefined();
		});

		it('keeps one writer per path when a subscriber commits back into it', async () => {
			const { given, land } = writesThatLandOnCommand();
			let reentered = false;
			autosave.subscribe((state) => {
				if (state !== 'saving' || reentered) return;
				reentered = true;
				void autosave.commit(P, encode('B')).catch(() => undefined);
			});

			void autosave.commit(P, encode('A')).catch(() => undefined);
			await leftAlone(land);

			expect({ reentered, given }).toEqual({ reentered: true, given: [{ path: P, text: 'B' }] });
		});

		it.each([
			{ ending: 'the store took the bytes', refuse: false, indicator: 'saved' },
			{ ending: 'the store refused the bytes', refuse: true, indicator: 'unsaved' }
		])(
			'leaves the path alive when a drain stops because $ending',
			async ({ refuse, indicator }) => {
				if (refuse) vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('the disk is full'));

				await autosave.commit(P, encode('first')).catch(() => undefined);

				expect({ state: autosave.state, pending: autosave.hasPendingWrite(P) }).toEqual({
					state: indicator,
					pending: refuse
				});

				autosave.queue(P, encode('by flush'));
				await autosave.flush();
				expect(await read()).toBe('by flush');

				autosave.queue(P, encode('by debounce'));
				await vi.advanceTimersByTimeAsync(DEBOUNCE);
				expect(await read()).toBe('by debounce');

				await expect(autosave.commit(P, encode('by commit'))).resolves.toBeUndefined();
				expect(await read()).toBe('by commit');
			}
		);
	});

	describe('a subscriber that throws cannot touch the write path', () => {
		const alwaysThrows = () =>
			autosave.subscribe(() => {
				throw new Error('a listener that could not cope');
			});

		it('lets subscribe return, reports out of band, and notifies every other listener', async () => {
			const escaped = escapesOutOfBand();
			const before: SaveState[] = [];
			const after: SaveState[] = [];
			autosave.subscribe((state) => before.push(state));
			expect(() => alwaysThrows()).not.toThrow();
			autosave.subscribe((state) => after.push(state));

			await microtasks();
			expect(escaped.map((cause) => (cause as Error).message)).toEqual([
				'a listener that could not cope'
			]);

			await autosave.commit(P, encode('a'));

			await microtasks();
			expect({ before, after }).toEqual({
				before: ['saved', 'saving', 'saved'],
				after: ['saved', 'saving', 'saved']
			});
		});

		it('still writes a debounced edit, and still writes a committed one', async () => {
			const escaped = escapesOutOfBand();
			alwaysThrows();
			const alsoTold: SaveState[] = [];
			autosave.subscribe((state) => alsoTold.push(state));

			autosave.queue(P, encode('by debounce'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);
			expect(await read()).toBe('by debounce');

			await expect(autosave.commit(P, encode('by commit'))).resolves.toBeUndefined();
			expect(await read()).toBe('by commit');

			await microtasks();
			expect({ escaped: escaped.length, told: alsoTold }).toEqual({
				escaped: 6,
				told: ['saved', 'unsaved', 'saving', 'saved', 'saving', 'saved']
			});
		});

		it('still flushes, abandons and settles', async () => {
			const escaped = escapesOutOfBand();
			alwaysThrows();

			autosave.queue('a/project.json', encode('flushed'));
			await autosave.flush();
			expect(await read('a/project.json')).toBe('flushed');

			autosave.queue('b/project.json', encode('settled'));
			await expect(autosave.settled('b/')).resolves.toBe(true);
			expect(await read('b/project.json')).toBe('settled');

			autosave.queue('c/project.json', encode('abandoned'));
			await expect(autosave.abandon('c/')).resolves.toBe(true);
			expect(autosave.hasPendingWrite('c/project.json')).toBe(false);
			expect(await store.list('c/')).toEqual([]);

			await microtasks();
			expect(escaped).not.toHaveLength(0);
		});

		it('still saves the edit when it is onJournalRefused that throws', async () => {
			const escaped = escapesOutOfBand();
			const refusing = new Autosave(store, {
				debounceMs: DEBOUNCE,
				journal: FULL_JOURNAL,
				onJournalRefused: () => {
					throw new Error('a refusal handler that could not cope');
				}
			});

			refusing.queue(P, encode('renamed'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			expect(await read()).toBe('renamed');
			await microtasks();
			expect(escaped.map((cause) => (cause as Error).message)).toEqual([
				'a refusal handler that could not cope'
			]);
		});
	});

	describe('giving up on what is being deleted', () => {
		it('drops pending bytes and clears the timer, so neither capture nor flush can put them back', async () => {
			const { journalled, journalling } = journallingAutosave();
			journalling.queue(AMS, encode('a rename mid-debounce'));
			expect([...journalled.keys()]).toEqual([AMS]);
			expect(journalling.state).toBe('unsaved');

			void journalling.abandon('amsterdam-1625/');

			expect(journalling.state).toBe('saved');
			expect(vi.getTimerCount()).toBe(0);
			expect(journalled.size).toBe(0);
			journalling.capture();
			expect(journalled.size).toBe(0);
			await journalling.flush();
			expect(writes).toEqual([]);
			expect(journalling.hasPendingWrite(AMS)).toBe(false);
		});

		it('leaves every other Project’s pending bytes alone', async () => {
			autosave.queue(AMS, encode('a'));
			autosave.queue('boston-1775/project.json', encode('b'));

			void autosave.abandon('amsterdam-1625/');
			await autosave.flush();

			expect(writes).toEqual(['boston-1775/project.json']);
		});

		it('gives up the bytes of a write it could not stop, and answers only once it lands', async () => {
			const { journalled, journalling } = journallingAutosave();
			const land = holdWrites();
			journalling.queue(AMS, encode('a rename mid-debounce'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);
			expect(writes).toEqual([]);
			expect([...journalled.keys()]).toEqual([AMS]);
			const abandoning = watch(journalling.abandon('amsterdam-1625/'));

			journalling.capture();
			await vi.advanceTimersByTimeAsync(0);
			expect({
				answer: abandoning.value,
				pending: journalling.hasPendingWrite(AMS),
				journal: [...journalled.keys()],
				state: journalling.state
			}).toEqual({ answer: 'still waiting', pending: false, journal: [], state: 'saving' });

			land();
			await vi.advanceTimersByTimeAsync(0);
			expect({
				answer: abandoning.value,
				state: journalling.state,
				journal: [...journalled.keys()],
				writes
			}).toEqual({ answer: true, state: 'saved', journal: [], writes: [AMS] });
		});

		it('leaves a path being written to one writer, even after abandoning it', async () => {
			let land = (): void => undefined;
			vi.spyOn(store, 'write').mockImplementation(
				async (path) =>
					new Promise<void>((resolve) => {
						const previous = land;
						land = () => {
							previous();
							writes.push(path);
							resolve();
						};
					})
			);
			autosave.queue(AMS, encode('first'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			void autosave.abandon('amsterdam-1625/');
			autosave.queue(AMS, encode('second'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			land();
			await vi.advanceTimersByTimeAsync(0);
			expect(writes).toEqual([AMS]);
		});

		it('withdraws a journal refusal for a Project it is giving up on', async () => {
			const refusals: unknown[] = [];
			const refusing = new Autosave(store, {
				debounceMs: DEBOUNCE,
				journal: FULL_JOURNAL,
				onJournalRefused: (problem) => refusals.push(problem)
			});
			refusing.queue(AMS, encode('a rename that would not fit'));
			expect(refusals).toEqual([expect.any(Error)]);

			await refusing.abandon('amsterdam-1625/');

			expect(refusals).toEqual([expect.any(Error), null]);
		});

		it('re-reads each path as it sweeps, so a journal that writes back cannot orphan a drain', async () => {
			const land = holdWrites();
			let reentered = false;
			const sweeping: Autosave = new Autosave(store, {
				debounceMs: DEBOUNCE,
				journal: {
					record: () => undefined,
					forget: () => {
						if (reentered) return;
						reentered = true;
						void sweeping.commit(AMS, encode('typed during the sweep')).catch(() => undefined);
					}
				}
			});
			sweeping.queue('amsterdam-1625/annotations/one.geojson', encode('a'));
			sweeping.queue(AMS, encode('b'));

			const quiet = watch(sweeping.abandon('amsterdam-1625/'));
			await vi.advanceTimersByTimeAsync(0);

			expect({ reentered, quiet: quiet.value }).toEqual({
				reentered: true,
				quiet: 'still waiting'
			});
			land();
			await vi.advanceTimersByTimeAsync(0);
			expect(quiet.value).toBe(true);
		});

		it('answers even when the write it could not stop rejected', async () => {
			vi.spyOn(store, 'write').mockRejectedValue(new Error('the disk is full'));
			autosave.queue(AMS, encode('a'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			await expect(autosave.abandon('amsterdam-1625/')).resolves.toBe(true);
		});

		it.each([
			{ given: 'a five-second wait', options: { inFlightWaitMs: 5000 }, waits: 5000 },
			{
				given: 'nothing, which is what every caller that says nothing gets',
				options: {},
				waits: 2000
			}
		])(
			'gives up on a write that will never settle after the wait it was given: $given',
			async ({ options, waits }) => {
				const waiting = new Autosave(store, { debounceMs: DEBOUNCE, ...options });
				neverSettle();
				waiting.queue(AMS, encode('a'));
				await vi.advanceTimersByTimeAsync(DEBOUNCE);

				const answer = watch(waiting.abandon('amsterdam-1625/'));

				await vi.advanceTimersByTimeAsync(waits - 1);
				expect(answer.value).toBe('still waiting');
				await vi.advanceTimersByTimeAsync(1);
				expect(answer.value).toBe(false);
			}
		);

		it('drains a file still inside its debounce, rather than calling it quiet', async () => {
			const land = holdWrites();
			autosave.queue('alignments/aaa1.json', encode('a placement mid-drag'));
			expect(writes).toEqual([]);
			const quiet = watch(autosave.settled('alignments/aaa1.json'));

			await vi.advanceTimersByTimeAsync(0);
			expect(quiet.value).toBe('still waiting');
			expect(autosave.state).toBe('saving');
			land();
			await vi.advanceTimersByTimeAsync(0);
			expect(quiet.value).toBe(true);
			expect(writes).toEqual(['alignments/aaa1.json']);
		});

		it('answers at once for a path the store is not writing, even with a write in flight elsewhere', async () => {
			await expect(autosave.settled('alignments/aaa1.json')).resolves.toBe(true);
			neverSettle();
			autosave.queue(AMS, encode('a rename that will never land'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			await expect(autosave.settled('images/aaa1/')).resolves.toBe(true);
		});

		it('waits for a path without giving anything up', async () => {
			const { journalled, journalling: waiting } = journallingAutosave();
			const land = holdWrites();
			waiting.queue('alignments/aaa1.json', encode('a placement mid-drag'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);
			waiting.queue('alignments/aaa1.json', encode('and one more control point'));

			const quiet = watch(waiting.settled('alignments/aaa1.json'));
			await vi.advanceTimersByTimeAsync(0);
			expect(quiet.value).toBe('still waiting');
			expect(waiting.hasPendingWrite('alignments/aaa1.json')).toBe(true);
			expect([...journalled.keys()]).toEqual(['alignments/aaa1.json']);
			land();
			await vi.advanceTimersByTimeAsync(0);
			expect(quiet.value).toBe('still waiting');
			land();
			await vi.advanceTimersByTimeAsync(0);
			expect(quiet.value).toBe(true);
			expect(writes).toEqual(['alignments/aaa1.json', 'alignments/aaa1.json']);
		});
	});

	describe('the save state (rule 5)', () => {
		it('goes saved → unsaved → saving → saved across one debounced write', async () => {
			expect(states).toEqual(['saved']);

			autosave.queue(P, encode('a'));
			expect(states).toEqual(['saved', 'unsaved']);

			await vi.advanceTimersByTimeAsync(DEBOUNCE);
			expect(states).toEqual(['saved', 'unsaved', 'saving', 'saved']);
		});

		it('goes saving → saved for a gesture-end commit, with no unsaved stop in between', async () => {
			await autosave.commit(P, encode('a'));

			expect(states).toEqual(['saved', 'saving', 'saved']);
		});

		it('does not claim saved because some other file was written afterwards', async () => {
			vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('quota exceeded'));
			await autosave.commit(AMS, encode('renamed')).catch(() => undefined);
			expect(autosave.state).toBe('unsaved');

			await autosave.commit('boston-1775/project.json', encode('a new Project'));

			expect(autosave.state).toBe('unsaved');
			expect(autosave.lastError).toBeInstanceOf(Error);
		});

		it('stops notifying an unsubscribed listener', async () => {
			const seen: SaveState[] = [];
			autosave.subscribe((state) => seen.push(state))();

			await autosave.commit(P, encode('a'));

			expect(seen).toEqual(['saved']);
		});

		it('does not tell a later subscriber a state an earlier one has already superseded', async () => {
			const seenByLate: SaveState[] = [];
			let armed = false;
			let edited = false;
			autosave.subscribe((state) => {
				if (!armed || state !== 'saved' || edited) return;
				edited = true;
				autosave.queue('p/other.json', encode('typed while being told'));
			});
			autosave.subscribe((state) => seenByLate.push(state));
			armed = true;

			await autosave.commit(P, encode('a'));

			expect({
				edited,
				state: autosave.state,
				pending: autosave.hasPendingWrite('p/other.json'),
				lastTold: seenByLate.at(-1)
			}).toEqual({ edited: true, state: 'unsaved', pending: true, lastTold: 'unsaved' });
		});

		it('does not tell a resubscribing listener the state it had before its own edit', async () => {
			const seen: SaveState[] = [];
			let armed = false;
			let churned = false;
			let unsubscribe = (): void => undefined;
			const listener = (state: SaveState) => {
				seen.push(state);
				if (!armed || state !== 'saved' || churned) return;
				churned = true;
				unsubscribe();
				unsubscribe = autosave.subscribe(listener);
				autosave.queue('p/other.json', encode('typed while being told'));
			};
			unsubscribe = autosave.subscribe(listener);
			armed = true;

			await autosave.commit(P, encode('a'));

			expect({ churned, state: autosave.state, lastTold: seen.at(-1) }).toEqual({
				churned: true,
				state: 'unsaved',
				lastTold: 'unsaved'
			});
		});
	});
});
