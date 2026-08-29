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
// The write-ahead journal that makes ADR-0017 rule 3 true for a real navigation.
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
// answers to one question.
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
// How a Project reached this Workspace (ADR-0037). Read-only transfer history, and never attribution:
// the editor renders it, and only an Import writes it.
export {
	IMPORT_PROVENANCE_KEY,
	inheritImportProvenance,
	parseImportProvenance,
	serialiseImportProvenance,
	type ForeignImportProvenance,
	type GitHubImportProvenance,
	type ImportProvenanceEntry,
	type ImportProvenanceEvidence,
	type ProjectBundleImportProvenance,
	type ReviewImportProvenance
} from './project/import-provenance.js';
export {
	// Exported because the editor has to recognise it: `createProject` throws it at the one moment a
	// user can be told, and a refusal the app cannot name is rendered as an unreachable Workspace.
	RESERVED_DIRECTORY_NAMES,
	ReservedDirectoryNameError,
	Workspace,
	hoistedImageId,
	isReservedDirectoryName,
	deletionsAreNoteworthy,
	takenDirectoryNames,
	toDirectoryName,
	unusedDirectoryName,
	type FinishedDeletions,
	type RefusedDeletion,
	type ProjectSummary,
	type WorkspaceIdentity,
	type WorkspaceOptions
} from './project/workspace.js';
// What makes a Workspace a throwaway Review Workspace (ADR-0024).
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
	type ReviewMark,
	type ReviewOrigin,
	type ReviewOriginBacking
} from './project/review-workspace.js';
// ADR-0008's ~1 GB cliff, and the byte total it is judged against. Both apps: a warning before a
// Workspace grows and again at publish, from the same two functions rather than two answers to one
// question.
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
// promise — see `ReadOnlyProjectStore` — because the published viewer must have no store `write` at
// all.
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
	releaseWorkspaceFolder,
	rememberedFolderName,
	reopenRetainedWorkspaceFolder,
	reopenWorkspaceFolder,
	retainWorkspaceFolder
} from './store/workspace-folder.js';
// A folder Workspace's own durable record, which is what makes there able to be more than one
// (ADR-0042). Keyed by a minted reference; the folder's name is shown, never asked.
export {
	listFolderWorkspaces,
	migratePreExistingFolderWorkspace,
	resolveFolderWorkspace,
	type FolderWorkspaceRecord
} from './store/folder-workspaces.js';
export {
	rekeyWorkspaceRecords,
	type WorkspaceRecordStores
} from './store/rekey-workspace-records.js';

// Handing one Project to somebody else, and reviewing one you were handed (ADR-0024).
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
	ReviewDestinationUnavailableError,
	refuseReviewDestination,
	reviewCopyStillHere,
	reviewImportOrigin,
	type ReviewDestinationRefusal
} from './transfer/project-import-review.js';
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
// Putting one Project into the Workspace the user already has (ADR-0037). The write half of the same
// boundary: one closure written once at fresh destination paths under one recoverable marker, and a
// Workspace that stays shut while that marker is unresolved rather than a filter at every reader.
export {
	IMPORT_TRANSACTION_FORMAT_VERSION,
	IMPORT_TRANSACTION_PATH,
	ImportRefusedError,
	clearImportTransaction,
	commitProjectImport,
	discardImportTransaction,
	parseImportTransaction,
	readImportTransaction,
	serialiseImportTransaction,
	type CommitProjectImportOptions,
	type ImportRefusal,
	type ImportTransaction,
	type ImportTransactionMark,
	type ImportTransactionState,
	type ImportedProject,
	type UnreadableImportTransaction
} from './transfer/project-import-transaction.js';
// The other half of that gate: what closes it. An outstanding marker is resolved — swept
// or finished — before the Workspace answers a single question about itself, and a Workspace whose
// marker cannot be resolved stays unavailable rather than opening over half a Project.
export {
	ImportRecoveryFailedError,
	recoverProjectImport,
	type ImportRecovery,
	type ImportRecoveryFailure
} from './transfer/project-import-recovery.js';
// Turning one validated closure into a detached one (ADR-0037): a fresh identity for every
// incoming Map Image, and every path, Layer, Alignment and pyramid stamp rewritten onto it, so nothing
// the Import writes can be something the user already has.
export {
	remapProjectImport,
	type MintImageId,
	type RemapProjectImportOptions,
	type RemappedProjectImport
} from './transfer/project-import-remapping.js';
// Where the detached closure lands (ADR-0037): a display name allocated against the names the
// Workspace shows, a directory allocated against the folded union of local, Remote and Baseline
// evidence, and one destination path per closure path — reserved before a transaction can write.
// The publication reset and the provenance entry that make an imported Project a detached local copy:
// applied to a source's manifest before the remapping plans the closure's bytes.
export {
	detachImportedProject,
	observedImportProvenance
} from './transfer/project-import-provenance.js';
export {
	allocateProjectImport,
	type ImportDestination,
	type ProjectImportAllocation
} from './transfer/project-import-allocation.js';
// What a bound Workspace's one Remote adds to an Import (ADR-0038): the current Remote
// inventory that allocation reserves directories from — refused rather than guessed at when GitHub
// will not answer — and the refusal of an Import of the Project this Workspace already synchronizes.
export {
	assertNotOwnRemote,
	readImportEvidence,
	type ImportEvidence,
	type ImportIntoWorkspace,
	type OwnRemoteCheck
} from './transfer/project-import-own-remote.js';
export {
	readProjectBundleSource,
	type ProjectBundleSourceOptions
} from './transfer/project-bundle-source.js';
export {
	readReviewWorkspaceSource,
	type ReviewWorkspaceSourceOptions
} from './transfer/review-workspace-source.js';
// Whole-Workspace backup and restore, as a tar (ADR-0024). Editor-only — a Published
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

