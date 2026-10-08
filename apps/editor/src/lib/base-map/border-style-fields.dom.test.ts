import { MAX_BORDER_WIDTH, MIN_BORDER_WIDTH, subnationalWidth } from '@ballastella/core';
import { flushSync, type ComponentProps } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { one, show, takeDown } from '$lib/test-support/dom';

import BorderStyleFieldsHarness from './BorderStyleFieldsHarness.svelte';

afterEach(takeDown);

const section = (props: ComponentProps<typeof BorderStyleFieldsHarness> = {}): void =>
	show(BorderStyleFieldsHarness, props);

const radioIn = (testid: string): HTMLInputElement => {
	const found = one(testid)?.querySelector('input[type="radio"]');
	if (!(found instanceof HTMLInputElement)) throw new Error(`no radio in ${testid}`);
	return found;
};

const choose = (testid: string): void => {
	radioIn(testid).click();
	flushSync();
};

const slider = (): HTMLInputElement => {
	const found = one('border-width');
	if (!(found instanceof HTMLInputElement)) throw new Error('no width slider');
	return found;
};

describe('the Automatic/Custom switch', () => {
	test('starts on Automatic for a Project that has chosen nothing, and offers no pickers', () => {
		section();
		expect(radioIn('border-appearance-automatic').checked).toBe(true);
		expect(radioIn('border-appearance-custom').checked).toBe(false);
		expect(one('border-color')).toBeNull();
		expect(one('border-line-style-solid')).toBeNull();
		expect(one('border-width')).toBeNull();
	});

	test('is on Custom for a Project holding any one property', () => {
		section({ style: { color: null, lineStyle: null, width: 3 } });
		expect(radioIn('border-appearance-custom').checked).toBe(true);
		expect(one('border-color')).not.toBeNull();
	});

	test('seeds every property from what is drawn now when Custom is chosen, and shows it', () => {
		const onchange = vi.fn();
		section({ automatic: { color: '#5f5f5f', lineStyle: 'dotted', width: 2.5 }, onchange });
		choose('border-appearance-custom');

		expect(onchange).toHaveBeenCalledWith(
			{ color: '#5f5f5f', lineStyle: 'dotted', width: 2.5 },
			undefined
		);
		expect(radioIn('border-line-style-dotted').checked).toBe(true);
		expect(slider().value).toBe('2.5');
		expect(one('border-width-value')?.textContent?.trim()).toBe('2.5');
	});

	test('hands every property back to the derivation when Automatic is chosen', () => {
		const onchange = vi.fn();
		section({ style: { color: '#c1272d', lineStyle: 'solid', width: 4 }, onchange });
		choose('border-appearance-automatic');
		expect(onchange).toHaveBeenCalledWith({ color: null, lineStyle: null, width: null }, undefined);
		expect(one('border-color')).toBeNull();
	});
});

describe('the three pickers', () => {
	test('writes a chosen swatch at once, because a swatch is one deliberate choice', () => {
		const onchange = vi.fn();
		const oncommit = vi.fn();
		section({ style: { color: '#c1272d', lineStyle: null, width: null }, onchange, oncommit });
		choose('border-color-blue');

		expect(onchange).toHaveBeenCalledWith(
			{ color: expect.stringMatching(/^#[0-9a-f]{6}$/) },
			undefined
		);
		expect(oncommit).toHaveBeenCalled();
	});

	test('offers the three line styles the Annotation face offers, in the same words', () => {
		section({ style: { color: null, lineStyle: 'solid', width: null } });

		for (const style of ['solid', 'dashed', 'dotted']) {
			expect(one(`border-line-style-${style}`)).not.toBeNull();
		}
		expect(radioIn('border-line-style-solid').checked).toBe(true);
	});

	test('debounces the width while it is dragged and commits on release (ADR-0017 rule 1)', () => {
		const onchange = vi.fn();
		const oncommit = vi.fn();
		section({ style: { color: null, lineStyle: null, width: 2 }, onchange, oncommit });
		slider().value = '3.5';
		slider().dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(onchange).toHaveBeenCalledWith({ width: 3.5 }, { debounce: true });
		expect(oncommit).not.toHaveBeenCalled();
		slider().dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(oncommit).toHaveBeenCalled();
	});

	test('cannot be dragged to a width that draws nothing', () => {
		section({ style: { color: null, lineStyle: null, width: 2 } });
		expect(slider().min).toBe(String(MIN_BORDER_WIDTH));
		expect(slider().max).toBe(String(MAX_BORDER_WIDTH));
		expect(Number(slider().min)).toBeGreaterThan(0);
	});
});

describe('what the section says', () => {
	test.each([
		['#ffffff', ['light'] as const, ['the light theme']],
		['#808080', ['light', 'dark'] as const, ['the light theme', 'the dark theme']]
	])('warns which themes %s cannot be seen in', (color, illegibleIn, named) => {
		section({ style: { color, lineStyle: null, width: null }, illegibleIn });
		for (const theme of named) {
			expect(one('border-color-contrast-warning')?.textContent).toContain(theme);
		}
	});

	test('says nothing about contrast when the colour is legible', () => {
		section({ style: { color: '#c1272d', lineStyle: null, width: null }, illegibleIn: [] });
		expect(one('border-color-contrast-warning')).toBeNull();
	});

	test('says what the divisions inside a nation are drawn at, only when it is drawing them', () => {
		section({ borders: 'all', style: { color: null, lineStyle: null, width: 4 } });
		expect(one('border-width-note')?.textContent).toContain(String(subnationalWidth(4)));
		expect(one('border-style-not-drawn')).toBeNull();
		takeDown();

		section({ borders: 'national', style: { color: null, lineStyle: null, width: 4 } });
		expect(one('border-width-note')).toBeNull();
	});

	test('keeps its controls but says so when the Project draws no borders', () => {
		section({ borders: 'none', style: { color: '#c1272d', lineStyle: null, width: null } });
		expect(one('border-style-not-drawn')).not.toBeNull();
		expect(one('border-color')).not.toBeNull();
	});
});
