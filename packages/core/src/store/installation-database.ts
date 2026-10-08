const DATABASE_NAME = 'ballastella';
const DATABASE_VERSION = 3;
export const WORKSPACE_STORE = 'workspace';
export const SYNCHRONIZATION_STORE = 'synchronization';
export const CREDENTIAL_STORE = 'credential';

async function openInstallationDatabase(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === 'undefined') return null;
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
		request.onupgradeneeded = () => {
			for (const name of [WORKSPACE_STORE, SYNCHRONIZATION_STORE, CREDENTIAL_STORE]) {
				if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'));
		request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
	});
}

export function transactInstallationDatabase<T>(
	database: IDBDatabase,
	storeName: string,
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(storeName, mode);
		const request = operation(transaction.objectStore(storeName));
		transaction.oncomplete = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
		transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB aborted'));
	});
}

export async function withInstallationDatabase<T>(
	use: (database: IDBDatabase) => Promise<T>
): Promise<T | null> {
	const database = await openInstallationDatabase();
	if (!database) return null;
	try {
		return await use(database);
	} finally {
		database.close();
	}
}
