import type { Layer, MapLayer } from '@ballastella/core';
// `@ballastella/core/render` rather than the barrel: everything under `src/render/` is browser-only and the barrel is not, which the barrel's own note explains.
import type { DrawnOutcome } from '@ballastella/core/render';
import { createRawSnippet, flushSync, mount, tick, unmount, type Snippet } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { KIND_STYLE } from './layer-kind-style.js';
import LayerList from './LayerList.svelte';
import LayerListHarness from './LayerListHarness.svelte';

const NOT_ALIGNED = 'Not aligned yet, so there is nothing to draw.';
const REFUSED: DrawnOutcome = { status: 'refused', reason: NOT_ALIGNED };

const mapLayer = (id: string, name: string): Layer => ({
	kind: 'map',
	id,
	name,
	visible: true,
	order: 0,
	opacity: 1,
	imageId: `image-${id}`
});

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

const MAP = (): Layer => mapLayer('l-map', 'La Floride');
const NOTES = (): Layer => annotationLayer('l-notes', 'Notes');

/** The document survives from test to test in one file, so a component left mounted would be found by the next test's `querySelectorAll` and counted — which turns "there is one open card" into a claim… */
let mounted: Record<string, unknown> | undefined;

const takeDown = (): void => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
};

afterEach(takeDown);

const shown = (component: Record<string, unknown>): void => {
	mounted = component;
	flushSync();
};

type Stack = {
	layers: readonly Layer[];
	outcomes?: Readonly<Record<string, DrawnOutcome>>;
	openLayerId?: string | null;
};

const liveStack = (options: Stack & { onmove?: (id: string, toIndex: number) => void }): void =>
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

type OptionalProps = {
	onopen?: (id: string | null) => void;
	ontypename?: (id: string, name: string) => void;
	oncommit?: () => void;
	onshow?: (id: string, visible: boolean) => void;
	ondragopacity?: (id: string, opacity: number) => void;
	onmove?: (id: string, toIndex: number) => void;
	ondelete?: (id: string) => void;
	noLayersGuidance?: Snippet;
	foreignLayerNote?: Snippet;
	mapContents?: Snippet<[MapLayer]>;
	annotationContents?: Snippet<[]>;
	problemAction?: Snippet<[Layer]>;
};

const offering = (optional: OptionalProps, options: Stack): void =>
	shown(
		mount(LayerList, {
			target: document.body,
			props: {
				layers: options.layers,
				outcomes: options.outcomes ?? {},
				openLayerId: options.openLayerId ?? null,
				onopen: vi.fn(),
				...optional
			}
		})
	);

const editorProps = () => ({
	ontypename: vi.fn(),
	oncommit: vi.fn(),
	onshow: vi.fn(),
	ondragopacity: vi.fn(),
	onmove: vi.fn(),
	ondelete: vi.fn()
});

const viewerProps = (): OptionalProps => ({ onshow: vi.fn(), ondragopacity: vi.fn() });

const stack = (options: Stack): void => offering(editorProps(), options);

const marker = <Args extends unknown[]>(testId: string): Snippet<Args> =>
	createRawSnippet<Args>(() => ({ render: () => `<span data-testid="${testId}"></span>` }));

const all = (testId: string): HTMLElement[] => [
	...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)
];

