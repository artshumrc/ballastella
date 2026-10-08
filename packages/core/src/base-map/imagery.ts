import type {
	LayerSpecification,
	RasterSourceSpecification
} from '@maplibre/maplibre-gl-style-spec';

import type { BaseMapImagery, BaseMapRegionalImagery } from './entry';

export const IMAGERY_SOURCE_ID = 'satellite';
export const IMAGERY_LAYER = 'satellite';
export const regionalImageryId = (index: number): string => `${IMAGERY_LAYER}-regional-${index}`;
const GROUND_LAYERS = ['background', 'earth', 'landcover'] as const;

export const isWaterFill = (layer: LayerSpecification): boolean =>
	layer.type === 'fill' && 'source-layer' in layer && layer['source-layer'] === 'water';

export function imageryReplaces(layer: LayerSpecification): boolean {
	return (
		GROUND_LAYERS.some((id) => id === layer.id) ||
		layer.id.startsWith('landuse_') ||
		isWaterFill(layer)
	);
}

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
		// MapLibre picks raster zooms by CSS pixels, so on a dense screen every tile is stretched across twice its pixels.
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

export function imageryLayer(): LayerSpecification {
	return {
		id: IMAGERY_LAYER,
		type: 'raster',
		source: IMAGERY_SOURCE_ID,
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
