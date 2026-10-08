import {
	CREDENTIAL_STORE,
	transactInstallationDatabase,
	withInstallationDatabase
} from '../store/installation-database.js';
import { type CredentialStorage, webCredentialStore } from './credential-store.js';

export const REMEMBER_SIGN_IN_KEY = 'ballastella.remember-github-sign-in';

export interface DurableCredentialStorage extends CredentialStorage {
	settled(): Promise<void>;
}

export function durableCredentialStorage(): DurableCredentialStorage {
	const mirror = new Map<string, string>();
	const decided = new Set<string>();

	const hydrate = () =>
		withInstallationDatabase(async (database) => {
			const keys = await transactInstallationDatabase(database, CREDENTIAL_STORE, 'readonly', (s) =>
				s.getAllKeys()
			);
			const values = await transactInstallationDatabase<unknown[]>(
				database,
				CREDENTIAL_STORE,
				'readonly',
				(s) => s.getAll()
			);
			keys.forEach((key, at) => {
				const value = values[at];
				if (typeof key !== 'string' || typeof value !== 'string') return;
				if (decided.has(key)) return;
				mirror.set(key, value);
			});
		});

	const write = (key: string, value: string | null) =>
		withInstallationDatabase((database) =>
			transactInstallationDatabase(database, CREDENTIAL_STORE, 'readwrite', (store): IDBRequest =>
				value === null ? store.delete(key) : store.put(value, key)
			)
		);

	let chain: Promise<unknown> = hydrate().catch(() => undefined);
	const queue = (key: string, value: string | null): void => {
		decided.add(key);
		chain = chain.then(() => write(key, value)).catch(() => undefined);
	};

	return {
		getItem: (key) => mirror.get(key) ?? null,
		setItem: (key, value) => {
			mirror.set(key, value);
			queue(key, value);
		},
		removeItem: (key) => {
			mirror.delete(key);
			queue(key, null);
		},
		settled: () => chain.then(() => undefined)
	};
}

export const readRememberSignIn = (storage: CredentialStorage): boolean =>
	webCredentialStore(storage, REMEMBER_SIGN_IN_KEY).read() === 'true';

export function writeRememberSignIn(storage: CredentialStorage, remember: boolean): void {
	const preference = webCredentialStore(storage, REMEMBER_SIGN_IN_KEY);
	if (remember) preference.write('true');
	else preference.clear();
}
