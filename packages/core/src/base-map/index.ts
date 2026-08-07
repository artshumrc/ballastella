export { BASE_MAP_CATALOG } from './catalog';
export type { BaseMapCatalog, BaseMapEmphasis, BaseMapEntry, BaseMapFlavorName } from './entry';
export { PROJECT_BASE_MAP_KEY, readBaseMapId } from './project';
// A Reader's own choice on one Published Site, kept in `localStorage` and **never** in Project data
// (ADR-0020, ticket 17). Keyed per site, because several scholars' sites share an origin.
export {
	BASE_MAP_PREFERENCE_PREFIX,
	baseMapPreferenceKey,
	readBaseMapPreference,
	writeBaseMapPreference,
	type PreferenceStorage
} from './reader-preference';
export {
	baseMapFallbackNotice,
	baseMapOptions,
	defaultEntry,
	resolveBaseMap,
	type BaseMapOption,
	type BaseMapResolution
} from './resolve';
// The opt-in offline tile cache (ADR-0025). The enumeration is pure and asserted numerically; the
// store half answers "is this Project available offline?" by looking, never by reading a flag.
export {
	BASE_MAP_TILE_DIRECTORY,
	ESTIMATED_BYTES_PER_TILE,
	MEASURED_CANAL_BELT,
	OFFLINE_TILE_LIMIT,
	cachedTilePath,
	countTilesForBounds,
	parseCachedTilePath,
	tileBudget,
	tilesForBounds,
	type TileBudget,
	type TileCoordinate
} from './tile-cache';
export {
	BASE_MAP_TILE_SOURCE_PATH,
	baseMapCacheSize,
	cachedTilesMatchArchive,
	clearBaseMapCache,
	describeTileBudget,
	fetchTilesIntoCache,
	offlineCoverage,
	readCachedTileSource,
	tileBudgetRefusal,
	writeCachedTileSource,
	type BaseMapCacheSize,
	type CachedTileSource,
	type FetchTilesOptions,
	type OfflineCoverage,
	type ReadSourceTile,
	type TileFetchResult
} from './offline-cache';
export {
	archiveUrl,
	baseMapStyle,
	isAbsoluteUrl,
	BASE_MAP_SOURCE_ID,
	type BaseMapStyleOptions
} from './style';
