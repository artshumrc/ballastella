import type { JournalStorage } from './journal.js';
import {
	keysNamed,
	parseWorkspaceScopedKey,
	removeAll,
	removeQuietly,
	workspaceNames,
	workspaceScopedKey
} from './workspace-scoped-key.js';

// Deliberately not under the journal's prefix, which its sweeps treat as journal entries.
export const DELETED_KEY_PREFIX = 'ballastella.deleted.';

export interface ProjectIdentity {
	readonly name: string;
	readonly updatedAt: string;
}

export interface DeletionRecord {
	readonly directory: string;
	readonly was: ProjectIdentity | null;
}

interface StoredRecord {
	readonly formatVersion: number;
	readonly at: string;
	readonly was?: ProjectIdentity;
}

const DELETION_FORMAT_VERSION = 1;

const deletions = (storage: JournalStorage) =>
	keysNamed(storage, DELETED_KEY_PREFIX, (key) => parseWorkspaceScopedKey(DELETED_KEY_PREFIX, key));

export class DeletedProjects {
	readonly #storage: JournalStorage;
	readonly #workspace: string;

	constructor(storage: JournalStorage, workspace: string) {
		this.#storage = storage;
		this.#workspace = workspace;
	}

	record(directory: string, was: ProjectIdentity | null): boolean {
		const stored: StoredRecord = {
			formatVersion: DELETION_FORMAT_VERSION,
			at: new Date().toISOString(),
			...(was ? { was } : {})
		};
		try {
			this.#storage.setItem(this.#key(directory), JSON.stringify(stored));
			return true;
		} catch {
			return false;
		}
	}

	forget(directory: string): void {
		removeQuietly(this.#storage, this.#key(directory));
	}

	has(directory: string): boolean {
		return this.#read(this.#key(directory)) !== null;
	}

	pending(): DeletionRecord[] {
		let named: ReturnType<typeof deletions>;
		try {
			named = deletions(this.#storage);
		} catch {
			return [];
		}
		return named
			.filter(({ workspace }) => workspace === this.#workspace)
			.map(({ key, subject }) => ({ directory: subject, was: decode(this.#read(key)) }))
			.sort((a, b) => a.directory.localeCompare(b.directory));
	}

	#read(key: string): string | null {
		try {
			return this.#storage.getItem(key);
		} catch {
			return null;
		}
	}

	#key(directory: string): string {
		return workspaceScopedKey(DELETED_KEY_PREFIX, this.#workspace, directory);
	}
}

function decode(value: string | null): ProjectIdentity | null {
	if (value === null) return null;
	try {
		const record = JSON.parse(value) as Partial<StoredRecord> | null;
		if (typeof record !== 'object' || record === null) return null;
		if (record.formatVersion !== DELETION_FORMAT_VERSION) return null;
		const was = record.was;
		return was && typeof was.name === 'string' && typeof was.updatedAt === 'string'
			? { name: was.name, updatedAt: was.updatedAt }
			: null;
	} catch {
		return null;
	}
}

export const workspacesWithDeletions = (storage: JournalStorage): string[] =>
	workspaceNames(deletions(storage));

export const discardDeletions = (storage: JournalStorage, workspace: string): number =>
	removeAll(
		storage,
		deletions(storage).filter((named) => named.workspace === workspace)
	);
