import { describe, expect, it, vi } from 'vitest';

import { requestPersistentStorage } from './persistent-storage';

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
		const storage = storageThat({ persisted: false, persist: false });
		expect(await requestPersistentStorage(storage.manager)).toBe('refused');
	});

	it('says “unsupported” for a browser without the API, which is not a refusal', async () => {
		expect(await requestPersistentStorage(undefined)).toBe('unsupported');
		expect(await requestPersistentStorage({} as StorageManager)).toBe('unsupported');
	});

	it('says “unsupported” when the browser has the methods and throws from them', async () => {
		const storage = storageThat({
			persisted: () => Promise.reject(new Error('no')),
			persist: false
		});

		expect(await requestPersistentStorage(storage.manager)).toBe('unsupported');
	});
});
