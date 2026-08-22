// What this installation knows about one Workspace's Remote: the relationship, and the Synchronization
// Baseline that says what the two sides last shared (ADR-0038).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// INSTALLATION-LOCAL, AND NOT IN THE WORKSPACE
//
// SPEC: *"Keep the Remote relationship, Synchronization Baseline, and local-change index in durable
// installation-local metadata keyed by stable Workspace identity and backing."* Both records say what
// **this machine** believes about a Remote, and a record that travelled — into a Backup, into a
// Project Bundle, up to the Remote and back down into a fork — would be somebody else's belief
// arriving as this machine's evidence. That is the whole reason `remote.json` stops being the active
// relationship: it is inside the published tree, so a fork carries a binding to the repository it was
// forked *from*, and an author who opened the fork would publish to the original.
//
// It is not `localStorage` either. A Workspace of 40 000 files is a Baseline of a couple of megabytes
// against an origin-wide 5 MB budget already shared with the write-ahead journal, and the v1 publish
// manifest could therefore fail to be stored *after* a publish had already reached GitHub. The seam
// below is a structured-clone record store — IndexedDB in the app — so a complete path map is an
// ordinary write rather than a gamble.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// EVERY FAILURE ANSWERS "CANNOT TELL"
//
// A store that will not answer, a record from a build that spells this differently, a truncated one,
// **a record naming a different repository or branch**: all of them read as no valid Baseline, which
// is `Cannot tell` — SPEC: *"Cannot tell is the Remote Status when no valid Baseline exists because
// evidence is absent, unreadable, for another Remote, or could not be stored."* It is the only
// direction that cannot turn a storage problem into an overwrite, and it is a determination the
// consumers of this module have to handle anyway.
//
// The mismatch case is why a Baseline names its Remote rather than only its Workspace. A Workspace can
// be re-bound with the Baseline untouched, and a self-validating record answers that without anything
// having to remember to clear it — and survives a re-bind and a re-bind back, which clearing would
// not.
//
// {@link SynchronizationMetadata.writeBaseline} answers *whether it was kept* rather than throwing,
// for the reason `PublishManifests.write` does: SPEC: *"If durable Baseline storage fails after Remote
// publication succeeds, report that Publish succeeded but status is now Cannot tell; never report the
// Publish as failed and never retain stale evidence."*

import { normaliseRemoteIdentity } from './remote-binding.js';
import type { RemoteRepository } from './publish-to-remote.js';

/**
 * The durable record store this module is kept in.
 *
 * A seam rather than IndexedDB directly, so that the failure modes the module exists to answer —
 * a store that throws, a record written by another build, a truncated path map — are reachable from a
 * test without a browser. Values are structured-clone data, not strings: a `Map` of tens of thousands
 * of paths is what this stores, and stringifying it is the v1 mistake.
 */
export interface MetadataStorage {
	get(key: string): Promise<unknown>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
	/** Every key currently held, for the repository-to-Workspace lookup ticket 11 builds on. */
	keys(): Promise<readonly string[]>;
}

/** Every key this module owns begins with this. */
export const SYNCHRONIZATION_KEY_PREFIX = 'synchronization/';

/**
 * The stored shape this build writes and understands.
 *
 * `2` because `1` is the `localStorage` publish manifest this supersedes, so a version number is
 * never ambiguous about which of the two records it describes.
 */
export const SYNCHRONIZATION_FORMAT_VERSION = 2;

/**
 * The one Remote a Workspace has, or has not.
 *
 * SPEC: *"A Workspace has zero or one active Remote."* There is deliberately no API here that could
 * represent a second one — {@link SynchronizationMetadata.bindRemote} replaces, and
 * {@link SynchronizationMetadata.clearRemote} clears.
 */
export type RemoteRelationship = RemoteRepository;

/** What the two sides last shared: the Remote it is a claim about, and the tree it held. */
export interface SynchronizationBaseline {
	readonly remote: RemoteRelationship;
	/** The commit that state was observed at, so the record says *which* transfer established it. */
	readonly commit: string;
	/** Every source path in that commit, and the blob SHA it pointed at. */
	readonly files: ReadonlyMap<string, string>;
}

/** The stored form of a relationship, so a future field is an addition rather than a re-encoding. */
interface StoredRelationship {
	readonly formatVersion: number;
	/** ISO 8601, for whoever is reading the database with the devtools open. */
	readonly at: string;
	readonly owner: string;
	readonly repository: string;
	readonly branch: string;
}

interface StoredBaseline extends StoredRelationship {
	readonly commit: string;
	readonly files: ReadonlyMap<string, string>;
}

