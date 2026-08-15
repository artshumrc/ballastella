// What the Annotation list renders, asserted against the component rather than against either app.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT MOVED HERE, AND WHAT DELIBERATELY DID NOT
//
// These claims were `apps/editor/src/lib/annotations/annotation-layer-contents.dom.test.ts`'s while
// the list and the row lived in the editor. A shared component tested from the app it used to live
// in is tested *through a consumer*, and the second consumer is then either untested or carrying a
// copy of the same claim (ADR-0034). What stayed behind is what is genuinely the editor's: the
// drawing tools, the place search, and the rule that the list stands aside while a shape is armed.
//
// ⚠ **The inertness of a stranger's `description` is NOT asserted here and must not be.** DOMPurify
// answers "supported" against happy-dom and then returns its input essentially untouched, so a
// sanitiser claim at this seam is green whatever the sanitiser does — this package's
// `vitest.config.ts` records the measurement. That claim lives in `e2e/viewer-reader.e2e.ts`, in a
// real browser, against a real published build.
//
// **The row's name surface is asserted here**, and it is a different mechanism from the description:
// a title is a Svelte interpolation, so the DOM never parses it as markup, and that it stays one is
// the whole of its safety. A change to `{@html}` there would otherwise be silent.

import type { Annotation } from '@ballastella/core';
import type { DetachedWindowAPI } from 'happy-dom';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import AnnotationListHarness from './AnnotationListHarness.svelte';
import AnnotationReading from './AnnotationReading.svelte';

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

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
	device().prefersReducedMotion = 'no-preference';
});

/** Mount the harness, remember it for {@link afterEach}, and let its effects run. */
const list = (props: ComponentProps<typeof AnnotationListHarness>): void => {
	mounted = mount(AnnotationListHarness, { target: document.body, props });
	flushSync();
};

/**
 * Hand the list already on the screen a different collection, the way a consumer does after a delete.
 *
 * A prop update rather than a second mount, which for anything a row computes from its place in the
 * collection is the only shape the claim has: a component that read the number once, at mount, is
 * right in a freshly mounted list and wrong in the one the scholar is looking at.
 */
const show = (annotations: readonly Annotation[] | null): void => {
	const harness = mounted as { show?: (next: readonly Annotation[] | null) => void } | undefined;
	if (!harness?.show) throw new Error('nothing is mounted that can be handed new Annotations');
	harness.show(annotations);
	flushSync();
};

/** Take the mounted list down mid-test, so a second prop set can be mounted into a clean document. */
const takeDown = (): void => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
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

/** Press a control and let Svelte finish, including the effect an open row runs. */
const press = async (element: HTMLElement): Promise<void> => {
	element.focus();
	element.click();
	await tick();
	await tick();
};

