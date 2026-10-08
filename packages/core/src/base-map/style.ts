import type { LayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { layers, namedFlavor, type Flavor } from '@protomaps/basemaps';

import {
	borderColorIsLegible,
	bordersInclude,
	DEFAULT_BASE_MAP_BORDER_STYLE,
	DEFAULT_BASE_MAP_BORDERS,
	NATIONAL_BOUNDARY_LAYER,
	strengthenedBorder,
	type BaseMapBorders,
	type BaseMapBorderStyle
} from './borders';
import {
	baseMapFlavorName,
	DEFAULT_BASE_MAP_APPEARANCE,
	drawnAppearance,
	type BaseMapAppearance
} from './appearance';
import { BASE_MAP_CATALOG } from './catalog';
import { highContrastFlavor } from './high-contrast';
import {
	IMAGERY_SOURCE_ID,
	imageryLayer,
	imageryReplaces,
	imagerySource,
	isWaterFill,
	regionalImageryId,
	regionalImageryLayer,
	regionalImagerySource
} from './imagery';
import { physicalFlavor, withLand } from './physical';
import type { BaseMapCatalog, BaseMapEntry } from './entry';
import {
	contourLayers,
	hillshadeLayer,
	terrainSources,
	type TerrainTileTemplates
} from './terrain';
import { themeScheme, type Theme, type ThemeScheme } from '../theme';

export const BASE_MAP_SOURCE_ID = 'protomaps';
const LABEL_LANGUAGE = 'en';
const BUILT_ENVIRONMENT_PREFIXES = ['roads_', 'buildings', 'address_label', 'pois'] as const;

const BUILT_ENVIRONMENT_LAYERS = [
	'landuse_hospital',
	'landuse_industrial',
	'landuse_school',
	'landuse_pedestrian',
	'landuse_aerodrome',
	'landuse_runway',
	'landuse_pier'
] as const;

const identity = (path: string): string => path;
export const isAbsoluteUrl = (candidate: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(candidate);

export function baseMapStyle(
	entry: BaseMapEntry,
	options: {
		readonly theme: Theme;
		readonly appearance?: BaseMapAppearance;
		readonly catalog?: BaseMapCatalog;
		readonly resolveAsset?: (path: string) => string;
		readonly cachedTiles?: { readonly maxZoom: number; readonly tileTemplate: string };
		readonly borders?: BaseMapBorders;
		readonly borderStyle?: BaseMapBorderStyle;
		// Passed in because minting them registers MapLibre protocols, and this module runs in Node during prerender.
		readonly terrainTiles?: TerrainTileTemplates;
		readonly pixelRatio?: number;
	}
): StyleSpecification {
	const catalog = options.catalog ?? BASE_MAP_CATALOG;
	const resolveAsset = options.resolveAsset ?? identity;
	const appearance = drawnAppearance(options.appearance ?? DEFAULT_BASE_MAP_APPEARANCE);
	const scheme = themeScheme(options.theme);
	const flavor = appearanceFlavor(appearance, scheme);
	const online = options.cachedTiles === undefined;
	const terrain =
		appearance.relief && online && catalog.terrain && options.terrainTiles
			? terrainSources(catalog.terrain, options.terrainTiles)
			: null;
	const imagery = (appearance.imagery && online && catalog.imagery) || null;
	const regionalImagery = imagery === null ? [] : (catalog.regionalImagery ?? []);
	const located = (tiles: string) => (isAbsoluteUrl(tiles) ? tiles : resolveAsset(tiles));
	const pixelRatio = options.pixelRatio ?? 1;

	const vector = appearanceLayers(
		layers(BASE_MAP_SOURCE_ID, flavor, { lang: LABEL_LANGUAGE }),
		appearance
	)
		.filter((layer) => bordersInclude(options.borders ?? DEFAULT_BASE_MAP_BORDERS, layer.id))
		.filter((layer) => imagery === null || !imageryReplaces(layer))
		.map((layer) =>
			strengthenedBorder(layer, flavor, options.borderStyle ?? DEFAULT_BASE_MAP_BORDER_STYLE)
		);

	return {
		version: 8,
		glyphs: resolveAsset(catalog.glyphs),
		sprite: resolveAsset(catalog.sprite).replace('{flavor}', baseMapFlavorName(appearance, scheme)),
		sources: {
			[BASE_MAP_SOURCE_ID]: {
				type: 'vector',
				attribution: catalog.attribution,
				...(options.cachedTiles
					? {
							// Without `maxzoom` MapLibre asks past the cached pyramid and the map goes blank instead of overzooming.
							tiles: [options.cachedTiles.tileTemplate],
							minzoom: 0,
							maxzoom: options.cachedTiles.maxZoom
						}
					: { url: `pmtiles://${archiveUrl(entry, resolveAsset)}` })
			},
			...terrain,
			...(imagery && {
				[IMAGERY_SOURCE_ID]: imagerySource(imagery, located(imagery.tiles), pixelRatio)
			}),
			...Object.fromEntries(
				regionalImagery.map((regional, index) => [
					regionalImageryId(index),
					regionalImagerySource(regional, located(regional.tiles), pixelRatio)
				])
			)
		},
		// The imagery goes in after the relief, so the hillshade's anchors are found among the vector layers alone.
		layers: [
			...(imagery === null
				? []
				: [
						imageryLayer(),
						...regionalImagery.map((regional, index) => regionalImageryLayer(regional, index))
					]),
			...(terrain === null ? vector : withRelief(vector, flavor))
		]
	};
}

export function automaticBorderStyle(
	appearance: BaseMapAppearance,
	theme: Theme
): BaseMapBorderStyle {
	const flavor = appearanceFlavor(appearance, themeScheme(theme));
	const drawn = strengthenedBorder(
		{
			id: NATIONAL_BOUNDARY_LAYER,
			type: 'line',
			source: BASE_MAP_SOURCE_ID,
			'source-layer': 'boundaries'
		},
		flavor
	);
	const paint = ('paint' in drawn ? drawn.paint : {}) as Record<string, unknown>;
	return {
		color: typeof paint['line-color'] === 'string' ? paint['line-color'] : null,
		lineStyle: 'dashed',
		width: typeof paint['line-width'] === 'number' ? paint['line-width'] : null
	};
}

export function bordersIllegibleThemes(
	appearance: BaseMapAppearance,
	colour: string
): readonly ('light' | 'dark')[] {
	return (['light', 'dark'] as const).filter(
		(scheme) => !borderColorIsLegible(colour, appearanceFlavor(appearance, scheme).earth)
	);
}

function withRelief(all: LayerSpecification[], flavor: Flavor): LayerSpecification[] {
	const anchor = (found: number, fallback: number) => (found === -1 ? fallback : found);
	const beneathLabels = anchor(
		all.findIndex((layer) => layer.type === 'symbol'),
		all.length
	);
	const beneathWater = anchor(all.findIndex(isWaterFill), beneathLabels);
	const stacked: LayerSpecification[] = [];
	for (let index = 0; index <= all.length; index += 1) {
		if (index === beneathWater) stacked.push(hillshadeLayer());
		if (index === beneathLabels) stacked.push(...contourLayers(flavor));
		const layer = all[index];
		if (layer !== undefined) stacked.push(layer);
	}
	return stacked;
}

export function archiveUrl(
	entry: BaseMapEntry,
	resolveAsset: (path: string) => string = identity
): string {
	return isAbsoluteUrl(entry.archive) ? entry.archive : resolveAsset(entry.archive);
}

function appearanceLayers(
	all: LayerSpecification[],
	appearance: BaseMapAppearance
): LayerSpecification[] {
	if (appearance.streets) return all;
	return all.filter(
		(layer) =>
			!BUILT_ENVIRONMENT_PREFIXES.some((prefix) => layer.id.startsWith(prefix)) &&
			!BUILT_ENVIRONMENT_LAYERS.some((id) => id === layer.id)
	);
}

function appearanceFlavor(chosen: BaseMapAppearance, scheme: ThemeScheme): Flavor {
	const appearance = drawnAppearance(chosen);
	const named = namedFlavor(baseMapFlavorName(appearance, scheme));
	const flavor = appearance.highContrast ? highContrastFlavor(named, scheme) : named;
	if (appearance.streets) return flavor;
	return appearance.highContrast ? contrastLandFlavor(flavor) : physicalFlavor(flavor, scheme);
}

function contrastLandFlavor(flavor: Flavor): Flavor {
	const landcover = flavor.landcover;
	if (landcover === undefined) return flavor;
	return withLand(flavor, {
		park: landcover.grassland,
		wood: landcover.forest,
		scrub: landcover.scrub,
		sand: landcover.barren,
		beach: landcover.barren,
		glacier: landcover.glacier
	});
}
