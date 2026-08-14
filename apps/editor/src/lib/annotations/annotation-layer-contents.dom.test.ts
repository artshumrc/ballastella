// What one Annotation Layer's contents render, asserted against the component rather than against
// the application.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT MOVED HERE FROM `e2e/editor-annotations.e2e.ts`, AND WHAT DELIBERATELY DID NOT
//
// Each of these was an end-to-end test that seeded a Project, booted the editor, started a real
// MapLibre over software-rasterised WebGL and *drew a pin by clicking the canvas* — to find out
// whether a `<li>` said "Untitled pin 1", or whether pressing a button deselected something. The
// canvas was the machinery for arriving at a state, never the subject.
//
// ⚠ **What stays in `e2e/` is the wiring.** This component is handed `collection` and `selectedId`;
// it computes neither. So "a newly drawn Annotation is selected" is `ProjectScreen`'s and the
// drawing state's, "the selected row wears the Layer's own wash" is a computed-colour claim with no
// answer where there is no paint, and "the Annotation is still on the map when its Layer is closed"
// is MapLibre's. Each of those would be asserted here against the props this file passes in.
//
// **The row's name surface is asserted here and nowhere else, which is why this file starts with
// it.** Ticket 06 moved the Markdown payload matrix to `packages/core`, which was right — but the
// list row is not rendered through that pipeline at all. It is a Svelte interpolation, and that it
// stays one is the whole of its safety: it is one of the three places a stranger's `title` reaches
// the screen.

import { type Annotation, type AnnotationCollection } from '@ballastella/core';
import type { DetachedWindowAPI } from 'happy-dom';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import AnnotationLayerContentsHarness from './AnnotationLayerContentsHarness.svelte';

/**
 * What this DOM reports about the person using it — here, whether they have asked for less motion.
 *
 * happy-dom answers `prefers-reduced-motion` from these settings, so `prefersReducedMotion` out of
 * `svelte/motion` is reading a real media query against a real `matchMedia` rather than a stub of
 * Svelte's own signal. The settings are the window's, so {@link afterEach} puts them back.
 */
const device = (): DetachedWindowAPI['settings']['device'] =>
	(window as unknown as { happyDOM: DetachedWindowAPI }).happyDOM.settings.device;

/**
 * A title a stranger wrote, chosen so that a surface which parsed it would be caught twice over.
 *
 * The `<img>` fires nothing here — there is no network and no loader — so the assertion is on the
 * characters rather than on a side effect: rendered as markup, the tag is an element and the text
 * content loses it; rendered as text, every character survives.
 */
const PAYLOAD = '<img src=x onerror=alert(1)>The west quay';

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
	device().prefersReducedMotion = 'no-preference';
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

/**
 * The `at`th element carrying a `data-testid`, addressed by position and never held across a click.
 *
 * The `{#each}` over the Annotations is keyed, so an element kept in a `const` goes on answering
 * questions from wherever it used to be, without an error to say so.
 */
const nth = (testId: string, at: number): HTMLElement => {
	const found = all(testId)[at];
	if (!found) throw new Error(`no [data-testid="${testId}"] at position ${at}`);
	return found;
};

/** Press a control and let Svelte finish, including the effect a selection change runs. */
const press = async (element: HTMLElement): Promise<void> => {
	element.focus();
	element.click();
	await tick();
	await tick();
};

