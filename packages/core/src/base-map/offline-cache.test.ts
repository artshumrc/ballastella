// The cache as files in a Workspace: what makes a Project available offline, and what unmakes it.
//
// SPEC's Seam 1 — "after this sequence of actions the store holds these files with this content" is
// the behaviour and not a proxy for it. Everything the criteria claim about deduplication, growth,
// refetching, and clearing is a claim about which paths exist, so it is asserted about paths.

import { describe, expect, it, vi } from 'vitest';

import {
	BASE_MAP_TILE_SOURCE_PATH,
	baseMapCacheSize,
	cachedTilesMatchArchive,
	clearBaseMapCache,
	describeTileBudget,
	fetchTilesIntoCache,
	offlineCoverage,
	readCachedTileSource,
	tileBudgetRefusal,
	writeCachedTileSource
} from './offline-cache';
import { cachedTilePath, tileBudget, type TileCoordinate } from './tile-cache';
import type { GeoBounds } from '../project/opening-view';
import { MemoryProjectStore } from '../store/memory-project-store';

/** Central Amsterdam's canal belt — 23 tiles over z0–14. See `tile-cache.test.ts`. */
const CANAL_BELT: GeoBounds = { west: 4.88, south: 52.36, east: 4.92, north: 52.38 };

/** A second Project a few streets away, inside the same area. */
const NEARBY: GeoBounds = { west: 4.885, south: 52.365, east: 4.9, north: 52.375 };

/** A Project whose work has since spread east, past what the canal belt cached. */
const GROWN: GeoBounds = { west: 4.88, south: 52.36, east: 5.05, north: 52.38 };

/** A source that answers every tile with a distinguishable body of `size` bytes. */
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

describe('offlineCoverage', () => {
	it('is incomplete, and every tile missing, for an empty Workspace', async () => {
		const store = new MemoryProjectStore();
		const coverage = await offlineCoverage(store, CANAL_BELT, 14);
		expect(coverage.budget.count).toBe(23);
		expect(coverage.missing.length).toBe(23);
		expect(coverage.present).toBe(0);
		expect(coverage.complete).toBe(false);
	});

	it('is complete once every tile the extent needs is a file', async () => {
		const store = new MemoryProjectStore();
		const { readTile } = source();
		await fetchTilesIntoCache({ store, tiles: tileBudget(CANAL_BELT, 14).tiles, readTile });
		const coverage = await offlineCoverage(store, CANAL_BELT, 14);
		expect(coverage.complete).toBe(true);
		expect(coverage.missing).toEqual([]);
	});

	it('is not complete when one tile of the extent is missing', async () => {
		// The partial-cache case ADR-0025 refuses to let claim completeness: the handler answers a
		// missing tile with an empty tile and nothing errors, so a Project-level claim built from the
		// absence of a complaint would be true here and the map would draw a hole.
		const store = new MemoryProjectStore();
		const tiles = tileBudget(CANAL_BELT, 14).tiles;
		const { readTile } = source();
		await fetchTilesIntoCache({ store, tiles: tiles.slice(0, -1), readTile });
		const coverage = await offlineCoverage(store, CANAL_BELT, 14);
		expect(coverage.present).toBe(22);
		expect(coverage.complete).toBe(false);
		expect(coverage.missing).toEqual([tiles[tiles.length - 1]]);
	});

	it('reports a second Project in the same area as available offline, having fetched nothing', async () => {
		const store = new MemoryProjectStore();
		const first = source();
		await fetchTilesIntoCache({
			store,
			tiles: tileBudget(CANAL_BELT, 14).tiles,
			readTile: first.readTile
		});
		const before = (await baseMapCacheSize(store)).tiles;

		const second = await offlineCoverage(store, NEARBY, 14);
		expect(second.complete).toBe(true);
		expect(second.missing).toEqual([]);

		// Nothing fetched, and the tile count on disk did not grow: the cache is Workspace-level, so
		// the second Project is offline because of the first Project's tiles (ADR-0023, ADR-0025).
		const run = await fetchTilesIntoCache({
			store,
			tiles: second.missing,
			readTile: first.readTile
		});
		expect(run.written).toBe(0);
		expect((await baseMapCacheSize(store)).tiles).toBe(before);
	});

	it('reports a Project whose extent has outgrown the cache as not available offline', async () => {
		const store = new MemoryProjectStore();
		const { readTile } = source();
		await fetchTilesIntoCache({ store, tiles: tileBudget(CANAL_BELT, 14).tiles, readTile });
		const grown = await offlineCoverage(store, GROWN, 14);
		expect(grown.complete).toBe(false);
		expect(grown.missing.length).toBeGreaterThan(0);
	});

	it('ignores files under the cache directory that are not tiles', async () => {
		const store = new MemoryProjectStore();
		await store.write('base-map/tiles/readme.txt', new TextEncoder().encode('hello'));
		expect(await baseMapCacheSize(store)).toEqual({ tiles: 0, bytes: 0, maxZoom: null });
	});
});

