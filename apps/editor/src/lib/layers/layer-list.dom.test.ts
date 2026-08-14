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
//
// Ticket 08 added the foreign-kind row and the three snippets, and the snippets are where the line is
// drawn most finely: **whether and where the card renders one is `LayerList`'s and is asserted here;
// what goes inside one is `ProjectScreen`'s and is not.** `LayerListHarness.svelte` supplies markers
// rather than the real Align link for exactly that reason. Nothing about a *drag* moved, and that was
// probed rather than assumed — happy-dom's `DragEvent` carries neither `dataTransfer` nor
// `relatedTarget`, which is entry 4 in `vitest.config.ts`'s catalog.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THIS RUNS IN NODE, AGAINST A DOM IMPLEMENTATION
//
// It used to run in vitest's browser mode. `vitest.config.ts` carries the argument for the move and
// the record of what this DOM implementation was probed for before any of these claims were trusted
// — the first test below is the probe that mattered most, re-asked here against the real component
// so that it cannot quietly stop being true.
//
// **Everything is addressed by position and read straight off the document.** There is no locator
// object and no component-testing library: `mount` is Svelte's own, and a query is
// `document.querySelectorAll`. That is the whole seam's machinery.

import type { Layer } from '@ballastella/core';
// `@ballastella/core/render` rather than the barrel: everything under `src/render/` is browser-only
// and the barrel is not, which the barrel's own note explains. `LayerList.svelte` imports it from
// exactly here.
import type { DrawnOutcome } from '@ballastella/core/render';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

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

/**
 * A Layer of a kind this build has never heard of (ADR-0014).
 *
 * `declaredKind` is the kind the file carried; `kind: 'foreign'` is what the parser turned it into.
 * Built here rather than through `parseLayers`, because what the parser does with an unknown kind has
 * its own tests in `packages/core/src/project/layer.test.ts` and this file's subject is what the list
 * renders when handed one.
 */
const foreignLayer = (id: string, name: string): Layer => ({
	kind: 'foreign',
	id,
	name,
	visible: true,
	order: 0,
	declaredKind: 'image-annotation'
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
 * Whatever was mounted, so it can be taken down again.
 *
 * The document survives from test to test in one file, so a component left mounted would be found
 * by the next test's `querySelectorAll` and counted — which turns "there is one open card" into a
 * claim about how many tests have run so far.
 */
let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

/** Remember what was mounted so {@link afterEach} can take it down, and let its effects run. */
const shown = (component: Record<string, unknown>): void => {
	mounted = component;
	flushSync();
};

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
}): void =>
	shown(
		mount(LayerList, {
			target: document.body,
			props: {
				layers: options.layers,
				outcomes: options.outcomes ?? {},
				referencedImageIds: options.referencedImageIds ?? new Set<string>(),
				openLayerId: options.openLayerId ?? null,
				...handlers()
			}
		})
	);

/**
 * `LayerList` under a parent that really reorders and really opens rows.
 *
 * `LayerListHarness.svelte` carries the argument for why this is a component rather than a props
 * assignment from the test body; the short version is that `moveByButton` restores focus one
 * microtask after `onmove`, so a parent that updates late tests the wrong thing.
 */
const liveStack = (options: {
	layers: readonly Layer[];
	outcomes?: Readonly<Record<string, DrawnOutcome>>;
	onmove?: (id: string, toIndex: number) => void;
}): void =>
	shown(
		mount(LayerListHarness, {
			target: document.body,
			props: {
				layers: options.layers,
				outcomes: options.outcomes ?? {},
				...(options.onmove ? { onmove: options.onmove } : {})
			}
		})
	);

/** Every element carrying a `data-testid`, in document order. */
const all = (testId: string): HTMLElement[] => [
	...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)
];

/**
 * The one element carrying a `data-testid`, or `null` when there is none.
 *
 * Deliberately `null` rather than a throw, because "there is no such element" is the assertion in
 * several tests below and `not.toBeInTheDocument()` is how it is spelled.
 */
