import type { Page } from './test.js';

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