describe('fetchTilesIntoCache', () => {
	it('writes the ADR-0025 layout, and the bytes the source gave, verbatim', async () => {
		const store = new MemoryProjectStore();
		const { readTile } = source(64);
		const tiles = tileBudget(CANAL_BELT, 14).tiles;
		const run = await fetchTilesIntoCache({ store, tiles, readTile });

		expect(run.written).toBe(23);
		expect(run.bytes).toBe(23 * 64);
		expect(await store.list('base-map/tiles/')).toEqual(
			[...tiles].map(cachedTilePath).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		);
		// Stored as handed over — no compression step in either direction. See the note in
		// `tile-cache.ts`: converting here is the silent blank map.
		const one = await store.read(cachedTilePath({ z: 14, x: 8414, y: 5383 }));
		expect(one.byteLength).toBe(64);
		expect(one[0]).toBe(14);
	});

	it('fetches only tiles not already present when it is run again', async () => {
		const store = new MemoryProjectStore();
		const first = source();
		const tiles = tileBudget(CANAL_BELT, 14).tiles;
		// A first, partial run: the user cancelled, or the tab died.
		await fetchTilesIntoCache({ store, tiles: tiles.slice(0, 10), readTile: first.readTile });

		const second = source();
		const coverage = await offlineCoverage(store, CANAL_BELT, 14);
		const run = await fetchTilesIntoCache({
			store,
			tiles: coverage.missing,
			readTile: second.readTile
		});

		expect(run.written).toBe(13);
		expect(second.asked.length).toBe(13);
		expect(second.asked.map(cachedTilePath)).not.toContain(
			cachedTilePath(tiles[0] as TileCoordinate)
		);
		expect((await offlineCoverage(store, CANAL_BELT, 14)).complete).toBe(true);
	});

	it('does not write a tile the source has nothing at, so coverage stays honest', async () => {
		const store = new MemoryProjectStore();
		const tiles = tileBudget(CANAL_BELT, 14).tiles;
		const run = await fetchTilesIntoCache({
			store,
			tiles,
			readTile: async (tile) => (tile.z === 14 ? null : new Uint8Array(8))
		});
		expect(run.absent).toBe(6);
		expect(run.written).toBe(17);
		expect((await offlineCoverage(store, CANAL_BELT, 14)).complete).toBe(false);
	});

	it('stops on its signal and says it was cancelled', async () => {
		const store = new MemoryProjectStore();
		const controller = new AbortController();
		let seen = 0;
		const run = await fetchTilesIntoCache({
			store,
			tiles: tileBudget(CANAL_BELT, 14).tiles,
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
		const tiles = tileBudget(CANAL_BELT, 14).tiles;
		await fetchTilesIntoCache({ store, tiles, readTile: source().readTile, onProgress });
		expect(onProgress).toHaveBeenCalledTimes(23);
		expect(onProgress).toHaveBeenLastCalledWith({ done: 23, total: 23, bytes: 23 * 40 });
	});
});

describe('an extent past the threshold', () => {
	it('is never reported as available offline, whatever the cache holds', async () => {
		// The empty-list trap: `complete` is "nothing missing", and a refused extent carries no list at
		// all — so without an explicit refusal a continent-sized Project would call itself available
		// offline having cached not one tile.
		const store = new MemoryProjectStore();
		const world: GeoBounds = { west: -179, south: -85, east: 179, north: 85 };
		const coverage = await offlineCoverage(store, world, 14);
		expect(coverage.budget.overThreshold).toBe(true);
		expect(coverage.complete).toBe(false);
		expect(coverage.missing).toEqual([]);
		expect(coverage.present).toBe(0);
	});
});

describe('baseMapCacheSize', () => {
	it('reports the deepest zoom on disk, which is how the map draws with no network', async () => {
		// The source archive's own maximum is the right number and needs the archive to be reachable.
		// Offline it is not, so the depth is read back off the files — a cancelled run leaves a shallower
		// cache and a map that overzooms rather than one that goes blank.
		const store = new MemoryProjectStore();
		const tiles = tileBudget(CANAL_BELT, 14).tiles.filter((tile) => tile.z <= 11);
		await fetchTilesIntoCache({ store, tiles, readTile: source().readTile });
		expect((await baseMapCacheSize(store)).maxZoom).toBe(11);
	});
});

describe('what the cache records about where it came from', () => {
	const ARCHIVE = 'https://example.test/basemaps.pmtiles';

	it('answers the source’s depth with no network, which is the whole point of the feature', async () => {
		// ⚠ Before this, "is this Project available offline?" opened the archive to learn the source's
		// maximum zoom — a live fetch on every Project open, every Base Map change, and every document
		// change. So offline, the one state the feature exists to remove, the UI could not say whether
		// the feature had worked. The depth recorded here came from the archive's own header, so it is
		// not `baseMapCacheSize().maxZoom` read back off our own files.
		const store = new MemoryProjectStore();
		await writeCachedTileSource(store, { archive: ARCHIVE, maxZoom: 14 });

		expect(await readCachedTileSource(store)).toEqual({ archive: ARCHIVE, maxZoom: 14 });
	});

	it('records nothing when nothing was recorded, rather than guessing', async () => {
		expect(await readCachedTileSource(new MemoryProjectStore())).toBeNull();
	});

	it('refuses a record it cannot believe rather than half-reading it', async () => {
		const store = new MemoryProjectStore();
		for (const body of ['not json', '{}', '{"archive":"","maxZoom":14}', `{"archive":"a"}`]) {
			await store.write(BASE_MAP_TILE_SOURCE_PATH, new TextEncoder().encode(body));
			expect(await readCachedTileSource(store), body).toBeNull();
		}
	});

	it('says when the tiles on disk came out of a different archive', async () => {
		// ADR-0020 promises that repointing a catalog entry needs no change anywhere else, and
		// `check-base-map-catalog.mjs` enforces it — so two entries on two archives is a supported
		// deployment, and `base-map/tiles/` carries no archive in its path. One directory would then
		// serve both: a plausible pane of the wrong map, with no error anywhere.
		const source = { archive: ARCHIVE, maxZoom: 14 };

		expect(cachedTilesMatchArchive(source, ARCHIVE)).toBe(true);
		expect(cachedTilesMatchArchive(source, 'https://example.test/other.pmtiles')).toBe(false);
		// Unknown provenance is not known-wrong: a cache filled before this record existed still draws.
		expect(cachedTilesMatchArchive(null, ARCHIVE)).toBe(true);
	});
});

describe('clearBaseMapCache', () => {
	it('takes the provenance record with it, so a cleared cache claims no archive', async () => {
		const store = new MemoryProjectStore();
		await fetchTilesIntoCache({
			store,
			tiles: tileBudget(CANAL_BELT, 14).tiles,
			readTile: source().readTile
		});
		await writeCachedTileSource(store, { archive: 'https://example.test/a.pmtiles', maxZoom: 14 });

		await clearBaseMapCache(store);

		expect(await readCachedTileSource(store)).toBeNull();
	});

	it('reclaims the cache and makes every Project report itself not available offline', async () => {
		const store = new MemoryProjectStore();
		await fetchTilesIntoCache({
			store,
			tiles: tileBudget(CANAL_BELT, 14).tiles,
			readTile: source(100).readTile
		});
		expect(await baseMapCacheSize(store)).toEqual({ tiles: 23, bytes: 2300, maxZoom: 14 });

		expect(await clearBaseMapCache(store)).toBe(23);

		expect(await baseMapCacheSize(store)).toEqual({ tiles: 0, bytes: 0, maxZoom: null });
		expect((await offlineCoverage(store, CANAL_BELT, 14)).complete).toBe(false);
		expect((await offlineCoverage(store, NEARBY, 14)).complete).toBe(false);
	});

	it('leaves everything outside the cache alone', async () => {
		const store = new MemoryProjectStore();
		await store.write('base-map/fonts/Noto Sans Regular/0-255.pbf', new Uint8Array(3));
		await store.write('my-project/project.json', new TextEncoder().encode('{}'));
		await fetchTilesIntoCache({
			store,
			tiles: tileBudget(CANAL_BELT, 14).tiles,
			readTile: source().readTile
		});
		await clearBaseMapCache(store);
		expect(await store.list('')).toEqual([
			'base-map/fonts/Noto Sans Regular/0-255.pbf',
			'my-project/project.json'
		]);
	});
});

describe('what the user is told before agreeing', () => {
	it('states the count, the estimate, and the zoom range', () => {
		const sentence = describeTileBudget(tileBudget(CANAL_BELT, 14));
		expect(sentence).toContain('23 tiles');
		expect(sentence).toMatch(/[0-9.]+ MB/);
		expect(sentence).toContain('every zoom level from 0 to 14');
	});

	it('says nothing when the request is within the threshold', () => {
		expect(tileBudgetRefusal(tileBudget(CANAL_BELT, 14))).toBe('');
	});

	it('refuses an over-threshold extent with the numbers and the reason', () => {
		const netherlands: GeoBounds = { west: 3.3, south: 50.7, east: 7.3, north: 53.6 };
		const budget = tileBudget(netherlands, 14);
		const refusal = tileBudgetRefusal(budget);
		expect(refusal).toContain(String(budget.count));
		expect(refusal).toContain(String(budget.limit));
		expect(refusal).toContain('Nothing has been fetched');
	});
});
