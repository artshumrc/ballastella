// The contract every credential store keeps, run against each implementation rather than described
// once and asserted about one of them.
//
// `sessionStorage` was the first implementation and the header of `credential-store.ts` said so;
// the durable one over the installation database is the second, and the property that makes the swap
// cheap — that nothing above {@link CredentialStore} can tell which is underneath — is only true if
// both answer the same questions the same way. So the questions live here and each implementation
// brings its own opening.
//
// The review seal is part of the contract rather than a test of the wrapper: ADR-0024's containment
// has to hold whichever store is inside it, and a durable one is exactly where it would stop holding
// unnoticed.

import { describe, expect, it } from 'vitest';

import { CREDENTIAL_KEY, closedWhileReviewing, type CredentialStore } from './credential-store.js';

/** A store to put through the contract, and a way to ask it what it wrote down. */
export interface CredentialStoreUnderTest {
	readonly store: CredentialStore;
	/** Every key this implementation has written, so *where it is not* can be asserted. */
	keys(): Promise<readonly string[]>;
}

const TOKEN = 'github_pat_11ABCDE0000abcdefghij';
const SECOND = 'github_pat_11ZYXWV9999zyxwvutsrq';

/**
 * Every question a credential store has to answer, asked of one implementation.
 *
 * @param name how the implementation is named in the test output
 * @param open a store with nothing in it, opened fresh for each test
 */
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

		// Asserting the key is asserting where the credential is *not*: one slot of its own, and
		// nothing scattered through the storage beside it (ADR-0033).
		it('keeps it under one key of its own', async () => {
			const held = await open();

			held.store.write(TOKEN);

			expect(await held.keys()).toEqual([CREDENTIAL_KEY]);
		});

		// ADR-0024. The seal is over the interface, so it has to hold for an implementation written
		// after it — which is the whole reason it is asked here rather than of one store.
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
