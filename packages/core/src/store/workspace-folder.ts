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
 * nothing about the app changes (ADR-0001, SPEC story 4).
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
 * Reopen the folder from last visit, or `null` if there is none to reopen.
 *
 * **Must be called from a user gesture.** `requestPermission()` needs transient user activation,
 * and called automatically on load it fails silently — leaving an app that appears to have lost
 * the user's folder (ADR-0012). True no-prompt resumption needs Chrome 122+ and works best for an
 * installed PWA, which is the honest answer to "why does it keep asking?" and is ticket 18.
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
 * The name of the folder waiting to be reopened, or `null`.
 *
 * Reads IndexedDB and nothing else — no permission is queried and no prompt can appear — so it is
 * safe on load, and it is what lets the resume affordance name the folder rather than offering a
 * blank "reopen something".
 */
export async function rememberedFolderName(): Promise<string | null> {
	const folder = await recallFolder();
	return folder ? folder.name : null;
}

/**
 * Stop offering to reopen the folder.
 *
 * Called when the user goes back to browser storage. Their choice is honoured next visit rather
 * than second-guessed: continuing to offer a folder they have just moved away from is the nagging
 * ticket 12 rules out. The folder itself is untouched — every Project in it is still there, and
 * choosing it again brings them back.
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

const directoryPicker = (): DirectoryPicker | undefined =>
	typeof globalThis === 'undefined'
		? undefined
		: (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;

// The handle is persisted in IndexedDB because it is the only browser storage that will hold one:
// a `FileSystemDirectoryHandle` is serialisable but not stringifiable, so `localStorage` cannot
// (ADR-0001). The database itself is `installation-database.ts`, which the synchronization metadata
// shares.

const FOLDER_KEY = 'folder';

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
