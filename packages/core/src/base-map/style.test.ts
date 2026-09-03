import { describe, expect, it } from 'vitest';
import { namedFlavor } from '@protomaps/basemaps';

import { ANNOTATION_COLORS } from '../annotation/annotation';
import { NATIONAL_BOUNDARY_LAYER, SUBNATIONAL_BOUNDARY_LAYER } from './borders';
import { BASE_MAP_CATALOG } from './catalog';
import { CATALOG_WITHOUT_TERRAIN, FORKED_CATALOG } from './fixture-catalogs';
import { PHYSICAL_LAND } from './physical';
import { defaultEntry, resolveBaseMap } from './resolve';
import { archiveUrl, baseMapStyle, BASE_MAP_SOURCE_ID, bordersIllegibleThemes } from './style';
import { TERRAIN_CONTOUR_SOURCE_ID, TERRAIN_DEM_SOURCE_ID } from './terrain';
import { DEFAULT_BASE_MAP_APPEARANCE, type BaseMapAppearance } from './appearance';
import type { BaseMapEntry } from './entry';

const entry = (id: string, catalog = BASE_MAP_CATALOG): BaseMapEntry => {
	const found = catalog.entries.find((candidate) => candidate.id === id);
	if (found === undefined) throw new Error(`no such fixture entry: ${id}`);
	return found;
};

/** This deployment's tiles. There is one set of them; how they are drawn is the appearance. */
const tiles = defaultEntry(BASE_MAP_CATALOG);

/** The default appearance with some switches moved, so each test names only what it is about. */
const look = (patch: Partial<BaseMapAppearance> = {}): BaseMapAppearance => ({
	...DEFAULT_BASE_MAP_APPEARANCE,
	...patch
});

const layerIds = (
	appearance: BaseMapAppearance = look(),
	theme: 'light' | 'dark' = 'light'
): string[] => baseMapStyle(tiles, { theme, appearance }).layers.map((layer) => layer.id);

const paint = (styleLayers: { id: string; paint?: unknown }[], id: string): unknown =>
	styleLayers.find((layer) => layer.id === id)?.paint;

