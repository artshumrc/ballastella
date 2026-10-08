import { FileSystemAccessProjectStore } from './directory-handle-store.js';
import {
	WORKSPACE_STORE,
	transactInstallationDatabase,
	withInstallationDatabase
} from './installation-database.js';
import { isRecord } from './project-store.js';
import { rekeyWorkspaceRecords, type WorkspaceRecordStores } from './rekey-workspace-records.js';

// `showDirectoryPicker` and the handle permission methods are not in TypeScript's DOM library.
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

const READWRITE = { mode: 'readwrite' } as const;
const PICKER_ID = 'ballastella-workspace';
const FOLDER_KEY = 'folder';
const RETAINED_PREFIX = 'retained:';
const FOLDER_WORKSPACE_PREFIX = 'workspace:';

export class FolderPermissionDeniedError extends Error {
	override readonly name = 'FolderPermissionDeniedError';
	constructor(folderName: string) {
		super(
			`Ballastella was not given permission to read and write the folder “${folderName}”. ` +
				'Your work has not been moved or lost.'
		);
	}
}

const directoryPicker = (): DirectoryPicker | undefined =>
	(globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;

const transact = <T>(
	database: IDBDatabase,
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> => transactInstallationDatabase(database, WORKSPACE_STORE, mode, operation);

const onWorkspaceStore = <T>(
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> => withInstallationDatabase((database) => transact(database, mode, operation));

export function isFolderWorkspaceSupported(): boolean {
	return typeof directoryPicker() === 'function';
}

/** Needs transient user activation, so it must be called from a click or a keypress. */
export async function chooseWorkspaceFolder(): Promise<FileSystemAccessProjectStore | null> {
	const picker = directoryPicker();
	if (!picker) throw new Error('This browser cannot put a Workspace in a folder.');
	let folder: FileSystemDirectoryHandle;
	try {
		folder = await picker({ id: PICKER_ID, mode: 'readwrite' });
	} catch (cause) {
		if (cause instanceof DOMException && cause.name === 'AbortError') return null;
		throw cause;
	}
	const granted = await grantWorkspaceFolder(folder);
	remembered = folder;
	await onWorkspaceStore('readwrite', (store) => store.put(folder, FOLDER_KEY));
	return granted;
}

/** Must be called from a user gesture: `requestPermission()` needs transient user activation. */
export async function reopenWorkspaceFolder(): Promise<FileSystemAccessProjectStore | null> {
	const folder = await rememberedWorkspaceFolder();
	return folder && grantWorkspaceFolder(folder);
}

export async function forgetWorkspaceFolder(): Promise<void> {
	remembered = null;
	await onWorkspaceStore('readwrite', (store) => store.delete(FOLDER_KEY));
}

export async function grantWorkspaceFolder(
	folder: FileSystemDirectoryHandle
): Promise<FileSystemAccessProjectStore> {
	const handle: PermissionCapableHandle = folder;
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

// Cached to spend the transient activation budget on the permission prompt, not on IndexedDB.
let remembered: FileSystemDirectoryHandle | null | undefined;

export async function rememberedWorkspaceFolder(): Promise<FileSystemDirectoryHandle | null> {
	if (remembered !== undefined) return remembered;
	const stored = await onWorkspaceStore('readonly', (store) => store.get(FOLDER_KEY));
	if (stored === null) return null;
	remembered = stored instanceof FileSystemDirectoryHandle ? stored : null;
	return remembered;
}

export async function retainWorkspaceFolder(
	folder: FileSystemDirectoryHandle
): Promise<string | null> {
	const reference = `${RETAINED_PREFIX}${crypto.randomUUID()}`;
	return withInstallationDatabase(async (database) => {
		await transact(database, 'readwrite', (store) => store.put(folder, reference));
		return reference;
	});
}

export async function reopenRetainedWorkspaceFolder(
	reference: string
): Promise<FileSystemAccessProjectStore | null> {
	if (!reference.startsWith(RETAINED_PREFIX)) return null;
	const stored = await onWorkspaceStore('readonly', (store) => store.get(reference));
	return stored instanceof FileSystemDirectoryHandle ? grantWorkspaceFolder(stored) : null;
}

export async function releaseWorkspaceFolder(reference: string): Promise<void> {
	if (!reference.startsWith(RETAINED_PREFIX)) return;
	await onWorkspaceStore('readwrite', (store) => store.delete(reference));
}

export interface FolderWorkspaceRecord {
	readonly reference: string;
	readonly label: string;
	readonly folderName: string;
}

interface StoredFolderWorkspace extends FolderWorkspaceRecord {
	readonly folder: FileSystemDirectoryHandle;
}

export async function listFolderWorkspaces(): Promise<readonly FolderWorkspaceRecord[]> {
	const listed = await withInstallationDatabase((database) =>
		storedWorkspaces(database).then(
			(stored) => stored.map(publicRecord),
			() => []
		)
	);
	return listed ?? [];
}

export function resolveFolderWorkspace(
	folder: FileSystemDirectoryHandle
): Promise<FolderWorkspaceRecord | null> {
	return settle(folder, async (database, record) =>
		(await keep(database, record, folder)) ? record : null
	);
}

export async function migratePreExistingFolderWorkspace(
	options: WorkspaceRecordStores & { readonly workspaceKey: (folderKey: string) => string }
): Promise<FolderWorkspaceRecord | null> {
	const folder = await rememberedWorkspaceFolder();
	if (folder === null) return null;
	return settle(folder, async (database, record) => {
		const moved = await rekeyWorkspaceRecords({
			from: options.workspaceKey(record.folderName),
			to: options.workspaceKey(record.reference),
			journalStorage: options.journalStorage,
			metadataStorage: options.metadataStorage,
			commit: () => keep(database, record, folder)
		});
		return moved ? record : null;
	});
}

/** Must be called from a user gesture: `requestPermission()` needs transient user activation. */
export async function openFolderWorkspace(
	reference: string
): Promise<FileSystemAccessProjectStore | null> {
	if (!reference.startsWith(FOLDER_WORKSPACE_PREFIX)) return null;
	const folder = await withInstallationDatabase((database) =>
		held(database, reference).then(
			(stored) => stored?.folder ?? null,
			() => null
		)
	);
	return folder && grantWorkspaceFolder(folder);
}

export async function renameFolderWorkspace(reference: string, label: string): Promise<boolean> {
	const renamed = await withInstallationDatabase(async (database) => {
		try {
			const stored = await held(database, reference);
			if (stored === null) return false;
			await write(database, { ...stored, label });
			return true;
		} catch {
			return false;
		}
	});
	return renamed ?? false;
}

export async function forgetFolderWorkspace(reference: string): Promise<void> {
	if (!reference.startsWith(FOLDER_WORKSPACE_PREFIX)) return;
	await withInstallationDatabase((database) =>
		transact(database, 'readwrite', (store) => store.delete(reference)).catch(() => undefined)
	);
}

async function settle(
	folder: FileSystemDirectoryHandle,
	adopt: (
		database: IDBDatabase,
		record: FolderWorkspaceRecord
	) => Promise<FolderWorkspaceRecord | null>
): Promise<FolderWorkspaceRecord | null> {
	return withInstallationDatabase(async (database) => {
		try {
			for (const stored of await storedWorkspaces(database)) {
				if (await stored.folder.isSameEntry(folder).catch(() => false)) {
					return renameIfMoved(database, stored, folder);
				}
			}
			return await adopt(database, {
				reference: `${FOLDER_WORKSPACE_PREFIX}${crypto.randomUUID()}`,
				label: folder.name,
				folderName: folder.name
			});
		} catch {
			return null;
		}
	});
}

const publicRecord = ({
	reference,
	label,
	folderName
}: StoredFolderWorkspace): FolderWorkspaceRecord => ({
	reference,
	label,
	folderName
});

async function renameIfMoved(
	database: IDBDatabase,
	stored: StoredFolderWorkspace,
	folder: FileSystemDirectoryHandle
): Promise<FolderWorkspaceRecord> {
	if (stored.folderName === folder.name) return publicRecord(stored);
	const renamed = { ...stored, folderName: folder.name };
	await write(database, renamed).catch(() => undefined);
	return publicRecord(renamed);
}

async function keep(
	database: IDBDatabase,
	record: FolderWorkspaceRecord,
	folder: FileSystemDirectoryHandle
): Promise<boolean> {
	return write(database, { ...record, folder }).then(
		() => true,
		() => false
	);
}

const write = (database: IDBDatabase, stored: StoredFolderWorkspace): Promise<IDBValidKey> =>
	transact(database, 'readwrite', (store) => store.put(stored, stored.reference));

async function storedWorkspaces(database: IDBDatabase): Promise<StoredFolderWorkspace[]> {
	const held = await transact<unknown[]>(database, 'readonly', (store) =>
		store.getAll(IDBKeyRange.bound(FOLDER_WORKSPACE_PREFIX, `${FOLDER_WORKSPACE_PREFIX}￿`))
	);
	return (held ?? []).filter(isStoredFolderWorkspace);
}

async function held(
	database: IDBDatabase,
	reference: string
): Promise<StoredFolderWorkspace | null> {
	const stored = await transact<unknown>(database, 'readonly', (store) => store.get(reference));
	return isStoredFolderWorkspace(stored) ? stored : null;
}

function isStoredFolderWorkspace(value: unknown): value is StoredFolderWorkspace {
	if (!isRecord(value)) return false;
	const record = value as Partial<StoredFolderWorkspace>;
	return (
		typeof record.reference === 'string' &&
		record.reference.startsWith(FOLDER_WORKSPACE_PREFIX) &&
		typeof record.label === 'string' &&
		typeof record.folderName === 'string' &&
		record.folder instanceof FileSystemDirectoryHandle
	);
}
