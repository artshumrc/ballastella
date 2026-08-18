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
// for Map Image pyramids: {@link fetchTilesIntoCache} takes a `readTile` and knows nothing about
// PMTiles, HTTP, or the catalog. The app supplies a reader over the deployment's archive; the tests
// supply one over a fixture, and reach no network.

import {
	BASE_MAP_TILE_ROOT,
	baseMapTileDirectory,
	cachedTilePath,
	parseAnyCachedTilePath,
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

/** The paths of every tile one archive's cache holds, as a set, from one `list`. */
async function cachedPaths(store: ProjectStore, archive: string): Promise<Set<string>> {
	return new Set(
		(await store.list(baseMapTileDirectory(archive))).filter(
			(path) => parseCachedTilePath(archive, path) !== null
		)
	);
}

/**
 * Whether a Project whose content occupies `bounds` is available offline, and what filling it takes.
 *
 * `archive` is the catalog entry's own `archive` string — see {@link baseMapArchiveKey} for why it
 * is that and not the URL a deployment resolves it to. Coverage is asked *of one archive*, because
 * a Workspace may hold a cache for each of several and a Project drawn on one of them is not made
 * available offline by another's tiles.
 *
 * `bounds` is `projectOpeningBounds`' answer — the same box ADR-0026 frames the Project on, so the
 * area cached is the area the Project opens on and the two cannot drift. A Project with nothing
 * placed on the earth has `null` bounds and nothing to cache: it is not "available offline", because
 * there is no extent to make that claim about, and the caller says so in those words.
 */
export async function offlineCoverage(
	store: ProjectStore,
	archive: string,
	bounds: GeoBounds,
	maxZoom: number
): Promise<OfflineCoverage> {
	const budget = tileBudget(bounds, maxZoom);
	// A refused extent carries no tile list — see `countTilesForBounds` — so there is nothing to look
	// for and nothing to claim. **Said explicitly rather than falling out of an empty `missing`**: an
	// empty list of missing tiles is exactly what "complete" is computed from, so without this a
	// continent-sized Project would report itself available offline having cached nothing at all.
	if (budget.overThreshold) {
		return { budget, missing: [], present: 0, complete: false };
	}
	const have = await cachedPaths(store, archive);
	const missing = budget.tiles.filter((tile) => !have.has(cachedTilePath(archive, tile)));
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

/** One archive's cache as it sits in the Workspace. */
export interface BaseMapCache extends BaseMapCacheSize {
	/** The archive the cache's own record names, or `null` when it records none. */
	readonly archive: string | null;
	/**
	 * Whether this is the **pre-ticket-12 unkeyed pile** at `base-map/tiles/{z}/…`.
	 *
	 * Distinct from `archive === null`, which a keyed cache reaches by losing its record. A legacy
	 * pile is not missing its provenance so much as predating the idea: there was one directory and
	 * it served whichever catalog entry was showing. Nothing writes it any more.
	 */
	readonly legacy: boolean;
	/** The directory the tiles are in, with its trailing `/`. The root itself when {@link legacy}. */
	readonly directory: string;
	/**
	 * The source's own maximum zoom as its header reported it at fetch time, or `null` when
	 * unrecorded. **Not** {@link BaseMapCacheSize.maxZoom}, which is read back off the files — see
	 * the note above {@link CachedTileSource} for why the two are different questions.
	 */
	readonly sourceMaxZoom: number | null;
}

/**
 * Every archive this Workspace has cached tiles for.
 *
 * The whole-Workspace read, for the three callers that must answer for all of them at once: the
 * hub's size and clear, and publishing, which writes the list into the site record because a
 * Reader's HTTP store cannot list a directory (ADR-0006). One `list` of {@link BASE_MAP_TILE_ROOT}
 * and a `size` per tile — never a `read` of one (ADR-0001) — plus one small `read` per archive for
 * the provenance record, which is the only place a key can be turned back into an archive.
 */
export async function baseMapCaches(store: ProjectStore): Promise<BaseMapCache[]> {
	/** `null` is the pre-ticket-12 unkeyed pile — see {@link parseAnyCachedTilePath}. */
	const byKey = new Map<string | null, { paths: string[]; zooms: number[] }>();
	for (const path of await store.list(BASE_MAP_TILE_ROOT)) {
		const parsed = parseAnyCachedTilePath(path);
		if (parsed === null) continue;
		const found = byKey.get(parsed.key) ?? { paths: [], zooms: [] };
		found.paths.push(path);
		found.zooms.push(parsed.tile.z);
		byKey.set(parsed.key, found);
	}

	return Promise.all(
		[...byKey].map(async ([key, { paths, zooms }]) => {
			// The unkeyed pile lives directly in the root, so its "directory" is the root — which is why
			// every caller that deletes filters by the parser rather than by the prefix.
			const directory = key === null ? BASE_MAP_TILE_ROOT : `${BASE_MAP_TILE_ROOT}${key}/`;
			const sizes = await Promise.all(paths.map((path) => store.size(path).catch(() => 0)));
			const record =
				key === null ? null : await readTileSourceAt(store, `${directory}${TILE_SOURCE_NAME}`);
			return {
				archive: record?.archive ?? null,
				legacy: key === null,
				directory,
				sourceMaxZoom: record?.maxZoom ?? null,
				tiles: paths.length,
				bytes: sizes.reduce((sum, size) => sum + size, 0),
				maxZoom: zooms.length === 0 ? null : Math.max(...zooms)
			};
		})
	);
}

/**
 * How much room **every** Base Map cache in this Workspace is taking, for the hub.
 *
 * Summed across archives rather than asked of one, because the sentence it feeds is about the
 * Workspace's disk and the button beside it clears the lot. `maxZoom` is the deepest zoom anywhere
 * in it, which is the honest answer to "how deep does what is on disk go".
 */
export async function baseMapCacheSize(store: ProjectStore): Promise<BaseMapCacheSize> {
	return totalBaseMapCacheSize(await baseMapCaches(store));
}

/**
 * What **one archive's** cache holds, for the pane that is about to draw from it.
 *
 * The Project screen's counterpart to {@link baseMapCacheSize}: the map is drawn from the tiles of
 * the entry the author picked, and `maxZoom` here is what the style's `maxzoom` is set to. Summing
 * across archives for that would cap the source at another archive's depth — MapLibre would then ask
 * for tiles this one has none of, and the map goes blank above the zoom that actually works.
 */
export async function baseMapCacheSizeFor(
	store: ProjectStore,
	archive: string
): Promise<BaseMapCacheSize> {
	const paths = [...(await cachedPaths(store, archive))];
	const sizes = await Promise.all(paths.map((path) => store.size(path).catch(() => 0)));
	const zooms = paths.map((path) => parseCachedTilePath(archive, path)?.z ?? 0);
	return {
		tiles: paths.length,
		bytes: sizes.reduce((sum, size) => sum + size, 0),
		maxZoom: zooms.length === 0 ? null : Math.max(...zooms)
	};
}

/** {@link baseMapCacheSize} over a list already in hand, so publishing walks the folder once. */
export function totalBaseMapCacheSize(caches: readonly BaseMapCache[]): BaseMapCacheSize {
	const depths = caches.map((cache) => cache.maxZoom).filter((zoom) => zoom !== null);
	return {
		tiles: caches.reduce((sum, cache) => sum + cache.tiles, 0),
		bytes: caches.reduce((sum, cache) => sum + cache.bytes, 0),
		maxZoom: depths.length === 0 ? null : Math.max(...depths)
	};
}

/**
 * Delete every cached tile of every archive, and report how many went.
 *
 * Confined to paths {@link parseAnyCachedTilePath} recognises, so a file somebody put under
 * `base-map/tiles/` by hand is left alone rather than swept up by a reclaim action.
 */
export async function clearBaseMapCache(store: ProjectStore): Promise<number> {
	const caches = await baseMapCaches(store);
	let cleared = 0;
	for (const cache of caches) {
		for (const path of await store.list(cache.directory)) {
			const parsed = parseAnyCachedTilePath(path);
			// A legacy pile's "directory" is the root, so its listing sees every keyed cache's tiles
			// too. Deleting those here would remove them once per cache — harmless for the files and
			// wrong for the count, which is what the hub tells the user it removed.
			if (parsed === null || (parsed.key === null) !== cache.legacy) continue;
			await store.delete(path);
			cleared += 1;
		}
		// The provenance record goes with them. Leaving it would have a cleared cache still claiming an
		// archive and a depth, which is the one way {@link readCachedTileSource} could lie.
		await store.delete(`${cache.directory}${TILE_SOURCE_NAME}`).catch(() => undefined);
	}
	return cleared;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHICH ARCHIVE FILLED THE CACHE, AND HOW DEEP IT GOES
//
// One small file beside the tiles, written when a run finishes. It exists for two questions the
// tiles themselves cannot answer.
//
// **"Is this Project available offline?" must be answerable offline.** Coverage needs the *source's*
// maximum zoom — ADR-0025 says "every zoom from 0 to the source's maximum" — and reading that off the
// archive is a network fetch on every Project open. So the state the feature exists to remove was
// the one state in which the feature could not say whether it had worked. The number recorded here
// came from the archive's own header at fetch time, so using it offline is not the vacuous claim
// {@link BaseMapCacheSize.maxZoom} warns about: that one is read back off our own files and can only
// under-report a half-filled cache, which is why it is right for *drawing* and wrong for *claiming*.
//
// **And the key alone does not say which archive it is.** {@link baseMapArchiveKey} is one-way, so
// the record is also what lets `base-map/tiles/<key>/` be read back as an archive — which publishing
// needs, because a Published Site's viewer has an HTTP store that cannot list a directory (ADR-0006)
// and has to be told on the site record which archives it carries tiles for.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NO LONGER ALSO A MISMATCH DETECTOR (ticket 12)
//
// Ticket 11 left the cache as one directory shared by every catalog entry and covered the resulting
// wrong-map risk with a comparison — `cachedTilesMatchArchive`, checked at each call site. Keying the
// directory removes the state that check existed for: two archives can no longer meet in one
// directory, so there is nothing left to compare and nothing left for a call site to forget. The one
// residue is kept here rather than deleted — {@link readCachedTileSource} refuses a record whose
// `archive` is not the one asked for, so a hand-edited or colliding record is "unknown" rather than
// authoritative — and it is one function's business instead of every caller's.

/** Which archive filled the cache, and how deep that archive said it went. */
export interface CachedTileSource {
	/**
	 * The catalog entry's own `archive` string. Identity, not a fetch target.
	 *
	 * Deliberately the *unresolved* string — see {@link baseMapArchiveKey}. A bundled archive is a
	 * deployment-relative path, and recording the URL the editor resolved it to would make a Workspace
	 * published to another host disagree with itself about which archive its own tiles came from.
	 */
	readonly archive: string;
	/** The source's own maximum zoom, read from its header — not read back off the cached files. */
	readonly maxZoom: number;
}

/** The record's filename inside one archive's keyed directory. */
const TILE_SOURCE_NAME = 'tile-source.json';

/**
 * Where one archive's {@link CachedTileSource} lives: inside its own keyed directory.
 *
 * Inside rather than beside, so that deleting the directory deletes the claim with it. A record
 * outliving the tiles it describes is the one way this can lie.
 */
export const baseMapTileSourcePath = (archive: string): string =>
	`${baseMapTileDirectory(archive)}${TILE_SOURCE_NAME}`;

/** The record at one exact path, or `null` when there is none or it cannot be believed. */
async function readTileSourceAt(
	store: ProjectStore,
	path: string
): Promise<CachedTileSource | null> {
	let bytes: Bytes;
	try {
		bytes = await store.read(path);
	} catch {
		// No record. A cache filled before this file existed, or none at all — in both cases the answer
		// is "unknown", which the callers treat as needing the network rather than as a mismatch.
		return null;
	}
	try {
		const record: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (typeof record !== 'object' || record === null) return null;
		const { archive, maxZoom } = record as { archive?: unknown; maxZoom?: unknown };
		if (typeof archive !== 'string' || archive === '') return null;
		if (typeof maxZoom !== 'number' || !Number.isInteger(maxZoom) || maxZoom < 0) return null;
		return { archive, maxZoom };
	} catch {
		return null;
	}
}

/** What one archive's cache records about where it came from, or `null` when it records nothing. */
export async function readCachedTileSource(
	store: ProjectStore,
	archive: string
): Promise<CachedTileSource | null> {
	const record = await readTileSourceAt(store, baseMapTileSourcePath(archive));
	// A record in this archive's directory naming a different archive is not evidence about this
	// archive. It can only arrive by a hand edit or a key collision, and in both cases "unknown" is the
	// honest answer — the callers then reach for the network rather than trusting a foreign depth.
	return record !== null && record.archive === archive ? record : null;
}

/** Record where one archive's cache came from. Written after a run, never before one. */
export async function writeCachedTileSource(
	store: ProjectStore,
	source: CachedTileSource
): Promise<void> {
	await store.write(
		baseMapTileSourcePath(source.archive),
		new TextEncoder().encode(JSON.stringify(source)) as Bytes
	);
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
	/** Whose cache these tiles go in — the catalog entry's own `archive` string. */
	readonly archive: string;
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
	const { store, archive, tiles, readTile, signal, onProgress } = options;
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
			await store.write(cachedTilePath(archive, tile), data);
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
