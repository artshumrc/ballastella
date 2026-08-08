import { describe, expect, it, vi } from 'vitest';

import {
	DEFAULT_WORKSPACE_NAME,
	requestPersistentStorage,
	toWorkspaceName
} from './opfs-workspaces';

// The two halves of `opfs-workspaces.ts` that do not need OPFS: turning a typed name into a
// directory name, and what is made of the browser's answer about persistence. Everything that
// touches the root is in `opfs-workspaces.browser.test.ts`, where there is a real one.

describe('toWorkspaceName', () => {
	it('keeps a name a person would type, rather than slugging it', () => {
		// The bar names the Workspace on every screen (SPEC story 88). A user who typed "Marking 2026"
		// and is shown "marking-2026" has had their work renamed without being asked — and a folder
		// Workspace's name is its folder's name, unaltered, so this is the same rule for both backings.
		expect(toWorkspaceName('Marking 2026')).toBe('Marking 2026');
		expect(toWorkspaceName('  Amsterdam   thesis  ')).toBe('Amsterdam thesis');
		expect(toWorkspaceName('Ünïcode Wörk')).toBe('Ünïcode Wörk');
		expect(toWorkspaceName('Marking 2026 (2)')).toBe('Marking 2026 (2)');
	});

	it('cannot produce a path, an escape, or a name a filesystem refuses', () => {
		// It becomes a directory name in OPFS, so this is the boundary: a `/` or a `..` here is a store
		// rooted somewhere nobody asked for, and the characters Windows refuses are a Workspace that
		// cannot be created at all on the platform where nothing else would have failed.
		for (const typed of ['../escape', 'a/b', 'a\\b', '..', '.', 'x:*?"<>|y', ' trailing ']) {
			const name = toWorkspaceName(typed);
			expect(name, typed).not.toMatch(/[/\\:*?"<>|]/);
			expect(name, typed).not.toBe('.');
			expect(name, typed).not.toBe('..');
			expect(name.trim(), typed).toBe(name);
			expect(name.length, typed).toBeGreaterThan(0);
		}
	});

	it('is idempotent, so the name checked for collisions is the name created', () => {
		// `createOpfsWorkspace` suffixes with ` (2)` and then normalises again. A normaliser that
		// rewrote its own output would answer "free" about one string and create another.
		for (const typed of ['Marking 2026', 'Marking 2026 (2)', '../escape', 'Ünïcode Wörk', '']) {
			expect(toWorkspaceName(toWorkspaceName(typed)), typed).toBe(toWorkspaceName(typed));
		}
	});

	it('gives a name that reduces to nothing the default, rather than refusing to make one', () => {
		expect(toWorkspaceName('')).toBe(DEFAULT_WORKSPACE_NAME);
		expect(toWorkspaceName('///')).toBe(DEFAULT_WORKSPACE_NAME);
	});
});

describe('requestPersistentStorage', () => {
	const storageThat = (answers: {
		persisted: boolean | (() => Promise<boolean>);
		persist: boolean | (() => Promise<boolean>);
	}) => {
		const persisted = vi.fn(
			typeof answers.persisted === 'boolean'
				? async () => answers.persisted as boolean
				: answers.persisted
		);
		const persist = vi.fn(
			typeof answers.persist === 'boolean'
				? async () => answers.persist as boolean
				: answers.persist
		);
		return { manager: { persisted, persist } as unknown as StorageManager, persisted, persist };
	};

	it('does not ask again when the grant is already held', async () => {
		// Firefox's `persist()` opens a permission prompt, so asking on every load of an origin that
		// already has the grant is the nagging ADR-0012 rules out — and a prompt with no user gesture
		// behind it is one that never resolves.
		const storage = storageThat({ persisted: true, persist: false });

		expect(await requestPersistentStorage(storage.manager)).toBe('granted');

		expect(storage.persist).not.toHaveBeenCalled();
	});

	it('asks when the grant is not held, and reports that it was given', async () => {
		const storage = storageThat({ persisted: false, persist: true });

		expect(await requestPersistentStorage(storage.manager)).toBe('granted');

		expect(storage.persist).toHaveBeenCalledTimes(1);
	});

	it('reports a refusal rather than swallowing it', async () => {
		// ADR-0024: without the grant, everything the user has is evictable under disk pressure — and on
		// Firefox, Safari, and iPadOS browser storage is the only Workspace there is. A refusal reported
		// as success is a data-loss risk the one person who could act on it is never told about.
		const storage = storageThat({ persisted: false, persist: false });

		expect(await requestPersistentStorage(storage.manager)).toBe('refused');
	});

	it('says “unsupported” for a browser without the API, which is not a refusal', async () => {
		expect(await requestPersistentStorage(undefined)).toBe('unsupported');
		expect(await requestPersistentStorage({} as StorageManager)).toBe('unsupported');
	});

	it('says “unsupported” when the browser has the methods and throws from them', async () => {
		// Reporting it as a refusal would tell the user their browser declined something it was never
		// actually asked.
		const storage = storageThat({
			persisted: () => Promise.reject(new Error('no')),
			persist: false
		});

		expect(await requestPersistentStorage(storage.manager)).toBe('unsupported');
	});
});
