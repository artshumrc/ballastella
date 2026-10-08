import { describe, expect, it } from 'vitest';
import { namedFlavor } from '@protomaps/basemaps';

import { ANNOTATION_COLORS } from '../annotation/annotation';
import { NATIONAL_BOUNDARY_LAYER, SUBNATIONAL_BOUNDARY_LAYER } from './borders';
import { BASE_MAP_CATALOG } from './catalog';
import { CATALOG_WITHOUT_TERRAIN, FORKED_CATALOG } from './fixture-catalogs';
import { IMAGERY_LAYER, IMAGERY_SOURCE_ID, regionalImageryId } from './imagery';
import { PHYSICAL_LAND } from './physical';
import { defaultEntry, resolveBaseMap } from './resolve';
import { archiveUrl, baseMapStyle, BASE_MAP_SOURCE_ID, bordersIllegibleThemes } from './style';
import { TERRAIN_CONTOUR_SOURCE_ID, TERRAIN_DEM_SOURCE_ID } from './terrain';
import { DEFAULT_BASE_MAP_APPEARANCE, type BaseMapAppearance } from './appearance';
import type { BaseMapCatalog, BaseMapEntry, BaseMapRegionalImagery } from './entry';

const entry = (id: string, catalog = BASE_MAP_CATALOG): BaseMapEntry => {
	const found = catalog.entries.find((candidate) => candidate.id === id);
	if (found === undefined) throw new Error(`no such fixture entry: ${id}`);
	return found;
};

const tiles = defaultEntry(BASE_MAP_CATALOG);

const look = (patch: Partial<BaseMapAppearance> = {}): BaseMapAppearance => ({
	...DEFAULT_BASE_MAP_APPEARANCE,
	...patch
});

type Style = ReturnType<typeof baseMapStyle>;

type Options = Parameters<typeof baseMapStyle>[1];

const styled = (options: Partial<Options> = {}, from: BaseMapEntry = tiles): Style =>
	baseMapStyle(from, { theme: 'light', ...options });

const forked = (options: Partial<Options> = {}, catalog = FORKED_CATALOG): Style =>
	styled({ catalog, ...options }, entry('harbour-charts', catalog));

const sourceField = (style: Style, field: string, id = BASE_MAP_SOURCE_ID): unknown =>
	(style.sources[id] as Record<string, unknown> | undefined)?.[field];

const idsOf = (style: Style): string[] => style.layers.map((layer) => layer.id);

const layerIds = (appearance: BaseMapAppearance = look(), theme: 'light' | 'dark' = 'light') =>
	idsOf(styled({ theme, appearance }));

const paint = (styleLayers: { id: string; paint?: unknown }[], id: string): unknown =>
	styleLayers.find((layer) => layer.id === id)?.paint;

const hasRoads = (ids: string[]) => ids.some((id) => id.startsWith('roads_'));

