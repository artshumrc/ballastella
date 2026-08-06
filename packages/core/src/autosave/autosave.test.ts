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
			autosave.queue('alignments/one.json', utf8.encode('mid-drag'));
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
