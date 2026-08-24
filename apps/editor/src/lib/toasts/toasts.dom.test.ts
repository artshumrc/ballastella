// The dismissible messages, and the one thing about them that is not presentation.
//
// ⚠ **The subject is the stack, not any one sentence.** What each message *says* is the business of
// the component that states it, and where each of them used to sit is asserted where it sits now
// (`editor-publish.e2e.ts`, `editor-github-signin.e2e.ts`, `editor-remote-conflict.e2e.ts` all find
// their message by the name its line carried before it became a toast). What only this seam can say
// cheaply is that a source states its current message and gets exactly one standing toast for it,
// that the reader can put it away, that a source leaving the screen takes its message with it — and
// that two sources posting in one flush do not bring the screen down, which is the defect this
// store's `untrack` exists for and which no wording assertion would ever show.

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test } from 'vitest';

import Toast from './Toast.svelte';
import ToastStack from './ToastStack.svelte';
import { toasts, type ToastTone } from './toasts.svelte.js';

let mounted: ReturnType<typeof mount>[] = [];
let host: HTMLElement | undefined;

/** The stack is the app's, so the store outlives any one test: every source has to be taken down. */
afterEach(() => {
	for (const component of mounted.reverse()) unmount(component);
	mounted = [];
	// Anything posted through the store directly has no source to unmount it.
	for (const item of [...toasts.items]) toasts.withdraw(item.testid);
	host?.remove();
	host = undefined;
	flushSync();
});

const render = (): HTMLElement => {
	host = document.createElement('div');
	document.body.append(host);
	const stack = mount(ToastStack, { target: host });
	mounted.push(stack);
	return host;
};

const post = (props: {
	text: string;
	testid: string;
	tone?: ToastTone;
	refusal?: boolean;
}): void => {
	mounted.push(mount(Toast, { target: host as HTMLElement, props }));
	flushSync();
};

test('draws a source’s message in the stack, under the name its line carried', () => {
	const page = render();
	post({ text: 'Published: 53 files written into your Workspace.', testid: 'publish-status' });

	const message = page.querySelector('[data-testid="publish-status"]');
	expect(message).not.toBeNull();
	expect(message?.textContent).toContain('53 files');
	// A status is announced by the region it is inserted into, which is mounted before it has
	// anything to say (ADR-0016). A refusal announces itself — see the test below.
	expect(page.querySelector('.toast')?.getAttribute('aria-live')).toBe('polite');
	expect(message?.getAttribute('role')).toBeNull();
	expect(message?.getAttribute('aria-live')).toBe('polite');
});

test('announces a refusal on insertion rather than politely', () => {
	// ADR-0016's amendment: a polite region announces a change of text inside a region that is
	// already there, and a refusal arrives with its words already in it.
	const page = render();
	post({ text: 'That folder could not be written to.', testid: 'save-error', refusal: true });

	const refusal = page.querySelector('[data-testid="save-error"]');
	expect(refusal?.getAttribute('role')).toBe('alert');
	expect(refusal?.getAttribute('aria-live')).toBeNull();
});

test('gives the reader a way to put it away', () => {
	const page = render();
	post({ text: 'Signed in to GitHub as ada.', testid: 'sign-in-outcome' });

	const dismiss = page.querySelector<HTMLButtonElement>('[data-testid="sign-in-outcome"] button');
	expect(dismiss?.textContent?.trim()).toBe('Dismiss');
	dismiss?.click();
	flushSync();

	expect(page.querySelector('[data-testid="sign-in-outcome"]')).toBeNull();
});

test('keeps one standing message per source, however often the source restates it', () => {
	// The bar restates what it has to say on every render, so a store that appended would stack four
	// copies of one sentence — and the reader would have to dismiss each of them. Driven through the
	// store rather than through a changing prop, because the claim is the store's: `Toast` states
	// whatever its text currently is, and this is what happens to a source that says something new.
	const page = render();
	toasts.post({ text: 'Checking…', testid: 'update-outcome', tone: 'info', refusal: false });
	flushSync();
	const first = toasts.items[0]?.id;

	toasts.post({
		text: 'Brought 3 files in.',
		testid: 'update-outcome',
		tone: 'info',
		refusal: false
	});
	flushSync();

	expect(page.querySelectorAll('[data-testid="update-outcome"]')).toHaveLength(1);
	expect(page.querySelector('[data-testid="update-outcome"]')?.textContent).toContain('Brought');
	// A new id, because the stack keys on it: new words are re-inserted and therefore re-announced.
	expect(toasts.items[0]?.id).not.toBe(first);
});

test('withdraws a message when its source has nothing left to say', () => {
	const page = render();
	const failure = {
		testid: 'remote-status-failure',
		tone: 'warning' as const,
		refusal: true
	};
	toasts.post({ ...failure, text: 'The Remote could not be reached.' });
	flushSync();
	expect(page.querySelector('[data-testid="remote-status-failure"]')).not.toBeNull();

	toasts.post({ ...failure, text: '' });
	flushSync();

	expect(page.querySelector('[data-testid="remote-status-failure"]')).toBeNull();
});

test('withdraws a message when the screen that stated it goes away', () => {
	// A publish result belongs to the Workspace it was about: left standing under the bar of the next
	// one it is a statement about that Workspace, and it is false.
	const page = render();
	const source = mount(Toast, {
		target: host as HTMLElement,
		props: { text: 'Published: 53 files.', testid: 'publish-status' }
	});
	flushSync();
	expect(page.querySelector('[data-testid="publish-status"]')).not.toBeNull();

	unmount(source);
	flushSync();

	expect(page.querySelector('[data-testid="publish-status"]')).toBeNull();
});

test('carries several sources at once without the screen coming down', () => {
	// ⚠ **The regression.** Deciding whether a message is news means reading what is standing, and a
	// tracked read there makes an effect that reads and writes the same state: Svelte answers
	// `effect_update_depth_exceeded`, and because these sources are mounted by the navigation bar the
	// whole editor stops — which is what happened, and what no assertion about wording would show.
	const page = render();
	post({ text: 'Saved nothing: the disk is full.', testid: 'save-error', refusal: true });
	post({
		text: 'The Remote could not be reached.',
		testid: 'remote-status-failure',
		refusal: true
	});
	post({ text: 'Published: 53 files.', testid: 'publish-status' });

	expect(page.querySelectorAll('.toast > *')).toHaveLength(3);
});
