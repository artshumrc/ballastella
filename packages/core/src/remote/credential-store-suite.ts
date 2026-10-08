import { describe, expect, it } from 'vitest';

import {
	CREDENTIAL_KEY,
	closedWhileReviewing,
	type CredentialStorage,
	type CredentialStore
} from './credential-store.js';

export class FakeStorage implements CredentialStorage {
	readonly items = new Map<string, string>();
	getItem = (key: string): string | null => this.items.get(key) ?? null;
	setItem = (key: string, value: string): void => void this.items.set(key, value);
	removeItem = (key: string): void => void this.items.delete(key);
}

const refuse = (): never => {
	throw new DOMException('The operation is insecure.', 'SecurityError');
};

export const refusingStorage = (): CredentialStorage => ({
	getItem: refuse,
	setItem: refuse,
	removeItem: refuse
});

interface CredentialStoreUnderTest {
	readonly store: CredentialStore;
	keys(): Promise<readonly string[]>;
}

export const TOKEN = 'github_pat_11ABCDE0000abcdefghij';
const SECOND = 'github_pat_11ZYXWV9999zyxwvutsrq';

export function credentialStoreContract(
	name: string,
	open: () => Promise<CredentialStoreUnderTest>
): void {
	describe(`${name} keeps the credential store's contract`, () => {
		it('holds nothing until something is put in it', async () => {
			const { store } = await open();

			expect(store.read()).toBeNull();
		});

		it('hands back the credential it was given', async () => {
			const { store } = await open();

			store.write(TOKEN);

			expect(store.read()).toBe(TOKEN);
		});

		it('holds the credential written last, so signing in again replaces rather than adds', async () => {
			const { store } = await open();

			store.write(TOKEN);
			store.write(SECOND);

			expect(store.read()).toBe(SECOND);
		});

		it('forgets it when signed out', async () => {
			const { store } = await open();
			store.write(TOKEN);

			store.clear();

			expect(store.read()).toBeNull();
		});

		it('clears a store that is already empty without complaint', async () => {
			const { store } = await open();

			expect(() => {
				store.clear();
				store.clear();
			}).not.toThrow();
		});

		it('keeps it under one key of its own', async () => {
			const held = await open();

			held.store.write(TOKEN);

			expect(await held.keys()).toEqual([CREDENTIAL_KEY]);
		});

		it('answers nothing through the review seal, and is readable again on the way out', async () => {
			const { store } = await open();
			store.write(TOKEN);
			let reviewing = true;
			const sealed = closedWhileReviewing(() => reviewing, store);
			expect(sealed.read()).toBeNull();
			reviewing = false;
			expect(sealed.read()).toBe(TOKEN);
		});
	});
}
