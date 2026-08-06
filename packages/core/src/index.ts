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

export { createImagePane } from './image-pane/iiif-image-pane';
export type { ImagePane, ImagePaneTile, XyzTile } from './image-pane/iiif-image-pane';

export * from './base-map';
export * from './theme';
