import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import { Autosave, type SaveState } from './autosave.js';
import { installFlushOnHide } from './flush-on-hide.js';

const utf8 = new TextEncoder();
const DEBOUNCE = 400;

/**
 * Catch what `Autosave` rethrows out of band, and hand back the list.
 *
 * ⚠ **The swap is an assertion as much as the `expect`s that read the list.** `Autosave` never
 * swallows a subscriber's failure: it rethrows it from a `queueMicrotask`, which is where an
 * uncaught error goes — `window.onerror` in a browser, this suite's `pageerror` watch in the e2e
 * projects, and an `uncaughtException` in Node, which vitest would otherwise fail the run with. So
 * the process's handlers are borrowed for the length of the test. If the class ever starts
 * swallowing instead, the returned list is empty and every test that uses this goes red.
 *
 * The same pattern as `store-image-fetch.test.ts`'s, which is where ticket 04 established it.
 */
const escapesOutOfBand = (): unknown[] => {
	const saved = process.listeners('uncaughtException');
	const escaped: unknown[] = [];
	process.removeAllListeners('uncaughtException');
	process.on('uncaughtException', (cause) => escaped.push(cause));
	onTestFinished(() => {
		process.removeAllListeners('uncaughtException');
		for (const listener of saved) process.on('uncaughtException', listener);
	});
	return escaped;
};

/**
 * Let a `queueMicrotask` that threw reach Node's `uncaughtException`.
 *
 * Timers are faked in this file, so a real `setTimeout(0)` would never fire; advancing by zero
 * yields to the microtask queue, which is where the rethrow is waiting.
 */
const microtasks = () => vi.advanceTimersByTimeAsync(0);

