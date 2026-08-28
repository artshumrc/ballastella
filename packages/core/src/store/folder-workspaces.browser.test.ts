// The durable record that makes a folder Workspace something there can be more than one of.
//
// A browser test because the record lives in IndexedDB and is recognised by `isSameEntry`, and
// neither exists in Node. The handles come from OPFS rather than from `showDirectoryPicker()`, for
// the reason `file-system-access-project-store.browser.test.ts` gives: the picker waits for a
// person. What that leaves unasserted is the dialog, not the record.

import { afterEach, beforeEach, expect, it } from 'vitest';

import { scratchDirectory } from './directory-handle-fixture.js';
import {
	listFolderWorkspaces,
	migratePreExistingFolderWorkspace,
	resolveFolderWorkspace
} from './folder-workspaces.js';
import { chooseWorkspaceFolder, forgetWorkspaceFolder } from './workspace-folder.js';
import { DeletedProjects } from '../autosave/deleted-projects.js';
import { FakeJournalStorage } from '../autosave/fake-journal-storage.js';
import { WriteAheadJournal, readJournal } from '../autosave/journal.js';
import { FakeMetadataStorage } from '../remote/fake-metadata-storage.js';
import { LocalChangeIndex } from '../remote/local-change-index.js';
import { PublishManifests } from '../remote/publish-manifest.js';
import { SynchronizationMetadata } from '../remote/synchronization-metadata.js';
import type { StorePath } from './project-store.js';

/** How the editor spells a folder Workspace's key. Injected, because only the app knows. */
const workspaceKey = (folderKey: string): string => `folder:${folderKey}`;

const REMOTE = { owner: 'ada', repository: 'atlas', branch: 'main' };
const PATH = 'amsterdam-1625/project.json' as StorePath;

let journalStorage: FakeJournalStorage;
let metadataStorage: FakeMetadataStorage;
let restorePicker: (() => void) | undefined;

/**
 * A directory whose `name` is ours, so two folders can share one.
 *
 * An own property over the real handle's prototype getter: everything else about it — `isSameEntry`
 * above all — is still the browser's.
 */
async function folderNamed(name: string): Promise<FileSystemDirectoryHandle> {
	const folder = await scratchDirectory(name);
	Object.defineProperty(folder, 'name', { value: name, configurable: true });
	return folder;
}

/** Make `folder` the one in the single pre-plural slot, as a previous visit would have. */
async function remember(folder: FileSystemDirectoryHandle): Promise<void> {
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'showDirectoryPicker');
	Object.defineProperty(globalThis, 'showDirectoryPicker', {
		value: () => Promise.resolve(folder),
		configurable: true,
		writable: true
	});
	restorePicker = () => {
		if (previous) Object.defineProperty(globalThis, 'showDirectoryPicker', previous);
		else delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
	};
	await chooseWorkspaceFolder();
}

/** All five families, with something of the user's in each, under one Workspace key. */
async function fillWorkspace(key: string): Promise<void> {
	new WriteAheadJournal(journalStorage, key).record(PATH, new TextEncoder().encode('{"n":1}'));
	new DeletedProjects(journalStorage, key).record('rotterdam-1690', null);
	new PublishManifests(journalStorage, key).write({
		remote: REMOTE,
		commit: 'c0ffee',
		files: new Map([[PATH, 'blob1']])
	});
	const synchronization = new SynchronizationMetadata(metadataStorage, key);
	await synchronization.bindRemote(REMOTE);
	await synchronization.writeBaseline({ remote: REMOTE, commit: 'c0ffee', files: new Map() });
	const changes = new LocalChangeIndex(metadataStorage, key, { flushInterval: 0 });
	await changes.mark(PATH, 'written');
	await changes.flush();
}

/** What each of the five families answers for a Workspace key. */
async function familiesOf(key: string): Promise<Record<string, unknown>> {
	const synchronization = new SynchronizationMetadata(metadataStorage, key);
	return {
		journalled: readJournal(journalStorage, key).entries.map((entry) => entry.path),
		deletions: new DeletedProjects(journalStorage, key).pending().map((one) => one.directory),
		manifest: new PublishManifests(journalStorage, key).read(REMOTE)?.commit ?? null,
		remote: (await synchronization.readRemote())?.repository ?? null,
		baseline: (await synchronization.readBaseline(REMOTE))?.commit ?? null,
		changes: (await new LocalChangeIndex(metadataStorage, key).localChanges()).written
	};
}

const everything = {
	journalled: [PATH],
	deletions: ['rotterdam-1690'],
	manifest: 'c0ffee',
	remote: 'atlas',
	baseline: 'c0ffee',
	changes: [PATH]
};

