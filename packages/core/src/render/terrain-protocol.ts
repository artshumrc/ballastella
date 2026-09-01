// Relief and contour tiles reaching MapLibre, for the topographic Base Map. ADR-0011's pattern once
// more: a protocol registered once per dataset, and the tile templates handed back to the caller.

import { addProtocol } from 'maplibre-gl';
import mlcontour from 'maplibre-contour';

import type { BaseMapTerrain } from '../base-map/entry.js';
import { CONTOUR_TILE_OPTIONS, type TerrainTileTemplates } from '../base-map/terrain.js';

let registered: { readonly key: string; readonly templates: TerrainTileTemplates } | null = null;

/**
 * Register the DEM and contour protocols for one elevation dataset, and return the tile templates
 * `baseMapStyle` needs for its `terrainTiles` option.
 *
 * **Why the contour lines are computed here rather than fetched.** Nobody publishes keyless global
 * contour vectors, and rasterised contours cannot be recoloured per flavor — so a topographic Base
 * Map either ships a second global tileset or traces isolines out of the DEM it is already
 * fetching for the shading. `maplibre-contour` does the second in a worker, off the UI thread, and
 * caches the decoded elevation tiles between the two readers. One dataset, two renderings.
 *
 * Idempotent per dataset, like {@link registerPmtilesProtocol} and for the same reason: panes come
 * and go with navigation, the page-global protocol registry does not. A *different* dataset
 * re-registers, because the DEM url, encoding, and maximum zoom are all baked into the protocol
 * handler and a stale one silently serves the wrong elevations.
 */
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
		// The shared protocol rather than the raw url, so the shading and the isolines read one
		// decoded copy of each tile instead of fetching and decoding the DEM twice.
		dem: source.sharedDemProtocolUrl,
		contours: source.contourProtocolUrl({
			...CONTOUR_TILE_OPTIONS,
			thresholds: mutableThresholds(CONTOUR_TILE_OPTIONS.thresholds)
		})
	};
	registered = { key, templates };
	return templates;
}

/** `maplibre-contour` types its thresholds mutably; ours are `readonly` because they are shared. */
const mutableThresholds = (thresholds: Readonly<Record<number, readonly [number, number]>>) =>
	Object.fromEntries(Object.entries(thresholds).map(([zoom, pair]) => [zoom, [...pair]]));
