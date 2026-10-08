import { createRawSnippet, flushSync, mount, type Snippet, unmount } from 'svelte';
import { afterEach, describe, expect, test } from 'vitest';

import MapNotice from './MapNotice.svelte';
import MapNoticeHarness from './MapNoticeHarness.svelte';

let mounted: Record<string, unknown> | undefined;

const takeDown = (): void => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
};

afterEach(takeDown);

const notice = (props: {
	shape: 'comes-and-goes' | 'always-present';
	text?: string | null;
	heading?: string;
	variant?: 'warning' | 'info' | 'plain';
	testid?: string;
	class?: string;
	children?: Snippet;
}): void => {
	mounted = mount(MapNotice, { target: document.body, props });
	flushSync();
};

const changeable = (props: {
	shape: 'comes-and-goes' | 'always-present';
	text?: string;
	heading?: string;
	variant?: 'warning' | 'info' | 'plain';
	testid: string;
}): { say: (words: string) => void } => {
	mounted = mount(MapNoticeHarness, { target: document.body, props });
	flushSync();
	return mounted as unknown as { say: (words: string) => void };
};

const marker = <Args extends unknown[]>(testId: string): Snippet<Args> =>
	createRawSnippet<Args>(() => ({
		render: () => `<p data-testid="${testId}">could not be reached</p>`
	}));

const one = (testId: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

const text = (element: Element | null): string =>
	(element?.textContent ?? '').replace(/\s+/g, ' ').trim();

const UNAVAILABLE = 'The archive that holds this Base Map did not answer.';

describe('which mechanism a notice uses is this component’s rule', () => {
	/** An `aria-live` region is announced when its text **changes**, not when the element carrying it is inserted — so a live region inside an `{#if}` is a notice a screen-reader user never hears. */
	test('is inserted with its text already in it, as an alert, or is not there at all', () => {
		const held = changeable({
			shape: 'comes-and-goes',
			heading: 'The Base Map did not load',
			testid: 'base-map-unavailable'
		});

		expect(one('base-map-unavailable')).not.toBeInTheDocument();

		held.say(UNAVAILABLE);
		flushSync();
		const element = one('base-map-unavailable');
		expect(element).toBeInTheDocument();
		expect(element).toHaveAttribute('role', 'alert');
		expect(element).not.toHaveAttribute('aria-live');
		expect(text(element)).toBe(`The Base Map did not load ${UNAVAILABLE}`);
	});

	test('is present with an empty string and is the same element when its text arrives', () => {
		const held = changeable({
			shape: 'always-present',
			variant: 'plain',
			testid: 'base-map-not-in-site'
		});

		const before = one('base-map-not-in-site');
		expect(before).toBeInTheDocument();
		expect(text(before)).toBe('');
		expect(before).toHaveAttribute('aria-live', 'polite');
		expect(before).toHaveAttribute('aria-atomic', 'true');
		expect(before).not.toHaveAttribute('role');

		held.say('This site does not carry the Base Map’s labels and symbols.');
		flushSync();
		expect(one('base-map-not-in-site')).toBe(before);
		expect(text(before)).toBe('This site does not carry the Base Map’s labels and symbols.');
		expect(before).toHaveAttribute('aria-live', 'polite');
	});

	test('gives no notice both mechanisms, and none the status role', () => {
		for (const shape of ['comes-and-goes', 'always-present'] as const) {
			takeDown();
			notice({ shape, text: UNAVAILABLE, testid: 'notice' });
			const element = one('notice');
			expect(element).toBeInTheDocument();
			expect(element?.getAttribute('role')).not.toBe('status');
			expect(element?.hasAttribute('role') && element.hasAttribute('aria-live')).toBe(false);
			expect(element?.hasAttribute('role') || element?.hasAttribute('aria-live')).toBe(true);
		}
	});
});

describe('every sentence is the consumer’s', () => {
	/** The sentences here are core's — `baseMapUnavailableNotice` and its siblings — and the headings are the calling screen's, so a notice handed one sentence must say exactly that sentence and nothing… */
	test('says exactly what it was handed, and offers nothing to operate', () => {
		notice({ shape: 'comes-and-goes', text: UNAVAILABLE, testid: 'notice' });
		expect(text(one('notice'))).toBe(UNAVAILABLE);
		expect(
			one('notice')?.querySelectorAll('button, a[href], input, select, [role="button"]')
		).toHaveLength(0);
	});

	test('renders the body the consumer hands it, and the sentence when none is handed over', () => {
		notice({
			shape: 'comes-and-goes',
			heading: 'Some of this Project could not be reached',
			children: marker('layer-unreachable'),
			testid: 'notice'
		});

		expect(one('layer-unreachable')).toBeInTheDocument();
		expect(text(one('notice'))).toBe(
			'Some of this Project could not be reached could not be reached'
		);

		takeDown();
		notice({
			shape: 'comes-and-goes',
			heading: 'The Base Map did not load',
			text: UNAVAILABLE,
			testid: 'notice'
		});

		expect(one('layer-unreachable')).not.toBeInTheDocument();
		expect(text(one('notice')?.querySelector('p') ?? null)).toBe(UNAVAILABLE);
	});
});
