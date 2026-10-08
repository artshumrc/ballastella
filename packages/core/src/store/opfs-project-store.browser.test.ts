import { expect, it } from 'vitest';

import { describeDirectoryHandleStore, scratchDirectory } from './directory-handle-fixture.js';
import { describeUpdateTransaction } from '../remote/update-transaction-suite.js';
import { OpfsProjectStore } from './directory-handle-store.js';
import { encode, decode } from '../test-support.js';

describeDirectoryHandleStore(
	'OpfsProjectStore',
	(directory) => new OpfsProjectStore(() => Promise.resolve(directory))
);

describeDirectoryHandleStore('OpfsProjectStore.open (a named Workspace)', (directory) =>
	OpfsProjectStore.open(directory.name)
);

it('puts a Project inside its named Workspace, never in the OPFS root (ADR-0024)', async () => {
	const workspace = `Root check ${crypto.randomUUID()}`;
	const store = OpfsProjectStore.open(workspace);
	const directory = 'amsterdam-1625';
	await store.write(`${directory}/project.json`, encode('{}'));

	const root = await navigator.storage.getDirectory();
	const project = await (await root.getDirectoryHandle(workspace)).getDirectoryHandle(directory);
	const file = await project.getFileHandle('project.json');
	expect(decode(new Uint8Array(await (await file.getFile()).arrayBuffer()))).toBe('{}');

	await expect(root.getDirectoryHandle(directory)).rejects.toThrow();

	await root.removeEntry(workspace, { recursive: true });
});

it('keeps two named Workspaces’ Projects apart, each invisible to the other', async () => {
	const suffix = crypto.randomUUID();
	const mine = OpfsProjectStore.open(`Mine ${suffix}`);
	const theirs = OpfsProjectStore.open(`Theirs ${suffix}`);

	await mine.write('amsterdam-1625/project.json', encode('{"n":1}'));

	expect(await theirs.list('')).toEqual([]);
	await theirs.write('boston-1775/project.json', encode('{"n":2}'));

	expect(await mine.list('')).toEqual(['amsterdam-1625/project.json']);
	expect(await theirs.list('')).toEqual(['boston-1775/project.json']);
	const root = await navigator.storage.getDirectory();
	for (const name of [`Mine ${suffix}`, `Theirs ${suffix}`]) {
		await root.removeEntry(name, { recursive: true });
	}
});

describeUpdateTransaction('browser storage', async () =>
	OpfsProjectStore.open(`Update ${crypto.randomUUID()}`)
);

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

it('lists what is still there when a directory is deleted while the walk is running', async () => {
	const directory = await scratchDirectory('vanishing');
	const store = new OpfsProjectStore(() => Promise.resolve(directory));
	await store.write('kept/project.json', encode('{}'));
	await store.write('doomed/project.json', encode('{}'));

	const realEntries = directory.entries.bind(directory);
	directory.entries = async function* () {
		for await (const entry of realEntries()) {
			if (entry[0] === 'doomed') await directory.removeEntry('doomed', { recursive: true });
			yield entry;
		}
	} as typeof directory.entries;

	expect(await store.list('')).toEqual(['kept/project.json']);
});

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
	const directory = await scratchDirectory('vanishing-prefix');
	const store = new OpfsProjectStore(() => Promise.resolve(directory));
	await store.write('amsterdam-1625/project.json', encode('{}'));

	interceptChild(directory, 'amsterdam-1625', () =>
		directory.removeEntry('amsterdam-1625', { recursive: true })
	);

	expect(await store.list('amsterdam-1625/')).toEqual([]);
});

it('re-reads a directory that changed mid-listing rather than returning a short list', async () => {
	const directory = await scratchDirectory('short-list');
	const store = new OpfsProjectStore(() => Promise.resolve(directory));
	for (const name of ['a', 'b', 'c']) await store.write(`p/${name}.json`, encode('{}'));
	let counter = { reads: 0 };
	interceptWalkedChild(directory, 'p', (child) => {
		counter = breakEntriesAfterOne(child, 1);
	});

	expect(await store.list('')).toEqual(['p/a.json', 'p/b.json', 'p/c.json']);
	expect(counter.reads, 'the directory should have been read a second time').toBe(2);
});

it('reports a directory it can never read completely, rather than a plausible short list', async () => {
	const directory = await scratchDirectory('never-settles');
	const store = new OpfsProjectStore(() => Promise.resolve(directory));
	for (const name of ['a', 'b']) await store.write(`p/${name}.json`, encode('{}'));

	interceptWalkedChild(directory, 'p', (child) => {
		breakEntriesAfterOne(child, Number.MAX_SAFE_INTEGER);
	});

	await expect(store.list('')).rejects.toThrow('gone');
});
