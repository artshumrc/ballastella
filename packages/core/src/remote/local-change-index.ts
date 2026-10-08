import {
	SYNCHRONIZATION_FORMAT_VERSION,
	deleteRecord,
	synchronizationKey
} from './synchronization-metadata.js';
import { compareWorkspace } from './synchronization-planner.js';
import { classifyInventory, recognisedProjectDirectories } from './synchronization-paths.js';
import { isRecord } from '../store/project-store.js';
import { carriesPublishedSite } from '../transfer/viewer-files.js';
import type { MetadataStorage, SynchronizationBaseline } from './synchronization-metadata.js';
import type { InventoryEntry, SourcePath, SourceStatus } from './synchronization-planner.js';

export type LocalChangeKind = 'written' | 'deleted';

export interface LocalChanges {
	readonly written: readonly string[];
	readonly deleted: readonly string[];
}

export interface LocalChangeSource {
	localChanges(): Promise<LocalChanges>;
}

export const localChangeKey = (workspaceKey: string): string =>
	synchronizationKey(workspaceKey, 'local-changes');

interface StoredLocalChanges {
	readonly formatVersion: number;
	readonly at: string;
	readonly changes: ReadonlyMap<string, LocalChangeKind>;
	readonly projects?: readonly string[];
}

const DEFAULT_FLUSH_INTERVAL = 250;

export class LocalChangeIndex implements LocalChangeSource {
	readonly #storage: MetadataStorage;
	readonly #key: string;
	readonly #interval: number;
	readonly #onNotRecorded: ((problem: unknown) => void) | undefined;
	#changes: Map<string, LocalChangeKind> | null = null;
	#projects: Set<string> | null = null;
	#seeded = false;
	#loading: Promise<void> | null = null;
	#pending: Promise<boolean> | null = null;
	#writes: Promise<boolean> = Promise.resolve(true);
	#lastWriteAt = Number.NEGATIVE_INFINITY;

	constructor(
		storage: MetadataStorage,
		workspaceKey: string,
		options: {
			readonly flushInterval?: number;
			readonly onChangeNotRecorded?: (problem: unknown) => void;
		} = {}
	) {
		this.#storage = storage;
		this.#key = localChangeKey(workspaceKey);
		this.#interval = options.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
		this.#onNotRecorded = options.onChangeNotRecorded;
	}

	async localChanges(): Promise<LocalChanges> {
		const changes = await this.#load();
		const written: string[] = [];
		const deleted: string[] = [];
		for (const [path, kind] of changes) (kind === 'written' ? written : deleted).push(path);
		return { written: written.sort(), deleted: deleted.sort() };
	}

	async mark(path: string, kind: LocalChangeKind): Promise<void> {
		const changes = await this.#load();
		if (changes.get(path) === kind) return;
		changes.set(path, kind);
		void this.#schedule();
	}

	async clearShared(paths: Iterable<string>): Promise<boolean> {
		const changes = await this.#load();
		let removed = false;
		for (const path of paths) removed = changes.delete(path) || removed;
		if (!removed) return true;
		return this.flush();
	}

	async clear(): Promise<void> {
		const changes = await this.#load();
		changes.clear();
		await this.flush();
	}

	flush(): Promise<boolean> {
		return this.#write();
	}

	async projectDirectories(): Promise<ReadonlySet<string> | null> {
		await this.#load();
		return this.#seeded ? this.#projects : null;
	}

