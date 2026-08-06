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
export {
	archiveUrl,
	baseMapStyle,
	isAbsoluteUrl,
	BASE_MAP_SOURCE_ID,
	type BaseMapStyleOptions
} from './style';
