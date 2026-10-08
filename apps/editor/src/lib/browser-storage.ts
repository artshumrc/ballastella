import type { CredentialStorage } from '@ballastella/core';

type Area = 'localStorage' | 'sessionStorage';

export function attempt<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch {
		return undefined;
	}
}

export function readItem(area: Area, key: string): string | null {
	return attempt(() => globalThis[area]?.getItem(key)) ?? null;
}

export function writeItem(area: Area, key: string, value: string | null): void {
	attempt(() =>
		value === null ? globalThis[area]?.removeItem(key) : globalThis[area]?.setItem(key, value)
	);
}

export function takeItem(area: Area, key: string): string | null {
	const held = readItem(area, key);
	writeItem(area, key, null);
	return held;
}

export const sessionArea: CredentialStorage = {
	getItem: (key) => readItem('sessionStorage', key),
	setItem: (key, value) => writeItem('sessionStorage', key, value),
	removeItem: (key) => writeItem('sessionStorage', key, null)
};
