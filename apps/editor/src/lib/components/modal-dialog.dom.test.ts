// Where a dialog puts focus back, at Seam 1c.
//
// ⚠ **Asserted on `ModalDialog` rather than once per surface, because that is where the behaviour
// is.** ADR-0016 mandates `<dialog>` + `showModal()`/`close()` and this component is the one
// implementation of it in the application, so every dialog this Epic added or moved — the door, the
// Update's deletion question, the roster's delete confirmation, Publish — restores focus by this
// code and by no other. A copy of this assertion per surface would be four readings of one fact.
//
// ⚠ **What is deliberately not here.** That Escape and the backdrop reach the same restoration is a
// native `<dialog>` behaviour, and happy-dom is not the browser that implements it — `e2e/`'s
// `editor-workspace` and `editor-remote-conflict` specs assert those against a real one. What this
// file can see is the restoration the component performs itself, which is the part that has a
// decision in it.

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test } from 'vitest';

import ModalDialogHarness from './ModalDialogHarness.svelte';

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted, { outro: false });
	mounted = undefined;
	document.body.innerHTML = '';
});

function open(props: { open?: boolean; vanishing?: boolean } = {}): void {
	const main = document.createElement('main');
	document.body.append(main);
	mounted = mount(ModalDialogHarness, { target: main, props });
	flushSync();
}

const at = (testId: string): HTMLElement => {
	const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
	if (!found) throw new Error(`nothing is rendered with data-testid="${testId}"`);
	return found;
};

const press = (testId: string): void => {
	at(testId).click();
	flushSync();
};

test('closing puts focus back on the control that opened it', () => {
	open();
	const opener = at('opener');
	opener.focus();

	press('opener');
	press('close');

	expect(document.activeElement).toBe(opener);
});

// The case `restoreFocusTo` exists for: the press that opened the dialog is also the press that
// took the control away, so there is nothing left to go back to.
test('an opener that has gone hands focus to what the caller named', () => {
	open({ vanishing: true });
	at('opener').focus();

	press('opener');
	press('close');

	expect(document.activeElement).toBe(at('fallback'));
});

/**
 * ⚠ **`<body>` is not an opener, and treating it as one is how a keyboard user is dropped.**
 * `document.activeElement` answers `<body>` whenever nothing is focused — a dialog raised by
 * something other than a press, or opened after a click on empty space — and `<body>` is connected
 * and inside no closed dialog, so it passed as a usable trigger. `focus()` on it does nothing, the
 * fallback the caller supplied was never consulted, and focus was left exactly where this
 * restoration exists to stop it being.
 */
test('nothing focused when it opened is not a place to put focus back', () => {
	open({ open: true });

	press('close');

	expect(document.activeElement).toBe(at('fallback'));
	expect(document.activeElement).not.toBe(document.body);
});
