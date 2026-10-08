import type { JournalStorage } from './journal.js';

export const workspaceScopedKey = (prefix: string, workspace: string, subject: string): string =>
	`${prefix}${encodeURIComponent(workspace)}/${encodeURIComponent(subject)}`;

export function parseWorkspaceScopedKey(
	prefix: string,
	key: string
): { workspace: string; subject: string } | null {
	if (!key.startsWith(prefix)) return null;
	const body = key.slice(prefix.length);
	const cut = body.indexOf('/');
	if (cut === -1) return null;
	try {
		return {
			workspace: decodeURIComponent(body.slice(0, cut)),
			subject: decodeURIComponent(body.slice(cut + 1))
		};
	} catch {
		return null;
	}
}

export function keysWithPrefix(storage: JournalStorage, prefix: string): string[] {
	const keys: string[] = [];
	for (let index = 0; index < storage.length; index += 1) {
		const key = storage.key(index);
		if (key !== null && key.startsWith(prefix)) keys.push(key);
	}
	return keys;
}

export function keysNamed<T extends { workspace: string }>(
	storage: JournalStorage,
	prefix: string,
	parse: (key: string) => T | null
): (T & { key: string })[] {
	const found: (T & { key: string })[] = [];
	for (const key of keysWithPrefix(storage, prefix)) {
		const named = parse(key);
		if (named !== null) found.push({ ...named, key });
	}
	return found;
}

export const workspaceNames = (named: readonly { workspace: string }[]): string[] =>
	[...new Set(named.map(({ workspace }) => workspace))].sort((a, b) => a.localeCompare(b));

export function removeQuietly(storage: JournalStorage, key: string): boolean {
	try {
		storage.removeItem(key);
		return true;
	} catch {
		return false;
	}
}

export const removeAll = (storage: JournalStorage, named: readonly { key: string }[]): number =>
	named.filter(({ key }) => removeQuietly(storage, key)).length;
