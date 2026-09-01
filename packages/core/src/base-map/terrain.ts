// Shaded relief and contour lines for the `relief-and-contours` emphasis: the layers, their
// colours, and the isoline intervals. Pure — it builds specifications and reaches no network, so
// the contour intervals are asserted numerically rather than looked at.

import type { LayerSpecification, SourceSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Flavor } from '@protomaps/basemaps';

import type { BaseMapTerrain } from './entry';

/** The raster DEM the relief shades and every contour line is traced from. */
export const TERRAIN_DEM_SOURCE_ID = 'terrain-dem';

/** The vector source of isolines `maplibre-contour` synthesises from {@link TERRAIN_DEM_SOURCE_ID}. */
export const TERRAIN_CONTOUR_SOURCE_ID = 'terrain-contours';

/** The source-layer inside the synthesised contour tiles. Must match {@link CONTOUR_TILE_OPTIONS}. */
export const CONTOUR_LAYER = 'contours';

/** The two protocol URL templates {@link terrainSources} needs, from whoever registered them. */
export type TerrainTileTemplates = {
	readonly dem: string;
	readonly contours: string;
};

/**
 * Contour intervals in **metres**, as `zoom: [minor, major]`. Each line carries a `level` naming
 * which of the two it is.
 *
 * Metres and not feet: the renderer's multiplier exists to convert, and a Project read by scholars
 * in more than one country is better served by the unit the data is already in.
 *
 * The intervals halve roughly every zoom because an isoline's job is to stay countable. They are
 * held wider than a national survey sheet's at every zoom — a 10 m interval over the Alps at z12 is
 * a black band, not a map — and stop at 5 m because a global DEM's vertical resolution does not
 * support a finer claim.
 */
export const CONTOUR_THRESHOLDS: Readonly<Record<number, readonly [number, number]>> = {
	9: [500, 2000],
	10: [200, 1000],
	11: [100, 500],
	12: [50, 200],
	13: [20, 100],
	14: [10, 50],
	15: [5, 25]
};

/** The property names this module's layers read out of the synthesised tiles. */
const ELEVATION_KEY = 'ele';
const LEVEL_KEY = 'level';

/**
 * What `maplibre-contour` is asked to put in a tile.
 *
 * Exported because these keys are a contract between the tile the protocol generates and the
 * layers that read it: set in one place and read in the other, a mismatch is a blank map with no
 * error anywhere.
 */
export const CONTOUR_TILE_OPTIONS = {
	thresholds: CONTOUR_THRESHOLDS,
	contourLayer: CONTOUR_LAYER,
	elevationKey: ELEVATION_KEY,
	levelKey: LEVEL_KEY,
	// One pixel of overdraw into the neighbouring tile. Without it an isoline is visibly cut at
	// every tile boundary, which reads as a grid ruled over the mountains.
	buffer: 1
} as const;

/**
 * The DEM and contour sources.
 *
 * Both tile templates are handed in rather than derived here: they are `maplibre-contour` protocol
 * URLs, and that library registers MapLibre protocols and spawns a worker, so it is imported from
 * `@ballastella/core/render` and never from this Node-safe module — the same seam `cachedTiles`
 * sits on in `style.ts`.
 */
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
			// The isolines are synthesised from the DEM, so they cannot be deeper than it is. Past
			// this zoom MapLibre overzooms the last tile, which keeps the lines on screen as the user
			// keeps zooming instead of dropping them at an arbitrary depth.
			maxzoom: terrain.maxZoom
		}
	};
}

/**
 * Shaded relief.
 *
 * The shadow and highlight are black and white at low alpha rather than colours out of the flavor,
 * because hillshade paints *over* what is beneath it: the flavor's own entries are opaque fills
 * chosen to be seen, and using one here tints the land instead of lighting it. Alpha over the
 * flavor's own earth is what keeps light and dark coherent without inventing a second palette.
 *
 * The illumination is from the north-west. Not an aesthetic default but a perceptual one: lit from
 * any southerly direction the eye reads the valleys as ridges and the whole relief inverts.
 */
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

/**
 * Contour lines and their elevation labels.
 *
 * Both take the flavor's `address_label` colours. That token is the flavor's own answer to "fine
 * detail drawn over land, legible at high zoom", already tuned against `earth` in every flavor, and
 * it is free here: this emphasis drops the address labels, so nothing else on the map is using it.
 * Choosing a topographic brown instead would be a palette this repository then owns in five
 * flavors and maintains against every upstream change.
 */
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
				// Major lines are drawn to be followed across the sheet and carry the labels; minor
				// ones are there to be counted between them.
				'line-width': ['match', ['get', LEVEL_KEY], 1, 1, 0.5],
				'line-opacity': ['match', ['get', LEVEL_KEY], 1, 0.5, 0.3]
			}
		},
		{
			id: 'terrain_contour_labels',
			type: 'symbol',
			source: TERRAIN_CONTOUR_SOURCE_ID,
			'source-layer': CONTOUR_LAYER,
			// Only major lines are labelled. Numbering every line at a 10 m interval writes the
			// figures over the lines they belong to.
			filter: ['==', ['get', LEVEL_KEY], 1],
			layout: {
				'symbol-placement': 'line',
				'text-field': ['concat', ['to-string', ['get', ELEVATION_KEY]], ' m'],
				// One of the three fontstacks the deployment ships glyphs for. A name with no SDF
				// behind it is a label layer that renders nothing and logs nothing.
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
