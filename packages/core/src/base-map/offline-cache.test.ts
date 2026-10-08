import { describe, expect, it, vi } from 'vitest';

import {
	baseMapCaches,
	baseMapTileSourcePath,
	describeTileBudget,
	fetchTilesIntoCache,
	offlineCoverage,
	readCachedTileSource,
	tileBudgetRefusal,
	totalBaseMapCacheSize,
	writeCachedTileSource
} from './offline-cache';
import {
	OFFLINE_TILE_LIMIT,
	baseMapTileDirectory,
	cachedTilePath,
	legacyCachedTilePath,
	tileBudget,
	type TileCoordinate
} from './tile-cache';
import type { GeoBounds } from '../project/opening-view';
import { MemoryProjectStore } from '../store/memory-project-store';
import { encode } from '../test-support.js';

const ARCHIVE = 'https://example.test/basemaps.pmtiles';
const OTHER_ARCHIVE = 'https://other.test/basemaps.pmtiles';
const CANAL_BELT: GeoBounds = { west: 4.88, south: 52.36, east: 4.92, north: 52.38 };
const NEARBY: GeoBounds = { west: 4.885, south: 52.365, east: 4.9, north: 52.375 };
const GROWN: GeoBounds = { west: 4.88, south: 52.36, east: 5.05, north: 52.38 };

const source = (size = 40) => {
	const asked: TileCoordinate[] = [];
	return {
		asked,
		readTile: async (tile: TileCoordinate) => {
			asked.push(tile);
			const bytes = new Uint8Array(size);
			bytes[0] = tile.z;
			return bytes;
		}
	};
};

const baseMapCacheSize = async (store: MemoryProjectStore) =>
	totalBaseMapCacheSize(await baseMapCaches(store));

const CANAL_BELT_TILES = tileBudget(CANAL_BELT, 14).tiles;

const cache = (
	store: MemoryProjectStore,
	tiles: readonly TileCoordinate[] = CANAL_BELT_TILES,
	readTile: Parameters<typeof fetchTilesIntoCache>[0]['readTile'] = source().readTile
) => fetchTilesIntoCache({ store, archive: ARCHIVE, tiles, readTile });

describe('offlineCoverage', () => {
	it('is incomplete, every tile missing, for an empty Workspace, which asking costs nothing', async () => {
		const store = new MemoryProjectStore();
		const coverage = await offlineCoverage(store, ARCHIVE, CANAL_BELT, 14);
		expect(coverage.budget.count).toBe(23);
		expect(describeTileBudget(coverage.budget)).toContain('23 tiles');
		expect(coverage.missing.length).toBe(23);
		expect(coverage.present).toBe(0);
		expect(coverage.complete).toBe(false);
		expect(await store.list('')).toEqual([]);
	});

	it('is not complete when one tile of the extent is missing', async () => {
		const store = new MemoryProjectStore();
		const tiles = CANAL_BELT_TILES;
		await cache(store, tiles.slice(0, -1));
		const coverage = await offlineCoverage(store, ARCHIVE, CANAL_BELT, 14);
		expect(coverage.present).toBe(22);
		expect(coverage.complete).toBe(false);
		expect(coverage.missing).toEqual([tiles[tiles.length - 1]]);
	});

	it('reports a second Project in the same area as available offline, and an outgrown one not', async () => {
		const store = new MemoryProjectStore();
		const first = source();
		await cache(store, undefined, first.readTile);
		const before = (await baseMapCacheSize(store)).tiles;
		const second = await offlineCoverage(store, ARCHIVE, NEARBY, 14);
		expect(second.complete).toBe(true);
		expect(second.missing).toEqual([]);
		const run = await cache(store, second.missing, first.readTile);
		expect(run.written).toBe(0);
		expect((await baseMapCacheSize(store)).tiles).toBe(before);
		const grown = await offlineCoverage(store, ARCHIVE, GROWN, 14);
		expect(grown.complete).toBe(false);
		expect(grown.missing.length).toBeGreaterThan(0);
	});

	it('ignores files under the cache directory that are not tiles', async () => {
		const store = new MemoryProjectStore();
		await store.write(`${baseMapTileDirectory(ARCHIVE)}readme.txt`, encode('hello'));
		expect(await baseMapCacheSize(store)).toEqual({ tiles: 0, bytes: 0, maxZoom: null });
	});
});