const one = (testId: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

const nth = (testId: string, at: number): HTMLElement => {
	const found = all(testId)[at];
	if (!found) throw new Error(`no [data-testid="${testId}"] at position ${at}`);
	return found;
};

const disclosure = (at: number) => nth('layer-disclosure', at);

/** Two ticks rather than one: the first lets the reorder reach the DOM, the second lets the focus restoration that runs *after* that reorder happen. */
const settle = async (): Promise<void> => {
	await tick();
	await tick();
};

/** `moveByButton` refuses to move the keyboard if something other than the button that was pressed holds it, so a bare `click()` — which moves focus nowhere in a DOM implementation, and would in a… */
const press = async (element: HTMLElement): Promise<void> => {
	element.focus();
	element.click();
	await settle();
};

const openRow = async (at: number): Promise<void> => {
	await press(disclosure(at));
	expect(disclosure(at)).toHaveAttribute('aria-expanded', 'true');
};

const renderedOrder = (): (string | null)[] =>
	all('layer-row').map((row) => row.getAttribute('data-layer-id'));

describe('the DOM implementation this seam trusts', () => {
	test('refuses to focus a disabled control, as a browser does', async () => {
		liveStack({ layers: [NOTES(), MAP()] });
		await openRow(0);

		const up = nth('layer-move-up', 0) as HTMLButtonElement;
		expect(up.disabled).toBe(true);
		const before = document.activeElement;
		up.focus();
		expect(document.activeElement).toBe(before);
		expect(up).not.toHaveFocus();
	});
});

describe('a closed row stays useful', () => {
	test.each<[string, Record<string, DrawnOutcome>, boolean]>([
		[
			'says what is wrong with a refused Layer as text, beside the screen’s action',
			{ 'l-map': REFUSED },
			true
		],
		[
			'says nothing, and offers no action, for a Layer that drew',
			{ 'l-map': { status: 'drawn' } },
			false
		],
		['says nothing for an outcome given for no Layer in the stack', { 'l-gone': REFUSED }, false],
		['says nothing for a Layer it was told nothing about', {}, false]
	])('%s', (_, outcomes, refused) => {
		liveStack({ layers: [MAP()], outcomes });

		expect(disclosure(0)).toHaveAttribute('aria-expanded', 'false');
		expect(one('layer-name-text')).toHaveTextContent('La Floride');
		if (refused) {
			expect(one('layer-problem')).toHaveTextContent(NOT_ALIGNED);
			expect(one('harness-problem-action')).toHaveAttribute('data-layer-id', 'l-map');
		} else {
			expect(one('layer-problem')).not.toBeInTheDocument();
			expect(one('harness-problem-action')).not.toBeInTheDocument();
		}
	});
});

describe('one Layer is open at a time', () => {
	test.each([
		['l-map', 1, ['true', 'false']],
		[null, 0, ['false', 'false']]
	])(
		'with %s open renders the contents of that Layer and of no other',
		(openLayerId, count, expanded) => {
			stack({ layers: [MAP(), NOTES()], openLayerId });

			// **Counted as well as attributed.** `aria-expanded` is the promise made to a screen reader and the count is the promise made to the eye; an implementation that rendered both and hid one with CSS would satisfy only the…
			expect(all('layer-contents')).toHaveLength(count);
			expect(all('layer-row')).toHaveLength(2);
			expect([0, 1].map((at) => disclosure(at).getAttribute('aria-expanded'))).toEqual(expanded);
		}
	);

	test('asks the screen to open a row rather than opening it itself', async () => {
		const onopen = vi.fn();
		offering({ ...editorProps(), onopen }, { layers: [MAP()] });

		await press(disclosure(0));

		expect(onopen).toHaveBeenCalledWith('l-map');
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

describe('the list reaches assistive technology', () => {
	test('is an ordered list whose structure and order come from the markup', () => {
		liveStack({ layers: [NOTES(), MAP()] });

		const list = document.querySelector('ol');
		expect(list).toHaveAccessibleName('Layers, top first');
		expect(list?.querySelectorAll(':scope > li')).toHaveLength(2);
	});

	test('each name field says where in the stack its Layer is', async () => {
		liveStack({ layers: [NOTES(), MAP()] });

		await openRow(0);
		await press(nth('layer-rename', 0));
		expect(one('layer-name')).toHaveAccessibleName('Name of Layer 1 of 2');

		await openRow(1);
		await press(nth('layer-rename', 0));
		expect(one('layer-name')).toHaveAccessibleName('Name of Layer 2 of 2');
	});
});

describe('reordering leaves the keyboard where it can move again', () => {
	test('moves a Layer down, announces where it went, and hands the keyboard the other half of the control at the end', async () => {
		const moves: [string, number][] = [];
		liveStack({ layers: [NOTES(), MAP()], onmove: (id, toIndex) => moves.push([id, toIndex]) });

		await openRow(0);
		await press(nth('layer-move-down', 0));

		expect(moves).toEqual([['l-notes', 1]]);
		expect(renderedOrder()).toEqual(['l-map', 'l-notes']);
		expect(one('layer-move-status')).toHaveTextContent('moved to 2 of 2');
		// At the bottom of the stack "Move down" is a disabled button — "this Layer cannot go lower" is information a screen reader gets free from the markup — so the keyboard is handed the other half of the same control rather…
		expect(one('layer-move-up')).toHaveFocus();
	});

	test('keeps the keyboard on the same button when the move does not reach an end', async () => {
		liveStack({
			layers: [annotationLayer('l-top', 'Top'), annotationLayer('l-middle', 'Middle'), MAP()]
		});

		await openRow(0);
		await press(nth('layer-move-down', 0));

		expect(renderedOrder()).toEqual(['l-middle', 'l-top', 'l-map']);
		expect(one('layer-move-down')).toHaveFocus();

		await press(nth('layer-move-down', 0));
		expect(renderedOrder()).toEqual(['l-middle', 'l-map', 'l-top']);
	});
});

describe('a Layer kind this build has never heard of (ADR-0014)', () => {
	/** ⚠ **What is asserted here is the row, never the file.** That such a Layer is read out of `project.json`, skipped at the render boundary rather than throwing, and **written back with every field it… */
	test('is listed, and names the kind it cannot draw rather than pretending', () => {
		stack({ layers: [foreignLayer('l-cartouche', 'Cartouche'), MAP()] });

		expect(all('layer-row')).toHaveLength(2);
		expect(nth('layer-row', 0)).toHaveAttribute('data-layer-kind', 'foreign');
		expect(nth('layer-kind', 0)).toHaveTextContent('Not shown by this version (image-annotation)');
		expect(nth('layer-name-text', 0)).toHaveTextContent('Cartouche');
	});

	test('opens onto a sentence rather than onto nothing, and can still be moved and renamed', async () => {
		liveStack({ layers: [foreignLayer('l-cartouche', 'Cartouche'), MAP()] });
		await openRow(0);

		expect(one('layer-foreign-note')).toHaveTextContent(
			'a kind this version of Ballastella does not understand'
		);
		expect(one('layer-foreign-note')).toHaveTextContent('nothing');
		expect(one('harness-map-contents')).not.toBeInTheDocument();
		expect(one('harness-annotation-contents')).not.toBeInTheDocument();
		expect(one('layer-opacity')).not.toBeInTheDocument();

		await press(nth('layer-move-down', 0));
		expect(renderedOrder()).toEqual(['l-map', 'l-cartouche']);

		await press(nth('layer-rename', 0));
		expect(one('layer-name')).toHaveValue('Cartouche');
	});
});

describe('what the screen supplies is drawn only where the card asks for it', () => {
	test('draws each kind’s contents and opacity in its own open card and in no other', async () => {
		liveStack({ layers: [NOTES(), MAP()] });

		expect(all('harness-map-contents')).toHaveLength(0);
		expect(all('harness-annotation-contents')).toHaveLength(0);

		await openRow(1);
		expect(one('harness-map-contents')).toHaveAttribute('data-layer-id', 'l-map');
		expect(all('harness-annotation-contents')).toHaveLength(0);
		expect(all('layer-opacity')).toHaveLength(1);

		await openRow(0);
		expect(all('harness-annotation-contents')).toHaveLength(1);
		expect(all('harness-map-contents')).toHaveLength(0);
		expect(all('layer-opacity')).toHaveLength(0);
	});
});

describe('a control the consumer does not ask for is not there', () => {
	const openMap = { layers: [MAP()], openLayerId: 'l-map' };

	test('offers the rename pencil, and the name as a field, only with ontypename and oncommit', async () => {
		offering({ ontypename: vi.fn(), oncommit: vi.fn() }, openMap);

		expect(one('layer-rename')).toBeInTheDocument();
		await press(nth('layer-rename', 0));
		expect(one('layer-name')).toHaveValue('La Floride');
		takeDown();
		offering({}, openMap);
		expect(one('layer-rename')).not.toBeInTheDocument();
		expect(one('layer-name')).not.toBeInTheDocument();
		expect(one('layer-name-text')).toHaveTextContent('La Floride');
		takeDown();
		offering({ ontypename: vi.fn() }, openMap);
		expect(one('layer-rename')).not.toBeInTheDocument();
		takeDown();
		offering({ oncommit: vi.fn() }, openMap);
		expect(one('layer-rename')).not.toBeInTheDocument();
	});

	test.each([
		[
			'Move up, Move down and the drag handle',
			'onmove',
			['layer-move-up', 'layer-move-down', 'layer-drag-handle']
		],
		['Delete', 'ondelete', ['layer-delete']],
		['the opacity slider', 'ondragopacity', ['layer-opacity', 'layer-opacity-value']],
		['the visibility toggle', 'onshow', ['layer-visible']]
	] as const)('offers %s only with %s, whatever else it is given', (_, prop, controls) => {
		const { [prop]: given, ...others } = editorProps();
		offering({ [prop]: given }, openMap);
		for (const control of controls) expect(one(control), control).toBeInTheDocument();
		takeDown();
		offering(others, openMap);
		for (const control of controls) expect(one(control), control).not.toBeInTheDocument();
	});

	test('lights a card up as a drop target only with onmove', () => {
		const dragOver = (row: HTMLElement): void => {
			row.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
			flushSync();
		};

		offering({ onmove: vi.fn() }, { layers: [MAP()] });
		expect(nth('layer-row', 0)).toHaveAttribute('data-drop-target', 'false');
		dragOver(nth('layer-row', 0));
		expect(nth('layer-row', 0)).toHaveAttribute('data-drop-target', 'true');
		takeDown();
		offering({}, { layers: [MAP()] });
		dragOver(nth('layer-row', 0));
		expect(nth('layer-row', 0)).toHaveAttribute('data-drop-target', 'false');
	});

	test('drops the row the two share when it would have nothing in it', () => {
		const strip = (): Element | null =>
			document.querySelector('[data-testid="layer-contents"] > div.border-t');

		offering({ ondelete: vi.fn() }, openMap);
		expect(strip()).toBeInTheDocument();
		takeDown();
		offering({}, openMap);
		expect(strip()).not.toBeInTheDocument();
		expect(one('layer-contents')).toBeInTheDocument();
	});

	test('draws a map card’s supplied regions, and leaves out each one it was not given', () => {
		const refused = { ...openMap, outcomes: { 'l-map': REFUSED } };
		offering(
			{
				mapContents: marker<[MapLayer]>('supplied-map-contents'),
				problemAction: marker<[Layer]>('supplied-problem-action')
			},
			refused
		);

		expect(one('supplied-map-contents')).toBeInTheDocument();
		expect(one('supplied-problem-action')).toBeInTheDocument();
		takeDown();
		offering({}, refused);
		expect(one('supplied-map-contents')).not.toBeInTheDocument();
		expect(one('supplied-problem-action')).not.toBeInTheDocument();
		expect(one('layer-problem')).toHaveTextContent(NOT_ALIGNED);
	});

	test('draws an Annotation card’s supplied contents, and leaves them out when not given', () => {
		const openNotes = { layers: [NOTES()], openLayerId: 'l-notes' };

		offering({ annotationContents: marker<[]>('supplied-annotation-contents') }, openNotes);

		expect(one('supplied-annotation-contents')).toBeInTheDocument();
		takeDown();
		offering({}, openNotes);
		expect(one('supplied-annotation-contents')).not.toBeInTheDocument();
		expect(one('layer-kind')).toHaveTextContent('Annotation Layer');
		expect(one('layer-contents')).toBeInTheDocument();
	});
});

describe('the two prop sets a real consumer passes', () => {
	const EDITING = [
		'layer-rename',
		'layer-move-up',
		'layer-move-down',
		'layer-delete',
		'layer-drag-handle'
	];

	test('offers the editor every editing control on the card it opens', () => {
		stack({ layers: [MAP(), NOTES()], openLayerId: 'l-map' });

		for (const control of EDITING) {
			expect(one(control), `${control} in the editor's card`).toBeInTheDocument();
		}
		expect(one('layer-opacity-value')).toHaveTextContent('100%');
	});

	test('offers a Reader the same card with none of them, at the same prop set', () => {
		offering(viewerProps(), { layers: [MAP(), NOTES()], openLayerId: 'l-map' });

		for (const control of EDITING) {
			expect(one(control), `${control} in a Reader's card`).not.toBeInTheDocument();
		}

		expect(one('layer-kind')).toHaveTextContent('Map Image');
		expect(one('layer-name-text')).toHaveTextContent('La Floride');
		expect(one('layer-header')).toBeInTheDocument();
		expect(one('layer-visible')).toBeInTheDocument();
		expect(one('layer-opacity')).toBeInTheDocument();
		expect(all('layer-disclosure')).toHaveLength(2);
	});

	test('tells a Reader an empty Project is empty, and leaves the instructions to the editor', () => {
		offering(
			{ ...editorProps(), noLayersGuidance: marker<[]>('supplied-no-layers-guidance') },
			{ layers: [] }
		);

		expect(one('supplied-no-layers-guidance')).toBeInTheDocument();
		expect(one('no-layers')).not.toHaveTextContent('This Project has no Layers on it.');
		takeDown();
		offering(viewerProps(), { layers: [] });
		expect(one('supplied-no-layers-guidance')).not.toBeInTheDocument();
		expect(one('no-layers')).toHaveTextContent('This Project has no Layers on it.');
	});

	test('tints a shown Layer’s header in its own kind’s colour for a Reader', () => {
		offering(viewerProps(), { layers: [MAP(), NOTES()] });

		// The one property that must not regress is legibility, and `layer-kind-contrast.dom.test.ts` measures that from the rendered colours instead.
		expect(nth('layer-header', 0)).toHaveClass(KIND_STYLE.map.tint);
		expect(nth('layer-header', 1)).toHaveClass(KIND_STYLE.annotation.tint);
		expect(KIND_STYLE.map.tint).not.toEqual(KIND_STYLE.annotation.tint);
		expect(nth('layer-header', 0)).not.toHaveClass(KIND_STYLE.foreign.tint);
		expect(nth('layer-header', 1)).not.toHaveClass(KIND_STYLE.foreign.tint);
	});

	test('tells a Reader a Layer of a kind this build cannot draw is left alone', () => {
		const foreign = {
			layers: [foreignLayer('l-cartouche', 'Cartouche')],
			openLayerId: 'l-cartouche'
		};

		offering(
			{ ...editorProps(), foreignLayerNote: marker<[]>('supplied-foreign-layer-note') },
			foreign
		);

		expect(one('supplied-foreign-layer-note')).toBeInTheDocument();
		takeDown();
		offering(viewerProps(), foreign);
		expect(one('supplied-foreign-layer-note')).not.toBeInTheDocument();
		expect(one('layer-kind')).toHaveTextContent('Not shown by this version (image-annotation)');
		expect(one('layer-foreign-note')).toHaveTextContent(
			'a kind this version of Ballastella does not understand'
		);
		expect(one('layer-foreign-note')).toHaveTextContent('nothing of it is drawn on the map');
		expect(one('layer-foreign-note')).not.toHaveTextContent('rename');
	});

	test('drains a hidden Layer’s card and says "Hidden" for a Reader too', () => {
		offering(viewerProps(), { layers: [{ ...MAP(), visible: false }] });
		expect(one('layer-hidden')).toHaveTextContent('Hidden');
		expect(one('layer-header')).toHaveClass('bg-base-content/5');
	});

	test('says what is wrong with a Reader’s Layer, on the closed card', () => {
		offering(viewerProps(), { layers: [MAP()], outcomes: { 'l-map': REFUSED } });

		// A blank patch of map has its explanation beside it, without opening anything.
		expect(disclosure(0)).toHaveAttribute('aria-expanded', 'false');
		expect(one('layer-problem')).toHaveTextContent(NOT_ALIGNED);
	});
});
