import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { credentialStoreContract, TOKEN } from './credential-store-suite.js';
import { CREDENTIAL_KEY, webCredentialStore } from './credential-store.js';
import {
	REMEMBER_SIGN_IN_KEY,
	durableCredentialStorage,
	readRememberSignIn,
	writeRememberSignIn
} from './durable-credential-store.js';
import {
	REMEMBERED_GRANT_KEY,
	readRememberedGrant,
	writeRememberedGrant
} from './github-sign-in.js';
import {
	CREDENTIAL_STORE,
	transactInstallationDatabase,
	withInstallationDatabase
} from '../store/installation-database.js';

const storedKeys = async (): Promise<readonly string[]> =>
	(
		(await withInstallationDatabase((database) =>
			transactInstallationDatabase(database, CREDENTIAL_STORE, 'readonly', (s) => s.getAllKeys())
		)) ?? []
	)
		.map(String)
		.sort();

const emptyTheDatabase = () =>
	withInstallationDatabase((database) =>
		transactInstallationDatabase(database, CREDENTIAL_STORE, 'readwrite', (s) => s.clear())
	);

const reopen = async () => {
	const storage = durableCredentialStorage();
	await storage.settled();
	return storage;
};

const reopenedAfter = async (
	write: (storage: ReturnType<typeof durableCredentialStorage>) => void
) => {
	const writing = durableCredentialStorage();
	write(writing);
	await writing.settled();
	return reopen();
};

beforeEach(emptyTheDatabase);
afterEach(async () => {
	localStorage.clear();
	sessionStorage.clear();
	await emptyTheDatabase();
});

credentialStoreContract('a store over session storage', async () => {
	sessionStorage.clear();
	return {
		store: webCredentialStore(sessionStorage),
		keys: async () => Object.keys(sessionStorage).sort()
	};
});

credentialStoreContract('a store over the installation database', async () => {
	const storage = await reopen();
	return {
		store: webCredentialStore(storage),
		// The contract's write is queued behind hydration.
		keys: async () => {
			await storage.settled();
			return storedKeys();
		}
	};
});

describe('a credential kept past the tab', () => {
	it('is read back by a storage opened after the one that wrote it', async () => {
		const reopened = await reopenedAfter((writing) => writing.setItem(CREDENTIAL_KEY, TOKEN));
		expect(reopened.getItem(CREDENTIAL_KEY)).toBe(TOKEN);
	});

	it('is gone from the next visit once it has been cleared', async () => {
		const reopened = await reopenedAfter((writing) => {
			writing.setItem(CREDENTIAL_KEY, TOKEN);
			writing.removeItem(CREDENTIAL_KEY);
		});
		expect(reopened.getItem(CREDENTIAL_KEY)).toBeNull();
		expect(await storedKeys()).toEqual([]);
	});

	it('lands the last of a burst of writes, whatever order they were queued in', async () => {
		const reopened = await reopenedAfter((storage) => {
			storage.setItem(CREDENTIAL_KEY, 'first');
			storage.setItem(CREDENTIAL_KEY, 'second');
			storage.setItem(CREDENTIAL_KEY, TOKEN);
		});
		expect(reopened.getItem(CREDENTIAL_KEY)).toBe(TOKEN);
	});

	it('holds nothing until the database has answered', () => {
		const storage = durableCredentialStorage();
		expect(storage.getItem(CREDENTIAL_KEY)).toBeNull();
	});

	it('puts no part of itself in localStorage', async () => {
		const storage = durableCredentialStorage();
		writeRememberedGrant(storage, { token: TOKEN, expiresAt: 42, refreshToken: 'ghr_renews' });
		storage.setItem(CREDENTIAL_KEY, TOKEN);
		await storage.settled();

		expect(localStorage.length).toBe(0);
		expect(sessionStorage.length).toBe(0);
	});
});

describe('the preference that selects it', () => {
	it('is unticked on an installation that has never been asked', async () => {
		const storage = await reopen();
		expect(readRememberSignIn(storage)).toBe(false);
		expect(await storedKeys()).toEqual([]);
	});

	it('survives the tab it was ticked in, and unticking takes it away again', async () => {
		expect(readRememberSignIn(await reopenedAfter((s) => writeRememberSignIn(s, true)))).toBe(true);
		expect(readRememberSignIn(await reopenedAfter((s) => writeRememberSignIn(s, false)))).toBe(
			false
		);
	});
});

describe('the remembered half of a sign-in, in the database it is kept in', () => {
	it('survives the tab, carrying the refresh token and not the access token', async () => {
		const reopened = await reopenedAfter((writing) =>
			writeRememberedGrant(writing, {
				token: 'ghu_publishes',
				expiresAt: 42,
				refreshToken: 'ghr_renews'
			})
		);
		expect(readRememberedGrant(reopened)).toEqual({ refreshToken: 'ghr_renews', expiresAt: 42 });
		expect(await storedKeys()).toEqual([REMEMBERED_GRANT_KEY]);
		expect(reopened.getItem(REMEMBERED_GRANT_KEY)).not.toContain('ghu_publishes');
	});

	it('shares its database with the preference and nothing else', async () => {
		const storage = durableCredentialStorage();
		writeRememberSignIn(storage, true);
		writeRememberedGrant(storage, { token: 'ghu_1', expiresAt: 1, refreshToken: 'ghr_1' });
		await storage.settled();

		expect(await storedKeys()).toEqual([REMEMBERED_GRANT_KEY, REMEMBER_SIGN_IN_KEY].sort());
	});
});