describe('fetchTilesIntoCache', () => {
	it('writes the ADR-0025 layout for every zoom from 0 to the maximum, with the bytes verbatim', async () => {
		const store = new MemoryProjectStore();
		const run = await cache(store, CANAL_BELT_TILES, source(64).readTile);
		expect(run.written).toBe(23);
		expect(run.bytes).toBe(23 * 64);
		const paths = await store.list(baseMapTileDirectory(ARCHIVE));
		expect(paths).toEqual(
			CANAL_BELT_TILES.map((tile) => cachedTilePath(ARCHIVE, tile)).sort((a, b) =>
				a < b ? -1 : a > b ? 1 : 0
			)
		);
		const one = await store.read(cachedTilePath(ARCHIVE, { z: 14, x: 8414, y: 5383 }));
		expect(one.byteLength).toBe(64);
		expect(one[0]).toBe(14);
		const zooms = [...new Set(paths.map((path) => Number(path.split('/')[3])))].sort(
			(a, b) => a - b
		);
		expect(zooms).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
		expect(paths).toContain(`${baseMapTileDirectory(ARCHIVE)}0/0/0.mvt`);
		expect(paths).toContain(`${baseMapTileDirectory(ARCHIVE)}14/8414/5383.mvt`);
		const coverage = await offlineCoverage(store, ARCHIVE, CANAL_BELT, 14);
		expect(coverage.complete).toBe(true);
		expect(coverage.missing).toEqual([]);
	});

	it('fetches only tiles not already present when it is run again', async () => {
		const store = new MemoryProjectStore();
		const tiles = CANAL_BELT_TILES;
		await cache(store, tiles.slice(0, 10));

		const second = source();
		const coverage = await offlineCoverage(store, ARCHIVE, CANAL_BELT, 14);
		const run = await cache(store, coverage.missing, second.readTile);
		expect(run.written).toBe(13);
		expect(second.asked.length).toBe(13);
		expect(second.asked.map((tile) => cachedTilePath(ARCHIVE, tile))).not.toContain(
			cachedTilePath(ARCHIVE, tiles[0] as TileCoordinate)
		);
		expect((await offlineCoverage(store, ARCHIVE, CANAL_BELT, 14)).complete).toBe(true);
	});

	it('does not write a tile the source has nothing at, so coverage stays honest', async () => {
		const store = new MemoryProjectStore();
		const run = await cache(store, undefined, async (tile) =>
			tile.z === 14 ? null : new Uint8Array(8)
		);
		expect(run.absent).toBe(6);
		expect(run.written).toBe(17);
		expect((await offlineCoverage(store, ARCHIVE, CANAL_BELT, 14)).complete).toBe(false);
	});

	it('stops on its signal and says it was cancelled', async () => {
		const store = new MemoryProjectStore();
		const controller = new AbortController();
		let seen = 0;
		const run = await fetchTilesIntoCache({
			store,
			archive: ARCHIVE,
			tiles: CANAL_BELT_TILES,
			signal: controller.signal,
			readTile: async () => {
				seen += 1;
				if (seen === 5) controller.abort();
				return new Uint8Array(4);
			}
		});
		expect(run.cancelled).toBe(true);
		expect(run.written).toBe(5);
	});

	it('reports progress against the same total the budget showed', async () => {
		const store = new MemoryProjectStore();
		const onProgress = vi.fn();
		await fetchTilesIntoCache({
			store,
			archive: ARCHIVE,
			tiles: CANAL_BELT_TILES,
			readTile: source().readTile,
			onProgress
		});
		expect(onProgress).toHaveBeenCalledTimes(23);
		expect(onProgress).toHaveBeenLastCalledWith({ done: 23, total: 23, bytes: 23 * 40 });
	});
});

