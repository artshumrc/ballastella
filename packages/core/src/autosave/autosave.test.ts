import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import { Autosave, type SaveState } from './autosave.js';
import { installFlushOnHide } from './flush-on-hide.js';

const utf8 = new TextEncoder();
const DEBOUNCE = 400;

describe('Autosave', () => {
	let store: MemoryProjectStore;
	let writes: string[];
	let autosave: Autosave;
	let states: SaveState[];

	beforeEach(() => {
		vi.useFakeTimers();
		store = new MemoryProjectStore();
		writes = [];
		const write = store.write.bind(store);
		vi.spyOn(store, 'write').mockImplementation(async (path, bytes) => {
			writes.push(path);
			await write(path, bytes);
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

		/** And a failed write settles it too: bytes the store refused are bytes the store has not got. */
		it('answers even when the write it could not stop rejected', async () => {
			vi.spyOn(store, 'write').mockRejectedValue(new Error('the disk is full'));
			autosave.queue('amsterdam-1625/project.json', utf8.encode('a'));
			await vi.advanceTimersByTimeAsync(DEBOUNCE);

			await expect(autosave.abandon('amsterdam-1625/')).resolves.toBeUndefined();
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
