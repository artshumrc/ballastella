// A folder Workspace as a durable record with an identity of its own, so there can be more than one
// (ADR-0042).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY A MINTED REFERENCE AND NOT THE FOLDER'S NAME
//
// `handle.name` is the last path segment and nothing more. Two folders called `maps` on two drives
// are one name; a folder deleted and another created in its place is the same name over different
// work; a folder renamed is a different name over the same work. While there could be exactly one
// folder Workspace at a time that was survivable — the collision needed two visits and destroyed
// nothing in between. Plural, it is reachable in a single session, and the five durable record
// families keyed by the Workspace include a Remote binding and a Synchronization Baseline, which
// are bounded by nothing at all.
//
// So the identity is minted here, once, and the folder is recognised again by `isSameEntry` against
// the granted handle — the only question the browser will actually answer about *which place* a
// directory is. The label is the author's own and the directory's name is shown beneath it; neither
// is ever identity.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THREE NAMESPACES IN ONE OBJECT STORE
//
//   `folder`            the single pre-plural slot, still what a resume offers (`workspace-folder.ts`)
//   `retained:<uuid>`   a Review Workspace's hold on the folder it began in (ADR-0037)
//   `workspace:<uuid>`  a folder Workspace's own record — here
//
// They share a store because they are all handles this installation keeps, and they are told apart
// by their key so that a reference from one can never be looked up as another.

import {
	WORKSPACE_STORE,
	openInstallationDatabase,
	transactInstallationDatabase
} from './installation-database.js';
import { rekeyWorkspaceRecords, type WorkspaceRecordStores } from './rekey-workspace-records.js';
import type { FileSystemAccessProjectStore } from './file-system-access-project-store.js';
import { grantWorkspaceFolder, rememberedWorkspaceFolder } from './workspace-folder.js';

/** What this installation knows about one folder Workspace. */
export interface FolderWorkspaceRecord {
	/** Minted once, stable, and the identity. Never derived from the folder's name. */
	readonly reference: string;
	/** The author's own name for this Workspace. */
	readonly label: string;
	/** `handle.name`, for display beneath the label. Never an identity. */
	readonly folderName: string;
}

export interface MigratePreExistingFolderWorkspace extends WorkspaceRecordStores {
	/**
	 * How this installation names a folder Workspace in its durable records — from its reference,
	 * and from its directory's name for the one folder a pre-plural installation could have.
	 *
	 * The caller's, because only the app knows how it spells its own keys.
	 */
	readonly workspaceKey: (folderKey: string) => string;
}

/**
 * Every folder Workspace this installation holds a record for.
 *
 * Empty where there is no IndexedDB, which is a browser that cannot keep a folder Workspace rather
 * than one that has none.
 */
export async function listFolderWorkspaces(): Promise<readonly FolderWorkspaceRecord[]> {
	const database = await openInstallationDatabase();
	if (!database) return [];
	try {
		return (await storedWorkspaces(database)).map(publicRecord);
	} catch {
		// A store that will not be read is not a store with nothing in it, but there is no third
		// answer to give and no caller that could act on one.
		return [];
	} finally {
		database.close();
	}
}

/**
 * The folder Workspace this directory *is*, minting one the first time it is seen.
 *
 * `null` where the record could not be kept — no IndexedDB, or a store that refused — which is a
 * folder Workspace this installation cannot tell apart from another, and the caller's answer to it
 * is to go on keying by the folder's name as the pre-plural build did.
 *
 * A directory that has been renamed since is still the same Workspace: the record's `folderName`
 * follows it, and {@link FolderWorkspaceRecord.label} does not.
 */
export async function resolveFolderWorkspace(
	folder: FileSystemDirectoryHandle
): Promise<FolderWorkspaceRecord | null> {
	const database = await openInstallationDatabase();
	if (!database) return null;
	try {
		const found = await matching(database, folder);
		if (found !== null) return renameIfMoved(database, found, folder);
		const record = mint(folder);
		return (await keep(database, record, folder)) ? record : null;
	} catch {
		return null;
	} finally {
		database.close();
	}
}

