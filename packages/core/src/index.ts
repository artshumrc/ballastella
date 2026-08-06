// @ballastella/core — the domain model, ProjectStore and its adapters, IIIF glue,
// alignment serialisation, and annotation styling (ADR-0019).
//
// The Base Map catalog and its resolution live here rather than in an app because ADR-0020 has
// the published viewer carrying the whole catalog and the style-switching logic too, not merely
// "render the configured style".

export { Autosave, type AutosaveOptions, type SaveState } from './autosave/autosave.js';
export { installFlushOnHide, type HideEventTargets } from './autosave/flush-on-hide.js';
export {
	BALLASTELLA_CANONICAL_URL,
	CURRENT_FORMAT_VERSION,
	PROJECT_FILE_NAME,
	ProjectFileUnreadableError,
	ProjectFormatTooNewError,
	newProjectFile,
	parseProjectFile,
	projectFilePath,
	serialiseProjectFile,
	type ProjectFile
} from './project/project-file.js';
export {
	Workspace,
	toDirectoryName,
	type ProjectSummary,
	type WorkspaceOptions
} from './project/workspace.js';
export { MemoryProjectStore } from './store/memory-project-store.js';
export { OpfsProjectStore, type DirectoryResolver } from './store/opfs-project-store.js';
export {
	InvalidPathError,
	PathNotFoundError,
	TEMP_PATH_SUFFIX,
	isTempPath,
	type Bytes,
	type ProjectStore,
	type StorePath
} from './store/project-store.js';
export { TempFileWriteStore } from './store/temp-file-write-store.js';

export {
	ROUND_TRIP_TOLERANCE_PX,
	WINDOW_TILE_ZOOM,
	createSyntheticProjection
} from './image-pane/synthetic-projection';
export type {
	PyramidGeometry,
	ResourcePoint,
	SyntheticLngLat,
	SyntheticProjection
} from './image-pane/synthetic-projection';

export { createImagePane } from './image-pane/iiif-image-pane';
export type { ImagePane, ImagePaneTile, XyzTile } from './image-pane/iiif-image-pane';

export * from './base-map';
export * from './theme';

// The tiler (ADR-0003). `wasm-vips` is deliberately absent: `streamingTiler` takes the module
// through a loader the consumer supplies, so nothing here imports it and `apps/viewer` cannot
// acquire it by depending on this package (ADR-0019).
export {
	MEASURED_DECODE_CEILING_PIXELS,
	STREAMING_TILER_THRESHOLD_PIXELS
} from './tiler/decode-ceiling.js';
export { openDecodeAndCropSource } from './tiler/decode-and-crop-tiler.js';
export { readImageHeader, type ImageHeader } from './tiler/image-header.js';
export { buildImageManifest, type ImageManifest } from './tiler/image-manifest.js';
export {
	NoStreamingTilerError,
	UnreadableImageError,
	ingestImageFile,
	listIngestedImages,
	type IngestedImage,
	type IngestOptions,
	type IngestProgress,
	type IngestResult,
	type OpenTileSource,
	type TileSource,
	type TilerKind
} from './tiler/ingest.js';
export {
	IMAGE_SERVICE_PLACEHOLDER_ORIGIN,
	PYRAMID_TILE_SIZE,
	TILE_JPEG_QUALITY,
	TILE_MEDIA_TYPE,
	buildImageInfo,
	imageDirectory,
	imageInfoPath,
	imageManifestPath,
	imageServiceId,
	planPyramid,
	pyramidScaleFactors,
	serialiseJson,
	type Level0ImageInfo,
	type PlannedTile
} from './tiler/pyramid.js';
export {
	streamingTiler,
	type LoadVips,
	type VipsImage,
	type VipsModule
} from './tiler/streaming-tiler.js';