const one = (testId: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/**
 * The `at`th element carrying a `data-testid`, which must exist.
 *
 * ⚠ **Position, never a handle held across an interaction.** In browser mode this rule was about a
 * locator binding to an accessible name — the disclosure is called "Open — Notes" before its click
 * and "Close — Notes" after it, so a held locator stopped matching the moment it did its job and
 * failed as "cannot find element" on a row that was plainly open. In Node the trap is worse rather
 * than gone: the `{#each}` is keyed, so a reorder *moves* the node and an element held in a `const`
 * goes on answering questions from its old position without any error at all.
 */
const nth = (testId: string, at: number): HTMLElement => {
	const found = all(testId)[at];
	if (!found) throw new Error(`no [data-testid="${testId}"] at position ${at}`);
	return found;
};

/** The disclosure of the row at `at`, addressed by position. */
const disclosure = (at: number) => nth('layer-disclosure', at);

/**
 * Let Svelte finish, including the microtask `moveByButton` and `deleteByButton` wait on.
 *
 * Two ticks rather than one: the first lets the reorder reach the DOM, the second lets the focus
 * restoration that runs *after* that reorder happen.
 */
const settle = async (): Promise<void> => {
	await tick();
	await tick();
};

/**
 * Press a control the way a pointer does: focus it, then click it.
 *
 * The focus is not decoration. `moveByButton` refuses to move the keyboard if something other than
 * the button that was pressed holds it, so a bare `click()` — which moves focus nowhere in a DOM
 * implementation, and would in a browser — would exercise the `document.body` branch of that guard
 * instead of the one a user reaches.
 */
const press = async (element: HTMLElement): Promise<void> => {
	element.focus();
	element.click();
	await settle();
};

/** Open a row by its disclosure, the way a user does. */
const openRow = async (at: number): Promise<void> => {
	await press(disclosure(at));
	expect(disclosure(at)).toHaveAttribute('aria-expanded', 'true');
};

/** The Layer ids in rendered order, top first. */
const renderedOrder = (): (string | null)[] =>
	all('layer-row').map((row) => row.getAttribute('data-layer-id'));

describe('the DOM implementation this seam trusts', () => {
	// ⚠ **The probe, not a test of the application** — and it is here rather than in a throwaway
	// script because two claims below turn on it. `moveByButton` hands the keyboard "the other half
	// of the same control" only because the half that was pressed is `disabled` and a browser
	// refuses to focus a disabled element. A DOM implementation that allowed it would make those
	// claims pass here for a reason no browser has, and they would have to go back to `e2e/` — where
	// the browser is real rather than nearly real — rather than be worked around.
	test('refuses to focus a disabled control, as a browser does', async () => {
		liveStack({
			layers: [annotationLayer('l-notes', 'Notes'), mapLayer('l-map', 'La Floride')]
		});
		await openRow(0);

		// The top Layer cannot go higher, so this is the disabled half.
		const up = nth('layer-move-up', 0) as HTMLButtonElement;
		expect(up.disabled).toBe(true);

		const before = document.activeElement;
		up.focus();
		expect(document.activeElement).toBe(before);
		expect(up).not.toHaveFocus();
	});
});

describe('a closed row stays useful (ticket 05)', () => {
	test('says what is wrong with a Layer as text, not as a colour', () => {
		stack({
			layers: [mapLayer('l-map', 'La Floride')],
			outcomes: { 'l-map': { status: 'refused', reason: NOT_ALIGNED } }
		});

		// The row is still closed: a user has to be able to notice a map needs aligning without
		// opening anything, which is the whole contract a closed card carries.
		expect(disclosure(0)).toHaveAttribute('aria-expanded', 'false');
		// **`toHaveTextContent`, because a `class:text-warning` contributes no characters.** An
		// implementation that coloured the row instead of saying anything satisfies a `toBeVisible`
		// and fails this, which is the distinction the criterion is about.
		expect(one('layer-problem')).toHaveTextContent(NOT_ALIGNED);
	});

	test('says nothing about a Layer that drew', () => {
		stack({
			layers: [mapLayer('l-map', 'La Floride')],
			outcomes: { 'l-map': { status: 'drawn' } }
		});

		expect(one('layer-name-text')).toHaveTextContent('La Floride');
		// The negative control for the test above: a component that rendered the band unconditionally
		// would pass that one and fail this, and "the map is fine" is the commonest state there is.
		expect(one('layer-problem')).not.toBeInTheDocument();
	});

	test('an outcome it was given for no Layer in the stack says nothing at all', () => {
		// A stale outcome for a deleted Layer is a real state — the stack is rebuilt asynchronously —
		// and the row it names is gone, so there is nothing to attach the sentence to.
		stack({
			layers: [mapLayer('l-map', 'La Floride')],
			outcomes: { 'l-gone': { status: 'refused', reason: NOT_ALIGNED } }
		});

		expect(one('layer-row')).toBeInTheDocument();
		expect(one('layer-problem')).not.toBeInTheDocument();
	});
});

describe('one Layer is open at a time', () => {
	test('renders the contents of the open Layer and of no other', () => {
		stack({
			layers: [mapLayer('l-map', 'La Floride'), annotationLayer('l-notes', 'Notes')],
			openLayerId: 'l-map'
		});

		// **Counted as well as attributed.** `aria-expanded` is the promise made to a screen reader
		// and the count is the promise made to the eye; an implementation that rendered both and hid
		// one with CSS would satisfy only the first.
		expect(all('layer-contents')).toHaveLength(1);

		expect(disclosure(0)).toHaveAttribute('aria-expanded', 'true');
		expect(disclosure(1)).toHaveAttribute('aria-expanded', 'false');
	});

	test('opens nothing when nothing is open', () => {
		stack({
			layers: [mapLayer('l-map', 'La Floride'), annotationLayer('l-notes', 'Notes')],
			openLayerId: null
		});

		// The sidebar arrives as a list of Layers: nothing opens itself.
		expect(all('layer-contents')).toHaveLength(0);
		expect(all('layer-row')).toHaveLength(2);
	});

	test('asks the screen to open a row rather than opening it itself', async () => {
		const spies = handlers();
		shown(
			mount(LayerList, {
				target: document.body,
				props: {
					layers: [mapLayer('l-map', 'La Floride')],
					outcomes: {},
					referencedImageIds: new Set<string>(),
					openLayerId: null,
					...spies
				}
			})
		);

		await press(disclosure(0));

		// Which Layer is open is `ProjectScreen`'s, because for an Annotation Layer it is also the
		// Layer being drawn into — a copy held here would be a second thing that could disagree. So
		// the component's job at this click is to report it, and this is that claim.
		expect(spies.onopen).toHaveBeenCalledWith('l-map');
		expect(all('layer-contents')).toHaveLength(0);
	});
});

describe('an empty stack', () => {
	test('says so rather than rendering an empty list', () => {
		stack({ layers: [] });

		expect(one('no-layers')).toBeInTheDocument();
		expect(all('layer-row')).toHaveLength(0);
	});
});

describe('the list reaches assistive technology (SPEC story 96)', () => {
	test('is an ordered list whose structure and order come from the markup', () => {
		liveStack({
			layers: [annotationLayer('l-notes', 'Notes'), mapLayer('l-map', 'La Floride')]
		});

		// An `<ol>`, so position in the stack comes out of the markup rather than out of a label
		// somebody has to remember to update — and the list is named, so it is findable among the
		// other lists on the Project screen.
		const list = document.querySelector('ol');
		expect(list).toHaveAccessibleName('Layers, top first');
		expect(list?.querySelectorAll(':scope > li')).toHaveLength(2);
	});

	test('each name field says where in the stack its Layer is', async () => {
		liveStack({
			layers: [annotationLayer('l-notes', 'Notes'), mapLayer('l-map', 'La Floride')]
		});

		// **One row at a time, because the field is behind the pencil in an open card and the
		// disclosure is an accordion.** Both labels cannot be in the document at once, so asserting
		// them together would assert something the design does not do — the *positions* are checked
		// for both rows at once by the `<ol>`/`<li>` structure above, which is where position properly
		// comes from.
		await openRow(0);
		await press(nth('layer-rename', 0));
		expect(one('layer-name')).toHaveAccessibleName('Name of Layer 1 of 2');

		await openRow(1);
		await press(nth('layer-rename', 0));
		expect(one('layer-name')).toHaveAccessibleName('Name of Layer 2 of 2');
	});
});

describe('opacity is a map Layer’s and no other kind’s (SPEC story 51)', () => {
	test('is absent from an open Annotation Layer and present on an open map Layer', async () => {
		liveStack({
			layers: [annotationLayer('l-notes', 'Notes'), mapLayer('l-map', 'La Floride')]
		});

		// ⚠ **Each row is asserted while its own card is open, and the absence is the reason.** The
		// slider lives inside the card and the disclosure is an accordion, so a version that opened
		// the map Layer and then asserted the annotation row had no slider would pass because that row
		// had just been *collapsed* — which is true of every control on it and says nothing about
		// kinds.
		await openRow(0);
		expect(all('layer-opacity')).toHaveLength(0);

		await openRow(1);
		expect(all('layer-opacity')).toHaveLength(1);
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
		liveStack({
			layers: [annotationLayer('l-notes', 'Notes'), mapLayer('l-map', 'La Floride')],
			onmove: (id, toIndex) => moves.push([id, toIndex])
		});

		// The reorder buttons live inside the open card, so the card is opened first — itself a
		// keyboard-operable step, since the disclosure is a plain `<button>`.
		await openRow(0);
		await press(nth('layer-move-down', 0));

		expect(moves).toEqual([['l-notes', 1]]);
		expect(renderedOrder()).toEqual(['l-map', 'l-notes']);
		// Announced, because a move changes nothing near the pointer and nothing that has focus.
		expect(one('layer-move-status')).toHaveTextContent('moved to 2 of 2');
	});

	test('hands the keyboard the other half of the control at the end of the stack', async () => {
		liveStack({
			layers: [annotationLayer('l-notes', 'Notes'), mapLayer('l-map', 'La Floride')]
		});

		await openRow(0);
		await press(nth('layer-move-down', 0));

		// At the bottom of the stack "Move down" is a disabled button — "this Layer cannot go lower"
		// is information a screen reader gets free from the markup — so the keyboard is handed the
		// other half of the same control rather than the document body. The first test in this file
		// is why that sentence can be asserted here at all.
		expect(one('layer-move-up')).toHaveFocus();
	});

	test('keeps the keyboard on the same button when the move does not reach an end', async () => {
		// Away from the ends, where the button that was pressed is still enabled: the case that is
		// about Svelte moving a keyed node rather than about `disabled`.
		liveStack({
			layers: [
				annotationLayer('l-top', 'Top'),
				annotationLayer('l-middle', 'Middle'),
				mapLayer('l-map', 'La Floride')
			]
		});

		await openRow(0);
		await press(nth('layer-move-down', 0));

		expect(renderedOrder()).toEqual(['l-middle', 'l-top', 'l-map']);
		expect(one('layer-move-down')).toHaveFocus();

		// And it really is operable from there: one more press, no Tab, and the Layer moves again.
		await press(nth('layer-move-down', 0));
		expect(renderedOrder()).toEqual(['l-middle', 'l-map', 'l-top']);
	});
});

describe('a Layer kind this build has never heard of (ADR-0014)', () => {
	/**
	 * ⚠ **What is asserted here is the row, never the file.** That such a Layer is read out of
	 * `project.json`, skipped at the render boundary rather than throwing, and **written back with
	 * every field it arrived with** is `e2e/editor-layers.e2e.ts`'s and
	 * `packages/core/src/project/layer.test.ts`'s. A version of the round-trip written here would
	 * round-trip the object literal above.
	 */
	test('is listed, and names the kind it cannot draw rather than pretending', () => {
		stack({
			layers: [foreignLayer('l-cartouche', 'Cartouche'), mapLayer('l-map', 'La Floride')]
		});

		expect(all('layer-row')).toHaveLength(2);
		expect(nth('layer-row', 0)).toHaveAttribute('data-layer-kind', 'foreign');
		// The kind the *file* carried, in the words, rather than only "unknown": a colleague reading
		// this row needs to know which feature of a newer build their Project is carrying.
		expect(nth('layer-kind', 0)).toHaveTextContent('Not shown by this version (image-annotation)');
		expect(nth('layer-name-text', 0)).toHaveTextContent('Cartouche');
	});

	test('opens onto a sentence rather than onto nothing', async () => {
		liveStack({ layers: [foreignLayer('l-cartouche', 'Cartouche')] });
		await openRow(0);

		// A row that opened onto an empty panel would read as contents that failed to load, which is a
		// different and much more alarming state than the true one.
		expect(one('layer-foreign-note')).toHaveTextContent(
			'a kind this version of Ballastella does not understand'
		);
		expect(one('layer-foreign-note')).toHaveTextContent('nothing');

		// And nothing of the two kinds this build *can* draw was rendered into it. The screen's own
		// snippets are markers here — see `LayerListHarness.svelte` — so this is the card declining to
		// ask for them rather than the screen declining to answer.
		expect(one('harness-map-contents')).not.toBeInTheDocument();
		expect(one('harness-annotation-contents')).not.toBeInTheDocument();
		expect(one('layer-opacity')).not.toBeInTheDocument();
	});

	test('can still be moved in the stack and renamed', async () => {
		liveStack({
			layers: [foreignLayer('l-cartouche', 'Cartouche'), mapLayer('l-map', 'La Floride')]
		});
		await openRow(0);

		// The move first, so the rename below is asked of a card that has just been moved — which is
		// the order the end-to-end test drives, and the order in which a keyed node has already moved.
		await press(nth('layer-move-down', 0));
		expect(renderedOrder()).toEqual(['l-map', 'l-cartouche']);

		// One rename button on the screen, because one card is open: the foreign one, which followed
		// its Layer down.
		await press(nth('layer-rename', 0));
		expect(one('layer-name')).toHaveValue('Cartouche');
	});
});

describe('what the screen supplies is drawn only where the card asks for it', () => {
	// ⚠ **Whose claim this is.** `problemAction`, `mapContents` and `annotationContents` are snippets
	// the Project screen passes in, so there are two claims in every sentence about them and they
	// belong at different seams. *Whether and where the card renders one* is `LayerList`'s and is
	// asserted here, against markers the harness supplies. *What goes inside* — the Align link, its
	// `(directory, layer id)` href, and which of the three refusals is answerable by aligning — is
	// `ProjectScreen`'s, is not derivable from anything this component is handed, and stays in
	// `e2e/editor-layers.e2e.ts`.

	test('draws the problem action beside the sentence of a Layer that was refused', () => {
		liveStack({
			layers: [mapLayer('l-map', 'La Floride')],
			outcomes: { 'l-map': { status: 'refused', reason: NOT_ALIGNED } }
		});

		// Still closed: the whole point of an action here is that the warning a user can notice without
		// opening anything can also be acted on without opening anything.
		expect(disclosure(0)).toHaveAttribute('aria-expanded', 'false');
		expect(one('layer-problem')).toHaveTextContent(NOT_ALIGNED);
		expect(one('harness-problem-action')).toHaveAttribute('data-layer-id', 'l-map');
	});

	test('draws no problem action for a Layer that drew', () => {
		liveStack({
			layers: [mapLayer('l-map', 'La Floride')],
			outcomes: { 'l-map': { status: 'drawn' } }
		});

		// The closed row is the one place on the screen where an action could appear for every Layer in
		// the stack at once, which would be four buttons competing with sentences they no longer answer.
		expect(one('layer-problem')).not.toBeInTheDocument();
		expect(one('harness-problem-action')).not.toBeInTheDocument();
	});

	test('draws no problem action for a Layer it was told nothing about', () => {
		liveStack({ layers: [mapLayer('l-map', 'La Floride')] });

		// The state every Layer is in before the first render of the stack has come back, and the one
		// an implementation that keyed the band off the Layer rather than off the outcome gets wrong.
		expect(one('harness-problem-action')).not.toBeInTheDocument();
	});

	test('draws each kind’s contents in its own open card and in no other', async () => {
		liveStack({
			layers: [annotationLayer('l-notes', 'Notes'), mapLayer('l-map', 'La Floride')]
		});

		// Nothing is open, so nothing has been asked for — which is what makes every other spec's
		// "open the row first" a step the user really takes rather than a formality.
		expect(all('harness-map-contents')).toHaveLength(0);
		expect(all('harness-annotation-contents')).toHaveLength(0);

		await openRow(1);
		expect(one('harness-map-contents')).toHaveAttribute('data-layer-id', 'l-map');
		expect(all('harness-annotation-contents')).toHaveLength(0);

		// ⚠ **Each kind asserted while its own card is open**, for the reason the opacity spec above
		// gives: the disclosure is an accordion, so a version that opened the map card and then found no
		// annotation contents would be reporting that the other row was *collapsed*.
		await openRow(0);
		expect(all('harness-annotation-contents')).toHaveLength(1);
		expect(all('harness-map-contents')).toHaveLength(0);
	});
});
