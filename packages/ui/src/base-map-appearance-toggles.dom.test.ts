import type { BaseMapAppearance } from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import BaseMapAppearanceToggles from './BaseMapAppearanceToggles.svelte';

const STREETS_ONLY: BaseMapAppearance = {
	streets: true,
	relief: false,
	highContrast: false,
	imagery: false
};

let mounted: Record<string, unknown> | undefined;

const render = (props: {
	appearance: BaseMapAppearance;
	onChange: (appearance: BaseMapAppearance) => void;
	legend?: string;
}) => {
	mounted = mount(BaseMapAppearanceToggles, { target: document.body, props });
	flushSync();
};

const toggle = (key: string): HTMLInputElement =>
	document.querySelector<HTMLInputElement>(`[data-testid="base-map-${key}"]`)!;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

test('offers the four switches as checkboxes, in the order a scholar reaches for them', () => {
	render({ appearance: STREETS_ONLY, onChange: () => {} });

	expect(
		[...document.querySelectorAll<HTMLInputElement>('input')].map((input) => [
			input.type,
			input.dataset.testid
		])
	).toEqual([
		['checkbox', 'base-map-streets'],
		['checkbox', 'base-map-imagery'],
		['checkbox', 'base-map-relief'],
		['checkbox', 'base-map-highContrast']
	]);
});

test('shows each switch in the state it was given', () => {
	render({
		appearance: { streets: false, relief: true, highContrast: true, imagery: true },
		onChange: () => {}
	});

	expect(toggle('streets').checked).toBe(false);
	expect(toggle('relief').checked).toBe(true);
	expect(toggle('highContrast').checked).toBe(true);
	expect(toggle('imagery').checked).toBe(true);
});

test('reports the whole appearance, carrying the switches it did not touch', () => {
	// ⚠ **The assertion this component exists for.** The named variants it replaced could not have passed it: a low-vision Reader who raised the contrast lost the author's relief to do it, because there was no entry that was…
	const onChange = vi.fn();
	render({
		appearance: { streets: false, relief: true, highContrast: false, imagery: false },
		onChange
	});

	toggle('highContrast').click();
	flushSync();

	expect(onChange).toHaveBeenCalledWith({
		streets: false,
		relief: true,
		highContrast: true,
		imagery: false
	});
});

test('switches a thing off as readily as on', () => {
	const onChange = vi.fn();
	render({
		appearance: { streets: true, relief: true, highContrast: true, imagery: false },
		onChange
	});

	toggle('streets').click();
	flushSync();

	expect(onChange).toHaveBeenCalledWith({
		streets: false,
		relief: true,
		highContrast: true,
		imagery: false
	});
});

test('names every switch and its consequence, and never in a tooltip', () => {
	// ADR-0016: daisyUI renders `title` through CSS `::before`, which no screen reader announces, so a toggle whose meaning is only in a tooltip has no meaning for anyone not using a mouse.
	render({ appearance: STREETS_ONLY, onChange: () => {} });
	expect(toggle('streets')).toHaveAccessibleName('Streets — roads, buildings and places');
	expect(toggle('relief')).toHaveAccessibleName('Topography — shaded relief and contour lines');
	expect(toggle('highContrast')).toHaveAccessibleName(
		'High contrast — black and white, for maximum legibility'
	);
	expect(document.querySelector('[title]')).toBeNull();
});

test('groups the three under one legend', () => {
	render({ appearance: STREETS_ONLY, onChange: () => {}, legend: 'Base Map detail' });
	expect(document.querySelector('fieldset > legend')).toHaveTextContent('Base Map detail');
});

test('takes the high-contrast switch away while the satellite is on, rather than leaving it inert', () => {
	const onChange = vi.fn();
	render({ appearance: { ...STREETS_ONLY, imagery: true }, onChange });
	expect(toggle('highContrast').disabled).toBe(true);
	expect(toggle('streets').disabled).toBe(false);
	expect(toggle('relief').disabled).toBe(false);
});

test('switches the high contrast off as it switches the satellite on', () => {
	const onChange = vi.fn();
	render({
		appearance: { streets: true, relief: false, highContrast: true, imagery: false },
		onChange
	});

	toggle('imagery').click();
	flushSync();

	expect(onChange).toHaveBeenCalledWith({
		streets: true,
		relief: false,
		highContrast: false,
		imagery: true
	});
});
