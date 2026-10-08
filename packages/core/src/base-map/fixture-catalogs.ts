import type { BaseMapCatalog } from './entry';

const FORK: BaseMapCatalog = {
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
		},
		{
			id: 'ordnance-relief',
			label: 'Ordnance relief',
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

export const FORKED_CATALOG: BaseMapCatalog = {
	...FORK,
	terrain: {
		tiles: 'https://elevation.example.invalid/{z}/{x}/{y}.webp',
		encoding: 'mapbox',
		maxZoom: 11,
		attribution: 'Somebody else&rsquo;s elevations'
	},
	imagery: {
		tiles: 'https://photographs.example.invalid/{z}/{y}/{x}.jpg',
		maxZoom: 9,
		tileSize: 512,
		attribution: 'Somebody else&rsquo;s photographs'
	}
};

export const CATALOG_WITHOUT_TERRAIN: BaseMapCatalog = FORK;

export const CATALOG_WITH_STALE_DEFAULT: BaseMapCatalog = {
	...FORKED_CATALOG,
	defaultId: 'an-entry-that-was-removed'
};

export const EMPTY_CATALOG: BaseMapCatalog = { ...FORKED_CATALOG, entries: [] };
