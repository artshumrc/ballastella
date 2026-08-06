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

// Annotations (CONTEXT.md, Annotation; ADR-0009). Note this is a **different thing** from the
// Georeference Annotation below: that is the IIIF document an Alignment serialises to, and these are
// the scholarly content a user places on the map. `geojson.js` is the only module here permitted
// GeoJSON's own vocabulary — `Feature`, `FeatureCollection` — for the same reason.
//
// Both apps: the editor draws and edits them, and the published viewer renders them and their
// popups through the very same `renderAnnotationPopup` (ADR-0019), which is what makes ticket 17's
// assertion that the same payload is inert in a Published Site mean anything at all.
export {
	DASHED_DASHARRAY,
	DOTTED_DASHARRAY,
	MARKER_SIZES,
	SIMPLESTYLE_DEFAULTS,
	SIMPLESTYLE_PROPERTIES,
	addAnnotation,
	dashArrayFor,
	emptyCollection,
	findAnnotation,
	lineStyleOf,
	newAnnotation,
	removeAnnotation,
	resolveStyle,
	setGeometry,
	setLineStyle,
	setStyle,
	setText,
	simpleStyleViolations,
	type Annotation,
	type AnnotationCollection,
	type AnnotationGeometry,
	type AnnotationProperties,
	type DrawnGeometryType,
	type ForeignGeometry,
	type LineStringGeometry,
	type LineStyle,
	type PointGeometry,
	type PolygonGeometry,
	type ResolvedStyle
} from './annotation/annotation.js';
export {
	AnnotationsUnreadableError,
	parseAnnotations,
	serialiseAnnotations
} from './annotation/geojson.js';
// The `description` pipeline: `marked` → DOMPurify → insert, in one function so the order cannot be
// reversed by a later edit (ADR-0009). **The one place in this epic where a bug is a security
// vulnerability rather than a defect.**
export {
	DescriptionRendererUnavailableError,
	isDescriptionRendererSupported,
	renderAnnotationPopup,
	renderDescription,
	type AnnotationText
} from './annotation/markdown.js';
export {
	ANNOTATION_ID_PROPERTY,
	LINE_STYLES,
	LINE_STYLE_PROPERTY,
	mapLibreDashArray,
	toRenderCollection
} from './annotation/render.js';

// The Alignment (CONTEXT.md, Align / Alignment). `georeference-annotation.js` is the only module
// in the codebase permitted the words "Georeference Annotation" and `GeoreferencedMap`; nothing
// above it needs them, so nothing above it names them.
export {
	ALIGNMENT_DIRECTORY,
	DEFAULT_TRANSFORMATION_TYPE,
	MINIMUM_CONTROL_POINTS,
	MINIMUM_MASK_VERTICES,
	NEVER_OFFERED_TRANSFORMATION_NAMES,
	TRANSFORMATION_CHOICES,
	alignmentPath,
	alignmentStorePath,
	canSolve,
	collectControlPoints,
	fullImageResourceMask,
	insertMaskVertexAfter,
	isFullImageResourceMask,
	isTransformationOffered,
	maskEdgeMidpoints,
	moveMaskVertex,
	newAlignment,
	removeMaskVertex,
	resetMaskToFullImage,
	toDraftControlPoints,
	transformationShortfall,
	withTransformationType,
	type Alignment,
	type ControlPoint,
	type DraftControlPoint,
	type GeoPoint,
	type TransformationChoice,
	type TransformationTier,
	type TransformationType
} from './alignment/alignment.js';
// Distortion (ADR-0013). The overlay is the renderer's; the fold check is ours, because it has to
// run whether or not anything is being colourised.
export {
	COMPUTED_DISTORTION_MEASURES,
	DEFAULT_DISTORTION_MEASURE,
	DEFAULT_DISTORTION_VIEW,
	DISTORTION_MEASURES,
	FOLD_DISTORTION_MEASURE,
	detectFold,
	type DistortionMeasure,
	type DistortionMeasureChoice,
	type DistortionRamp,
	type DistortionView,
	type FoldWarning
} from './alignment/distortion.js';
export {
	AlignmentUnreadableError,
	AlignmentUnwritableError,
	parseAlignment,
	serialiseAlignment,
	toRendererControlPoints,
	toRendererDocument,
	toRendererResourceMask,
	type RendererControlPoint
} from './alignment/georeference-annotation.js';

export { createImagePane } from './image-pane/iiif-image-pane';
export type {
	ImagePane,
	ImagePaneTile,
	ImagePaneTileBase,
	XyzTile
} from './image-pane/iiif-image-pane';
export { padTileToCell } from './image-pane/pad-tile-to-cell.js';

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
export {
	storedPyramidTileSource,
	type OpenSeadragonTileContext,
	type OpenSeadragonTileSource,
	type StoredPyramidTileSourceOptions
} from './injection/openseadragon-tile-source.js';

// Remote IIIF ingest (ticket 14; ADR-0007, ADR-0015, ADR-0018). Free of triiiceratops and of
// OpenSeadragon: the parser boundary is a string, and the OpenSeadragon tile source above is
// duck-typed, so `apps/viewer` gains neither by depending on this package (ADR-0019).
export {
	COMMUNITY_ALIGNMENT_DISCLOSURE,
	COMMUNITY_ALIGNMENT_HOST,
	MAX_COMMUNITY_ALIGNMENTS,
	findCommunityAlignments,
	type CommunityAlignment,
	type CommunityAlignmentOffer,
	type FetchCommunityAnnotations
} from './remote-iiif/community-alignments.js';
export {
	RemoteImageUnusableError,
	measureTileWithImageBitmap,
	probeRemoteImageService,
	type MeasureTile,
	type RemoteImageProbe,
	type RemoteProbeStage
} from './remote-iiif/cors-probe.js';
export {
	DESCRIPTION_LIMITS,
	describeRemoteResource,
	imageServiceOf,
	type DescribedCanvas,
	type DescribedField,
	type DescribedItem,
	type DescribedResource
} from './remote-iiif/describe-resource.js';
export {
	MAX_REMOTE_IMAGE_PIXELS,
	acceptRemoteImageService,
	readRemoteImageService,
	type RemoteImageService
} from './remote-iiif/image-service.js';
export {
	ParserBoundaryError,
	imageServiceUriCrossingBoundary
} from './remote-iiif/parser-boundary.js';
export {
	REFERENCED_IMAGE_FILE,
	ReferencedImageUnreadableError,
	imageModeOf,
	isReferenced,
	listReferencedImages,
	localCopySource,
	parseReferencedImage,
	referencedRendererDocument,
	referencedImage,
	referencedImagePath,
	referencedImageStorePath,
	serialiseReferencedAlignment,
	serialiseReferencedImage,
	sourceOf,
	tileBaseFor,
	type HistoricalMapSource,
	type ReferencedImage
} from './remote-iiif/referenced-image.js';
export {
	REMOTE_IIIF_LIMITS,
	RemoteIiifRejectedError,
	readRemoteIiifResource,
	remoteIiifUrl,
	type RemoteIiifKind,
	type RemoteIiifLimits,
	type RemoteIiifResource
} from './remote-iiif/remote-resource.js';

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
export {
	readImageHeader,
	readImageHeaderFromBlob,
	type ImageHeader
} from './tiler/image-header.js';
export { buildImageManifest, readImageLabel, type ImageManifest } from './tiler/image-manifest.js';
export {
	StreamingTilerUnavailableError,
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
