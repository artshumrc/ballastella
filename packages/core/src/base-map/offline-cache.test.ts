// The cache as files in a Workspace: what makes a Project available offline, and what unmakes it.
//
// SPEC's Seam 1 — "after this sequence of actions the store holds these files with this content" is
// the behaviour and not a proxy for it. Everything the criteria claim about deduplication, growth,
// refetching, and clearing is a claim about which paths exist, so it is asserted about paths.

import { describe, expect, it, vi } from 'vitest';

import {
	baseMapCacheSize,
	baseMapCaches,
	baseMapTileSourcePath,
	clearBaseMapCache,
	describeTileBudget,
	fetchTilesIntoCache,
	offlineCoverage,
	readCachedTileSource,
	tileBudgetRefusal,
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

/**
 * The deployment's archive, as a catalog entry spells it. Every cache in this file is keyed on it.
 *
 * A second one appears where two archives have to meet — the arrangement ticket 12 keyed the
 * directory for, and the one an unkeyed cache drew the wrong world in.
 */
const ARCHIVE = 'https://example.test/basemaps.pmtiles';

/** A fork's own extract: the same filename, a different host. */
const OTHER_ARCHIVE = 'https://other.test/basemaps.pmtiles';

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
		const coverage = await offlineCoverage(store, ARCHIVE, CANAL_BELT, 14);
		expect(coverage.budget.count).toBe(23);
		expect(coverage.missing.length).toBe(23);
		expect(coverage.present).toBe(0);
		expect(coverage.complete).toBe(false);
	});

	it('is complete once every tile the extent needs is a file', async () => {
		const store = new MemoryProjectStore();
		const { readTile } = source();
		await fetchTilesIntoCache({
			store,
			archive: ARCHIVE,
			tiles: tileBudget(CANAL_BELT, 14).tiles,
			readTile
		});
		const coverage = await offlineCoverage(store, ARCHIVE, CANAL_BELT, 14);
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
		await fetchTilesIntoCache({ store, archive: ARCHIVE, tiles: tiles.slice(0, -1), readTile });
		const coverage = await offlineCoverage(store, ARCHIVE, CANAL_BELT, 14);
		expect(coverage.present).toBe(22);
		expect(coverage.complete).toBe(false);
		expect(coverage.missing).toEqual([tiles[tiles.length - 1]]);
	});

	it('reports a second Project in the same area as available offline, having fetched nothing', async () => {
		const store = new MemoryProjectStore();
		const first = source();
		await fetchTilesIntoCache({
			store,
			archive: ARCHIVE,
			tiles: tileBudget(CANAL_BELT, 14).tiles,
			readTile: first.readTile
		});
		const before = (await baseMapCacheSize(store)).tiles;

		const second = await offlineCoverage(store, ARCHIVE, NEARBY, 14);
		expect(second.complete).toBe(true);
		expect(second.missing).toEqual([]);

		// Nothing fetched, and the tile count on disk did not grow: the cache is Workspace-level, so
		// the second Project is offline because of the first Project's tiles (ADR-0023, ADR-0025).
		const run = await fetchTilesIntoCache({
			store,
			archive: ARCHIVE,
			tiles: second.missing,
			readTile: first.readTile
		});
		expect(run.written).toBe(0);
		expect((await baseMapCacheSize(store)).tiles).toBe(before);
	});

	it('reports a Project whose extent has outgrown the cache as not available offline', async () => {
		const store = new MemoryProjectStore();
		const { readTile } = source();
		await fetchTilesIntoCache({
			store,
			archive: ARCHIVE,
			tiles: tileBudget(CANAL_BELT, 14).tiles,
			readTile
		});
		const grown = await offlineCoverage(store, ARCHIVE, GROWN, 14);
		expect(grown.complete).toBe(false);
		expect(grown.missing.length).toBeGreaterThan(0);
	});

	it('costs the Workspace nothing to ask, because the plan is only a plan', async () => {
		// What the dialog does before the user has agreed to anything: it counts, it quotes, and it says
		// the Project is not available offline — and it writes not one byte doing so. A budget that
		// touched the cache to answer would have spent somebody else's bandwidth (ADR-0007) on a
		// question, and the refusal below would already be too late.
		const store = new MemoryProjectStore();
		const coverage = await offlineCoverage(store, ARCHIVE, CANAL_BELT, 14);

		expect(describeTileBudget(coverage.budget)).toContain('23 tiles');
		expect(coverage.complete).toBe(false);
		expect(await store.list('')).toEqual([]);
	});

	it('ignores files under the cache directory that are not tiles', async () => {
		const store = new MemoryProjectStore();
		await store.write(
			`${baseMapTileDirectory(ARCHIVE)}readme.txt`,
			new TextEncoder().encode('hello')
		);
		expect(await baseMapCacheSize(store)).toEqual({ tiles: 0, bytes: 0, maxZoom: null });
	});
});

