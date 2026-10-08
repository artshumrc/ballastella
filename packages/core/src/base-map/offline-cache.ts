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
import { jsonObjectOrNull, type Bytes, type ProjectStore } from '../store/project-store.js';

export interface OfflineCoverage {
	readonly budget: TileBudget;
	readonly missing: readonly TileCoordinate[];
	readonly present: number;
	readonly complete: boolean;
}

const TILE_SOURCE_NAME = 'tile-source.json';

async function cachedPaths(store: ProjectStore, archive: string): Promise<Set<string>> {
	return new Set(
		(await store.list(baseMapTileDirectory(archive))).filter(
			(path) => parseCachedTilePath(archive, path) !== null
		)
	);
}

export async function offlineCoverage(
	store: ProjectStore,
	archive: string,
	bounds: GeoBounds,
	maxZoom: number
): Promise<OfflineCoverage> {
	const budget = tileBudget(bounds, maxZoom);
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

export interface BaseMapCacheSize {
	readonly tiles: number;
	readonly bytes: number;
	readonly maxZoom: number | null;
}

export interface BaseMapCache extends BaseMapCacheSize {
	readonly archive: string | null;
	readonly legacy: boolean;
	readonly sourceMaxZoom: number | null;
}

export async function baseMapCaches(store: ProjectStore): Promise<BaseMapCache[]> {
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
			const record =
				key === null
					? null
					: await readTileSourceAt(store, `${BASE_MAP_TILE_ROOT}${key}/${TILE_SOURCE_NAME}`);
			return {
				archive: record?.archive ?? null,
				legacy: key === null,
				sourceMaxZoom: record?.maxZoom ?? null,
				...(await cacheSize(store, paths, zooms))
			};
		})
	);
}

export async function baseMapCacheSizeFor(
	store: ProjectStore,
	archive: string
): Promise<BaseMapCacheSize> {
	const paths = [...(await cachedPaths(store, archive))];
	return cacheSize(
		store,
		paths,
		paths.map((path) => parseCachedTilePath(archive, path)?.z ?? 0)
	);
}

async function cacheSize(
	store: ProjectStore,
	paths: readonly string[],
	zooms: readonly number[]
): Promise<BaseMapCacheSize> {
	const sizes = await Promise.all(paths.map((path) => store.size(path).catch(() => 0)));
	return {
		tiles: paths.length,
		bytes: sizes.reduce((sum, size) => sum + size, 0),
		maxZoom: zooms.length === 0 ? null : Math.max(...zooms)
	};
}

export function totalBaseMapCacheSize(caches: readonly BaseMapCache[]): BaseMapCacheSize {
	const depths = caches.map((cache) => cache.maxZoom).filter((zoom) => zoom !== null);
	return {
		tiles: caches.reduce((sum, cache) => sum + cache.tiles, 0),
		bytes: caches.reduce((sum, cache) => sum + cache.bytes, 0),
		maxZoom: depths.length === 0 ? null : Math.max(...depths)
	};
}

interface CachedTileSource {
	readonly archive: string;
	readonly maxZoom: number;
}

export const baseMapTileSourcePath = (archive: string): string =>
	`${baseMapTileDirectory(archive)}${TILE_SOURCE_NAME}`;

async function readTileSourceAt(
	store: ProjectStore,
	path: string
): Promise<CachedTileSource | null> {
	try {
		const { archive, maxZoom } = jsonObjectOrNull(await store.read(path)) ?? {};
		if (typeof archive !== 'string' || archive === '') return null;
		if (typeof maxZoom !== 'number' || !Number.isInteger(maxZoom) || maxZoom < 0) return null;
		return { archive, maxZoom };
	} catch {
		return null;
	}
}

export async function readCachedTileSource(
	store: ProjectStore,
	archive: string
): Promise<CachedTileSource | null> {
	const record = await readTileSourceAt(store, baseMapTileSourcePath(archive));
	return record !== null && record.archive === archive ? record : null;
}

export async function writeCachedTileSource(
	store: ProjectStore,
	source: CachedTileSource
): Promise<void> {
	await store.write(
		baseMapTileSourcePath(source.archive),
		new TextEncoder().encode(JSON.stringify(source)) as Bytes
	);
}

interface TileFetchResult {
	readonly written: number;
	readonly bytes: number;
	readonly absent: number;
	readonly cancelled: boolean;
}

interface FetchTilesOptions {
	readonly store: ProjectStore;
	readonly archive: string;
	readonly tiles: readonly TileCoordinate[];
	readonly readTile: (tile: TileCoordinate) => Promise<Bytes | null>;
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: {
		readonly done: number;
		readonly total: number;
		readonly bytes: number;
	}) => void;
}

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

export function describeTileBudget(budget: TileBudget): string {
	return (
		`${budget.count} ${budget.count === 1 ? 'tile' : 'tiles'}, about ` +
		`${describeBytes(budget.estimatedBytes)}, covering every zoom level from 0 to ${budget.maxZoom}.`
	);
}

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
