// Choosing a Workspace folder, keeping it across visits, and asking for it back — everything
// about the *grant*, and nothing about bytes (ADR-0001, ADR-0008, ADR-0012).
//
// The grant is deliberately separate from FileSystemAccessProjectStore. One folder is granted
// once and every Project inside it is reachable (ADR-0008), so permission is a thing that
// happens at two moments — picking, and returning — and never on the path of a read or a write.
// A store that re-checked permission per operation would reintroduce the prompt-per-Project
// friction the workspace model exists to remove, and would put a possible prompt inside autosave.

import { FileSystemAccessProjectStore } from './file-system-access-project-store.js';
import {
	WORKSPACE_STORE,
	openInstallationDatabase,
	transactInstallationDatabase
} from './installation-database.js';

/**
 * A Workspace is read *and* written, so the grant asked for is always `readwrite`. Asking for
 * `read` first and upgrading later would cost the user a second prompt for no benefit — the
 * first thing the app does with a Workspace is write to it.
 */
const READWRITE = { mode: 'readwrite' } as const;

/**
 * `showDirectoryPicker`, `FileSystemHandle.queryPermission`, and
 * `FileSystemHandle.requestPermission` are all in the File System Access specification and none
 * of them is in TypeScript's DOM library. Declared narrowly and locally, as optional members, so
 * that every use is a feature test — a global `declare` would let a browser without the picker
 * typecheck as though it had one, which is the mistake ADR-0001 is guarding against.
 */
type FileSystemPermissionMode = 'read' | 'readwrite';

type PermissionCapableHandle = FileSystemHandle & {
	queryPermission?: (descriptor: { mode: FileSystemPermissionMode }) => Promise<PermissionState>;
	requestPermission?: (descriptor: { mode: FileSystemPermissionMode }) => Promise<PermissionState>;
};

type DirectoryPicker = (options?: {
	id?: string;
	mode?: FileSystemPermissionMode;
	startIn?: FileSystemHandle | string;
}) => Promise<FileSystemDirectoryHandle>;

/**
 * Names the picker's memory of where the user last browsed, so choosing again starts in the
 * folder they chose before rather than at their home directory. Purely Chromium's own state; we
 * store nothing under it.
 */
const PICKER_ID = 'ballastella-workspace';

/** Rejected when the user says no to the folder. A normal state with a retry, not a fault. */
export class FolderPermissionDeniedError extends Error {
	constructor(folderName: string) {
		super(
			`Ballastella was not given permission to read and write the folder “${folderName}”. ` +
				'Your work has not been moved or lost.'
		);
		this.name = 'FolderPermissionDeniedError';
	}
}

/**
 * Whether this browser can put a Workspace in a folder the user can see.
 *
 * False in Firefox, in Safari, and on Chrome for Android — where the answer must be that the
 * option is simply **absent**, not disabled and not explained away. OPFS keeps working and
 * nothing about the app changes (ADR-0001).
 */
export function isFolderWorkspaceSupported(): boolean {
	return typeof directoryPicker() === 'function';
}

/**
 * Ask the user for a Workspace folder, and remember it for next time.
 *
 * `null` when they closed the picker without choosing — a cancelled gesture is not a failure and
 * needs no message. Rejects with {@link FolderPermissionDeniedError} if a folder was chosen but
 * writing to it was refused, because that is a state with a recovery the user has to be told
 * about rather than one to fall back from silently.
 *
 * Needs transient user activation, so it must be called from a click or a keypress.
 */
export async function chooseWorkspaceFolder(): Promise<FileSystemAccessProjectStore | null> {
	const picker = directoryPicker();
	if (!picker) throw new Error('This browser cannot put a Workspace in a folder.');

	let folder: FileSystemDirectoryHandle;
	try {
		folder = await picker({ id: PICKER_ID, mode: 'readwrite' });
	} catch (cause) {
		// The one failure that is not a failure. Chromium also reports a refused *write* grant this
		// way, which is why the grant below is checked rather than assumed.
		if (cause instanceof DOMException && cause.name === 'AbortError') return null;
		throw cause;
	}
	const store = await grantWorkspaceFolder(folder);
	await rememberFolder(folder);
	return store;
}