describe('an Annotation’s own words reach the row as text (SPEC story 34, ADR-0009)', () => {
	test('a title that looks like markup is characters, not elements', () => {
		list({ annotations: [annotation({ id: 'a-1', title: PAYLOAD })] });

		const row = one('annotation-row-name')!;
		// Every character survives, including the angle brackets: nothing parsed it.
		expect(row).toHaveTextContent(PAYLOAD);
		// And the negative control, because a text assertion alone passes on a surface that rendered
		// the tag *and* left the words after it: no element was created from those characters.
		expect(row.querySelector('img')).toBeNull();
		expect(row.children).toHaveLength(0);
	});

	test('an Annotation with no title is named by its shape and its place in the list', () => {
		list({
			annotations: [
				annotation({ id: 'a-1' }),
				annotation({ id: 'a-2', type: 'LineString' }),
				annotation({ id: 'a-3', type: 'Polygon' })
			]
		});

		// Numbered from 1 and by *position*, so the list reads as a list rather than as three things
		// all called "Untitled".
		expect(all('annotation-row-name').map((row) => row.textContent?.trim())) //
			.toEqual(['Untitled pin 1', 'Untitled line 2', 'Untitled shape 3']);
	});

	test('a title displaces the fallback rather than joining it', () => {
		list({
			annotations: [annotation({ id: 'a-1', title: 'Fort Amsterdam' }), annotation({ id: 'a-2' })]
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
		list({ annotations: [annotation({ id: 'a-1', title: '' })] });

		expect(one('annotation-row-name')).toHaveTextContent('Untitled pin 1');
	});
});

describe('every Annotation is numbered on its row (stories 37, 38, 42)', () => {
	// **The number is the same fact the map's mark draws**, and it is `annotationOrdinal`'s in both
	// places — see `packages/core/src/annotation/ordinal.ts` for why the rule is one function rather
	// than an `index + 1` written wherever a number is wanted. That the mark carries it too is asserted
	// in a real browser, against a real map, in `e2e/editor-annotations.e2e.ts` and
	// `e2e/viewer-reader.e2e.ts`; what is asserted here is the row's half and the rule behind it.

	const three = (): Annotation[] => [
		annotation({ id: 'a-1', title: 'The west quay' }),
		annotation({ id: 'a-2', type: 'LineString', title: 'The tow path' }),
		annotation({ id: 'a-3', type: 'Polygon' })
	];

	const ordinals = (): (string | undefined)[] =>
		all('annotation-row-ordinal').map((mark) => mark.textContent?.trim());

	test('the ordinals start at 1 and follow the collection’s order', () => {
		list({ annotations: three() });

		expect(ordinals()).toEqual(['1', '2', '3']);
	});

	test('the number is added to the row, not put in place of anything it already said', () => {
		// The Contract's own words: the row keeps its name and its shape word, and the marker keeps
		// whatever accessible name it has. A number that displaced the name would read as a tidier list
		// and would have taken away the only thing that says what an Annotation *is*.
		list({ annotations: three() });

		expect(all('annotation-row-name').map((row) => row.textContent?.trim())) //
			.toEqual(['The west quay', 'The tow path', 'Untitled shape 3']);
		expect(nth('annotation-row', 1)).toHaveTextContent('line');
	});

	test('the number is inside the row’s own button, so it is heard as well as seen', () => {
		// Story 42: nothing about which Annotation is which may depend on seeing a line, so the ordinal
		// is part of the button's accessible name rather than a decoration positioned beside it.
		list({ annotations: three() });

		const button = nth('annotation-row', 2);
		expect(button.querySelector('[data-testid="annotation-row-ordinal"]')).not.toBeNull();
		expect(button.textContent?.replace(/\s+/g, ' ').trim()).toBe('3 shape Untitled shape 3');
	});

	test('deleting an Annotation renumbers the rest, in the rows already on the screen', () => {
		// The whole of ADR-0002 at this seam: the consumer hands the list a shorter collection and the
		// survivors are numbered from what is in front of them. Nothing was written to renumber them —
		// `packages/core/src/annotation/ordinal.test.ts` asserts the bytes, and the Annotations here are
		// the same objects handed back.
		//
		// ⚠ **A prop update and not a second mount**, which is the whole of what this asserts. Mounting
		// the shorter collection into a clean document is a claim about mounting: a row that read its
		// number once, when it was first rendered, would satisfy it and would go on showing "3" beside
		// the Annotation now second in the sidebar. So the survivor's own element is held across the
		// change and asserted to be the same node, still in the list, now numbered 2.
		const before = three();
		list({ annotations: before });
		expect(ordinals()).toEqual(['1', '2', '3']);
		const survivor = nth('annotation-row', 2);

		show([before[0]!, before[2]!]);

		expect(ordinals()).toEqual(['1', '2']);
		expect(all('annotation-row-name').map((row) => row.textContent?.trim())) //
			.toEqual(['The west quay', 'Untitled shape 2']);
		expect(nth('annotation-row', 1)).toBe(survivor);
		expect(survivor.textContent?.replace(/\s+/g, ' ').trim()).toBe('2 shape Untitled shape 2');
	});
});

describe('the row is a disclosure (one-shell-two-apps stories 24–32, 35)', () => {
	// **Openness and selection are one state, so there is one property for them.** The row carries no
	// `aria-pressed`: an Annotation that was pressed but not open, or open but not pressed, were two
	// answers to "which one is active" that could disagree, and now there is one. The wash the open
	// row wears is a paint claim and stays in `e2e/`.

	test('a row expands to reveal its own Annotation, and pressing it again collapses it', async () => {
		const opened = vi.fn();
		list({
			annotations: [
				annotation({ id: 'a-1', title: 'One' }),
				annotation({ id: 'a-2', title: 'Two' })
			],
			withContents: true,
			onopen: opened
		});

		await press(nth('annotation-row', 0));
		expect(opened).toHaveBeenLastCalledWith('a-1');
		expect(nth('annotation-row', 0)).toHaveAttribute('aria-expanded', 'true');
		expect(nth('annotation-row', 1)).toHaveAttribute('aria-expanded', 'false');
		expect(nth('annotation-row', 0)).not.toHaveAttribute('aria-pressed');
		expect(all('harness-annotation-contents')).toHaveLength(1);

		// **The same row again, which is the half a helper that clicked unconditionally would break.**
		await press(nth('annotation-row', 0));
		expect(opened).toHaveBeenLastCalledWith(null);
		expect(nth('annotation-row', 0)).toHaveAttribute('aria-expanded', 'false');
		expect(all('harness-annotation-contents')).toHaveLength(0);
	});

	test('the revealed region is inside the row, and the button says which region it opens', () => {
		// The defect this is about: the details were a *sibling of the list*, so which of four rows the
		// panel headed "The west quay" belonged to was inferred rather than seen. Asserted as
		// containment rather than by counting siblings, because that is the claim — and `aria-controls`
		// is the same fact said to a screen reader, which cannot see containment at all.
		list({
			annotations: [
				annotation({ id: 'a-1', title: 'One' }),
				annotation({ id: 'a-2', title: 'Two' })
			],
			openId: 'a-2',
			withContents: true
		});

		const revealed = one('harness-annotation-contents')!;
		const row = nth('annotation-row', 1);
		expect(row.closest('li')).toContainElement(revealed);
		expect(nth('annotation-row', 0).closest('li')).not.toContainElement(revealed);

		const region = row.getAttribute('aria-controls');
		expect(region).not.toBeNull();
		expect(document.getElementById(region!)).toContainElement(revealed);
	});

	test('opening a second Annotation collapses the first', async () => {
		list({
			annotations: [
				annotation({ id: 'a-1', title: 'One' }),
				annotation({ id: 'a-2', title: 'Two' })
			],
			openId: 'a-1',
			withContents: true
		});

		await press(nth('annotation-row', 1));

		expect(nth('annotation-row', 0)).toHaveAttribute('aria-expanded', 'false');
		expect(nth('annotation-row', 1)).toHaveAttribute('aria-expanded', 'true');
		// One revealed region, and it is the second Annotation's: a panel that had merely been
		// re-titled would pass a count and show the wrong Annotation.
		expect(all('harness-annotation-contents')).toHaveLength(1);
		expect(one('harness-annotation-contents')).toHaveAttribute('data-annotation-id', 'a-2');
	});

	test('the keyboard stays on the row’s own button through opening and closing', async () => {
		// **Nothing here stops existing**, which is what separates this from the Layer card's delete and
		// reorder: those move focus only because the element holding it was removed. A disclosure that
		// took the keyboard would cost a reader their place in the list for nothing.
		list({
			annotations: [
				annotation({ id: 'a-1', title: 'One' }),
				annotation({ id: 'a-2', title: 'Two' })
			],
			withContents: true
		});

		nth('annotation-row', 0).focus();
		expect(document.activeElement).toBe(nth('annotation-row', 0));

		await press(nth('annotation-row', 0));
		expect(document.activeElement).toBe(nth('annotation-row', 0));

		await press(nth('annotation-row', 0));
		expect(document.activeElement).toBe(nth('annotation-row', 0));
	});

	test('the row computes a zero duration when less motion has been asked for', () => {
		// ⚠ **This asserts the number the component computed, and not that the row animated.** There is
		// no paint at this seam and no Web Animations clock, so what an animation looks like has no
		// answer here. `prefersReducedMotion` is a real media query against this DOM's own device
		// settings, so the branch that produced the number is the one the application runs.
		//
		// ⚠ **What it therefore does not catch**, both measured: a `transition:slide` hard-coded to
		// `{ duration: 220 }` while this attribute goes on reporting 0 — a reduced-motion user watching
		// a 220 ms slide — and `transition:slide` deleted altogether. Story 25 ("expand and collapse
		// with a short animation") is unasserted at every seam; ticket 01 records it under "Coverage
		// gap". Do not read a green here as coverage of the animation.
		device().prefersReducedMotion = 'reduce';
		list({
			annotations: [annotation({ id: 'a-1', title: 'One' })],
			openId: 'a-1',
			withContents: true
		});

		expect(one('annotation-row-contents')).toHaveAttribute('data-reveal-ms', '0');
	});

	test('and the Layer cards’ own 220 ms when it has not been', () => {
		// The positive control. A duration hard-coded to `0` would satisfy the test above for ever.
		list({
			annotations: [annotation({ id: 'a-1', title: 'One' })],
			openId: 'a-1',
			withContents: true
		});

		expect(one('annotation-row-contents')).toHaveAttribute('data-reveal-ms', '220');
	});

	test('a Layer with nothing in it says so instead of drawing an empty list', () => {
		list({ annotations: [] });

		expect(one('annotation-list-empty')).toBeInTheDocument();
		expect(all('annotation-row')).toHaveLength(0);
	});

	test('and says nothing at all about a Layer whose collection has not been read', () => {
		// ⚠ **"This Layer has no Annotations in it" is a claim about a collection somebody has read.**
		// A Layer still loading, and a Layer whose GeoJSON will not parse, are Layers nobody can say
		// that about — and the viewer said it about both, because `openAnnotations` collapsed all three
		// document states into `[]`. A Reader who had hidden that Layer got the sentence with nothing
		// beside it: the problem band is built from the Layers that are *shown*, so there was no
		// "could not be read" anywhere on the screen to contradict it.
		list({ annotations: null });

		expect(one('annotation-list-empty')).not.toBeInTheDocument();
		expect(one('annotation-list')).not.toBeInTheDocument();
		expect(all('annotation-row')).toHaveLength(0);
	});

	test('the empty state is the bare fact, and guidance about it is the consumer’s', () => {
		// Both halves, in both directions, for the reason the `tools` and `contents` pairs below are
		// asserted both ways: an absence on its own goes quietly green when the wording changes.
		//
		// **"yet" is the word this is about.** On a Published Site nothing will ever be put in this
		// Layer — there is no control that could — so an editor's "yet" promises a Reader something
		// that cannot happen. It is the same defect `LayerList`'s empty state already had.
		list({ annotations: [], withGuidance: true });

		expect(one('harness-annotation-guidance')).toBeInTheDocument();
		expect(one('annotation-list-empty')).toHaveTextContent('Nothing in this Layer yet');

		takeDown();
		list({ annotations: [] });

		expect(one('harness-annotation-guidance')).not.toBeInTheDocument();
		expect(one('annotation-list-empty')).toHaveTextContent('This Layer has no Annotations in it.');
		expect(one('annotation-list-empty')?.textContent).not.toMatch(/yet/i);
	});

	test('the caption counts what is in the Layer, in the singular and the plural', () => {
		// **Exact rather than containing**, because "1 Annotations" contains "1 Annotation": a caption
		// that never singularised would satisfy a substring assertion and be the defect this is about.
		// The count and the word are two interpolations on two source lines, so the markup between them
		// is a newline and the template's indentation; the caption is one phrase to a reader.
		const caption = () =>
			document.querySelector('#annotation-list-caption')?.textContent?.replace(/\s+/g, ' ').trim();

		list({ annotations: [annotation({ id: 'a-1' })] });
		expect(caption()).toBe('1 Annotation');

		takeDown();

		list({ annotations: [annotation({ id: 'a-1' }), annotation({ id: 'a-2' })] });
		expect(caption()).toBe('2 Annotations');
	});
});

describe('a surface the consumer does not ask for is not there (SPEC stories 58, 60)', () => {
	// ⚠ **Both halves of every claim, on purpose.** An absence asserted on its own is the vacuous
	// green this repository's testing decisions exist to prevent: rename one `data-testid` and every
	// `not.toBeInTheDocument()` below goes on passing while the control it names sits on the screen.
	// So each test mounts the same list twice — once passing the snippet and once not — and the
	// present half is what gives the absent half its meaning.
	//
	// **There is no `readOnly` prop to test, and that is the subject rather than an omission.** A
	// consumer's interface *is* the set of props it passes.

	const two = (): Annotation[] => [
		annotation({ id: 'a-1', title: 'One' }),
		annotation({ id: 'a-2', title: 'Two' })
	];

	test('offers the drawing surface only with tools', () => {
		// ⚠ **This is the absence that matters most in the epic.** The editor's `tools` snippet holds
		// the drawing surface *and* the place search, and a place search issues a lookup to a
		// third-party service. A Published Site quietly doing that for a Reader who asked for nothing
		// is what ADR-0029 is written against, which is why the viewer passes no snippet at all rather
		// than passing one that renders less.
		list({ annotations: two(), withTools: true });
		expect(one('harness-annotation-tools')).toBeInTheDocument();
		// The list is there either way: withholding the tools must not withhold the Annotations.
		expect(all('annotation-row')).toHaveLength(2);

		takeDown();
		list({ annotations: two() });

		expect(one('harness-annotation-tools')).not.toBeInTheDocument();
		expect(all('annotation-row')).toHaveLength(2);
	});

	test('reveals what the consumer put in an open row, and nothing when it put nothing', async () => {
		list({ annotations: two(), withContents: true });
		await press(nth('annotation-row', 0));

		expect(one('harness-annotation-contents')).toBeInTheDocument();
		expect(one('harness-annotation-delete')).toBeInTheDocument();

		takeDown();
		list({ annotations: two() });
		await press(nth('annotation-row', 0));

		// The row still opens — `aria-expanded` and the region are the list's, and they are what a
		// screen reader is promised — but there is nothing inside it to press.
		expect(nth('annotation-row', 0)).toHaveAttribute('aria-expanded', 'true');
		expect(one('annotation-row-contents')).toBeInTheDocument();
		expect(one('harness-annotation-contents')).not.toBeInTheDocument();
		expect(one('harness-annotation-delete')).not.toBeInTheDocument();
	});
});

describe('what an open row reveals is the same Annotation the button above it names', () => {
	/** Mount `AnnotationReading` on its own, which is what a Reader's open row puts in the row. */
	const reading = (props: ComponentProps<typeof AnnotationReading>): void => {
		mounted = mount(AnnotationReading, { target: document.body, props });
		flushSync();
	};

	test('an untitled Annotation is “Untitled pin 3” on the button and beneath it', () => {
		// The row's name first, so the claim is that the two *agree* rather than that each matches a
		// literal written twice. The reading surface had wording of its own — "Untitled" — so an
		// untitled Annotation was named two ways a few pixels apart.
		list({
			annotations: [annotation({ id: 'a-1' }), annotation({ id: 'a-2' }), annotation({ id: 'a-3' })]
		});
		const onTheButton = nth('annotation-row-name', 2).textContent?.trim();
		expect(onTheButton).toBe('Untitled pin 3');

		takeDown();
		reading({ annotation: annotation({ id: 'a-3' }), index: 2 });

		expect(one('annotation-title-text')).toHaveTextContent(onTheButton!);
	});

	test('names the description on an element that can carry a name', () => {
		// A bare `<div>` has the implicit `generic` role, for which ARIA 1.2 prohibits `aria-label` and
		// which browsers drop from the accessibility tree: the attribute was there, and named nothing.
		// A `<section>` with a name is a `region`, so a Reader on a screen reader meets a boundary
		// between the title and a stranger's prose instead of running straight from one into the other.
		reading({ annotation: annotation({ id: 'a-1', title: 'The west quay' }), index: 0 });

		const description = one('annotation-description-text');
		expect(description?.tagName).toBe('SECTION');
		expect(description).toHaveAttribute('aria-label', 'Description');
	});
});
