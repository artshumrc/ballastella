// What one Annotation's panel offers, asserted against the component rather than against the
// application.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT MOVED HERE FROM `e2e/editor-annotations.e2e.ts`, AND WHAT DELIBERATELY DID NOT
//
// Which controls a geometry gets, what the nine swatches are called and which of them wears a tick,
// and whether the text fields survive a sentence being typed. Every one of those was reached by
// booting the editor and drawing a pin on a real MapLibre canvas — four seconds of application to
// count nine radios.
//
// ⚠ **What stays in `e2e/` is everything the panel cannot answer alone.** That the nine swatches sit
// on one line inside the sidebar is layout, and there is no layout here (`vitest.config.ts` records
// the probe). That choosing purple writes `marker-color: #7b1fa2` into the Layer's file is storage.
// That a recolour does not rebuild the MapLibre stack is MapLibre's. And the *wiring* — that this
// panel is really mounted, really handed the selected Annotation, and really writes — is asserted
// there too, deliberately: a Seam 2 test and a test here asserting the same sentence are not
// duplicates, because this one is handed its props by the test and so cannot fail for a wiring
// reason at all.

import { ANNOTATION_COLORS, type AnnotationGeometry } from '@ballastella/core';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import AnnotationEditorHarness from './AnnotationEditorHarness.svelte';

const POINT = { type: 'Point', coordinates: [0, 0] } as unknown as AnnotationGeometry;
const LINE = { type: 'LineString', coordinates: [[0, 0]] } as unknown as AnnotationGeometry;
const POLYGON = { type: 'Polygon', coordinates: [[[0, 0]]] } as unknown as AnnotationGeometry;

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

const editor = (props: ComponentProps<typeof AnnotationEditorHarness>): void => {
	mounted = mount(AnnotationEditorHarness, { target: document.body, props });
	flushSync();
};

const all = (testId: string): HTMLElement[] => [
	...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)
];

