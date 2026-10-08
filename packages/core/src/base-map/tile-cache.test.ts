import { describe, expect, it } from 'vitest';

import {
	BASE_MAP_TILE_ROOT,
	ESTIMATED_BYTES_PER_TILE,
	OFFLINE_TILE_LIMIT,
	baseMapArchiveKey,
	baseMapTileDirectory,
	cachedTilePath,
	countTilesForBounds,
	legacyCachedTilePath,
	parseAnyCachedTilePath,
	parseCachedTilePath,
	tileBudget,
	tilesForBounds
} from './tile-cache';
import type { GeoBounds } from '../project/opening-view';

const MEASURED_CANAL_BELT = { tiles: 23, decompressedBytes: 3_485_916 } as const;
const CANAL_BELT: GeoBounds = { west: 4.88, south: 52.36, east: 4.92, north: 52.38 };

const at = (tiles: readonly { z: number; x: number; y: number }[], z: number) =>
	tiles.filter((tile) => tile.z === z);

describe('tilesForBounds', () => {
	it('gives the one tile of zoom 0 for any box', () => {
		expect(at(tilesForBounds(CANAL_BELT, 14), 0)).toEqual([{ z: 0, x: 0, y: 0 }]);
	});

	it('names the Web Mercator tiles a known box falls in, by number', () => {
		expect(at(tilesForBounds(CANAL_BELT, 14), 14)).toEqual([
			{ z: 14, x: 8414, y: 5383 },
			{ z: 14, x: 8414, y: 5384 },
			{ z: 14, x: 8414, y: 5385 },
			{ z: 14, x: 8415, y: 5383 },
			{ z: 14, x: 8415, y: 5384 },
			{ z: 14, x: 8415, y: 5385 }
		]);
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
		expect(tiles.length).toBe(MEASURED_CANAL_BELT.tiles);
	});

	it('is a neighbourhood at 23 tiles and a continent at hundreds of thousands', () => {
		const africa: GeoBounds = { west: -18, south: -35, east: 52, north: 38 };
		expect(countTilesForBounds(africa, 14)).toBeGreaterThan(100_000);
	});

	it('never lists the same tile twice', () => {
		const tiles = tilesForBounds({ west: -180, south: -80, east: 180, north: 80 }, 4);
		expect(new Set(tiles.map((tile) => `${tile.z}/${tile.x}/${tile.y}`)).size).toBe(tiles.length);
	});

	it('takes the short way round a box that crosses the antimeridian', () => {
		const pacific: GeoBounds = { west: 139.77, south: 37.6, east: 237.58, north: 37.8 };
		const z4 = at(tilesForBounds(pacific, 4), 4);
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

describe('the measured numbers ADR-0025 quotes', () => {
	it('never under-quotes a realistic extent, because the error has a right direction', () => {
		const quoted = tileBudget(CANAL_BELT, 14).estimatedBytes;
		expect(quoted).toBeGreaterThanOrEqual(MEASURED_CANAL_BELT.decompressedBytes);
		expect(quoted).toBeLessThan(MEASURED_CANAL_BELT.decompressedBytes * 1.25);
	});
});

describe('a box with no area', () => {
	const INVERTED: GeoBounds = { west: 4.92, south: 52.36, east: 4.88, north: 52.38 };
	const UPSIDE_DOWN: GeoBounds = { west: 4.88, south: 52.38, east: 4.92, north: 52.36 };

	it('needs a whole number of tiles, never a negative one', () => {
		for (const bounds of [INVERTED, UPSIDE_DOWN]) {
			const counted = countTilesForBounds(bounds, 14);
			expect(counted).toBeGreaterThanOrEqual(0);
			expect(counted).toBe(tilesForBounds(bounds, 14).length);
		}
	});

	it('is quoted as a cost a user could agree to, not a negative refund', () => {
		const budget = tileBudget(INVERTED, 14);
		expect(budget.count).toBeGreaterThanOrEqual(0);
		expect(budget.estimatedBytes).toBeGreaterThanOrEqual(0);
		expect(budget.overThreshold).toBe(false);
	});
});

describe('countTilesForBounds', () => {
	it('agrees with the list it does not build', () => {
		expect(countTilesForBounds(CANAL_BELT, 14)).toBe(tilesForBounds(CANAL_BELT, 14).length);
		expect(countTilesForBounds({ west: -180, south: -80, east: 180, north: 80 }, 4)).toBe(
			tilesForBounds({ west: -180, south: -80, east: 180, north: 80 }, 4).length
		);
	});

	it('answers for a world-spanning extent without building 358 million entries', () => {
		const world: GeoBounds = { west: -179, south: -85, east: 179, north: 85 };
		const started = Date.now();
		expect(countTilesForBounds(world, 14)).toBeGreaterThan(100_000_000);
		expect(Date.now() - started).toBeLessThan(50);
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
		expect(budget.tiles).toEqual([]);
	});

	it('still reports the honest count for an extent it refuses to enumerate', () => {
		const world: GeoBounds = { west: -179, south: -85, east: 179, north: 85 };
		const budget = tileBudget(world, 14);
		expect(budget.count).toBe(countTilesForBounds(world, 14));
		expect(budget.estimatedBytes).toBe(budget.count * ESTIMATED_BYTES_PER_TILE);
	});
});

const ARCHIVE = 'https://example.test/v4.pmtiles';
const OTHER_ARCHIVE = 'https://other.test/v4.pmtiles';

describe('cachedTilePath', () => {
	it('is the ADR-0025 layout, under the archive’s own directory', () => {
		expect(cachedTilePath(ARCHIVE, { z: 14, x: 8434, y: 5403 })).toBe(
			`${baseMapTileDirectory(ARCHIVE)}14/8434/5403.mvt`
		);
		expect(cachedTilePath(ARCHIVE, { z: 0, x: 0, y: 0 }).startsWith(BASE_MAP_TILE_ROOT)).toBe(true);
	});

	it('round-trips through the parser', () => {
		const tile = { z: 11, x: 1054, y: 675 };
		expect(parseCachedTilePath(ARCHIVE, cachedTilePath(ARCHIVE, tile))).toEqual(tile);
	});

	it('does not claim a path that is not a cached tile', () => {
		expect(parseCachedTilePath(ARCHIVE, 'base-map/fonts/Noto Sans Regular/0-255.pbf')).toBeNull();
		expect(
			parseCachedTilePath(ARCHIVE, `${baseMapTileDirectory(ARCHIVE)}14/8434/5403.png`)
		).toBeNull();
		expect(parseCachedTilePath(ARCHIVE, 'images/abc/info.json')).toBeNull();
		expect(parseCachedTilePath(ARCHIVE, 'base-map/tiles/14/8434/5403.mvt')).toBeNull();
	});
});

describe('the cache directory is keyed by archive', () => {
	it('gives two archives two directories, so neither can serve the other’s tiles', () => {
		expect(baseMapTileDirectory(ARCHIVE)).not.toBe(baseMapTileDirectory(OTHER_ARCHIVE));
		const tile = { z: 14, x: 8434, y: 5403 };
		expect(parseCachedTilePath(ARCHIVE, cachedTilePath(OTHER_ARCHIVE, tile))).toBeNull();
		expect(parseCachedTilePath(OTHER_ARCHIVE, cachedTilePath(ARCHIVE, tile))).toBeNull();
	});

	it('is stable for one archive, because a Published Site’s paths are already written', () => {
		expect(baseMapArchiveKey(ARCHIVE)).toBe(baseMapArchiveKey(ARCHIVE));
		expect(baseMapTileDirectory(ARCHIVE)).toBe(
			`${BASE_MAP_TILE_ROOT}${baseMapArchiveKey(ARCHIVE)}/`
		);
	});

	it('is a single path segment a filesystem will take, whatever the archive looks like', () => {
		for (const archive of [
			ARCHIVE,
			'base-map/amsterdam-centre.pmtiles',
			'https://demo.test/a b/v4.pmtiles?token=x#y',
			'../escape.pmtiles',
			''
		]) {
			expect(baseMapArchiveKey(archive), archive).toMatch(/^[a-z0-9][a-z0-9-]*$/);
		}
	});

	it('still recognises the older unkeyed layout, as belonging to no archive', () => {
		const tile = { z: 14, x: 8434, y: 5403 };
		expect(legacyCachedTilePath(tile)).toBe('base-map/tiles/14/8434/5403.mvt');
		expect(parseAnyCachedTilePath(legacyCachedTilePath(tile))).toEqual({ key: null, tile });
		expect(parseCachedTilePath(ARCHIVE, legacyCachedTilePath(tile))).toBeNull();
	});

	it('reads the key back off a path, which is how a whole-Workspace walk finds every cache', () => {
		const tile = { z: 3, x: 4, y: 5 };
		expect(parseAnyCachedTilePath(cachedTilePath(ARCHIVE, tile))).toEqual({
			key: baseMapArchiveKey(ARCHIVE),
			tile
		});
		expect(parseAnyCachedTilePath('base-map/tiles/some-key/tile-source.json')).toBeNull();
	});
});