/**
 * The installation-local synchronization metadata of **one** Workspace.
 *
 * Bound to a Workspace key at construction for the reason {@link PublishManifests} is: one click
 * switches Workspaces, and metadata keyed by nothing else would let what this machine knows about one
 * Remote stand as evidence about another. The key carries the backing as well as the name — `opfs:My
 * Workspace` and `folder:maps` — so a browser-backed Workspace and a chosen folder that happen to
 * share a name are two subjects, and renaming the display text of one does not redirect the other's
 * evidence.
 */
export class SynchronizationMetadata {
	readonly #storage: MetadataStorage;
	readonly #remoteKey: string;
	readonly #baselineKey: string;

	constructor(storage: MetadataStorage, workspaceKey: string) {
		this.#storage = storage;
		this.#remoteKey = remoteRelationshipKey(workspaceKey);
		this.#baselineKey = baselineKey(workspaceKey);
	}

	/** The Remote this Workspace is bound to, or `null` for bound to nothing. Never throws. */
	async readRemote(): Promise<RemoteRelationship | null> {
		const stored = await this.#read(this.#remoteKey);
		return stored === null ? null : decodeRelationship(stored);
	}

	/**
	 * Bind this Workspace to `remote`, replacing whatever relationship it had.
	 *
	 * @returns whether it was kept. A store that refuses leaves the Workspace unbound rather than
	 *   half-bound, which is the direction a caller can report and recover from.
	 */
	async bindRemote(remote: RemoteRelationship): Promise<boolean> {
		const stored: StoredRelationship = { ...versionStamp(), ...identityOf(remote) };
		try {
			await this.#storage.put(this.#remoteKey, stored);
			return true;
		} catch {
			// Not left half-written: a relationship the reader would answer `null` about anyway is worse
			// than none, because it is one nothing will ever try to write again.
			await this.clearRemote();
			return false;
		}
	}

	/**
	 * Unbind this Workspace. Idempotent.
	 *
	 * ⚠ **The Baseline is deliberately left alone**, exactly as the v1 manifest was: it names the
	 * Remote it is a claim about, so it is answered `null` while the Workspace is bound elsewhere and
	 * is still good evidence if the same Remote is bound again. Clearing it here would throw away a
	 * record that survives a re-bind and a re-bind back.
	 */
	async clearRemote(): Promise<void> {
		await this.#delete(this.#remoteKey);
	}

	/**
	 * What this Workspace and `remote` last shared, or `null` for `Cannot tell`.
	 *
	 * ⚠ **The Remote is an argument because the answer depends on it.** A record describing another
	 * repository, or another branch of the same one, is a claim about somewhere else and is answered
	 * `null` — the same answer absence and corruption get, because those three license the same
	 * caution.
	 */
	async readBaseline(remote: RemoteRelationship): Promise<SynchronizationBaseline | null> {
		const stored = await this.#read(this.#baselineKey);
		return stored === null ? null : decodeBaseline(stored, remote);
	}

	/**
	 * Record what the two sides now share.
	 *
	 * @returns whether it was kept. `false` is a durable store that refused, and the caller's answer
	 *   to it is `Cannot tell` — never a failure of the operation that had already succeeded.
	 */
	async writeBaseline(baseline: SynchronizationBaseline): Promise<boolean> {
		const stored: StoredBaseline = {
			...versionStamp(),
			...identityOf(baseline.remote),
			commit: baseline.commit,
			files: new Map(baseline.files)
		};
		try {
			await this.#storage.put(this.#baselineKey, stored);
			return true;
		} catch {
			// ⚠ **The record already there is thrown away, and that is the point of catching at all.** A
			// refused write leaves the *previous* transfer's map in place, and the reader above cannot
			// tell it from a record of the transfer that has just happened — so every path this transfer
			// legitimately changed would come back as somebody else's work. Removing it degrades the
			// answer to `Cannot tell`, which every consumer handles.
			await this.clearBaseline();
			return false;
		}
	}

	/** Forget the Baseline. Idempotent. */
	async clearBaseline(): Promise<void> {
		await this.#delete(this.#baselineKey);
	}

	async #read(key: string): Promise<unknown> {
		try {
			return (await this.#storage.get(key)) ?? null;
		} catch {
			// A store that will not answer is not evidence of an unbound Workspace or an empty Remote; it
			// is evidence of nothing.
			return null;
		}
	}

	async #delete(key: string): Promise<void> {
		try {
			await this.#storage.delete(key);
		} catch {
			// Nothing a caller can do, and nothing is lost: an unremovable record is one the readers above
			// still validate before anybody acts on it.
		}
	}
}

/** The key one Workspace's relationship is filed under. */
export const remoteRelationshipKey = (workspaceKey: string): string =>
	`${SYNCHRONIZATION_KEY_PREFIX}${encodeURIComponent(workspaceKey)}/remote`;