describe('baseMapStyle', () => {
	it('reads its tiles through the pmtiles protocol, from one archive whatever the appearance, attributed', () => {
		const style = styled();
		expect(Object.keys(style.sources)).toEqual([BASE_MAP_SOURCE_ID]);
		expect(style.sources[BASE_MAP_SOURCE_ID]).toMatchObject({ type: 'vector' });
		expect(sourceField(style, 'url')).toMatch(/^pmtiles:\/\//);
		expect(sourceField(style, 'attribution')).toContain('OpenStreetMap');
		const url = (appearance: BaseMapAppearance) => sourceField(styled({ appearance }), 'url');
		expect(url(look({ streets: false }))).toBe(url(look()));
		expect(url(look({ highContrast: true }))).toBe(url(look()));
	});

	it('reads the Workspace cache to its filled zoom when asked, keeping attribution, glyphs, sprite and layers', () => {
		const options = { theme: 'dark', appearance: look({ highContrast: true }) } as const;
		const networked = styled(options);
		const cached = styled({
			...options,
			cachedTiles: { maxZoom: 11, tileTemplate: 'x://{z}/{x}/{y}' }
		});

		expect(cached.sources[BASE_MAP_SOURCE_ID]).toMatchObject({
			type: 'vector',
			tiles: ['x://{z}/{x}/{y}'],
			minzoom: 0,
			maxzoom: 11
		});
		expect(sourceField(cached, 'url')).toBeUndefined();
		expect(sourceField(cached, 'attribution')).toBe(BASE_MAP_CATALOG.attribution);
		expect(sourceField(cached, 'attribution')).toContain('OpenStreetMap');
		expect([idsOf(cached), cached.glyphs, cached.sprite]).toEqual([
			idsOf(networked),
			networked.glyphs,
			networked.sprite
		]);
	});

	it('drops the built environment, lines and areas, with the streets off, and keeps the natural world and places', () => {
		const streets = layerIds(look());
		const bare = layerIds(look({ streets: false }));
		const built = [
			'buildings',
			'roads_labels_major',
			'landuse_industrial',
			'landuse_school',
			'landuse_pedestrian'
		];
		expect(hasRoads(streets)).toBe(true);
		expect(streets).toEqual(expect.arrayContaining(built));
		expect(hasRoads(bare)).toBe(false);
		expect(bare.filter((id) => built.includes(id))).toEqual([]);
		expect(bare).toEqual(
			expect.arrayContaining([
				'landuse_park',
				'landuse_beach',
				'water',
				'landcover',
				'places_locality'
			])
		);
	});

	it('repaints the park with the streets off in the physical palette, not the low-zoom landcover ramp', () => {
		const streets = paint(styled().layers, 'landuse_park');
		const bare = paint(styled({ appearance: look({ streets: false }) }).layers, 'landuse_park');
		expect(bare).not.toEqual(streets);
		expect(JSON.stringify(bare)).toContain(PHYSICAL_LAND.light.park);
		expect(JSON.stringify(bare)).not.toContain(namedFlavor('light').landcover?.grassland);
	});

	it('draws both `borders.ts` boundary layers by default, heavier than upstream’s hairlines, coloured per theme', () => {
		const line = (theme: 'light' | 'dark', id: string) =>
			paint(styled({ theme }).layers, id) as Record<string, unknown>;
		expect(layerIds()).toEqual(
			expect.arrayContaining([NATIONAL_BOUNDARY_LAYER, SUBNATIONAL_BOUNDARY_LAYER])
		);
		expect(line('light', NATIONAL_BOUNDARY_LAYER)['line-width'] as number).toBeGreaterThan(0.7);
		expect(line('light', SUBNATIONAL_BOUNDARY_LAYER)['line-width'] as number).toBeGreaterThan(0.4);
		expect(line('light', NATIONAL_BOUNDARY_LAYER)['line-color']).not.toBe(
			line('dark', NATIONAL_BOUNDARY_LAYER)['line-color']
		);
	});

	it('warns about the palette colours that cannot be seen on one ground, naming the one they fail in', () => {
		const both: string[] = [];
		const oneOnly: string[] = [];
		for (const colour of ANNOTATION_COLORS) {
			(bordersIllegibleThemes(look(), colour.value).length === 0 ? both : oneOnly).push(
				colour.name
			);
		}

		expect(both).toEqual(['Red', 'Green', 'Blue']);
		expect(oneOnly).toEqual(['Black', 'Grey', 'White', 'Orange', 'Yellow', 'Purple']);
		expect(bordersIllegibleThemes(look(), '#ffffff')).toEqual(['light']);
		expect(bordersIllegibleThemes(look(), '#000000')).toEqual(['dark']);
	});

	it('drops subnational boundaries for national, and nothing but both for none, under any appearance', () => {
		const all = styled({ borders: 'all' });
		const none = styled({ borders: 'none' });
		const national = idsOf(styled({ borders: 'national' }));
		expect(national).toContain(NATIONAL_BOUNDARY_LAYER);
		expect(national).not.toContain(SUBNATIONAL_BOUNDARY_LAYER);
		expect(idsOf(all).filter((id) => !idsOf(none).includes(id))).toEqual([
			NATIONAL_BOUNDARY_LAYER,
			SUBNATIONAL_BOUNDARY_LAYER
		]);
		expect(none.sources).toEqual(all.sources);
		for (const appearance of [look(), look({ streets: false }), look({ highContrast: true })]) {
			expect(idsOf(styled({ appearance, borders: 'none' }))).not.toContain(NATIONAL_BOUNDARY_LAYER);
		}
	});

	it('changes every colour with the theme', () => {
		const light = styled().layers;
		const dark = styled({ theme: 'dark' }).layers;
		expect(paint(dark, 'background')).not.toEqual(paint(light, 'background'));
		expect(paint(dark, 'water')).not.toEqual(paint(light, 'water'));
	});

	it('repaints the map when high contrast is on, and takes its sprite with it', () => {
		const contrast = styled({ appearance: look({ highContrast: true }) });
		const ordinary = styled();
		expect(contrast.sprite).not.toBe(ordinary.sprite);
		expect(paint(contrast.layers, 'water')).not.toEqual(paint(ordinary.layers, 'water'));
		expect(paint(contrast.layers, 'earth')).toMatchObject({ 'fill-color': '#ffffff' });
		expect(paint(contrast.layers, 'roads_major')).toMatchObject({ 'line-color': '#000000' });
	});

	it('keeps the switches independent but for the one exclusion, so each combination is its own map', () => {
		const drawn = new Set<string>();
		const both = [true, false];
		for (const streets of both)
			for (const relief of both)
				for (const highContrast of both)
					for (const imagery of both) {
						const style = styled({
							appearance: { streets, relief, highContrast, imagery },
							terrainTiles: { dem: 'dem://x', contours: 'contour://x' }
						});
						drawn.add(
							JSON.stringify([style.sprite, idsOf(style), paint(style.layers, 'landuse_park')])
						);
					}

		expect(drawn.size).toBe(12);
	});

	it('draws no high-contrast palette over the imagery, and says so in the appearance', () => {
		const satellite = forked({ appearance: look({ imagery: true, highContrast: true }) });
		const plain = forked({ appearance: look({ imagery: true }) });
		expect(satellite.sprite).toBe(plain.sprite);
		expect(JSON.stringify(satellite.layers)).toBe(JSON.stringify(plain.layers));
	});

	it('resolves relative asset paths through the caller, leaving placeholders intact', () => {
		const style = styled(
			{ resolveAsset: (path) => `https://example.test/site/${path}` },
			entry('harbour-charts', FORKED_CATALOG)
		);

		expect(style.glyphs).toBe('https://example.test/site/base-map/fonts/{fontstack}/{range}.pbf');
		expect(style.sprite).toBe('https://example.test/site/base-map/sprites/light');
		expect(sourceField(style, 'url')).toBe(
			'pmtiles://https://example.test/site/tiles/harbours.pmtiles'
		);
	});

	it('leaves an already-absolute remote archive alone', () => {
		expect(tiles.archive).toMatch(/^https:\/\//);
		expect(archiveUrl(tiles, (path) => `https://example.test/${path}`)).toBe(tiles.archive);
	});

	it('takes glyphs from the catalog alone, so no appearance or theme can be without them', () => {
		const asked: string[] = [];
		const style = styled({
			resolveAsset: (path) => (asked.push(path), `https://editor.test/${path}`)
		});

		expect(asked).toContain(BASE_MAP_CATALOG.glyphs);
		expect(style.glyphs).toBe(`https://editor.test/${BASE_MAP_CATALOG.glyphs}`);
		expect(style.glyphs).toMatch(/\{fontstack\}.*\{range\}/);
	});
});

describe('a topographic Base Map', () => {
	const terrainTiles = { dem: 'dem-protocol://shared', contours: 'contour-protocol://lines' };
	const topographic = entry('ordnance-relief', FORKED_CATALOG);
	const appearance = look({ streets: false, relief: true });
	const options = { catalog: FORKED_CATALOG, appearance, terrainTiles };
	const relief = (patch: Partial<Options> = {}, from = topographic) =>
		styled({ ...options, ...patch }, from);

	it('draws relief and contours from one elevation dataset the catalog describes and attributes', () => {
		const sources = relief().sources;

		expect(sources[TERRAIN_DEM_SOURCE_ID]).toMatchObject({
			type: 'raster-dem',
			tiles: [terrainTiles.dem],
			encoding: 'mapbox',
			maxzoom: 11,
			attribution: 'Somebody else&rsquo;s elevations'
		});
		expect(sources[TERRAIN_CONTOUR_SOURCE_ID]).toMatchObject({
			type: 'vector',
			tiles: [terrainTiles.contours],
			maxzoom: 11
		});
	});

	it('shades beneath the water and rules its contours beneath the labels', () => {
		const layers = relief().layers;
		const ids = layers.map((layer) => layer.id);
		const firstPlaceName = layers.findIndex(
			(layer) => layer.type === 'symbol' && !layer.id.startsWith('terrain_')
		);

		expect(ids.indexOf('terrain_hillshade')).toBeGreaterThan(ids.indexOf('earth'));
		expect(ids.indexOf('terrain_hillshade')).toBeLessThan(ids.indexOf('water'));
		expect(ids.indexOf('terrain_contours')).toBeGreaterThan(ids.indexOf('water'));
		expect(ids.indexOf('terrain_contour_labels')).toBe(firstPlaceName - 1);
	});

	it('drops the built environment when the streets are off, and keeps it when they are on', () => {
		const bare = idsOf(relief());
		const withStreets = idsOf(relief({ appearance: look({ relief: true }) }));
		expect([hasRoads(bare), hasRoads(withStreets)]).toEqual([false, true]);
		expect(bare).toContain('water');
		expect(withStreets).toContain('terrain_contours');
	});

	it.each([
		[
			'where the deployment has provisioned no elevation dataset',
			() =>
				relief(
					{ catalog: CATALOG_WITHOUT_TERRAIN },
					entry('ordnance-relief', CATALOG_WITHOUT_TERRAIN)
				)
		],
		[
			'where the caller registered no protocols to serve it',
			() => styled({ catalog: FORKED_CATALOG, appearance }, topographic)
		],
		[
			'over the offline cache, whose promise the DEM cannot keep',
			() => relief({ cachedTiles: { maxZoom: 14, tileTemplate: 'workspace://{z}/{x}/{y}.mvt' } })
		],
		[
			'for a map that draws none, without a second source',
			() => relief({ appearance: look() }, entry('parish-roads', FORKED_CATALOG))
		]
	])('draws the map but no relief %s', (_where, draw) => {
		const style = draw();
		expect(Object.keys(style.sources)).toEqual([BASE_MAP_SOURCE_ID]);
		expect(style.layers.some((layer) => layer.id.startsWith('terrain_'))).toBe(false);
		expect(idsOf(style)).toContain('water');
	});
});

describe('baseMapStyle over a forked catalog', () => {
	const satellite = (patch: Partial<Options> = {}) =>
		forked({ appearance: look({ imagery: true }), ...patch });

	it('takes its archive, glyphs, sprite, and attribution from the catalog it was given', () => {
		const style = forked();
		expect(sourceField(style, 'url')).toBe('pmtiles://tiles/harbours.pmtiles');
		expect(style.glyphs).toBe('typefaces/{fontstack}/{range}.pbf');
		expect(style.sprite).toBe('icons/light');
		expect(sourceField(style, 'attribution')).toBe('Somebody else entirely');
	});

	it('draws the imagery under the map and takes away the ground it stands in for', () => {
		const ids = idsOf(satellite());
		expect(ids[0]).toBe(IMAGERY_LAYER);
		expect(
			ids.filter((id) => ['earth', 'landcover', 'landuse_park', 'water'].includes(id))
		).toEqual([]);
		expect(hasRoads(ids)).toBe(true);
		expect(ids).toEqual(
			expect.arrayContaining(['places_locality', NATIONAL_BOUNDARY_LAYER, 'water_stream'])
		);
	});

	it('states the imagery source’s depth, tile size and attribution, a zoom deeper on a dense screen', () => {
		expect(satellite().sources[IMAGERY_SOURCE_ID]).toMatchObject({
			type: 'raster',
			maxzoom: 9,
			tileSize: 512,
			attribution: 'Somebody else&rsquo;s photographs'
		});
		const tileSize = (pixelRatio: number) =>
			sourceField(satellite({ pixelRatio }), 'tileSize', IMAGERY_SOURCE_ID);
		expect([1, 1.25, 2, 3].map(tileSize)).toEqual([512, 512, 256, 256]);
	});

	describe('with regional imagery', () => {
		const regional: BaseMapRegionalImagery = {
			tiles: 'https://sharper.example.invalid/export?bbox={bbox-epsg-3857}',
			bounds: [-10, 40, 5, 52],
			minZoom: 13,
			maxZoom: 18,
			tileSize: 256,
			attribution: 'Somebody nearer&rsquo;s photographs'
		};
		const catalog: BaseMapCatalog = { ...FORKED_CATALOG, regionalImagery: [regional] };
		const regionally = (patch: Partial<BaseMapAppearance>, over: BaseMapCatalog = catalog) =>
			forked({ appearance: look(patch), pixelRatio: 2 }, over);

		it('draws it over the worldwide imagery, only inside its bounds and from its zoom', () => {
			const style = regionally({ imagery: true });
			expect(idsOf(style).slice(0, 2)).toEqual([IMAGERY_LAYER, regionalImageryId(0)]);
			expect(style.layers[1]).toMatchObject({ type: 'raster', minzoom: 13 });
			expect(style.sources[regionalImageryId(0)]).toMatchObject({
				type: 'raster',
				tiles: [regional.tiles],
				bounds: [-10, 40, 5, 52],
				maxzoom: 18,
				tileSize: 128,
				attribution: regional.attribution
			});
		});

		it('draws none of it with the satellite off, or with no worldwide imagery beneath', () => {
			const withoutImagery = { ...CATALOG_WITHOUT_TERRAIN, regionalImagery: [regional] };
			expect(regionally({ imagery: false }).sources[regionalImageryId(0)]).toBeUndefined();
			expect(
				regionally({ imagery: true }, withoutImagery).sources[regionalImageryId(0)]
			).toBeUndefined();
		});
	});

	it.each([
		[
			'the deployment has provisioned no imagery',
			() => forked({ appearance: look({ imagery: true }) }, CATALOG_WITHOUT_TERRAIN)
		],
		[
			'the Base Map is read from the offline cache',
			() => satellite({ cachedTiles: { maxZoom: 12, tileTemplate: 'cached://{z}/{x}/{y}' } })
		]
	])('draws the vector ground and no imagery when %s', (_when, draw) => {
		const style = draw();
		expect(style.sources[IMAGERY_SOURCE_ID]).toBeUndefined();
		expect(idsOf(style)).toContain('earth');
	});

	it('keeps the relief beneath the labels when the imagery has taken the water fill away', () => {
		const style = satellite({
			appearance: look({ imagery: true, relief: true }),
			terrainTiles: { dem: 'dem://x', contours: 'contour://x' }
		});
		const firstSymbol = style.layers.findIndex((layer) => layer.type === 'symbol');
		expect(idsOf(style).findIndex((id) => id.includes('hillshade'))).toBeLessThan(firstSymbol);
	});

	it('draws a physical high-contrast map over a forked archive, landcover and all', () => {
		const style = forked({ appearance: look({ streets: false, highContrast: true }) });
		expect(style.sprite).toBe('icons/white');
		expect(hasRoads(idsOf(style))).toBe(false);
		expect(idsOf(style)).toContain('water');
		expect(paint(style.layers, 'landuse_park')).not.toMatchObject({ 'fill-color': '#ffffff' });
	});

	it('resolves a forked default, and falls back to it, without the real catalog involved', () => {
		expect(resolveBaseMap('streets', FORKED_CATALOG)).toMatchObject({
			entry: { id: 'parish-roads' },
			fellBack: true
		});
	});
});
