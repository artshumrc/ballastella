import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test } from 'vitest';

import { all, one } from '$lib/test-support/dom';

import Toast from './Toast.svelte';
import ToastStack from './ToastStack.svelte';
import { toasts, type ToastTone } from './toasts.svelte.js';

let mounted: ReturnType<typeof mount>[] = [];
let host: HTMLElement | undefined;

afterEach(() => {
	for (const component of mounted.reverse()) unmount(component);
	mounted = [];
	for (const item of [...toasts.items]) toasts.withdraw(item.testid);
	host?.remove();
	host = undefined;
	flushSync();
});

const render = (): void => {
	host = document.createElement('div');
	document.body.append(host);
	mounted.push(mount(ToastStack, { target: host }));
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
	render();
	post({ text: 'Sent: 53 files written into your Workspace.', testid: 'sync-status' });
	const message = one('sync-status');
	expect(message).not.toBeNull();
	expect(message?.textContent).toContain('53 files');
	expect(document.querySelector('.toast')?.getAttribute('aria-live')).toBe('polite');
	expect(message?.getAttribute('role')).toBeNull();
	expect(message?.getAttribute('aria-live')).toBe('polite');
});

test('announces a refusal on insertion rather than politely', () => {
	render();
	post({ text: 'That folder could not be written to.', testid: 'save-error', refusal: true });
	const refusal = one('save-error');
	expect(refusal?.getAttribute('role')).toBe('alert');
	expect(refusal?.getAttribute('aria-live')).toBeNull();
});

test('gives the reader a way to put it away', () => {
	render();
	post({ text: 'Signed in to GitHub as ada.', testid: 'sign-in-outcome' });

	const dismiss = document.querySelector<HTMLButtonElement>(
		'[data-testid="sign-in-outcome"] button'
	);
	expect(dismiss?.textContent?.trim()).toBe('Dismiss');
	dismiss?.click();
	flushSync();
	expect(one('sign-in-outcome')).toBeNull();
});

test('keeps one standing message per source, however often the source restates it', () => {
	render();
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
	expect(all('update-outcome')).toHaveLength(1);
	expect(one('update-outcome')?.textContent).toContain('Brought');
	expect(toasts.items[0]?.id).not.toBe(first);
});

test('withdraws a message when its source has nothing left to say', () => {
	render();
	const failure = {
		testid: 'remote-status-failure',
		tone: 'warning' as const,
		refusal: true
	};
	toasts.post({ ...failure, text: 'The Remote could not be reached.' });
	flushSync();
	expect(one('remote-status-failure')).not.toBeNull();

	toasts.post({ ...failure, text: '' });
	flushSync();
	expect(one('remote-status-failure')).toBeNull();
});

test('withdraws a message when the screen that stated it goes away', () => {
	render();
	const source = mount(Toast, {
		target: host as HTMLElement,
		props: { text: 'Sent: 53 files.', testid: 'sync-status' }
	});
	flushSync();
	expect(one('sync-status')).not.toBeNull();
	unmount(source);
	flushSync();
	expect(one('sync-status')).toBeNull();
});

test('carries several sources at once without the screen coming down', () => {
	render();
	post({ text: 'Saved nothing: the disk is full.', testid: 'save-error', refusal: true });
	post({
		text: 'The Remote could not be reached.',
		testid: 'remote-status-failure',
		refusal: true
	});
	post({ text: 'Sent: 53 files.', testid: 'sync-status' });
	expect(document.querySelectorAll('.toast > *')).toHaveLength(3);
});
