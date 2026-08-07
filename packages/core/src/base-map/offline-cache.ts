// The Base Map tile cache as it sits in the Workspace: what is there, what is missing, and how the
// missing part is filled (ADR-0025).
//
// The enumeration is next door in `tile-cache.ts` and is pure. This module is the half that touches
// the store, and it is deliberately thin: every question it answers is "which of these paths exist",
// which is what makes **"is this Project available offline?" computed rather than stored**. There is
// no flag anywhere. A Project is available offline exactly when every tile its extent needs is a file
// on disk, so a cache the user cleared, a Project whose content has since grown, and a second Project
// that happens to sit inside an area already cached all give the right answer without anything being
// written or maintained.
//
// **Where the tiles come from is injected** (ADR-0011), the same seam `createStoreImageFetch` sits on
// for Historical Map pyramids: {@link fetchTilesIntoCache} takes a `readTile` and knows nothing about
// PMTiles, HTTP, or the catalog. The app supplies a reader over the deployment's archive; the tests
// supply one over a fixture, and reach no network.

import {
	BASE_MAP_TILE_DIRECTORY,
	cachedTilePath,
	parseCachedTilePath,
	tileBudget,
	type TileBudget,
	type TileCoordinate
} from './tile-cache.js';
import type { GeoBounds } from '../project/opening-view.js';
import { describeBytes } from '../project/workspace-size.js';
import type { Bytes, ProjectStore } from '../store/project-store.js';

/** How much of what one Project's extent needs is already on disk. */
export interface OfflineCoverage {
	/** The budget for the extent: every tile it needs, the count, and the estimate. */
	readonly budget: TileBudget;
	/** The tiles of {@link budget} that are **not** on disk, in the order they will be fetched. */
	readonly missing: readonly TileCoordinate[];
	/** How many of {@link budget}'s tiles are on disk already. */
	readonly present: number;
	/**
	 * Whether this Project is available offline: **every** tile its extent needs is present.
	 *
	 * False for a partial cache, which is the contract ADR-0025 is emphatic about — a tile outside the
	 * cache is served as an empty tile rather than an error, so a partly cached Project draws with
	 * holes and looks fine until the user pans. The Project-level claim must not be made from the
	 * absence of a complaint.
	 */
	readonly complete: boolean;
}

/** The paths of every tile in the cache, as a set, from one `list`. */
async function cachedPaths(store: ProjectStore): Promise<Set<string>> {
	return new Set(
		(await store.list(BASE_MAP_TILE_DIRECTORY)).filter((path) => parseCachedTilePath(path) !== null)
	);
}

/**
 * Whether a Project whose content occupies `bounds` is available offline, and what filling it takes.
 *
 * `bounds` is `projectOpeningBounds`' answer — the same box ADR-0026 frames the Project on, so the
 * area cached is the area the Project opens on and the two cannot drift. A Project with nothing
 * placed on the earth has `null` bounds and nothing to cache: it is not "available offline", because
 * there is no extent to make that claim about, and the caller says so in those words.
 */
export async function offlineCoverage(
	store: ProjectStore,
	bounds: GeoBounds,
	maxZoom: number
): Promise<OfflineCoverage> {
	const budget = tileBudget(bounds, maxZoom);
	const have = await cachedPaths(store);
	const missing = budget.tiles.filter((tile) => !have.has(cachedTilePath(tile)));
	return {
		budget,
		missing,
		present: budget.count - missing.length,
		complete: budget.count > 0 && missing.length === 0
	};
}

/** What the cache holds. */
export interface BaseMapCacheSize {
	readonly tiles: number;
	readonly bytes: number;
	/**
	 * The deepest zoom any cached tile is at, or `null` for an empty cache.
	 *
	 * **This is how the map is drawn with no network at all.** The source archive's own maximum is the
	 * right number and is what the cache is filled to — but reading it means opening the archive, which
	 * is exactly what is unavailable offline. So the depth is read back off the files. A cache filled
	 * completely gives the same answer either way; a cache left half filled by a cancelled run gives a
	 * shallower one, and a map capped at z11 that overzooms is a far better offline outcome than a map
	 * that goes blank above it.
	 */
	readonly maxZoom: number | null;
}

/** How much room the cache is taking, for the hub. `list` + `size`, never `read` (ADR-0001). */
export async function baseMapCacheSize(store: ProjectStore): Promise<BaseMapCacheSize> {
	const paths = [...(await cachedPaths(store))];
	const sizes = await Promise.all(paths.map((path) => store.size(path).catch(() => 0)));
	const zooms = paths.map((path) => parseCachedTilePath(path)?.z ?? 0);
	return {
		tiles: paths.length,
		bytes: sizes.reduce((sum, size) => sum + size, 0),
		maxZoom: zooms.length === 0 ? null : Math.max(...zooms)
	};
}

