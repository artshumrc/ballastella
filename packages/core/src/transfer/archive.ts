import { createTarDecoder, createTarPacker, type TarHeader } from 'modern-tar';

import { MAX_WORKSPACE_NAME_LENGTH, toWorkspaceName } from '../store/opfs-workspaces.js';
import { isTempPath, messageOf, type Bytes, type ProjectStore } from '../store/project-store.js';
import type { TransferProgressListener } from './transfer.js';

export const TAR_ENTRY_MTIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0, 0));
export const bundleFileName = (directory: string): string => `${directory}.project.tar`;
export const backupFileName = (workspaceName: string): string => `${workspaceName}.tar`;

export const archivePathFor = (workspaceName: string, storePath: string): string =>
	`${workspaceName}/${storePath}`;

export const workspaceDirectoryEntry = (workspaceName: string): string => `${workspaceName}/`;
export const BACKUP_DISPLAY_NAME_RECORD = 'BALLASTELLA.workspace';

export function backupDisplayName(pax: Record<string, string> | undefined): string | null {
	const value = pax?.[BACKUP_DISPLAY_NAME_RECORD];
	if (typeof value !== 'string' || value === '') return null;
	if (value.includes('/') || value.includes('\\')) return null;
	// eslint-disable-next-line no-control-regex -- a control character in a name is not a name
	if (/[\u0000-\u001f\u007f]/.test(value)) return null;
	if ([...value].length > MAX_WORKSPACE_NAME_LENGTH * 4) return null;
	return value;
}

export function backupWorkspaceName(entryName: string): string | null {
	if (!entryName.endsWith('/')) return null;
	const name = entryName.slice(0, -1);
	if (name === '' || name.includes('/')) return null;
	if ([...name].length > MAX_WORKSPACE_NAME_LENGTH) return null;
	return toWorkspaceName(name) === name ? name : null;
}

const MAX_ARCHIVE_PATH_BYTES = 1024;

type BackupRejection =
	'not-a-tar' | 'no-workspace-directory' | 'path-traversal' | 'too-large' | 'insufficient-quota';

export class BackupRejectedError extends Error {
	override readonly name = 'BackupRejectedError';
	constructor(
		readonly reason: BackupRejection,
		message: string
	) {
		super(`${message} Nothing has been restored.`);
	}
}

export function unsafeArchivePathReason(
	name: string,
	root: 'Project' | 'Workspace'
): string | null {
	if (name === '') return 'has no name';
	if (name.startsWith('/')) return 'is an absolute path';
	if (/^[A-Za-z]:/.test(name)) return 'is an absolute path with a drive letter';
	if (name.includes('\\')) return 'uses a backslash as a separator';
	// eslint-disable-next-line no-control-regex -- a control character in a filename is not a filename
	if (/[\u0000-\u001f\u007f]/.test(name)) return 'contains a control character';
	if (new TextEncoder().encode(name).length > MAX_ARCHIVE_PATH_BYTES) {
		return `is longer than the ${MAX_ARCHIVE_PATH_BYTES} bytes any path in a ${root} needs`;
	}

	const segments = name.split('/');
	for (const segment of segments.at(-1) === '' ? segments.slice(0, -1) : segments) {
		if (segment === '..') return `climbs out of the ${root}`;
		if (segment === '.') return 'contains a “.” segment';
		if (segment === '') return 'contains an empty path segment';
	}
	if (isTempPath(name)) return 'uses the name Ballastella reserves for its own unfinished writes';
	return null;
}

interface ArchiveEntry {
	readonly header: TarHeader;
	readonly directory: boolean;
	bytes(): Promise<Bytes>;
	skip(): Promise<void>;
}

export async function* decodeTar(
	archive: ReadableStream<Uint8Array>,
	refuse: (detail: string) => Error
): AsyncGenerator<ArchiveEntry, void, undefined> {
	const fail = (cause: unknown): never => {
		throw refuse(messageOf(cause).replace(/\.$/, ''));
	};
	const reader = archive.pipeThrough(createTarDecoder({ strict: true })).getReader();
	try {
		for (;;) {
			const next = await reader.read().catch(fail);
			if (next.done) return;
			const { header, body } = next.value;
			yield {
				header,
				directory: header.type === 'directory' || header.name.endsWith('/'),
				bytes: () => collect(body).catch(fail),
				skip: () => body.cancel()
			};
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Bytes> {
	const chunks: Uint8Array[] = [];
	const reader = body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const out = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

export interface PackedArchive {
	readonly totalFiles: number;
	readonly totalBytes: number;
	readonly body: ReadableStream<Uint8Array>;
}

/** Progress names each file as it sits under `root`, so a backup reports store paths. */
export async function packTar(
	store: Pick<ProjectStore, 'read' | 'size'>,
	files: readonly { readonly name: string; readonly path: string }[],
	onProgress?: TransferProgressListener,
	root?: { readonly name: string; readonly pax?: Record<string, string> }
): Promise<PackedArchive> {
	const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const sizes = await Promise.all(sorted.map((file) => store.size(file.path)));
	const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
	const totalFiles = sorted.length;

	const { readable, controller } = createTarPacker();
	let done = 0;
	let bytes = 0;
	const report = (path: string | null): void =>
		onProgress?.({ files: done, totalFiles, bytes, totalBytes, path });

	const produce = async (): Promise<void> => {
		report(null);
		if (root) {
			await controller.add({ ...root, size: 0, type: 'directory', mtime: TAR_ENTRY_MTIME }).close();
		}
		for (const file of sorted) {
			const content = await store.read(file.path);
			const writer = controller
				.add({ name: file.name, size: content.length, type: 'file', mtime: TAR_ENTRY_MTIME })
				.getWriter();
			await writer.write(content);
			await writer.close();
			done += 1;
			bytes += content.length;
			report(root ? file.name.slice(root.name.length) : file.name);
		}
		controller.finalize();
		report(null);
	};
	produce().catch((cause: unknown) => controller.error(cause));

	return { totalFiles, totalBytes, body: readable };
}
