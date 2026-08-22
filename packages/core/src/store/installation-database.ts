// The one IndexedDB this installation keeps: the Workspace folder grant, and synchronization metadata.
//
// Factored out of `workspace-folder.ts`, which had this plumbing inline for one object store and one
// key. It is the same database rather than a second one deliberately: SPEC keeps the Remote
// relationship, the Synchronization Baseline and the local-change index in "durable installation-local
// metadata ... rather than origin-wide `localStorage`", and a second database would be a second thing
// to open, version and clear on a path where the first already has to be open.
//
// Hand-rolled rather than pulling in a wrapper library, for the reason the folder grant was: two object
// stores, a version bump, and no record migration.

const DATABASE_NAME = 'ballastella';

/**
 * `2` adds {@link SYNCHRONIZATION_STORE}. Nothing in version 1 is re-encoded, so the upgrade creates
 * the missing store and leaves the folder grant where it is.
 */
const DATABASE_VERSION = 2;

/** The folder handle store, from version 1. Its one key is `folder`. */
export const WORKSPACE_STORE = 'workspace';

/** Installation-local synchronization records, keyed by the strings `synchronization-metadata.ts` builds. */
export const SYNCHRONIZATION_STORE = 'synchronization';

/**
 * Open the installation database, or `null` where there is no IndexedDB at all.
 *
 * The caller closes it. Held open across a whole session it would block the next version upgrade in
 * another tab, which is what `onblocked` below reports rather than hangs on.
 */
export async function openInstallationDatabase(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === 'undefined') return null;
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
		request.onupgradeneeded = () => {
			for (const name of [WORKSPACE_STORE, SYNCHRONIZATION_STORE]) {
				if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'));
		// Another tab is holding the database open at an older version. It must not hang forever.
		request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
	});
}

/** One request against one object store, as a promise that rejects on an abort as well as an error. */
export function transactInstallationDatabase<T>(
	database: IDBDatabase,
	storeName: string,
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(storeName, mode);
		const request = operation(transaction.objectStore(storeName));
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
		transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB aborted'));
	});
}
