// @ballastella/core — the domain model, ProjectStore and its adapters, IIIF glue,
// alignment serialisation, and annotation styling (ADR-0019).
//
// The Base Map catalog and its resolution live here rather than in an app because ADR-0020 has
// the published viewer carrying the whole catalog and the style-switching logic too, not merely
// "render the configured style".

export {
	Autosave,
	type AutosaveJournal,
	type AutosaveOptions,
	type SaveState
} from './autosave/autosave.js';
export { installFlushOnHide, type HideEventTargets } from './autosave/flush-on-hide.js';
// The write-ahead journal that makes ADR-0017 rule 3 true for a real navigation (ticket 20).
export {
	JOURNAL_FORMAT_VERSION,
	JournalFullError,
	JournalUnavailableError,
	WriteAheadJournal,
	browserJournalStorage,
	discardJournal,
	fingerprintOf,
	forgetHeldCopy,
	readHeldCopies,
	journalledWorkspaces,
	readJournal,
	type JournalContents,
	type HeldCopy,
	type JournalEntry,
	type StoreContentObserver,
	type JournalProblem,
	type JournalProblemReason,
	type JournalStorage
} from './autosave/journal.js';
// The plain `localStorage` stand-in the journal suites drive. Exported because the editor's own unit
// seam needs the identical one: a fourth hand-written copy in `apps/editor` is a fourth thing that can
// drift from the `JournalStorage` they all claim to satisfy, which is the drift
// `fake-journal-storage.ts` exists to prevent.
export { FakeJournalStorage } from './autosave/fake-journal-storage.js';
export {
	DeletedProjects,
	discardDeletions,
	workspacesWithDeletions,
	type DeletionRecord,
	type ProjectIdentity
} from './autosave/deleted-projects.js';
export {
	replayIsNoteworthy,
	replayJournal,
	type JournalReplayReport,
	type ReplayFailure,
	type ReplayOptions,
	type ReplaySkipReason,
	type ReplaySkipped
} from './autosave/replay.js';
// The Layer stack (CONTEXT.md, Layer; ADR-0002). Both apps: the editor edits it, and the published
// viewer reads it to know what draws over what (ADR-0019), so it lives here and is free of
// `terra-draw` and the tiler.
export {
	ANNOTATION_DIRECTORY,
	addLayer,
	annotationPath,
	annotationStorePath,
	drawingOrder,
	emptyAnnotationCollection,
	findLayer,
	insertLayerAt,
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
	type Layer,
	type MapLayer,
	type SimpleStyle
} from './project/layer.js';
export {
	IMAGE_DIRECTORY,
	imageDirectory,
	imageInfoPath,
	imageManifestPath
} from './project/image-files.js';
// ADR-0023's derived answer, in one place: which Map Images the Workspace holds, whether each
// one's tiles are here or on a Library's server, who draws it, and what deleting it takes. Both apps
// — the viewer reaches only for `tileLocation`, because a static file server cannot list a directory
// and its half of the observation is a 404 probe.
export {
	MapImageInUseError,
	MapImagePartlyDeletedError,
	deleteMapImage,
	mapImageUsage,
	listWorkspaceMapImages,
	partitionByOfflineCopy,
	referencedMapImages,
	tileLocation,
	unusedMapImageBytes,
	unusedMapImages,
	type MapImageFiles,
	type MapImageUsage,
	type MapImageUser,
	type TileLocation,
	type WorkspaceMapImage
} from './project/map-images.js';
// The opening view (ADR-0026). Both apps, and that is the whole point of it being here: a Published
// Site that opened on the deployment's default while the editor opened on the work would be two
// answers to one question, and ticket 17 is already merged and would not remind anyone.
export {
	OPENING_VIEW_MAX_ZOOM,
	OPENING_VIEW_PADDING,
	alignmentOpeningBounds,
	alignmentOpeningFit,
	applyOpeningFit,
	openingViewFit,
	openingViewSentence,
	projectOpeningBounds,
	projectOpeningFit,
	type ContentLayer,
	type FittableMap,
	type GeoBounds,
	type OpeningViewFit,
	type OpeningViewOutcome
} from './project/opening-view.js';
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
	// Exported because the editor has to recognise it: `createProject` throws it at the one moment a
	// user can be told, and a refusal the app cannot name is rendered as an unreachable Workspace.
	RESERVED_DIRECTORY_NAMES,
	ReservedDirectoryNameError,
	Workspace,
	hoistedImageId,
	isReservedDirectoryName,
	deletionsAreNoteworthy,
	toDirectoryName,
	type FinishedDeletions,
	type RefusedDeletion,
	type ProjectSummary,
	type WorkspaceIdentity,
	type WorkspaceOptions
} from './project/workspace.js';
// What makes a Workspace a throwaway Review Workspace (ticket 14, ADR-0024).
export {
	REVIEW_MARK_FORMAT_VERSION,
	REVIEW_MARK_PATH,
	ReviewWorkspaceError,
	assertNotReviewing,
	assertReviewing,
	describeReviewSubject,
	parseReviewMark,
	readReviewMark,
	serialiseReviewMark,
	type ReviewMark
} from './project/review-workspace.js';
// ADR-0008's ~1 GB cliff, and the byte total it is judged against. Both apps: ticket 15 warns before a
// Workspace grows and ticket 16 warns again at publish, from the same two functions rather than two
// answers to one question.
export {
	STATIC_HOSTING_LIMIT_BYTES,
	crossesHostingLimit,
	describeBytes,
	hostingLimitWarning,
	workspaceSize,
	type WorkspaceSize
} from './project/workspace-size.js';
export { DirectoryHandleStore, type DirectoryResolver } from './store/directory-handle-store.js';
export { FileSystemAccessProjectStore } from './store/file-system-access-project-store.js';
// ADR-0006's third backend: a Published Site read over HTTP. Read-only by *type* rather than by
// promise — see `ReadOnlyProjectStore` — because ticket 17 requires that the viewer have no store
// `write` at all.
export {
	SiteFileUnreachableError,
	createHttpProjectStore,
	type HttpFetch,
	type HttpProjectStoreOptions
} from './store/http-project-store.js';
export { MemoryProjectStore } from './store/memory-project-store.js';
export { OpfsProjectStore } from './store/opfs-project-store.js';
// The OPFS root as a place holding several named Workspaces (ADR-0024's amendment to ADR-0001).
export {
	DEFAULT_WORKSPACE_NAME,
	createOpfsWorkspace,
	deleteOpfsWorkspace,
	ensureOpfsWorkspace,
	listOpfsWorkspaces,
	openOpfsWorkspace,
	toWorkspaceName,
	MAX_WORKSPACE_NAME_LENGTH,
	WorkspaceNameExhaustedError
} from './store/opfs-workspaces.js';
// Whether this **origin's** storage is evictable — a question about the browser, not a Workspace.
export { requestPersistentStorage, type StoragePersistence } from './store/persistent-storage.js';
export {
	InvalidPathError,
	PathNotFoundError,
	TEMP_PATH_SUFFIX,
	isTempPath,
	type Bytes,
	type EnumerableReadOnlyProjectStore,
	type ProjectStore,
	type ReadOnlyProjectStore,
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

// Handing one Project to somebody else, and reviewing one you were handed (ticket 14, ADR-0024).
// Importing one into the Workspace already open is a different operation over the same file format —
// see `project-import-source.ts` below, and ADR-0037.
//
// The zip flavour of both is gone: it counted entries in sixteen bits and read a 70,000-entry
// archive back as 4,464 files with no error, and the refusal that kept that from shipping fired for
// an ordinary Project with two large scans.
export {
	exportProjectBundle,
	type ExportProjectBundleOptions,
	type ProjectBundle
} from './transfer/export-project-bundle.js';
export {
	BUNDLE_LIMITS,
	assertReferencesPresent,
	openProjectBundle,
	type BundleLimits,
	type OpenProjectBundleOptions,
	type OpenReviewDestination,
	type OpenedBundle,
	type ReviewDestination
} from './transfer/open-project-bundle.js';
export {
	BUNDLE_MEDIA_TYPE,
	BundleRejectedError,
	MAX_BUNDLE_PATH_BYTES,
	assertSafeBundlePath,
	bundleFileName,
	bundleWorkspaceName,
	type BundleRejection
} from './transfer/project-bundle.js';
// Reading one Project out of somewhere else, for Import (ADR-0037). The read-only half of the
// boundary that replaced ADR-0024's prohibition: a validated closure carries no destination store and
// no credential, so only the Import engine can combine one with a Workspace the user owns.
export {
	ImportSourceRefusedError,
	createProjectImportSource,
	gatherProjectClosure,
	isSharedClosurePath,
	parseImportedProjectFile,
	type ClosureFile,
	type ClosurePath,
	type ImportSourceRefusal,
	type OfferedFile,
	type ProjectClosure,
	type ProjectImportOrigin,
	type ProjectImportSource,
	type ProjectImportSourceInput,
	type UnmetClosureReference
} from './transfer/project-import-source.js';
export {
	readProjectBundleSource,
	type ProjectBundleSourceOptions
} from './transfer/project-bundle-source.js';
export {
	readReviewWorkspaceSource,
	type ReviewWorkspaceSourceOptions
} from './transfer/review-workspace-source.js';
// Whole-Workspace backup and restore, as a tar (ticket 13, ADR-0024). Editor-only — a Published
// Site never backs anything up — but exported from the barrel rather than a subpath, because the
// modules are plain Web Streams over `ProjectStore` and drag nothing browser-only in with them.
export {
	exportWorkspaceTar,
	type ExportWorkspaceTarOptions,
	type WorkspaceBackup
} from './transfer/export-workspace-tar.js';
export {
	restoreWorkspaceTar,
	type EstimateStorage,
	type OpenRestoreDestination,
	type RestoreDestination,
	type RestoreWorkspaceTarOptions,
	type WorkspaceRestore
} from './transfer/restore-workspace-tar.js';
export {
	BACKUP_MEDIA_TYPE,
	BackupRejectedError,
	MAX_BACKUP_PATH_BYTES,
	TAR_ENTRY_MTIME,
	backupFileName,
	type BackupRejection
} from './transfer/workspace-tar.js';
export type { TransferProgress, TransferProgressListener } from './transfer/transfer.js';
export {
	PUBLISHED_APP_DIRECTORY,
	PUBLISHED_SITE_RECORD_NAME,
	VIEWER_FILE_PATHS,
	claimedByPublishing,
	createViewerFileFilter,
	isViewerFile
} from './transfer/viewer-files.js';

// Publishing (ticket 16; ADR-0006, ADR-0008). Both apps, for different halves of it: the editor
// plans and writes a Published Site, and the viewer reads the site record to know which Projects
// exist and which Base Maps it may offer (ADR-0020) — a static host has no directory listing, so
// that record is the only way the hub page can list anything.
//
// It adds no dependency and reaches no heavy module: paths, byte counts, and JSON. The bundle's
// bytes arrive through the injected `readAsset`, for the same reason ADR-0011's shim exists — where
// the viewer's files are served from is the app's knowledge, not core's.
export {
	PUBLISHED_SITE_FORMAT_VERSION,
	PublishRefusedError,
	PublishedSiteUnreadableError,
	canonicalImageServiceId,
	normaliseCanonicalUrl,
	parsePublishedSite,
	planPublish,
	publishSite,
	publishedSiteStaleness,
	readPublishedSite,
	serialisePublishedSite,
	stampCanonicalUrl,
	type CanonicalStamp,
	type PlanPublishOptions,
	type PublishPlan,
	type PublishSiteOptions,
	type PublishWarning,
	type PublishedProject,
	type PublishedSite
} from './publish/publish.js';
export {
	ViewerBundleUnreadableError,
	bundleBytes,
	parseViewerBundle,
	type ViewerBundle,
	type ViewerBundleFile
} from './publish/viewer-bundle.js';

// Publishing to a Remote (ADR-0031, ADR-0032, ADR-0033). The name git gives a file's bytes, which
// is what makes an incremental publish, a conflict refusal, and a resumed Clone possible at all.
export { gitBlobSha } from './remote/blob-sha.js';
export { GITHUB_API_ORIGIN, GITHUB_RAW_ORIGIN } from './remote/github-api.js';
// The fake GitHub every test in that epic drives: one fake eleven tickets share cannot disagree
// with itself, and eleven private ones can.
export {
	createFakeGitHub,
	type FakeGitHub,
	type FakeGitHubOptions,
	type FakeRateLimit,
	type FakeRepositoryPermissions,
	type FakeSignInOptions,
	type FakeTreeEntry
} from './remote/fake-github.js';
// The publish engine: the Workspace becomes one tree, one commit, and one ref move (ADR-0033).
// Editor-only — a Published Site publishes nothing — but here rather than in the app because the
// owned-namespace rules, the incremental upload, and the three budgets are where this epic's silent
// failures live, and all of them are assertable with no browser.
export {
	MAX_PUBLISHED_FILES,
	RemotePublishCredentialError,
	RemotePublishFailedError,
	RemotePublishRateLimitedError,
	RemotePublishRefusedError,
	planRemotePublish,
	publishToRemote,
	type PendingLocalFile,
	type PlanRemotePublishOptions,
	type PlannedRemoteFile,
	type PublishToRemoteOptions,
	type RemotePublishConflict,
	type RemotePublishOptions,
	type RemotePublishPlan,
	type RemotePublishWarning,
	type RemoteRepository,
	type RemoteTreeEntry
} from './remote/publish-to-remote.js';
// What this machine last saw on the Remote. Local only and keyed per Workspace, because it is
// evidence about a Remote rather than a fact about a Workspace — see the module header.
export {
	PUBLISH_MANIFEST_FORMAT_VERSION,
	PUBLISH_MANIFEST_KEY_PREFIX,
	PublishManifests,
	discardPublishManifest,
	publishManifestKey,
	type PublishManifest
} from './remote/publish-manifest.js';
// Installation-local synchronization evidence, superseding the v1 `localStorage` manifest above
// (ADR-0038). The relationship and the Baseline are what *this machine* believes about a Remote, so
// neither travels in a Workspace, a Backup, a Project Bundle or a published tree.
export {
	SYNCHRONIZATION_FORMAT_VERSION,
	SYNCHRONIZATION_KEY_PREFIX,
	SynchronizationMetadata,
	baselineKey,
	discardSynchronizationMetadata,
	listRemoteRelationships,
	remoteRelationshipKey,
	type MetadataStorage,
	type RemoteRelationship,
	type SynchronizationBaseline
} from './remote/synchronization-metadata.js';
export { FakeMetadataStorage } from './remote/fake-metadata-storage.js';
export {
	IndexedDbMetadataStorage,
	browserMetadataStorage
} from './store/indexeddb-metadata-storage.js';
// Deciding, once per Workspace, what its v1 evidence means — before any synchronization action is
// offered for it.
export {
	confirmLegacyRemote,
	migrateSynchronizationMetadata,
	type SynchronizationMigration
} from './remote/migrate-synchronization.js';
// Cloning a published Workspace back out of a public repository (ADR-0031, ADR-0032). The one
// operation in this epic that needs no credential at all, which is what lets a student with no
// GitHub account seed a Workspace from their instructor's Remote.
export {
	CloneRefusedError,
	cloneFromRemote,
	type CloneFromRemoteOptions,
	type CloneReference,
	type CloneRefusal,
	type WorkspaceClone
} from './remote/clone-from-remote.js';
// Reviewing one Project out of a public repository (ADR-0024, ADR-0031). The Clone's sibling and
// the bundle's: it needs no credential either, and what it makes is a throwaway Workspace that is
// unbound and unpublishable.
export {
	ReviewRefusedError,
	reviewFromRemote,
	type ReviewFromRemoteOptions,
	type ReviewReference,
	type ReviewRefusal,
	type ReviewedProject,
	type UnmetReference
} from './remote/review-from-remote.js';
// Importing one published Project into the Workspace the user already has open (ADR-0037). The
// Review's transport with the Import's contract: anonymous, blob-SHA checked, and refused whole rather
// than reported incomplete.
export {
	readRemoteProjectSource,
	type RemoteProjectSourceOptions
} from './remote/remote-project-source.js';
// Which repository a Workspace publishes to, and the credential that may push there (ADR-0032,
// ADR-0033). The rights check and the Pages enablement happen the moment a scholar names one, so
// that "you cannot push here" is not discovered after four thousand tiles have gone.
export {
	RemoteBindRefusedError,
	bindWorkspaceToRemote,
	enableRemotePages,
	readRemoteRights,
	type BindRemoteOptions,
	type RemoteBindOutcome,
	type RemoteBindRefusal,
	type RemotePagesOutcome,
	type RemoteReference,
	type RemoteRights
} from './remote/bind-remote.js';
export {
	DEFAULT_REMOTE_BRANCH,
	REMOTE_BINDING_FORMAT_VERSION,
	REMOTE_BINDING_PATH,
	clearRemoteBinding,
	describeRemote,
	parseRemoteBinding,
	parseRemoteReference,
	readRemoteBinding,
	serialiseRemoteBinding,
	writeRemoteBinding,
	type RemoteBinding
} from './remote/remote-binding.js';
// The Front Page's two return links (SPEC stories 49–51). Exported for **both** apps: the viewer
// builds the address and the editor reads it back, and they share no code but this package.
export {
	readReturnLink,
	returnLinkUrl,
	withoutReturnLink,
	type ReturnLink
} from './remote/return-link.js';
// The credential lives behind this interface, outside `ProjectStore`, and is never reachable through
// it: a token in the Workspace would be backed up, journalled, and published (ADR-0033). The two
// implementations behind `browserCredentialStore` and the storage shape they take are deliberately
// not here — the app composes the sealed store and asks it three questions, and ticket 10's
// broker-exchanged token has to be a swap underneath rather than a second surface above.
export {
	browserCredentialStore,
	closedWhileReviewing,
	describeTokenProblem,
	type CredentialStorage,
	type CredentialStore
} from './remote/credential-store.js';
// The second acquisition path behind that same interface (ticket 10, ADR-0031): a GitHub App token
// obtained by redirect and exchanged through the broker. **The engine never learns which door a
// token came through** — what is exported here is used by the UI layer alone, and everything below
// it still receives an opaque bearer string.
export { GITHUB_APP, isGitHubAppConfigured, type GitHubApp } from './remote/github-app.js';
export {
	CREDENTIAL_FRESHNESS_MARGIN_MS,
	GITHUB_APP_SESSION_KEY,
	GITHUB_AUTHORIZE_URL,
	GitHubCallbackRefusedError,
	GitHubSignInError,
	SIGN_IN_STATE_KEY,
	authorizeUrl,
	clearGrantRecord,
	describeCallbackRefusal,
	exchangeAuthorizationCode,
	isGrantFresh,
	newSignInState,
	readGrantRecord,
	readSignInCallback,
	refreshGitHubToken,
	signInAgainMessage,
	verifySignInState,
	writeGrantRecord,
	type GitHubTokenGrant,
	type SignInCallback
} from './remote/github-sign-in.js';

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
// Both apps: the editor draws and edits them, and the published viewer renders them through the very
// same `renderDescription` (ADR-0019), which is what makes the assertion that the same payload is
// inert in a Published Site mean anything at all. `renderAnnotationPopup` is the same pipeline with a
// title assembled onto it; no screen calls it since the map popup retired, and it is kept because the
// sanitiser did not retire with the popup.
export {
	ANNOTATION_COLORS,
	DASHED_DASHARRAY,
	DEFAULT_ANNOTATION_COLOR,
	DOTTED_DASHARRAY,
	LABEL_MARKER_SYMBOL,
	MARKER_SIZES,
	SIMPLESTYLE_DEFAULTS,
	SIMPLESTYLE_PROPERTIES,
	addAnnotation,
	annotationAnchor,
	annotationColorName,
	dashArrayFor,
	emptyCollection,
	findAnnotation,
	insertAnnotationAt,
	isLabel,
	isLabelFeature,
	lineStyleOf,
	moveAnnotation,
	newAnnotation,
	removeAnnotation,
	resolveStyle,
	setGeometry,
	setLineStyle,
	setStyle,
	setText,
	simpleStyleViolations,
	styleForNewAnnotation,
	styleForNewLabel,
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
// The number an Annotation is known by. Display state, derived from the collection's order and
// written nowhere (ADR-0002) — read by the row in `packages/ui` and by the mark in `render/`, so
// that "look at 3" means one Annotation in both apps and on both surfaces.
export { annotationOrdinal } from './annotation/ordinal.js';
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
// The one writer of `alignments/<image-id>.json` (ticket 18). Nothing else in the codebase can turn
// an `AlignmentPath` into a path the store will write, so every Alignment write in the application
// arrives here and has to name which of create / update / replace it is.
export {
	writeAlignmentBytes,
	writeAlignmentFile,
	writeAlignmentFileReporting,
	type AlignmentFilePort,
	type AlignmentWrite,
	type AlignmentWriteOutcome,
	type AlignmentWriteReport
} from './alignment/alignment-file.js';
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
	AlignmentUnpreservableError,
	AlignmentUnreadableError,
	AlignmentUnwritableError,
	parseAlignment,
	serialiseAlignment,
	toRendererControlPoints,
	toRendererDocument,
	toRendererResourceMask,
	type AlignmentAddress,
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
// stored pyramid resolves through. Free of the tiler, because `apps/viewer`
// reads published pyramids through it too (ADR-0019).
export {
	MissingImageServiceOverrideError,
	createStoreImageFetch,
	isImageServicePlaceholderUrl,
	refuseUnroutedImageServiceRequests,
	type FetchFn,
	type StoreImageFetchOptions,
	type TileFetchOutcome
} from './injection/store-image-fetch.js';
// The sentence a person is shown when a Map Image's tiles stop arriving. One function, rendered
// by the published viewer (ticket 04) and by the editor (ticket 05), so that one outage cannot be
// described two ways at the same scholar.
// `keepAskingForMissingTiles` is what makes that sentence's self-healing clause true: MapLibre paints
// no frames when nothing changes, and the renderer only re-asks for a refused record while it is
// painting.
export {
	mapImageTilesUnavailableNotice,
	keepAskingForMissingTiles,
	type TileSourceFailure
} from './injection/tile-failure.js';
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
	PROBE_ATTEMPTS,
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
// Making an offline copy (ticket 15; ADR-0007). Adds no dependency: it is a funnel into the tiler this barrel
// already exports, with `assemble` and the tilers themselves injected, so `apps/viewer` gains nothing
// it did not already have by depending on this package (ADR-0019).
export {
	ESTIMATED_OFFLINE_COPY_BYTES_PER_PIXEL,
	OFFLINE_COPY_LIMITS,
	OfflineCopyRefusedError,
	assembleWithCanvas,
	estimateOfflineCopyBytes,
	makeOfflineCopy,
	planOfflineCopy,
	type AssembleImage,
	type OfflineCopyPath,
	type OfflineCopyPiece,
	type OfflineCopyPiecePayload,
	type OfflineCopyPlan,
	type OfflineCopyProgress,
	type OfflineCopyResult
} from './remote-iiif/offline-copy.js';
export {
	ParserBoundaryError,
	imageServiceUriCrossingBoundary
} from './remote-iiif/parser-boundary.js';
export {
	REFERENCED_IMAGE_FILE,
	ReferencedImageUnreadableError,
	imagePaneSourceFor,
	isReferenced,
	listReferencedImages,
	parseReferencedImage,
	referencedRendererDocument,
	referencedImage,
	referencedImagePath,
	referencedAlignmentAddress,
	serialiseReferencedImage,
	sourceOf,
	tileBaseFor,
	type MapImageSource,
	type ImagePaneSource,
	type ReferencedImage
} from './remote-iiif/referenced-image.js';
export {
	REMOTE_IIIF_LIMITS,
	RemoteIiifRejectedError,
	RemoteImageResponseError,
	readRemoteIiifResource,
	remoteIiifUrl,
	type RemoteIiifKind,
	type RemoteIiifLimits,
	type RemoteIiifResource
} from './remote-iiif/remote-resource.js';

// A plain image at a URL, downloaded into the bytes the tiler takes. Not IIIF and not a reference:
// a single image file has no request that returns part of it, so the only way to draw one is to copy
// it into the Workspace and cut its own tiles.
export { isImageContentType } from './remote-image/content-type.js';
export {
	REMOTE_IMAGE_LIMITS,
	RemoteImageRefusedError,
	fetchRemoteImageFile,
	type FetchRemoteImageOptions,
	type RemoteImageLimits
} from './remote-image/fetch-remote-image.js';

// Single-level undo (ADR-0014, ticket 11). Editor-only in practice — a Published Site has nothing to
// undo — but here rather than in the app because it is where the record shapes, the wording of the
// affordance, and the one-slot semantics can be asserted without a browser.
export {
	UndoSlot,
	describeUndo,
	isControlPointUndo,
	layerFileRef,
	restoreControlPoint,
	type AnnotationDeletedUndo,
	type ControlPointDeletedUndo,
	type ControlPointMovedUndo,
	type LayerDeletedUndo,
	type UndoRecord
} from './undo/undo.js';

export * from './base-map';
export * from './places';
export * from './theme';

// NOTE: `src/render/` is deliberately **not** re-exported here. It is reached as
// `@ballastella/core/render`, because everything in it is browser-only and this barrel is not.
//
// Not a style preference — measured. `render/pmtiles-protocol.ts` imports `addProtocol` from
// `maplibre-gl` as a *value*, and both apps' root layouts import this barrel, so re-exporting the
// directory made every prerendered page evaluate `maplibre-gl` in Node: `SyntaxError: The requested
// module 'maplibre-gl' does not provide an export named 'addProtocol'`, and `pnpm -r build` failed on
// the editor's first route with a 500. A subpath keeps the barrel Node-safe — which is what
// `publish.test.ts` and every other Seam 1 test depend on — and makes "this module needs a browser"
// legible at the import site.

// The tiler (ADR-0003, ADR-0027). One implementation, decode-and-crop, injected rather than
// imported so that everything above it is testable in Node; an image above the measured decode
// ceiling is refused rather than routed to a second tiler.
export { MAX_INGEST_PIXELS, MEASURED_DECODE_CEILING_PIXELS } from './tiler/decode-ceiling.js';
export { openDecodeAndCropSource } from './tiler/decode-and-crop-tiler.js';
export {
	readImageHeader,
	readImageHeaderFromBlob,
	type ImageHeader
} from './tiler/image-header.js';
export { buildImageManifest, readImageLabel, type ImageManifest } from './tiler/image-manifest.js';
export {
	ImageTooLargeError,
	UnreadableImageError,
	ingestImageFile,
	listIngestedImages,
	type IngestedImage,
	type IngestOptions,
	type IngestProgress,
	type IngestResult,
	type OpenTileSource,
	type TileSource
} from './tiler/ingest.js';
export {
	IMAGE_SERVICE_PLACEHOLDER_ORIGIN,
	PYRAMID_TILE_SIZE,
	TILE_JPEG_QUALITY,
	TILE_MEDIA_TYPE,
	buildImageInfo,
	imageServiceId,
	imageSizeFromInfo,
	planPyramid,
	pyramidScaleFactors,
	serialiseJson,
	type Level0ImageInfo,
	type PlannedTile
} from './tiler/pyramid.js';
