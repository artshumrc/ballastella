import type { BaseMapCatalog } from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import BaseMapSwitcher from './BaseMapSwitcher.svelte';

const CATALOG: BaseMapCatalog = {
	entries: [
		{
			id: 'harbour-charts',
			label: 'Harbour charts',
			needsNetwork: false,
			archive: 'tiles/harbours.pmtiles'
		},
		{
			id: 'parish-roads',
			label: 'Parish roads',
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
	defaultId: 'parish-roads',
	initialView: { center: [-71.1167, 42.3736], zoom: 11 },
	glyphs: 'typefaces/{fontstack}/{range}.pbf',
	sprite: 'icons/{flavor}',
	attribution: 'Somebody else entirely'
};

let mounted: Record<string, unknown> | undefined;

const render = (props: {
	entryId: string;
	catalog: BaseMapCatalog;
	onSelect: (id: string) => void;
	class?: string;
}) => {
	mounted = mount(BaseMapSwitcher, { target: document.body, props });
	flushSync();
	return document.querySelector('select')!;
};

const ONE_ENTRY: BaseMapCatalog = { ...CATALOG, entries: CATALOG.entries.slice(0, 1) };

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

test('offers every entry of the catalog it is handed, in catalog order', () => {
	const select = render({ entryId: 'parish-roads', catalog: CATALOG, onSelect: () => {} });

	expect([...select.options].map((option) => option.value)).toEqual([
		'harbour-charts',
		'parish-roads',
		'satellite'
	]);
});

test('labels an option with the map’s name and nothing else', () => {
	// Not a tooltip, here or anywhere: ADR-0016 rules them out as an information channel because daisyUI renders them via CSS `::before`, which no screen reader announces.
	const select = render({ entryId: 'parish-roads', catalog: CATALOG, onSelect: () => {} });

	expect([...select.options].map((option) => option.textContent)).toEqual([
		'Harbour charts',
		'Parish roads',
		'Satellite'
	]);
	expect(select.querySelector('[title]')).toBeNull();
	expect(
		[...select.options].map((option) => option.dataset.needsNetwork).filter((set) => set === 'true')
			.length
	).toBeGreaterThan(0);
});

test('carries the test id both suites address the control by', () => {
	const select = render({ entryId: 'parish-roads', catalog: CATALOG, onSelect: () => {} });
	expect(select).toHaveAttribute('data-testid', 'base-map-switcher');
});

test('marks needs-network on each option as data a test can read, and not only in the text', () => {
	const select = render({ entryId: 'parish-roads', catalog: CATALOG, onSelect: () => {} });

	expect([...select.options].map((option) => [option.value, option.dataset.needsNetwork])).toEqual([
		['harbour-charts', 'false'],
		['parish-roads', 'false'],
		['satellite', 'true']
	]);
});

test('shows the entry it was given as the one in force', () => {
	const select = render({ entryId: 'satellite', catalog: CATALOG, onSelect: () => {} });
	expect(select).toHaveValue('satellite');
});

test('reports the id of the entry chosen, and changes nothing itself', () => {
	const onSelect = vi.fn();
	const select = render({ entryId: 'parish-roads', catalog: CATALOG, onSelect });

	select.value = 'harbour-charts';
	select.dispatchEvent(new Event('change', { bubbles: true }));
	flushSync();
	expect(onSelect).toHaveBeenCalledWith('harbour-charts');
});

test('names the select for a screen reader', () => {
	const onScreen = render({ entryId: 'parish-roads', catalog: CATALOG, onSelect: () => {} });
	expect(onScreen).toHaveAccessibleName('Base Map');
	expect(document.querySelector('label')).toHaveClass('label');
});

test('wears the width its caller asked for, on top of the classes it owns', () => {
	const select = render({
		entryId: 'parish-roads',
		catalog: CATALOG,
		onSelect: () => {},
		class: 'max-w-xs'
	});

	expect(select.className).toBe('select-bordered select w-full max-w-xs');
});

test('renders nothing at all for a deployment that offers one set of tiles', () => {
	mounted = mount(BaseMapSwitcher, {
		target: document.body,
		props: { entryId: 'harbour-charts', catalog: ONE_ENTRY, onSelect: () => {} }
	});
	flushSync();
	expect(document.querySelector('select')).toBeNull();
	expect(document.querySelector('label')).toBeNull();
});
