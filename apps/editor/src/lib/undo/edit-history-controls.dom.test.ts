import { EditHistory, type Bytes, type HistoryFiles, type StorePath } from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test } from 'vitest';

import { one, settle } from '$lib/test-support/dom';
import ToastStack from '$lib/toasts/ToastStack.svelte';
import { toasts } from '$lib/toasts/toasts.svelte.js';

import EditHistoryControls from './EditHistoryControls.svelte';

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
	for (const item of [...toasts.items]) toasts.withdraw(item.testid);
	flushSync();
	document.body.innerHTML = '';
});

const render = (): { history: EditHistory; files: Files } => {
	const files = new Files();
	const history = new EditHistory(files);
	mounted.push(mount(ToastStack, { target: document.body }));
	mounted.push(mount(EditHistoryControls, { target: document.body, props: { history } }));
	flushSync();
	return { history, files };
};

const LABEL = 'Undo delete of the Layer “Rhineland 1580”';

const renderWithStep = async () => {
	const rendered = render();
	await rendered.history.step(LABEL, [PATH], async () => {
		rendered.files.held.set(PATH, bytesOf('gone'));
	});
	flushSync();
	return rendered;
};

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

test('draws nothing at all for a history with no Steps in it', () => {
	render();
	expect(one('edit-history-undo')).toBeNull();
	expect(one('edit-history-redo')).toBeNull();
});

test('says what it will reverse, and offers no redo until something has been undone', async () => {
	await renderWithStep();

	expect(one('edit-history-undo')?.textContent?.trim()).toBe(LABEL);
	expect(one('edit-history-redo')).toBeNull();
});

test('after an undo, shows redo as a word named by the same sentence, and says what was undone', async () => {
	await renderWithStep();

	one('edit-history-undo')?.click();
	await settle();

	const redo = one('edit-history-redo');
	expect(redo?.textContent?.trim()).toBe('Redo');
	expect(redo).toHaveAccessibleName('Redo delete of the Layer “Rhineland 1580”');
	expect(redo?.getAttribute('title')).toBe('Redo delete of the Layer “Rhineland 1580”');
	expect(one('edit-history-undo')).toBeNull();
	expect(one('edit-history-outcome')?.textContent).toContain(
		'Undone: delete of the Layer “Rhineland 1580”.'
	);
});

test('leaves both controls where they are when the write does not land', async () => {
	const { files } = await renderWithStep();
	files.refuseWrite = true;

	one('edit-history-undo')?.click();
	await settle();

	expect(one('edit-history-undo')).not.toBeNull();
	expect(one('edit-history-redo')).toBeNull();
	expect(one('edit-history-outcome')).toBeNull();
});

test('undoes on Ctrl+Z and redoes on both Ctrl+Shift+Z and Ctrl+Y', async () => {
	await renderWithStep();

	press('z');
	await settle();
	expect(one('edit-history-undo')).toBeNull();
	press('z', { shift: true });
	await settle();
	expect(one('edit-history-undo')).not.toBeNull();
	press('z');
	await settle();
	press('y');
	await settle();
	expect(one('edit-history-undo')).not.toBeNull();
	expect(one('edit-history-redo')).toBeNull();
});

test('leaves a text field its own Ctrl+Z', async () => {
	await renderWithStep();
	const field = document.createElement('input');
	field.type = 'text';
	document.body.append(field);

	press('z', {}, field);
	await settle();

	expect(one('edit-history-undo')).not.toBeNull();
});
