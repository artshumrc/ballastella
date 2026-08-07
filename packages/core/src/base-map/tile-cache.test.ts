// Tile enumeration, asserted numerically. This is what makes the budget honest: the number the
// dialog shows and the work the loop does are the same list, so a test of the list is a test of both.

import { describe, expect, it } from 'vitest';

import {
	BASE_MAP_TILE_DIRECTORY,
	ESTIMATED_BYTES_PER_TILE,
	OFFLINE_TILE_LIMIT,
	cachedTilePath,
	parseCachedTilePath,
	tileBudget,
	tilesForBounds
} from './tile-cache';
import type { GeoBounds } from '../project/opening-view';

/**
 * Central Amsterdam's canal belt, and the box the measurement at the top of `tile-cache.ts` was
 * taken over. Roughly 2.7 km by 2.2 km — a Project about one city's streets.
 */
const CANAL_BELT: GeoBounds = { west: 4.88, south: 52.36, east: 4.92, north: 52.38 };

const at = (tiles: readonly { z: number; x: number; y: number }[], z: number) =>
	tiles.filter((tile) => tile.z === z);

describe('tilesForBounds', () => {
	it('gives the one tile of zoom 0 for any box', () => {
		expect(at(tilesForBounds(CANAL_BELT, 14), 0)).toEqual([{ z: 0, x: 0, y: 0 }]);
	});

	it('names the Web Mercator tiles a known box falls in, by number', () => {
		// x = floor(((lng + 180) / 360) * 2^14): 4.88 → 8414.1, 4.92 → 8415.9.
		// y from the Mercator formula: 52.38 → 5383.5, 52.36 → 5385.2.
		expect(at(tilesForBounds(CANAL_BELT, 14), 14)).toEqual([
			{ z: 14, x: 8414, y: 5383 },
			{ z: 14, x: 8414, y: 5384 },
			{ z: 14, x: 8414, y: 5385 },
			{ z: 14, x: 8415, y: 5383 },
			{ z: 14, x: 8415, y: 5384 },
			{ z: 14, x: 8415, y: 5385 }
		]);
		// And one level up, exactly the parents of those six.
		expect(at(tilesForBounds(CANAL_BELT, 14), 13)).toEqual([
			{ z: 13, x: 4207, y: 2691 },
			{ z: 13, x: 4207, y: 2692 }
		]);
	});

	it('covers every zoom from 0 to the maximum, with none missing', () => {
		const tiles = tilesForBounds(CANAL_BELT, 14);
		expect([...new Set(tiles.map((tile) => tile.z))].sort((a, b) => a - b)).toEqual([
			0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14
		]);
		// The count the budget dialog would show for a city-centre Project, measured against the real
		// archive in the note at the top of `tile-cache.ts`: tens of tiles, not thousands.
		expect(tiles.length).toBe(23);
	});

	it('is a neighbourhood at 23 tiles and a continent at hundreds of thousands', () => {
		// The contrast ADR-0025 rests its refusal threshold on, in one assertion rather than in prose.
		const africa: GeoBounds = { west: -18, south: -35, east: 52, north: 38 };
		expect(tilesForBounds(africa, 14).length).toBeGreaterThan(100_000);
	});

	it('never lists the same tile twice', () => {
		const tiles = tilesForBounds({ west: -180, south: -80, east: 180, north: 80 }, 4);
		expect(new Set(tiles.map((tile) => `${tile.z}/${tile.x}/${tile.y}`)).size).toBe(tiles.length);
	});

	it('takes the short way round a box that crosses the antimeridian', () => {
		// `projectOpeningBounds` expresses Tokyo-to-San-Francisco with `east` above 180. The columns run
		// past the pyramid's width and wrap, rather than sweeping the whole world the other way.
		const pacific: GeoBounds = { west: 139.77, south: 37.6, east: 237.58, north: 37.8 };
		const z4 = at(tilesForBounds(pacific, 4), 4);
		// 139.77° → column 14, 237.58° → column 18, which wraps to 2. Five columns, not eleven.
		expect(z4.map((tile) => tile.x)).toEqual([14, 15, 0, 1, 2]);
	});

	it('clamps a box beyond the Mercator limit to the rows that exist', () => {
		const polar: GeoBounds = { west: -10, south: 80, east: 10, north: 90 };
		const z3 = at(tilesForBounds(polar, 3), 3);
		expect(z3.every((tile) => tile.y >= 0 && tile.y < 8)).toBe(true);
		expect(z3.some((tile) => tile.y === 0)).toBe(true);
	});

	it('is empty for a negative maximum zoom and one tile for zoom 0', () => {
		expect(tilesForBounds(CANAL_BELT, -1)).toEqual([]);
		expect(tilesForBounds(CANAL_BELT, 0)).toEqual([{ z: 0, x: 0, y: 0 }]);
	});
});

describe('tileBudget', () => {
	it('counts and estimates from the same list the fetch loop consumes', () => {
		const budget = tileBudget(CANAL_BELT, 14);
		expect(budget.count).toBe(budget.tiles.length);
		expect(budget.count).toBe(23);
		expect(budget.estimatedBytes).toBe(23 * ESTIMATED_BYTES_PER_TILE);
		expect(budget.maxZoom).toBe(14);
		expect(budget.overThreshold).toBe(false);
	});

	it('marks an extent past the threshold as refused, and says what the threshold is', () => {
		const netherlands: GeoBounds = { west: 3.3, south: 50.7, east: 7.3, north: 53.6 };
		const budget = tileBudget(netherlands, 14);
		expect(budget.count).toBeGreaterThan(OFFLINE_TILE_LIMIT);
		expect(budget.overThreshold).toBe(true);
		expect(budget.limit).toBe(OFFLINE_TILE_LIMIT);
	});
});

describe('cachedTilePath', () => {
	it('is the ADR-0025 layout, under the Workspace-level directory', () => {
		expect(cachedTilePath({ z: 14, x: 8434, y: 5403 })).toBe('base-map/tiles/14/8434/5403.mvt');
		expect(cachedTilePath({ z: 0, x: 0, y: 0 }).startsWith(BASE_MAP_TILE_DIRECTORY)).toBe(true);
	});

	it('round-trips through the parser', () => {
		const tile = { z: 11, x: 1054, y: 675 };
		expect(parseCachedTilePath(cachedTilePath(tile))).toEqual(tile);
	});

	it('does not claim a path that is not a cached tile', () => {
		expect(parseCachedTilePath('base-map/fonts/Noto Sans Regular/0-255.pbf')).toBeNull();
		expect(parseCachedTilePath('base-map/tiles/14/8434/5403.png')).toBeNull();
		expect(parseCachedTilePath('images/abc/info.json')).toBeNull();
	});
});
