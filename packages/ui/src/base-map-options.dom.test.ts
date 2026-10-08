import type { BaseMapAppearance, BaseMapCatalog } from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import BaseMapOptions from './BaseMapOptions.svelte';

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

const ONE_ARCHIVE: BaseMapCatalog = { ...TWO_ARCHIVES, entries: TWO_ARCHIVES.entries.slice(0, 1) };

const STREETS_ONLY: BaseMapAppearance = {
	streets: true,
	relief: false,
	highContrast: false,
	imagery: false
};

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
	return document.querySelector<HTMLButtonElement>('[data-testid="base-map-options"]')!;
};

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

test('is one button, named in words rather than by an icon', () => {
	// ADR-0016: an icon with a `title` is not a name — daisyUI renders tooltips through CSS `::before`, which no screen reader announces.
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

test('holds the four appearance switches', () => {
	render();
	expect(document.querySelector('[data-testid="base-map-appearance"]')).not.toBeNull();
	expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(4);
});

test('offers no choice of tiles where the deployment reads one archive', () => {
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
		highContrast: true,
		imagery: false
	});
	expect(onBorders).toHaveBeenCalledExactlyOnceWith('none');
});
