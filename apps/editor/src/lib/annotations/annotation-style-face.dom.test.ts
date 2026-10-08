import { ANNOTATION_COLORS, type AnnotationGeometry } from '@ballastella/core';
import { type ComponentProps } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { all, one, settle, show, takeDown } from '$lib/test-support/dom';

import AnnotationStyleFaceHarness from './AnnotationStyleFaceHarness.svelte';

const POINT = { type: 'Point', coordinates: [0, 0] } as unknown as AnnotationGeometry;
const LINE = { type: 'LineString', coordinates: [[0, 0]] } as unknown as AnnotationGeometry;
const POLYGON = { type: 'Polygon', coordinates: [[[0, 0]]] } as unknown as AnnotationGeometry;
afterEach(takeDown);

const editor = (props: ComponentProps<typeof AnnotationStyleFaceHarness>): void =>
	show(AnnotationStyleFaceHarness, props);

const press = async (element: HTMLElement): Promise<void> => {
	element.focus();
	element.click();
	await settle();
};

describe('a geometry is offered the controls it has and no others', () => {
	test('a pin has marker controls and neither a line nor a fill', () => {
		editor({ geometry: POINT });
		expect(all('annotation-marker-color')).toHaveLength(1);
		expect(all('annotation-marker-size-large')).toHaveLength(1);
		expect(all('annotation-fill')).toHaveLength(0);
		expect(all('annotation-fill-opacity')).toHaveLength(0);
		expect(all('annotation-stroke')).toHaveLength(0);
		expect(all('annotation-stroke-width')).toHaveLength(0);
		expect(all('annotation-line-style-dashed')).toHaveLength(0);

		const checked = ['small', 'medium', 'large'].filter(
			(size) => one(`annotation-marker-size-${size}`)!.querySelector('input')!.checked
		);
		expect(checked, 'an unset size reports what the renderer draws').toEqual(['medium']);
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
		const order = [...document.querySelectorAll('legend')].map((legend) => legend.textContent);
		expect(order.indexOf('Fill')).toBeLessThan(order.indexOf('Line'));
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
		expect(swatches).toHaveLength(ANNOTATION_COLORS.length);
		expect(swatches).toHaveLength(9);

		for (const colour of ANNOTATION_COLORS) {
			const swatch = one(`annotation-marker-color-${colour.name.toLowerCase()}`)!;
			expect(swatch.querySelector('input')).toHaveAccessibleName(colour.name);
			expect(swatch.querySelector('input')).toHaveAttribute('value', colour.value);
		}
	});

	test('the chosen one wears a tick, and the tick is legible against it', async () => {
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
			expect(one(`annotation-marker-color-${name}`)!.querySelector('[data-ink]')).toHaveAttribute(
				'data-ink',
				ink
			);
			expect(one('annotation-marker-color')!.querySelectorAll('[data-ink]')).toHaveLength(1);
			takeDown();
		}
	});

	test('choosing a colour says it in words, reports the simplestyle name and commits it at once', async () => {
		const styled = vi.fn();
		const committed = vi.fn();
		editor({ geometry: POINT, onstyle: styled, oncommit: committed });

		await press(one('annotation-marker-color-purple')!.querySelector('input')!);

		expect(one('annotation-marker-color-chosen')).toHaveTextContent('Purple');
		expect(one('annotation-marker-color-chosen')).toHaveAttribute('aria-live', 'polite');
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
		editor({ geometry: POINT, properties: { 'marker-color': '#123456' } });
		await settle();

		expect(one('annotation-marker-color-chosen')).toHaveTextContent('not one of the nine');
		expect(one('annotation-marker-color-current')).toHaveAttribute('data-colour', '#123456');
		expect(one('annotation-marker-color')!.querySelectorAll('input[type=radio]')).toHaveLength(9);

		await press(one('annotation-marker-color-green')!.querySelector('input')!);
		expect(one('annotation-marker-color-current')).not.toBeInTheDocument();
	});

	test('a colour spelled in upper case is the same colour', () => {
		editor({ geometry: POINT, properties: { 'marker-color': '#FFFFFF' } });
		expect(one('annotation-marker-color-chosen')).toHaveTextContent('White');
		expect(one('annotation-marker-color-white')).toHaveAttribute('data-chosen', 'true');
	});
});
