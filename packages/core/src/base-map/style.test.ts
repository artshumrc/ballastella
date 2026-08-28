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

	it('reads the Workspace cache instead of the archive when asked, and keeps the attribution', () => {
		// ADR-0025: the cached case is a `tiles` template under our own protocol, with no archive
		// anywhere in it — and the ODbL obligation does not lapse because no request leaves the
		// machine, so the source carries the very same attribution string the networked one does.
		const cached = baseMapStyle(entry('streets'), {
			theme: 'light',
			cachedTiles: { maxZoom: 14, tileTemplate: 'ballastella-base-map://tiles/{z}/{x}/{y}' }
		});
		const source = cached.sources[BASE_MAP_SOURCE_ID];

		expect(source).toMatchObject({
			type: 'vector',
			tiles: ['ballastella-base-map://tiles/{z}/{x}/{y}'],
			minzoom: 0,
			maxzoom: 14
		});
		expect(source && 'url' in source ? source.url : undefined).toBeUndefined();
		expect(source && 'attribution' in source ? source.attribution : '').toBe(
			BASE_MAP_CATALOG.attribution
		);
		expect(source && 'attribution' in source ? source.attribution : '').toContain('OpenStreetMap');
	});

	it('caps the cached source at the zoom the cache was filled to', () => {
		// Without this MapLibre asks for tiles the cache has none of, every one of them comes back
		// empty, and the map goes blank at exactly the zoom the user was told works offline.
		const cached = baseMapStyle(entry('streets'), {
			theme: 'light',
			cachedTiles: { maxZoom: 11, tileTemplate: 'x://{z}/{x}/{y}' }
		});
		const source = cached.sources[BASE_MAP_SOURCE_ID];
		expect(source && 'maxzoom' in source ? source.maxzoom : undefined).toBe(11);
	});

	it('keeps the glyphs, the sprite, and every layer when reading the cache', () => {
		// The cache changes where the *tiles* come from and nothing else: the same style documents over
		// one vector dataset is ADR-0020's zero-extra-bytes claim, and it has to survive caching.
		const networked = baseMapStyle(entry('muted'), { theme: 'dark' });
		const cached = baseMapStyle(entry('muted'), {
			theme: 'dark',
			cachedTiles: { maxZoom: 14, tileTemplate: 'x://{z}/{x}/{y}' }
		});
		expect(cached.layers.map((layer) => layer.id)).toEqual(
			networked.layers.map((layer) => layer.id)
		);
		expect(cached.glyphs).toBe(networked.glyphs);
		expect(cached.sprite).toBe(networked.sprite);
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

	it('takes glyphs from the catalog alone, so no entry or theme can be without them', () => {
		// A Label's words are shaped from the Base Map's typefaces, and the stack omits the
		// Label bucket where the style carries none (`styleHasGlyphs` in `render/stack-layers.ts`) — which
		// is the state of a Published Site written before ADR-0025. **The editor never reaches that
		// state**, and the reason is structural rather than statistical: `glyphs` is
		// `resolveAsset(catalog.glyphs)`, which reads neither the entry nor the theme, so there is one
		// code path and no entry-or-theme combination that can miss it. Looping the catalog × both themes
		// would call that one path N×2 times and prove no more than this does.
		const asked: string[] = [];
		const style = baseMapStyle(entry('streets'), {
			theme: 'light',
			// The editor's own `resolveDeploymentAsset` shape: concatenation onto a prefix, chosen because
			// `new URL()` would percent-encode the braces and MapLibre's plain-string substitution would
			// stop matching — leaving a style whose `glyphs` is a non-empty string that fetches nothing.
			resolveAsset: (path) => {
				asked.push(path);
				return `https://editor.test/${path}`;
			}
		});

		// The template the catalog names is what the resolver is handed, unmodified and unencoded…
		expect(asked).toContain(BASE_MAP_CATALOG.glyphs);
		// …and what comes back is the glyph URL, with the placeholders MapLibre fills in still intact.
		expect(style.glyphs).toBe(`https://editor.test/${BASE_MAP_CATALOG.glyphs}`);
		expect(style.glyphs).toContain('{fontstack}');
		expect(style.glyphs).toContain('{range}');
	});

	it('carries the tile attribution, which ODbL makes an obligation', () => {
		const source = baseMapStyle(entry('streets'), { theme: 'light' }).sources[BASE_MAP_SOURCE_ID];

		expect(source && 'attribution' in source ? source.attribution : '').toContain('OpenStreetMap');
	});
});

describe('baseMapStyle over a forked catalog', () => {
	// The forkability property: nothing about a style comes from anywhere but the entry and the
	// catalog it was given, so replacing the catalog module is the whole of pointing a fork at
	// its own tiles.
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
