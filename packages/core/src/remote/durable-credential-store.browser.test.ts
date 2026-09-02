// The durable credential store, against a real IndexedDB.
//
// A browser test because the whole claim is about a database Node does not have: that a credential
// written here is still there after the tab that wrote it has gone, and that nothing about it lands
// anywhere a Backup packs or a send uploads. A Node stub of IndexedDB would only prove the stub
// agrees with the mirror in front of it, which is the very thing this file exists to check.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { credentialStoreContract } from './credential-store-suite.js';
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
	openInstallationDatabase,
	transactInstallationDatabase
} from '../store/installation-database.js';

const TOKEN = 'github_pat_11ABCDE0000abcdefghij';

/** Everything the installation database holds for the credential, read behind the store's back. */
async function storedKeys(): Promise<readonly string[]> {
	const database = await openInstallationDatabase();
	if (database === null) return [];
	try {
		const keys = await transactInstallationDatabase(database, CREDENTIAL_STORE, 'readonly', (s) =>
			s.getAllKeys()
		);
		return keys.map(String).sort();
	} finally {
		database.close();
	}
}

async function emptyTheDatabase(): Promise<void> {
	const database = await openInstallationDatabase();
	if (database === null) return;
	try {
		await transactInstallationDatabase(database, CREDENTIAL_STORE, 'readwrite', (s) => s.clear());
	} finally {
		database.close();
	}
}

beforeEach(emptyTheDatabase);
afterEach(async () => {
	localStorage.clear();
	sessionStorage.clear();
	await emptyTheDatabase();
});

// ⚠ **Both implementations, from one suite, in one run.** The property this whole slice rests on is
// that nothing above `CredentialStore` can tell which is underneath — asserted by asking them the
// same questions side by side rather than by saying so in a comment.
credentialStoreContract('a store over session storage', async () => {
	sessionStorage.clear();
	return {
		store: webCredentialStore(sessionStorage),
		keys: async () => Object.keys(sessionStorage).sort()
	};
});

credentialStoreContract('a store over the installation database', async () => {
	const storage = durableCredentialStorage();
	await storage.settled();
	return {
		store: webCredentialStore(storage),
		// Settled first: the write the contract is asking about is queued behind the hydration, and
		// reading the database ahead of it would be asking where the credential is before it is there.
		keys: async () => {
			await storage.settled();
			return storedKeys();
		}
	};
});

describe('a credential kept past the tab', () => {
	// The tab close, as far as this seam can stage one: the storage that wrote the record is thrown
	// away and a second one is opened over the same database, exactly as the next visit would.
	it('is read back by a storage opened after the one that wrote it', async () => {
		const writing = durableCredentialStorage();
		writing.setItem(CREDENTIAL_KEY, TOKEN);
		await writing.settled();

		const reopened = durableCredentialStorage();
		await reopened.settled();

		expect(reopened.getItem(CREDENTIAL_KEY)).toBe(TOKEN);
	});

	it('is gone from the next visit once it has been cleared', async () => {
		const writing = durableCredentialStorage();
		writing.setItem(CREDENTIAL_KEY, TOKEN);
		writing.removeItem(CREDENTIAL_KEY);
		await writing.settled();

		const reopened = durableCredentialStorage();
		await reopened.settled();

		expect(reopened.getItem(CREDENTIAL_KEY)).toBeNull();
		expect(await storedKeys()).toEqual([]);
	});

	// The writes are one chain rather than a race: a sign-out that landed before the sign-in it
	// followed would leave a credential behind it.
	it('lands the last of a burst of writes, whatever order they were queued in', async () => {
		const storage = durableCredentialStorage();

		storage.setItem(CREDENTIAL_KEY, 'first');
		storage.setItem(CREDENTIAL_KEY, 'second');
		storage.setItem(CREDENTIAL_KEY, TOKEN);
		await storage.settled();

		const reopened = durableCredentialStorage();
		await reopened.settled();
		expect(reopened.getItem(CREDENTIAL_KEY)).toBe(TOKEN);
	});

	// Reading before the database has answered is *no credential held*, which is a sign-in prompt.
	// A wrong answer here would be a screen claiming a sign-in this tab cannot yet spend.
	it('holds nothing until the database has answered', () => {
		const storage = durableCredentialStorage();

		expect(storage.getItem(CREDENTIAL_KEY)).toBeNull();
	});

	// ADR-0033. `localStorage` holds the write-ahead journal, so a secret there is copied into every
	// edit's rescue record; this is the Seam 1 form of the assertion the browser suite makes of the
	// whole app.
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
	// The default is the shared-machine one, and it stays the default until an author
	// says otherwise on this machine.
	it('is unticked on an installation that has never been asked', async () => {
		const storage = durableCredentialStorage();
		await storage.settled();

		expect(readRememberSignIn(storage)).toBe(false);
		expect(await storedKeys()).toEqual([]);
	});

	it('survives the tab it was ticked in, and unticking takes it away again', async () => {
		const ticking = durableCredentialStorage();
		writeRememberSignIn(ticking, true);
		await ticking.settled();

		const reopened = durableCredentialStorage();
		await reopened.settled();
		expect(readRememberSignIn(reopened)).toBe(true);

		writeRememberSignIn(reopened, false);
		await reopened.settled();
		const again = durableCredentialStorage();
		await again.settled();
		expect(readRememberSignIn(again)).toBe(false);
	});
});

describe('the remembered half of a sign-in, in the database it is kept in', () => {
	it('survives the tab, carrying the refresh token and not the access token', async () => {
		const writing = durableCredentialStorage();
		writeRememberedGrant(writing, {
			token: 'ghu_publishes',
			expiresAt: 42,
			refreshToken: 'ghr_renews'
		});
		await writing.settled();

		const reopened = durableCredentialStorage();
		await reopened.settled();

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
