import { afterEach, beforeEach, expect, it } from 'vitest';

import {
	describeDirectoryHandleStore,
	everyPathIn,
	scratchDirectory
} from './directory-handle-fixture.js';
import { describeUpdateTransaction } from '../remote/update-transaction-suite.js';
import { FileSystemAccessProjectStore } from './directory-handle-store.js';
import {
	FolderPermissionDeniedError,
	chooseWorkspaceFolder,
	forgetWorkspaceFolder,
	grantWorkspaceFolder,
	isFolderWorkspaceSupported,
	rememberedWorkspaceFolder,
	reopenWorkspaceFolder
} from './workspace-folder.js';
import { encode } from '../test-support.js';

describeDirectoryHandleStore(
	'FileSystemAccessProjectStore',
	(directory) => new FileSystemAccessProjectStore(directory)
);

describeUpdateTransaction(
	'a chosen folder',
	async () => new FileSystemAccessProjectStore(await scratchDirectory('folder-update'))
);

it('names the folder, so the app can tell the user which folder their Workspace is', async () => {
	const directory = await scratchDirectory('named');
	const store = new FileSystemAccessProjectStore(directory);
	expect(store.folderName).toBe(directory.name);
	expect(store.folder).toBe(directory);
});

it('reports a folder Workspace as unreachable once the folder is gone (ADR-0008)', async () => {
	const root = await navigator.storage.getDirectory();
	const name = `vanishing-${crypto.randomUUID()}`;
	const directory = await root.getDirectoryHandle(name, { create: true });
	const store = new FileSystemAccessProjectStore(directory);
	await store.write('p/project.json', encode('{}'));

	await root.removeEntry(name, { recursive: true });

	await expect(store.list('')).rejects.toThrow();
});

interface PickerCall {
	readonly mode: string | undefined;
	readonly id: string | undefined;
}

const picked: PickerCall[] = [];
let restorePicker: (() => void) | undefined;

function stubDirectoryPicker(outcome: FileSystemDirectoryHandle | 'cancelled' | 'absent'): void {
	const global = globalThis as { showDirectoryPicker?: unknown };
	const own = Object.getOwnPropertyDescriptor(global, 'showDirectoryPicker');
	restorePicker = () => {
		delete global.showDirectoryPicker;
		if (own) Object.defineProperty(global, 'showDirectoryPicker', own);
	};

	const value =
		outcome === 'absent'
			? undefined
			: (options?: { mode?: string; id?: string }) => {
					picked.push({ mode: options?.mode, id: options?.id });
					return outcome === 'cancelled'
						? Promise.reject(new DOMException('The user aborted a request.', 'AbortError'))
						: Promise.resolve(outcome);
				};
	Object.defineProperty(global, 'showDirectoryPicker', {
		value,
		configurable: true,
		writable: true
	});
}

function withPermission(
	folder: FileSystemDirectoryHandle,
	held: PermissionState,
	granted: PermissionState = held
): { folder: FileSystemDirectoryHandle; requests: () => number } {
	let requests = 0;
	Object.assign(folder, {
		queryPermission: () => Promise.resolve(held),
		requestPermission: () => {
			requests += 1;
			return Promise.resolve(granted);
		}
	});
	return { folder, requests: () => requests };
}

beforeEach(async () => {
	picked.length = 0;
	await forgetWorkspaceFolder();
});

afterEach(async () => {
	restorePicker?.();
	restorePicker = undefined;
	await forgetWorkspaceFolder();
});

it('offers a folder Workspace only where the browser has a picker', async () => {
	stubDirectoryPicker('absent');
	expect(isFolderWorkspaceSupported()).toBe(false);
	restorePicker?.();
	stubDirectoryPicker(await scratchDirectory('supported'));
	expect(isFolderWorkspaceSupported()).toBe(true);
});

it('makes the chosen folder the Workspace, asking once for read and write', async () => {
	const folder = await scratchDirectory('chosen');
	stubDirectoryPicker(folder);
	const store = await chooseWorkspaceFolder();
	expect(picked).toEqual([{ mode: 'readwrite', id: 'ballastella-workspace' }]);
	await store?.write('amsterdam-1625/project.json', encode('{}'));
	expect(await everyPathIn(folder, '')).toEqual(['amsterdam-1625/project.json']);
});

it('treats a closed picker as nothing having happened, and remembers no folder', async () => {
	stubDirectoryPicker('cancelled');

	await expect(chooseWorkspaceFolder()).resolves.toBeNull();

	expect(await rememberedWorkspaceFolder()).toBeNull();
});

it('refuses to remember a folder whose write permission was declined', async () => {
	const { folder } = withPermission(await scratchDirectory('declined'), 'prompt', 'denied');
	stubDirectoryPicker(folder);

	await expect(chooseWorkspaceFolder()).rejects.toThrow(FolderPermissionDeniedError);

	expect(await rememberedWorkspaceFolder()).toBeNull();
});

it('resumes the same folder on the next visit, with its Projects in it', async () => {
	const folder = await scratchDirectory('resumed');
	stubDirectoryPicker(folder);
	const chosen = await chooseWorkspaceFolder();
	await chosen?.write('amsterdam-1625/project.json', encode('{"n":1}'));

	expect((await rememberedWorkspaceFolder())?.name).toBe(folder.name);
	const resumed = await reopenWorkspaceFolder();
	expect(await resumed?.list('')).toEqual(['amsterdam-1625/project.json']);
	expect(resumed?.folderName).toBe(folder.name);
});

it('has nothing to resume when no folder was ever chosen', async () => {
	await expect(reopenWorkspaceFolder()).resolves.toBeNull();
});

it('stops offering a folder the user has moved away from', async () => {
	stubDirectoryPicker(await scratchDirectory('abandoned'));
	await chooseWorkspaceFolder();

	await forgetWorkspaceFolder();

	expect(await rememberedWorkspaceFolder()).toBeNull();
	await expect(reopenWorkspaceFolder()).resolves.toBeNull();
});

it('asks for permission on return only when it is not already held (ADR-0008)', async () => {
	const held = withPermission(await scratchDirectory('still-granted'), 'granted');
	const store = await grantWorkspaceFolder(held.folder);
	await store.write('a/project.json', encode('{}'));
	await store.write('b/project.json', encode('{}'));
	await store.list('');

	expect(held.requests()).toBe(0);
});

it('asks for permission on return when the grant has lapsed', async () => {
	const lapsed = withPermission(await scratchDirectory('lapsed'), 'prompt', 'granted');
	const store = await grantWorkspaceFolder(lapsed.folder);
	expect(lapsed.requests()).toBe(1);
	expect(store.folderName).toBe(lapsed.folder.name);
});

it('explains a declined return rather than falling back to browser storage', async () => {
	const refused = withPermission(await scratchDirectory('refused'), 'prompt', 'denied');

	await expect(grantWorkspaceFolder(refused.folder)).rejects.toThrow(FolderPermissionDeniedError);
	await expect(grantWorkspaceFolder(refused.folder)).rejects.toThrow(/not been moved or lost/);
});
