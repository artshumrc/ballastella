// The one IndexedDB this installation keeps: the Workspace folder grant, synchronization metadata,
// and a sign-in the author asked to keep past the tab.
//
// Factored out of `workspace-folder.ts`, which had this plumbing inline for one object store and one
// key. It is the same database rather than a second one deliberately: the Remote relationship, the
// Synchronization Baseline and the local-change index all belong in durable installation-local
// metadata rather than in origin-wide `localStorage`, and a second database would be a second thing
// to open, version and clear on a path where the first already has to be open.
//
// Hand-rolled rather than pulling in a wrapper library, for the reason the folder grant was: a
// handful of object stores, a version bump, and no record migration.

const DATABASE_NAME = 'ballastella';

/**
 * `3` adds {@link CREDENTIAL_STORE}. No version re-encodes anything an earlier one wrote, so each
 * upgrade creates the stores that are missing and leaves every existing record where it is.
 */
const DATABASE_VERSION = 3;

/**
 * The folder handle store, from version 1.
 *
 * Three namespaces share it, told apart by their key: `folder` is the single pre-plural slot a
 * resume is offered from, `retained:<uuid>` is a Review Workspace's hold on the folder it began in
 * (ADR-0037), and `workspace:<uuid>` is a folder Workspace's own record (ADR-0042).
 */
export const WORKSPACE_STORE = 'workspace';

/** Installation-local synchronization records, keyed by the strings `synchronization-metadata.ts` builds. */
export const SYNCHRONIZATION_STORE = 'synchronization';

/**
 * What this installation keeps of a sign-in past the tab, when the author has asked for it.
 *
 * ⚠ **Here rather than in a Workspace, and that is the whole reason it is in IndexedDB at all.**
 * `export-workspace-tar` walks a Workspace into a file the author mails to a colleague and a Publish
 * uploads one to a public repository, so a secret anywhere inside one leaves the machine two ways
 * that look like a favour; `localStorage` holds the write-ahead journal (ADR-0033). This database is
 * installation-local and walked by neither.
 */
export const CREDENTIAL_STORE = 'credential';

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
			for (const name of [WORKSPACE_STORE, SYNCHRONIZATION_STORE, CREDENTIAL_STORE]) {
				if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'));
		// Another tab is holding the database open at an older version. It must not hang forever.
		request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
	});
}

/**
 * One request against one object store, as a promise that rejects on an abort as well as an error.
 *
 * ⚠ **Resolved on the transaction's commit, not on the request's success.** A `put` succeeds long
 * before the transaction commits, and IndexedDB checks quota at commit — so a Baseline written by a
 * browser at its quota would report itself durable and be rolled back a tick later. Everything the
 * caller then does on the strength of it (narrowing the change index, calling the Publish's evidence
 * kept) is done over a record that is not there. A failed write must read as failed, so that Remote
 * Status says `Cannot tell` rather than describing work GitHub has never seen as shared.
 */
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
