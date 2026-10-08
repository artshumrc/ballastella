import { openingViewSentence } from '@ballastella/core';
import { createRawSnippet, type Snippet } from 'svelte';
import { afterEach, describe, expect, test } from 'vitest';

import { one, show, takeDown, textOf as text } from '../vitest-setup/dom.js';
import MapCommentary from './MapCommentary.svelte';

afterEach(takeDown);

const note = (words: string): Snippet =>
	createRawSnippet(() => ({ render: () => `<span>${words}</span>` }));

const extra = (): Snippet =>
	createRawSnippet(() => ({
		render: () => `<p data-testid="offline-availability" data-offline="yes">Available offline.</p>`
	}));

const EDITOR_EMPTY = 'Nothing is on the map yet.';
const READER_EMPTY = 'This Project has nothing on the map.';

const commentary = ({
	layerCount,
	drawnCount = layerCount,
	emptyStackNote = note(READER_EMPTY),
	openingOutcome = 'content',
	...rest
}: {
	layerCount: number;
	drawnCount?: number;
	emptyStackNote?: Snippet;
	openingOutcome?: 'pending' | 'content' | 'default';
	refitted?: boolean;
	children?: Snippet;
}): void => {
	const outcomes = Object.fromEntries(
		Array.from({ length: drawnCount }, (_, index) => [
			`layer-${index}`,
			{ status: 'drawn' as const }
		])
	);
	show(MapCommentary, { layerCount, emptyStackNote, openingOutcome, outcomes, ...rest });
};

describe('what is on the map, in words', () => {
	test.each([
		[3, 2, '2 of 3 Layers are drawn over the Base Map.'],
		[1, 1, '1 of 1 Layer is drawn over the Base Map.']
	])(
		'counts %i Layers, %i drawn, and carries the count as an attribute',
		(layerCount, drawnCount, said) => {
			commentary({ layerCount, drawnCount });
			expect(text(one('stack-status'))).toBe(said);
			expect(one('stack-status')).toHaveAttribute('data-drawn', String(drawnCount));
		}
	);

	test('says the consumer’s own sentence about an empty stack and never its own', () => {
		commentary({ layerCount: 0, emptyStackNote: note(EDITOR_EMPTY), openingOutcome: 'default' });

		expect(text(one('stack-status'))).toBe(EDITOR_EMPTY);
		expect(one('stack-status')).toHaveAttribute('data-drawn', '0');
		takeDown();
		commentary({ layerCount: 0, openingOutcome: 'default' });

		expect(text(one('stack-status'))).toBe(READER_EMPTY);
		expect(text(one('stack-status'))).not.toContain(EDITOR_EMPTY);
	});
});

describe('where the map is looking', () => {
	test('renders core’s sentence and the outcome it came from', () => {
		commentary({ layerCount: 1, openingOutcome: 'default' });

		expect(one('opening-view')).toHaveAttribute('data-opening-view', 'default');
		expect(text(one('opening-view'))).toBe(openingViewSentence('default', false));
		takeDown();
		commentary({ layerCount: 1, refitted: true });

		expect(one('opening-view')).toHaveAttribute('data-opening-view', 'content');
		expect(text(one('opening-view'))).toBe(openingViewSentence('content', true));
	});
});

describe('the commentary is announced by its text changing', () => {
	// Always present, so a change is what is heard: an `aria-live` region is announced on a text change rather than on insertion.
	test('is a pair of polite, atomic live regions and no status', () => {
		commentary({ layerCount: 2, drawnCount: 1 });

		for (const testId of ['stack-status', 'opening-view']) {
			expect(one(testId)).toHaveAttribute('aria-live', 'polite');
			expect(one(testId)).toHaveAttribute('aria-atomic', 'true');
			expect(one(testId)).not.toHaveAttribute('role');
		}
		expect(one('stack-status')?.closest('.sr-only')).toBeInTheDocument();
	});

	/** ⚠ **Both halves again.** What is offline, and what a copy finished doing, are the editor's own announcements: making an offline copy is one button away there and nowhere at all for a Reader. */
	test('carries the consumer’s own extra announcements, and none it was not handed', () => {
		commentary({ layerCount: 2, emptyStackNote: note(EDITOR_EMPTY), children: extra() });

		expect(one('offline-availability')).toHaveAttribute('data-offline', 'yes');
		expect(one('offline-availability')?.closest('.sr-only')).toBeInTheDocument();
		takeDown();
		commentary({ layerCount: 2 });

		expect(one('offline-availability')).not.toBeInTheDocument();
		expect(one('stack-status')).toBeInTheDocument();
		expect(one('opening-view')).toBeInTheDocument();
	});
});
