// @ballastella/core — the domain model, ProjectStore and its adapters, IIIF glue,
// alignment serialisation, and annotation styling (ADR-0019).
//
// The Base Map catalog and its resolution live here rather than in an app because ADR-0020 has
// the published viewer carrying the whole catalog and the style-switching logic too, not merely
// "render the configured style".

export { Autosave, type AutosaveOptions, type SaveState } from './autosave/autosave.js';
export { installFlushOnHide, type HideEventTargets } from './autosave/flush-on-hide.js';
// The Layer stack (CONTEXT.md, Layer; ADR-0002). Both apps: the editor edits it, and the published
// viewer reads it to know what draws over what (ADR-0019), so it lives here and is free of
// `terra-draw`, the tiler, and `wasm-vips`.
export {
	ANNOTATION_DIRECTORY,
	LOCAL_COPY,
	addLayer,
	annotationPath,
	annotationStorePath,
	drawingOrder,
	emptyAnnotationCollection,
	findLayer,
	imageIdFromAlignmentRef,
	mapLayerImageInfoPath,
	moveLayer,
	moveLayerDown,
	moveLayerUp,
	newAnnotationLayer,
	newMapLayer,
	parseLayers,
	removeLayer,
	renameLayer,
	serialiseLayers,
	setLayerVisible,
	setMapLayerOpacity,
	type AnnotationLayer,
	type ForeignLayer,
	type ImageMode,
	type Layer,
	type MapLayer,
	type SimpleStyle
} from './project/layer.js';
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
	ProjectDirectoryCollisionError,
	Workspace,
	toDirectoryName,
	type ProjectSummary,
	type WorkspaceOptions
} from './project/workspace.js';
export { DirectoryHandleStore, type DirectoryResolver } from './store/directory-handle-store.js';
export { FileSystemAccessProjectStore } from './store/file-system-access-project-store.js';
export { MemoryProjectStore } from './store/memory-project-store.js';
export { OpfsProjectStore } from './store/opfs-project-store.js';
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
	FolderPermissionDeniedError,
	chooseWorkspaceFolder,
	forgetWorkspaceFolder,
	grantWorkspaceFolder,
	isFolderWorkspaceSupported,
	rememberedFolderName,
	reopenWorkspaceFolder
} from './store/workspace-folder.js';

export {
	MAX_ZIP_ENTRIES,
	ProjectTooLargeToZipError,
	exportProjectZip,
	type ExportProjectZipOptions,
	type ProjectExport
} from './transfer/export-project-zip.js';
export {
	PROJECT_ZIP_LIMITS,
	ProjectZipRejectedError,
	readProjectZip,
	type ProjectZip,
	type ProjectZipLimits,
	type ProjectZipRejection,
	type ReadProjectZipOptions
} from './transfer/import-project-zip.js';
export type {
	ProjectFileSource,
	TransferFile,
	TransferProgress,
	TransferProgressListener
} from './transfer/transfer.js';
export {
	VIEWER_FILE_PATHS,
	createViewerFileFilter,
	isViewerFile
} from './transfer/viewer-files.js';

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

// The Alignment (CONTEXT.md, Align / Alignment). `georeference-annotation.js` is the only module
// in the codebase permitted the words "Georeference Annotation" and `GeoreferencedMap`; nothing
// above it needs them, so nothing above it names them.
export {
	ALIGNMENT_DIRECTORY,
	DEFAULT_TRANSFORMATION_TYPE,
	MINIMUM_CONTROL_POINTS,
	alignmentPath,
	alignmentStorePath,
	canSolve,
	collectControlPoints,
	fullImageResourceMask,
	newAlignment,
	toDraftControlPoints,
	type Alignment,
	type ControlPoint,
	type DraftControlPoint,
	type GeoPoint,
	type TransformationType
} from './alignment/alignment.js';
export {
	AlignmentUnreadableError,
	parseAlignment,
	serialiseAlignment,
	toGeoreferencedMap
} from './alignment/georeference-annotation.js';

export { createImagePane } from './image-pane/iiif-image-pane';
export type {
	ImagePane,
	ImagePaneTile,
	ImagePaneTileBase,
	XyzTile
} from './image-pane/iiif-image-pane';

// The injection layer (ADR-0011): the one `ProjectStore` → `Response` shim every consumer of a
// stored pyramid resolves through. Free of the tiler and of `wasm-vips`, because `apps/viewer`
// reads published pyramids through it too (ADR-0019).
export {
	MissingImageServiceOverrideError,
	createStoreImageFetch,
	isImageServicePlaceholderUrl,
	refuseUnroutedImageServiceRequests,
	type FetchFn,
	type StoreImageFetchOptions
} from './injection/store-image-fetch.js';

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