describe('baseMapStyle', () => {
	it('reads its tiles through the pmtiles protocol, from one archive', () => {
		const style = baseMapStyle(tiles, { theme: 'light' });
		const source = style.sources[BASE_MAP_SOURCE_ID];

		expect(Object.keys(style.sources)).toEqual([BASE_MAP_SOURCE_ID]);
		expect(source).toMatchObject({ type: 'vector' });
		expect(source && 'url' in source ? source.url : '').toMatch(/^pmtiles:\/\//);
	});

	it('reads the Workspace cache instead of the archive when asked, and keeps the attribution', () => {
		// ADR-0025: the cached case is a `tiles` template under our own protocol, with no archive
		// anywhere in it — and the ODbL obligation does not lapse because no request leaves the
		// machine, so the source carries the very same attribution string the networked one does.
		const cached = baseMapStyle(tiles, {
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
		const cached = baseMapStyle(tiles, {
			theme: 'light',
			cachedTiles: { maxZoom: 11, tileTemplate: 'x://{z}/{x}/{y}' }
		});
		const source = cached.sources[BASE_MAP_SOURCE_ID];
		expect(source && 'maxzoom' in source ? source.maxzoom : undefined).toBe(11);
	});

	it('keeps the glyphs, the sprite, and every layer when reading the cache', () => {
		// The cache changes where the *tiles* come from and nothing else: the same style documents over
		// one vector dataset is ADR-0020's zero-extra-bytes claim, and it has to survive caching.
		const networked = baseMapStyle(tiles, {
			theme: 'dark',
			appearance: look({ highContrast: true })
		});
		const cached = baseMapStyle(tiles, {
			theme: 'dark',
			appearance: look({ highContrast: true }),
			cachedTiles: { maxZoom: 14, tileTemplate: 'x://{z}/{x}/{y}' }
		});
		expect(cached.layers.map((layer) => layer.id)).toEqual(
			networked.layers.map((layer) => layer.id)
		);
		expect(cached.glyphs).toBe(networked.glyphs);
		expect(cached.sprite).toBe(networked.sprite);
	});

	it('builds every appearance over the very same archive URL', () => {
		// The zero-extra-data claim, and the reason the switches are switches: turning the streets off
		// or the colours down is a different style document over identical tiles, never a different
		// dataset. The relief is the one exception, and it has a source of its own that says so.
		const url = (appearance: BaseMapAppearance): string => {
			const source = baseMapStyle(tiles, { theme: 'light', appearance }).sources[
				BASE_MAP_SOURCE_ID
			];
			return source && 'url' in source ? (source.url ?? '') : '';
		};

		expect(url(look({ streets: false }))).toBe(url(look()));
		expect(url(look({ highContrast: true }))).toBe(url(look()));
	});

	it('drops the built environment when the streets are switched off', () => {
		const streets = layerIds(look());
		const bare = layerIds(look({ streets: false }));

		expect(streets.some((id) => id.startsWith('roads_'))).toBe(true);
		expect(streets).toContain('buildings');
		expect(bare.some((id) => id.startsWith('roads_'))).toBe(false);
		expect(bare).not.toContain('buildings');
	});

	it('drops the built environment drawn as an area, and keeps the natural world beside it', () => {
		const bare = layerIds(look({ streets: false }));

		// These share a `landuse_` prefix with the park and the beach, which is why `style.ts` names
		// them one at a time: a prefix filter here would take the subject of the map with them.
		for (const id of ['landuse_industrial', 'landuse_school', 'landuse_pedestrian']) {
			expect(layerIds(look())).toContain(id);
			expect(bare).not.toContain(id);
		}
		expect(bare).toContain('landuse_park');
		expect(bare).toContain('landuse_beach');
	});

	it('paints the park in the physical palette, not the low-zoom landcover ramp', () => {
		// The bug this replaces: `landcover.grassland` is what the `landcover` layer draws at z5-7,
		// where its own opacity has already reached zero by the zoom `landuse_park` fades in — so the
		// park was painted a shade off the earth at every zoom a reader actually looks at.
		const bare = paint(
			baseMapStyle(tiles, { theme: 'light', appearance: look({ streets: false }) }).layers,
			'landuse_park'
		);

		expect(JSON.stringify(bare)).toContain(PHYSICAL_LAND.light.park);
		expect(JSON.stringify(bare)).not.toContain(namedFlavor('light').landcover?.grassland);
	});

	it('keeps water, landcover, and place labels with the streets switched off', () => {
		const bare = layerIds(look({ streets: false }));

		expect(bare).toContain('water');
		expect(bare).toContain('landcover');
		expect(bare).toContain('places_locality');
	});

	it('draws both boundary layers by default, and they are the ids `borders.ts` names', () => {
		// ⚠ **This is the assertion that keeps the border control honest.** Every value it offers is a
		// filter over two layer ids, so a `@protomaps/basemaps` upgrade that renamed either one would
		// leave all three choices drawing the same map with nothing failing. The ids come from the
		// installed package here, not from a fixture, so the rename fails the build instead.
		const drawn = layerIds();

		expect(drawn).toContain(NATIONAL_BOUNDARY_LAYER);
		expect(drawn).toContain(SUBNATIONAL_BOUNDARY_LAYER);
	});

	it('draws the boundary lines heavier than the hairlines upstream ships', () => {
		// End-to-end over the real `@protomaps/basemaps` output rather than a fabricated layer: an
		// upgrade that changed upstream's widths would otherwise leave this passing against a fixture.
		const drawn = baseMapStyle(tiles, { theme: 'light' }).layers;
		const national = paint(drawn, NATIONAL_BOUNDARY_LAYER) as Record<string, unknown>;
		const subnational = paint(drawn, SUBNATIONAL_BOUNDARY_LAYER) as Record<string, unknown>;

		expect(national['line-width'] as number).toBeGreaterThan(0.7);
		expect(subnational['line-width'] as number).toBeGreaterThan(0.4);
	});

	it('repaints the boundary lines in both themes, and never the same colour in each', () => {
		// ADR-0016: a border legible on the pale map and invisible on the dark one is the failure the
		// theme argument exists to prevent, and a hardcoded colour is exactly how it happens.
		const light = baseMapStyle(tiles, { theme: 'light' }).layers;
		const dark = baseMapStyle(tiles, { theme: 'dark' }).layers;
		const colour = (styleLayers: typeof light): unknown =>
			(paint(styleLayers, NATIONAL_BOUNDARY_LAYER) as Record<string, unknown>)['line-color'];

		expect(colour(light)).not.toBe(colour(dark));
	});

	// ⚠ **This is the measurement that justifies the warning's threshold**, and the reason it is a
	// test rather than a comment: a chosen colour is one colour for both grounds, and the warning is
	// only worth reading if it separates the palette rather than firing on all of it. Three of the
	// nine clear both themes; the six that fail are the ones an author needs told.
	it('warns about the palette colours that cannot be seen on one of the two grounds', () => {
		const both: string[] = [];
		const oneOnly: string[] = [];
		for (const colour of ANNOTATION_COLORS) {
			const failing = bordersIllegibleThemes(look(), colour.value);
			(failing.length === 0 ? both : oneOnly).push(colour.name);
		}

		expect(both).toEqual(['Red', 'Green', 'Blue']);
		expect(oneOnly).toEqual(['Black', 'Grey', 'White', 'Orange', 'Yellow', 'Purple']);
	});

	it('names the theme a colour actually fails in, rather than both every time', () => {
		// White is invisible on the pale ground and perfectly legible on the dark one, and the warning
		// has to say which — an author on a dark screen is otherwise told their visible line is wrong.
		expect(bordersIllegibleThemes(look(), '#ffffff')).toEqual(['light']);
		expect(bordersIllegibleThemes(look(), '#000000')).toEqual(['dark']);
	});

	it('drops the divisions inside a nation for national, and both for none', () => {
		const national = baseMapStyle(tiles, { theme: 'light', borders: 'national' }).layers;
		const none = baseMapStyle(tiles, { theme: 'light', borders: 'none' }).layers;

		expect(national.map((layer) => layer.id)).toContain(NATIONAL_BOUNDARY_LAYER);
		expect(national.map((layer) => layer.id)).not.toContain(SUBNATIONAL_BOUNDARY_LAYER);
		expect(none.map((layer) => layer.id)).not.toContain(NATIONAL_BOUNDARY_LAYER);
		expect(none.map((layer) => layer.id)).not.toContain(SUBNATIONAL_BOUNDARY_LAYER);
	});

	it('takes nothing but the boundaries away, and reads the same one archive doing it', () => {
		// The zero-extra-data claim, restated for this control: hiding borders is a shorter layer list
		// over identical tiles, so it costs no request and cannot make a map go blank.
		const all = baseMapStyle(tiles, { theme: 'light', borders: 'all' });
		const none = baseMapStyle(tiles, { theme: 'light', borders: 'none' });
		const removed = all.layers
			.map((layer) => layer.id)
			.filter((id) => !none.layers.some((layer) => layer.id === id));

		expect(removed).toEqual([NATIONAL_BOUNDARY_LAYER, SUBNATIONAL_BOUNDARY_LAYER]);
		expect(none.sources).toEqual(all.sources);
	});

	it('hides borders under any appearance, because the boundaries are in the tiles', () => {
		for (const appearance of [look(), look({ streets: false }), look({ highContrast: true })]) {
			const none = baseMapStyle(tiles, { theme: 'light', appearance, borders: 'none' }).layers;
			expect(none.map((layer) => layer.id)).not.toContain(NATIONAL_BOUNDARY_LAYER);
		}
	});

	it('gives the streets their labels, which is what makes them a street map', () => {
		expect(layerIds()).toContain('roads_labels_major');
	});

	it('repaints the natural world with the streets off, over identical tiles', () => {
		const streets = baseMapStyle(tiles, { theme: 'light' }).layers;
		const bare = baseMapStyle(tiles, {
			theme: 'light',
			appearance: look({ streets: false })
		}).layers;

		expect(paint(bare, 'landuse_park')).not.toEqual(paint(streets, 'landuse_park'));
	});

	it('changes every colour with the theme', () => {
		const light = baseMapStyle(tiles, { theme: 'light' }).layers;
		const dark = baseMapStyle(tiles, { theme: 'dark' }).layers;

		expect(paint(dark, 'background')).not.toEqual(paint(light, 'background'));
		expect(paint(dark, 'water')).not.toEqual(paint(light, 'water'));
	});

	it('repaints the map when high contrast is on, and takes its sprite with it', () => {
		const contrast = baseMapStyle(tiles, {
			theme: 'light',
			appearance: look({ highContrast: true })
		});
		const ordinary = baseMapStyle(tiles, { theme: 'light' });

		expect(contrast.sprite).not.toBe(ordinary.sprite);
		expect(paint(contrast.layers, 'water')).not.toEqual(paint(ordinary.layers, 'water'));
		// `high-contrast.test.ts` owns the palette's ratios; what this file owns is that a style
		// document actually carries them rather than a flavor name that reads as one.
		expect(paint(contrast.layers, 'earth')).toMatchObject({ 'fill-color': '#ffffff' });
		expect(paint(contrast.layers, 'roads_major')).toMatchObject({ 'line-color': '#000000' });
	});

	it('keeps the three switches independent, so every combination is a different map', () => {
		// ⚠ **The assertion the named variants could not make.** Four entries covered four of these
		// eight, and the ones they left out — contours under a road network, a high-contrast palette
		// with the relief still shaded — were the combinations scholars asked for. A regression letting
		// one switch swallow another would still draw a map; only counting them catches it.
		const drawn = new Set<string>();
		for (const streets of [true, false]) {
			for (const relief of [true, false]) {
				for (const highContrast of [true, false]) {
					const style = baseMapStyle(tiles, {
						theme: 'light',
						appearance: { streets, relief, highContrast },
						terrainTiles: { dem: 'dem://x', contours: 'contour://x' }
					});
					drawn.add(
						JSON.stringify([
							style.sprite,
							style.layers.map((layer) => layer.id),
							paint(style.layers, 'landuse_park')
						])
					);
				}
			}
		}

		expect(drawn.size).toBe(8);
	});

	it('resolves relative asset paths through the caller, leaving placeholders intact', () => {
		const style = baseMapStyle(entry('harbour-charts', FORKED_CATALOG), {
			theme: 'light',
			resolveAsset: (path) => `https://example.test/site/${path}`
		});
		const source = style.sources[BASE_MAP_SOURCE_ID];

		expect(style.glyphs).toBe('https://example.test/site/base-map/fonts/{fontstack}/{range}.pbf');
		expect(style.sprite).toBe('https://example.test/site/base-map/sprites/light');
		expect(source && 'url' in source ? source.url : '').toBe(
			'pmtiles://https://example.test/site/tiles/harbours.pmtiles'
		);
	});

	it('leaves an already-absolute remote archive alone', () => {
		// Every shipped entry reads `REMOTE_ARCHIVE`, so this asserts against the catalog rather than a
		// fixture: it is the real archive URL a deployment would repoint (ADR-0020), and `resolveAsset`
		// prefixing it would produce a style that fetches nothing.
		expect(tiles.archive).toMatch(/^https:\/\//);
		expect(archiveUrl(tiles, (path) => `https://example.test/${path}`)).toBe(tiles.archive);
	});

	it('takes glyphs from the catalog alone, so no appearance or theme can be without them', () => {
		// A Label's words are shaped from the Base Map's typefaces, and the stack omits the
		// Label bucket where the style carries none (`styleHasGlyphs` in `render/stack-layers.ts`) — which
		// is the state of a Published Site written before ADR-0025. **The editor never reaches that
		// state**, and the reason is structural rather than statistical: `glyphs` is
		// `resolveAsset(catalog.glyphs)`, which reads neither the entry nor the theme, so there is one
		// code path and no entry-or-theme combination that can miss it. Looping the catalog × both themes
		// would call that one path N×2 times and prove no more than this does.
		const asked: string[] = [];
		const style = baseMapStyle(tiles, {
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
		const source = baseMapStyle(tiles, { theme: 'light' }).sources[BASE_MAP_SOURCE_ID];

		expect(source && 'attribution' in source ? source.attribution : '').toContain('OpenStreetMap');
	});
});

describe('a topographic Base Map', () => {
	// The registered protocol URLs the app hands in. Their shape does not matter here — this module
	// puts them in a source and never parses one — and standing in for them is what keeps
	// `maplibre-contour`, its worker, and its network out of a unit test.
	const terrainTiles = { dem: 'dem-protocol://shared', contours: 'contour-protocol://lines' };
	// The fork's own tiles under the topographic look a scholar reaches for: relief on, streets off.
	const topographic = () => entry('ordnance-relief', FORKED_CATALOG);
	const appearance = look({ streets: false, relief: true });
	const options = { theme: 'light' as const, catalog: FORKED_CATALOG, appearance, terrainTiles };

	it('draws relief and contours from one elevation dataset, described by the catalog', () => {
		const sources = baseMapStyle(topographic(), options).sources;

		expect(sources[TERRAIN_DEM_SOURCE_ID]).toMatchObject({
			type: 'raster-dem',
			tiles: [terrainTiles.dem],
			// Every one of these is the fork's, not this repository's: an entry pointed at a DEM in a
			// different encoding, ending at a different zoom, is the case ADR-0020 exists for.
			encoding: 'mapbox',
			maxzoom: 11
		});
		expect(sources[TERRAIN_CONTOUR_SOURCE_ID]).toMatchObject({
			type: 'vector',
			tiles: [terrainTiles.contours],
			maxzoom: 11
		});
	});

	it('carries the elevation attribution, which is a second obligation from a second dataset', () => {
		const dem = baseMapStyle(topographic(), options).sources[TERRAIN_DEM_SOURCE_ID];

		expect(dem && 'attribution' in dem ? dem.attribution : '').toBe(
			'Somebody else&rsquo;s elevations'
		);
	});

	it('shades beneath the water and rules its contours beneath the labels', () => {
		// The order is the whole of whether this looks like a map: shading over the sea makes the
		// water read as land, and contours over the place names makes them unreadable. Asserted by
		// position rather than by presence, because both failures still contain every layer.
		const layers = baseMapStyle(topographic(), options).layers;
		const ids = layers.map((layer) => layer.id);
		// The contour labels are themselves symbols, so the layer this stack must sit above is the
		// first symbol that is not part of it.
		const firstPlaceName = layers.findIndex(
			(layer) => layer.type === 'symbol' && !layer.id.startsWith('terrain_')
		);

		expect(ids.indexOf('terrain_hillshade')).toBeGreaterThan(ids.indexOf('earth'));
		expect(ids.indexOf('terrain_hillshade')).toBeLessThan(ids.indexOf('water'));
		expect(ids.indexOf('terrain_contours')).toBeGreaterThan(ids.indexOf('water'));
		expect(ids.indexOf('terrain_contour_labels')).toBe(firstPlaceName - 1);
	});

	it('drops the built environment when the streets are off, and keeps it when they are on', () => {
		// **The combination the named variants could not offer**: contour lines under a road network.
		// Relief and streets are independent switches, so a topographic map is not implicitly a
		// physical one.
		const bare = baseMapStyle(topographic(), options).layers.map((layer) => layer.id);
		const withStreets = baseMapStyle(topographic(), {
			...options,
			appearance: look({ relief: true })
		}).layers.map((layer) => layer.id);

		expect(bare.some((id) => id.startsWith('roads_'))).toBe(false);
		expect(bare).toContain('water');
		expect(withStreets.some((id) => id.startsWith('roads_'))).toBe(true);
		expect(withStreets).toContain('terrain_contours');
	});

	it('draws terrain without relief where the deployment has provisioned no elevation dataset', () => {
		// A fork editing the catalog must not be able to produce a blank pane. The map loses its
		// relief and keeps everything else.
		const style = baseMapStyle(entry('ordnance-relief', CATALOG_WITHOUT_TERRAIN), {
			theme: 'light',
			catalog: CATALOG_WITHOUT_TERRAIN,
			appearance,
			terrainTiles
		});

		expect(Object.keys(style.sources)).toEqual([BASE_MAP_SOURCE_ID]);
		expect(style.layers.map((layer) => layer.id)).toContain('water');
		expect(style.layers.some((layer) => layer.id.startsWith('terrain_'))).toBe(false);
	});

	it('draws no relief where the caller registered no protocols to serve it', () => {
		const style = baseMapStyle(topographic(), {
			theme: 'light',
			catalog: FORKED_CATALOG,
			appearance
		});

		expect(Object.keys(style.sources)).toEqual([BASE_MAP_SOURCE_ID]);
		expect(style.layers.some((layer) => layer.id.startsWith('terrain_'))).toBe(false);
	});

	it('draws no relief over the offline cache, whose promise the DEM cannot keep', () => {
		// The cache holds tiles from the vector archive. The DEM is a second host and a live request,
		// so shading a Project that was called available offline would make the claim false at
		// exactly the moment somebody relies on it (ADR-0025).
		const style = baseMapStyle(topographic(), {
			...options,
			cachedTiles: { maxZoom: 14, tileTemplate: 'workspace://{z}/{x}/{y}.mvt' }
		});

		expect(Object.keys(style.sources)).toEqual([BASE_MAP_SOURCE_ID]);
		expect(style.layers.some((layer) => layer.id.startsWith('terrain_'))).toBe(false);
	});

	it('leaves a map drawing no relief without a second source', () => {
		const streets = baseMapStyle(entry('parish-roads', FORKED_CATALOG), {
			...options,
			appearance: look()
		});

		expect(Object.keys(streets.sources)).toEqual([BASE_MAP_SOURCE_ID]);
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
		expect(style.sprite).toBe('icons/light');
		expect(source && 'attribution' in source ? source.attribution : '').toBe(
			'Somebody else entirely'
		);
	});

	it('draws a physical high-contrast map over a forked archive, landcover and all', () => {
		const style = baseMapStyle(entry('harbour-charts', FORKED_CATALOG), {
			...options,
			appearance: look({ streets: false, highContrast: true })
		});

		// `white` has no landcover colours to borrow, so the high-contrast palette brings its own —
		// without them the combination a low-vision Reader most needs is a blank rectangle.
		expect(style.sprite).toBe('icons/white');
		expect(style.layers.some((layer) => layer.id.startsWith('roads_'))).toBe(false);
		expect(style.layers.some((layer) => layer.id === 'water')).toBe(true);
		expect(paint(style.layers, 'landuse_park')).not.toMatchObject({ 'fill-color': '#ffffff' });
	});

	it('resolves a forked default, and falls back to it, without the real catalog involved', () => {
		expect(resolveBaseMap('streets', FORKED_CATALOG).entry.id).toBe('parish-roads');
		expect(resolveBaseMap('streets', FORKED_CATALOG).fellBack).toBe(true);
	});
});