// Publishing (ADR-0006, ADR-0008). Both apps, for different halves of it: the editor
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
	type PublishedRepository,
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
// The fake GitHub every Remote test drives: one fake shared by every suite cannot disagree with
// itself, and a private copy per suite can.
export {
	createFakeGitHub,
	type FakeGitHub,
	type FakeGitHubOptions,
	type FakeGrantedRepository,
	type FakeGrants,
	type FakeRateLimit,
	type FakeRepositoryPermissions,
	type FakeSignInOptions,
	type FakeTreeEntry
} from './remote/fake-github.js';
// The publish engine: the Workspace becomes one tree, one commit, and one ref move (ADR-0033).
// Editor-only — a Published Site publishes nothing — but here rather than in the app because the
// owned-namespace rules, the incremental upload, and the three budgets are where publishing's silent
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
export {
	publishWorkspaceToRemote,
	type PublishWorkspaceOptions,
	type SharedStateRecorder,
	type WorkspacePublished
} from './remote/synchronization-publish.js';
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
// The durable record of what Ballastella itself has written or deleted since the Baseline, and the
// Remote Status that can be read off it without touching a byte of a multi-gigabyte Workspace.
export {
	LOCALLY_CHANGED,
	LocalChangeIndex,
	checkSourceStatus,
	discardLocalChanges,
	localChangeKey,
	type AutomaticStatus,
	type AutomaticStatusInput,
	type LocalChangeIndexOptions,
	type LocalChangeKind,
	type LocalChangeSource,
	type LocalChanges
} from './remote/local-change-index.js';
// The Remote Status a scholar reads, and the bounded observational checking behind it (ADR-0038).
// Nothing here transfers a file, writes a Workspace path, or advances a Baseline.
export {
	AUTOMATIC_CHECK_INTERVAL_MS,
	REMOTE_STATUS_LABELS,
	REMOTE_STATUS_UNCHECKED,
	RemoteStatusChecker,
	RemoteStatusUnavailableError,
	UNCHECKED_REMOTE_STATUS,
	readRemoteInventory,
	type RemoteInventoryOptions,
	type RemoteStatusCheckerOptions,
	type RemoteStatusObservation,
	type RemoteStatusRefusal,
	type RemoteStatusState,
	type RemoteStatusTrigger
} from './remote/remote-status.js';
// Where those marks come from: composition over `ProjectStore`, so every writer that exists and every
// writer still to be written is tracked without knowing it.
export { ManagedProjectStore, manageProjectStore } from './store/managed-project-store.js';
// Comparing a Workspace, its Remote and their Baseline (ADR-0038). Pure: the callers do the I/O, so
// the six Remote Status values and every plan are decided by a table rather than by a transfer.
export {
	comparePath,
	compareWorkspace,
	planWorkspacePublish,
	planWorkspaceUpdate,
	type GraphFailure,
	type GraphVerdict,
	type GraphViolation,
	type InventoryEntry,
	type PathChoice,
	type PathComparison,
	type PlanRefusal,
	type PlanResult,
	type SourcePath,
	type SourceStatus,
	type SynchronizationInput,
	type WorkspaceComparison,
	type WorkspacePublishOptions,
	type WorkspacePublishPlan,
	type WorkspaceUpdatePlan
} from './remote/synchronization-planner.js';
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
// Downloading a published Workspace back out of a public repository (ADR-0031, ADR-0032). It needs
// no credential at all, which is what lets a student with no GitHub account seed a Workspace from
// their instructor's Remote.
export {
	CloneRefusedError,
	cloneFromRemote,
	type CloneFromRemoteOptions,
	type CloneReference,
	type CloneRefusal,
	type WorkspaceClone
} from './remote/clone-from-remote.js';
// Open a Workspace from GitHub: the transfer above, plus the one thing that makes it a relationship —
// this installation keeps at most one synchronized Workspace per repository, and reopening returns to
// it rather than making a second (ADR-0038).
export {
	findWorkspaceForRepository,
	openWorkspaceFromGitHub,
	type OpenWorkspaceFromGitHubOptions,
	type OpenedWorkspace
} from './remote/open-workspace-from-github.js';
// Update from GitHub: the explicit inbound transfer, which takes the Remote's own additions,
// replacements and confirmed deletions, keeps local-only work, and publishes nothing (ADR-0038).
// Anonymous, like the Open above — inbound synchronization is not publishing authority.
export {
	UPDATE_BEFORE_DIRECTORY,
	UPDATE_DOWNLOAD_CONCURRENCY,
	UPDATE_TRANSACTION_FORMAT_VERSION,
	UPDATE_TRANSACTION_PATH,
	UpdateRefusedError,
	clearUpdateTransaction,
	parseUpdateTransaction,
	readUpdateTransaction,
	recoverWorkspaceUpdate,
	serialiseUpdateTransaction,
	updateFromGitHub,
	type RemovedProject,
	type UnreadableUpdateTransaction,
	type UpdateBeforeImage,
	type UpdateDeletionPreview,
	type UpdateFromGitHubOptions,
	type UpdateRecovery,
	type UpdateReference,
	type UpdateRefusal,
	type UpdateTransaction,
	type UpdateTransactionMark,
	type UpdateTransactionState,
	type WorkspaceUpdate
} from './remote/update-from-github.js';
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
// Which repositories the signed-in author has granted this App access to.
// A read of GitHub's own installation endpoints and nothing else: nothing is remembered here, so
// there is no second answer to keep in step with GitHub's. A rejected sign-in is a refusal rather
// than an empty list, which is the whole point of the outcome being a discriminated union.
export {
	readGrantedRepositories,
	type GrantedRepositoriesOptions,
	type GrantedRepositoriesOutcome,
	type GrantedRepository,
	type GrantedInstallation
} from './remote/github-installations.js';
// Whatever address a student happens to have — a Published Site's, a GitHub one, or
// `owner/repository` — turned into the repository it means, by asking GitHub which of the
// candidates is real rather than asking the author a question only GitHub can answer.
export {
	resolveWorkspaceAddress,
	workspaceAddressCandidates,
	type AddressCandidate,
	type AddressResolution
} from './remote/workspace-address.js';
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
// The Front Page's two return links. Exported for **both** apps: the viewer
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
// not here — the app composes the sealed store and asks it three questions, and the
// broker-exchanged token has to be a swap underneath rather than a second surface above.
export {
	browserCredentialStore,
	closedWhileReviewing,
	describeTokenProblem,
	type CredentialStorage,
	type CredentialStore
} from './remote/credential-store.js';
// The durable implementation behind that same interface, and the installation-local preference that
// selects it (ADR-0041). Exported as a *storage* rather than a store because the sign-in's grant
// record shares it: one opening of the installation database holds both halves of what is kept.
export {
	REMEMBER_SIGN_IN_KEY,
	durableCredentialStorage,
	readRememberSignIn,
	writeRememberSignIn,
	type DurableCredentialStorage
} from './remote/durable-credential-store.js';
// The second acquisition path behind that same interface (ADR-0031): a GitHub App token
// obtained by redirect and exchanged through the broker. **The engine never learns which door a
// token came through** — what is exported here is used by the UI layer alone, and everything below
// it still receives an opaque bearer string.
export { GITHUB_APP, isGitHubAppConfigured, type GitHubApp } from './remote/github-app.js';
export {
	CREDENTIAL_FRESHNESS_MARGIN_MS,
	GITHUB_APPS_URL,
	GITHUB_APP_SESSION_KEY,
	GITHUB_AUTHORIZE_URL,
	GitHubCallbackRefusedError,
	GitHubSignInError,
	REMEMBERED_GRANT_KEY,
	SIGN_IN_STATE_KEY,
	authorizeUrl,
	clearGrantRecord,
	describeCallbackRefusal,
	exchangeAuthorizationCode,
	grantAccessUrl,
	installUrl,
	isGrantFresh,
	newSignInState,
	readGrantRecord,
	readSignInCallback,
	refreshGitHubToken,
	signInAgainMessage,
	clearRememberedGrant,
	readRememberedGrant,
	signInDepartureUrl,
	verifySignInState,
	writeGrantRecord,
	writeRememberedGrant,
	type GitHubTokenGrant,
	type RememberedGrant,
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
// reversed by a later edit (ADR-0009). **A bug in this pipeline is a security vulnerability rather
// than a defect.**
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
	alignmentImageId,
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
// The one writer of `alignments/<image-id>.json`. Nothing else in the codebase can turn
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
// by the published viewer and by the editor, so that one outage cannot be described two ways at the
// same scholar.
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

// Remote IIIF ingest (ADR-0007, ADR-0015, ADR-0018). Free of triiiceratops and of
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
// Making an offline copy (ADR-0007). Adds no dependency: it is a funnel into the tiler this barrel
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

// Which file a Layer draws, so a deletion and the Step that reverses it name the same one (ADR-0023).
export { layerFileRef } from './undo/undo.js';

// The Edit History of one screen (ADR-0039): the last few edits made on it, each one reversible and
// repeatable. Framework-free and here rather than in the app for the same reason `Autosave` is —
// linearity, the cursor, eviction and the flush ordering are all worth asserting without a browser.
export {
	EditHistory,
	type EditHistoryOptions,
	type HistoryFiles,
	type HistoryState,
	type Step,
	type StepFile
} from './undo/edit-history.js';
export { carryAcross, carryAnnotationText, carryProjectText } from './undo/carry-text.js';

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