	async rememberProjectDirectories(directories: Iterable<string>): Promise<void> {
		await this.#load();
		const projects = (this.#projects ??= new Set());
		const before = projects.size;
		for (const directory of directories) projects.add(directory);
		if (this.#seeded && projects.size === before) return;
		this.#seeded = true;
		void this.#schedule();
	}

	#load(): Promise<Map<string, LocalChangeKind>> {
		this.#loading ??= this.#read();
		return this.#loading.then(() => this.#changes ?? new Map());
	}

	async #read(): Promise<void> {
		this.#changes = new Map();
		this.#projects = new Set();
		let stored: unknown;
		try {
			stored = (await this.#storage.get(this.#key)) ?? null;
		} catch {
			return;
		}
		const record = decode(stored);
		if (record === null) return;
		this.#changes = new Map(record.changes);
		if (record.projects !== undefined) {
			this.#projects = new Set(record.projects);
			this.#seeded = true;
		}
	}

	#schedule(): Promise<boolean> {
		this.#pending ??= this.#afterInterval().then(() => {
			this.#pending = null;
			return this.#write();
		});
		return this.#pending;
	}

	async #afterInterval(): Promise<void> {
		const wait = this.#interval - (Date.now() - this.#lastWriteAt);
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
	}

	#write(): Promise<boolean> {
		this.#writes = this.#writes.then(() => this.#put());
		return this.#writes;
	}

	async #put(): Promise<boolean> {
		const changes = await this.#load();
		this.#lastWriteAt = Date.now();
		try {
			if (changes.size === 0 && !this.#seeded) {
				await this.#storage.delete(this.#key);
				return true;
			}
			const stored: StoredLocalChanges = {
				formatVersion: SYNCHRONIZATION_FORMAT_VERSION,
				at: new Date().toISOString(),
				changes: new Map(changes),
				...(this.#seeded ? { projects: [...(this.#projects ?? [])] } : {})
			};
			await this.#storage.put(this.#key, stored);
			return true;
		} catch (problem) {
			this.#onNotRecorded?.(problem);
			return false;
		}
	}
}

function decode(
	stored: unknown
): { changes: Map<string, LocalChangeKind>; projects: readonly string[] | undefined } | null {
	if (!isRecord(stored)) return null;
	const record = stored as Partial<StoredLocalChanges>;
	if (record.formatVersion !== SYNCHRONIZATION_FORMAT_VERSION) return null;
	if (!(record.changes instanceof Map)) return null;
	const changes = new Map<string, LocalChangeKind>();
	for (const [path, kind] of record.changes) {
		if (typeof path !== 'string' || path === '') return null;
		if (kind !== 'written' && kind !== 'deleted') return null;
		changes.set(path, kind);
	}
	const projects = record.projects;
	if (projects !== undefined && !Array.isArray(projects)) return null;
	if (projects?.some((directory) => typeof directory !== 'string' || directory === '')) return null;
	return { changes, projects };
}

export const discardLocalChanges = (
	storage: MetadataStorage,
	workspaceKey: string
): Promise<void> => deleteRecord(storage, localChangeKey(workspaceKey));

const LOCALLY_CHANGED = 'locally-changed-bytes-unknown';

interface AutomaticStatus {
	readonly status: SourceStatus;
	readonly paths: readonly SourcePath[];
	readonly written: readonly string[];
	readonly deleted: readonly string[];
	readonly publishedSiteStale: readonly string[];
	readonly shareLinks: boolean;
}

export async function checkSourceStatus(input: {
	readonly changes: LocalChangeSource;
	readonly remote: Iterable<InventoryEntry>;
	readonly baseline: SynchronizationBaseline | null;
}): Promise<AutomaticStatus> {
	const changes = await input.changes.localChanges();
	const written = new Set(changes.written);
	const deleted = new Set(changes.deleted);
	const baseline = input.baseline?.files ?? new Map<string, string>();
	const local: InventoryEntry[] = [];
	for (const [path, sha] of baseline) {
		if (deleted.has(path)) continue;
		local.push({ path, sha: written.has(path) ? LOCALLY_CHANGED : sha });
	}
	for (const path of written) {
		if (!baseline.has(path)) local.push({ path, sha: LOCALLY_CHANGED });
	}
	const remote = [...input.remote];
	const comparison = compareWorkspace({ local, remote, baseline: input.baseline });
	const projects = recognisedProjectDirectories({
		local: local.map((entry) => entry.path),
		remote: remote.map((entry) => entry.path)
	});
	const held = classifyInventory(local, projects).publishedOutput.length > 0;
	return {
		status: comparison.status,
		paths: comparison.paths,
		written: changes.written,
		deleted: changes.deleted,
		publishedSiteStale: held ? comparison.publishedSiteStale : [],
		shareLinks: carriesPublishedSite(remote.map((entry) => entry.path))
	};
}
