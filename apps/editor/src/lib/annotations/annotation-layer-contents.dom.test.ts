// What one Annotation Layer's contents render, asserted against the component rather than against
// the application.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS ASSERTED HERE, AND WHAT MOVED TO `packages/ui`
//
// The list and the rows are `@ballastella/ui`'s, and every claim about them went with them to
// `packages/ui/src/annotation-list.dom.test.ts` — how a row names an untitled Annotation, that a title
// which looks like markup is characters, `aria-expanded`, `aria-controls`, one row selected at a time,
// where the keyboard stays, the empty state and the caption. A shared component tested from the app it
// used to live in is tested through a consumer (ADR-0034), and the second consumer is then either
// untested or carrying a copy of the same claim.
//
// **The selected Annotation itself is no longer here at all** (ADR-0035). It is read in the Annotation
// Inspector over the map, whose two faces are `annotation-text-face.dom.test.ts`'s and
// `annotation-style-face.dom.test.ts`'s, and whose tab strip is
// `packages/ui/src/annotation-inspector.dom.test.ts`'s.
//
// **What is left is this app's own composition**: the drawing tools above the list, and the rule that
// the list of what is already in the Layer is there throughout — while the shapes are on offer and
// while one is being drawn. None of that is a published site's, and none of it belongs to the list.
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
	test('closes the Annotation that was open and leaves the list where it is', async () => {
		// **Two claims, and they pull in opposite directions.** Pressing "new" must close the panel
		// titled after the *previous* Annotation — it is not an edit to that one, and its panel would
		// otherwise sit under the tool about to draw a different one, in the place the new one's own
		// panel appears. What must *not* go with it is the list: "what is already in this Layer" is not
		// the thing to take away from somebody who is adding to it
		// (the-annotation-inspector stories 11, 36).
		const chose = vi.fn();
		contents({
			collection: collectionOf(annotation({ id: 'a-1', title: 'The west quay' })),
			selectedId: 'a-1',
			onselect: chose
		});
		expect(one('annotation-row')).toHaveAttribute('aria-expanded', 'true');

		await press(one('annotation-new')!);

		// Deselected, which is what takes the Inspector off the map: the panel is on screen because a row
		// is selected, and this component's half of that is reporting the gesture.
		expect(chose).toHaveBeenCalledWith(null);
		expect(one('annotation-row')).toHaveAttribute('aria-expanded', 'false');
		expect(one('annotation-tools')).toBeInTheDocument();
		expect(one('annotation-list')).toBeInTheDocument();
		// **And the caption with it**, which is the half that says what the list is: a Layer holding one
		// Annotation and a Layer nobody has counted have to stay distinguishable
		// (the-annotation-inspector story 13).
		expect(one('annotation-row')).toHaveTextContent('The west quay');
		expect(document.getElementById('annotation-list-caption')).toHaveTextContent('1 Annotation');
	});

	test('Done puts the shapes away, and the list was never the thing hidden', async () => {
		contents({ collection: collectionOf(annotation({ id: 'a-1', title: 'The west quay' })) });

		await press(one('annotation-new')!);
		expect(one('annotation-list')).toBeInTheDocument();

		await press(one('annotation-tool-cancel')!);

		// Back to resting: one button, and the list untouched throughout.
		expect(one('annotation-new')).toBeInTheDocument();
		expect(all('annotation-tools')).toHaveLength(0);
		expect(one('annotation-list')).toBeInTheDocument();
	});

	test('an armed shape leaves the list alone too', async () => {
		contents({ collection: collectionOf(annotation({ id: 'a-1', title: 'The west quay' })) });

		await press(one('annotation-new')!);
		await press(one('annotation-tool-point')!);

		expect(one('annotation-tool-point')).toHaveAttribute('aria-pressed', 'true');
		expect(one('annotation-list')).toBeInTheDocument();
	});
});

describe('the Annotation just drawn is in the list, because that is where it is', () => {
	// ⚠ **Nothing on this screen is a list of one.** The Annotation just drawn is an ordinary row in
	// the ordinary list, selected and with its editor open, so it is counted and captioned with the
	// rest — a Layer holding one Annotation and a Layer nobody has counted stay distinguishable even in
	// the instant after a shape lands. These assert the state the page is in mid-gesture, which is
	// where a second list would have to appear if one were going to.

	test('with a tool armed and an Annotation selected, its row is the selected one in the list', () => {
		contents({
			collection: collectionOf(
				annotation({ id: 'a-1', title: 'The west quay' }),
				annotation({ id: 'a-2', title: 'The east quay' })
			),
			selectedId: 'a-2',
			tool: 'point'
		});

		// The tools are still out, so this is the state the page is in mid-gesture rather than at rest.
		expect(one('annotation-tools')).toBeInTheDocument();
		expect(one('annotation-list')).toBeInTheDocument();
		// No list of one anywhere: what is on screen is the Layer's Annotations, counted and captioned.
		expect(all('annotation-row')).toHaveLength(2);
		expect(all('annotation-row')[1]).toHaveAttribute('aria-expanded', 'true');
		expect(all('annotation-row')[0]).toHaveAttribute('aria-expanded', 'false');
	});

	test('with a tool armed and nothing selected, no row is selected', () => {
		contents({
			collection: collectionOf(annotation({ id: 'a-1', title: 'The west quay' })),
			tool: 'point'
		});

		expect(one('annotation-tools')).toBeInTheDocument();
		expect(one('annotation-row')).toHaveAttribute('aria-expanded', 'false');
	});

	// **"A freshly drawn Annotation opens with its title as a field" is no longer here.** Nothing about
	// the words is in this column any more, so the claim is
	// `annotation-text-face.dom.test.ts`'s test of the same name — handed `titling` directly, which is
	// the prop the state layer sets from `titlingId`.
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
