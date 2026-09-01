import type { BaseMapCatalog } from './entry';

/** Everything the fork is except its elevation dataset, so that both catalogs below share it. */
const FORK: BaseMapCatalog = {
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
		},
		{
			id: 'ordnance-relief',
			label: 'Ordnance relief',
			needsNetwork: true,
			archive: 'https://tiles.example.invalid/satellite.pmtiles',
			emphasis: 'relief-and-contours',
			flavor: { light: 'light', dark: 'dark' }
		}
	],
	defaultId: 'parish-roads',
	initialView: { center: [-71.1167, 42.3736], zoom: 11 },
	glyphs: 'typefaces/{fontstack}/{range}.pbf',
	sprite: 'icons/{flavor}',
	attribution: 'Somebody else entirely'
};

/**
 * A catalog with nothing whatsoever in common with the real one — different ids, labels,
 * archives, flavors, view, asset paths, and elevation dataset.
 *
 * It exists to assert the forkability property ADR-0020 rests on: everything the app does with
 * Base Maps is a function of the catalog it is given, so replacing the catalog module changes
 * the switcher and requires no change anywhere else. A test that passed a near-copy of the
 * real catalog would assert nothing.
 */
export const FORKED_CATALOG: BaseMapCatalog = {
	...FORK,
	terrain: {
		tiles: 'https://elevation.example.invalid/{z}/{x}/{y}.webp',
		encoding: 'mapbox',
		maxZoom: 11,
		attribution: 'Somebody else&rsquo;s elevations'
	}
};

/**
 * The same fork with no elevation dataset provisioned, which is the ordinary state of a deployment
 * that has its own vector tiles and no DEM. Its `relief-and-contours` entry must still draw — a
 * catalog is a fork's to edit, and no edit to it may produce a blank pane.
 */
export const CATALOG_WITHOUT_TERRAIN: BaseMapCatalog = FORK;

/** A catalog whose `defaultId` names an entry that is not there — a deployment mistake. */
export const CATALOG_WITH_STALE_DEFAULT: BaseMapCatalog = {
	...FORKED_CATALOG,
	defaultId: 'an-entry-that-was-removed'
};

/** A catalog with no entries at all. Unrenderable by any means. */
export const EMPTY_CATALOG: BaseMapCatalog = { ...FORKED_CATALOG, entries: [] };
