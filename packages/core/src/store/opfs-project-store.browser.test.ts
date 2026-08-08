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

it('lists what is still there when a directory is deleted while the walk is running', async () => {
	// ADR-0023's Workspace is shared: a second tab, a colleague's edit arriving through a synced
	// folder, or the user deleting a Project in another window can all remove a directory between
	// the root's `entries()` yielding it and the walk descending into it. Chromium raises
	// `NotFoundError` from inside the `for await` at that point, and it used to come out of `list`
	// — which `EditorSession.refreshHistoricalMaps` reads as the Workspace being unreachable, so one
	// deleted Project replaced the whole hub with "your Workspace cannot be reached".
	//
	// The deletion here is real and lands at the real race point: the root's iterator is wrapped so
	// that `doomed/` is removed at the moment it is yielded, before anything descends into it.
	const directory = await scratchDirectory('vanishing');
	const store = new OpfsProjectStore(() => Promise.resolve(directory));
	await store.write('kept/project.json', new TextEncoder().encode('{}'));
	await store.write('doomed/project.json', new TextEncoder().encode('{}'));

	const realEntries = directory.entries.bind(directory);
	directory.entries = async function* () {
		for await (const entry of realEntries()) {
			if (entry[0] === 'doomed') await directory.removeEntry('doomed', { recursive: true });
			yield entry;
		}
	} as typeof directory.entries;

	// The surviving Project is listed, and nothing throws. The vanished one is simply not there,
	// which is the same answer a listing taken a moment later gives.
	expect(await store.list('')).toEqual(['kept/project.json']);
});

/**
 * Hand the store a real child handle and then do something to the folder before it is walked.
 *
 * Patched on the *root handle the store was given*, because that is the object it actually calls:
 * `#directory` resolves every prefix with `getDirectoryHandle`, which returns a fresh handle each
 * time — so patching a handle obtained separately in the test patches something the store never
 * touches. (It did, in the first cut of these tests, and they passed for the wrong reason.)
 */
const interceptChild = (
	directory: FileSystemDirectoryHandle,
	name: string,
	meddle: (child: FileSystemDirectoryHandle) => void | Promise<void>
): void => {
	const real = directory.getDirectoryHandle.bind(directory);
	directory.getDirectoryHandle = async (wanted: string, options?: { create?: boolean }) => {
		const child = await real(wanted, options);
		if (wanted === name) await meddle(child);
		return child;
	};
};

/**
 * The same, for a child the walk reaches by *iterating* rather than by name.
 *
 * The two routes into a subdirectory are different objects and only one of them goes through
 * `getDirectoryHandle`: a walk of the root gets its children straight out of `entries()`. Patching
 * the wrong one is a hook that never fires and a test that passes having exercised nothing, which is
 * what the first cut of these did.
 */
const interceptWalkedChild = (
	directory: FileSystemDirectoryHandle,
	name: string,
	meddle: (child: FileSystemDirectoryHandle) => void
): void => {
	const real = directory.entries.bind(directory);
	directory.entries = (() =>
		(async function* () {
			for await (const [entryName, handle] of real()) {
				if (entryName === name && handle.kind === 'directory')
					meddle(handle as FileSystemDirectoryHandle);
				yield [entryName, handle] as [string, FileSystemHandle];
			}
		})()) as typeof directory.entries;
};

/**
 * Make a directory handle's `entries()` raise `NotFoundError` after one entry, for the first
 * `failures` reads. Counts the reads, so "was it read again?" is assertable.
 */
const breakEntriesAfterOne = (child: FileSystemDirectoryHandle, failures: number) => {
	const real = child.entries.bind(child);
	const counter = { reads: 0 };
	child.entries = (() => {
		counter.reads += 1;
		const failThisRead = counter.reads <= failures;
		return (async function* () {
			let yielded = 0;
			for await (const entry of real()) {
				if (failThisRead && yielded === 1) throw new DOMException('gone', 'NotFoundError');
				yielded += 1;
				yield entry;
			}
		})();
	}) as typeof child.entries;
	return counter;
};

it('forgives a vanished directory under a prefix too, not only at the root', async () => {
	// The scenario the fix above is *named* for is a Project deleted in another window, and the
	// callers that meet it are `Workspace.duplicateProject` and `deleteProject`, which list
	// `<project>/` rather than `''`. Covering only `list('')` left those throwing on the very race —
	// found by review, not by anything failing, because no e2e test happens to delete a Project
	// during a per-Project listing.
	//
	// This is also not a weakening. `#directory` resolves a prefix with `getDirectoryHandle`, whose
	// `NotFoundError` is already caught and returned as `[]` — so a Project deleted a moment *earlier*
	// has always listed as empty, and this only makes a Project deleted a moment *later* agree.
	// The race is precisely: `#directory` resolved the Project, *then* it went, so the failure lands
	// on the Project's own `entries()` — one level above where the descent already forgave.
	const directory = await scratchDirectory('vanishing-prefix');
	const store = new OpfsProjectStore(() => Promise.resolve(directory));
	await store.write('amsterdam-1625/project.json', new TextEncoder().encode('{}'));

	interceptChild(directory, 'amsterdam-1625', () =>
		directory.removeEntry('amsterdam-1625', { recursive: true })
	);

	expect(await store.list('amsterdam-1625/')).toEqual([]);
});

it('re-reads a directory that changed mid-listing rather than returning a short list', async () => {
	// **The failure mode that the obvious fix introduces.** Keeping the entries collected before a
	// mid-drain `NotFoundError` and carrying on gives a listing that is short by an unknown number of
	// files and reports success — quieter and worse than the throw it replaces, because `list('')`
	// feeds the hub, publishing, and ticket 13's backup, where a short listing is an archive silently
	// missing somebody's work.
	//
	// So the drain is restarted instead. The first read of `p/` throws after one of its three files;
	// a "keep what we have" implementation answers `['p/a.json']` and this asserts all three.
	const directory = await scratchDirectory('short-list');
	const store = new OpfsProjectStore(() => Promise.resolve(directory));
	for (const name of ['a', 'b', 'c'])
		await store.write(`p/${name}.json`, new TextEncoder().encode('{}'));

	let counter = { reads: 0 };
	interceptWalkedChild(directory, 'p', (child) => {
		counter = breakEntriesAfterOne(child, 1);
	});

	expect(await store.list('')).toEqual(['p/a.json', 'p/b.json', 'p/c.json']);
	expect(counter.reads, 'the directory should have been read a second time').toBe(2);
});

it('reports a directory it can never read completely, rather than a plausible short list', async () => {
	// The other side of the retry: something being deleted continuously is a fact about the Workspace
	// and the caller is entitled to hear it rather than to be handed a short list. Bounded, so this
	// terminates rather than spinning.
	const directory = await scratchDirectory('never-settles');
	const store = new OpfsProjectStore(() => Promise.resolve(directory));
	for (const name of ['a', 'b'])
		await store.write(`p/${name}.json`, new TextEncoder().encode('{}'));

	interceptWalkedChild(directory, 'p', (child) => {
		breakEntriesAfterOne(child, Number.MAX_SAFE_INTEGER);
	});

	await expect(store.list('')).rejects.toThrow('gone');
});
