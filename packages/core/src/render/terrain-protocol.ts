import { addProtocol } from 'maplibre-gl';
import mlcontour from 'maplibre-contour';

import type { BaseMapTerrain } from '../base-map/entry.js';
import { CONTOUR_TILE_OPTIONS, type TerrainTileTemplates } from '../base-map/terrain.js';

let registered: { readonly key: string; readonly templates: TerrainTileTemplates } | null = null;

export function registerTerrainProtocols(terrain: BaseMapTerrain): TerrainTileTemplates {
	const key = `${terrain.tiles}|${terrain.encoding}|${terrain.maxZoom}`;
	if (registered?.key === key) return registered.templates;

	const source = new mlcontour.DemSource({
		url: terrain.tiles,
		encoding: terrain.encoding,
		maxzoom: terrain.maxZoom,
		worker: true
	});
	source.setupMaplibre({ addProtocol });

	const templates = {
		dem: source.sharedDemProtocolUrl,
		contours: source.contourProtocolUrl({
			...CONTOUR_TILE_OPTIONS,
			thresholds: mutableThresholds(CONTOUR_TILE_OPTIONS.thresholds)
		})
	};
	registered = { key, templates };
	return templates;
}

const mutableThresholds = (thresholds: Readonly<Record<number, readonly [number, number]>>) =>
	Object.fromEntries(Object.entries(thresholds).map(([zoom, pair]) => [zoom, [...pair]]));
