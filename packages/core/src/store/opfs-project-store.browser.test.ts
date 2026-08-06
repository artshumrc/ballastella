import { expect, it } from 'vitest';

import {
	everyPathIn,
	failNextDirectoryHandleWrite,
	plantAbandonedWriteIn,
	scratchDirectory
} from './directory-handle-fixture.js';
import { OpfsProjectStore } from './opfs-project-store.js';
import { describeProjectStore } from './project-store-suite.js';

/**
 * Real OPFS in a real browser. `*.browser.test.ts` files run in the browser project of
 * `vitest.config.ts`; there is no OPFS in Node and a stub of one would only prove the stub
 * matches the memory adapter, which is the thing this file exists to check.
 *
 * Each store gets its own directory rather than the OPFS root, so tests do not see each
 * other's files. The app uses `OpfsProjectStore.open()`, whose root *is* the OPFS root —
 * asserted below, because that is the layout ADR-0008 specifies.
 *
 * The fixture is shared with the File System Access adapter's suite, because both backends are
 * one `FileSystemDirectoryHandle` store; see `directory-handle-fixture.ts`.
 */
describeProjectStore('OpfsProjectStore', async () => {
	const directory = await scratchDirectory('suite');
	return {
		store: new OpfsProjectStore(() => Promise.resolve(directory)),
		everyStoredPath: () => everyPathIn(directory, ''),
		failNextWrite: failNextDirectoryHandleWrite,
		plantAbandonedWrite: (path) => plantAbandonedWriteIn(directory, path)
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
