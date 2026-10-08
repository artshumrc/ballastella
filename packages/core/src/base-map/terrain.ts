import type { LayerSpecification, SourceSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Flavor } from '@protomaps/basemaps';

import type { BaseMapTerrain } from './entry';

export const TERRAIN_DEM_SOURCE_ID = 'terrain-dem';
export const TERRAIN_CONTOUR_SOURCE_ID = 'terrain-contours';
const CONTOUR_LAYER = 'contours';

export type TerrainTileTemplates = {
	readonly dem: string;
	readonly contours: string;
};

const CONTOUR_THRESHOLDS: Readonly<Record<number, readonly [number, number]>> = {
	9: [500, 2000],
	10: [200, 1000],
	11: [100, 500],
	12: [50, 200],
	13: [20, 100],
	14: [10, 50],
	15: [5, 25]
};

const ELEVATION_KEY = 'ele';
const LEVEL_KEY = 'level';

export const CONTOUR_TILE_OPTIONS = {
	thresholds: CONTOUR_THRESHOLDS,
	contourLayer: CONTOUR_LAYER,
	elevationKey: ELEVATION_KEY,
	levelKey: LEVEL_KEY,
	buffer: 1
} as const;

export function terrainSources(
	terrain: BaseMapTerrain,
	tiles: TerrainTileTemplates
): Record<string, SourceSpecification> {
	return {
		[TERRAIN_DEM_SOURCE_ID]: {
			type: 'raster-dem',
			tiles: [tiles.dem],
			encoding: terrain.encoding,
			attribution: terrain.attribution,
			tileSize: 256,
			maxzoom: terrain.maxZoom
		},
		[TERRAIN_CONTOUR_SOURCE_ID]: {
			type: 'vector',
			tiles: [tiles.contours],
			maxzoom: terrain.maxZoom
		}
	};
}

export function hillshadeLayer(): LayerSpecification {
	return {
		id: 'terrain_hillshade',
		type: 'hillshade',
		source: TERRAIN_DEM_SOURCE_ID,
		paint: {
			'hillshade-exaggeration': 0.4,
			'hillshade-illumination-direction': 315,
			'hillshade-shadow-color': 'rgba(0, 0, 0, 0.32)',
			'hillshade-highlight-color': 'rgba(255, 255, 255, 0.25)',
			'hillshade-accent-color': 'rgba(0, 0, 0, 0.05)'
		}
	};
}

export function contourLayers(flavor: Flavor): LayerSpecification[] {
	const ink = flavor.address_label;
	return [
		{
			id: 'terrain_contours',
			type: 'line',
			source: TERRAIN_CONTOUR_SOURCE_ID,
			'source-layer': CONTOUR_LAYER,
			paint: {
				'line-color': ink,
				'line-width': ['match', ['get', LEVEL_KEY], 1, 1, 0.5],
				'line-opacity': ['match', ['get', LEVEL_KEY], 1, 0.5, 0.3]
			}
		},
		{
			id: 'terrain_contour_labels',
			type: 'symbol',
			source: TERRAIN_CONTOUR_SOURCE_ID,
			'source-layer': CONTOUR_LAYER,
			filter: ['==', ['get', LEVEL_KEY], 1],
			layout: {
				'symbol-placement': 'line',
				'text-field': ['concat', ['to-string', ['get', ELEVATION_KEY]], ' m'],
				'text-font': ['Noto Sans Regular'],
				'text-size': 10,
				'text-max-angle': 25
			},
			paint: {
				'text-color': ink,
				'text-halo-color': flavor.address_label_halo,
				'text-halo-width': 1.5
			}
		}
	];
}
