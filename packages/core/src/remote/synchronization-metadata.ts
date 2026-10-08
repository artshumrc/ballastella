import { isRecord } from '../store/project-store.js';
import { isSameRemote, normaliseRemoteIdentity, type RemoteRepository } from './remote-binding.js';

export interface MetadataStorage {
	get(key: string): Promise<unknown>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
	keys(): Promise<readonly string[]>;
}

const SYNCHRONIZATION_KEY_PREFIX = 'synchronization/';
export const SYNCHRONIZATION_FORMAT_VERSION = 2;

export type RemoteRelationship = RemoteRepository;

export interface SynchronizationBaseline {
	readonly remote: RemoteRelationship;
	readonly commit: string;
	readonly files: ReadonlyMap<string, string>;
}

interface StoredRelationship {
	readonly formatVersion: number;
	readonly at: string;
	readonly owner: string;
	readonly repository: string;
	readonly branch: string;
}

interface StoredBaseline extends StoredRelationship {
	readonly commit: string;
	readonly files: ReadonlyMap<string, string>;
}

export class SynchronizationMetadata {
	readonly #storage: MetadataStorage;
	readonly #remoteKey: string;
	readonly #baselineKey: string;
	readonly #withdrawalKey: string;

	constructor(storage: MetadataStorage, workspaceKey: string) {
		this.#storage = storage;
		this.#remoteKey = remoteRelationshipKey(workspaceKey);
		this.#baselineKey = baselineKey(workspaceKey);
		this.#withdrawalKey = withdrawalKey(workspaceKey);
	}

	async readRemote(): Promise<RemoteRelationship | null> {
		return decodeIdentity(await this.#read(this.#remoteKey));
	}

	bindRemote(remote: RemoteRelationship): Promise<boolean> {
		return this.#put(this.#remoteKey, { ...versionStamp(), ...identityOf(remote) });
	}

	async clearRemote(): Promise<void> {
		await this.#delete(this.#remoteKey);
	}

	async readBaseline(remote: RemoteRelationship): Promise<SynchronizationBaseline | null> {
		return decodeBaseline(await this.#read(this.#baselineKey), remote);
	}

	writeBaseline(baseline: SynchronizationBaseline): Promise<boolean> {
		const stored: StoredBaseline = {
			...versionStamp(),
			...identityOf(baseline.remote),
			commit: baseline.commit,
			files: new Map(baseline.files)
		};
		return this.#put(this.#baselineKey, stored);
	}

	async clearBaseline(): Promise<void> {
		await this.#delete(this.#baselineKey);
	}

	async readWithdrawal(remote: RemoteRelationship): Promise<boolean> {
		const identity = decodeIdentity(await this.#read(this.#withdrawalKey));
		return identity !== null && isSameRemote(identity, remote);
	}

	requestWithdrawal(remote: RemoteRelationship): Promise<boolean> {
		return this.#put(this.#withdrawalKey, { ...versionStamp(), ...identityOf(remote) });
	}

	async clearWithdrawal(): Promise<void> {
		await this.#delete(this.#withdrawalKey);
	}

	async #read(key: string): Promise<unknown> {
		try {
			return (await this.#storage.get(key)) ?? null;
		} catch {
			return null;
		}
	}

	async #put(key: string, stored: StoredRelationship): Promise<boolean> {
		try {
			await this.#storage.put(key, stored);
			return true;
		} catch {
			await this.#delete(key);
			return false;
		}
	}

	#delete(key: string): Promise<void> {
		return deleteRecord(this.#storage, key);
	}
}

export async function deleteRecord(storage: MetadataStorage, key: string): Promise<void> {
	try {
		await storage.delete(key);
	} catch {
		// An unremovable record is still validated before anyone acts on it.
	}
}

export const synchronizationKey = (workspaceKey: string, record: string): string =>
	`${SYNCHRONIZATION_KEY_PREFIX}${encodeURIComponent(workspaceKey)}/${record}`;

export const remoteRelationshipKey = (workspaceKey: string): string =>
	synchronizationKey(workspaceKey, 'remote');

export const baselineKey = (workspaceKey: string): string =>
	synchronizationKey(workspaceKey, 'baseline');

const withdrawalKey = (workspaceKey: string): string =>
	synchronizationKey(workspaceKey, 'withdrawal');

export async function discardSynchronizationMetadata(
	storage: MetadataStorage,
	workspaceKey: string
): Promise<void> {
	const metadata = new SynchronizationMetadata(storage, workspaceKey);
	await metadata.clearRemote();
	await metadata.clearBaseline();
	await metadata.clearWithdrawal();
}

const identityOf = (remote: RemoteRelationship) => ({
	owner: remote.owner,
	repository: remote.repository,
	branch: remote.branch
});

const versionStamp = () => ({
	formatVersion: SYNCHRONIZATION_FORMAT_VERSION,
	at: new Date().toISOString()
});

function decodeIdentity(stored: unknown): RemoteRelationship | null {
	if (!isRecord(stored)) return null;
	const record = stored as Partial<StoredRelationship>;
	if (record.formatVersion !== SYNCHRONIZATION_FORMAT_VERSION) return null;
	return normaliseRemoteIdentity(record);
}

function decodeBaseline(
	stored: unknown,
	remote: RemoteRelationship
): SynchronizationBaseline | null {
	const identity = decodeIdentity(stored);
	if (identity === null || !isSameRemote(identity, remote)) return null;
	const record = stored as Partial<StoredBaseline>;
	if (typeof record.commit !== 'string' || record.commit === '') return null;
	if (!(record.files instanceof Map)) return null;
	const files = new Map<string, string>();
	for (const [path, sha] of record.files) {
		if (typeof path !== 'string' || path === '') return null;
		if (typeof sha !== 'string' || sha === '') return null;
		files.set(path, sha);
	}
	return { remote: identity, commit: record.commit, files };
}