describe('fetchTilesIntoCache', () => {
	it('writes the ADR-0025 layout, and the bytes the source gave, verbatim', async () => {
		const store = new MemoryProjectStore();
		const { readTile } = source(64);
		const tiles = tileBudget(CANAL_BELT, 14).tiles;
		const run = await fetchTilesIntoCache({ store, archive: ARCHIVE, tiles, readTile });

		expect(run.written).toBe(23);
		expect(run.bytes).toBe(23 * 64);
		expect(await store.list(baseMapTileDirectory(ARCHIVE))).toEqual(
			[...tiles]
				.map((tile) => cachedTilePath(ARCHIVE, tile))
				.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		);
		// Stored as handed over — no compression step in either direction. See the note in
		// `tile-cache.ts`: converting here is the silent blank map.
		const one = await store.read(cachedTilePath(ARCHIVE, { z: 14, x: 8414, y: 5383 }));
		expect(one.byteLength).toBe(64);
		expect(one[0]).toBe(14);
	});

	it('writes a tile file for every zoom from 0 to the source maximum', async () => {
		// **Every** zoom, because omitting the low ones makes zooming out go blank inside an area the
		// user was told is available offline (ADR-0025, SPEC story 6) — and an empty tile is not an
		// error, so the failure is a blank pane with nothing to show for it.
		const store = new MemoryProjectStore();
		await fetchTilesIntoCache({
			store,
			archive: ARCHIVE,
			tiles: tileBudget(CANAL_BELT, 14).tiles,
			readTile: source().readTile
		});

		const paths = await store.list(baseMapTileDirectory(ARCHIVE));
		expect(paths.length).toBe(23);
		// The zoom is the segment after the archive key: `base-map/tiles/<key>/<z>/…`.
		const zooms = [...new Set(paths.map((path) => Number(path.split('/')[3])))].sort(
			(a, b) => a - b
		);
		expect(zooms).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
		expect(paths).toContain(`${baseMapTileDirectory(ARCHIVE)}0/0/0.mvt`);
		expect(paths).toContain(`${baseMapTileDirectory(ARCHIVE)}14/8414/5383.mvt`);

		expect((await offlineCoverage(store, ARCHIVE, CANAL_BELT, 14)).complete).toBe(true);
	});

	it('fetches only tiles not already present when it is run again', async () => {
		const store = new MemoryProjectStore();
		const first = source();
		const tiles = tileBudget(CANAL_BELT, 14).tiles;
		// A first, partial run: the user cancelled, or the tab died.
		await fetchTilesIntoCache({
			store,
			archive: ARCHIVE,
			tiles: tiles.slice(0, 10),
			readTile: first.readTile
		});

		const second = source();
		const coverage = await offlineCoverage(store, ARCHIVE, CANAL_BELT, 14);
		const run = await fetchTilesIntoCache({
			store,
			archive: ARCHIVE,
			tiles: coverage.missing,
			readTile: second.readTile
		});

		expect(run.written).toBe(13);
		expect(second.asked.length).toBe(13);
		expect(second.asked.map((tile) => cachedTilePath(ARCHIVE, tile))).not.toContain(
			cachedTilePath(ARCHIVE, tiles[0] as TileCoordinate)
		);
		expect((await offlineCoverage(store, ARCHIVE, CANAL_BELT, 14)).complete).toBe(true);
	});

	it('does not write a tile the source has nothing at, so coverage stays honest', async () => {
		const store = new MemoryProjectStore();
		const tiles = tileBudget(CANAL_BELT, 14).tiles;
		const run = await fetchTilesIntoCache({
			store,
			archive: ARCHIVE,
			tiles,
			readTile: async (tile) => (tile.z === 14 ? null : new Uint8Array(8))
		});
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
		await fetchTilesIntoCache({
			store,
			archive: ARCHIVE,
			tiles,
			readTile: source().readTile,
			onProgress
		});
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
		const coverage = await offlineCoverage(store, ARCHIVE, world, 14);
		expect(coverage.budget.overThreshold).toBe(true);
		expect(coverage.complete).toBe(false);
		expect(coverage.missing).toEqual([]);
		expect(coverage.present).toBe(0);
	});

	it('is refused with the numbers, and nothing is fetched', async () => {
		// ADR-0007's courtesy: this fetches from somebody else's server, so the refusal has to carry the
		// numbers — a tool declining without saying what it declined — and it has to happen *before*
		// anything is written, which is the half a sentence alone cannot assert.
		//
		// A third of a degree square rather than a continent, because the mutation this was watched to
		// fail against removes the refusal and then really does enumerate and fetch the extent; the
		// continent case is `tile-cache.test.ts`'s "a continent at hundreds of thousands".
		const store = new MemoryProjectStore();
		const spread: GeoBounds = { west: 4.8, south: 52.3, east: 5.1, north: 52.6 };
		const coverage = await offlineCoverage(store, ARCHIVE, spread, 14);

		const refusal = tileBudgetRefusal(coverage.budget);
		expect(coverage.budget.count).toBeGreaterThan(OFFLINE_TILE_LIMIT);
		expect(refusal).toContain(String(coverage.budget.count));
		expect(refusal).toContain(`${OFFLINE_TILE_LIMIT} tiles`);
		expect(refusal).toContain('Nothing has been fetched');

		// And the extent carries no work to do, so the caller that hands `missing` to the fetch loop
		// cannot fetch one tile of it either.
		const run = await fetchTilesIntoCache({
			store,
			archive: ARCHIVE,
			tiles: coverage.missing,
			readTile: source().readTile
		});
		expect(run.written).toBe(0);
		expect(await store.list('')).toEqual([]);
	});
});

