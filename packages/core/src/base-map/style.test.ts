import { describe, expect, it } from 'vitest';

import { BASE_MAP_CATALOG } from './catalog';
import { FORKED_CATALOG } from './fixture-catalogs';
import { resolveBaseMap } from './resolve';
import { archiveUrl, baseMapStyle, BASE_MAP_SOURCE_ID } from './style';
import type { BaseMapEntry } from './entry';

const entry = (id: string, catalog = BASE_MAP_CATALOG): BaseMapEntry => {
	const found = catalog.entries.find((candidate) => candidate.id === id);
	if (found === undefined) throw new Error(`no such fixture entry: ${id}`);
	return found;
};

const layerIds = (id: string, theme: 'light' | 'dark' = 'light'): string[] =>
	baseMapStyle(entry(id), { theme }).layers.map((layer) => layer.id);

const paint = (styleLayers: { id: string; paint?: unknown }[], id: string): unknown =>
	styleLayers.find((layer) => layer.id === id)?.paint;

describe('baseMapStyle', () => {
	it('reads its tiles through the pmtiles protocol, from one archive', () => {
		const style = baseMapStyle(entry('streets'), { theme: 'light' });
		const source = style.sources[BASE_MAP_SOURCE_ID];

		expect(Object.keys(style.sources)).toEqual([BASE_MAP_SOURCE_ID]);
		expect(source).toMatchObject({ type: 'vector' });
		expect(source && 'url' in source ? source.url : '').toMatch(/^pmtiles:\/\//);
	});

	it('builds the streets and physical variants over the very same archive URL', () => {
		const streets = baseMapStyle(entry('streets'), { theme: 'light' });
		const physical = baseMapStyle(entry('physical'), { theme: 'light' });

		const url = (style: typeof streets): string => {
			const source = style.sources[BASE_MAP_SOURCE_ID];
			return source && 'url' in source ? (source.url ?? '') : '';
		};

		expect(url(streets)).toBe(url(physical));
	});

	it('drops the built environment from the physical variant and keeps it in streets', () => {
		const streets = layerIds('streets');
		const physical = layerIds('physical');

		expect(streets.some((id) => id.startsWith('roads_'))).toBe(true);
		expect(streets).toContain('buildings');
		expect(physical.some((id) => id.startsWith('roads_'))).toBe(false);
		expect(physical).not.toContain('buildings');
	});

	it('keeps water, landcover, and place labels in the physical variant', () => {
		const physical = layerIds('physical');

		expect(physical).toContain('water');
		expect(physical).toContain('landcover');
		expect(physical).toContain('places_locality');
	});

	it('gives the streets variant labels, which is what makes it a streets-and-labels map', () => {
		expect(layerIds('streets')).toContain('roads_labels_major');
	});

	it('repaints the natural world in the physical variant, over identical tiles', () => {
		const streets = baseMapStyle(entry('streets'), { theme: 'light' }).layers;
		const physical = baseMapStyle(entry('physical'), { theme: 'light' }).layers;

		expect(paint(physical, 'landuse_park')).not.toEqual(paint(streets, 'landuse_park'));
	});

	it('changes every colour with the theme, from the entry the author chose', () => {
		const light = baseMapStyle(entry('streets'), { theme: 'light' }).layers;
		const dark = baseMapStyle(entry('streets'), { theme: 'dark' }).layers;

		expect(paint(dark, 'background')).not.toEqual(paint(light, 'background'));
		expect(paint(dark, 'water')).not.toEqual(paint(light, 'water'));
	});

	it('selects the muted flavor for the muted entry, and its sprite with it', () => {
		const muted = baseMapStyle(entry('muted'), { theme: 'light' });
		const streets = baseMapStyle(entry('streets'), { theme: 'light' });

		expect(muted.sprite).not.toBe(streets.sprite);
		expect(paint(muted.layers, 'water')).not.toEqual(paint(streets.layers, 'water'));
	});

	it('resolves relative asset paths through the caller, leaving placeholders intact', () => {
		const style = baseMapStyle(entry('harbour-charts', FORKED_CATALOG), {
			theme: 'light',
			resolveAsset: (path) => `https://example.test/site/${path}`
		});
		const source = style.sources[BASE_MAP_SOURCE_ID];

		expect(style.glyphs).toBe('https://example.test/site/base-map/fonts/{fontstack}/{range}.pbf');
		expect(style.sprite).toBe('https://example.test/site/base-map/sprites/white');
		expect(source && 'url' in source ? source.url : '').toBe(
			'pmtiles://https://example.test/site/tiles/harbours.pmtiles'
		);
	});

	it('leaves an already-absolute remote archive alone', () => {
		const remote = entry('streets-worldwide');

		expect(archiveUrl(remote, (path) => `https://example.test/${path}`)).toBe(remote.archive);
	});

	it('carries the tile attribution, which ODbL makes an obligation', () => {
		const source = baseMapStyle(entry('streets'), { theme: 'light' }).sources[BASE_MAP_SOURCE_ID];

		expect(source && 'attribution' in source ? source.attribution : '').toContain('OpenStreetMap');
	});
});

describe('baseMapStyle over a forked catalog', () => {
	// The forkability property: nothing about a style comes from anywhere but the entry and the
	// catalog it was given, so replacing the catalog module is the whole of pointing a fork at
	// its own tiles (SPEC story 100).
	const options = { theme: 'light' as const, catalog: FORKED_CATALOG };

	it('takes its archive, glyphs, sprite, and attribution from the catalog it was given', () => {
		const style = baseMapStyle(entry('harbour-charts', FORKED_CATALOG), options);
		const source = style.sources[BASE_MAP_SOURCE_ID];

		expect(source && 'url' in source ? source.url : '').toBe('pmtiles://tiles/harbours.pmtiles');
		expect(style.glyphs).toBe('typefaces/{fontstack}/{range}.pbf');
		expect(style.sprite).toBe('icons/white');
		expect(source && 'attribution' in source ? source.attribution : '').toBe(
			'Somebody else entirely'
		);
	});

	it('honours a forked entry emphasis and a flavor that carries no landcover struct', () => {
		const style = baseMapStyle(entry('harbour-charts', FORKED_CATALOG), options);

		// `white` has no landcover colours to borrow, so the emphasis is the layer selection.
		expect(style.layers.some((layer) => layer.id.startsWith('roads_'))).toBe(false);
		expect(style.layers.some((layer) => layer.id === 'water')).toBe(true);
	});

	it('resolves a forked default, and falls back to it, without the real catalog involved', () => {
		expect(resolveBaseMap('streets', FORKED_CATALOG).entry.id).toBe('parish-roads');
		expect(resolveBaseMap('streets', FORKED_CATALOG).fellBack).toBe(true);
	});
});