/**
 * Give the one folder a pre-plural installation could have a reference, and move its records onto it.
 *
 * ⚠ **Run before any folder is picked in this session.** The trigger is the folder in the single
 * slot rather than a folder the user has just chosen, because a folder that merely shares a name
 * with the remembered one holds different work — and inheriting the remembered folder's Remote
 * binding would aim an author's next Publish at a repository they have never seen.
 *
 * Once, structurally: a folder with a record is found by {@link resolveFolderWorkspace}'s own
 * matching and there is nothing left to move. `null` is a slot with no folder in it, a browser with
 * no IndexedDB, or a move that could not finish — and the last of those leaves every old record
 * exactly where it was, so the next visit tries again.
 */
export async function migratePreExistingFolderWorkspace(
	options: MigratePreExistingFolderWorkspace
): Promise<FolderWorkspaceRecord | null> {
	const folder = await rememberedWorkspaceFolder();
	if (folder === null) return null;
	const database = await openInstallationDatabase();
	if (!database) return null;
	try {
		const found = await matching(database, folder);
		if (found !== null) return renameIfMoved(database, found, folder);
		const record = mint(folder);
		const moved = await rekeyWorkspaceRecords({
			from: options.workspaceKey(record.folderName),
			to: options.workspaceKey(record.reference),
			journalStorage: options.journalStorage,
			metadataStorage: options.metadataStorage,
			commit: () => keep(database, record, folder)
		});
		return moved ? record : null;
	} catch {
		return null;
	} finally {
		database.close();
	}
}

/** What a folder Workspace's key begins with, so it cannot be read as any other kind of entry. */
const FOLDER_WORKSPACE_PREFIX = 'workspace:';

/**
 * The record as it is kept: the three fields, and the grant that says which directory they are about.
 *
 * The handle is inside the record rather than in an entry of its own because there is no moment at
 * which one is meaningful without the other, and two entries would be two things to keep in step.
 */
interface StoredFolderWorkspace extends FolderWorkspaceRecord {
	readonly folder: FileSystemDirectoryHandle;
}

const publicRecord = (stored: StoredFolderWorkspace): FolderWorkspaceRecord => ({
	reference: stored.reference,
	label: stored.label,
	folderName: stored.folderName
});

const mint = (folder: FileSystemDirectoryHandle): FolderWorkspaceRecord => ({
	reference: `${FOLDER_WORKSPACE_PREFIX}${crypto.randomUUID()}`,
	// The folder's name is the only name there is until an author gives it another, and a Workspace
	// with no name at all would be a row nobody could read.
	label: folder.name,
	folderName: folder.name
});

/** The record for this directory, by grant rather than by name, or `null` for a folder never seen. */
async function matching(
	database: IDBDatabase,
	folder: FileSystemDirectoryHandle
): Promise<StoredFolderWorkspace | null> {
	for (const stored of await storedWorkspaces(database)) {
		// A handle whose directory has been deleted still answers this, and answers `false` for every
		// other directory — which is what makes it identity where a name is not.
		if (await stored.folder.isSameEntry(folder).catch(() => false)) return stored;
	}
	return null;
}

/** Follow a directory that has been renamed, keeping the name its author gave the Workspace. */
async function renameIfMoved(
	database: IDBDatabase,
	stored: StoredFolderWorkspace,
	folder: FileSystemDirectoryHandle
): Promise<FolderWorkspaceRecord> {
	if (stored.folderName === folder.name) return publicRecord(stored);
	const renamed = { ...stored, folderName: folder.name };
	// Best effort: the name beneath the label being a visit out of date is worth nothing beside
	// refusing to open the Workspace over it.
	await write(database, renamed).catch(() => undefined);
	return publicRecord(renamed);
}

/** Write the record, answering whether it stuck rather than throwing. */
async function keep(
	database: IDBDatabase,
	record: FolderWorkspaceRecord,
	folder: FileSystemDirectoryHandle
): Promise<boolean> {
	try {
		await write(database, { ...record, folder });
		return true;
	} catch {
		return false;
	}
}

const write = (database: IDBDatabase, stored: StoredFolderWorkspace): Promise<IDBValidKey> =>
	transactInstallationDatabase(database, WORKSPACE_STORE, 'readwrite', (store) =>
		store.put(stored, stored.reference)
	);

async function storedWorkspaces(database: IDBDatabase): Promise<StoredFolderWorkspace[]> {
	const held = await transactInstallationDatabase<unknown[]>(
		database,
		WORKSPACE_STORE,
		'readonly',
		(store) =>
			store.getAll(
				// Every key under the prefix and nothing else, so the single slot and the retained grants
				// beside it are never read as folder Workspaces.
				IDBKeyRange.bound(FOLDER_WORKSPACE_PREFIX, `${FOLDER_WORKSPACE_PREFIX}\uffff`)
			)
	);
	return (held ?? []).filter(isStoredFolderWorkspace);
}

