import { writeArrivedFile } from '../alignment/alignment-file.js';
import { PROJECT_FILE_NAME, isProjectManifest, parseProjectFile } from '../project/project-file.js';
import { describeBytes } from '../project/workspace-size.js';
import type { EstimateStorage } from '../store/persistent-storage.js';
import type { Bytes, ProjectStore } from '../store/project-store.js';
import {
	BackupRejectedError,
	backupDisplayName,
	backupWorkspaceName,
	decodeTar,
	unsafeArchivePathReason
} from './archive.js';
import { storageShortfall, type TransferProgressListener } from './transfer.js';

interface RestoreDestination {
	readonly name: string;
	readonly store: ProjectStore;
	discard(): Promise<void>;
}

export interface WorkspaceRestore {
	readonly workspaceName: string;
	readonly backupName: string;
	readonly backupDirectoryName: string;
	readonly totalFiles: number;
	readonly totalBytes: number;
	readonly projects: readonly string[];
	readonly declined: readonly string[];
	readonly notice: string;
}

const MAX_PROJECTS = 1000;
const MAX_PROJECT_FILE_BYTES = 4 * 1024 * 1024;

export async function restoreWorkspaceTar(
	archive: ReadableStream<Uint8Array>,
	open: (preferredName: string) => Promise<RestoreDestination>,
	options: {
		readonly onProgress?: TransferProgressListener;
		readonly archiveBytes?: number;
		readonly estimateStorage?: EstimateStorage;
	} = {}
): Promise<WorkspaceRestore> {
	if (options.archiveBytes !== undefined) {
		const short = await storageShortfall(options.archiveBytes, options.estimateStorage);
		if (short !== null) {
			throw new BackupRejectedError(
				'insufficient-quota',
				`This backup ${short} Delete a Workspace you no longer need, or free space on this ` +
					`device, and try again.`
			);
		}
	}

	const entries = decodeTar(
		archive,
		(detail) =>
			new BackupRejectedError(
				'not-a-tar',
				`This file could not be read as a Ballastella backup: ${detail}. A backup is the ` +
					`“.tar” file the Back up button produces; if this is one, it may not have ` +
					`downloaded completely, in which case ask for it again.`
			)
	);
	let destination: RestoreDestination | null = null;
	try {
		const first = await entries.next();
		if (first.done) {
			throw new BackupRejectedError(
				'no-workspace-directory',
				'This is a valid archive, but it holds nothing at all — not even the folder a ' +
					'Ballastella backup names its Workspace with.'
			);
		}
		const { header } = first.value;
		const backupName = backupWorkspaceName(header.name);
		await first.value.skip();
		if (backupName === null) {
			throw new BackupRejectedError(
				'no-workspace-directory',
				`A Ballastella backup begins with the folder it is a backup of, and this one begins with ` +
					`“${header.name}”. If it came from another program, or was repacked, ` +
					`restore cannot tell what Workspace it holds.`
			);
		}
		const displayName = backupDisplayName(header.pax) ?? backupName;
		destination = await open(displayName);
		const store = destination.store;
		const prefix = `${backupName}/`;
		const manifests: { path: string; bytes: Bytes }[] = [];
		const declined: string[] = [];
		let files = 0;
		let bytes = 0;
		const report = (path: string | null): void =>
			options.onProgress?.({ files, totalFiles: files, bytes, totalBytes: bytes, path });
		const restore = async (path: string, content: Bytes): Promise<boolean> => {
			if ((await writeArrivedFile(store, path, content)) === 'declined') {
				declined.push(path);
				return false;
			}
			files += 1;
			bytes += content.length;
			return true;
		};

		report(null);
		for await (const entry of entries) {
			const name = entry.header.name;
			if (entry.directory) {
				await entry.skip();
				continue;
			}
			if (!name.startsWith(prefix)) {
				throw new BackupRejectedError(
					'path-traversal',
					`This backup contains “${name}”, which is outside the “${backupName}” folder the ` +
						`archive says it is a backup of.`
				);
			}
			const path = name.slice(prefix.length);
			const unsafe = unsafeArchivePathReason(path, 'Workspace');
			if (unsafe !== null) {
				throw new BackupRejectedError(
					'path-traversal',
					`This backup contains an entry that would not stay inside the Workspace: “${path}” ${unsafe}.`
				);
			}

			const content = await entry.bytes();
			if (!isProjectManifest(path)) {
				await restore(path, content);
				report(path);
				continue;
			}
			if (manifests.length >= MAX_PROJECTS) {
				throw new BackupRejectedError(
					'too-large',
					`This backup holds more than ${MAX_PROJECTS} Projects, which is more than a Workspace ` +
						`is. It has not been read further.`
				);
			}
			if (content.length > MAX_PROJECT_FILE_BYTES) {
				throw new BackupRejectedError(
					'too-large',
					`“${path}” in this backup is ${describeBytes(content.length)}, and a ` +
						`${PROJECT_FILE_NAME} is a short manifest rather than a document of that size.`
				);
			}
			parseProjectFile(content, 'Nothing has been restored.');
			manifests.push({ path, bytes: content });
		}
		for (const manifest of manifests) {
			if (await restore(manifest.path, manifest.bytes)) report(manifest.path);
		}
		report(null);

		return {
			workspaceName: destination.name,
			backupName: displayName,
			backupDirectoryName: backupName,
			totalFiles: files,
			totalBytes: bytes,
			projects: manifests
				.map((manifest) => manifest.path)
				.filter((path) => !declined.includes(path))
				.map((path) => path.slice(0, -PROJECT_FILE_NAME.length - 1)),
			declined,
			notice:
				`Restored into a new Workspace called “${destination.name}”. Your other Workspaces have ` +
				`not been touched. A backup holds your work rather than a website, so turn Share Links on for this ` +
				`Workspace again to make it one — and if you had made a Project available ` +
				`offline, make its offline copy again.` +
				(declined.length === 0
					? ''
					: ` ${declined.length} ${declined.length === 1 ? 'Alignment' : 'Alignments'} in the ` +
						`backup ${declined.length === 1 ? 'was' : 'were'} not restored, because this ` +
						`Workspace already had one for the same Map Image: ${declined.join(', ')}.`)
		};
	} catch (cause) {
		if (destination) await destination.discard().catch(() => undefined);
		await entries.return();
		throw cause;
	}
}
