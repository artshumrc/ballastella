// The three things the shared adapter suite needs that no public API can give it, for a backend
// built on a `FileSystemDirectoryHandle` — which is both real ones (see DirectoryHandleStore).
//
// Shared between the OPFS and File System Access browser tests rather than written twice. Each is
// injected at the *browser API* the store calls, never at anything either adapter declares: the
// suite has to stay ignorant of how any backend is built, and a fixture that spied on a member of
// one of them would be the coupling ADR-0001 exists to prevent.
//
// Not a `*.test.ts` file, so Vitest does not collect it. It is browser-only all the same: there is
// no OPFS and no `FileSystemWritableFileStream` in Node.

import type { WriteStep } from './project-store-suite.js';
import { pathSegments, TEMP_PATH_SUFFIX, type StorePath } from './project-store.js';

/**
 * A fresh directory to root a store at, so no two tests see each other's files.
 *
 * From OPFS, because a real `FileSystemDirectoryHandle` is the point and OPFS is the only source
 * of one an automated browser can reach: `showDirectoryPicker()` needs a human. It is the same
 * interface either way — that is exactly what {@link DirectoryHandleStore} is built on — so what
 * this cannot assert is the picker and the permission grant, not the file operations.
 */
export const scratchDirectory = async (label: string): Promise<FileSystemDirectoryHandle> => {
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle(`${label}-${crypto.randomUUID()}`, { create: true });
};

/** Every file under `directory`, recursively, sorted. Temporary files included. */
export async function everyPathIn(
	directory: FileSystemDirectoryHandle,
	prefix: string
): Promise<StorePath[]> {
	const found: StorePath[] = [];
	for await (const [name, handle] of directory.entries()) {
		if (handle.kind === 'file') found.push(`${prefix}${name}`);
		else
			found.push(...(await everyPathIn(handle as FileSystemDirectoryHandle, `${prefix}${name}/`)));
	}
	return found.sort();
}

/**
 * Put a half-finished atomic write at `path` — what a tab that died between the two steps of a
 * write leaves behind. Impossible through the interface, which is why
 * `reclaimAbandonedWrites` exists.
 */
export async function plantAbandonedWriteIn(
	directory: FileSystemDirectoryHandle,
	path: StorePath
): Promise<void> {
	const { directory: parent, name } = await directoryOf(directory, path);
	const handle = await parent.getFileHandle(name, { create: true });
	const writable = await handle.createWritable();
	await writable.write('half a document');
	await writable.close();
}

/**
 * Fail the next write at `step`, by patching the browser API the adapter calls.
 *
 * No spy on anything the adapter declares, and nothing about how it is built: `close()` is where a
 * full disk is reported, and looking a temporary file up again is the first thing the move into
 * place does. Each patch restores itself the moment it fires, so exactly one write fails.
 */
export function failNextDirectoryHandleWrite(step: WriteStep): void {
	if (step === 'bytes') {
		const close = FileSystemWritableFileStream.prototype.close;
		FileSystemWritableFileStream.prototype.close = function () {
			FileSystemWritableFileStream.prototype.close = close;
			return Promise.reject(new DOMException('Quota exceeded', 'QuotaExceededError'));
		};
		return;
	}
	const getFileHandle = FileSystemDirectoryHandle.prototype.getFileHandle;
	FileSystemDirectoryHandle.prototype.getFileHandle = function (
		name: string,
		options?: FileSystemGetFileOptions
	) {
		// A lookup, not a creation: the creation is the temporary file landing, which has to succeed
		// for this to be the *second* step failing.
		if (name.endsWith(TEMP_PATH_SUFFIX) && options?.create !== true) {
			FileSystemDirectoryHandle.prototype.getFileHandle = getFileHandle;
			return Promise.reject(new DOMException('storage went away', 'InvalidStateError'));
		}
		return getFileHandle.call(this, name, options);
	};
}

/** Descend to (and create) the directory `path`'s file lives in. */
async function directoryOf(
	root: FileSystemDirectoryHandle,
	path: StorePath
): Promise<{ directory: FileSystemDirectoryHandle; name: string }> {
	const segments = pathSegments(path);
	const name = segments.pop() as string;
	let directory = root;
	for (const segment of segments) {
		directory = await directory.getDirectoryHandle(segment, { create: true });
	}
	return { directory, name };
}
