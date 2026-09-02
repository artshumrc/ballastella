// The notice both map panes render, asserted against the component rather than against either app.
//
// The presentation used to be written twice — the alert boxes in `apps/editor`'s `ProjectScreen` and
// again in the viewer's `+page.svelte`, each with its own `role="alert"` versus `aria-live` decision
// — and the two had already drifted: the viewer's own comment recorded that `base-map-notice` and
// `base-map-not-in-site` were `aria-live` regions inside `{#if}` blocks, which is a notice a
// screen-reader user never hears. The rule is one component's now, so it is one test.
//
// ⚠ **What stays in `e2e/`.** Which notice is up when, and what each one says: the sentences are
// core's (`baseMapUnavailableNotice`, `mapImageTilesUnavailableNotice` and the rest, each with
// its own unit tests), and the conditions that raise them are asserted against real archives and a
// real MapLibre in `editor-base-map.e2e.ts`, `editor-pwa.e2e.ts` and `viewer-reader.e2e.ts`. Those
// specs also carry the mechanism through to the built apps, on the elements they already address.

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

/** The component offering **exactly** what it is handed here, and nothing else. */
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

/** The same component under a parent that can change its text without remounting it. */
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
	/**
	 * A notice that comes and goes is an `alert`, and there is no live region to miss it.
	 *
	 * An `aria-live` region is announced when its text **changes**, not when the element carrying it
	 * is inserted — so a live region inside an `{#if}` is a notice a screen-reader user never hears.
	 * This is the recorded amendment to ADR-0016's `aria-live="polite"` mandate for status, and the
	 * reason it is the component's decision rather than each call site's is that it had already been
	 * got wrong twice in the same file.
	 */
	test('is inserted with its text already in it, as an alert, or is not there at all', () => {
		const held = changeable({
			shape: 'comes-and-goes',
			heading: 'The Base Map did not load',
			testid: 'base-map-unavailable'
		});

		// Nothing to say, so nothing on the screen: an alert that is always up is one nobody reads.
		expect(one('base-map-unavailable')).not.toBeInTheDocument();

		held.say(UNAVAILABLE);
		flushSync();

		const element = one('base-map-unavailable');
		expect(element).toBeInTheDocument();
		expect(element).toHaveAttribute('role', 'alert');
		// Not both, and not a status: the save indicator owns `status` for the whole editor, and a
		// second makes `getByRole('status')` ambiguous — which a screen-reader user would have to
		// disambiguate too.
		expect(element).not.toHaveAttribute('aria-live');
		expect(text(element)).toBe(`The Base Map did not load ${UNAVAILABLE}`);
	});

	/**
	 * A notice that is always there is a live region, and the element survives its text arriving.
	 *
	 * **The node identity is the assertion.** Two mounts would prove the text renders in both states
	 * and nothing about the mechanism; what makes a live region work is that the region was already
	 * on the page when the text changed. Put this notice back inside an `{#if}` and the element after
	 * the change is a different node, which is the defect the viewer's own comment reported shipping.
	 */
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
		// Read as a whole sentence rather than as the words that changed.
		expect(before).toHaveAttribute('aria-atomic', 'true');
		expect(before).not.toHaveAttribute('role');

		held.say('This site does not carry the Base Map’s labels and symbols.');
		flushSync();

		expect(one('base-map-not-in-site')).toBe(before);
		expect(text(before)).toBe('This site does not carry the Base Map’s labels and symbols.');
		expect(before).toHaveAttribute('aria-live', 'polite');
	});

	// The two mechanisms are one switch rather than two independent attributes, so neither shape can
	// be given both — the state in which a notice is announced twice, or announced not at all.
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
	/**
	 * ⚠ **This component composes no prose at all**, and that is the claim rather than a side effect.
	 *
	 * Three times a component moved into `packages/ui` carried a sentence that was only true in the
	 * editor, and every control-shaped sweep stayed green because prose is not a `role=button`. The
	 * sentences here are core's — `baseMapUnavailableNotice` and its siblings — and the headings are
	 * the calling screen's, so a notice handed one sentence must say exactly that sentence and
	 * nothing else in either app.
	 */
	test('says exactly what it was handed, and offers nothing to operate', () => {
		notice({ shape: 'comes-and-goes', text: UNAVAILABLE, testid: 'notice' });

		expect(text(one('notice'))).toBe(UNAVAILABLE);
		expect(
			one('notice')?.querySelectorAll('button, a[href], input, select, [role="button"]')
		).toHaveLength(0);
	});

	// A notice whose body is a list of failures, or a sentence with a host named in it, is the
	// consumer's markup — and a consumer that hands over none gets the plain sentence rather than an
	// empty box where somebody else's body would be.
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
