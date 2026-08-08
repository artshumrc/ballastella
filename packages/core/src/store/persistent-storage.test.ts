import { describe, expect, it, vi } from 'vitest';

import { requestPersistentStorage } from './persistent-storage';

// Whether this origin's storage is evictable (ADR-0024). No OPFS involved and none needed: the
// question is what is made of the browser's three possible answers, and a real browser can be made
// to give only one of them.

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