describe('Autosave', () => {
	let store: MemoryProjectStore;
	let writes: string[];
	let autosave: Autosave;
	let states: SaveState[];
	/** The unspied `store.write`, so a test can re-spy without recursing into its own mock. */
	let writeThrough: MemoryProjectStore['write'];

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

	describe('debouncing per file (rule 2)', () => {
		it('collapses two writes to the same path inside the window into one', async () => {
			autosave.queue('p/project.json', utf8.encode('first'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
			autosave.queue('p/project.json', utf8.encode('second'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			expect(writes).toEqual(['p/project.json']);
			expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('second');
		});

		it('does not batch different paths together: each keeps its own deadline', async () => {
			autosave.queue('p/project.json', utf8.encode('a'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
			autosave.queue('p/annotations/one.geojson', utf8.encode('b'));

			// The first file's own window closes while the second is still waiting. A global
			// debounce would have delayed both, which is how one busy file starves the others.
			await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
			expect(writes).toEqual(['p/project.json']);

			await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
			expect(writes).toEqual(['p/project.json', 'p/annotations/one.geojson']);
		});

		it('writes nothing before the window closes', async () => {
			autosave.queue('p/project.json', utf8.encode('a'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);

			expect(writes).toEqual([]);
		});
	});

	describe('committing on gesture end (rule 1)', () => {
		it('writes immediately and cancels the pending debounce', async () => {
			// alignment-write-is-the-fixture: the specimen this rule-1 test queues; Autosave neither knows nor cares that the path is an Alignment's
			autosave.queue('alignments/one.json', utf8.encode('mid-drag'));
			// alignment-write-is-the-fixture: the specimen this rule-1 test commits; Autosave neither knows nor cares that the path is an Alignment's
			await autosave.commit('alignments/one.json', utf8.encode('pointer-up'));

			expect(writes).toEqual(['alignments/one.json']);
			// ⚠ **Cancelled, not merely overtaken.** Counting the timers is what says so: the debounce
			// callback checks the file's state before it drains, so a timer left armed here fires
			// *harmlessly* and every assertion about bytes stays green. That is precisely the shape this
			// epic twice caught a refactor sliding into — a stray timer that used to strand bytes going
			// quiet rather than going away — and the count is the only thing that can see it.
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
			expect(writes).toEqual(['alignments/one.json']);
			expect(new TextDecoder().decode(await store.read('alignments/one.json'))).toBe('pointer-up');
		});
	});

	describe('flushing (rule 3)', () => {
		it('writes everything pending, without waiting for any window to close', async () => {
			autosave.queue('a/project.json', utf8.encode('a'));
			autosave.queue('b/project.json', utf8.encode('b'));
			await autosave.flush();

			expect(writes.sort()).toEqual(['a/project.json', 'b/project.json']);
			expect(autosave.state).toBe('saved');
		});

		it('does nothing when there is nothing pending', async () => {
			await autosave.flush();

			expect(writes).toEqual([]);
		});

		it('does not turn one failing write into a storm of retries', async () => {
			const write = vi.spyOn(store, 'write').mockRejectedValue(new Error('quota exceeded'));
			autosave.queue('p/project.json', utf8.encode('a'));

			await autosave.flush();

			// A write that has just failed will not succeed on an immediate retry, and a flush that
			// kept trying would turn one quota failure into a hundred against a full disk. Failed
			// bytes stay pending, so this is the guard on the loop that drains them.
			expect(write).toHaveBeenCalledTimes(1);
			expect(autosave.state).toBe('unsaved');
		});
	});

	describe('surviving a store that rejects a write', () => {
		it('reports the failure to its caller rather than resolving', async () => {
			// `Workspace.writeProject` and `EditorSession` both await this. While it resolved, a
			// rename that never reached the disk was reported as a success all the way up.
			vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('quota exceeded'));

			await expect(autosave.commit('p/project.json', utf8.encode('a'))).rejects.toThrow(
				'quota exceeded'
			);
		});

		it('keeps the bytes, so a later flush still has something to write', async () => {
			// The bytes used to be cleared *before* the write was attempted, and a failure merely
			// returned: the edit was gone, there was nothing for `flush` to retry, and the entry was
			// then deleted outright. This is the closed-laptop path arriving after a hiccup.
			vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('quota exceeded'));
			await autosave.commit('p/project.json', utf8.encode('renamed')).catch(() => undefined);

			expect(autosave.hasPendingWrite('p/project.json')).toBe(true);
			await autosave.flush();

			expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('renamed');
			expect(autosave.state).toBe('saved');
			expect(autosave.lastError).toBeUndefined();
		});

		it('keeps the newest bytes when an edit arrives while the store is failing', async () => {
			vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('quota exceeded'));
			const failing = autosave
				.commit('p/project.json', utf8.encode('first'))
				.catch(() => undefined);
			autosave.queue('p/project.json', utf8.encode('second'));
			await failing;

			await autosave.flush();

			expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('second');
		});
	});

	/**
	 * ⚠ **A `commit` COULD RESOLVE SUCCESSFULLY WITH ITS BYTES STILL IN MEMORY.**
	 *
	 * `#drain` memoised the running drain and released the memo from a `.finally` on the loop's
	 * promise — one microtask *after* the loop had already exited its `while`. A `commit` landing in
	 * that window was handed the settling promise, set `pending`, and no loop restarted. Its caller
	 * was told the write succeeded; the bytes stayed in memory until the next edit to that path
	 * overwrote them, so the last write of a burst was lost permanently and a superseded one
	 * silently. The indicator did not read "Saved" — `#derive` still saw `pending` — it read
	 * *Unsaved, for ever, for no reason*, which is a thing no scholar can act on.
	 *
	 * **Whether real OPFS timing enters that window has not been shown and is not claimed here.**
	 * The window is one microtask, and these tests build it deliberately.
	 *
	 * The invariant these assert, rather than the mechanism that keeps it: **if a file has pending
	 * bytes, a drain is scheduled or running for it.** The exception is a drain that stopped by
	 * throwing, and since ticket 09 there is exactly **one** way it can — the store refused the
	 * bytes. It holds them rather than rescheduling them, and `leaves the path alive when a drain
	 * stops because …` drives that ending and the ordinary one through each of the three routes to
	 * the store.
	 *
	 * ⚠ **That enumeration has been wrong twice, and re-checking it is the whole discipline.** A
	 * journal whose `forget` threw was once an ending, and the worst of them: `commit` rejected for a
	 * write the store had taken, with the indicator reading Saved (see `does not fail a write the
	 * store took because the journal would not forget it`). A subscriber that threw while the
	 * indicator was published was once an ending too — **that is the one ticket 09 removed**, by not
	 * letting a listener throw into this class at all rather than by guarding the three places it
	 * could land. See `a subscriber that throws cannot touch the write path`, which is where those
	 * assertions went.
	 */
	describe('a write that reports success has been written', () => {
		/**
		 * A store whose writes land only when the test says so, **and which hands the test the very
		 * promise the drain loop awaits**.
		 *
		 * That second half is the instrument and not a convenience. A continuation registered on that
		 * promise *after* the drain loop registered its own runs in the microtask between the loop's
		 * last pass and whatever the loop does on its way out — the only window in which a `commit`
		 * could be handed a drain that had already stopped. Nothing else in this file can reach it,
		 * which is why every test above stayed green while the defect was live.
		 */
		const writesThatLandOnCommand = () => {
			const awaited: Promise<void>[] = [];
			const given: { path: string; text: string }[] = [];
			const outstanding: (() => void)[] = [];
			vi.spyOn(store, 'write').mockImplementation((path, bytes) => {
				writes.push(path);
				given.push({ path, text: new TextDecoder().decode(bytes) });
				let landed!: () => void;
				const landing = new Promise<void>((resolve) => {
					landed = resolve;
				});
				awaited.push(landing);
				// The real write happens when the test lands it, so assertions can be on the store's own
				// contents. `landing` is returned unchained, because it has to be the object the drain
				// loop awaits for a test to be able to queue a continuation behind the loop's own.
				outstanding.push(() => void writeThrough(path, bytes).then(landed, landed));
				return landing;
			});
			/** Let the oldest write the store has been given complete. */
			const land = () => outstanding.shift()?.();
			return { awaited, given, land };
		};

		/**
		 * Hand over to time and to the store, and **ask `Autosave` for nothing at all**.
		 *
		 * This is how "a drain is scheduled or running" is checked from outside: no further `commit`,
		 * `queue` or `flush` happens here, so bytes that reach the store did so because something was
		 * already coming for them. Several passes, because one drain can start the next.
		 */
		const leftAlone = async (land: () => void) => {
			for (let pass = 0; pass < 10; pass += 1) {
				await vi.advanceTimersByTimeAsync(DEBOUNCE);
				land();
				await vi.advanceTimersByTimeAsync(0);
			}
		};

		it('writes bytes committed in the gap between a drain finishing and its bookkeeping', async () => {
			const { awaited, land } = writesThatLandOnCommand();
			autosave.queue('p/project.json', utf8.encode('one'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);
			expect(writes).toEqual(['p/project.json']);

			// The gap, entered the only way it can be entered.
			let reported: 'waiting' | 'resolved' | 'rejected' = 'waiting';
			void awaited[0]
				?.then(() => autosave.commit('p/project.json', utf8.encode('two')))
				.then(
					() => (reported = 'resolved'),
					() => (reported = 'rejected')
				);
			land();
			// From here nothing further is asked of `autosave`: no second commit, no queue, no flush.
			await vi.advanceTimersByTimeAsync(0);
			land();
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('two');
			expect(writes).toEqual(['p/project.json', 'p/project.json']);
			// And the promise that said so was the truth: it resolved because the bytes are in the
			// store, not because a drain that had already stopped happened to settle.
			expect(reported).toBe('resolved');
			expect(autosave.hasPendingWrite('p/project.json')).toBe(false);
			expect(autosave.state).toBe('saved');
		});

		it('has something coming for bytes left pending by a debounce', async () => {
			const { land } = writesThatLandOnCommand();
			autosave.queue('p/project.json', utf8.encode('debounced'));
			expect(autosave.hasPendingWrite('p/project.json')).toBe(true);

			await leftAlone(land);

			expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('debounced');
			expect(autosave.hasPendingWrite('p/project.json')).toBe(false);
		});

		it('has something coming for bytes queued while a write is in flight', async () => {
			const { land } = writesThatLandOnCommand();
			void autosave.commit('p/project.json', utf8.encode('first')).catch(() => undefined);
			// Behind a drain that is already running, so the running loop is what has to pick them up.
			autosave.queue('p/project.json', utf8.encode('second'));
			expect(autosave.hasPendingWrite('p/project.json')).toBe(true);

			await leftAlone(land);

			expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('second');
			expect(autosave.hasPendingWrite('p/project.json')).toBe(false);
		});

		it('has something coming for bytes committed as a drain was stopping', async () => {
			const { awaited, land } = writesThatLandOnCommand();
			void autosave.commit('p/project.json', utf8.encode('first')).catch(() => undefined);
			void awaited[0]?.then(
				() => void autosave.commit('p/project.json', utf8.encode('last')).catch(() => undefined)
			);

			await leftAlone(land);

			expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('last');
			expect(autosave.hasPendingWrite('p/project.json')).toBe(false);
			expect(autosave.state).toBe('saved');
		});

		/**
		 * The bytes the invariant deliberately does **not** cover, stated so the exception cannot be
		 * lost: a write the store refused keeps its bytes and schedules nothing. Rescheduling them
		 * here would turn a full disk into a spin. They wait for the next `commit`, `queue` or
		 * `flush`; retrying them unasked is a separate change and is not made here.
		 */
		it('holds bytes the store refused rather than spinning on them', async () => {
			const write = vi.spyOn(store, 'write').mockRejectedValue(new Error('the disk is full'));
			await autosave.commit('p/project.json', utf8.encode('a')).catch(() => undefined);

			await vi.advanceTimersByTimeAsync(DEBOUNCE * 100);

			expect(write).toHaveBeenCalledTimes(1);
			expect(autosave.hasPendingWrite('p/project.json')).toBe(true);
		});

		/**
		 * ⚠ **`vi.getTimerCount()` IS THE DISCRIMINATOR, AND THESE FOUR ARE WHY** (ticket 09).
		 *
		 * Three assertions in this epic were found unable to tell "nothing is scheduled" from
		 * "scheduled for ever", because they only read the end state — and a state a timer is about to
		 * arrive in looks exactly like one nothing is coming for. The count is the only thing that
		 * separates them, so the states this class can rest in are pinned by it here rather than by an
		 * indicator that reads the same either way.
		 *
		 * They are also what says the union did what it was for. `debouncing` is the only variant that
		 * carries a timer, so a timer outliving the state that armed it — the stray this epic twice
		 * caught firing against bytes that were no longer there — has nowhere to be recorded.
		 */
		describe('what is scheduled, counted rather than inferred', () => {
			it('arms exactly one debounce for a queued edit, and none once it has landed', async () => {
				autosave.queue('p/project.json', utf8.encode('a'));
				expect(vi.getTimerCount()).toBe(1);

				await vi.advanceTimersByTimeAsync(DEBOUNCE);

				expect({ timers: vi.getTimerCount(), state: autosave.state }).toEqual({
					timers: 0,
					state: 'saved'
				});
			});

			it('collapses a re-queue onto one timer rather than leaving the first behind', async () => {
				autosave.queue('p/project.json', utf8.encode('a'));
				autosave.queue('p/project.json', utf8.encode('b'));

				// One window, not two. A second timer here is the stray that fires against bytes that
				// have gone, which is the shape a refactor in this epic twice made harmless-looking.
				expect(vi.getTimerCount()).toBe(1);
			});

			/**
			 * ⚠ **A BEHAVIOUR CHANGE, AND THE SPECIFICATION CHANGE THAT JUSTIFIES IT** (ticket 09).
			 *
			 * `queue` used to record the bytes *and* arm a timer even when a drain already owned the
			 * path, so one file could be debouncing and writing at the same time. Two consequences, both
			 * bad and neither asserted anywhere:
			 *
			 * 1. the timer usually fired against bytes the running drain had already written — the
			 *    "stray timer firing harmlessly" this epic caught twice, harmless only by luck;
			 * 2. when that drain *failed*, the timer turned the documented "bytes the store refused are
			 *    **held**, not retried" into "retried, if the edit that failed happened to have a
			 *    sibling behind it". Two answers to one question, decided by timing.
			 *
			 * With one state per path there is no way to write "debouncing and writing", so the drain is
			 * the mechanism and it is the only one. `holds bytes the store refused rather than spinning
			 * on them` states the rule; this is the case that used to escape it.
			 */
			it('does not retry a refused write because an edit was queued behind it', async () => {
				const write = vi.spyOn(store, 'write').mockRejectedValue(new Error('the disk is full'));
				const failing = autosave
					.commit('p/project.json', utf8.encode('first'))
					.catch(() => undefined);
				// Typed while the store still had the first bytes, so this lands on a path a drain owns.
				autosave.queue('p/project.json', utf8.encode('second'));
				await failing;

				await vi.advanceTimersByTimeAsync(DEBOUNCE * 100);

				expect({
					timers: vi.getTimerCount(),
					attempts: write.mock.calls.length,
					pending: autosave.hasPendingWrite('p/project.json'),
					state: autosave.state
				}).toEqual({ timers: 0, attempts: 1, pending: true, state: 'unsaved' });
				// And nothing was lost by not retrying: the newer bytes are the ones still held, and the
				// next flush against a store that will take them writes those.
				write.mockImplementation(writeThrough);
				await autosave.flush();
				expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('second');
			});

			it('leaves nothing scheduled for a path it was told to abandon mid-write', async () => {
				const { land } = writesThatLandOnCommand();
				autosave.queue('amsterdam-1625/project.json', utf8.encode('a rename mid-debounce'));
				await vi.advanceTimersByTimeAsync(DEBOUNCE);
				// A second edit, arriving while the store has the first and after the sweep.
				const abandoning = autosave.abandon('amsterdam-1625/');
				autosave.queue('amsterdam-1625/project.json', utf8.encode('and another'));

				land();
				await vi.advanceTimersByTimeAsync(0);
				land();
				await expect(abandoning).resolves.toBe(true);

				// `abandon`'s own bounded wait is over, the drain is over, and the edit that arrived
				// behind it went to that same drain rather than to a timer of its own.
				expect(vi.getTimerCount()).toBe(0);
			});
		});

		/**
		 * Re-asserted rather than trusted. Closing the gap is a change to exactly the code that decides
		 * what happens when a drain stops, and a drain that stops by throwing is the half a fix for the
		 * other half could quietly take with it.
		 */
		it('still rejects to its caller when the store rejected, with the bytes still pending', async () => {
			vi.spyOn(store, 'write').mockRejectedValue(new Error('quota exceeded'));

			await expect(autosave.commit('p/project.json', utf8.encode('a'))).rejects.toThrow(
				'quota exceeded'
			);

			expect(autosave.hasPendingWrite('p/project.json')).toBe(true);
			expect(autosave.state).toBe('unsaved');
			expect(autosave.lastError).toBeInstanceOf(Error);
		});

		/** Rule 2's one-writer-per-path, re-asserted across the route the fix newly opens. */
		it('still gives the store two edits to one path in the order they were made', async () => {
			const { awaited, given, land } = writesThatLandOnCommand();
			void autosave.commit('p/project.json', utf8.encode('first')).catch(() => undefined);
			void awaited[0]?.then(
				() => void autosave.commit('p/project.json', utf8.encode('second')).catch(() => undefined)
			);

			await leftAlone(land);

			expect(given).toEqual([
				{ path: 'p/project.json', text: 'first' },
				{ path: 'p/project.json', text: 'second' }
			]);
			expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('second');
		});

		/**
		 * The journal's forget rule, re-asserted: the entry goes only when the store took *those*
		 * bytes. An edit typed while the write was in flight has already recorded itself, so a
		 * `forget` for the older bytes would drop the only copy of the newer ones.
		 */
		it('still forgets a journal entry only for the exact bytes the store took', async () => {
			const journalled = new Map<string, string>();
			const journalling = new Autosave(store, {
				debounceMs: DEBOUNCE,
				journal: {
					record: (path, bytes) => void journalled.set(path, new TextDecoder().decode(bytes)),
					forget: (path) => void journalled.delete(path)
				}
			});
			const { land } = writesThatLandOnCommand();
			void journalling.commit('p/project.json', utf8.encode('first')).catch(() => undefined);
			journalling.queue('p/project.json', utf8.encode('second'));

			land();
			await vi.advanceTimersByTimeAsync(0);
			// The store took 'first'; 'second' is newer and is all that stands between the user and a
			// navigation, so its entry has to survive.
			expect(journalled.get('p/project.json')).toBe('second');

			land();
			await vi.advanceTimersByTimeAsync(0);
			expect(journalled.size).toBe(0);
		});

		/**
		 * The other `forget`, on the same rule. {@link Autosave.abandon} drops a deleted Project's
		 * entries synchronously and is called from a Delete the user is watching, so a journal that
		 * threw there would take the deletion down with it — the same hole as in the drain loop, one
		 * method along. Guarded through the same `#forget`.
		 *
		 * ⚠ **Also unreachable from any shipped journal**, for the reason given on the test above: the
		 * stub here is what the `AutosaveJournal` interface allows, not what `WriteAheadJournal` does.
		 */
		it('does not fail abandoning a Project because the journal would not forget it', async () => {
			const journalling = new Autosave(store, {
				debounceMs: DEBOUNCE,
				journal: {
					record: () => undefined,
					forget: () => {
						throw new Error('forget blew up');
					}
				}
			});
			journalling.queue('amsterdam-1625/project.json', utf8.encode('a rename mid-debounce'));

			await expect(journalling.abandon('amsterdam-1625/')).resolves.toBe(true);

			expect(journalling.hasPendingWrite('amsterdam-1625/project.json')).toBe(false);
		});

		/**
		 * ⚠ **A SUBSCRIBER THAT THREW KILLED THE PATH OUTRIGHT, AND THIS FIX INTRODUCED IT.**
		 *
		 * `#drainLoop`'s first act is `#publish('saving')`, and `#publish` runs subscribers
		 * synchronously. Published from *above* the loop's `try`, a subscriber that threw made the loop
		 * reject without the `finally` ever running — so `file.draining` held a rejected promise for
		 * ever and every later `#drain` on that path handed it straight back. The indicator sat on
		 * "Saving" and `commit`, the debounce and `flush` were all dead for that file, permanently.
		 *
		 * That is strictly worse than the defect this whole change closes: the parent's `.finally` on
		 * the returned promise ran on rejection too, so the bytes stayed recoverable and the indicator
		 * read "Unsaved". A recoverable stranding was traded for an unrecoverable one — stories 6 and
		 * 30 inverted on the exact path this ticket owns.
		 *
		 * ⚠ **Ticket 09 changed what this asserts, and the change is a specification change.** It used
		 * to assert that a subscriber's throw stopped the drain *survivably* — `commit` rejected, the
		 * bytes held, the path usable afterwards. It now asserts that a subscriber's throw does not
		 * reach the write path **at all**: the write completes and `commit` resolves. Defending the
		 * three places a listener could land was the shape that let this defect in twice; a listener
		 * that cannot throw into this class has no places to land. The subscriber's own failure is not
		 * swallowed for it — see `a subscriber that throws cannot touch the write path`, which asserts
		 * it escapes.
		 */
		it('is not killed by a subscriber that throws while the indicator is published', async () => {
			escapesOutOfBand();
			let willThrow = true;
			autosave.subscribe((state) => {
				if (state !== 'saving' || !willThrow) return;
				willThrow = false;
				throw new Error('a listener that could not cope');
			});

			// ⚠ **One assertion over the four facts together, not four in a row.** Asserted
			// separately, the first to fail hides the rest, and a mutation that moves two of them is
			// then recorded as killing only one — which is how an assertion with no kill of its own
			// survives a mutation check (review 2, finding C).
			const outcome = await autosave
				.commit('p/project.json', utf8.encode('first'))
				.then(() => 'resolved' as const)
				.catch(() => 'rejected' as const);

			expect({
				outcome,
				state: autosave.state,
				pending: autosave.hasPendingWrite('p/project.json'),
				written: new TextDecoder().decode(await store.read('p/project.json'))
			}).toEqual({ outcome: 'resolved', state: 'saved', pending: false, written: 'first' });

			// And the path is still alive rather than merely stranded: the next commit *resolves*,
			// which on the shape this replaced it could not — it was handed the first one's rejection.
			await expect(
				autosave.commit('p/project.json', utf8.encode('second'))
			).resolves.toBeUndefined();
		});

		/**
		 * ⚠ **The `finally` replaces the drain's state BEFORE it publishes, and the order is
		 * load-bearing** (review 2, finding F). `#derive` reads the state map, so publishing first
		 * reports `'saving'` for a drain that has already stopped and then never republishes — the
		 * indicator sits on "Saving" for ever with nothing in flight.
		 *
		 * ⚠ **Driven by a store that rejects rather than by a subscriber that throws** (ticket 09).
		 * The old version armed a listener to throw on every transition, which since ticket 09 does
		 * not stop a drain at all — so it would have gone on passing while measuring nothing, which is
		 * exactly the "a refactor silently disarmed a mutation" failure this epic keeps finding. A
		 * refused write is the ending that reaches this line with a state still to be replaced, and
		 * swapping the two lines turns this red.
		 */
		it('releases the drain before it publishes, so the indicator does not stick on Saving', async () => {
			vi.spyOn(store, 'write').mockRejectedValue(new Error('the disk is full'));

			await autosave.commit('p/project.json', utf8.encode('first')).catch(() => undefined);

			expect({
				state: autosave.state,
				pending: autosave.hasPendingWrite('p/project.json')
			}).toEqual({ state: 'unsaved', pending: true });
		});

		/**
		 * ⚠ **A JOURNAL WHOSE `forget` THREW WAS A THIRD WAY A DRAIN COULD STOP, AND THE WORST OF
		 * THEM** (review 2, finding A).
		 *
		 * `#drainLoop` forgets the journal entry *after* `store.write` resolved and outside the `try`
		 * that guards the write. So a journal that threw there rejected `commit` for a write the store
		 * had actually taken: measured on the commit before this one, `commit` rejected, the store had
		 * the bytes, `pending` was already false so nothing was held, `lastError` was `undefined`, and
		 * the indicator read **`saved`**. A failed save reported to its caller with the indicator
		 * saying Saved and no sentence anywhere is the exact inversion this epic exists to remove.
		 *
		 * The behaviour is pre-existing; what was new was the *claim* — an explicit two-item
		 * enumeration of how a drain can stop, and a ranged test whose docblock said it drove every
		 * ending. Neither was true. `#forget` now swallows: **a journal failure is not a save
		 * failure**, and the asymmetry with `#writeAhead`, which swallows a refused `record`, was
		 * itself the bug.
		 *
		 * ⚠ **No shipped journal can reach this, and that is not claimed to be otherwise.**
		 * `WriteAheadJournal.forget` already swallows a refused `removeItem` of its own, and
		 * `EditorSession` is the only place that injects it — so the throwing journal below is a stub,
		 * exercising what the `AutosaveJournal` *interface* permits rather than what any production
		 * implementation does. The enumeration of how a drain can stop has to be true of the
		 * interface, because the interface is what a later journal will be written against.
		 */
		it('does not fail a write the store took because the journal would not forget it', async () => {
			const forgotten: string[] = [];
			const journalling = new Autosave(store, {
				debounceMs: DEBOUNCE,
				journal: {
					record: () => undefined,
					forget: (path) => {
						forgotten.push(path);
						throw new Error('forget blew up');
					}
				}
			});

			const outcome = await journalling
				.commit('p/project.json', utf8.encode('first'))
				.then(() => 'resolved' as const)
				.catch(() => 'rejected' as const);

			expect({
				outcome,
				written: new TextDecoder().decode(await store.read('p/project.json')),
				state: journalling.state,
				pending: journalling.hasPendingWrite('p/project.json'),
				lastError: journalling.lastError,
				forgetWasTried: forgotten
			}).toEqual({
				outcome: 'resolved',
				written: 'first',
				state: 'saved',
				pending: false,
				lastError: undefined,
				forgetWasTried: ['p/project.json']
			});
		});

		/**
		 * ⚠ **WHY THE DEFERRED IN `#drain` IS LOAD-BEARING RATHER THAN DEFENSIVE.**
		 *
		 * `#drainLoop` publishes `'saving'` before it does anything else, and subscribers run
		 * synchronously. A subscriber is application code, so it can commit — and therefore re-enter
		 * `#drain` — *before the loop that provoked it has run a second line*. The memo must already be
		 * in `file.draining` by then, and an `async` method cannot see its own promise to put it there.
		 *
		 * Assigning the loop's promise after the call instead leaves the slot empty for that whole
		 * synchronous cascade, so the re-entrant commit starts a **second concurrent loop on the same
		 * path** — two writes racing into one file, which is exactly the out-of-order write into a
		 * single path that rule 2 exists to forbid, and it is silent.
		 */
		it('keeps one writer per path when a subscriber commits back into it', async () => {
			const { given, land } = writesThatLandOnCommand();
			let reentered = false;
			autosave.subscribe((state) => {
				if (state !== 'saving' || reentered) return;
				reentered = true;
				void autosave.commit('p/project.json', utf8.encode('B')).catch(() => undefined);
			});

			void autosave.commit('p/project.json', utf8.encode('A')).catch(() => undefined);
			await leftAlone(land);

			// One writer: 'A' was superseded before the store ever saw it, so the store is given the
			// newer bytes once and nothing races them. `reentered` is here so that a change which
			// stopped the subscriber being called at all reads as a failure rather than a pass.
			//
			// The two assertions this used to carry as well — that the store then holds 'B', and that
			// nothing is pending — are gone: with two concurrent loops both writing 'B' they are true
			// either way, so no edit could redden them (review 2, finding C).
			expect({ reentered, given }).toEqual({
				reentered: true,
				given: [{ path: 'p/project.json', text: 'B' }]
			});
		});

		/**
		 * ⚠ **The invariant as a property over how a drain can END, not over which method was called.**
		 *
		 * Every assertion above this point picks an operation — a debounce, a commit, a commit in the
		 * settling gap — and checks the invariant for it. That is why a drain stopping *because a
		 * subscriber threw* went unnoticed: it is not an operation, it is a way any operation can end,
		 * and no per-operation test ranges over those. So this one does.
		 *
		 * The property: however a drain stops, the drain has stopped and the indicator says so, the
		 * bytes are held exactly when the store did not take them, and the path is still usable by
		 * **each** of the three routes to the store.
		 *
		 * ⚠ **Each route is asserted where it happens** (review 2, finding B). The first cut ran a
		 * flush, then a debounced queue, then a commit, and asserted only the final contents — so the
		 * last write covered for the two before it, and both a no-op `flush` and a deleted debounce
		 * drain left all three rows green. A route that is written down but not read is decoration.
		 *
		 * ⚠ **This table lost a row in ticket 09, and losing a row is exactly the move that needs
		 * justifying.** `a subscriber threw while the indicator was being published` is no longer a
		 * way a drain can stop — a listener cannot throw into this class any more — so keeping the row
		 * would have meant asserting `holdsTheBytes: true` for a write that now completes. The
		 * property it was here to check has not been dropped: it moved to
		 * `a subscriber that throws cannot touch the write path`, which drives a throwing listener
		 * through **every** publish point rather than only the one at the top of the drain loop.
		 */
		const waysADrainCanStop = [
			{
				ending: 'the store took the bytes',
				arrange: () => undefined,
				holdsTheBytes: false,
				indicator: 'saved'
			},
			{
				ending: 'the store refused the bytes',
				arrange: () =>
					void vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('the disk is full')),
				holdsTheBytes: true,
				indicator: 'unsaved'
			}
		] as const;

		for (const way of waysADrainCanStop) {
			it(`leaves the path alive when a drain stops because ${way.ending}`, async () => {
				way.arrange();

				await autosave.commit('p/project.json', utf8.encode('first')).catch(() => undefined);

				// However it ended, it ended — and the indicator says which, rather than merely not
				// saying "Saving".
				expect({
					state: autosave.state,
					pending: autosave.hasPendingWrite('p/project.json')
				}).toEqual({ state: way.indicator, pending: way.holdsTheBytes });

				// Route 1, flush: the closed-laptop path, and the one nobody would notice was dead.
				// Given something of its own to carry, so this is an assertion in every row rather than
				// only in the two that happen to have bytes left over.
				autosave.queue('p/project.json', utf8.encode('by flush'));
				await autosave.flush();
				expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('by flush');

				// Route 2, the debounce.
				autosave.queue('p/project.json', utf8.encode('by debounce'));
				await vi.advanceTimersByTimeAsync(DEBOUNCE);
				expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('by debounce');

				// Route 3, a gesture-end commit — which must resolve as well as write.
				await expect(
					autosave.commit('p/project.json', utf8.encode('by commit'))
				).resolves.toBeUndefined();
				expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('by commit');
			});
		}
	});

	/**
	 * ⚠ **A SUBSCRIBER THAT THREW CORRUPTED THIS CLASS TWICE, FROM TWO DIFFERENT PUBLISH POINTS**
	 * (ticket 09, and reviews 1 and 2 of ticket 01).
	 *
	 * Once it left a rejected promise memoised against the path for ever, so every later write to
	 * that file was handed the rejection and the indicator sat on "Saving" — `commit`, the debounce
	 * and `flush` all dead for that file, permanently. Once it left the bytes stranded. Each was
	 * closed by guarding the *place it landed*, and each time a new place turned up.
	 *
	 * So the class stopped defending the places. **A listener is never allowed to throw into
	 * `Autosave` at all**: every call into application code is wrapped, and the failure is rethrown
	 * from a `queueMicrotask` — not swallowed, which would be the silence this epic exists to
	 * remove. Ticket 04 established the pattern at the tile-fetch seam and this copies it.
	 *
	 * ⚠ **Driven at every seam rather than at the one that hurt.** The two defects above were both at
	 * `#drainLoop`'s first publish, so a test that drove only that seam would have gone green against
	 * a class that still let `abandon`, `settled` or `subscribe` be taken down. `onJournalRefused` is
	 * in here too: it is a different callback, but it is the same thing — application code called
	 * from inside a method that owns an invariant.
	 */
	describe('a subscriber that throws cannot touch the write path', () => {
		/** A listener that throws on every transition it is told about, for ever. */
		const alwaysThrows = () =>
			autosave.subscribe(() => {
				throw new Error('a listener that could not cope');
			});

		it('lets subscribe itself return, and reports the listener’s failure out of band', async () => {
			const escaped = escapesOutOfBand();

			expect(() => alwaysThrows()).not.toThrow();

			// Not swallowed. `subscribe` replays the current state immediately, so this is the very
			// first call and it has already failed.
			await microtasks();
			expect(escaped.map((cause) => (cause as Error).message)).toEqual([
				'a listener that could not cope'
			]);
		});

		it('still writes a debounced edit, and still writes a committed one', async () => {
			const escaped = escapesOutOfBand();
			alwaysThrows();
			// Subscribed behind the thrower, so it counts exactly the calls the thrower also got: its
			// own immediate replay, and then every transition.
			const alsoTold: SaveState[] = [];
			autosave.subscribe((state) => alsoTold.push(state));

			autosave.queue('p/project.json', utf8.encode('by debounce'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);
			expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('by debounce');

			await expect(
				autosave.commit('p/project.json', utf8.encode('by commit'))
			).resolves.toBeUndefined();
			expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('by commit');

			await microtasks();
			// Every one of those calls failed, and every one of them was reported — one escape for each
			// call a healthy listener beside it received. A count rather than a bare
			// `not.toHaveLength(0)`: this is what says the listener really was called at every publish,
			// so a change that stopped publishing reads as a failure rather than as a pass.
			expect({ escaped: escaped.length, told: alsoTold }).toEqual({
				escaped: 6,
				told: ['saved', 'unsaved', 'saving', 'saved', 'saving', 'saved']
			});
		});

		it('still flushes, abandons and settles', async () => {
			const escaped = escapesOutOfBand();
			alwaysThrows();

			autosave.queue('a/project.json', utf8.encode('flushed'));
			await autosave.flush();
			expect(new TextDecoder().decode(await store.read('a/project.json'))).toBe('flushed');

			autosave.queue('b/project.json', utf8.encode('settled'));
			await expect(autosave.settled('b/')).resolves.toBe(true);
			expect(new TextDecoder().decode(await store.read('b/project.json'))).toBe('settled');

			autosave.queue('c/project.json', utf8.encode('abandoned'));
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
				journal: {
					record: () => {
						throw new Error('the journal is full');
					},
					forget: () => undefined
				},
				onJournalRefused: () => {
					throw new Error('a refusal handler that could not cope');
				}
			});

			// A lost guarantee must not become a lost edit, and neither must a lost *report* of one.
			refusing.queue('p/project.json', utf8.encode('renamed'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('renamed');
			await microtasks();
			expect(escaped.map((cause) => (cause as Error).message)).toEqual([
				'a refusal handler that could not cope'
			]);
		});

		it('notifies every other listener, rather than stopping at the one that threw', async () => {
			escapesOutOfBand();
			const before: SaveState[] = [];
			const after: SaveState[] = [];
			autosave.subscribe((state) => before.push(state));
			alwaysThrows();
			autosave.subscribe((state) => after.push(state));

			await autosave.commit('p/project.json', utf8.encode('a'));

			// ⚠ **The listener registered *after* the thrower is the assertion.** `#publish` iterates
			// its set, and an unguarded throw stopped that iteration — so a single bad subscriber
			// silenced the indicator for everything registered behind it. Named as a residual on the
			// previous shape of this class, closed here.
			await microtasks();
			expect({ before, after }).toEqual({
				before: ['saved', 'saving', 'saved'],
				after: ['saved', 'saving', 'saved']
			});
		});
	});

	describe('what is waiting to be written', () => {
		it('reports a path as pending until the store has it', async () => {
			// Read by the Project view, which must not commit — and so must not stamp a fresh
			// `updatedAt` — when nothing has changed (ADR-0010).
			expect(autosave.hasPendingWrite('p/project.json')).toBe(false);

			autosave.queue('p/project.json', utf8.encode('a'));
			expect(autosave.hasPendingWrite('p/project.json')).toBe(true);

			await autosave.flush();
			expect(autosave.hasPendingWrite('p/project.json')).toBe(false);
		});
	});

	/**
	 * ⚠ **THE HOLE THAT DISARMED TICKET 21's `project-deleted` LAYER.**
	 *
	 * `EditorSession.deleteProject` emptied the write-ahead *journal* of the Project it was deleting
	 * and left `Autosave`'s own pending bytes exactly where they were. The journal is written **from**
	 * those bytes, so both halves of rule 3 undid the sweep within milliseconds: `capture()`
	 * re-records `<project>/project.json` at `pagehide`, after the sweep, and `flush()` writes it into
	 * the store outright. Either resurrects a Project the user watched disappear — and the
	 * `project-deleted` layer cannot catch it, because by the time the next startup replays, the
	 * deletion it named has finished and its record has been dropped.
	 */
	describe('giving up on what is being deleted', () => {
		it('drops pending bytes, so neither capture nor flush can put them back', async () => {
			const journalled = new Map<string, Uint8Array>();
			const journalling = new Autosave(store, {
				debounceMs: DEBOUNCE,
				journal: {
					record: (path, bytes) => void journalled.set(path, bytes),
					forget: (path) => void journalled.delete(path)
				}
			});
			journalling.queue('amsterdam-1625/project.json', utf8.encode('a rename mid-debounce'));
			expect([...journalled.keys()]).toEqual(['amsterdam-1625/project.json']);

			journalling.abandon('amsterdam-1625/');

			// The journal is empty, and — the half that was missing — so is the source it is written
			// from, so `pagehide` cannot refill it.
			expect(journalled.size).toBe(0);
			journalling.capture();
			expect(journalled.size).toBe(0);
			// And nothing is written into the store for a Project that is being removed.
			await journalling.flush();
			expect(writes).toEqual([]);
			expect(journalling.hasPendingWrite('amsterdam-1625/project.json')).toBe(false);
		});

		it('leaves every other Project’s pending bytes alone', async () => {
			autosave.queue('amsterdam-1625/project.json', utf8.encode('a'));
			autosave.queue('boston-1775/project.json', utf8.encode('b'));

			autosave.abandon('amsterdam-1625/');
			await autosave.flush();

			expect(writes).toEqual(['boston-1775/project.json']);
		});

		/**
		 * ⚠ **A write the store already has cannot be called back, and the sweep read as though it
		 * could** (ticket 21, review 3). `#drainLoop` captures its `bytes` and then awaits
		 * `store.write`; clearing `pending` does not reach into that await. So the bytes of an edit
		 * whose debounce had just fired land *after* the deletion that abandoned them has listed the
		 * directory — recreating the file behind it, and `Workspace.deleteProject` then drops the
		 * record that would have caught it at the next startup.
		 *
		 * Everything this *can* stop is stopped before the call returns; the promise is for the rest,
		 * and `Workspace.deleteProject` waits on it after writing the deletion down and before
		 * removing a byte.
		 */
		it('answers with a promise for the write it could not stop', async () => {
			let land = (): void => undefined;
			vi.spyOn(store, 'write').mockImplementation(
				async (path) =>
					new Promise<void>((resolve) => {
						land = () => {
							writes.push(path);
							resolve();
						};
					})
			);
			autosave.queue('amsterdam-1625/project.json', utf8.encode('a rename mid-debounce'));
			// The window closes, so the bytes are handed to the store and are no longer callable back.
			await vi.advanceTimersByTimeAsync(DEBOUNCE);
			expect(writes).toEqual([]);

			let settled = false;
			void autosave.abandon('amsterdam-1625/').then(() => (settled = true));

			// Not yet: the store still has the bytes, and this is exactly the window in which a
			// deletion would have listed the directory and missed them.
			await vi.advanceTimersByTimeAsync(0);
			expect(settled).toBe(false);

			land();
			await vi.advanceTimersByTimeAsync(0);
			expect(settled).toBe(true);
			expect(writes).toEqual(['amsterdam-1625/project.json']);
		});

		/**
		 * The other half of the same rule, and the reason the entry is **kept** while a write is in
		 * flight rather than dropped with the rest: a write already in flight owns its entry until
		 * `#drain`'s `finally` removes it. Dropped here, the next `queue` for that path builds a fresh
		 * entry with no `draining` on it and starts a **second** concurrent write to the same file —
		 * which is exactly the out-of-order write into one path that rule 2's one-writer-per-path
		 * invariant exists to prevent, arriving through the sweep.
		 */
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
			autosave.queue('amsterdam-1625/project.json', utf8.encode('first'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			void autosave.abandon('amsterdam-1625/');
			// A Project of the same name made straight afterwards, writing to the same path.
			autosave.queue('amsterdam-1625/project.json', utf8.encode('second'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			// One writer. The second edit's bytes are pending behind the first, not racing it.
			land();
			await vi.advanceTimersByTimeAsync(0);
			expect(writes).toEqual(['amsterdam-1625/project.json']);
		});

		/**
		 * ⚠ **THE RESURRECTION DEFECT AT THE SEAM `abandon` CANNOT SWEEP** (ticket 09).
		 *
		 * The sibling test above drops a Project's bytes while they sit in a debounce, and asserts
		 * that neither `capture` nor `flush` can put them back. The other half — a write already handed
		 * to the store when Delete is pressed — had nothing saying the same thing, and it is the half
		 * where the bytes are *still in this object*, held by the drain that cannot be called back.
		 *
		 * So `capture()` at `pagehide` would re-journal them and the next startup would replay a
		 * Project the user watched disappear: ticket 21's defect exactly, by the one route its own
		 * tests could not build.
		 *
		 * ⚠ **And the indicator must still read "Saving" while that write is out there**, because it
		 * is: saying "Saved" for bytes the store has not answered about is the inversion this epic
		 * exists to remove, and it does not stop being one because the file is on its way out.
		 */
		it('gives up the bytes of a write it could not stop, without pretending it is over', async () => {
			const journalled = new Map<string, Uint8Array>();
			const journalling = new Autosave(store, {
				debounceMs: DEBOUNCE,
				journal: {
					record: (path, bytes) => void journalled.set(path, bytes),
					forget: (path) => void journalled.delete(path)
				}
			});
			let land = (): void => undefined;
			vi.spyOn(store, 'write').mockImplementation(
				async (path) =>
					new Promise<void>((resolve) => {
						land = () => {
							writes.push(path);
							resolve();
						};
					})
			);
			journalling.queue('amsterdam-1625/project.json', utf8.encode('a rename mid-debounce'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);
			expect([...journalled.keys()]).toEqual(['amsterdam-1625/project.json']);

			const abandoning = journalling.abandon('amsterdam-1625/');

			// Given up: nothing here is holding them any more, so `pagehide` has nothing to re-record.
			journalling.capture();
			expect({
				pending: journalling.hasPendingWrite('amsterdam-1625/project.json'),
				journal: [...journalled.keys()],
				// …and yet a write really is still out there, and the indicator says so rather than
				// reporting a file it has no answer about as saved.
				state: journalling.state
			}).toEqual({ pending: false, journal: [], state: 'saving' });

			land();
			await expect(abandoning).resolves.toBe(true);
			expect({ state: journalling.state, journal: [...journalled.keys()] }).toEqual({
				state: 'saved',
				journal: []
			});
		});

		/** And a failed write settles it too: bytes the store refused are bytes the store has not got. */
		it('answers even when the write it could not stop rejected', async () => {
			vi.spyOn(store, 'write').mockRejectedValue(new Error('the disk is full'));
			autosave.queue('amsterdam-1625/project.json', utf8.encode('a'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			await expect(autosave.abandon('amsterdam-1625/')).resolves.toBe(true);
		});

		/**
		 * ⚠ **A store write is not guaranteed to settle, and this one is on a gesture the user is
		 * watching** (ticket 21, round 4). A folder whose grant was revoked mid-write, or an OPFS
		 * handle a second tab tore down, leaves `store.write` pending with nothing to reject it. Round
		 * 3 made `Workspace.deleteProject` await this — where before it was synchronous and the
		 * removal ran regardless — so an unbounded wait here is a Delete button that does nothing, for
		 * ever, with the Project still on screen. And in a folder Workspace the consequence compounds:
		 * the deletion never finishes, so the next startup shows a refusal about it.
		 *
		 * The answer is `false` rather than a silent timeout, because "we gave up waiting" is a
		 * different fact from "everything is quiet" and the caller has to keep its deletion record for
		 * the first.
		 */
		it('gives up on a write that is never going to settle, and says it gave up', async () => {
			const waiting = new Autosave(store, { debounceMs: DEBOUNCE, inFlightWaitMs: 5000 });
			vi.spyOn(store, 'write').mockImplementation(() => new Promise<never>(() => undefined));
			waiting.queue('amsterdam-1625/project.json', utf8.encode('a'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			let answer: boolean | 'still waiting' = 'still waiting';
			void waiting.abandon('amsterdam-1625/').then((quiet) => (answer = quiet));

			// Still waiting a moment before the bound, so this is a bound and not an immediate refusal.
			await vi.advanceTimersByTimeAsync(4999);
			expect(answer).toBe('still waiting');

			await vi.advanceTimersByTimeAsync(1);
			expect(answer).toBe(false);
		});

		/**
		 * ⚠ **THE CASE `settled` WAS BUILT FOR, AND THE ONE ITS FIRST CUT DID NOT COVER** (round 5).
		 *
		 * It waited only on `file.draining` — a write the store already had — which is precisely the
		 * state that does *not* obtain when the user drags a Control Point and presses Delete. Inside
		 * the 400 ms debounce there is no drain: `pending` is set and `draining` is undefined, so the
		 * wait answered `true` on the spot and the timer fired **during** `deleteHistoricalMap`'s own
		 * awaits — the first of which walks every Project in the Workspace. The Alignment landed after
		 * `alignments/<id>.json` had been removed, orphaning a placement for a map that is gone, which
		 * is the one leftover that function exists to prevent.
		 *
		 * The pending case is the live one, and the suite already said so: the test below queues a
		 * second edit and asserts it is still pending while the wait runs.
		 */
		it('drains a file still inside its debounce, rather than calling it quiet', async () => {
			let land = (): void => undefined;
			vi.spyOn(store, 'write').mockImplementation(
				async (path) =>
					new Promise<void>((resolve) => {
						land = () => {
							writes.push(path);
							resolve();
						};
					})
			);
			// A Control Point dragged, and Delete pressed before the window closes. Nothing is in
			// flight: this is the whole of what `Autosave` is holding.
			// alignment-write-is-the-fixture: the debounced edit is the specimen the deletion has to wait for
			autosave.queue('alignments/aaa1.json', utf8.encode('a placement mid-drag'));
			expect(writes).toEqual([]);

			let quiet: boolean | 'still waiting' = 'still waiting';
			void autosave.settled('alignments/aaa1.json').then((answer) => (quiet = answer));

			// Not "quiet" — and not waiting on the debounce either: the write is started **now**, which
			// is the only reading of "settled" that is true of bytes that have not left this object.
			await vi.advanceTimersByTimeAsync(0);
			expect(quiet).toBe('still waiting');
			// The write is under way **without the debounce having elapsed** — the indicator says so —
			// which is the difference between draining a pending file and waiting for its timer.
			expect(autosave.state).toBe('saving');

			land();
			await vi.advanceTimersByTimeAsync(0);
			expect(quiet).toBe(true);
			// And the edit is on disk, not discarded: if the deletion is now refused the user has it.
			expect(writes).toEqual(['alignments/aaa1.json']);
		});

		/**
		 * ⚠ **The prefix is load-bearing and nothing asserted it** (round 5). Without it every call
		 * would wait on every write in the Workspace, so one stuck write in a Project nobody is
		 * looking at would put the whole two-second bound on every Historical Map deletion — a pause
		 * with no cause the user could see, and no test to say why.
		 */
		it('ignores a write in flight somewhere else in the Workspace', async () => {
			vi.spyOn(store, 'write').mockImplementation(() => new Promise<never>(() => undefined));
			autosave.queue('amsterdam-1625/project.json', utf8.encode('a rename that will never land'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			// The map being deleted has nothing outstanding, so this must not wait on the Project's.
			await expect(autosave.settled('images/aaa1/')).resolves.toBe(true);
		});

		/**
		 * `settled` is `abandon`'s half that loses nothing: it brings a prefix to rest and discards no
		 * bytes and no journal entry. It exists for `deleteHistoricalMap`, which decides for itself
		 * whether the deletion may happen at all and must not have the user's unsaved Alignment thrown
		 * away before it does.
		 */
		it('waits for a path without giving anything up', async () => {
			const journalled = new Map<string, Uint8Array>();
			const waiting = new Autosave(store, {
				debounceMs: DEBOUNCE,
				journal: {
					record: (path, bytes) => void journalled.set(path, bytes),
					forget: (path) => void journalled.delete(path)
				}
			});
			let land = (): void => undefined;
			vi.spyOn(store, 'write').mockImplementation(
				async (path) =>
					new Promise<void>((resolve) => {
						land = () => {
							writes.push(path);
							resolve();
						};
					})
			);
			// alignment-write-is-the-fixture: the path is the specimen `settled` waits on — this is the caller it exists for, and nothing here is an Alignment document
			waiting.queue('alignments/aaa1.json', utf8.encode('a placement mid-drag'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);
			// A second edit typed while the first is in flight: pending bytes `abandon` would drop.
			// alignment-write-is-the-fixture: the second edit is the specimen for "nothing was given up"
			waiting.queue('alignments/aaa1.json', utf8.encode('and one more control point'));

			let quiet: boolean | 'still waiting' = 'still waiting';
			void waiting.settled('alignments/aaa1.json').then((answer) => (quiet = answer));
			await vi.advanceTimersByTimeAsync(0);
			expect(quiet).toBe('still waiting');
			// ⚠ **The assertion that separates this from `abandon`, and it has to be made here** —
			// while the wait is still running, which is the moment `abandon` would already have thrown
			// both away. The second edit is still pending and still journalled.
			expect(waiting.hasPendingWrite('alignments/aaa1.json')).toBe(true);
			expect([...journalled.keys()]).toEqual(['alignments/aaa1.json']);

			// The first write lands, and the drain loop starts a second for the newer bytes — so the
			// store is not quiet yet, which is exactly what this is waiting to be told.
			land();
			await vi.advanceTimersByTimeAsync(0);
			expect(quiet).toBe('still waiting');

			land();
			await vi.advanceTimersByTimeAsync(0);
			expect(quiet).toBe(true);
			expect(writes).toEqual(['alignments/aaa1.json', 'alignments/aaa1.json']);
		});

		it('answers at once for a path the store is not writing', async () => {
			await expect(autosave.settled('alignments/aaa1.json')).resolves.toBe(true);
		});

		/**
		 * ⚠ **The shipped bound, not an injected one** (round 5). Every other assertion here passes an
		 * `inFlightWaitMs`, so deleting `?? 2000` from the constructor left the suite green — and a
		 * bound of zero is not cosmetic: every `deleteProject` with any write in flight would answer
		 * `false`, keep its deletion record, and produce a refusal at the next startup for a deletion
		 * that had in fact finished. The number is a judgement, but that it is *this* number, and
		 * comfortably longer than a debounce, is a fact the build should hold to.
		 */
		it('waits two seconds by default, which is what every caller that says nothing gets', async () => {
			const shipped = new Autosave(store, { debounceMs: DEBOUNCE });
			vi.spyOn(store, 'write').mockImplementation(() => new Promise<never>(() => undefined));
			shipped.queue('amsterdam-1625/project.json', utf8.encode('a'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			let answer: boolean | 'still waiting' = 'still waiting';
			void shipped.abandon('amsterdam-1625/').then((quiet) => (answer = quiet));

			await vi.advanceTimersByTimeAsync(1999);
			expect(answer).toBe('still waiting');
			await vi.advanceTimersByTimeAsync(1);
			expect(answer).toBe(false);
		});

		it('clears the timer, so the indicator does not sit on “Unsaved” for a file that has gone', () => {
			autosave.queue('amsterdam-1625/project.json', utf8.encode('a'));
			expect(autosave.state).toBe('unsaved');

			autosave.abandon('amsterdam-1625/');

			expect(autosave.state).toBe('saved');
			expect(vi.getTimerCount()).toBe(0);
		});
	});

	describe('the save state (rule 5)', () => {
		it('goes saved → unsaved → saving → saved across one debounced write', async () => {
			expect(states).toEqual(['saved']);

			autosave.queue('p/project.json', utf8.encode('a'));
			expect(states).toEqual(['saved', 'unsaved']);

			await vi.advanceTimersByTimeAsync(DEBOUNCE);
			expect(states).toEqual(['saved', 'unsaved', 'saving', 'saved']);
		});

		it('goes saving → saved for a gesture-end commit, with no unsaved stop in between', async () => {
			await autosave.commit('p/project.json', utf8.encode('a'));

			expect(states).toEqual(['saved', 'saving', 'saved']);
		});

		it('does not claim saved when the store rejected the write', async () => {
			vi.spyOn(store, 'write').mockRejectedValue(new Error('storage went away'));

			await autosave.commit('p/project.json', utf8.encode('a')).catch(() => undefined);

			expect(autosave.state).toBe('unsaved');
			expect(autosave.lastError).toBeInstanceOf(Error);
		});

		it('does not claim saved because some other file was written afterwards', async () => {
			// The concrete failure this forbids: rename a Project with OPFS quota exhausted, then
			// create any other Project, and the indicator read "Saved" for an edit that was never
			// written. ADR-0017 rule 5 exists because the indicator is the user's only signal, so an
			// indicator that lies is worse than none.
			vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('quota exceeded'));
			await autosave
				.commit('amsterdam-1625/project.json', utf8.encode('renamed'))
				.catch(() => undefined);
			expect(autosave.state).toBe('unsaved');

			await autosave.commit('boston-1775/project.json', utf8.encode('a new Project'));

			expect(autosave.state).toBe('unsaved');
			expect(autosave.lastError).toBeInstanceOf(Error);
		});

		it('reports the current state to a new subscriber straight away', () => {
			const seen: SaveState[] = [];
			autosave.subscribe((state) => seen.push(state));

			expect(seen).toEqual(['saved']);
		});

		it('stops notifying an unsubscribed listener', async () => {
			const seen: SaveState[] = [];
			autosave.subscribe((state) => seen.push(state))();

			await autosave.commit('p/project.json', utf8.encode('a'));

			expect(seen).toEqual(['saved']);
		});
	});
});

describe('installFlushOnHide (rule 3)', () => {
	class FakeTarget {
		readonly listeners = new Map<string, EventListener>();
		addEventListener(type: string, listener: EventListener) {
			this.listeners.set(type, listener);
		}
		removeEventListener(type: string) {
			this.listeners.delete(type);
		}
		fire(type: string) {
			this.listeners.get(type)?.(new Event(type));
		}
	}

	const setup = () => {
		const store = new MemoryProjectStore();
		const autosave = new Autosave(store, { debounceMs: 10_000 });
		const doc = new FakeTarget() as FakeTarget & { visibilityState: DocumentVisibilityState };
		doc.visibilityState = 'visible';
		const win = new FakeTarget();
		const uninstall = installFlushOnHide(autosave, {
			document: doc as unknown as Document,
			window: win as unknown as Window
		});
		return { store, autosave, doc, win, uninstall };
	};

	/**
	 * Let the listener's own `flush()` run to completion.
	 *
	 * The test must never call `flush()` itself. These two tests used to, which made them
	 * assertions that `flush` works — deleting the listener bodies outright left both green, and
	 * rule 3 is the closed-laptop path, the one nobody notices is missing until an afternoon is
	 * gone. The debounce here is 10 s, so nothing but the listener can have written.
	 */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	it('flushes on pagehide', async () => {
		const { store, autosave, win } = setup();
		autosave.queue('p/project.json', utf8.encode('a'));

		win.fire('pagehide');
		await settle();

		expect(await store.list('')).toEqual(['p/project.json']);
	});

	it('flushes when the page becomes hidden', async () => {
		const { store, autosave, doc } = setup();
		autosave.queue('p/project.json', utf8.encode('a'));

		doc.visibilityState = 'hidden';
		doc.fire('visibilitychange');
		await settle();

		expect(await store.list('')).toEqual(['p/project.json']);
	});

	it('does not flush when the page merely becomes visible again', async () => {
		const { store, autosave, doc } = setup();
		autosave.queue('p/project.json', utf8.encode('a'));

		doc.fire('visibilitychange');

		expect(await store.list('')).toEqual([]);
	});

	it('never listens for beforeunload, which mobile browsers ignore', () => {
		const { doc, win } = setup();

		expect([...doc.listeners.keys(), ...win.listeners.keys()]).toEqual([
			'visibilitychange',
			'pagehide'
		]);
	});

	it('removes its listeners again', () => {
		const { doc, win, uninstall } = setup();
		uninstall();

		expect([...doc.listeners.keys(), ...win.listeners.keys()]).toEqual([]);
	});
});