const nothing = {
	journalled: [],
	deletions: [],
	manifest: null,
	remote: null,
	baseline: null,
	changes: []
};

beforeEach(async () => {
	journalStorage = new FakeJournalStorage();
	metadataStorage = new FakeMetadataStorage();
	await forgetWorkspaceFolder();
});

afterEach(async () => {
	restorePicker?.();
	restorePicker = undefined;
	await forgetWorkspaceFolder();
});

it('gives a folder a reference of its own, and the same one every time it is opened', async () => {
	const folder = await folderNamed('maps');

	const first = await resolveFolderWorkspace(folder);
	const again = await resolveFolderWorkspace(folder);

	expect(first?.reference).toMatch(/./);
	expect(again?.reference).toBe(first?.reference);
});

it('makes two folders that share a name two Workspaces', async () => {
	const one = await folderNamed('maps');
	const other = await folderNamed('maps');

	const first = await resolveFolderWorkspace(one);
	const second = await resolveFolderWorkspace(other);

	expect(first?.folderName).toBe('maps');
	expect(second?.folderName).toBe('maps');
	expect(second?.reference).not.toBe(first?.reference);
});

it('keeps the Workspace’s own name across a reload, and its directory’s name beneath it', async () => {
	const folder = await folderNamed('maps');
	const created = await resolveFolderWorkspace(folder);

	// Nothing in memory: what a later visit has is the record IndexedDB kept.
	const listed = (await listFolderWorkspaces()).find(
		(record) => record.reference === created?.reference
	);

	expect(listed).toEqual({ reference: created?.reference, label: 'maps', folderName: 'maps' });
});

it('leaves the Workspace’s own name alone when its directory is renamed', async () => {
	const folder = await folderNamed('maps');
	const created = await resolveFolderWorkspace(folder);

	Object.defineProperty(folder, 'name', { value: 'charts', configurable: true });
	const renamed = await resolveFolderWorkspace(folder);

	// The same place, so the same Workspace and the same journal — with the label the author's and
	// the directory's own name only what is shown beneath it.
	expect(renamed?.reference).toBe(created?.reference);
	expect(renamed?.label).toBe('maps');
	expect(renamed?.folderName).toBe('charts');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The one folder a pre-plural installation could have, moved onto a reference of its own.

it('moves the pre-existing folder’s records onto its reference, once', async () => {
	const folder = await folderNamed('maps');
	await remember(folder);
	await fillWorkspace(workspaceKey('maps'));

	const migrated = await migratePreExistingFolderWorkspace({
		journalStorage,
		metadataStorage,
		workspaceKey
	});

	expect(migrated?.folderName).toBe('maps');
	expect(await familiesOf(workspaceKey(migrated?.reference ?? ''))).toEqual(everything);
	expect(await familiesOf(workspaceKey('maps'))).toEqual(nothing);
});

it('has nothing left to move the second time it runs', async () => {
	const folder = await folderNamed('maps');
	await remember(folder);
	await fillWorkspace(workspaceKey('maps'));
	const first = await migratePreExistingFolderWorkspace({
		journalStorage,
		metadataStorage,
		workspaceKey
	});
	// What the same folder is worth after the migration: a Workspace already recorded, and a second
	// pass that mints nothing and moves nothing.
	await fillWorkspace(workspaceKey('maps'));

	const second = await migratePreExistingFolderWorkspace({
		journalStorage,
		metadataStorage,
		workspaceKey
	});

	expect(second?.reference).toBe(first?.reference);
	expect(await familiesOf(workspaceKey('maps'))).toEqual(everything);
});

it('has nothing to move where no folder was ever chosen', async () => {
	await expect(
		migratePreExistingFolderWorkspace({ journalStorage, metadataStorage, workspaceKey })
	).resolves.toBeNull();
});

it('leaves the old records where they are when the move cannot finish', async () => {
	const folder = await folderNamed('maps');
	await remember(folder);
	await fillWorkspace(workspaceKey('maps'));
	const recorded = (await listFolderWorkspaces()).length;
	journalStorage.setItem = () => {
		throw new Error('QuotaExceededError');
	};

	const migrated = await migratePreExistingFolderWorkspace({
		journalStorage,
		metadataStorage,
		workspaceKey
	});

	// And no record either, so the next visit tries again rather than opening a Workspace whose
	// journal and Remote binding are somewhere it will never look.
	expect(migrated).toBeNull();
	expect(await familiesOf(workspaceKey('maps'))).toEqual(everything);
	expect(await listFolderWorkspaces()).toHaveLength(recorded);
});
