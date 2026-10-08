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