describe('an extent past the threshold', () => {
	it('is never reported as available offline, whatever the cache holds', async () => {
		const store = new MemoryProjectStore();
		const world: GeoBounds = { west: -179, south: -85, east: 179, north: 85 };
		const coverage = await offlineCoverage(store, ARCHIVE, world, 14);
		expect(coverage.budget.overThreshold).toBe(true);
		expect(coverage.complete).toBe(false);
		expect(coverage.missing).toEqual([]);
		expect(coverage.present).toBe(0);
	});

	it('is refused with the numbers, and nothing is fetched', async () => {
		const store = new MemoryProjectStore();
		const spread: GeoBounds = { west: 4.8, south: 52.3, east: 5.1, north: 52.6 };
		const coverage = await offlineCoverage(store, ARCHIVE, spread, 14);
		const refusal = tileBudgetRefusal(coverage.budget);
		expect(coverage.budget.count).toBeGreaterThan(OFFLINE_TILE_LIMIT);
		expect(refusal).toContain(String(coverage.budget.count));
		expect(refusal).toContain(`${OFFLINE_TILE_LIMIT} tiles`);
		expect(coverage.budget.limit).toBe(OFFLINE_TILE_LIMIT);
		expect(refusal).toContain('Nothing has been fetched');
		const run = await cache(store, coverage.missing);
		expect(run.written).toBe(0);
		expect(await store.list('')).toEqual([]);
	});
});

describe('baseMapCacheSize', () => {
	it('reports the deepest zoom on disk, which is how the map draws with no network', async () => {
		const store = new MemoryProjectStore();
		const tiles = CANAL_BELT_TILES.filter((tile) => tile.z <= 11);
		await cache(store, tiles);
		expect((await baseMapCacheSize(store)).maxZoom).toBe(11);
	});
});

describe('what the cache records about where it came from', () => {
	it('answers the source’s depth with no network, and nothing when nothing was recorded', async () => {
		const store = new MemoryProjectStore();
		expect(await readCachedTileSource(store, ARCHIVE)).toBeNull();
		await writeCachedTileSource(store, { archive: ARCHIVE, maxZoom: 14 });
		expect(await readCachedTileSource(store, ARCHIVE)).toEqual({ archive: ARCHIVE, maxZoom: 14 });
	});

	it('refuses a record it cannot believe, or naming another archive, rather than half-reading it', async () => {
		const store = new MemoryProjectStore();
		for (const body of [
			'not json',
			'{}',
			'{"archive":"","maxZoom":14}',
			`{"archive":"a"}`,
			JSON.stringify({ archive: OTHER_ARCHIVE, maxZoom: 14 })
		]) {
			await store.write(baseMapTileSourcePath(ARCHIVE), encode(body));
			expect(await readCachedTileSource(store, ARCHIVE), body).toBeNull();
		}
	});
});

describe('a Workspace filled before the directory was keyed', () => {
	const seedLegacy = async (store: MemoryProjectStore, tiles: readonly TileCoordinate[]) => {
		for (const tile of tiles) await store.write(legacyCachedTilePath(tile), new Uint8Array(100));
	};

	it('is counted by the hub, but makes no Project available offline for an archive', async () => {
		const store = new MemoryProjectStore();
		await seedLegacy(store, CANAL_BELT_TILES);

		expect(await baseMapCacheSize(store)).toEqual({ tiles: 23, bytes: 2300, maxZoom: 14 });
		const [only] = await baseMapCaches(store);
		expect(only?.legacy).toBe(true);
		expect(only?.archive).toBeNull();
		expect((await offlineCoverage(store, ARCHIVE, CANAL_BELT, 14)).complete).toBe(false);
	});
});

describe('what the user is told before agreeing', () => {
	it('states the count, the estimate, and the zoom range, and no refusal within the threshold', () => {
		const sentence = describeTileBudget(tileBudget(CANAL_BELT, 14));
		expect(sentence).toContain('23 tiles');
		expect(sentence).toMatch(/[0-9.]+ MB/);
		expect(sentence).toContain('every zoom level from 0 to 14');
		expect(tileBudgetRefusal(tileBudget(CANAL_BELT, 14))).toBe('');
	});
});
