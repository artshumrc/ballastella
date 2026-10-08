import {
	SYNCHRONIZATION_STORE,
	transactInstallationDatabase,
	withInstallationDatabase
} from './installation-database.js';
import type { MetadataStorage } from '../remote/synchronization-metadata.js';

export function browserMetadataStorage(): MetadataStorage | null {
	if (typeof indexedDB === 'undefined') return null;
	const run = <T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) =>
		withInstallationDatabase((database) =>
			transactInstallationDatabase(database, SYNCHRONIZATION_STORE, mode, operation)
		);
	return {
		get: (key) => run('readonly', (store) => store.get(key)),
		put: async (key, value) => {
			await run('readwrite', (store) => store.put(value, key));
		},
		delete: async (key) => {
			await run('readwrite', (store) => store.delete(key));
		},
		keys: async () =>
			((await run('readonly', (store) => store.getAllKeys())) ?? []).filter(
				(key): key is string => typeof key === 'string'
			)
	};
}
