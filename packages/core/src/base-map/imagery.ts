import type {
	LayerSpecification,
	RasterSourceSpecification
} from '@maplibre/maplibre-gl-style-spec';

import type { BaseMapImagery, BaseMapRegionalImagery } from './entry';

/** The raster source the imagery is drawn from. One source, one layer. */
export const IMAGERY_SOURCE_ID = 'satellite';

/** The layer id, so a caller can find the imagery in a built style without matching on type. */
export const IMAGERY_LAYER = 'satellite';

/** Source and layer id of the catalog's `index`th regional imagery. */
export const regionalImageryId = (index: number): string => `${IMAGERY_LAYER}-regional-${index}`;

/**
 * Layer ids the imagery replaces, beside every `landuse_` layer and every water fill.
 *
 * **Replaced rather than drawn under**, because each of these is an opaque fill covering the whole
 * viewport: left in, the imagery is loaded, paid for, and invisible. What they draw — the shape of
 * the land, where the woods and the fields are, where the water is — is what a photograph shows
 * directly, so this is the one switch whose layers are redundant rather than unwanted.
 */
const GROUND_LAYERS = ['background', 'earth', 'landcover'] as const;

/**
 * Whether a layer draws ground the imagery stands in for.
 *
 * Water fills go and water *lines* stay: a stream or a river at the width OpenStreetMap draws it is
 * a feature Sentinel-2's 10 m/px cannot resolve, so the vector line is carrying information the
 * photograph does not have. A lake fill is the opposite — the imagery has it, better.
 */
export function imageryReplaces(layer: LayerSpecification): boolean {
	if (GROUND_LAYERS.some((id) => id === layer.id)) return true;
	if (layer.id.startsWith('landuse_')) return true;
	return layer.type === 'fill' && 'source-layer' in layer && layer['source-layer'] === 'water';
}

/**
 * The raster source for one deployment's imagery.
 *
 * `maxzoom` is the imagery's own depth rather than a display limit: with it MapLibre overzooms the
 * deepest real tile, and without it the map asks for tiles past the pyramid and shows blank ground
 * at exactly the zoom somebody leaned in at.
 */
export function imagerySource(
	imagery: BaseMapImagery,
	tiles: string,
	pixelRatio: number
): RasterSourceSpecification {
	return {
		type: 'raster',
		tiles: [tiles],
		minzoom: 0,
		maxzoom: imagery.maxZoom,
		// MapLibre picks raster zooms by CSS pixels, so on a dense screen every tile is stretched
		// across twice its pixels. Declaring half the size fetches one zoom deeper; placement is by
		// tile coordinate, so the photograph stays where it was.
		tileSize: pixelRatio >= 1.5 ? imagery.tileSize / 2 : imagery.tileSize,
		attribution: imagery.attribution
	};
}

export function regionalImagerySource(
	regional: BaseMapRegionalImagery,
	tiles: string,
	pixelRatio: number
): RasterSourceSpecification {
	return { ...imagerySource(regional, tiles, pixelRatio), bounds: [...regional.bounds] };
}

/** The imagery layer. Bottom of the stack, so everything the vector archive draws sits over it. */
export function imageryLayer(): LayerSpecification {
	return {
		id: IMAGERY_LAYER,
		type: 'raster',
		source: IMAGERY_SOURCE_ID,
		// No fade. The default cross-fade between zoom levels dissolves one photograph into another,
		// which over a coastline reads as the coast moving.
		paint: { 'raster-fade-duration': 0 }
	};
}

export function regionalImageryLayer(
	regional: BaseMapRegionalImagery,
	index: number
): LayerSpecification {
	return {
		id: regionalImageryId(index),
		type: 'raster',
		source: regionalImageryId(index),
		minzoom: regional.minZoom,
		paint: { 'raster-fade-duration': 0 }
	};
}
