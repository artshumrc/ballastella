import { describe, expect, it } from 'vitest';

import { Autosave } from '../autosave/autosave.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { readIfPresent, type StorePath } from '../store/project-store.js';
import { EditHistory, type HistoryFiles, type Step } from './edit-history.js';
import { encode, decode } from '../test-support.js';

const NOTES: StorePath = 'floride/notes.txt';
const ROUTES: StorePath = 'floride/routes.txt';

function filesOf(store: MemoryProjectStore, autosave: Autosave): HistoryFiles {
	return {
		flush: () => autosave.flush(),
		read: (path) => readIfPresent(store, path),
		writeBack: async (path, bytes) => {
			if (bytes === null) await store.delete(path);
			else await autosave.commit(path, bytes);
		}
	};
}

async function undoAll(history: EditHistory): Promise<string[]> {
	const labels: string[] = [];
	while (history.undoable !== null) {
		labels.push(history.undoable.label);
		await history.undo();
	}
	return labels;
}

function seam(options?: { depth?: number; byteCeiling?: number }) {
	const store = new MemoryProjectStore();
	const autosave = new Autosave(store);
	const history = new EditHistory(filesOf(store, autosave), options);
	const held = (path: StorePath): Promise<string | null> =>
		store.read(path).then(decode, () => null);
	const edit = (label: string, text: string) =>
		history.step(label, [NOTES], async () => {
			autosave.queue(NOTES, encode(text));
		});
	return { store, autosave, history, held, edit };
}

describe('a gesture wrapped as a Step', () => {
	it('records both images of what the gesture wrote, through a flush, and puts it back', async () => {
		const { autosave, history, held } = seam();
		autosave.queue(NOTES, encode('the first reading'));

		const answer = await history.step('Undo delete of “notes”', [NOTES], async () => {
			autosave.queue(NOTES, encode('the second reading'));
			return 'done';
		});

		expect(answer).toBe('done');
		expect(history.undoable?.files[0]?.before).toEqual(encode('the first reading'));
		expect(history.undoable?.files[0]?.after).toEqual(encode('the second reading'));
		expect(await held(NOTES)).toBe('the second reading');
		expect(history.undoable?.label).toBe('Undo delete of “notes”');
		expect(history.redoable).toBeNull();
		expect(await history.undo()).toBe(true);
		expect(await held(NOTES)).toBe('the first reading');
		expect(history.undoable).toBeNull();
	});

	it('records a file that did not exist as absent, and redo removes it again', async () => {
		const { history, held, edit } = seam();
		await edit('Undo draw', 'a new file');

		expect(history.undoable?.files[0]?.before).toBeNull();
		expect(await history.undo()).toBe(true);
		expect(await held(NOTES)).toBeNull();
		expect(await history.redo()).toBe(true);
		expect(await held(NOTES)).toBe('a new file');
	});

	it('lets a throwing gesture through unchanged and records nothing', async () => {
		const { autosave, history } = seam();
		const boom = new Error('the store went away');

		await expect(
			history.step('Undo edit', [NOTES], async () => {
				autosave.queue(NOTES, encode('half an edit'));
				throw boom;
			})
		).rejects.toBe(boom);

		expect(history.undoable).toBeNull();
	});

	it('records nothing when every declared file is byte-identical either side', async () => {
		const { autosave, history, edit } = seam();
		autosave.queue(NOTES, encode('unchanged'));
		await edit('Undo edit', 'unchanged');

		expect(history.undoable).toBeNull();
	});
});

describe('the cursor', () => {
	it('walks back and forward through a run of Steps', async () => {
		const { history, held, edit } = seam();
		await edit('Undo edit one', 'one');
		await edit('Undo edit two', 'two');
		await edit('Undo edit three', 'three');

		expect(await history.undo()).toBe(true);
		expect(await history.undo()).toBe(true);
		expect(await held(NOTES)).toBe('one');
		expect(history.undoable?.label).toBe('Undo edit one');
		expect(history.redoable?.label).toBe('Undo edit two');
		expect(await history.redo()).toBe(true);
		expect(await history.redo()).toBe(true);
		expect(await held(NOTES)).toBe('three');
		expect(history.redoable).toBeNull();
	});

	it('holds five Steps, and a sixth evicts the oldest', async () => {
		const { history, edit } = seam();
		for (const n of [1, 2, 3, 4, 5, 6]) await edit(`Undo edit ${n}`, `${n}`);

		expect(await undoAll(history)).toEqual([6, 5, 4, 3, 2].map((n) => `Undo edit ${n}`));
	});

	it('truncates everything ahead of it when a new Step is pushed', async () => {
		const { history, held, edit } = seam();
		await edit('Undo edit one', 'one');
		await edit('Undo edit two', 'two');
		await history.undo();
		expect(history.redoable?.label).toBe('Undo edit two');

		await edit('Undo edit three', 'three');

		expect(history.redoable).toBeNull();
		expect(history.undoable?.label).toBe('Undo edit three');
		expect(await undoAll(history)).toEqual(['Undo edit three', 'Undo edit one']);
		expect(await held(NOTES)).toBeNull();
	});
});

