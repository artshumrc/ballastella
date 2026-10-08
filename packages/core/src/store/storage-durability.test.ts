import { describe, expect, test } from 'vitest';

import {
	deriveStorageDurability,
	readPersistentStoragePermission,
	readStoragePersisted,
	type StorageDurability,
	type StorageDurabilityInputs
} from './persistent-storage.js';

const answers = (over: Partial<StorageDurabilityInputs> = {}): StorageDurabilityInputs => ({
	persisted: false,
	permission: 'prompt',
	ephemeral: false,
	installed: false,
	fileSystemAccess: true,
	...over
});

describe('deriveStorageDurability', () => {
	test.each<[string, Partial<StorageDurabilityInputs>, StorageDurability['kind']]>([
		['a persisted origin is granted, and nothing else is asked', { persisted: true }, 'granted'],
		['a granted permission is granted', { permission: 'granted' }, 'granted'],
		[
			'an un-installed browser with File System Access is told installing is the lever',
			{},
			'install-to-keep'
		],
		[
			'a browser with no File System Access and a prompt to give is asked',
			{ fileSystemAccess: false },
			'can-ask'
		],
		[
			'a browser with no persistent-storage permission at all is the seven-day case',
			{ permission: undefined },
			'seven-day'
		],
		[
			'the seven-day case holds without File System Access too',
			{ permission: undefined, fileSystemAccess: false },
			'seven-day'
		],
		[
			'a session that keeps nothing is ephemeral whatever else it answered',
			{ ephemeral: true, persisted: true },
			'ephemeral'
		],
		[
			'a session that keeps nothing is ephemeral with no permission to ask',
			{ ephemeral: true, permission: undefined },
			'ephemeral'
		],
		['a browser whose Storage API cannot answer is unknown', { persisted: undefined }, 'unknown'],
		[
			'an installed application that is still not persisted is unknown, not install-to-keep',
			{ installed: true },
			'unknown'
		],
		[
			'a permission refused for good is unknown, not a prompt to offer again',
			{ permission: 'denied', fileSystemAccess: false },
			'unknown'
		]
	])('%s', (_description, over, kind) => {
		expect(deriveStorageDurability(answers(over))).toEqual({ kind });
	});

	test('reads no user-agent string', async () => {
		const source = await import('node:fs/promises').then((fs) =>
			fs.readFile(new URL('./persistent-storage.ts', import.meta.url), 'utf8')
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
		expect(
			await readPersistentStoragePermission({
				query: () => Promise.reject(new TypeError('unsupported'))
			} as unknown as Permissions)
		).toBeUndefined();
	});
});
