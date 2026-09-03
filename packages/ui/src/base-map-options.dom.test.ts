// What the Base Map Options panel puts behind one button.
//
// Its subject is the composition rather than the controls: each of the three sections has a test of
// its own beside it, and what only this file can say is which of them are there. Two of the three are
// conditional, and both conditions are load-bearing — a deployment reading one archive offers no
// choice of tiles, and a Published Site offers no control over the borders a work asserts, because
// that is the author's argument about it (ADR-0020).
//
// The panel's own dismissal, focus and `aria-expanded` are `MenuPopover`'s and are not re-asserted
// here. Everything is read straight off the document; there is no component-testing library.

import type { BaseMapAppearance, BaseMapCatalog } from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import BaseMapOptions from './BaseMapOptions.svelte';

/** A catalog with nothing in common with this deployment's — ADR-0020's forkability property. */
const TWO_ARCHIVES: BaseMapCatalog = {
	entries: [
		{
			id: 'harbour-charts',
			label: 'Harbour charts',
			needsNetwork: false,
			archive: 'tiles/harbours.pmtiles'
		},
		{
			id: 'satellite',
			label: 'Satellite',
			needsNetwork: true,
			archive: 'https://tiles.example.invalid/satellite.pmtiles'
		}
	],
	defaultId: 'harbour-charts',
	initialView: { center: [-71.1167, 42.3736], zoom: 11 },
	glyphs: 'typefaces/{fontstack}/{range}.pbf',
	sprite: 'icons/{flavor}',
	attribution: 'Somebody else entirely'
};

/** One archive, which is what this repository ships and what most forks will have. */
const ONE_ARCHIVE: BaseMapCatalog = { ...TWO_ARCHIVES, entries: TWO_ARCHIVES.entries.slice(0, 1) };

const STREETS_ONLY: BaseMapAppearance = { streets: true, relief: false, highContrast: false };

let mounted: Record<string, unknown> | undefined;

const render = (props: Partial<Record<string, unknown>> = {}) => {
	mounted = mount(BaseMapOptions, {
		target: document.body,
		props: {
			entryId: 'harbour-charts',
			catalog: ONE_ARCHIVE,
			appearance: STREETS_ONLY,
			onAppearance: () => {},
			onSelectEntry: () => {},
			...props
		}
	});
	flushSync();
	// The popover's contents are in the DOM whether or not it is showing — `popover="auto"` hides
	// them, it does not withhold them — so a test may address them without opening it.
	return document.querySelector<HTMLButtonElement>('[data-testid="base-map-options"]')!;
};

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

test('is one button, named in words rather than by an icon', () => {
	// ADR-0016: an icon with a `title` is not a name — daisyUI renders tooltips through CSS
	// `::before`, which no screen reader announces.
	const button = render();

	expect(button.tagName).toBe('BUTTON');
	expect(button).toHaveAccessibleName('Base Map Options');
	expect(button).toHaveAttribute('aria-expanded', 'false');
	expect(document.querySelector('[title]')).toBeNull();
});

test('can show a down chevron after the button label', () => {
	const button = render({ showChevron: true });

	expect(button.querySelector('svg')).not.toBeNull();
	expect(button).toHaveAccessibleName('Base Map Options');
});

test('holds the three appearance switches', () => {
	render();

	expect(document.querySelector('[data-testid="base-map-appearance"]')).not.toBeNull();
	expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
});

test('offers no choice of tiles where the deployment reads one archive', () => {
	// ⚠ **And no empty row where it would have been.** A `<li>` holding a component that draws nothing
	// is still one of the panel's gaps, which reads as a section somebody forgot to fill.
	render();

	expect(document.querySelector('[data-testid="base-map-switcher"]')).toBeNull();
	expect(document.querySelectorAll('li')).toHaveLength(1);
});

test('offers the tiles where the deployment has more than one set of them', () => {
	render({ catalog: TWO_ARCHIVES });

	const select = document.querySelector<HTMLSelectElement>('[data-testid="base-map-switcher"]')!;
	expect([...select.options].map((option) => option.value)).toEqual([
		'harbour-charts',
		'satellite'
	]);
});

test('offers the borders only to a caller that can record them', () => {
	// The viewer passes neither, and that is the claim: which boundaries a work draws is the author's
	// argument about it, so a Published Site has no control for it rather than a disabled one.
	render();
	expect(document.querySelector('[data-testid="border-switcher"]')).toBeNull();

	unmount(mounted!);
	document.body.innerHTML = '';

	render({ borders: 'national', onBorders: () => {} });
	expect(document.querySelector('[data-testid="border-switcher"]')).not.toBeNull();
});

test('hands each section’s choice back to the caller that owns it', () => {
	const onAppearance = vi.fn();
	const onBorders = vi.fn();
	render({ borders: 'all', onBorders, onAppearance });

	document.querySelector<HTMLInputElement>('[data-testid="base-map-highContrast"]')!.click();
	document.querySelector<HTMLInputElement>('[data-testid="border-option-none"]')!.click();
	flushSync();

	expect(onAppearance).toHaveBeenCalledExactlyOnceWith({
		streets: true,
		relief: false,
		highContrast: true
	});
	expect(onBorders).toHaveBeenCalledExactlyOnceWith('none');
});
