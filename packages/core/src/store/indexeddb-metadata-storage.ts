// The browser's implementation of the synchronization metadata seam (ADR-0033).
//
// One database connection per operation rather than one held open for the session, matching what the
// folder grant already does: a connection left open blocks the next version upgrade in another tab,
// and these writes happen at Open and at a Sync rather than on the path of an edit.
//
// Nothing here catches. `SynchronizationMetadata` is the layer that turns a store which will not answer
// into `Cannot tell`, and a second silent catch here would hide the difference between "no record" and
// "no database" from it.

import {
	SYNCHRONIZATION_STORE,
	openInstallationDatabase,
	transactInstallationDatabase
} from './installation-database.js';
import type { MetadataStorage } from '../remote/synchronization-metadata.js';

/**
 * The installation's metadata store, or `null` where the browser has no IndexedDB at all.
 *
 * `null` is a real state rather than a default, exactly as `browserJournalStorage()`'s is: a context
 * with no IndexedDB cannot hold a Remote relationship or a Baseline, and a silent stand-in would let
 * the app claim synchronization evidence it has no way to keep.
 */
export const browserMetadataStorage = (): MetadataStorage | null =>
	typeof indexedDB === 'undefined' ? null : new IndexedDbMetadataStorage();

export class IndexedDbMetadataStorage implements MetadataStorage {
	async get(key: string): Promise<unknown> {
		return this.#run('readonly', (store) => store.get(key));
	}

	async put(key: string, value: unknown): Promise<void> {
		await this.#run('readwrite', (store) => store.put(value, key));
	}

	async delete(key: string): Promise<void> {
		await this.#run('readwrite', (store) => store.delete(key));
	}

	async keys(): Promise<readonly string[]> {
		const keys = await this.#run('readonly', (store) => store.getAllKeys());
		// `getAllKeys` answers `IDBValidKey[]`; everything this module files is a string, and anything
		// else under the store is not a key it wrote.
		return (keys ?? []).filter((key): key is string => typeof key === 'string');
	}

	async #run<T>(
		mode: IDBTransactionMode,
		operation: (store: IDBObjectStore) => IDBRequest<T>
	): Promise<T | undefined> {
		const database = await openInstallationDatabase();
		// No IndexedDB at all — an old browser, or a context with storage switched off. A read answers
		// nothing and a write is a write that did not happen, which is what the layer above reports as
		// `Cannot tell`.
		if (!database)
			throw new Error('This browser has no IndexedDB to keep synchronization metadata in.');
		try {
			return await transactInstallationDatabase(database, SYNCHRONIZATION_STORE, mode, operation);
		} finally {
			database.close();
		}
	}
}
