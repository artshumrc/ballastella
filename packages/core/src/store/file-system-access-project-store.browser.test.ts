import { afterEach, beforeEach, expect, it } from 'vitest';

import {
	everyPathIn,
	failNextDirectoryHandleWrite,
	plantAbandonedWriteIn,
	scratchDirectory
} from './directory-handle-fixture.js';
import { describeUpdateTransaction } from '../remote/update-transaction-suite.js';
import { FileSystemAccessProjectStore } from './file-system-access-project-store.js';
import { describeProjectStore } from './project-store-suite.js';
import {
	FolderPermissionDeniedError,
	chooseWorkspaceFolder,
	forgetWorkspaceFolder,
	grantWorkspaceFolder,
	isFolderWorkspaceSupported,
	rememberedFolderName,
	reopenWorkspaceFolder
} from './workspace-folder.js';

/**
 * The File System Access adapter, in a real browser, against a real `FileSystemDirectoryHandle`.
 *
 * **What is real here and what is not.** Every file operation below runs against a genuine handle
 * of the genuine class — real `createWritable`, real `move`, real `removeEntry`, real
 * `getFileHandle` — so the bytes, the two-step write and the reclaim are asserted for real. The
 * handle comes from OPFS rather than from `showDirectoryPicker()`, because the picker opens an
 * operating-system dialog and waits for a person; what that leaves unasserted is the dialog and
 * the user's own folder, not the store. The grant around it — the picker call, the permission
 * query, the IndexedDB persistence — is asserted below with the picker stubbed, and again through
 * the running app in `e2e/editor-folder-workspace.e2e.ts`, where the user gesture is real.
 *
 * The shared suite runs **unchanged**, and it has to: needing to widen the interface or relax an
 * assertion for this backend would be evidence the interface had been shaped around OPFS
 * (ADR-0001). It passes because there was nothing to widen — an OPFS root and a picked folder are
 * the same handle interface, so both backends are one `DirectoryHandleStore`.
 */
describeProjectStore('FileSystemAccessProjectStore', async () => {
	const directory = await scratchDirectory('folder-suite');
	return {
		store: new FileSystemAccessProjectStore(directory),
		everyStoredPath: () => everyPathIn(directory, ''),
		failNextWrite: failNextDirectoryHandleWrite,
		plantAbandonedWrite: (path) => plantAbandonedWriteIn(directory, path)
	};
});

/**
 * Update from GitHub over a chosen folder.
 *
 * ⚠ **The same suite, unchanged, and that is the assertion.** The requirement is that the two
 * backings produce the same committed files, the same rollback-or-forward choice, the same Project
 * and Map Image lists and the same Baseline — so a claim spelled differently here would be the place
 * the two quietly stopped agreeing.
 */
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

it('writes atomically in a browser with no FileSystemFileHandle.move', async () => {
	// Safari has neither the picker nor `move`, so this branch is unreachable *on Safari* — but the
	// fallback is shared with OPFS, where Safari is the backend, and asserting it in one direction
	// only is how the shared path rots. Firefox 153 has `move`, so running the suite in a second
	// engine does not reach it either; it has to be hidden deliberately.
	const prototype = FileSystemFileHandle.prototype as { move?: unknown };
	const move = prototype.move;
	delete prototype.move;
	try {
		const directory = await scratchDirectory('folder-no-move');
		const store = new FileSystemAccessProjectStore(directory);
		await store.write('p/project.json', new TextEncoder().encode('the first version'));

		await store.write('p/project.json', new TextEncoder().encode('second'));

		expect(new TextDecoder().decode(await store.read('p/project.json'))).toBe('second');
		// In a real folder the litter is a dotfile the user sees and git commits, so the copy has to
		// take the temporary file with it.
		expect(await everyPathIn(directory, '')).toEqual(['p/project.json']);
	} finally {
		if (move !== undefined) prototype.move = move;
	}
});

it('reports a folder Workspace as unreachable once the folder is gone (ADR-0008)', async () => {
	// The sharpest difference from OPFS: this folder belongs to the user, who can move, rename, or
	// delete it while the app is open. A real deletion and a real failure from the real handle, not
	// an injected rejection.
	const root = await navigator.storage.getDirectory();
	const name = `vanishing-${crypto.randomUUID()}`;
	const directory = await root.getDirectoryHandle(name, { create: true });
	const store = new FileSystemAccessProjectStore(directory);
	await store.write('p/project.json', new TextEncoder().encode('{}'));

	await root.removeEntry(name, { recursive: true });

	await expect(store.list('')).rejects.toThrow();
});