describe('the byte ceiling', () => {
	it('evicts oldest-first as a backstop, but never the most recent Step', async () => {
		const ceiling = seam({ byteCeiling: 45 });
		await ceiling.edit('Undo edit one', 'a'.repeat(10));
		await ceiling.edit('Undo edit two', 'b'.repeat(10));
		await ceiling.edit('Undo edit three', 'c'.repeat(10));
		expect(await undoAll(ceiling.history)).toEqual(['Undo edit three', 'Undo edit two']);

		const tiny = seam({ byteCeiling: 1 });
		await tiny.edit('Undo edit one', 'a'.repeat(4096));
		expect(tiny.history.undoable?.label).toBe('Undo edit one');
	});
});

describe('a write that does not land', () => {
	it('refuses a second call while one is still in flight', async () => {
		const store = new MemoryProjectStore();
		const autosave = new Autosave(store);
		const port = filesOf(store, autosave);
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let held = false;
		const history = new EditHistory({
			...port,
			writeBack: async (path, bytes) => {
				if (!held) {
					held = true;
					await gate;
				}
				await port.writeBack(path, bytes);
			}
		});

		autosave.queue(NOTES, encode('the first reading'));
		await history.step('Undo edit', [NOTES], async () => {
			autosave.queue(NOTES, encode('the second reading'));
		});

		const first = history.undo();
		expect(await history.undo()).toBe(false);
		release();
		expect(await first).toBe(true);
		expect(decode(await store.read(NOTES))).toBe('the first reading');
	});
});

describe('discard', () => {
	it('empties both directions and announces', async () => {
		const { history, edit } = seam();
		await edit('Undo edit one', 'one');
		await edit('Undo edit two', 'two');
		await history.undo();

		const seen: { undoable: Step | null; redoable: Step | null }[] = [];
		history.subscribe((state) => seen.push(state));
		history.discard();

		expect(history.undoable).toBeNull();
		expect(history.redoable).toBeNull();
		expect(seen.at(-1)).toEqual({ undoable: null, redoable: null });
		expect(seen).toHaveLength(2);
	});
});

describe('subscribe', () => {
	it('calls its listener once immediately, on every change, and stops when unsubscribed', async () => {
		const { history, edit } = seam();
		const seen: (string | null)[] = [];
		const stop = history.subscribe((state) => seen.push(state.undoable?.label ?? null));
		expect(seen).toEqual([null]);

		await edit('Undo edit', 'one');
		expect(seen).toEqual([null, 'Undo edit']);

		await history.undo();
		expect(seen).toEqual([null, 'Undo edit', null]);
		stop();
		await history.redo();
		expect(seen).toEqual([null, 'Undo edit', null]);
	});
});

describe('a Step over several files', () => {
	it('puts every one back, or answers false and leaves the cursor exactly where it was', async () => {
		const { store, autosave, history, held } = seam();
		autosave.queue(NOTES, encode('notes before'));
		autosave.queue(ROUTES, encode('routes before'));

		await history.step('Undo edit', [NOTES, ROUTES], async () => {
			autosave.queue(NOTES, encode('notes after'));
			autosave.queue(ROUTES, encode('routes after'));
		});
		expect(history.undoable?.files).toHaveLength(2);

		store.failNextWrite('rename');
		expect(await history.undo()).toBe(false);
		expect(history.undoable?.label).toBe('Undo edit');
		expect(history.redoable).toBeNull();
		expect(await history.undo()).toBe(true);
		expect(await held(NOTES)).toBe('notes before');
		expect(await held(ROUTES)).toBe('routes before');
	});
});
