import { expect, it } from 'vitest';

import { describeProjectStore, type WriteStep } from './project-store-suite.js';
import {
	pathSegments,
	TEMP_PATH_SUFFIX,
	type ProjectStore,
	type StorePath
} from './project-store.js';
import { decode, encode } from '../test-support.js';

export const scratchDirectory = async (label: string): Promise<FileSystemDirectoryHandle> => {
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle(`${label}-${crypto.randomUUID()}`, { create: true });
};

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

async function plantAbandonedWriteIn(
	directory: FileSystemDirectoryHandle,
	path: StorePath
): Promise<void> {
	const { directory: parent, name } = await directoryOf(directory, path);
	const handle = await parent.getFileHandle(name, { create: true });
	const writable = await handle.createWritable();
	await writable.write('half a document');
	await writable.close();
}

function failNextDirectoryHandleWrite(step: WriteStep): void {
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
		if (name.endsWith(TEMP_PATH_SUFFIX) && options?.create !== true) {
			FileSystemDirectoryHandle.prototype.getFileHandle = getFileHandle;
			return Promise.reject(new DOMException('storage went away', 'InvalidStateError'));
		}
		return getFileHandle.call(this, name, options);
	};
}

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

export function describeDirectoryHandleStore(
	name: string,
	open: (directory: FileSystemDirectoryHandle) => ProjectStore
): void {
	describeProjectStore(name, async () => {
		const directory = await scratchDirectory('suite');
		return {
			store: open(directory),
			everyStoredPath: () => everyPathIn(directory, ''),
			failNextWrite: failNextDirectoryHandleWrite,
			plantAbandonedWrite: (path) => plantAbandonedWriteIn(directory, path)
		};
	});

	it(`${name} writes atomically in a browser with no FileSystemFileHandle.move`, async () => {
		const prototype = FileSystemFileHandle.prototype as { move?: unknown };
		const move = prototype.move;
		delete prototype.move;
		try {
			const directory = await scratchDirectory('no-move');
			const store = open(directory);
			await store.write('p/project.json', encode('the first version'));

			await store.write('p/project.json', encode('second'));

			expect(decode(await store.read('p/project.json'))).toBe('second');
			expect(await everyPathIn(directory, '')).toEqual(['p/project.json']);
		} finally {
			if (move !== undefined) prototype.move = move;
		}
	});
}
