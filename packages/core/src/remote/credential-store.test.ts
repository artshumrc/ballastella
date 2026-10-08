import { describe, expect, it } from 'vitest';

import {
	credentialStoreContract,
	FakeStorage,
	refusingStorage,
	TOKEN
} from './credential-store-suite.js';
import {
	CREDENTIAL_KEY,
	closedWhileReviewing,
	describeTokenProblem,
	memoryCredentialStore,
	webCredentialStore
} from './credential-store.js';

credentialStoreContract('a store over web storage', async () => {
	const storage = new FakeStorage();
	return { store: webCredentialStore(storage), keys: async () => [...storage.items.keys()] };
});

credentialStoreContract('a store holding nothing but a variable', async () => {
	const store = memoryCredentialStore();
	return { store, keys: async () => (store.read() === null ? [] : [CREDENTIAL_KEY]) };
});

describe('a credential store over web storage', () => {
	it('reads a storage that throws from every property as holding nothing', () => {
		const store = webCredentialStore(refusingStorage());
		expect(store.read()).toBeNull();
		expect(() => store.write(TOKEN)).not.toThrow();
		expect(() => store.clear()).not.toThrow();
	});
});

describe('while a Review Workspace is open the credential store reads and writes nothing', () => {
	it('answers nothing, however good the credential behind it is', () => {
		const inner = memoryCredentialStore();
		inner.write(TOKEN);
		let reviewing = false;
		const store = closedWhileReviewing(() => reviewing, inner);
		expect(store.read()).toBe(TOKEN);
		reviewing = true;
		expect(store.read()).toBeNull();
	});

	it('writes nothing, so a review copy cannot leave a credential behind it', () => {
		const inner = memoryCredentialStore();
		const store = closedWhileReviewing(() => true, inner);

		store.write(TOKEN);

		expect(inner.read()).toBeNull();
	});

	it('clears nothing, so putting a submission down does not sign the teacher out', () => {
		const inner = memoryCredentialStore();
		inner.write(TOKEN);
		const store = closedWhileReviewing(() => true, inner);

		store.clear();

		expect(inner.read()).toBe(TOKEN);
	});
});

describe('a pasted credential that is not one', () => {
	it.each([
		['accepts a fine-grained token', TOKEN],
		['accepts a classic token alike', 'ghp_0123456789abcdefghijklmnopqrstuvwxyz'],
		['accepts a prefix this build has never heard of', 'ghs_0123456789abcdefghijklmnopqrstuvwxyz'],
		['trims what the clipboard brought with it', `  ${TOKEN}\n`]
	])('%s', (_, pasted) => {
		expect(describeTokenProblem(pasted)).toBe('');
	});

	it.each([
		['an empty paste, and says where the token comes from', '   ', /shown once/],
		[
			'one with something else copied along with it',
			'token: ghp_0123456789abcdefghijklmno',
			/space or a line break/
		],
		['a repository address pasted where a token goes', 'ada/atlas', /repository address or a URL/],
		['half a token, and says to paste the whole of it', 'ghp_0123', /too short/]
	])('refuses %s', (_, pasted, said) => {
		expect(describeTokenProblem(pasted)).toMatch(said);
	});
});
