import { TRANSFORMATION_CHOICES, type TransformationType } from '@ballastella/core';
import { flushSync } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { absent, at, press, show, takeDown } from '$lib/test-support/dom';

import TransformationPicker from './TransformationPicker.svelte';

afterEach(takeDown);

const picker = (options: {
	value?: TransformationType;
	controlPointCount: number;
}): ((type: TransformationType) => void) => {
	const onchoose = vi.fn();
	show(TransformationPicker, {
		value: options.value ?? 'polynomial1',
		controlPointCount: options.controlPointCount,
		onchoose
	});
	return onchoose;
};

const select = () => at('transformation-select') as HTMLSelectElement;

const options = () =>
	[...select().options].map((option) => ({
		value: option.value,
		text: option.textContent?.trim() ?? '',
		disabled: option.disabled,
		group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : ''
	}));

const pick = (value: string): void => {
	select().value = value;
	select().dispatchEvent(new Event('change', { bubbles: true }));
	flushSync();
};

const pressAdvanced = (): void => press('transformation-advanced');

describe('the tiers the picker offers (ADR-0013)', () => {
	test('offers four primary types with the guidance as the primary text, and two behind Advanced', () => {
		picker({ controlPointCount: 10 });

		expect(options().map((one) => one.value)).toEqual([
			'helmert',
			'polynomial1',
			'projective',
			'thinPlateSpline'
		]);

		expect(options().map((one) => one.text)).toEqual([
			'Accurate modern maps — rotate, scale, and move only (Simple)',
			'Most printed and scanned maps (Standard)',
			'Maps photographed at an angle (Perspective)',
			'Hand-drawn or geometrically inconsistent maps (Flexible)'
		]);
	});

	test('announces Advanced as a disclosure, and closes it again', () => {
		picker({ controlPointCount: 10 });
		expect(at('transformation-advanced').getAttribute('aria-expanded')).toBe('false');
		pressAdvanced();
		expect(at('transformation-advanced').getAttribute('aria-expanded')).toBe('true');

		expect(options().map((one) => one.value)).toEqual([
			'helmert',
			'polynomial1',
			'projective',
			'thinPlateSpline',
			'polynomial2',
			'polynomial3'
		]);
		expect(options()[4]?.group).toBe('Advanced');
		expect(options()[5]?.group).toBe('Advanced');
		expect(options()[4]?.text).toBe('Only with many well-spread points (Higher-order (2nd))');
		pressAdvanced();
		expect(at('transformation-advanced').getAttribute('aria-expanded')).toBe('false');
		expect(options()).toHaveLength(4);
	});

	test('discloses Advanced unasked when an advanced type is the one selected', () => {
		picker({ value: 'polynomial3', controlPointCount: 10 });
		expect(options().map((one) => one.value)).toContain('polynomial3');
		expect(select().value).toBe('polynomial3');
		expect(absent('transformation-advanced')).toBe(true);
	});
});

describe('the point count gates the type, visibly (ADR-0013)', () => {
	test('disables a type below its minimum and names the shortfall', () => {
		picker({ value: 'helmert', controlPointCount: 2 });
		pressAdvanced();
		const byValue = (value: string) => options().find((one) => one.value === value);
		expect(byValue('helmert')?.disabled, 'Simple needs 2 and there are 2').toBe(false);
		expect(byValue('polynomial1')?.disabled).toBe(true);
		expect(byValue('projective')?.disabled).toBe(true);
		expect(byValue('thinPlateSpline')?.disabled).toBe(true);
		expect(byValue('polynomial2')?.disabled).toBe(true);
		expect(byValue('polynomial3')?.disabled).toBe(true);

		expect(byValue('thinPlateSpline')?.text).toContain(
			'Flexible needs at least 3 Control Points — you have 2'
		);
		expect(byValue('polynomial3')?.text).toContain(
			'Higher-order (3rd) needs at least 10 Control Points — you have 2'
		);

		const listed = at('transformation-shortfalls').textContent ?? '';
		expect(listed).toContain('Flexible needs at least 3 Control Points — you have 2');
		expect(listed).toContain('Perspective needs at least 4 Control Points — you have 2');
		expect(listed).toContain('Higher-order (3rd) needs at least 10 Control Points — you have 2');
	});

	test('drops a shortfall the moment the count reaches the minimum', () => {
		picker({ controlPointCount: 3 });
		const listed = at('transformation-shortfalls').textContent ?? '';
		expect(listed).not.toContain('Flexible needs');
		expect(listed).toContain('Perspective needs at least 4');
		expect(options().find((one) => one.value === 'thinPlateSpline')?.disabled).toBe(false);
		expect(options().find((one) => one.value === 'projective')?.disabled).toBe(true);
	});

	test('refuses to choose a type the count cannot support', () => {
		const onchoose = picker({ value: 'helmert', controlPointCount: 2 });
		pick('thinPlateSpline');
		expect(onchoose).not.toHaveBeenCalled();
		pick('helmert');
		expect(onchoose).toHaveBeenCalledWith('helmert');
	});
});

describe('the guidance is announced with the control (ADR-0016)', () => {
	test('describes the control with the selected type’s guidance, by id', () => {
		picker({ controlPointCount: 3 });
		const describedById = select().getAttribute('aria-describedby') ?? '';
		expect(describedById).not.toBe('');
		expect(document.getElementById(describedById)?.textContent?.trim()).toBe(
			'Most printed and scanned maps'
		);
		expect(at('transformation-guidance').textContent?.trim()).toBe('Most printed and scanned maps');
		const group = at('transformation-picker');
		expect(group.querySelector('[title]'), 'leans on no native tooltip').toBeNull();
		expect(group.querySelector('[class*="tooltip"]'), 'leans on no daisyUI tooltip').toBeNull();
	});

	test('the guidance follows the selection rather than the default', () => {
		picker({ value: 'thinPlateSpline', controlPointCount: 3 });

		expect(at('transformation-guidance').textContent?.trim()).toBe(
			'Hand-drawn or geometrically inconsistent maps'
		);
	});
});

describe('the notes about consequences are not standing in this group', () => {
	test('says nothing extra about Simple when Simple is the selection', () => {
		picker({ value: 'helmert', controlPointCount: 3 });
		expect(absent('transformation-simple-note')).toBe(true);
		expect(at('transformation-picker').textContent).not.toContain('cannot turn the Map Image over');
	});

	test('says nothing extra about the higher orders when Advanced is disclosed', () => {
		picker({ controlPointCount: 10 });
		pressAdvanced();
		expect(absent('transformation-advanced-note')).toBe(true);
		expect(at('transformation-picker').textContent).not.toContain('spectacular distortion');
	});
});

test('renders an option for every type the catalog offers', () => {
	picker({ controlPointCount: 10 });
	pressAdvanced();

	expect(options().map((one) => one.value)).toEqual(
		TRANSFORMATION_CHOICES.map((choice) => choice.type)
	);
	for (const choice of TRANSFORMATION_CHOICES) {
		expect(options().find((one) => one.value === choice.type)?.text).toContain(choice.guidance);
	}
});
