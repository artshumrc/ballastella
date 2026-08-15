// The map's running commentary, asserted against the component both apps render (SPEC stories 17,
// 22, 70).
//
// It is announced and not drawn: a sighted user reads what is on the map off the map, so on screen
// these lines were restatement eating the Base Map's vertical space. `sr-only` rather than deletion,
// because the announcements are the whole reason they were written — and the `data-` attributes are
// the only machine-checkable statement of what the map is showing, which is why the suites read them.
//
// ⚠ **What stays in `e2e/`.** That the numbers are true of a real MapLibre stack, and that the
// opening view really settled where the attribute says: `editor-layers.e2e.ts`,
// `editor-opening-view.e2e.ts` and `viewer-reader.e2e.ts` own all of it, on these same test ids.

import { openingViewSentence } from '@ballastella/core';
import { createRawSnippet, flushSync, mount, type Snippet, unmount } from 'svelte';
import { afterEach, describe, expect, test } from 'vitest';

import MapCommentary from './MapCommentary.svelte';

let mounted: Record<string, unknown> | undefined;

const takeDown = (): void => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
};

afterEach(takeDown);

/** A sentence as either app writes it, as the snippet that app hands over. */
const note = (words: string): Snippet =>
	createRawSnippet(() => ({ render: () => `<span>${words}</span>` }));

/** What the editor adds to the commentary and the viewer does not. */
const extra = (): Snippet =>
	createRawSnippet(() => ({
		render: () => `<p data-testid="offline-availability" data-offline="yes">Available offline.</p>`
	}));

const commentary = (props: {
	layerCount: number;
	drawnCount: number;
	emptyStackNote: Snippet;
	openingOutcome: 'pending' | 'content' | 'default';
	refitted?: boolean;
	children?: Snippet;
}): void => {
	mounted = mount(MapCommentary, { target: document.body, props });
	flushSync();
};

const one = (testId: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

const text = (element: Element | null): string =>
	(element?.textContent ?? '').replace(/\s+/g, ' ').trim();

const EDITOR_EMPTY = 'Nothing is on the map yet.';
const READER_EMPTY = 'This Project has nothing on the map.';

describe('what is on the map, in words (SPEC story 22)', () => {
	test('counts what is drawn over the Base Map, and carries the count as an attribute', () => {
		commentary({
			layerCount: 3,
			drawnCount: 2,
			emptyStackNote: note(EDITOR_EMPTY),
			openingOutcome: 'content'
		});

		expect(text(one('stack-status'))).toBe('2 of 3 Layers are drawn over the Base Map.');
		// The suites wait on this attribute rather than on the sentence, and it is the only
		// machine-checkable statement of what the map is showing.
		expect(one('stack-status')).toHaveAttribute('data-drawn', '2');
	});

	test('says “Layer is” of one Layer', () => {
		commentary({
			layerCount: 1,
			drawnCount: 1,
			emptyStackNote: note(READER_EMPTY),
			openingOutcome: 'content'
		});

		expect(text(one('stack-status'))).toBe('1 of 1 Layer is drawn over the Base Map.');
		expect(one('stack-status')).toHaveAttribute('data-drawn', '1');
	});

	/**
	 * ⚠ **Both halves, in one test.** An empty stack means two different things to the two users, and
	 * the wording is each app's own: the editor's invites adding something, and a Reader has nothing
	 * to add. So the component supplies neither sentence, and the way to show that is to mount it
	 * twice and see each consumer's words arrive and the other's stay away — an absence asserted
	 * alone passes the moment a test id is renamed.
	 */
	test('says the consumer’s own sentence about an empty stack and never its own', () => {
		commentary({
			layerCount: 0,
			drawnCount: 0,
			emptyStackNote: note(EDITOR_EMPTY),
			openingOutcome: 'default'
		});

		expect(text(one('stack-status'))).toBe(EDITOR_EMPTY);
		expect(one('stack-status')).toHaveAttribute('data-drawn', '0');

		takeDown();
		commentary({
			layerCount: 0,
			drawnCount: 0,
			emptyStackNote: note(READER_EMPTY),
			openingOutcome: 'default'
		});

		expect(text(one('stack-status'))).toBe(READER_EMPTY);
		expect(text(one('stack-status'))).not.toContain(EDITOR_EMPTY);
	});
});

describe('where the map is looking (SPEC story 22)', () => {
	// The sentence is core's — the editor and a Published Site answer one question the same way — so
	// it is asserted against `openingViewSentence` rather than re-spelled here.
	test('publishes core’s sentence and the outcome it came from', () => {
		commentary({
			layerCount: 1,
			drawnCount: 1,
			emptyStackNote: note(READER_EMPTY),
			openingOutcome: 'default'
		});

		expect(one('opening-view')).toHaveAttribute('data-opening-view', 'default');
		expect(text(one('opening-view'))).toBe(openingViewSentence('default', false));

		takeDown();
		commentary({
			layerCount: 1,
			drawnCount: 1,
			emptyStackNote: note(READER_EMPTY),
			openingOutcome: 'content',
			refitted: true
		});

		expect(one('opening-view')).toHaveAttribute('data-opening-view', 'content');
		expect(text(one('opening-view'))).toBe(openingViewSentence('content', true));
	});
});

describe('the commentary is announced by its text changing (SPEC story 17)', () => {
	// Always present, so a change is what is heard: an `aria-live` region is announced on a text
	// change rather than on insertion. `role="status"` is unavailable — the save indicator owns it —
	// and an `alert` would interrupt a Reader every time they hid a Layer.
	test('is a pair of polite, atomic live regions and no status', () => {
		commentary({
			layerCount: 2,
			drawnCount: 1,
			emptyStackNote: note(READER_EMPTY),
			openingOutcome: 'content'
		});

		for (const testId of ['stack-status', 'opening-view']) {
			expect(one(testId)).toHaveAttribute('aria-live', 'polite');
			expect(one(testId)).toHaveAttribute('aria-atomic', 'true');
			expect(one(testId)).not.toHaveAttribute('role');
		}
		// Announced, not drawn: these facts are on the map for anybody who can see it.
		expect(one('stack-status')?.closest('.sr-only')).toBeInTheDocument();
	});

	/**
	 * ⚠ **Both halves again.** What is offline, and what a copy finished doing, are the editor's own
	 * announcements: making an offline copy is one button away there and nowhere at all for a Reader.
	 * The viewer hands over no extra lines and therefore has none.
	 */
	test('carries the consumer’s own extra announcements, and none it was not handed', () => {
		commentary({
			layerCount: 2,
			drawnCount: 2,
			emptyStackNote: note(EDITOR_EMPTY),
			openingOutcome: 'content',
			children: extra()
		});

		expect(one('offline-availability')).toHaveAttribute('data-offline', 'yes');
		expect(one('offline-availability')?.closest('.sr-only')).toBeInTheDocument();

		takeDown();
		commentary({
			layerCount: 2,
			drawnCount: 2,
			emptyStackNote: note(READER_EMPTY),
			openingOutcome: 'content'
		});

		expect(one('offline-availability')).not.toBeInTheDocument();
		// And the two lines a Reader does get are still there, so the absence above is a subtraction
		// rather than a commentary that failed to render at all.
		expect(one('stack-status')).toBeInTheDocument();
		expect(one('opening-view')).toBeInTheDocument();
	});
});
