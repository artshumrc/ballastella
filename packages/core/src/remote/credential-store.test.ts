import { describe, expect, it } from 'vitest';

import {
	CREDENTIAL_KEY,
	closedWhileReviewing,
	describeTokenProblem,
	memoryCredentialStore,
	webCredentialStore,
	type CredentialStorage
} from './credential-store.js';

const TOKEN = 'github_pat_11ABCDE0000abcdefghij';

/** A web storage with nothing clever in it, on `FakeJournalStorage`'s precedent. */
class FakeStorage implements CredentialStorage {
	readonly items = new Map<string, string>();

	getItem(key: string): string | null {
		return this.items.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.items.set(key, value);
	}

	removeItem(key: string): void {
		this.items.delete(key);
	}
}

/** A web storage that has the object and throws from every property. Safari, cookies blocked. */
const refusingStorage = (): CredentialStorage => ({
	getItem: () => {
		throw new DOMException('The operation is insecure.', 'SecurityError');
	},
	setItem: () => {
		throw new DOMException('The operation is insecure.', 'SecurityError');
	},
	removeItem: () => {
		throw new DOMException('The operation is insecure.', 'SecurityError');
	}
});

describe('a credential store over web storage', () => {
	it('holds a credential, hands it back, and forgets it when signed out', () => {
		const store = webCredentialStore(new FakeStorage());

		expect(store.read()).toBeNull();
		store.write(TOKEN);
		expect(store.read()).toBe(TOKEN);
		store.clear();
		expect(store.read()).toBeNull();
	});

	// The token is in web storage under its own key and **nowhere in the Workspace** (ADR-0033):
	// `export-workspace-tar.ts` walks the store, so a token kept there would be backed up and mailed
	// to a colleague. Asserting the key is asserting where it is *not*.
	it('keeps it under one key of its own', () => {
		const storage = new FakeStorage();

		webCredentialStore(storage).write(TOKEN);

		expect([...storage.items.keys()]).toEqual([CREDENTIAL_KEY]);
	});

	it('reads a storage that throws from every property as holding nothing', () => {
		const store = webCredentialStore(refusingStorage());

		expect(store.read()).toBeNull();
		expect(() => store.write(TOKEN)).not.toThrow();
		expect(() => store.clear()).not.toThrow();
	});

	it('holds one in memory where there is no storage at all', () => {
		const store = memoryCredentialStore();

		store.write(TOKEN);

		expect(store.read()).toBe(TOKEN);
	});
});

// SPEC story 40, ADR-0024. **The rule is on the store rather than on each screen**, because it has
// to hold for code written later that never saw it: a teacher opening a student's submission must
// not be able to reach their own push credential from inside it, by any route.
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

	// The credential is *sealed*, not destroyed: leaving the review copy is what makes "put the
	// submission down and go back to your own work" cost nothing.
	it('is readable again the moment the review copy is left', () => {
		const inner = memoryCredentialStore();
		inner.write(TOKEN);
		let reviewing = true;
		const store = closedWhileReviewing(() => reviewing, inner);

		expect(store.read()).toBeNull();
		reviewing = false;
		expect(store.read()).toBe(TOKEN);
	});
});

describe('a pasted credential that is not one', () => {
	it('accepts a fine-grained token and a classic one alike', () => {
		expect(describeTokenProblem(TOKEN)).toBe('');
		expect(describeTokenProblem('ghp_0123456789abcdefghijklmnopqrstuvwxyz')).toBe('');
	});

	// ⚠ The prefix is deliberately not checked: `gho_`, `ghu_` and ticket 10's broker-exchanged token
	// are all real, and a fence on a list of prefixes refuses tomorrow's valid credential with a
	// message saying it is malformed — the one refusal a user cannot act on.
	it('accepts a prefix this build has never heard of', () => {
		expect(describeTokenProblem('ghs_0123456789abcdefghijklmnopqrstuvwxyz')).toBe('');
	});

	it('trims what the clipboard brought with it', () => {
		expect(describeTokenProblem(`  ${TOKEN}\n`)).toBe('');
	});

	it('refuses an empty paste, and says where the token comes from', () => {
		expect(describeTokenProblem('   ')).toMatch(/shown once/);
	});

	it('refuses one with something else copied along with it', () => {
		expect(describeTokenProblem('token: ghp_0123456789abcdefghijklmno')).toMatch(
			/space or a line break/
		);
	});

	// The sentence deliberately does not name a field to put it in instead: it is shown on the bind
	// screen, which has a repository field, and on the sign-in-again screen, which has not.
	it('refuses a repository address pasted where a token goes', () => {
		expect(describeTokenProblem('ada/atlas')).toMatch(/repository address or a URL/);
	});

	it('refuses half a token, and says to paste the whole of it', () => {
		expect(describeTokenProblem('ghp_0123')).toMatch(/too short/);
	});
});