describe('baseMapCacheSize', () => {
	it('reports the deepest zoom on disk, which is how the map draws with no network', async () => {
		// The source archive's own maximum is the right number and needs the archive to be reachable.
		// Offline it is not, so the depth is read back off the files — a cancelled run leaves a shallower
		// cache and a map that overzooms rather than one that goes blank.
		const store = new MemoryProjectStore();
		const tiles = tileBudget(CANAL_BELT, 14).tiles.filter((tile) => tile.z <= 11);
		await fetchTilesIntoCache({ store, archive: ARCHIVE, tiles, readTile: source().readTile });
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

		expect(await readCachedTileSource(store, ARCHIVE)).toEqual({ archive: ARCHIVE, maxZoom: 14 });
	});

	it('records nothing when nothing was recorded, rather than guessing', async () => {
		expect(await readCachedTileSource(new MemoryProjectStore(), ARCHIVE)).toBeNull();
	});

	it('refuses a record it cannot believe rather than half-reading it', async () => {
		const store = new MemoryProjectStore();
		for (const body of ['not json', '{}', '{"archive":"","maxZoom":14}', `{"archive":"a"}`]) {
			await store.write(baseMapTileSourcePath(ARCHIVE), new TextEncoder().encode(body));
			expect(await readCachedTileSource(store, ARCHIVE), body).toBeNull();
		}
	});

	it('refuses a record naming an archive other than the one asked about', async () => {
		// It can only arrive by a hand edit or a key collision, and "unknown" is the honest reading: the
		// caller then reaches for the network rather than trusting a foreign archive's depth.
		const store = new MemoryProjectStore();
		await store.write(
			baseMapTileSourcePath(ARCHIVE),
			new TextEncoder().encode(JSON.stringify({ archive: OTHER_ARCHIVE, maxZoom: 14 }))
		);

		expect(await readCachedTileSource(store, ARCHIVE)).toBeNull();
	});
});

