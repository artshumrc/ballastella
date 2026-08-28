// The two controls of an Edit History: what the bar draws, what it says, and what the keyboard
// reaches (ADR-0039).
//
// A real `EditHistory` over an in-memory `HistoryFiles`, because the class is the subject's other
// half: "absent at each end" is a claim about the cursor as much as about the markup, and a stubbed
// `undoable` would be the component agreeing with a fixture. What the history *does* to a store is
// `packages/core`'s and `editor-session.test.ts`'s; what it does to a Project's files on disk is
// `e2e/`'s.

import { EditHistory, type Bytes, type HistoryFiles, type StorePath } from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test } from 'vitest';

import ToastStack from '$lib/toasts/ToastStack.svelte';
import { toasts } from '$lib/toasts/toasts.svelte.js';

import EditHistoryControls from './EditHistoryControls.svelte';

/** The files a history reads and writes, with a switch for the write that will not land. */
class Files implements HistoryFiles {
	readonly held = new Map<StorePath, Bytes>();
	refuseWrite = false;

	async flush(): Promise<void> {}

	async read(path: StorePath): Promise<Bytes | null> {
		return this.held.get(path) ?? null;
	}

	async writeBack(path: StorePath, bytes: Bytes | null): Promise<void> {
		if (this.refuseWrite) throw new Error('the Workspace refused the write');
		if (bytes === null) this.held.delete(path);
		else this.held.set(path, bytes);
	}
}

const PATH = 'amsterdam-1625/notes.txt';

const bytesOf = (text: string): Bytes => new TextEncoder().encode(text);

let mounted: ReturnType<typeof mount>[] = [];

afterEach(() => {
	for (const component of mounted.reverse()) unmount(component);
	mounted = [];
	// The stack is the app's and outlives any one test, so anything still standing has to go.
	for (const item of [...toasts.items]) toasts.withdraw(item.testid);
	flushSync();
	document.body.innerHTML = '';
});

/** A history with the controls and the toast stack rendered over it. */
const render = (): { history: EditHistory; files: Files } => {
	const files = new Files();
	const history = new EditHistory(files);
	mounted.push(mount(ToastStack, { target: document.body }));
	mounted.push(mount(EditHistoryControls, { target: document.body, props: { history } }));
	flushSync();
	return { history, files };
};

/** One completed gesture over `PATH`, so the history has something at each end to offer. */
const gesture = async (history: EditHistory, files: Files, label: string, wrote: string) => {
	await history.step(label, [PATH], async () => {
		files.held.set(PATH, bytesOf(wrote));
	});
	flushSync();
};

const at = (testid: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);

const press = (key: string, modifiers: { shift?: boolean } = {}, target: EventTarget = window) => {
	target.dispatchEvent(
		new KeyboardEvent('keydown', {
			key,
			ctrlKey: true,
			shiftKey: modifiers.shift ?? false,
			bubbles: true,
			cancelable: true
		})
	);
};

/** Let the undo's own writes settle, since the handlers do not await. */
const settled = async (): Promise<void> => {
	// A handful of microtask turns: the write, the history's own publish, and this component's
	// continuation after it are each one, and counting them exactly would be a test of the internals.
	for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
	// Twice: the first flush runs `Toast`'s effect, which posts to the store the stack renders from.
	flushSync();
	flushSync();
};

// Absent rather than greyed out, so what is on the bar is what can actually be done.
test('draws nothing at all for a history with no Steps in it', () => {
	render();

	expect(at('edit-history-undo')).toBeNull();
	expect(at('edit-history-redo')).toBeNull();
});

// The sentence answers "have I just lost the thing I think I have lost?" before the control is
// pressed, which a bare "Undo" cannot.
test('says what it will reverse, and offers no redo until something has been undone', async () => {
	const { history, files } = render();

	await gesture(history, files, 'Undo delete of the Layer “Rhineland 1580”', 'gone');

	expect(at('edit-history-undo')?.textContent?.trim()).toBe(
		'Undo delete of the Layer “Rhineland 1580”'
	);
	expect(at('edit-history-redo')).toBeNull();
});

// Compact for a scholar reading the bar, and named in full for one who cannot see it.
test('shows redo as a word, named by the same sentence with one word swapped', async () => {
	const { history, files } = render();
	await gesture(history, files, 'Undo delete of the Layer “Rhineland 1580”', 'gone');

	at('edit-history-undo')?.click();
	await settled();

	const redo = at('edit-history-redo');
	expect(redo?.textContent?.trim()).toBe('Redo');
	expect(redo).toHaveAccessibleName('Redo delete of the Layer “Rhineland 1580”');
	expect(redo?.getAttribute('title')).toBe('Redo delete of the Layer “Rhineland 1580”');
	// And the other end is empty now, so its control is gone rather than sitting there greyed out.
	expect(at('edit-history-undo')).toBeNull();
});

// The control disappears when it is pressed, so the confirmation is the only thing left that says
// what happened — and it is in the stack's own live region.
test('says in words what was undone, in the toast stack', async () => {
	const { history, files } = render();
	await gesture(history, files, 'Undo delete of the Layer “Rhineland 1580”', 'gone');

	at('edit-history-undo')?.click();
	await settled();

	expect(at('edit-history-outcome')?.textContent).toContain(
		'Undone: delete of the Layer “Rhineland 1580”.'
	);
});

// A failed write keeps its place in the history: the control is still there to press again, and
// nothing claims the undo happened.
test('leaves both controls where they are when the write does not land', async () => {
	const { history, files } = render();
	await gesture(history, files, 'Undo delete of the Layer “Rhineland 1580”', 'gone');
	files.refuseWrite = true;

	at('edit-history-undo')?.click();
	await settled();

	expect(at('edit-history-undo')).not.toBeNull();
	expect(at('edit-history-redo')).toBeNull();
	expect(at('edit-history-outcome')).toBeNull();
});

// The shortcuts a scholar's other software taught them.
test('undoes on Ctrl+Z and redoes on both Ctrl+Shift+Z and Ctrl+Y', async () => {
	const { history, files } = render();
	await gesture(history, files, 'Undo delete of the Layer “Rhineland 1580”', 'gone');

	press('z');
	await settled();
	expect(at('edit-history-undo')).toBeNull();

	press('z', { shift: true });
	await settled();
	expect(at('edit-history-undo')).not.toBeNull();

	press('z');
	await settled();
	press('y');
	await settled();
	expect(at('edit-history-undo')).not.toBeNull();
	expect(at('edit-history-redo')).toBeNull();
});

// Typed text is not a Step and is never reverted by one, so a field keeps the only undo it has.
test('leaves a text field its own Ctrl+Z', async () => {
	const { history, files } = render();
	await gesture(history, files, 'Undo delete of the Layer “Rhineland 1580”', 'gone');
	const field = document.createElement('input');
	field.type = 'text';
	document.body.append(field);

	press('z', {}, field);
	await settled();

	expect(at('edit-history-undo')).not.toBeNull();
});