/** The key one Workspace's Baseline is filed under. */
export const baselineKey = (workspaceKey: string): string =>
	`${SYNCHRONIZATION_KEY_PREFIX}${encodeURIComponent(workspaceKey)}/baseline`;

/**
 * Throw away the synchronization metadata of a Workspace that is being deleted.
 *
 * ⚠ **The reuse hazard the journal and the deletion records carry.** Metadata left behind by a
 * Workspace called "Marking 2026" is this machine's belief about a Remote, standing ready for whatever
 * "Marking 2026" is made next — which would arrive bound to somebody else's repository, with a
 * Baseline claiming its files were already shared.
 */
export async function discardSynchronizationMetadata(
	storage: MetadataStorage,
	workspaceKey: string
): Promise<void> {
	const metadata = new SynchronizationMetadata(storage, workspaceKey);
	await metadata.clearRemote();
	await metadata.clearBaseline();
}

/**
 * Every Workspace key this installation holds a relationship for, and the repository it names.
 *
 * The hook under SPEC's *"installation-local reverse lookup so reopening a repository selects its
 * existing synchronized Workspace rather than creating another"*. Ticket 11 owns that flow; this only
 * answers the question, and answers it with an empty list rather than throwing when the store will not
 * be read.
 */
export async function listRemoteRelationships(
	storage: MetadataStorage
): Promise<readonly { workspaceKey: string; remote: RemoteRelationship }[]> {
	let keys: readonly string[];
	try {
		keys = await storage.keys();
	} catch {
		return [];
	}
	const found: { workspaceKey: string; remote: RemoteRelationship }[] = [];
	for (const key of keys) {
		const workspaceKey = workspaceKeyOfRelationship(key);
		if (workspaceKey === null) continue;
		const remote = await new SynchronizationMetadata(storage, workspaceKey).readRemote();
		if (remote !== null) found.push({ workspaceKey, remote });
	}
	return found;
}

/** The Workspace a relationship key names, or `null` when the key is not one. */
function workspaceKeyOfRelationship(key: string): string | null {
	if (!key.startsWith(SYNCHRONIZATION_KEY_PREFIX) || !key.endsWith('/remote')) return null;
	const body = key.slice(SYNCHRONIZATION_KEY_PREFIX.length, -'/remote'.length);
	try {
		return decodeURIComponent(body) || null;
	} catch {
		// A malformed `%` escape: somebody else's key under our prefix, or a truncated one. It names no
		// Workspace, so it is not one to report as a relationship.
		return null;
	}
}

/**
 * The three fields of a repository identity, and nothing else the caller happened to be carrying.
 *
 * ⚠ **Spelled out rather than spread.** A `RemoteBinding` read off disk carries its *own*
 * `formatVersion`, and spreading it over the stamp below silently wrote a record this build's reader
 * then refused — a Workspace that reported itself unbound the moment it was bound.
 */
const identityOf = (remote: RemoteRelationship) => ({
	owner: remote.owner,
	repository: remote.repository,
	branch: remote.branch
});

const versionStamp = () => ({
	formatVersion: SYNCHRONIZATION_FORMAT_VERSION,
	at: new Date().toISOString()
});

/** A stored record's repository identity, or `null` for anything this build has no rules for. */
function decodeIdentity(stored: unknown): RemoteRelationship | null {
	if (typeof stored !== 'object' || stored === null) return null;
	const record = stored as Partial<StoredRelationship>;
	if (record.formatVersion !== SYNCHRONIZATION_FORMAT_VERSION) return null;
	// Re-checked against GitHub's character sets on the way out, not only on the way in: this is
	// user-writable browser storage, and both fields are interpolated straight into an API path.
	return normaliseRemoteIdentity(record);
}

const decodeRelationship = (stored: unknown): RemoteRelationship | null => decodeIdentity(stored);

function decodeBaseline(
	stored: unknown,
	remote: RemoteRelationship
): SynchronizationBaseline | null {
	const identity = decodeIdentity(stored);
	if (identity === null) return null;
	// A claim about somewhere else, which is no claim about here.
	if (
		identity.owner !== remote.owner ||
		identity.repository !== remote.repository ||
		identity.branch !== remote.branch
	) {
		return null;
	}
	const record = stored as Partial<StoredBaseline>;
	if (typeof record.commit !== 'string' || record.commit === '') return null;
	if (!(record.files instanceof Map)) return null;
	const files = new Map<string, string>();
	for (const [path, sha] of record.files) {
		// One bad entry is a truncated or foreign record rather than a Baseline missing one file, and
		// reading it as the latter is how a partial belief comes to license an overwrite.
		if (typeof path !== 'string' || path === '') return null;
		if (typeof sha !== 'string' || sha === '') return null;
		files.set(path, sha);
	}
	return { remote: identity, commit: record.commit, files };
}
