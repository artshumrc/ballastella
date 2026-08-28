// Where the editor's push credential is kept, in a document that has both web storages (ADR-0024).
//
// ⚠ **The claim is about which storage, so it needs a DOM that has the wrong one available.** A lab
// or library machine is the case: the next person to sit down must not be signed in as the last one,
// and the property that makes that true is that the credential lives as long as the tab and no
// longer. `credential-store.test.ts` asserts what `webCredentialStore` does with a storage it is
// handed; nothing there can see which storage the browser build picks, because in Node there is only
// one. Which storage a browser build reaches for is a claim only a browser can settle, so it is
// asserted here rather than assumed.
//
// ⚠ **This is not a component test and it is here for the environment alone.** `browserCredentialStore`
// is `packages/core`'s; what this seam contributes is a `sessionStorage` and a `localStorage` side by
// side.

import { browserCredentialStore } from '@ballastella/core';
import { afterEach, describe, expect, test } from 'vitest';

const TOKEN = 'github_pat_11ABCDE0000abcdefghij';

afterEach(() => {
	sessionStorage.clear();
	localStorage.clear();
});

describe('the credential lasts as long as the tab and no longer', () => {
	test('is written to session storage', () => {
		browserCredentialStore().write(TOKEN);

		expect([...Object.values(sessionStorage)]).toContain(TOKEN);
	});

	// ⚠ **`localStorage` is the failure this exists to catch.** Origin-wide and unbounded by the tab,
	// it would leave a working credential behind for whoever opens the browser next — which is the one
	// thing a shared machine may not do, and a change nobody would notice from the interface.
	test('is written nowhere that outlives the tab', () => {
		browserCredentialStore().write(TOKEN);

		expect(localStorage.length).toBe(0);
	});

	test('is gone from that storage when the sign-in is ended', () => {
		const store = browserCredentialStore();
		store.write(TOKEN);

		store.clear();

		expect(store.read()).toBeNull();
		expect([...Object.values(sessionStorage)]).not.toContain(TOKEN);
	});
});