/**
 * Reopen the folder in the single pre-plural slot — whichever was picked last — or `null` if there is
 * none.
 *
 * ⚠ **Not "the folder Workspace the author was in".** Since ADR-0042 that question is answered by a
 * folder Workspace's own record, and this slot holds only the most recent pick, so the app reaches
 * this only where no record could be kept — which is also the one case where there can be no second
 * folder to confuse it with.
 *
 * **Must be called from a user gesture.** `requestPermission()` needs transient user activation,
 * and called automatically on load it fails silently — leaving an app that appears to have lost
 * the user's folder (ADR-0012). True no-prompt resumption needs Chrome 122+ and works best for an
 * installed PWA, which is the honest answer to "why does it keep asking?".
 *
 * Rejects with {@link FolderPermissionDeniedError} when the user declines. A folder that has been
 * moved or deleted is *not* reported here: permission survives the folder, so this resolves and
 * the first `list` fails, which is where ADR-0008's "Workspace not reachable" belongs.
 */
export async function reopenWorkspaceFolder(): Promise<FileSystemAccessProjectStore | null> {
	const folder = await recallFolder();
	if (!folder) return null;
	return grantWorkspaceFolder(folder);
}

/**
 * The name of the folder in the single pre-plural slot, or `null`.
 *
 * Reads IndexedDB and nothing else — no permission is queried and no prompt can appear — so it is
 * safe on load. Nothing in the running app calls it: the offer to reopen a remembered folder is what
 * ADR-0042 deleted, and a folder Workspace's name comes from its own record.
 */
export async function rememberedFolderName(): Promise<string | null> {
	const folder = await recallFolder();
	return folder ? folder.name : null;
}

/**
 * Let the single pre-plural slot go.
 *
 * ⚠ **Nothing in the running app calls this, and that is the state ADR-0042 left it in.** A folder
 * Workspace is a row in the roster with a record of its own, so there is no "go back to browser
 * storage" that drops a folder grant and no offer that has to stop being made. What remains is the
 * slot itself, which the one-time migration's trigger reads and which a test has to be able to
 * empty. The folder is untouched either way — every Project in it is still there.
 */
export async function forgetWorkspaceFolder(): Promise<void> {
	remembered = null;
	const database = await openInstallationDatabase();
	if (!database) return;
	try {
		await transact(database, 'readwrite', (store) => store.delete(FOLDER_KEY));
	} finally {
		database.close();
	}
}

/**
 * Turn a directory handle into a Workspace, asking for permission only if it is not already held.
 *
 * The **one grant** of ADR-0008: called once when the folder is chosen and once when it is
 * reopened, never per Project and never per write.
 */
export async function grantWorkspaceFolder(
	folder: FileSystemDirectoryHandle
): Promise<FileSystemAccessProjectStore> {
	const handle: PermissionCapableHandle = folder;
	// A browser with no `queryPermission` has no permission model for handles either, so there is
	// nothing that could be outstanding. Treating that as granted keeps this honest about which
	// browsers it is talking to instead of inventing a refusal none of them would give.
	const held = handle.queryPermission
		? await handle.queryPermission.call(folder, READWRITE)
		: 'granted';
	const state =
		held === 'granted'
			? held
			: handle.requestPermission
				? await handle.requestPermission.call(folder, READWRITE)
				: 'denied';
	if (state !== 'granted') throw new FolderPermissionDeniedError(folder.name);
	return new FileSystemAccessProjectStore(folder);
}

/**
 * The remembered folder itself, for the caller that needs the **place** rather than a name to show.
 *
 * `folder-workspaces.ts` alone: the single slot holds the one folder Workspace a pre-plural
 * installation could have, and moving its durable records onto a minted reference means recognising
 * that folder again by handle. A name would not do — two folders may share one, which is the whole
 * reason a folder Workspace stopped being keyed by its name (ADR-0042).
 */
export async function rememberedWorkspaceFolder(): Promise<FileSystemDirectoryHandle | null> {
	return recallFolder();
}

/**
 * Keep a **second, independent** hold on a folder grant, and answer with the reference to ask for it
 * back by (ADR-0037).
 *
 * ⚠ **Separate from the single slot {@link rememberedFolderName} reads, which is the whole reason it
 * exists.** That slot is "the folder to offer to reopen next visit", and it is overwritten the moment
 * the user picks another folder. A Review Workspace's origin has to outlive exactly that: a reviewer
 * opens a bundle from their folder Workspace, wanders into browser storage and back into a
 * *different* folder, and the copy they then Import must still land in the folder they were in when
 * they opened it. A remembered *name* would not do either — two folders can share one, and a folder
 * deleted and recreated under the same name is a different place holding different work.
 *
 * The reference is opaque and means nothing outside this installation's IndexedDB. `null` where there
 * is no IndexedDB at all, which is a Review that cannot record a folder origin rather than one that
 * records a bad one.
 */
