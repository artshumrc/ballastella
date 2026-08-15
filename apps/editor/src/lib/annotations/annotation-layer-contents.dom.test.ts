// What one Annotation Layer's contents render, asserted against the component rather than against
// the application.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS ASSERTED HERE, AND WHAT MOVED TO `packages/ui`
//
// The list, the row and the disclosure it opens are `@ballastella/ui`'s, and every claim about them
// went with them to `packages/ui/src/annotation-list.dom.test.ts` — how a row names an untitled
// Annotation, that a title which looks like markup is characters, `aria-expanded`, one row open at a
// time, where the keyboard stays, the reveal's duration, the empty state and the caption. A shared
// component tested from the app it used to live in is tested through a consumer (ADR-0034), and the
// second consumer is then either untested or carrying a copy of the same claim.
//
// **What is left is this app's own composition**: the drawing tools, and the rule that the list of
// what is already in the Layer stands aside while a shape is armed — except for the one Annotation
// that has just been drawn. None of that is a published site's, and none of it belongs to the list.
//
// ⚠ **What stays in `e2e/` is the wiring.** This component is handed `collection` and `selectedId`;
// it computes neither. So "a newly drawn Annotation is selected" is `ProjectScreen`'s and the
// drawing state's, "the selected row wears the Layer's own wash" is a computed-colour claim with no
// answer where there is no paint, and "the Annotation is still on the map when its Layer is closed"
// is MapLibre's. Each of those would be asserted here against the props this file passes in.

import { type Annotation, type AnnotationCollection } from '@ballastella/core';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import AnnotationLayerContentsHarness from './AnnotationLayerContentsHarness.svelte';

const annotation = (fields: {
	id: string;
	type?: 'Point' | 'LineString' | 'Polygon';
	title?: string;
}): Annotation =>
	({
		id: fields.id,
		geometry: { type: fields.type ?? 'Point', coordinates: [0, 0] },
		properties: fields.title === undefined ? {} : { title: fields.title }
	}) as Annotation;

const collectionOf = (...annotations: Annotation[]): AnnotationCollection => ({ annotations });

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

/** Mount the harness, remember it for {@link afterEach}, and let its effects run. */
const contents = (props: ComponentProps<typeof AnnotationLayerContentsHarness>): void => {
	mounted = mount(AnnotationLayerContentsHarness, { target: document.body, props });
	flushSync();
};

const all = (testId: string): HTMLElement[] => [
	...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)
];

const one = (testId: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/** Press a control and let Svelte finish, including the effect a selection change runs. */
const press = async (element: HTMLElement): Promise<void> => {
	element.focus();
	element.click();
	await tick();
	await tick();
};

describe('“New Annotation” clears the way for the one about to be drawn', () => {
	test('closes the Annotation that was open and puts the list away', async () => {
		// The defect: the editor is not part of the list, so it stayed on screen when the list stepped
		// aside for the shape buttons — a panel titled after the *previous* Annotation, sitting
		// directly under the tool about to draw a different one, in the place the new one's own panel
		// will appear.
		const chose = vi.fn();
		contents({
			collection: collectionOf(annotation({ id: 'a-1', title: 'The west quay' })),
			selectedId: 'a-1',
			onselect: chose
		});
		expect(one('annotation-editor')).toHaveTextContent('The west quay');

		await press(one('annotation-new')!);

		expect(chose).toHaveBeenCalledWith(null);
		expect(all('annotation-editor')).toHaveLength(0);
		// And the list is out of the way too: somebody who has just pressed "new" is asking what they
		// are about to draw, not what is already there.
		expect(all('annotation-list')).toHaveLength(0);
		expect(one('annotation-tools')).toBeInTheDocument();
	});

	test('Done puts the shapes away and brings the list back', async () => {
		contents({ collection: collectionOf(annotation({ id: 'a-1', title: 'The west quay' })) });

		await press(one('annotation-new')!);
		expect(all('annotation-list')).toHaveLength(0);

		await press(one('annotation-tool-cancel')!);

		// Back to resting: one button, and the Annotations legible again.
		expect(one('annotation-new')).toBeInTheDocument();
		expect(all('annotation-tools')).toHaveLength(0);
		expect(one('annotation-list')).toBeInTheDocument();
	});

	test('an armed shape keeps the list away without pressing “new” again', async () => {
		// Drawing three pins in a row is three clicks on the map rather than three trips through the
		// button, which is `choosing` being `picking || tool !== 'select'` rather than `picking` alone.
		contents({ collection: collectionOf(annotation({ id: 'a-1', title: 'The west quay' })) });

		await press(one('annotation-new')!);
		await press(one('annotation-tool-point')!);

		expect(one('annotation-tool-point')).toHaveAttribute('aria-pressed', 'true');
		expect(all('annotation-list')).toHaveLength(0);
	});
});

describe('the Annotation just drawn stays under the tools', () => {
	// ⚠ **The regression these two are the fence around.** Before the editor moved into the row it was
	// rendered outside this branch, so it survived the list stepping aside for the shape buttons.
	// Inside the row it went behind the same curtain — and drawing deliberately leaves the tool in
	// hand, so titling a shape then began with pressing "Done", which is the opposite of what drawing
	// something is for. Armed *and* selected is the state the page is in the instant a shape lands.
	//
	// Asserted as a pair on purpose. "The row is there when something is selected" alone would pass a
	// component that showed a row whatever happened; "no row when nothing is" alone would pass one
	// that had gone back to hiding everything.

	test('with a tool armed and an Annotation selected, that row and its editor are on screen', () => {
		contents({
			collection: collectionOf(
				annotation({ id: 'a-1', title: 'The west quay' }),
				annotation({ id: 'a-2', title: 'The east quay' })
			),
			selectedId: 'a-2',
			tool: 'point'
		});

		// The tools are still out, so this is not merely the resting list under another name.
		expect(one('annotation-tools')).toBeInTheDocument();
		expect(all('annotation-list')).toHaveLength(0);

		// One row, and it is the selected one rather than the first thing in the collection.
		expect(all('annotation-row')).toHaveLength(1);
		expect(one('annotation-row')).toHaveAttribute('data-annotation-id', 'a-2');
		expect(one('annotation-row')).toHaveAttribute('aria-expanded', 'true');
		expect(one('annotation-editor')).toHaveAttribute('data-annotation-id', 'a-2');
	});

	test('with a tool armed and nothing selected, no row is', () => {
		contents({
			collection: collectionOf(annotation({ id: 'a-1', title: 'The west quay' })),
			tool: 'point'
		});

		expect(one('annotation-tools')).toBeInTheDocument();
		expect(all('annotation-row')).toHaveLength(0);
		expect(all('annotation-editor')).toHaveLength(0);
	});
});

describe('a Layer with nothing in it yet', () => {
	test('tells a scholar how to fill it, in this app’s own words', () => {
		contents({ collection: collectionOf() });

		// **The positive control for an absence asserted in two other places.** `AnnotationList` supplies
		// only the bare fact — "This Layer has no Annotations in it." — and this app supplies the half
		// that is true only where there is something to draw with. A Reader gets the fact alone:
		// `packages/ui/src/annotation-list.dom.test.ts` asserts both directions against the component,
		// and `e2e/viewer-reader.e2e.ts` sweeps a Published Site for the word "yet" itself.
		expect(one('annotation-list-empty')).toHaveTextContent(
			'Nothing in this Layer yet. Press New Annotation and draw one on the map.'
		);
	});
});
