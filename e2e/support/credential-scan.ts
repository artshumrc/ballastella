// Where a secret is, read behind the app's back — the assertion **no credential in `localStorage`
// or IndexedDB** is made of (ADR-0033).
//
// ⚠ **One scan, shared, for the reason `github-hosts.ts` is one fake.** A second copy of this under
// the same name appeared in the sign-in suite and enumerated keys without ever comparing a value —
// so it reported the same shape as this one while asserting nothing at all, and the refresh token,
// which outlives the access token it mints, went unchecked. Two scans with one name and different
// strength is the `iiif-hosts` divergence again, one directory along. Extend this; do not fork it.

import type { Page } from './test.js';

/**
 * Everywhere in this browser that holds `secret`, as `label:key` strings, sorted.
 *
 * `export-workspace-tar.ts` walks the `ProjectStore` and hands the result to the user as a file they
 * mail to a colleague; the write-ahead journal copies edits into `localStorage`; a Publish uploads
 * the Workspace. So the one place a credential may be is `sessionStorage`, and a test that only
 * checked "signing in works" would pass just as happily with the token in any of the other three.
 *
 * **IndexedDB is scanned too, because the rule names it** — *no credential in `localStorage` or
 * IndexedDB* — and it is the obvious place a later "remember me" would reach
 * for. `indexedDB.databases()` exists in Chromium, which is the only project these specs run under.
 */
export async function whereverTheTokenIs(page: Page, token: string): Promise<string[]> {
	return page.evaluate(async (secret) => {
		const found: string[] = [];
		const scan = (storage: Storage, label: string) => {
			for (let at = 0; at < storage.length; at += 1) {
				const key = storage.key(at);
				if (key !== null && (storage.getItem(key) ?? '').includes(secret)) {
					found.push(`${label}:${key}`);
				}
			}
		};
		scan(localStorage, 'localStorage');
		scan(sessionStorage, 'sessionStorage');

		const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
			for await (const [name, entry] of handle.entries()) {
				if (entry.kind === 'directory') {
					await walk(entry as FileSystemDirectoryHandle, `${prefix}${name}/`);
					continue;
				}
				const text = await (await (entry as FileSystemFileHandle).getFile()).text();
				if (text.includes(secret)) found.push(`workspace:${prefix}${name}`);
			}
		};
		await walk(await navigator.storage.getDirectory(), '');

		/** Anything a record could hold that a string could hide in. Depth-bounded, not clever. */
		const holds = (value: unknown, depth = 0): boolean => {
			if (typeof value === 'string') return value.includes(secret);
			if (depth > 8 || value === null || typeof value !== 'object') return false;
			if (Array.isArray(value)) return value.some((item) => holds(item, depth + 1));
			return Object.values(value as Record<string, unknown>).some((item) => holds(item, depth + 1));
		};
		const settle = <T>(request: IDBRequest<T>): Promise<T | null> =>
			new Promise((resolve) => {
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => resolve(null);
			});

		for (const { name } of await indexedDB.databases()) {
			if (name === undefined) continue;
			const open = indexedDB.open(name);
			const database = await settle(open as IDBRequest<IDBDatabase>);
			if (database === null) continue;
			for (const store of database.objectStoreNames) {
				const records = await settle(
					database.transaction(store, 'readonly').objectStore(store).getAll()
				);
				// The keys as well as the values: a token used as a key is still a token in IndexedDB.
				const keys = await settle(
					database.transaction(store, 'readonly').objectStore(store).getAllKeys()
				);
				if (holds(records) || holds(keys)) found.push(`indexedDB:${name}/${store}`);
			}
			database.close();
		}

		return found.sort();
	}, token);
}
