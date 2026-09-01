// What the Annotation Inspector's Style face offers, asserted against the component rather than
// against the application.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS ASSERTED HERE, AND WHAT DELIBERATELY IS NOT
//
// Which controls a geometry gets, what the nine swatches are called and which of them wears a tick.
// Every one of those was once reached by booting the editor and drawing a pin on a real MapLibre
// canvas — four seconds of application to count nine radios.
//
// ⚠ **What stays in `e2e/` is everything this face cannot answer alone.** That the nine swatches sit
// on one line inside the Inspector is layout, and there is no layout here (`vitest.config.ts` records
// the probe). That choosing purple writes `marker-color: #7b1fa2` into the Layer's file is storage.
// That a recolour does not rebuild the MapLibre stack is MapLibre's. And the *wiring* — that this face
// is really rendered behind the Inspector's Style tab, really handed the selected Annotation, and
// really writes — is asserted there too, deliberately: a Seam 2 test and a test here asserting the
// same sentence are not duplicates, because this one is handed its props by the test and so cannot
// fail for a wiring reason at all.
//
// **That the face is behind a tab at all, and that an undrawable geometry is offered no tab, are
// `AnnotationInspector`'s** and are asserted in `packages/ui/src/annotation-inspector.dom.test.ts`
// against the snippet being withheld. Nothing here knows it is in a tab.

import { ANNOTATION_COLORS, type AnnotationGeometry } from '@ballastella/core';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import AnnotationStyleFaceHarness from './AnnotationStyleFaceHarness.svelte';

const POINT = { type: 'Point', coordinates: [0, 0] } as unknown as AnnotationGeometry;
const LINE = { type: 'LineString', coordinates: [[0, 0]] } as unknown as AnnotationGeometry;
const POLYGON = { type: 'Polygon', coordinates: [[[0, 0]]] } as unknown as AnnotationGeometry;

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

const editor = (props: ComponentProps<typeof AnnotationStyleFaceHarness>): void => {
	mounted = mount(AnnotationStyleFaceHarness, { target: document.body, props });
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

describe('a geometry is offered the controls it has and no others', () => {
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

	test('an unset pin size reports what the renderer draws rather than a blank', () => {
		// The renderer coalesces an absent `marker-size` to medium, so a control showing nothing chosen
		// would be telling a scholar something untrue about the map in front of them.
		editor({ geometry: POINT });

		const checked = ['small', 'medium', 'large'].filter(
			(size) => one(`annotation-marker-size-${size}`)!.querySelector('input')!.checked
		);
		expect(checked).toEqual(['medium']);
	});

	test('the style face gives a Label its text, background, and shared size controls, with no pin or line controls', async () => {
		const styled = vi.fn();
		const committed = vi.fn();
		editor({
			geometry: POINT,
			properties: { 'marker-symbol': 'label' },
			onstyle: styled,
			oncommit: committed
		});

		const legends = [...document.querySelectorAll('legend')].map(
			(legend) => legend.textContent ?? ''
		);
		expect(legends).toContain('Label');
		expect(legends.some((text) => text.includes('Pin'))).toBe(false);
		expect(all('annotation-marker-color')).toHaveLength(1);
		expect(all('annotation-fill')).toHaveLength(1);
		expect(all('annotation-fill-opacity')).toHaveLength(1);
		expect(all('annotation-marker-size-large')).toHaveLength(1);
		expect(all('annotation-stroke')).toHaveLength(0);
		expect(all('annotation-stroke-width')).toHaveLength(0);
		expect(all('annotation-stroke-opacity')).toHaveLength(0);
		expect(all('annotation-line-style-dashed')).toHaveLength(0);
		expect(
			one('annotation-marker-color')!.parentElement!.querySelector('legend')
		).toHaveTextContent('Label text colour');
		expect(one('annotation-fill')!.parentElement!.querySelector('legend')).toHaveTextContent(
			'Label background colour'
		);
		const controlsInOrder = [...document.querySelectorAll<HTMLElement>('[data-testid]')]
			.map((element) => element.dataset.testid)
			.filter((testid) =>
				[
					'annotation-marker-color',
					'annotation-fill',
					'annotation-fill-opacity',
					'annotation-marker-size-large'
				].includes(testid ?? '')
			);
		expect(controlsInOrder).toEqual([
			'annotation-marker-color',
			'annotation-fill',
			'annotation-fill-opacity',
			'annotation-marker-size-large'
		]);

		await press(one('annotation-marker-color-purple')!.querySelector('input')!);
		await press(one('annotation-fill-blue')!.querySelector('input')!);
		await press(one('annotation-marker-size-large')!.querySelector('input')!);
		const opacity = one('annotation-fill-opacity') as HTMLInputElement;
		opacity.value = '0.4';
		opacity.dispatchEvent(new Event('input', { bubbles: true }));
		opacity.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();

		expect(styled).toHaveBeenCalledWith({ 'marker-color': '#7b1fa2' }, undefined);
		expect(styled).toHaveBeenCalledWith({ fill: '#1976d2' }, undefined);
		expect(styled).toHaveBeenCalledWith({ 'marker-size': 'large' }, undefined);
		expect(styled).toHaveBeenCalledWith({ 'fill-opacity': 0.4 }, { debounce: true });
		expect(committed).toHaveBeenCalledTimes(3);
	});
});

describe('an Annotation may be one of nine colours and no other', () => {
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

	test('offers applying the effective style to the whole Layer', async () => {
		const apply = vi.fn();
		editor({ geometry: POINT, onapplytoall: apply });

		await press(one('annotation-apply-style-to-layer')!);

		expect(apply).toHaveBeenCalledOnce();
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
