// What the Base Map switcher renders, asserted against the component rather than against an app.
//
// This is the claim that used to be made twice — once in `e2e/editor-base-map.e2e.ts` against the
// authoring app and once in `e2e/viewer-reader.e2e.ts` against a published site — because the
// component existed twice. It is one component now, so it is one test, and it lives beside the
// component rather than in either consumer.
//
// ⚠ What stays in `e2e/` is unchanged: that *this deployment's* catalog is what the editor offers,
// that a Published Site keeps offering what it was published with, and that choosing an entry
// actually redraws MapLibre. Those are claims about the application's real dependencies. This file's
// subject is the `<select>` the component builds out of whatever catalog it is handed.
//
// Everything is addressed by position and read straight off the document: `mount` is Svelte's own
// and a query is `document.querySelector`. There is no component-testing library.

import type { BaseMapCatalog } from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import BaseMapSwitcher from './BaseMapSwitcher.svelte';

/**
 * A catalog with nothing in common with this deployment's.
 *
 * Written out here rather than imported from the real one, which is the property ADR-0020 rests on:
 * the switcher is a function of the catalog it is given, so a component test that passed a near-copy
 * of the shipped catalog would assert that the component agrees with the deployment rather than that
 * it renders what it is handed. `scripts/check-base-map-catalog.mjs` refuses the real ids here too.
 */
const CATALOG: BaseMapCatalog = {
	entries: [
		{
			id: 'harbour-charts',
			label: 'Harbour charts',
			needsNetwork: false,
			archive: 'tiles/harbours.pmtiles',
			emphasis: 'water-and-terrain',
			flavor: { light: 'white', dark: 'black' }
		},
		{
			id: 'parish-roads',
			label: 'Parish roads',
			needsNetwork: false,
			archive: 'tiles/harbours.pmtiles',
			emphasis: 'streets-and-labels',
			flavor: { light: 'light', dark: 'dark' }
		},
		{
			id: 'satellite',
			label: 'Satellite',
			needsNetwork: true,
			archive: 'https://tiles.example.invalid/satellite.pmtiles',
			emphasis: 'streets-and-labels',
			flavor: { light: 'light', dark: 'dark' }
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
	labelSrOnly?: boolean;
	fullWidth?: boolean;
	class?: string;
}) => {
	mounted = mount(BaseMapSwitcher, { target: document.body, props });
	flushSync();
	return document.querySelector('select')!;
};

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
	// An option's words are the map's name. The needs-network fact rides on `data-needs-network` for
	// anything that has to branch on it, and the words a scholar reads when it actually bites are the
	// offline notice's — `nothingUnderTheWork`, covered in `packages/core/src/base-map/resolve.test.ts`.
	//
	// Not a tooltip, here or anywhere: ADR-0016 rules them out as an information channel because
	// daisyUI renders them via CSS `::before`, which no screen reader announces.
	const select = render({ entryId: 'parish-roads', catalog: CATALOG, onSelect: () => {} });

	expect([...select.options].map((option) => option.textContent)).toEqual([
		'Harbour charts',
		'Parish roads',
		'Satellite'
	]);
	expect(select.querySelector('[title]')).toBeNull();
	// The fact itself still reaches anything that needs it.
	expect(
		[...select.options].map((option) => option.dataset.needsNetwork).filter((set) => set === 'true')
			.length
	).toBeGreaterThan(0);
});

test('carries the test id both suites address the control by', () => {
	// Roughly twenty assertions in `e2e/viewer-reader.e2e.ts` and `e2e/editor-publish.e2e.ts` reach
	// this control as `getByTestId('base-map-switcher')`, and a published site is not rebuilt by this
	// repository's test run — so deleting the attribute here breaks a suite that cannot see this file.
	const select = render({ entryId: 'parish-roads', catalog: CATALOG, onSelect: () => {} });

	expect(select).toHaveAttribute('data-testid', 'base-map-switcher');
});

test('marks needs-network on each option as data a test can read, and not only in the text', () => {
	// The visible text is for the Reader; this attribute is how `e2e/viewer-reader.e2e.ts` asks which
	// entries of a *published* catalog need the network, having no access to that catalog otherwise.
	// It reads `option.dataset.needsNetwork === 'true'`, so the value matters as much as the name.
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

	// The id, not the label and not the archive: a Base Map is an id everywhere above `core`
	// (ADR-0020), and the caller is what decides whether the choice is kept.
	expect(onSelect).toHaveBeenCalledWith('harbour-charts');
});

test('names the select for a screen reader, and keeps that name when the label is taken off screen', () => {
	// The alignment route's own heading already says "Base Map" beside the control, so the visible
	// label there is the word repeated. `labelSrOnly` takes it off the screen; it never removes it,
	// because the `<select>` needs an accessible name and ADR-0016 keeps that out of a `title`.
	const onScreen = render({ entryId: 'parish-roads', catalog: CATALOG, onSelect: () => {} });
	expect(onScreen).toHaveAccessibleName('Base Map');
	expect(document.querySelector('label')).toHaveClass('label');

	if (mounted) unmount(mounted);
	document.body.innerHTML = '';

	const offScreen = render({
		entryId: 'parish-roads',
		catalog: CATALOG,
		onSelect: () => {},
		labelSrOnly: true
	});
	expect(offScreen).toHaveAccessibleName('Base Map');
	expect(document.querySelector('label')).toHaveClass('sr-only');
});

test('wears the width its caller asked for, on top of the classes it owns', () => {
	// The two apps put the switcher in columns of different widths, and the width is the caller's
	// business: the component owns what makes it a daisyUI select and nothing about where it sits.
	const select = render({
		entryId: 'parish-roads',
		catalog: CATALOG,
		onSelect: () => {},
		class: 'max-w-xs'
	});

	expect(select.className).toBe('select-bordered select w-full max-w-xs');
});

test('can use its intrinsic width instead of filling a compact toolbar', () => {
	const select = render({
		entryId: 'parish-roads',
		catalog: CATALOG,
		onSelect: () => {},
		fullWidth: false
	});

	expect(select).toHaveClass('w-fit');
	expect(select).not.toHaveClass('w-full');
});
