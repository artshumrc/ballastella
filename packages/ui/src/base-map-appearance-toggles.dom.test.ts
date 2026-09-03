// What the appearance control renders, asserted against the component rather than against an app.
//
// Its subject is the one property that made it worth building: the three switches are independent,
// so flipping one carries the other two through untouched. A control that quietly reset its
// neighbours would look right in every screenshot and lose a scholar's contour lines the moment they
// raised the contrast.

import type { BaseMapAppearance } from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import BaseMapAppearanceToggles from './BaseMapAppearanceToggles.svelte';

const STREETS_ONLY: BaseMapAppearance = { streets: true, relief: false, highContrast: false };

let mounted: Record<string, unknown> | undefined;

const render = (props: {
	appearance: BaseMapAppearance;
	onChange: (appearance: BaseMapAppearance) => void;
	legend?: string;
	legendSrOnly?: boolean;
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

test('offers the three switches as checkboxes, in the order a scholar reaches for them', () => {
	render({ appearance: STREETS_ONLY, onChange: () => {} });

	expect(
		[...document.querySelectorAll<HTMLInputElement>('input')].map((input) => [
			input.type,
			input.dataset.testid
		])
	).toEqual([
		['checkbox', 'base-map-streets'],
		['checkbox', 'base-map-relief'],
		['checkbox', 'base-map-highContrast']
	]);
});

test('shows each switch in the state it was given', () => {
	render({ appearance: { streets: false, relief: true, highContrast: true }, onChange: () => {} });

	expect(toggle('streets').checked).toBe(false);
	expect(toggle('relief').checked).toBe(true);
	expect(toggle('highContrast').checked).toBe(true);
});

test('reports the whole appearance, carrying the switches it did not touch', () => {
	// ⚠ **The assertion this component exists for.** The named variants it replaced could not have
	// passed it: a low-vision Reader who raised the contrast lost the author's relief to do it, because
	// there was no entry that was both. Here the other two switches travel through untouched.
	const onChange = vi.fn();
	render({ appearance: { streets: false, relief: true, highContrast: false }, onChange });

	toggle('highContrast').click();
	flushSync();

	expect(onChange).toHaveBeenCalledWith({ streets: false, relief: true, highContrast: true });
});

test('switches a thing off as readily as on', () => {
	const onChange = vi.fn();
	render({ appearance: { streets: true, relief: true, highContrast: true }, onChange });

	toggle('streets').click();
	flushSync();

	expect(onChange).toHaveBeenCalledWith({ streets: false, relief: true, highContrast: true });
});

test('names every switch and its consequence, and never in a tooltip', () => {
	// ADR-0016: daisyUI renders `title` through CSS `::before`, which no screen reader announces, so a
	// toggle whose meaning is only in a tooltip has no meaning for anyone not using a mouse.
	render({ appearance: STREETS_ONLY, onChange: () => {} });

	expect(toggle('streets')).toHaveAccessibleName('Streets — roads, buildings and places');
	expect(toggle('relief')).toHaveAccessibleName('Topography — shaded relief and contour lines');
	expect(toggle('highContrast')).toHaveAccessibleName(
		'High contrast — black and white, for maximum legibility'
	);
	expect(document.querySelector('[title]')).toBeNull();
});

test('groups the three under one legend, kept for a screen reader when taken off screen', () => {
	// One question with three answers: "Streets, checkbox" announced on its own says nothing about
	// what it is a property of.
	render({ appearance: STREETS_ONLY, onChange: () => {}, legend: 'Base Map detail' });
	expect(document.querySelector('fieldset > legend')).toHaveTextContent('Base Map detail');
	expect(document.querySelector('legend')).not.toHaveClass('sr-only');

	if (mounted) unmount(mounted);
	document.body.innerHTML = '';

	render({ appearance: STREETS_ONLY, onChange: () => {}, legendSrOnly: true });
	expect(document.querySelector('legend')).toHaveClass('sr-only');
});
