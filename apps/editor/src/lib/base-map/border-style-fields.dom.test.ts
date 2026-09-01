// What the Borders section of Project settings offers, asserted against the component rather than
// against the application.
//
// ⚠ **What stays in `e2e/` is everything this section cannot answer alone**: that choosing a colour
// writes `borderStyle` into `project.json`, that MapLibre repaints the boundary line, and the wiring
// — that this section is really rendered inside the settings dialog and really handed the Project's
// style. Handed its props by the test, it cannot fail for a wiring reason at all.

import { MAX_BORDER_WIDTH, MIN_BORDER_WIDTH, subnationalWidth } from '@ballastella/core';
import { flushSync, mount, unmount, type ComponentProps } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import BorderStyleFieldsHarness from './BorderStyleFieldsHarness.svelte';

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

const section = (props: ComponentProps<typeof BorderStyleFieldsHarness> = {}): void => {
	mounted = mount(BorderStyleFieldsHarness, { target: document.body, props });
	flushSync();
};

const at = (testid: string): HTMLElement | null =>
	document.querySelector(`[data-testid="${testid}"]`);

const radioIn = (testid: string): HTMLInputElement => {
	const found = at(testid)?.querySelector('input[type="radio"]');
	if (!(found instanceof HTMLInputElement)) throw new Error(`no radio in ${testid}`);
	return found;
};

const press = (testid: string): void => {
	radioIn(testid).click();
	flushSync();
};

const slider = (): HTMLInputElement => {
	const found = at('border-width');
	if (!(found instanceof HTMLInputElement)) throw new Error('no width slider');
	return found;
};

describe('the Automatic/Custom switch', () => {
	test('starts on Automatic for a Project that has chosen nothing, and offers no pickers', () => {
		section();

		expect(radioIn('border-appearance-automatic').checked).toBe(true);
		expect(radioIn('border-appearance-custom').checked).toBe(false);
		expect(at('border-color')).toBeNull();
		expect(at('border-line-style-solid')).toBeNull();
		expect(at('border-width')).toBeNull();
	});

	test('is on Custom for a Project holding any one property', () => {
		section({ style: { color: null, lineStyle: null, width: 3 } });

		expect(radioIn('border-appearance-custom').checked).toBe(true);
		expect(at('border-color')).not.toBeNull();
	});

	// The property that makes the switch safe: flipping it must change what the file says and not what
	// the map shows, so a scholar can read the controls to find out what automatic was.
	test('seeds every property from what is drawn now when Custom is chosen', () => {
		const onchange = vi.fn();
		section({ automatic: { color: '#5f5f5f', lineStyle: 'dashed', width: 1.4 }, onchange });

		press('border-appearance-custom');

		expect(onchange).toHaveBeenCalledWith(
			{ color: '#5f5f5f', lineStyle: 'dashed', width: 1.4 },
			undefined
		);
	});

	test('shows the seeded values in the pickers, so nothing has to be set twice', () => {
		section({ automatic: { color: '#5f5f5f', lineStyle: 'dotted', width: 2.5 } });

		press('border-appearance-custom');

		expect(radioIn('border-line-style-dotted').checked).toBe(true);
		expect(slider().value).toBe('2.5');
		expect(at('border-width-value')?.textContent?.trim()).toBe('2.5');
	});

	test('hands every property back to the derivation when Automatic is chosen', () => {
		// All three, not just the one last touched: a partial clear would leave the section on Custom
		// with a value the author thought they had cleared.
		const onchange = vi.fn();
		section({ style: { color: '#c1272d', lineStyle: 'solid', width: 4 }, onchange });

		press('border-appearance-automatic');

		expect(onchange).toHaveBeenCalledWith({ color: null, lineStyle: null, width: null }, undefined);
		expect(at('border-color')).toBeNull();
	});
});

describe('the three pickers', () => {
	test('writes a chosen swatch at once, because a swatch is one deliberate choice', () => {
		const onchange = vi.fn();
		const oncommit = vi.fn();
		section({ style: { color: '#c1272d', lineStyle: null, width: null }, onchange, oncommit });

		radioIn('border-color-blue').click();
		flushSync();

		expect(onchange).toHaveBeenCalledWith(
			{ color: expect.stringMatching(/^#[0-9a-f]{6}$/) },
			undefined
		);
		expect(oncommit).toHaveBeenCalled();
	});

	test('offers the three line styles the Annotation face offers, in the same words', () => {
		section({ style: { color: null, lineStyle: 'solid', width: null } });

		for (const style of ['solid', 'dashed', 'dotted']) {
			expect(at(`border-line-style-${style}`)).not.toBeNull();
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

	// Not from zero: zero is an invisible border, which the level control says properly, and a width
	// slider that can contradict it is two controls for one thing.
	test('cannot be dragged to a width that draws nothing', () => {
		section({ style: { color: null, lineStyle: null, width: 2 } });

		expect(slider().min).toBe(String(MIN_BORDER_WIDTH));
		expect(slider().max).toBe(String(MAX_BORDER_WIDTH));
		expect(Number(slider().min)).toBeGreaterThan(0);
	});
});

describe('what the section says', () => {
	// The palette contains White and Black and each is invisible on one of the two grounds. Named
	// rather than corrected, because the chosen colour is drawn verbatim.
	test('warns which themes a chosen colour cannot be seen in', () => {
		section({
			style: { color: '#ffffff', lineStyle: null, width: null },
			illegibleIn: ['light']
		});

		expect(at('border-color-contrast-warning')?.textContent).toContain('the light theme');
	});

	test('names both themes when a colour fails in both', () => {
		section({
			style: { color: '#808080', lineStyle: null, width: null },
			illegibleIn: ['light', 'dark']
		});

		expect(at('border-color-contrast-warning')?.textContent).toContain('the light theme');
		expect(at('border-color-contrast-warning')?.textContent).toContain('the dark theme');
	});

	test('says nothing about contrast when the colour is legible', () => {
		section({ style: { color: '#c1272d', lineStyle: null, width: null }, illegibleIn: [] });

		expect(at('border-color-contrast-warning')).toBeNull();
	});

	// One slider labelled "Width" over a map drawing two weights of line is otherwise a discrepancy a
	// scholar has to measure to understand.
	test('says what the divisions inside a nation are drawn at, when it is drawing them', () => {
		section({ borders: 'all', style: { color: null, lineStyle: null, width: 4 } });

		expect(at('border-width-note')?.textContent).toContain(String(subnationalWidth(4)));
	});

	test('says nothing about divisions when only the national line is drawn', () => {
		section({ borders: 'national', style: { color: null, lineStyle: null, width: 4 } });

		expect(at('border-width-note')).toBeNull();
	});

	// The two fields are independent in the file on purpose, so an author comparing "with" and
	// "without" does not lose their styling — and a section that vanished would look like it had.
	test('keeps its controls but says so when the Project draws no borders', () => {
		section({ borders: 'none', style: { color: '#c1272d', lineStyle: null, width: null } });

		expect(at('border-style-not-drawn')).not.toBeNull();
		expect(at('border-color')).not.toBeNull();
	});

	test('says nothing of the kind when borders are drawn', () => {
		section({ borders: 'all' });

		expect(at('border-style-not-drawn')).toBeNull();
	});
});