describe('a Workspace filled before the directory was keyed (ticket 11)', () => {
	/** The unkeyed layout, seeded the way ticket 11's build left it. */
	const seedLegacy = async (store: MemoryProjectStore, tiles: readonly TileCoordinate[]) => {
		for (const tile of tiles) await store.write(legacyCachedTilePath(tile), new Uint8Array(100));
	};

	it('is counted by the hub rather than being invisible disk', async () => {
		// Bytes a user deliberately fetched from somebody else's server. A size report that stopped
		// seeing them would show a Workspace smaller than it is and offer no way to reclaim them.
		const store = new MemoryProjectStore();
		await seedLegacy(store, tileBudget(CANAL_BELT, 14).tiles);

		expect(await baseMapCacheSize(store)).toEqual({ tiles: 23, bytes: 2300, maxZoom: 14 });
		const [only] = await baseMapCaches(store);
		expect(only?.legacy).toBe(true);
		expect(only?.archive).toBeNull();
	});

	it('is cleared by the hub’s clear, and counted once', async () => {
		// Its "directory" is the root, so a naive clear would walk every keyed cache's tiles through it
		// as well and report a total larger than what it removed.
		const store = new MemoryProjectStore();
		await seedLegacy(store, tileBudget(CANAL_BELT, 14).tiles);
		await fetchTilesIntoCache({
			store,
			archive: ARCHIVE,
			tiles: tileBudget(CANAL_BELT, 14).tiles,
			readTile: source().readTile
		});

		expect(await clearBaseMapCache(store)).toBe(46);

		expect(await baseMapCacheSize(store)).toEqual({ tiles: 0, bytes: 0, maxZoom: null });
	});

	it('does not make a Project report itself available offline for an archive', async () => {
		// The one thing it must not do. A tile whose provenance is unknown cannot support a claim
		// about a particular archive — that is the wrong-map failure keying exists to end, arriving
		// through the legacy reader instead.
		const store = new MemoryProjectStore();
		await seedLegacy(store, tileBudget(CANAL_BELT, 14).tiles);

		expect((await offlineCoverage(store, ARCHIVE, CANAL_BELT, 14)).complete).toBe(false);
	});
});

describe('clearBaseMapCache', () => {
	it('takes the provenance record with it, so a cleared cache claims no archive', async () => {
		const store = new MemoryProjectStore();
		await fetchTilesIntoCache({
			store,
			archive: ARCHIVE,
			tiles: tileBudget(CANAL_BELT, 14).tiles,
			readTile: source().readTile
		});
		await writeCachedTileSource(store, { archive: ARCHIVE, maxZoom: 14 });

		await clearBaseMapCache(store);

		expect(await readCachedTileSource(store, ARCHIVE)).toBeNull();
	});

	it('reclaims the cache and makes every Project report itself not available offline', async () => {
		const store = new MemoryProjectStore();
		await fetchTilesIntoCache({
			store,
			archive: ARCHIVE,
			tiles: tileBudget(CANAL_BELT, 14).tiles,
			readTile: source(100).readTile
		});
		expect(await baseMapCacheSize(store)).toEqual({ tiles: 23, bytes: 2300, maxZoom: 14 });

		expect(await clearBaseMapCache(store)).toBe(23);

		expect(await baseMapCacheSize(store)).toEqual({ tiles: 0, bytes: 0, maxZoom: null });
		expect((await offlineCoverage(store, ARCHIVE, CANAL_BELT, 14)).complete).toBe(false);
		expect((await offlineCoverage(store, ARCHIVE, NEARBY, 14)).complete).toBe(false);
	});

	it('leaves everything outside the cache alone', async () => {
		const store = new MemoryProjectStore();
		await store.write('base-map/fonts/Noto Sans Regular/0-255.pbf', new Uint8Array(3));
		await store.write('my-project/project.json', new TextEncoder().encode('{}'));
		await fetchTilesIntoCache({
			store,
			archive: ARCHIVE,
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
