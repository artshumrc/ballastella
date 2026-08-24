import { describe, expect, it } from 'vitest';

import { Autosave } from '../autosave/autosave.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { PathNotFoundError, type Bytes, type StorePath } from '../store/project-store.js';
import { EditHistory, type HistoryFiles, type Step } from './edit-history.js';

const NOTES: StorePath = 'floride/notes.txt';
const ROUTES: StorePath = 'floride/routes.txt';

const encode = (text: string): Bytes => new TextEncoder().encode(text);
const decode = (bytes: Bytes): string => new TextDecoder().decode(bytes);

/**
 * The port as the session implements it: reads go straight to the store, writes go through the same
 * {@link Autosave} as every other edit, and `null` is a deletion.
 */
function filesOf(store: MemoryProjectStore, autosave: Autosave): HistoryFiles {
	return {
		flush: () => autosave.flush(),
		read: async (path) => {
			try {
				return await store.read(path);
			} catch (cause) {
				if (cause instanceof PathNotFoundError) return null;
				throw cause;
			}
		},
		writeBack: async (path, bytes) => {
			if (bytes === null) await store.delete(path);
			else await autosave.commit(path, bytes);
		}
	};
}

function seam(options?: { depth?: number; byteCeiling?: number }) {
	const store = new MemoryProjectStore();
	const autosave = new Autosave(store);
	const history = new EditHistory(filesOf(store, autosave), options);
	const held = async (path: StorePath): Promise<string | null> => {
		try {
			return decode(await store.read(path));
		} catch {
			return null;
		}
	};
	return { store, autosave, history, held };
}

