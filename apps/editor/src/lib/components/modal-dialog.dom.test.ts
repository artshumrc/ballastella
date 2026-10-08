import { afterEach, expect, test } from 'vitest';

import { at, inMain, press, show, takeDown } from '$lib/test-support/dom';

import ModalDialogHarness from './ModalDialogHarness.svelte';

afterEach(takeDown);

const open = (props: { open?: boolean; vanishing?: boolean } = {}): void =>
	show(ModalDialogHarness, props, inMain());

test('closing puts focus back on the control that opened it', () => {
	open();
	const opener = at('opener');
	opener.focus();

	press('opener');
	press('close');
	expect(document.activeElement).toBe(opener);
});

test('an opener that has gone hands focus to what the caller named', () => {
	open({ vanishing: true });
	at('opener').focus();
	press('opener');
	press('close');
	expect(document.activeElement).toBe(at('fallback'));
});

test('nothing focused when it opened is not a place to put focus back', () => {
	open({ open: true });
	press('close');
	expect(document.activeElement).toBe(at('fallback'));
	expect(document.activeElement).not.toBe(document.body);
});
