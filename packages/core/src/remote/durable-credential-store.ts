// The second implementation behind `CredentialStore`: one that outlives the tab, on this machine
// only, and only because the author asked (ADR-0041).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE RULE NARROWS; IT DOES NOT FALL
//
// *Forgotten when the tab closes* becomes *forgotten when the tab closes unless the author has
// asked otherwise on this machine*. The beneficiary of the original — a scholar on a shared or lab
// machine — keeps the old behaviour untouched, because the preference is unticked until somebody
// ticks it and is installation-local rather than per-Workspace.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE INSTALLATION DATABASE AND NOWHERE ELSE
//
// `export-workspace-tar` walks a Workspace into a file the author mails to a colleague, and a
// a send uploads one to a public repository — so a secret anywhere inside a Workspace leaves the
// machine two ways that both look like a favour. `localStorage` holds the write-ahead journal. What
// is left is the installation-local IndexedDB, which neither of those two walks (ADR-0033).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THERE IS A MIRROR, AND WHY THE READ IS STILL SYNCHRONOUS
//
// `CredentialStore.read` answers a string, now, and making it a promise would be a change to the
// interface every screen above it is written against — the one thing this swap was supposed not to
// cost. IndexedDB is asynchronous, so the records are read once into a `Map` and every read after
// that is answered from it. A read before the database has answered reports *no credential held*,
// which is a sign-in prompt rather than a wrong answer, and {@link DurableCredentialStorage.settled}
// is how a caller that must not race the hydration waits for it.

import {
	CREDENTIAL_STORE,
	openInstallationDatabase,
	transactInstallationDatabase
} from '../store/installation-database.js';
import type { CredentialStorage } from './credential-store.js';

/** Where the author's answer to "keep me signed in on this machine" is kept. */
export const REMEMBER_SIGN_IN_KEY = 'ballastella.remember-github-sign-in';

/** A storage over the installation database, with the one extra thing an asynchronous backing needs. */
export interface DurableCredentialStorage extends CredentialStorage {
	/**
	 * Resolves once the database has been read and every write made since has committed.
	 *
	 * ⚠ **The writes are one chain, not a race.** A `setItem` followed by a `removeItem` that landed
	 * in the other order would leave a credential behind a sign-out, so each is queued after the last
	 * and after the hydration; this is the end of that queue. It is what a startup path awaits before
	 * concluding that nothing was remembered.
	 */
	settled(): Promise<void>;
}

/**
 * Open the durable storage: synchronous to construct, and answering from the database once it has.
 *
 * Every operation is best-effort in the direction the rest of this module falls: a database that
 * will not open, will not read, or will not write degrades to *nothing remembered*, which costs a
 * sign-in rather than the tab.
 */
export function durableCredentialStorage(): DurableCredentialStorage {
	const mirror = new Map<string, string>();
	// Keys the caller has already decided about. The hydration must not overwrite a write that
	// happened while it was still in flight, nor put back a key that was removed in the same window.
	const decided = new Set<string>();

	const hydrate = async (): Promise<void> => {
		const database = await openInstallationDatabase();
		if (database === null) return;
		try {
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
		} finally {
			database.close();
		}
	};

	const write = async (key: string, value: string | null): Promise<void> => {
		const database = await openInstallationDatabase();
		if (database === null) return;
		try {
			// The two branches are spelled apart rather than as one ternary, which types as a union of
			// two `IDBRequest`s that no single call signature accepts.
			if (value === null) {
				await transactInstallationDatabase(database, CREDENTIAL_STORE, 'readwrite', (store) =>
					store.delete(key)
				);
			} else {
				await transactInstallationDatabase(database, CREDENTIAL_STORE, 'readwrite', (store) =>
					store.put(value, key)
				);
			}
		} finally {
			database.close();
		}
	};

	let chain = hydrate().catch(() => undefined);
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
		settled: () => chain
	};
}

/** Whether the author has asked for their sign-in to be kept past this tab. Unticked by default. */
export function readRememberSignIn(storage: CredentialStorage): boolean {
	try {
		return storage.getItem(REMEMBER_SIGN_IN_KEY) === 'true';
	} catch {
		return false;
	}
}

/** Record the author's answer, or take it away again so the default is what is read next time. */
export function writeRememberSignIn(storage: CredentialStorage, remember: boolean): void {
	try {
		if (remember) storage.setItem(REMEMBER_SIGN_IN_KEY, 'true');
		else storage.removeItem(REMEMBER_SIGN_IN_KEY);
	} catch {
		// A preference that could not be kept leaves the default in place, which is the safe one.
	}
}
