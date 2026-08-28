import type { BaseMapCatalog } from './entry';

/**
 * A catalog with nothing whatsoever in common with the real one — different ids, labels,
 * archives, flavors, view, and asset paths.
 *
 * It exists to assert the forkability property ADR-0020 rests on: everything the app does with
 * Base Maps is a function of the catalog it is given, so replacing the catalog module changes
 * the switcher and requires no change anywhere else. A test that passed a near-copy of the
 * real catalog would assert nothing.
 */
export const FORKED_CATALOG: BaseMapCatalog = {
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

/** A catalog whose `defaultId` names an entry that is not there — a deployment mistake. */
export const CATALOG_WITH_STALE_DEFAULT: BaseMapCatalog = {
	...FORKED_CATALOG,
	defaultId: 'an-entry-that-was-removed'
};

/** A catalog with no entries at all. Unrenderable by any means. */
export const EMPTY_CATALOG: BaseMapCatalog = { ...FORKED_CATALOG, entries: [] };
