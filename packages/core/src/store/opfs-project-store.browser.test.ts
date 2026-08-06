import { expect, it } from 'vitest';

import { OpfsProjectStore } from './opfs-project-store.js';
import { describeProjectStore, type WriteStep } from './project-store-suite.js';
import { pathSegments, TEMP_PATH_SUFFIX, type StorePath } from './project-store.js';

/**
 * Real OPFS in a real browser. `*.browser.test.ts` files run in the browser project of
 * `vitest.config.ts`; there is no OPFS in Node and a stub of one would only prove the stub
 * matches the memory adapter, which is the thing this file exists to check.
 *
 * Each store gets its own directory rather than the OPFS root, so tests do not see each
 * other's files. The app uses `OpfsProjectStore.open()`, whose root *is* the OPFS root —
 * asserted below, because that is the layout ADR-0008 specifies.
 */
const scratchDirectory = async (label: string): Promise<FileSystemDirectoryHandle> => {
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle(`${label}-${crypto.randomUUID()}`, { create: true });
};

/** Every file under `directory`, recursively, sorted. Temporary files included. */
async function everyPathIn(
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

/**
 * Fail the next write at `step`, by patching the browser API the adapter calls.
 *
 * No spy on anything the adapter declares, and nothing about how it is built: `close()` is where
 * OPFS reports a full disk, and looking a temporary file up again is the first thing the move into
 * place does. Each patch restores itself the moment it fires, so exactly one write fails.
 */
function failNextWrite(step: WriteStep): void {
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

describeProjectStore('OpfsProjectStore', async () => {
	const directory = await scratchDirectory('suite');
	return {
		store: new OpfsProjectStore(() => Promise.resolve(directory)),
		everyStoredPath: () => everyPathIn(directory, ''),
		failNextWrite,
		plantAbandonedWrite: async (path) => {
			const { directory: parent, name } = await directoryOf(directory, path);
			const handle = await parent.getFileHandle(name, { create: true });
			const writable = await handle.createWritable();
			await writable.write('half a document');
			await writable.close();
		}
	};
});

it('puts a Project directly in the OPFS root, so the workspace is the root (ADR-0008)', async () => {
	const store = OpfsProjectStore.open();
	const directory = `root-check-${crypto.randomUUID()}`;
	await store.write(`${directory}/project.json`, new TextEncoder().encode('{}'));

	const root = await navigator.storage.getDirectory();
	const project = await root.getDirectoryHandle(directory);
	const file = await project.getFileHandle('project.json');
	expect(new TextDecoder().decode(await (await file.getFile()).arrayBuffer())).toBe('{}');

	await store.delete(`${directory}/project.json`);
});

it('reports OPFS as supported in a browser', () => {
	expect(OpfsProjectStore.isSupported()).toBe(true);
});

it('writes atomically in a browser with no FileSystemFileHandle.move (SPEC story 4)', async () => {
	// The adapter prefers `move` and copies when a browser has none. That fallback was dead code
	// that no test executed — and story 4's promise is a *fully* functional tool wherever folder
	// access is impossible, which is precisely the browsers that lack `move`.
	//
	// Running the suite in a second engine does not reach it: Firefox 153 has `move` too, so the
	// branch has to be entered deliberately, by hiding `move` the way Safari does.
	const prototype = FileSystemFileHandle.prototype as { move?: unknown };
	const move = prototype.move;
	delete prototype.move;
	try {
		const directory = await scratchDirectory('no-move');
		const store = new OpfsProjectStore(() => Promise.resolve(directory));
		await store.write('p/project.json', new TextEncoder().encode('the first version'));

		await store.write('p/project.json', new TextEncoder().encode('second'));

		expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('second');
		// The copy has to take the temporary file with it, or every write on those browsers leaves
		// litter nothing can reach.
		expect(await everyPathIn(directory, '')).toEqual(['p/project.json']);
	} finally {
		if (move !== undefined) prototype.move = move;
	}
});

it('recovers once an unreachable workspace comes back, rather than latching broken', async () => {
	let reachable = false;
	const store = new OpfsProjectStore(async () => {
		if (!reachable) throw new DOMException('gone', 'NotFoundError');
		return scratchDirectory('recovery');
	});

	await expect(store.list('')).rejects.toThrow('gone');
	reachable = true;
	await expect(store.list('')).resolves.toEqual([]);
});
