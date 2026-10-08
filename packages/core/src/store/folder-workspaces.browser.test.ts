import { afterEach, beforeEach, expect, it } from 'vitest';

import { scratchDirectory } from './directory-handle-fixture.js';
import {
	chooseWorkspaceFolder,
	forgetWorkspaceFolder,
	listFolderWorkspaces,
	migratePreExistingFolderWorkspace,
	resolveFolderWorkspace
} from './workspace-folder.js';
import { FakeJournalStorage } from '../autosave/fake-journal-storage.js';
import { FakeMetadataStorage } from '../remote/fake-metadata-storage.js';
import {
	EVERY_RECORD,
	NO_RECORDS,
	fillWorkspaceRecords,
	workspaceRecordsOf
} from './workspace-records-fixture.js';

const workspaceKey = (folderKey: string): string => `folder:${folderKey}`;
let journalStorage: FakeJournalStorage;
let metadataStorage: FakeMetadataStorage;
let restorePicker: (() => void) | undefined;
const fill = (key: string) => fillWorkspaceRecords(journalStorage, metadataStorage, key);
const recordsOf = (key: string) => workspaceRecordsOf(journalStorage, metadataStorage, key);
const migrate = () =>
	migratePreExistingFolderWorkspace({ journalStorage, metadataStorage, workspaceKey });

async function folderNamed(name: string): Promise<FileSystemDirectoryHandle> {
	const folder = await scratchDirectory(name);
	Object.defineProperty(folder, 'name', { value: name, configurable: true });
	return folder;
}

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
	expect(renamed?.reference).toBe(created?.reference);
	expect(renamed?.label).toBe('maps');
	expect(renamed?.folderName).toBe('charts');
});

it('moves the pre-existing folder’s records onto its reference, once', async () => {
	const folder = await folderNamed('maps');
	await remember(folder);
	await fill(workspaceKey('maps'));

	const migrated = await migrate();
	expect(migrated?.folderName).toBe('maps');
	expect(
		await workspaceRecordsOf(
			journalStorage,
			metadataStorage,
			workspaceKey(migrated?.reference ?? '')
		)
	).toEqual(EVERY_RECORD);
	expect(await recordsOf(workspaceKey('maps'))).toEqual(NO_RECORDS);
});

it('has nothing left to move the second time it runs', async () => {
	const folder = await folderNamed('maps');
	await remember(folder);
	await fill(workspaceKey('maps'));
	const first = await migrate();
	await fill(workspaceKey('maps'));

	const second = await migrate();
	expect(second?.reference).toBe(first?.reference);
	expect(await recordsOf(workspaceKey('maps'))).toEqual(EVERY_RECORD);
});

it('has nothing to move where no folder was ever chosen', async () => {
	await expect(migrate()).resolves.toBeNull();
});

it('leaves the old records where they are when the move cannot finish', async () => {
	const folder = await folderNamed('maps');
	await remember(folder);
	await fill(workspaceKey('maps'));
	const recorded = (await listFolderWorkspaces()).length;
	journalStorage.setItem = () => {
		throw new Error('QuotaExceededError');
	};

	const migrated = await migrate();
	expect(migrated).toBeNull();
	expect(await recordsOf(workspaceKey('maps'))).toEqual(EVERY_RECORD);
	expect(await listFolderWorkspaces()).toHaveLength(recorded);
});
