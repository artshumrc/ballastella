export { BASE_MAP_CATALOG } from './catalog';
export type { BaseMapCatalog, BaseMapEmphasis, BaseMapEntry, BaseMapFlavorName } from './entry';
export { PROJECT_BASE_MAP_KEY, readBaseMapId, withBaseMapId } from './project';
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
