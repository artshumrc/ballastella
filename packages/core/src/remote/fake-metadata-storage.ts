// A durable record store with nothing clever in it, and one that refuses, for the suites that need one.
//
// In source rather than in a test file for the reason `fake-journal-storage.ts` is: the metadata store
// is the seam three things are tested through — the metadata module, migration, and the editor session
// — and a fake copied into each is three things that can drift from the {@link MetadataStorage} they
// all claim to satisfy. The failure injection is here too, because *refusing* is the behaviour half of
// this module's contract is about.

import type { MetadataStorage } from './synchronization-metadata.js';

export class FakeMetadataStorage implements MetadataStorage {
	readonly records = new Map<string, unknown>();

	/** Keys whose write must fail, standing in for a quota or a store the browser has closed. */
	readonly refuseWrites = new Set<string>();
	/** Keys whose read must fail, standing in for Safari with storage blocked. */
	readonly refuseReads = new Set<string>();

	async get(key: string): Promise<unknown> {
		if (this.refuseReads.has(key)) throw new Error(`refusing to read ${key}`);
		return this.records.get(key) ?? null;
	}

	async put(key: string, value: unknown): Promise<void> {
		if (this.refuseWrites.has(key)) throw new Error(`refusing to write ${key}`);
		// Cloned on the way in, as a structured-clone store does: a caller that keeps mutating the map
		// it handed over must not be able to change what was stored.
		this.records.set(key, structuredClone(value));
	}

	async delete(key: string): Promise<void> {
		this.records.delete(key);
	}

	async keys(): Promise<readonly string[]> {
		return [...this.records.keys()];
	}
}
