// CONTRIBUTING.md's Seam 1 for what the browser has promised about keeping the work: a pure
// derivation over injected capability answers, in Node, with no browser and no user-agent string.
//
// Seam 1 and not a browser test on purpose. A real browser produces exactly one of these six — the
// one its engine is — so a test against `navigator` can only assert that *something* came back,
// which is the shape of assertion that still passes when the function has been deleted. What a real
// browser really answers, and that the sentence reaches a screen, is `e2e/editor-pwa`'s.

import { describe, expect, test } from 'vitest';

import {
	deriveStorageDurability,
	readPersistentStoragePermission,
	readStoragePersisted,
	type StorageDurabilityInputs
} from './storage-durability';

/** A browser that has everything and has granted nothing. Each test names only what it varies. */
const answers = (over: Partial<StorageDurabilityInputs> = {}): StorageDurabilityInputs => ({
	persisted: false,
	permission: 'prompt',
	ephemeral: false,
	installed: false,
	fileSystemAccess: true,
	...over
});

describe('deriveStorageDurability', () => {
	test('a persisted origin is granted, and nothing else is asked', () => {
		expect(deriveStorageDurability(answers({ persisted: true }))).toEqual({ kind: 'granted' });
	});

	// Chromium's `permissions.query` answers `granted` for an origin it has persisted, so the two
	// agree; a browser that says so through the permission alone is still granted.
	test('a granted permission is granted', () => {
		expect(deriveStorageDurability(answers({ permission: 'granted' }))).toEqual({
			kind: 'granted'
		});
	});

	// The Chromium grant model: the permission exists, the browser never opens a dialog about it, and
	// an installed domain is granted persistence outright. So the lever is installing.
	test('an un-installed browser with File System Access is told installing is the lever', () => {
		expect(deriveStorageDurability(answers())).toEqual({ kind: 'install-to-keep' });
	});

	// The Firefox model: no File System Access, and the one engine whose `persist()` really asks.
	test('a browser with no File System Access and a prompt to give is asked', () => {
		expect(deriveStorageDurability(answers({ fileSystemAccess: false }))).toEqual({
			kind: 'can-ask'
		});
	});

	// ⚠ The whole point of the state. WebKit does not know the `persistent-storage` permission name,
	// and that absence is not a gap to fill with an optimistic guess: ITP deletes the OPFS store
	// after seven days of browser use without an interaction, and no page-reachable grant stops it.
	test('a browser with no persistent-storage permission at all is the seven-day case', () => {
		expect(deriveStorageDurability(answers({ permission: undefined }))).toEqual({
			kind: 'seven-day'
		});
		// Including where File System Access is absent, which is every WebKit there is.
		expect(
			deriveStorageDurability(answers({ permission: undefined, fileSystemAccess: false }))
		).toEqual({ kind: 'seven-day' });
	});

	// A grant on storage that goes when the window closes is a promise about nothing, so this wins
	// over every other answer the browser gave.
	test('a session that keeps nothing is ephemeral whatever else it answered', () => {
		expect(deriveStorageDurability(answers({ ephemeral: true, persisted: true }))).toEqual({
			kind: 'ephemeral'
		});
		expect(deriveStorageDurability(answers({ ephemeral: true, permission: undefined }))).toEqual({
			kind: 'ephemeral'
		});
	});

	test('a browser whose Storage API cannot answer is unknown', () => {
		expect(deriveStorageDurability(answers({ persisted: undefined }))).toEqual({
			kind: 'unknown'
		});
	});

	// Two ways to arrive with no lever left to name, and neither may be dressed up as one: an
	// installed application that is still not persisted has nothing left to install, and a permission
	// refused for good is a prompt that will not appear again.
	test('an installed application that is still not persisted is unknown, not install-to-keep', () => {
		expect(deriveStorageDurability(answers({ installed: true }))).toEqual({ kind: 'unknown' });
	});

	test('a permission refused for good is unknown, not a prompt to offer again', () => {
		expect(
			deriveStorageDurability(answers({ permission: 'denied', fileSystemAccess: false }))
		).toEqual({ kind: 'unknown' });
	});

	// The advice must not break when a browser changes what it calls itself, so nothing here may
	// consult a name. Asserted over the module's own text because that is the claim: not that this
	// call happened not to read one, but that there is no name to read.
	test('reads no user-agent string', async () => {
		const source = await import('node:fs/promises').then((fs) =>
			fs.readFile(new URL('./storage-durability.ts', import.meta.url), 'utf8')
		);
		expect(source).not.toMatch(/navigator\.userAgent|userAgentData|navigator\.vendor|\bplatform\b/);
	});
});

describe('reading the answers off a browser', () => {
	test('persisted is what the Storage API said, and undefined where it cannot say', async () => {
		expect(await readStoragePersisted({ persisted: async () => true } as StorageManager)).toBe(
			true
		);
		expect(await readStoragePersisted({ persisted: async () => false } as StorageManager)).toBe(
			false
		);
		expect(await readStoragePersisted(undefined)).toBeUndefined();
		expect(await readStoragePersisted({} as StorageManager)).toBeUndefined();
		expect(
			await readStoragePersisted({
				persisted: () => Promise.reject(new Error('no'))
			} as unknown as StorageManager)
		).toBeUndefined();
	});

	// ⚠ **`persist()` is never called by the read.** It is what opens Firefox's prompt, and it does
	// not settle without a user gesture — a durability read behind it would produce no sentence at all
	// on the one browser that asks.
	test('the persisted read never asks for the grant', async () => {
		let asked = 0;
		await readStoragePersisted({
			persisted: async () => false,
			persist: async () => {
				asked += 1;
				return true;
			}
		} as StorageManager);
		expect(asked).toBe(0);
	});

	test('the permission is what the browser said, and undefined where the name is unknown', async () => {
		expect(
			await readPersistentStoragePermission({
				query: async () => ({ state: 'prompt' }) as PermissionStatus
			} as unknown as Permissions)
		).toBe('prompt');
		expect(await readPersistentStoragePermission(undefined)).toBeUndefined();
		// WebKit's answer to a permission name it does not know is a rejection, and that is an answer.
		expect(
			await readPersistentStoragePermission({
				query: () => Promise.reject(new TypeError('unsupported'))
			} as unknown as Permissions)
		).toBeUndefined();
	});
});