/**
 * Delete every cached tile, and report how many went.
 *
 * Confined to paths {@link parseCachedTilePath} recognises, so a file somebody put under
 * `base-map/tiles/` by hand is left alone rather than swept up by a reclaim action.
 */
export async function clearBaseMapCache(store: ProjectStore): Promise<number> {
	const paths = [...(await cachedPaths(store))];
	for (const path of paths) await store.delete(path);
	return paths.length;
}

/** Where one tile's bytes come from: `null` when the source has no tile there. */
export type ReadSourceTile = (tile: TileCoordinate) => Promise<Bytes | null>;

/** What one run of {@link fetchTilesIntoCache} did. */
export interface TileFetchResult {
	/** Tiles written to the cache by this run. */
	readonly written: number;
	/** Bytes those tiles weigh — **measured**, not the estimate the user agreed to. */
	readonly bytes: number;
	/** Tiles the source had nothing at. Ordinary: an extract does not cover the whole world. */
	readonly absent: number;
	/** Whether the run was stopped by its `signal` before it finished. */
	readonly cancelled: boolean;
}

export interface FetchTilesOptions {
	readonly store: ProjectStore;
	/** The tiles to fetch. Pass {@link OfflineCoverage.missing}, never the whole budget. */
	readonly tiles: readonly TileCoordinate[];
	readonly readTile: ReadSourceTile;
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: {
		readonly done: number;
		readonly total: number;
		readonly bytes: number;
	}) => void;
}

/**
 * Fetch tiles from the source and write them into the Workspace.
 *
 * **Only what it is given, and it is given only what is missing** (ADR-0025: "do not refetch tiles
 * already in the cache"). The skip is the caller's, computed once by {@link offlineCoverage}, rather
 * than a `read` per tile here — which would be a second answer to the same question and one more
 * place for the two to disagree.
 *
 * A tile the source has nothing at is counted and skipped rather than written empty. Writing a
 * zero-byte file would make the coverage check say the Project is complete while the map draws a
 * hole, which is precisely the lie the computed claim exists to make impossible.
 */
export async function fetchTilesIntoCache(options: FetchTilesOptions): Promise<TileFetchResult> {
	const { store, tiles, readTile, signal, onProgress } = options;
	let written = 0;
	let bytes = 0;
	let absent = 0;
	let done = 0;
	for (const tile of tiles) {
		if (signal?.aborted) return { written, bytes, absent, cancelled: true };
		const data = await readTile(tile);
		if (data === null || data.byteLength === 0) {
			absent += 1;
		} else {
			await store.write(cachedTilePath(tile), data);
			written += 1;
			bytes += data.byteLength;
		}
		done += 1;
		onProgress?.({ done, total: tiles.length, bytes });
	}
	return { written, bytes, absent, cancelled: false };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// What the user reads before they agree
//
// The sentences live here rather than in the editor because the numbers are core's and the refusal
// is a contract rather than a presentation choice: ADR-0007 requires the cost be stated before
// somebody else's server is asked for it, and a refusal that did not carry the numbers would be the
// tool declining without saying what it declined.

/** The count and the estimate, in one sentence, for the dialog. */
export function describeTileBudget(budget: TileBudget): string {
	return (
		`${budget.count} ${budget.count === 1 ? 'tile' : 'tiles'}, about ` +
		`${describeBytes(budget.estimatedBytes)}, covering every zoom level from 0 to ${budget.maxZoom}.`
	);
}

/**
 * Why an over-threshold request is refused, with the numbers — or `''` when it is not refused.
 *
 * It names the area rather than the user: an extent this large is a Project spread across a country
 * or a continent, and the way out is to make a smaller Project available offline rather than to try
 * again.
 */
export function tileBudgetRefusal(budget: TileBudget): string {
	if (!budget.overThreshold) return '';
	return (
		`This Project's work is spread over an area needing ${budget.count} Base Map tiles, about ` +
		`${describeBytes(budget.estimatedBytes)}, which is past the ${budget.limit} tiles Ballastella ` +
		`will fetch in one go. Those tiles come from somebody else's server, and a request this large ` +
		`is one it should not be asked for unannounced. Nothing has been fetched. A Project covering a ` +
		`city or a neighbourhood is tens of tiles; if this Project really does span a country, split ` +
		`the work into Projects that each cover the area their argument is about.`
	);
}
