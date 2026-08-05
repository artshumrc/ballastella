import { expect, it } from 'vitest';

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
 */
const scratchDirectory = async (label: string): Promise<FileSystemDirectoryHandle> => {
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle(`${label}-${crypto.randomUUID()}`, { create: true });
};

describeProjectStore('OpfsProjectStore', async () => {
	const directory = await scratchDirectory('suite');
	return new OpfsProjectStore(() => Promise.resolve(directory));
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
