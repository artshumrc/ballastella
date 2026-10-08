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
