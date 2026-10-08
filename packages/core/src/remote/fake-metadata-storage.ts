import type { MetadataStorage } from './synchronization-metadata.js';

export class FakeMetadataStorage implements MetadataStorage {
	readonly records = new Map<string, unknown>();
	readonly refuseWrites = new Set<string>();
	readonly refuseReads = new Set<string>();

	async get(key: string): Promise<unknown> {
		if (this.refuseReads.has(key)) throw new Error(`refusing to read ${key}`);
		return this.records.get(key) ?? null;
	}

	async put(key: string, value: unknown): Promise<void> {
		if (this.refuseWrites.has(key)) throw new Error(`refusing to write ${key}`);
		this.records.set(key, structuredClone(value));
	}

	async delete(key: string): Promise<void> {
		this.records.delete(key);
	}

	async keys(): Promise<readonly string[]> {
		return [...this.records.keys()];
	}
}
