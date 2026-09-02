// How the Base Map is drawn — streets, relief, muted colours — as three switches over one archive.
// Project data beside the borders, and a Reader may override it for themselves without editing it.
export {
	DEFAULT_BASE_MAP_APPEARANCE,
	PROJECT_BASE_MAP_APPEARANCE_KEY,
	appearanceFrom,
	baseMapFlavorName,
	isDefaultAppearance,
	type BaseMapAppearance
} from './appearance';
// Which administrative boundaries a Project draws. A filter over layers the same archive already
// carries, so it costs no request — see the note at the top of `borders.ts`.
export {
	BASE_MAP_BORDERS,
	DEFAULT_BASE_MAP_BORDER_STYLE,
	DEFAULT_BASE_MAP_BORDERS,
	MAX_BORDER_WIDTH,
	MIN_BORDER_WIDTH,
	NATIONAL_BOUNDARY_LAYER,
	PROJECT_BORDER_STYLE_KEY,
	PROJECT_BORDERS_KEY,
	SUBNATIONAL_BOUNDARY_LAYER,
	borderColorIsLegible,
	bordersInclude,
	isBaseMapBorders,
	isDefaultBorderStyle,
	readBaseMapBorderStyle,
	readBaseMapBorders,
	strengthenedBorder,
	subnationalWidth,
	type BaseMapBorders,
	type BaseMapBorderStyle
} from './borders';
export { BASE_MAP_CATALOG } from './catalog';
export type { BaseMapCatalog, BaseMapEntry, BaseMapFlavorName, BaseMapTerrain } from './entry';
// Shaded relief and contour lines, the one appearance switch that reads a second dataset. The layers are
// here; the protocols that feed them are in `@ballastella/core/render`.
export {
	CONTOUR_LAYER,
	CONTOUR_THRESHOLDS,
	CONTOUR_TILE_OPTIONS,
	TERRAIN_CONTOUR_SOURCE_ID,
	TERRAIN_DEM_SOURCE_ID,
	contourLayers,
	hillshadeLayer,
	terrainSources,
	type TerrainTileTemplates
} from './terrain';
export {
	PROJECT_BASE_MAP_KEY,
	readBaseMapChoice,
	readBaseMapId,
	type BaseMapChoice
} from './project';
// A Reader's own choice on one Published Site, kept in `localStorage` and **never** in Project data
// (ADR-0020). Keyed per site, because several scholars' sites share an origin.
export {
	BASE_MAP_PREFERENCE_PREFIX,
	baseMapPreferenceKey,
	readBaseMapPreference,
	writeBaseMapPreference,
	type PreferenceStorage,
	type ReaderBaseMapPreference
} from './reader-preference';
export {
	baseMapArchiveHost,
	baseMapFallbackNotice,
	baseMapNotInSiteNotice,
	baseMapOptions,
	baseMapUnavailableNotice,
	defaultEntry,
	resolveBaseMap,
	type BaseMapOption,
	type BaseMapResolution
} from './resolve';
// The opt-in offline tile cache (ADR-0025). The enumeration is pure and asserted numerically; the
// store half answers "is this Project available offline?" by looking, never by reading a flag.
export {
	BASE_MAP_TILE_ROOT,
	ESTIMATED_BYTES_PER_TILE,
	MEASURED_CANAL_BELT,
	OFFLINE_TILE_LIMIT,
	baseMapArchiveKey,
	baseMapTileDirectory,
	cachedTilePath,
	countTilesForBounds,
	legacyCachedTilePath,
	parseAnyCachedTilePath,
	parseCachedTilePath,
	tileBudget,
	tilesForBounds,
	type TileBudget,
	type TileCoordinate
} from './tile-cache';
export {
	baseMapCacheSize,
	baseMapCacheSizeFor,
	baseMapCaches,
	totalBaseMapCacheSize,
	baseMapTileSourcePath,
	clearBaseMapCache,
	describeTileBudget,
	fetchTilesIntoCache,
	offlineCoverage,
	readCachedTileSource,
	tileBudgetRefusal,
	writeCachedTileSource,
	type BaseMapCache,
	type BaseMapCacheSize,
	type CachedTileSource,
	type FetchTilesOptions,
	type OfflineCoverage,
	type ReadSourceTile,
	type TileFetchResult
} from './offline-cache';
export {
	archiveUrl,
	automaticBorderStyle,
	bordersIllegibleThemes,
	baseMapStyle,
	isAbsoluteUrl,
	BASE_MAP_SOURCE_ID,
	type BaseMapStyleOptions
} from './style';