describe('an Annotation’s own words reach the row as text (SPEC story 67, ADR-0009)', () => {
	// ⚠ **This is the claim that had no home at all.** `AnnotationLayerContents` names the row as
	// "one of the three places a stranger's `title` or `description` reaches the screen", and says it
	// is safe for a different reason from the other two: Svelte interpolates it, so the DOM never
	// parses it as markup. The other two are asserted — the popup in `e2e/` and the Markdown pipeline
	// in `packages/core` — and this one was asserted nowhere once ticket 06 rehoused the payload
	// matrix. A change to `{@html describe(annotation, index)}` would have been silent.
	test('a title that looks like markup is characters, not elements', () => {
		contents({ collection: collectionOf(annotation({ id: 'a-1', title: PAYLOAD })) });

		const row = one('annotation-row-name')!;
		// Every character survives, including the angle brackets: nothing parsed it.
		expect(row).toHaveTextContent(PAYLOAD);
		// And the negative control, because a text assertion alone passes on a surface that rendered
		// the tag *and* left the words after it: no element was created from those characters.
		expect(row.querySelector('img')).toBeNull();
		expect(row.children).toHaveLength(0);
	});

	test('an Annotation with no title is named by its shape and its place in the list', () => {
		contents({
			collection: collectionOf(
				annotation({ id: 'a-1' }),
				annotation({ id: 'a-2', type: 'LineString' }),
				annotation({ id: 'a-3', type: 'Polygon' })
			)
		});

		// Numbered from 1 and by *position*, so the list reads as a list rather than as three things
		// all called "Untitled".
		expect(all('annotation-row-name').map((row) => row.textContent?.trim())) //
			.toEqual(['Untitled pin 1', 'Untitled line 2', 'Untitled shape 3']);
	});

	test('a title displaces the fallback rather than joining it', () => {
		contents({
			collection: collectionOf(
				annotation({ id: 'a-1', title: 'Fort Amsterdam' }),
				annotation({ id: 'a-2' })
			)
		});

		expect(all('annotation-row-name').map((row) => row.textContent?.trim())) //
			.toEqual(['Fort Amsterdam', 'Untitled pin 2']);
		// The shape word is beside the name rather than instead of it (SPEC story 111), so the glyph
		// is a second channel: a screen reader still hears which shape each row is.
		expect(nth('annotation-row', 0)).toHaveTextContent('pin');
	});

	test('an empty title falls back rather than rendering a blank row', () => {
		// A scholar who selects all and deletes leaves `title: ''` behind, which is a different state
		// from having no title at all and reads identically to a broken row if it is not handled.
		contents({ collection: collectionOf(annotation({ id: 'a-1', title: '' })) });

		expect(one('annotation-row-name')).toHaveTextContent('Untitled pin 1');
	});
});

