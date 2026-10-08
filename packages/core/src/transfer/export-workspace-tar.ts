import { assertNotReviewing, readReviewMark } from '../project/review-workspace.js';
import { toWorkspaceName } from '../store/opfs-workspaces.js';
import type { ProjectStore } from '../store/project-store.js';
import {
	archivePathFor,
	BACKUP_DISPLAY_NAME_RECORD,
	backupFileName,
	packTar,
	workspaceDirectoryEntry,
	type PackedArchive
} from './archive.js';
import type { TransferProgressListener } from './transfer.js';
import { isViewerFile } from './viewer-files.js';

export interface WorkspaceBackup extends PackedArchive {
	readonly fileName: string;
	readonly workspaceName: string;
	readonly displayName: string;
}

export async function exportWorkspaceTar(
	store: ProjectStore,
	displayName: string,
	options: { readonly onProgress?: TransferProgressListener } = {}
): Promise<WorkspaceBackup> {
	assertNotReviewing(displayName, await readReviewMark(store), 'backed up');
	const directoryName = toWorkspaceName(displayName);
	const files = (await store.list(''))
		.filter((path) => !isViewerFile(path))
		.map((path) => ({ name: archivePathFor(directoryName, path), path }));

	return {
		fileName: backupFileName(directoryName),
		workspaceName: directoryName,
		displayName,
		...(await packTar(store, files, options.onProgress, {
			name: workspaceDirectoryEntry(directoryName),
			...(displayName === directoryName
				? {}
				: { pax: { [BACKUP_DISPLAY_NAME_RECORD]: displayName } })
		}))
	};
}
