// What the Layer stack renders, asserted against the component rather than against the application.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT MOVED HERE FROM `e2e/editor-layers.e2e.ts`, AND WHAT DELIBERATELY DID NOT
//
// The claims below were end-to-end tests. Each one seeded a Project into OPFS, booted the built
// editor, waited for MapLibre to report a stack, and then asserted on the *text of a sidebar row* —
// roughly four seconds of real application to read a sentence out of a `<li>`. None of that
// scenery was load-bearing for the claim, and there was no seam between "a class with no DOM" and
// "the whole app", so that was the only place they could live.
//
// ⚠ **What did not move is as important.** `LayerList` is handed `outcomes` and `openLayerId`; it
// does not compute either. So "a Layer that is drawn appears in MapLibre's own layer order", "a
// rename leaves `alignments/*.json` byte-identical", and "opening a row writes nothing to
// localStorage" are still `e2e/`'s, because each is a claim about the application's real
// dependencies and asserting it here would assert it against the props this file passes in.
// The sentence itself is `ProjectScreen`'s — see the note on {@link NOT_ALIGNED}.

/// <reference types="@vitest/browser/matchers" />

import { page } from '@vitest/browser/context';
import type { Layer } from '@ballastella/core';
// `@ballastella/core/render` rather than the barrel: everything under `src/render/` is browser-only
// and the barrel is not, which the barrel's own note explains. `LayerList.svelte` imports it from
// exactly here.
import type { DrawnOutcome } from '@ballastella/core/render';
import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

import LayerList from './LayerList.svelte';
import LayerListHarness from './LayerListHarness.svelte';

/**
 * What an unaligned map Layer says about itself.
 *
 * **Spelled out here rather than imported, and that is the point of the test that uses it.**
 * `ProjectScreen` composes this sentence and hands it to `LayerList` as a `refused` outcome; this
 * component's contract is that whatever it is handed arrives as *characters*. Importing the
 * constant would make the assertion agree with the producer whatever either of them said, which is
 * the failure `e2e/support/reader-project.ts` records for fixtures generally.
 */
const NOT_ALIGNED = 'Not aligned yet, so there is nothing to draw.';

const mapLayer = (id: string, name: string): Layer => ({
	kind: 'map',
	id,
	name,
	visible: true,
	order: 0,
	opacity: 1,
	imageId: `image-${id}`
});

const annotationLayer = (id: string, name: string): Layer => ({
	kind: 'annotation',
	id,
	name,
	visible: true,
	order: 1,
	geojsonRef: `annotations/${id}.geojson`
});

/** Every callback the component requires, as spies nothing here asserts on unless it says so. */
const handlers = () => ({
	onopen: vi.fn(),
	ontypename: vi.fn(),
	oncommit: vi.fn(),
	onshow: vi.fn(),
	ondragopacity: vi.fn(),
	onmove: vi.fn(),
	ondelete: vi.fn()
});

/**
 * `LayerList` alone, with a fixed `openLayerId` and callbacks that do nothing.
 *
 * For claims about what the component *renders* given a state. A claim about what it does after a
 * state has changed takes {@link liveStack} instead — see that helper's note.
 */
const stack = (options: {
	layers: readonly Layer[];
	outcomes?: Readonly<Record<string, DrawnOutcome>>;
	openLayerId?: string | null;
	referencedImageIds?: ReadonlySet<string>;
}) =>
	render(LayerList, {
		layers: options.layers,
		outcomes: options.outcomes ?? {},
		referencedImageIds: options.referencedImageIds ?? new Set<string>(),
		openLayerId: options.openLayerId ?? null,
		...handlers()
	});

/**
 * `LayerList` under a parent that really reorders and really opens rows.
 *
 * `LayerListHarness.svelte` carries the argument for why this is a component rather than a
 * `rerender` call; the short version is that `moveByButton` restores focus one microtask after
 * `onmove`, so a parent that updates late tests the wrong thing.
 */
const liveStack = (options: {
	layers: readonly Layer[];
	outcomes?: Readonly<Record<string, DrawnOutcome>>;
	onmove?: (id: string, toIndex: number) => void;
}) =>
	render(LayerListHarness, {
		layers: options.layers,
		outcomes: options.outcomes ?? {},
		...(options.onmove ? { onmove: options.onmove } : {})
	});

/** The disclosure of the row at `at`, addressed by position. */
const disclosure = (at: number) => page.getByTestId('layer-disclosure').nth(at);

/**
 * Open a row by its disclosure, the way a user does.
 *
 * ⚠ **`nth`, never a locator held from `.all()`.** A locator taken out of `.all()` is bound to the
 * element's *accessible name*, and this button's name is "Open — Notes" before the click and
 * "Close — Notes" after it — so a held locator stops matching the moment it does its job, and the
 * failure reads as "cannot find element" on a row that is plainly open.
 */
const openRow = async (at: number): Promise<void> => {
	await disclosure(at).click();
	await expect.element(disclosure(at)).toHaveAttribute('aria-expanded', 'true');
};