describe('the row is a disclosure (one-shell-two-apps stories 24–31, 35, 36, 67)', () => {
	// **Selection and expansion are one state, so there is one property for them.** The row's
	// `aria-pressed` is gone: an Annotation that was pressed but not open, or open but not pressed,
	// were two answers to "which one is active" that could disagree, and now there is one. What is
	// asserted here is therefore `aria-expanded` — the wash the open row wears is a paint claim and
	// stays in `e2e/`.

	test('a row expands to reveal its own Annotation, and pressing it again collapses it', async () => {
		const chose = vi.fn();
		contents({
			collection: collectionOf(
				annotation({ id: 'a-1', title: 'One' }),
				annotation({ id: 'a-2', title: 'Two' })
			),
			onselect: chose
		});

		await press(nth('annotation-row', 0));
		expect(chose).toHaveBeenLastCalledWith('a-1');
		expect(nth('annotation-row', 0)).toHaveAttribute('aria-expanded', 'true');
		expect(nth('annotation-row', 1)).toHaveAttribute('aria-expanded', 'false');
		expect(nth('annotation-row', 0)).not.toHaveAttribute('aria-pressed');
		expect(all('annotation-editor')).toHaveLength(1);

		// **The same row again, which is the half a helper that clicked unconditionally would break.**
		await press(nth('annotation-row', 0));
		expect(chose).toHaveBeenLastCalledWith(null);
		expect(nth('annotation-row', 0)).toHaveAttribute('aria-expanded', 'false');
		expect(all('annotation-editor')).toHaveLength(0);
	});

	test('the revealed region is inside the row, and the button says which region it opens', () => {
		// The defect this is about: the editor was a *sibling of the list*, so which of four rows the
		// panel headed "The west quay" belonged to was inferred rather than seen. Asserted as
		// containment rather than by counting siblings, because that is the claim — and `aria-controls`
		// is the same fact said to a screen reader, which cannot see containment at all.
		contents({
			collection: collectionOf(
				annotation({ id: 'a-1', title: 'One' }),
				annotation({ id: 'a-2', title: 'Two' })
			),
			selectedId: 'a-2'
		});

		const editor = one('annotation-editor')!;
		const row = nth('annotation-row', 1);
		expect(row.closest('li')).toContainElement(editor);
		expect(nth('annotation-row', 0).closest('li')).not.toContainElement(editor);

		const region = row.getAttribute('aria-controls');
		expect(region).not.toBeNull();
		expect(document.getElementById(region!)).toContainElement(editor);
	});

	test('opening a second Annotation collapses the first', async () => {
		contents({
			collection: collectionOf(
				annotation({ id: 'a-1', title: 'One' }),
				annotation({ id: 'a-2', title: 'Two' })
			),
			selectedId: 'a-1'
		});

		await press(nth('annotation-row', 1));

		expect(nth('annotation-row', 0)).toHaveAttribute('aria-expanded', 'false');
		expect(nth('annotation-row', 1)).toHaveAttribute('aria-expanded', 'true');
		// One editor, and it is the second Annotation's: a panel that had merely been re-titled would
		// pass a count and show the wrong Annotation.
		expect(all('annotation-editor')).toHaveLength(1);
		expect(one('annotation-editor')).toHaveAttribute('data-annotation-id', 'a-2');
	});

	test('the keyboard stays on the row’s own button through opening and closing', async () => {
		// **Nothing here stops existing**, which is what separates this from the Layer card's delete and
		// reorder: those move focus only because the element holding it was removed. A disclosure that
		// took the keyboard would cost a scholar their place in the list for nothing.
		contents({
			collection: collectionOf(
				annotation({ id: 'a-1', title: 'One' }),
				annotation({ id: 'a-2', title: 'Two' })
			)
		});

		nth('annotation-row', 0).focus();
		expect(document.activeElement).toBe(nth('annotation-row', 0));

		await press(nth('annotation-row', 0));
		expect(document.activeElement).toBe(nth('annotation-row', 0));

		await press(nth('annotation-row', 0));
		expect(document.activeElement).toBe(nth('annotation-row', 0));
	});

	test('the component computes a zero duration when less motion has been asked for', () => {
		// ⚠ **This asserts the number the component computed, and not that the row animated.** There is
		// no paint at this seam and no Web Animations clock, so what an animation looks like has no
		// answer here. `prefersReducedMotion` is a real media query against this DOM's own device
		// settings, so the branch that produced the number is the one the application runs.
		//
		// ⚠ **What it therefore does not catch**, both measured: a `transition:slide` hard-coded to
		// `{ duration: 220 }` while this attribute goes on reporting 0 — a reduced-motion user watching
		// a 220 ms slide — and `transition:slide` deleted altogether. Story 25 ("expand and collapse
		// with a short animation") is unasserted at every seam; the ticket records it under "Coverage
		// gap". Do not read a green here as coverage of the animation.
		device().prefersReducedMotion = 'reduce';
		contents({
			collection: collectionOf(annotation({ id: 'a-1', title: 'One' })),
			selectedId: 'a-1'
		});

		expect(one('annotation-row-contents')).toHaveAttribute('data-reveal-ms', '0');
	});

	test('and the Layer cards’ own 220 ms when it has not been', () => {
		// The positive control. A duration hard-coded to `0` would satisfy the test above for ever.
		contents({
			collection: collectionOf(annotation({ id: 'a-1', title: 'One' })),
			selectedId: 'a-1'
		});

		expect(one('annotation-row-contents')).toHaveAttribute('data-reveal-ms', '220');
	});

	test('a Layer with nothing in it says so instead of drawing an empty list', () => {
		contents({ collection: collectionOf() });

		expect(one('annotation-list-empty')).toBeInTheDocument();
		expect(all('annotation-row')).toHaveLength(0);
	});

	test('the caption counts what is in the Layer, in the singular and the plural', () => {
		// **Exact rather than containing**, because "1 Annotations" contains "1 Annotation": a caption
		// that never singularised would satisfy a substring assertion and be the defect this is about.
		// The count and the word are two interpolations on two source lines, so the markup between them
		// is a newline and the template's indentation; the caption is one phrase to a reader.
		const caption = () =>
			document.querySelector('#annotation-list-caption')?.textContent?.replace(/\s+/g, ' ').trim();

		contents({ collection: collectionOf(annotation({ id: 'a-1' })) });
		expect(caption()).toBe('1 Annotation');

		unmount(mounted!);
		mounted = undefined;
		document.body.innerHTML = '';

		contents({ collection: collectionOf(annotation({ id: 'a-1' }), annotation({ id: 'a-2' })) });
		expect(caption()).toBe('2 Annotations');
	});
});

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