export async function retainWorkspaceFolder(
	folder: FileSystemDirectoryHandle
): Promise<string | null> {
	const database = await openInstallationDatabase();
	if (!database) return null;
	const reference = `${RETAINED_PREFIX}${crypto.randomUUID()}`;
	try {
		await transact(database, 'readwrite', (store) => store.put(folder, reference));
	} finally {
		database.close();
	}
	return reference;
}

/**
 * Ask for a retained folder back, or `null` when this installation no longer holds that grant.
 *
 * **Must be called from a user gesture**, for {@link reopenWorkspaceFolder}'s reason:
 * `requestPermission()` needs transient user activation.
 *
 * A folder that has been deleted — or replaced by another folder of the same name, which is a
 * different entry — is *not* reported here. Permission survives the folder, so this resolves and the
 * first `list` fails, which is where ADR-0008's "Workspace not reachable" belongs and where the
 * Import that asked for it refuses.
 *
 * @throws FolderPermissionDeniedError when the user declines
 */
export async function reopenRetainedWorkspaceFolder(
	reference: string
): Promise<FileSystemAccessProjectStore | null> {
	if (!reference.startsWith(RETAINED_PREFIX)) return null;
	const database = await openInstallationDatabase();
	if (!database) return null;
	let stored: unknown;
	try {
		stored = await transact(database, 'readonly', (store) => store.get(reference));
	} finally {
		database.close();
	}
	if (!(stored instanceof FileSystemDirectoryHandle)) return null;
	return grantWorkspaceFolder(stored);
}

/**
 * Let a retained grant go.
 *
 * Called when the Review Workspace that was holding it is gone, in either of the two ways that
 * happens. A reference nothing holds any more is a handle this installation keeps for a Workspace
 * that no longer exists; the folder itself is untouched, and the user's own grant to it — the one
 * {@link reopenWorkspaceFolder} uses — is a different record and stays where it is.
 */
export async function releaseWorkspaceFolder(reference: string): Promise<void> {
	if (!reference.startsWith(RETAINED_PREFIX)) return;
	const database = await openInstallationDatabase();
	if (!database) return;
	try {
		await transact(database, 'readwrite', (store) => store.delete(reference));
	} finally {
		database.close();
	}
}

const directoryPicker = (): DirectoryPicker | undefined =>
	typeof globalThis === 'undefined'
		? undefined
		: (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;

// The handle is persisted in IndexedDB because it is the only browser storage that will hold one:
// a `FileSystemDirectoryHandle` is serialisable but not stringifiable, so `localStorage` cannot
// (ADR-0001). The database itself is `installation-database.ts`, which the synchronization metadata
// shares.

const FOLDER_KEY = 'folder';

/**
 * What a retained grant's key begins with, so it cannot collide with {@link FOLDER_KEY} and so a
 * reference from somewhere else — a mark somebody hand-edited — is refused rather than looked up.
 */
const RETAINED_PREFIX = 'retained:';

async function rememberFolder(folder: FileSystemDirectoryHandle): Promise<void> {
	remembered = folder;
	const database = await openInstallationDatabase();
	if (!database) return;
	try {
		await transact(database, 'readwrite', (store) => store.put(folder, FOLDER_KEY));
	} finally {
		database.close();
	}
}

/**
 * The remembered handle, held once it has been read.
 *
 * Not a cache for speed — it is a cache for the **transient activation budget**.
 * `requestPermission()` needs a user gesture, and a gesture's activation is transient: it is spent
 * by time as well as by use. `reopenWorkspaceFolder` used to open IndexedDB, wait for a transaction,
 * and *then* ask for permission, putting a disk round trip between the user's click and the one call
 * that needs to be close to it. The handle is already fetched and discarded on load by
 * `rememberedFolderName`, which is safe there because reading IndexedDB prompts for nothing, so
 * keeping it makes the gesture path synchronous up to the permission call for free.
 *
 * `undefined` means "not looked yet"; `null` means "looked, and there is none".
 */
let remembered: FileSystemDirectoryHandle | null | undefined;

async function recallFolder(): Promise<FileSystemDirectoryHandle | null> {
	if (remembered !== undefined) return remembered;
	const database = await openInstallationDatabase();
	if (!database) return null;
	try {
		const stored = await transact(database, 'readonly', (store) => store.get(FOLDER_KEY));
		// A handle is what we put there, but IndexedDB is user-writable storage and a stale entry
		// from a future version of the app must not throw on load.
		remembered = stored instanceof FileSystemDirectoryHandle ? stored : null;
		return remembered;
	} finally {
		database.close();
	}
}

const transact = <T>(
	database: IDBDatabase,
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> => transactInstallationDatabase(database, WORKSPACE_STORE, mode, operation);