/**
 * IndexedDB is storage a user can edit and a future build will write, so what comes out is checked
 * rather than asserted. An entry this build has no rules for is one to skip, never one to open a
 * Workspace from.
 */
function isStoredFolderWorkspace(value: unknown): value is StoredFolderWorkspace {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Partial<StoredFolderWorkspace>;
	return (
		typeof record.reference === 'string' &&
		record.reference.startsWith(FOLDER_WORKSPACE_PREFIX) &&
		typeof record.label === 'string' &&
		typeof record.folderName === 'string' &&
		record.folder instanceof FileSystemDirectoryHandle
	);
}

/**
 * Ask for a listed folder Workspace's directory back, or `null` where this installation no longer
 * holds a record for it.
 *
 * **Must be called from a user gesture**, because `requestPermission()` needs transient user
 * activation and a browser grants a directory only when the user asks (ADR-0012). One press is the
 * whole cost of opening a folder Workspace from its row.
 *
 * A folder that has been deleted or unplugged is *not* reported here: permission survives the
 * folder, so this resolves and the first `list` fails, which is where ADR-0008's "Workspace not
 * reachable" belongs.
 *
 * @throws FolderPermissionDeniedError when the user declines
 */
export async function openFolderWorkspace(
	reference: string
): Promise<FileSystemAccessProjectStore | null> {
	const folder = await heldFolder(reference);
	return folder === null ? null : grantWorkspaceFolder(folder);
}

/**
 * Give a folder Workspace the name its author wants it listed under.
 *
 * The directory is untouched, exactly as renaming a Project leaves its directory alone: identity is
 * the minted reference, never a name, so two folder Workspaces may share a label and renaming can
 * never collide or move files under a sync client's feet.
 *
 * Answers whether it stuck. `false` is a browser with no IndexedDB or a store that refused, which is
 * a rename the caller has to be able to report rather than one to claim silently.
 */
export async function renameFolderWorkspace(reference: string, label: string): Promise<boolean> {
	const database = await openInstallationDatabase();
	if (!database) return false;
	try {
		const stored = await held(database, reference);
		if (stored === null) return false;
		await write(database, { ...stored, label });
		return true;
	} catch {
		return false;
	} finally {
		database.close();
	}
}

/**
 * Stop listing a folder Workspace, letting its grant go.
 *
 * ⚠ **The folder and every byte in it are untouched, and that is the whole difference between this
 * and deleting a browser Workspace.** These are the author's own files, in a place they chose, which
 * this application has no business removing and — without a grant it would have to ask for first —
 * no way to remove either. What goes is this installation's record of the folder: the row, and the
 * hold on the directory that made the row openable. Choosing the folder again brings it back, under
 * a fresh reference.
 */
export async function forgetFolderWorkspace(reference: string): Promise<void> {
	if (!reference.startsWith(FOLDER_WORKSPACE_PREFIX)) return;
	const database = await openInstallationDatabase();
	if (!database) return;
	try {
		await transactInstallationDatabase(database, WORKSPACE_STORE, 'readwrite', (store) =>
			store.delete(reference)
		);
	} catch {
		// A record that will not be deleted is a row that comes back next visit, which is a better
		// failure than refusing the gesture: nothing has been lost and the press can be repeated.
	} finally {
		database.close();
	}
}

/** The directory a listed folder Workspace is about, or `null` for a reference with no record. */
async function heldFolder(reference: string): Promise<FileSystemDirectoryHandle | null> {
	if (!reference.startsWith(FOLDER_WORKSPACE_PREFIX)) return null;
	const database = await openInstallationDatabase();
	if (!database) return null;
	try {
		return (await held(database, reference))?.folder ?? null;
	} catch {
		return null;
	} finally {
		database.close();
	}
}

/** One record by its reference, checked on the way out for the reason {@link storedWorkspaces} is. */
async function held(
	database: IDBDatabase,
	reference: string
): Promise<StoredFolderWorkspace | null> {
	const stored = await transactInstallationDatabase<unknown>(
		database,
		WORKSPACE_STORE,
		'readonly',
		(store) => store.get(reference)
	);
	return isStoredFolderWorkspace(stored) ? stored : null;
}