const one = (testId: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

const settle = async (): Promise<void> => {
	await tick();
	await tick();
};

const press = async (element: HTMLElement): Promise<void> => {
	element.focus();
	element.click();
	await settle();
};

/** Type one character into a field the way a keyboard does: append, then fire `input`. */
const typeInto = async (field: HTMLInputElement | HTMLTextAreaElement, text: string) => {
	for (const character of text) {
		field.value += character;
		field.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
	}
};

describe('a geometry is offered the controls it has and no others (SPEC stories 63, 64, 65)', () => {
	// The union doing its job in the interface: there is no fill on a pin, so there is no control for
	// one — absent rather than present and empty, which is the distinction each count is about.
	test('a pin has marker controls and neither a line nor a fill', () => {
		editor({ geometry: POINT });

		expect(all('annotation-marker-color')).toHaveLength(1);
		expect(all('annotation-marker-size-large')).toHaveLength(1);
		expect(all('annotation-fill')).toHaveLength(0);
		expect(all('annotation-fill-opacity')).toHaveLength(0);
		expect(all('annotation-stroke')).toHaveLength(0);
		expect(all('annotation-stroke-width')).toHaveLength(0);
		expect(all('annotation-line-style-dashed')).toHaveLength(0);
	});

	test('a line has the line group and no pin and no fill', () => {
		editor({ geometry: LINE });

		expect(all('annotation-stroke')).toHaveLength(1);
		expect(all('annotation-stroke-width')).toHaveLength(1);
		expect(all('annotation-line-style-dashed')).toHaveLength(1);
		expect(all('annotation-marker-color')).toHaveLength(0);
		expect(all('annotation-fill')).toHaveLength(0);
	});

	test('a shape has the area and the edge around it, in that order', () => {
		editor({ geometry: POLYGON });

		expect(all('annotation-fill')).toHaveLength(1);
		expect(all('annotation-stroke')).toHaveLength(1);
		expect(all('annotation-marker-color')).toHaveLength(0);
		// Fill before Line, which is the order every drawing tool uses: the area first, then its edge.
		const order = [...document.querySelectorAll('legend')].map((legend) => legend.textContent);
		expect(order.indexOf('Fill')).toBeLessThan(order.indexOf('Line'));
	});

	test('a shape this version cannot draw says so instead of offering nothing', () => {
		// A foreign document may carry a GeometryCollection. Its title and description are still the
		// scholar's to edit and the shape is written back untouched, so an empty style panel with no
		// explanation would read as a bug rather than as the honest answer.
		editor({ geometry: null });

		expect(one('annotation-not-drawable')).toBeInTheDocument();
		expect(all('annotation-marker-color')).toHaveLength(0);
		// The text is still there to edit, which is the half that is not refused.
		expect(one('annotation-edit-text')).toBeInTheDocument();
	});

	test('an unset pin size reports what the renderer draws rather than a blank', () => {
		// The renderer coalesces an absent `marker-size` to medium, so a control showing nothing chosen
		// would be telling a scholar something untrue about the map in front of them.
		editor({ geometry: POINT });

		const checked = ['small', 'medium', 'large'].filter(
			(size) => one(`annotation-marker-size-${size}`)!.querySelector('input')!.checked
		);
		expect(checked).toEqual(['medium']);
	});
});

describe('an Annotation may be one of nine colours and no other (SPEC story 111)', () => {
	test('nine swatches, each a real radio and each named in words', () => {
		editor({ geometry: POINT });

		const swatches = one('annotation-marker-color')!.querySelectorAll('input[type=radio]');
		// The count *and* the element: a row of nine `<div>`s that looked identical would pass a count
		// and be unreachable from a keyboard.
		expect(swatches).toHaveLength(ANNOTATION_COLORS.length);
		expect(swatches).toHaveLength(9);

		for (const colour of ANNOTATION_COLORS) {
			const swatch = one(`annotation-marker-color-${colour.name.toLowerCase()}`)!;
			// Named, so the accessible name is "Red" rather than "option 4" — the channel that survives
			// a monochrome screen and the one that makes a row of coloured squares legal at all.
			expect(swatch.querySelector('input')).toHaveAccessibleName(colour.name);
			// `toHaveValue` refuses a radio, so the attribute is read directly: what a swatch *submits* is
			// the hex the file will carry, and a row of correctly named radios all worth the same colour
			// would pass every other assertion here.
			expect(swatch.querySelector('input')).toHaveAttribute('value', colour.value);
		}
	});

	test('the chosen one wears a tick, and the tick is legible against it', async () => {
		// A contrast fact rather than a taste one: a white tick carries 1.7:1 on Yellow and 1.0:1 on
		// White, against the 3:1 a graphical object needs. `ColorPicker.svelte` records all nine ratios.
		// **Asserted on the attribute the component computes, not on a rendered colour** — there is no
		// paint here, and the measurement of what the *page* draws stays in `e2e/`.
		for (const [name, ink] of [
			['black', '#ffffff'],
			['blue', '#ffffff'],
			['green', '#ffffff'],
			['orange', '#ffffff'],
			['white', '#000000'],
			['yellow', '#000000']
		] as const) {
			editor({ geometry: POINT });
			const swatch = one(`annotation-marker-color-${name}`)!;
			await press(swatch.querySelector('input')!);

			expect(one(`annotation-marker-color-${name}`)).toHaveAttribute('data-chosen', 'true');
			expect(one(`annotation-marker-color-${name}`)!.querySelector('[data-ink]')) //
				.toHaveAttribute('data-ink', ink);
			// One tick in the row, so the mark moves rather than accumulating.
			expect(one('annotation-marker-color')!.querySelectorAll('[data-ink]')).toHaveLength(1);

			unmount(mounted!);
			mounted = undefined;
			document.body.innerHTML = '';
		}
	});

	test('the choice is said in words as well as drawn', async () => {
		editor({ geometry: POINT });

		await press(one('annotation-marker-color-purple')!.querySelector('input')!);

		expect(one('annotation-marker-color-chosen')).toHaveTextContent('Purple');
		// Announced, because choosing a swatch changes text the keyboard has just moved past.
		expect(one('annotation-marker-color-chosen')).toHaveAttribute('aria-live', 'polite');
	});

	test('choosing a colour reports the simplestyle name and commits it at once', async () => {
		// Not debounced, unlike the colour well this replaced: a swatch is one deliberate choice rather
		// than a drag around a colour wheel. What reaches the *file* is `e2e/`'s and the writer's.
		const styled = vi.fn();
		const committed = vi.fn();
		editor({ geometry: POINT, onstyle: styled, oncommit: committed });

		await press(one('annotation-marker-color-purple')!.querySelector('input')!);

		expect(styled).toHaveBeenCalledWith({ 'marker-color': '#7b1fa2' }, undefined);
		expect(committed).toHaveBeenCalled();
	});

	test('a colour from outside the palette is reported, not rounded to the nearest of the nine', async () => {
		// simplestyle allows any `#RRGGBB` and ADR-0009 validates the format rather than the value, so a
		// file from QGIS can carry one. Rounding it would silently rewrite a scholar's map.
		editor({ geometry: POINT, properties: { 'marker-color': '#123456' } });
		await settle();

		expect(one('annotation-marker-color-chosen')).toHaveTextContent('not one of the nine');
		expect(one('annotation-marker-color-current')).toHaveAttribute('data-colour', '#123456');
		// A `<span>` rather than a tenth radio: it is not a choice, so it is not a tab stop and not an
		// option a screen reader lists.
		expect(one('annotation-marker-color')!.querySelectorAll('input[type=radio]')).toHaveLength(9);

		// And choosing one of the nine replaces it, so the state is escapable rather than sticky.
		await press(one('annotation-marker-color-green')!.querySelector('input')!);
		expect(one('annotation-marker-color-current')).not.toBeInTheDocument();
	});

	test('a colour spelled in upper case is the same colour', () => {
		// A file may say `#FFFFFF` and a swatch never does, so a picker comparing raw strings would
		// report a scholar's plain white as a tenth colour.
		editor({ geometry: POINT, properties: { 'marker-color': '#FFFFFF' } });

		expect(one('annotation-marker-color-chosen')).toHaveTextContent('White');
		expect(one('annotation-marker-color-white')).toHaveAttribute('data-chosen', 'true');
	});
});

describe('the title and description are text until somebody asks to change them', () => {
	test('the pencil turns them into fields and hands over the keyboard', async () => {
		editor({ geometry: POINT, properties: { title: 'Warehouses' } });

		expect(one('annotation-title-text')).toHaveTextContent('Warehouses');
		expect(all('annotation-title')).toHaveLength(0);

		await press(one('annotation-edit-text')!);

		expect(one('annotation-title')).toHaveValue('Warehouses');
		expect(one('annotation-description')).toBeInTheDocument();
		expect(one('annotation-title')).toHaveFocus();
	});

	test('typing a whole sentence does not shut the fields', async () => {
		// ⚠ **The regression this is here for, and the reason the harness rebuilds the Annotation.**
		// The panel resets its editing state when *a different Annotation arrives*, and `annotation` is
		// a fresh object after every save — which is after every keystroke. Written as an effect that
		// merely read `annotation.id`, that reset fired on each character, and a scholar could type
		// exactly one letter before the fields turned back into text.
		editor({ geometry: POINT });
		await press(one('annotation-edit-text')!);

		const title = one('annotation-title') as HTMLInputElement;
		await typeInto(title, 'Fort Amsterdam');
		// Read fresh off the document rather than through the handle above: had the fields closed and
		// reopened, the old node would still answer with the value it was holding when it left.
		expect(one('annotation-title')).toHaveValue('Fort Amsterdam');

		const description = one('annotation-description') as HTMLTextAreaElement;
		await typeInto(description, 'Built in 1625.');
		expect(one('annotation-description')).toHaveValue('Built in 1625.');
		// Still fields, which is the sentence: a panel that had reverted to text would have no
		// `annotation-title` at all and the assertions above would have failed on a stale node.
		expect(one('annotation-text-done')).toBeInTheDocument();
	});

	test('a different Annotation arriving does close them', async () => {
		// The negative control for the test above, and the behaviour the guard exists to keep: without
		// it, selecting one Annotation while editing another's text opens the second straight into a
		// form nobody asked to edit.
		editor({ geometry: POINT, id: 'a-1' });
		await press(one('annotation-edit-text')!);
		expect(one('annotation-title')).toBeInTheDocument();

		unmount(mounted!);
		mounted = undefined;
		document.body.innerHTML = '';

		// A second panel for a second Annotation is what the screen does with a new selection — the
		// same component, told about a different id.
		editor({ geometry: POINT, id: 'a-2' });
		expect(all('annotation-title')).toHaveLength(0);
		expect(one('annotation-title-text')).toBeInTheDocument();
	});

	test('Done puts them back to text, committing what was typed', async () => {
		const committed = vi.fn();
		editor({ geometry: POINT, oncommit: committed });
		await press(one('annotation-edit-text')!);
		await typeInto(one('annotation-title') as HTMLInputElement, 'Warehouses');

		await press(one('annotation-text-done')!);

		expect(committed).toHaveBeenCalled();
		expect(all('annotation-title')).toHaveLength(0);
		expect(one('annotation-title-text')).toHaveTextContent('Warehouses');
	});

	test('an Annotation with no title says so rather than showing an empty line', () => {
		editor({ geometry: POINT });

		expect(one('annotation-title-text')).toHaveTextContent('Untitled');
		expect(one('annotation-description-text')).toHaveTextContent('No description yet.');
	});
});