describe('a gesture wrapped as a Step', () => {
	// The crux: with a sub-second per-file debounce the edit *is* the last saved state by the time undo
	// is reached, so the images are taken around a flush.
	it('records what the gesture wrote and puts it back', async () => {
		const { autosave, history, held } = seam();
		autosave.queue(NOTES, encode('the first reading'));
		await autosave.flush();

		const answer = await history.step('Undo delete of “notes”', [NOTES], async () => {
			autosave.queue(NOTES, encode('the second reading'));
			return 'done';
		});

		expect(answer).toBe('done');
		expect(await held(NOTES)).toBe('the second reading');
		expect(history.undoable?.label).toBe('Undo delete of “notes”');
		expect(history.redoable).toBeNull();

		expect(await history.undo()).toBe(true);
		expect(await held(NOTES)).toBe('the first reading');
		expect(history.undoable).toBeNull();
	});

	// Both flushes are load-bearing: the gesture's own write sits inside the debounce window, and an
	// unflushed edit would put the wrong bytes in either image.
	it('takes both images through a flush, so neither holds unwritten bytes', async () => {
		const { autosave, history, held } = seam();
		// Queued and never flushed by the caller: the "before" image has to be this, not nothing.
		autosave.queue(NOTES, encode('the first reading'));

		await history.step('Undo edit', [NOTES], async () => {
			autosave.queue(NOTES, encode('the second reading'));
		});

		expect(history.undoable?.files[0]?.before).toEqual(encode('the first reading'));
		expect(history.undoable?.files[0]?.after).toEqual(encode('the second reading'));
		expect(await held(NOTES)).toBe('the second reading');
	});

	it('records a file that did not exist as absent, and redo removes it again', async () => {
		const { autosave, history, held } = seam();

		await history.step('Undo draw', [NOTES], async () => {
			autosave.queue(NOTES, encode('a new file'));
		});

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

	// A no-op is not a thing to undo, and offering one would spend a Step of a five-deep history.
	it('records nothing when every declared file is byte-identical either side', async () => {
		const { autosave, history } = seam();
		autosave.queue(NOTES, encode('unchanged'));

		await history.step('Undo edit', [NOTES], async () => {
			autosave.queue(NOTES, encode('unchanged'));
		});

		expect(history.undoable).toBeNull();
	});
});

describe('the cursor', () => {
	const write = async (
		history: EditHistory,
		autosave: Autosave,
		label: string,
		text: string
	): Promise<void> => {
		await history.step(label, [NOTES], async () => {
			autosave.queue(NOTES, encode(text));
		});
	};

	it('walks back and forward through a run of Steps', async () => {
		const { autosave, history, held } = seam();
		await write(history, autosave, 'Undo edit one', 'one');
		await write(history, autosave, 'Undo edit two', 'two');
		await write(history, autosave, 'Undo edit three', 'three');

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

	// SPEC stories 10 and 11: the sixth edit forgets the oldest rather than refusing to record.
	it('holds five Steps, and a sixth evicts the oldest', async () => {
		const { autosave, history } = seam();
		for (const n of [1, 2, 3, 4, 5, 6]) await write(history, autosave, `Undo edit ${n}`, `${n}`);

		const labels: string[] = [];
		while (history.undoable !== null) {
			labels.push(history.undoable.label);
			await history.undo();
		}
		expect(labels).toEqual([
			'Undo edit 6',
			'Undo edit 5',
			'Undo edit 4',
			'Undo edit 3',
			'Undo edit 2'
		]);
	});

	// SPEC story 9: redo never offers a future the scholar has contradicted.
	it('truncates everything ahead of it when a new Step is pushed', async () => {
		const { autosave, history } = seam();
		await write(history, autosave, 'Undo edit one', 'one');
		await write(history, autosave, 'Undo edit two', 'two');
		await history.undo();
		expect(history.redoable?.label).toBe('Undo edit two');

		await write(history, autosave, 'Undo edit three', 'three');

		expect(history.redoable).toBeNull();
		expect(history.undoable?.label).toBe('Undo edit three');
	});
});

describe('the byte ceiling', () => {
	const step = async (history: EditHistory, autosave: Autosave, label: string, text: string) => {
		await history.step(label, [NOTES], async () => {
			autosave.queue(NOTES, encode(text));
		});
	};

	it('evicts oldest-first as a backstop', async () => {
		// Each Step after the first carries both images, so ten bytes of text is twenty of history.
		const { autosave, history } = seam({ byteCeiling: 45 });
		await step(history, autosave, 'Undo edit one', 'aaaaaaaaaa');
		await step(history, autosave, 'Undo edit two', 'bbbbbbbbbb');
		await step(history, autosave, 'Undo edit three', 'cccccccccc');

		const labels: string[] = [];
		while (history.undoable !== null) {
			labels.push(history.undoable.label);
			await history.undo();
		}
		expect(labels).toEqual(['Undo edit three', 'Undo edit two']);
	});

	// SPEC story 12: undo covers the last thing done even when it touched a large file.
	it('never evicts the most recent Step for size', async () => {
		const { autosave, history } = seam({ byteCeiling: 1 });
		await step(history, autosave, 'Undo edit one', 'a'.repeat(4096));

		expect(history.undoable?.label).toBe('Undo edit one');
	});
});

describe('a write that does not land', () => {
	// SPEC story 50: a failure must not look exactly like a success, and the affordance has to stay
	// on the bar so the scholar can try again.
	it('answers false and leaves the cursor exactly where it was', async () => {
		const { store, autosave, history, held } = seam();
		autosave.queue(NOTES, encode('the first reading'));
		await history.step('Undo edit', [NOTES], async () => {
			autosave.queue(NOTES, encode('the second reading'));
		});

		store.failNextWrite('rename');
		expect(await history.undo()).toBe(false);
		expect(history.undoable?.label).toBe('Undo edit');
		expect(history.redoable).toBeNull();

		expect(await history.undo()).toBe(true);
		expect(await held(NOTES)).toBe('the first reading');
	});

	// SPEC story 51: a slow undo cannot run twice.
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
	// SPEC story 39: a disturbed history simply leaves, in both directions at once.
	it('empties both directions and publishes', async () => {
		const { autosave, history } = seam();
		await history.step('Undo edit one', [NOTES], async () => {
			autosave.queue(NOTES, encode('one'));
		});
		await history.step('Undo edit two', [NOTES], async () => {
			autosave.queue(NOTES, encode('two'));
		});
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
	// The app depends on the immediate call: a control mounted against a history that already holds
	// Steps has to be told about them without waiting for the next one.
	it('calls its listener once immediately, on every change, and stops when unsubscribed', async () => {
		const { autosave, history } = seam();
		const seen: (string | null)[] = [];
		const stop = history.subscribe((state) => seen.push(state.undoable?.label ?? null));

		expect(seen).toEqual([null]);

		await history.step('Undo edit', [NOTES], async () => {
			autosave.queue(NOTES, encode('one'));
		});
		expect(seen).toEqual([null, 'Undo edit']);

		await history.undo();
		expect(seen).toEqual([null, 'Undo edit', null]);

		stop();
		await history.redo();
		expect(seen).toEqual([null, 'Undo edit', null]);
	});
});

describe('a Step over several files', () => {
	it('puts every one of them back, and answers false if any write fails', async () => {
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

		expect(await history.undo()).toBe(true);
		expect(await held(NOTES)).toBe('notes before');
		expect(await held(ROUTES)).toBe('routes before');
	});
});