// ---------------------------------------------------------------------------------------------
// The grant: choosing the folder, keeping it across visits, and asking for it back.
//
// `showDirectoryPicker` is stubbed because it cannot be otherwise, and so are the two permission
// methods: both wait for a person. Everything they hand back is a real handle, and everything
// asserted is our own sequencing — that the grant is asked for once and not per Project, that the
// handle really survives a round trip through IndexedDB, and that a refusal becomes a state with a
// recovery rather than a silent fall back to OPFS.

interface PickerCall {
	readonly mode: string | undefined;
	readonly id: string | undefined;
}

const picked: PickerCall[] = [];
let restorePicker: (() => void) | undefined;

/**
 * Stand in for the picker: hand back `outcome`, or refuse the two ways it can.
 *
 * An **own** property on the global, because a browser's own `showDirectoryPicker` lives on
 * `Window.prototype` and cannot be deleted from the instance. Shadowing it with `undefined` is
 * what makes "this browser has no picker" reproducible in a browser that has one.
 */
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

/**
 * A real handle whose permission answers we choose.
 *
 * Own properties on a real directory handle, so every file operation on it is still the real
 * thing and only the two methods that would open a dialog are ours.
 */
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

it('offers no folder Workspace where the browser has no picker', () => {
	stubDirectoryPicker('absent');

	expect(isFolderWorkspaceSupported()).toBe(false);
});

it('offers a folder Workspace where the browser has a picker', async () => {
	stubDirectoryPicker(await scratchDirectory('supported'));

	expect(isFolderWorkspaceSupported()).toBe(true);
});

it('makes the chosen folder the Workspace, asking once for read and write', async () => {
	const folder = await scratchDirectory('chosen');
	stubDirectoryPicker(folder);

	const store = await chooseWorkspaceFolder();

	// `readwrite` up front: the first thing the app does with a Workspace is write to it, so asking
	// for read and upgrading later would cost a second prompt for nothing.
	expect(picked).toEqual([{ mode: 'readwrite', id: 'ballastella-workspace' }]);
	// Really that folder: a Project written through the store is a file in it.
	await store?.write('amsterdam-1625/project.json', new TextEncoder().encode('{}'));
	expect(await everyPathIn(folder, '')).toEqual(['amsterdam-1625/project.json']);
});

it('treats a closed picker as nothing having happened, and remembers no folder', async () => {
	stubDirectoryPicker('cancelled');

	await expect(chooseWorkspaceFolder()).resolves.toBeNull();

	expect(await rememberedFolderName()).toBeNull();
});

it('refuses to remember a folder whose write permission was declined', async () => {
	// Never a silent fall back to OPFS, which to the user is indistinguishable from the tool having
	// lost the folder they just pointed it at.
	const { folder } = withPermission(await scratchDirectory('declined'), 'prompt', 'denied');
	stubDirectoryPicker(folder);

	await expect(chooseWorkspaceFolder()).rejects.toThrow(FolderPermissionDeniedError);

	expect(await rememberedFolderName()).toBeNull();
});

it('resumes the same folder on the next visit, with its Projects in it', async () => {
	const folder = await scratchDirectory('resumed');
	stubDirectoryPicker(folder);
	const chosen = await chooseWorkspaceFolder();
	await chosen?.write('amsterdam-1625/project.json', new TextEncoder().encode('{"n":1}'));

	// A later visit has nothing in memory: only what IndexedDB kept, which is the handle itself.
	expect(await rememberedFolderName()).toBe(folder.name);
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

	expect(await rememberedFolderName()).toBeNull();
	await expect(reopenWorkspaceFolder()).resolves.toBeNull();
});

it('asks for permission on return only when it is not already held (ADR-0008)', async () => {
	// One grant covers every Project in the Workspace. A store that asked per Project — or per
	// write — reintroduces the prompt-per-Project friction the workspace model exists to remove,
	// and puts a possible dialog inside autosave.
	const held = withPermission(await scratchDirectory('still-granted'), 'granted');

	const store = await grantWorkspaceFolder(held.folder);
	await store.write('a/project.json', new TextEncoder().encode('{}'));
	await store.write('b/project.json', new TextEncoder().encode('{}'));
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
	// The message has to say the work is still there: a permission dialog dismissed by reflex is
	// otherwise indistinguishable from the tool having lost the folder.
	await expect(grantWorkspaceFolder(refused.folder)).rejects.toThrow(/not been moved or lost/);
});