/** The Layer ids in rendered order, top first. */
const renderedOrder = async (): Promise<(string | null)[]> =>
	Promise.all(
		(await page.getByTestId('layer-row').all()).map((row) =>
			row.element().getAttribute('data-layer-id')
		)
	);

describe('a closed row stays useful (ticket 05)', () => {
	test('says what is wrong with a Layer as text, not as a colour', async () => {
		await stack({
			layers: [mapLayer('l-map', 'La Floride')],
			outcomes: { 'l-map': { status: 'refused', reason: NOT_ALIGNED } }
		});

		const row = page.getByTestId('layer-row');
		// The row is still closed: a user has to be able to notice a map needs aligning without
		// opening anything, which is the whole contract a closed card carries.
		await expect
			.element(row.getByTestId('layer-disclosure'))
			.toHaveAttribute('aria-expanded', 'false');
		// **`toHaveTextContent`, because a `class:text-warning` contributes no characters.** An
		// implementation that coloured the row instead of saying anything satisfies a `toBeVisible`
		// and fails this, which is the distinction the criterion is about.
		await expect.element(row.getByTestId('layer-problem')).toHaveTextContent(NOT_ALIGNED);
	});

	test('says nothing about a Layer that drew', async () => {
		await stack({
			layers: [mapLayer('l-map', 'La Floride')],
			outcomes: { 'l-map': { status: 'drawn' } }
		});

		await expect.element(page.getByTestId('layer-name-text')).toHaveTextContent('La Floride');
		// The negative control for the test above: a component that rendered the band unconditionally
		// would pass that one and fail this, and "the map is fine" is the commonest state there is.
		await expect.element(page.getByTestId('layer-problem')).not.toBeInTheDocument();
	});

	test('an outcome it was given for no Layer in the stack says nothing at all', async () => {
		// A stale outcome for a deleted Layer is a real state — the stack is rebuilt asynchronously —
		// and the row it names is gone, so there is nothing to attach the sentence to.
		await stack({
			layers: [mapLayer('l-map', 'La Floride')],
			outcomes: { 'l-gone': { status: 'refused', reason: NOT_ALIGNED } }
		});

		await expect.element(page.getByTestId('layer-row')).toBeInTheDocument();
		await expect.element(page.getByTestId('layer-problem')).not.toBeInTheDocument();
	});
});

describe('one Layer is open at a time', () => {
	test('renders the contents of the open Layer and of no other', async () => {
		await stack({
			layers: [mapLayer('l-map', 'La Floride'), annotationLayer('l-notes', 'Notes')],
			openLayerId: 'l-map'
		});

		// **Counted as well as attributed.** `aria-expanded` is the promise made to a screen reader
		// and the count is the promise made to the eye; an implementation that rendered both and hid
		// one with CSS would satisfy only the first.
		await expect.element(page.getByTestId('layer-contents')).toBeInTheDocument();
		expect(await page.getByTestId('layer-contents').all()).toHaveLength(1);

		await expect.element(disclosure(0)).toHaveAttribute('aria-expanded', 'true');
		await expect.element(disclosure(1)).toHaveAttribute('aria-expanded', 'false');
	});

	test('opens nothing when nothing is open', async () => {
		await stack({
			layers: [mapLayer('l-map', 'La Floride'), annotationLayer('l-notes', 'Notes')],
			openLayerId: null
		});

		// The sidebar arrives as a list of Layers: nothing opens itself.
		expect(await page.getByTestId('layer-contents').all()).toHaveLength(0);
		expect(await page.getByTestId('layer-row').all()).toHaveLength(2);
	});

	test('asks the screen to open a row rather than opening it itself', async () => {
		const spies = handlers();
		await render(LayerList, {
			layers: [mapLayer('l-map', 'La Floride')],
			outcomes: {},
			referencedImageIds: new Set<string>(),
			openLayerId: null,
			...spies
		});

		await page.getByTestId('layer-disclosure').click();

		// Which Layer is open is `ProjectScreen`'s, because for an Annotation Layer it is also the
		// Layer being drawn into — a copy held here would be a second thing that could disagree. So
		// the component's job at this click is to report it, and this is that claim.
		expect(spies.onopen).toHaveBeenCalledWith('l-map');
		expect(await page.getByTestId('layer-contents').all()).toHaveLength(0);
	});
});

describe('an empty stack', () => {
	test('says so rather than rendering an empty list', async () => {
		await stack({ layers: [] });

		await expect.element(page.getByTestId('no-layers')).toBeInTheDocument();
		expect(await page.getByTestId('layer-row').all()).toHaveLength(0);
	});
});

