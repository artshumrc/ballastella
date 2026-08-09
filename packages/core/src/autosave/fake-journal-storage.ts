// A `localStorage` with nothing clever in it, for the suites that need one.
//
// In source rather than in a test file, and for the same reason `alignment/alignment-fixture.ts` is:
// three suites need it — `replay.test.ts`, `workspace.test.ts` and `deleted-projects.test.ts` — and
// a fake copied into each is three things that can drift from the `JournalStorage` they all claim to
// satisfy. The *awkward* cases live where they belong: a quota that refuses, a storage that throws
// from every property, and a malformed key are `journal.test.ts`'s subject and stay there.

import type { JournalStorage } from './journal.js';

export class FakeJournalStorage implements JournalStorage {
	readonly items = new Map<string, string>();

	get length(): number {
		return this.items.size;
	}

	key(index: number): string | null {
		return [...this.items.keys()][index] ?? null;
	}

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