describe('the list reaches assistive technology (SPEC story 96)', () => {
	test('is an ordered list whose structure and order come from the markup', async () => {
		await liveStack({
			layers: [annotationLayer('l-notes', 'Notes'), mapLayer('l-map', 'La Floride')]
		});

		const list = page.getByRole('list', { name: 'Layers, top first' });
		await expect.element(list).toBeInTheDocument();
		// An `<ol>`, so position in the stack comes out of the markup rather than out of a label
		// somebody has to remember to update.
		expect(list.element().tagName).toBe('OL');
		expect(await list.getByRole('listitem').all()).toHaveLength(2);
	});

	test('each name field says where in the stack its Layer is', async () => {
		await liveStack({
			layers: [annotationLayer('l-notes', 'Notes'), mapLayer('l-map', 'La Floride')]
		});

		// **One row at a time, because the field is behind the pencil in an open card and the
		// disclosure is an accordion.** Both labels cannot be in the document at once, so asserting
		// them together would assert something the design does not do — the *positions* are checked
		// for both rows at once by the `<ol>`/`<li>` structure above, which is where position properly
		// comes from.
		await openRow(0);
		await page.getByTestId('layer-rename').click();
		await expect
			.element(page.getByTestId('layer-name'))
			.toHaveAccessibleName('Name of Layer 1 of 2');

		await openRow(1);
		await page.getByTestId('layer-rename').click();
		await expect
			.element(page.getByTestId('layer-name'))
			.toHaveAccessibleName('Name of Layer 2 of 2');
	});
});

describe('opacity is a map Layer’s and no other kind’s (SPEC story 51)', () => {
	test('is absent from an open Annotation Layer and present on an open map Layer', async () => {
		await liveStack({
			layers: [annotationLayer('l-notes', 'Notes'), mapLayer('l-map', 'La Floride')]
		});

		// ⚠ **Each row is asserted while its own card is open, and the absence is the reason.** The
		// slider lives inside the card and the disclosure is an accordion, so a version that opened
		// the map Layer and then asserted the annotation row had no slider would pass because that row
		// had just been *collapsed* — which is true of every control on it and says nothing about
		// kinds.
		await openRow(0);
		expect(await page.getByTestId('layer-opacity').all()).toHaveLength(0);

		await openRow(1);
		expect(await page.getByTestId('layer-opacity').all()).toHaveLength(1);
	});
});

describe('reordering leaves the keyboard where it can move again (SPEC story 53)', () => {
	/**
	 * ⚠ **What is asserted here is the list and the keyboard, never the map.**
	 *
	 * "An Annotation Layer above a map Layer *draws* above it" is a claim about MapLibre's own layer
	 * order and stays in `e2e/editor-layers.e2e.ts`, where there is a real renderer to ask. The
	 * component cannot see one, and a version of that assertion written here would be checking the
	 * order of the array this file passed in.
	 */
	test('moves a Layer down and announces where it went', async () => {
		const moves: [string, number][] = [];
		await liveStack({
			layers: [annotationLayer('l-notes', 'Notes'), mapLayer('l-map', 'La Floride')],
			onmove: (id, toIndex) => moves.push([id, toIndex])
		});

		// The reorder buttons live inside the open card, so the card is opened first — itself a
		// keyboard-operable step, since the disclosure is a plain `<button>`.
		await openRow(0);
		await page.getByTestId('layer-move-down').click();

		expect(moves).toEqual([['l-notes', 1]]);
		expect(await renderedOrder()).toEqual(['l-map', 'l-notes']);
		// Announced, because a move changes nothing near the pointer and nothing that has focus.
		await expect
			.element(page.getByTestId('layer-move-status'))
			.toHaveTextContent('moved to 2 of 2');
	});

	test('hands the keyboard the other half of the control at the end of the stack', async () => {
		await liveStack({
			layers: [annotationLayer('l-notes', 'Notes'), mapLayer('l-map', 'La Floride')]
		});

		await openRow(0);
		await page.getByTestId('layer-move-down').click();

		// At the bottom of the stack "Move down" is a disabled button — "this Layer cannot go lower"
		// is information a screen reader gets free from the markup — so the keyboard is handed the
		// other half of the same control rather than the document body.
		await expect.element(page.getByTestId('layer-move-up')).toHaveFocus();
	});

	test('keeps the keyboard on the same button when the move does not reach an end', async () => {
		// Away from the ends, where the button that was pressed is still enabled: the case that is
		// about Svelte moving a keyed node rather than about `disabled`.
		await liveStack({
			layers: [
				annotationLayer('l-top', 'Top'),
				annotationLayer('l-middle', 'Middle'),
				mapLayer('l-map', 'La Floride')
			]
		});

		await openRow(0);
		await page.getByTestId('layer-move-down').click();

		expect(await renderedOrder()).toEqual(['l-middle', 'l-top', 'l-map']);
		await expect.element(page.getByTestId('layer-move-down')).toHaveFocus();

		// And it really is operable from there: one more press, no Tab, and the Layer moves again.
		await page.getByTestId('layer-move-down').click();
		expect(await renderedOrder()).toEqual(['l-middle', 'l-map', 'l-top']);
	});
});
