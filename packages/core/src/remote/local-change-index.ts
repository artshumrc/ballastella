// What Ballastella itself has written or deleted in one Workspace since its Synchronization Baseline
// (ADR-0033), and the passive Remote Status that can be read off it without touching a byte.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY AN INDEX AND NOT A HASHING PASS
//
// Remote Status is checked automatically, with bounded frequency, and without rereading and hashing
// every local file. A Workspace is a Project directory, a handful of Annotations, and tens of
// thousands of pyramid tiles — several gigabytes. Answering "has anything changed here?" by reading
// and hashing all of it is the obvious implementation and it is unusable: it would run on every
// window focus, on a folder the browser reaches through a permission-checked handle, while the user
// is drawing.
//
// So the question is answered from the other side. Every byte of a user's work crosses
// `ProjectStore.write` or `ProjectStore.delete` (ADR-0001), so the seam that already sees every
// change can write down *which paths* it changed. The Remote tree and the Baseline supply SHAs; this
// supplies the one bit per path that the local side is otherwise gigabytes away from.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// IT IS NOT A BASELINE, AND IT CLAIMS NOTHING ABOUT BYTES
//
// A mark says *this path may differ from the Baseline*. It does not say what the file now holds, and
// it must never be read as though it did: {@link checkSourceStatus} therefore reports a path changed
// on both sides as a Conflict rather than as `converged`, because two changes it cannot compare are
// not evidence that they agree. A deliberate Sync keeps the complete read-and-hash pass
// and may revise the status that was already displayed.
//
// The gap is deliberate in the other direction too. An author who edits a file in their chosen
// folder with another program never crosses the seam, so the index does not know. Detecting an
// out-of-band edit is the deliberate transfer's job, not this one's. There is no watcher, no polling
// and no modification-time heuristic here; the complete pass at transfer time is the answer, and it
// is the only one that is actually reliable.

import {
	SYNCHRONIZATION_FORMAT_VERSION,
	SYNCHRONIZATION_KEY_PREFIX
} from './synchronization-metadata.js';
import { compareWorkspace } from './synchronization-planner.js';
import { classifyInventory, recognisedProjectDirectories } from './synchronization-paths.js';
import { carriesPublishedSite } from '../transfer/viewer-files.js';
import type { MetadataStorage, SynchronizationBaseline } from './synchronization-metadata.js';
import type { InventoryEntry, SourcePath, SourceStatus } from './synchronization-planner.js';

/** Which of the two things the seam saw happen to a path last. */
export type LocalChangeKind = 'written' | 'deleted';

/** The paths Ballastella has changed since the Baseline, each sorted. */
export interface LocalChanges {
	readonly written: readonly string[];
	readonly deleted: readonly string[];
}

/**
 * Whatever can answer what changed locally without reading the Workspace.
 *
 * The seam {@link checkSourceStatus} is given, rather than the index itself, so that a test can spy
 * on the {@link ProjectStore} underneath a managed store and prove the automatic check reached none
 * of it.
 */
export interface LocalChangeSource {
	localChanges(): Promise<LocalChanges>;
}

/** The key one Workspace's index is filed under, beside its relationship and its Baseline. */
export const localChangeKey = (workspaceKey: string): string =>
	`${SYNCHRONIZATION_KEY_PREFIX}${encodeURIComponent(workspaceKey)}/local-changes`;

/** The stored form, so a future field is an addition rather than a re-encoding. */
interface StoredLocalChanges {
	readonly formatVersion: number;
	/** ISO 8601, for whoever is reading the database with the devtools open. */
	readonly at: string;
	readonly changes: ReadonlyMap<string, LocalChangeKind>;
	/**
	 * Every Project directory this installation has seen this Workspace hold.
	 *
	 * ⚠ **Here so that classifying a write needs no directory walk.** Whether `atlas/notes.json` is
	 * scholarship depends on whether `atlas` is a Project — `synchronization-paths.ts` asks for the
	 * recognised directories — and finding that out from the store means `list('')` over a Workspace
	 * of tens of thousands of files. Recorded once and then maintained by the writes themselves, that
	 * walk happens once in a Workspace's life rather than once per session.
	 *
	 * `undefined` means never recorded, which is what asks the managed store to take that one walk.
	 */
	readonly projects?: readonly string[];
}

/** How long two flushes are kept apart, in milliseconds. See {@link LocalChangeIndex}. */
const DEFAULT_FLUSH_INTERVAL = 250;

export interface LocalChangeIndexOptions {
	/** Milliseconds between durable writes. `0` for a test that wants each one immediately. */
	readonly flushInterval?: number;
	/**
	 * A mark that could not be made durable — a full or closed store.
	 *
	 * Worth a caller's attention rather than a silent catch: the record on disk now holds *fewer*
	 * marks than the truth, so a status derived from it after a reload under-reports local drift,
	 * which is the direction that lets an Update overwrite work.
	 */
	readonly onChangeNotRecorded?: (problem: unknown) => void;
}

/**
 * One Workspace's durable local-change index.
 *
 * ⚠ **Marks are applied in memory and made durable behind the caller**, and that is a performance
 * requirement rather than a convenience. Tiling one Map Image writes tens of thousands of files
 * through this seam; a record rewritten and awaited per file would rewrite a map of tens of thousands
 * of entries tens of thousands of times, turning an already long job into an unusable one. So a mark
 * resolves as soon as it is in memory — where {@link localChanges} reads it — and flushes coalesce,
 * no two closer together than {@link LocalChangeIndexOptions.flushInterval}.
 *
 * What that costs is bounded and is the right way round: a tab that dies inside a tiling burst loses
 * the last few marks, so status under-reports those tiles until the next deliberate Update or
 * A Sync hashes the Workspace and finds them. {@link flush} is there for a caller that wants the
 * guarantee at a moment it chooses.
 */
export class LocalChangeIndex implements LocalChangeSource {
	readonly #storage: MetadataStorage;
	readonly #key: string;
	readonly #interval: number;
	readonly #onNotRecorded: ((problem: unknown) => void) | undefined;

	/** The record, once read. `null` until then; never re-read, because this is its only writer. */
	#changes: Map<string, LocalChangeKind> | null = null;
	#projects: Set<string> | null = null;
	/** Whether {@link StoredLocalChanges.projects} has ever been recorded. */
	#seeded = false;
	#loading: Promise<void> | null = null;
	/** The scheduled flush, so a burst of marks shares one. */
	#pending: Promise<boolean> | null = null;
	/** Serialises the durable writes, so two flushes cannot interleave their puts. */
	#writes: Promise<boolean> = Promise.resolve(true);
	#lastWriteAt = Number.NEGATIVE_INFINITY;

	constructor(
		storage: MetadataStorage,
		workspaceKey: string,
		options: LocalChangeIndexOptions = {}
	) {
		this.#storage = storage;
		this.#key = localChangeKey(workspaceKey);
		this.#interval = options.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
		this.#onNotRecorded = options.onChangeNotRecorded;
	}

	/** What Ballastella has changed since the Baseline. Never throws; never reads the Workspace. */
	async localChanges(): Promise<LocalChanges> {
		const changes = await this.#load();
		const written: string[] = [];
		const deleted: string[] = [];
		for (const [path, kind] of changes) (kind === 'written' ? written : deleted).push(path);
		return { written: written.sort(), deleted: deleted.sort() };
	}

	/**
	 * Record that `path` was written or deleted.
	 *
	 * Resolves once the mark is in memory; the durable write is scheduled. Repeating the same change
	 * to the same path leaves one entry, so an autosaved `project.json` is one indexed path however
	 * many times it is saved.
	 */
	async mark(path: string, kind: LocalChangeKind): Promise<void> {
		const changes = await this.#load();
		if (changes.get(path) === kind) return;
		changes.set(path, kind);
		void this.#schedule();
	}

	/**
	 * Drop the marks on paths a transfer has just made shared, and **only** those.
	 *
	 * ⚠ **Selective, because an Update advances part of a Baseline.** An Update retains local-only
	 * changes and advances only state that was made shared, so the paths it left alone are still
	 * Changes to send afterwards and clearing the whole index would report them as shared
	 * with a Remote that has never seen them. The caller must have written the Baseline successfully
	 * before calling this; under a refused Baseline write there is no shared state to record.
	 *
	 * @returns whether the narrowed index was made durable.
	 */
	async clearShared(paths: Iterable<string>): Promise<boolean> {
		const changes = await this.#load();
		let removed = false;
		for (const path of paths) removed = changes.delete(path) || removed;
		if (!removed) return true;
		return this.flush();
	}

	/** Forget every mark. For a Workspace whose whole namespace has just been shared, and deletion. */
	async clear(): Promise<void> {
		const changes = await this.#load();
		changes.clear();
		await this.flush();
	}

	/** Make everything marked so far durable now, rather than at the next scheduled flush. */
	flush(): Promise<boolean> {
		return this.#write();
	}

	/**
	 * The Project directories this installation has seen, or `null` for never recorded.
	 *
	 * `null` is the managed store's cue to take the one directory walk this record exists to avoid
	 * repeating. See {@link StoredLocalChanges.projects}.
	 */
	async projectDirectories(): Promise<ReadonlySet<string> | null> {
		await this.#load();
		return this.#seeded ? this.#projects : null;
	}

	/** Remember Project directories, so a later write inside one is classified without a walk. */
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
			// A store that will not answer is not evidence that nothing has changed. It is evidence of
			// nothing — and the marks made from here on are still worth keeping.
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

	/** One flush per {@link #interval}, shared by every mark made while it is waiting. */
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
			// ⚠ **Nothing is thrown away, unlike a refused Baseline write.** A stale Baseline is a claim
			// that paths are shared when they are not, which licenses an overwrite; a stale *index* holds
			// marks that are all still true — it is only missing the newest one. Keeping it is strictly
			// the safer of the two, so the record stays and the caller is told.
			this.#onNotRecorded?.(problem);
			return false;
		}
	}
}

/** A stored record's contents, or `null` for anything this build has no rules for. */
function decode(
	stored: unknown
): { changes: Map<string, LocalChangeKind>; projects: readonly string[] | undefined } | null {
	if (typeof stored !== 'object' || stored === null) return null;
	const record = stored as Partial<StoredLocalChanges>;
	if (record.formatVersion !== SYNCHRONIZATION_FORMAT_VERSION) return null;
	if (!(record.changes instanceof Map)) return null;
	const changes = new Map<string, LocalChangeKind>();
	for (const [path, kind] of record.changes) {
		// One unreadable entry is a foreign or truncated record rather than an index missing one path.
		// Read as the latter, it is a change that silently stops being reported.
		if (typeof path !== 'string' || path === '') return null;
		if (kind !== 'written' && kind !== 'deleted') return null;
		changes.set(path, kind);
	}
	const projects = record.projects;
	if (projects !== undefined && !Array.isArray(projects)) return null;
	if (projects?.some((directory) => typeof directory !== 'string' || directory === '')) return null;
	return { changes, projects };
}

/**
 * Throw away the local-change index of a Workspace that is being deleted.
 *
 * ⚠ **The same reuse hazard `discardSynchronizationMetadata` covers.** Marks left behind by a
 * Workspace called "Marking 2026" stand ready for whatever "Marking 2026" is made next, which would
 * then report paths as changed that this installation has never written.
 */
export async function discardLocalChanges(
	storage: MetadataStorage,
	workspaceKey: string
): Promise<void> {
	try {
		await storage.delete(localChangeKey(workspaceKey));
	} catch {
		// Nothing a caller can do, and nothing is lost: an unremovable record is one the reader above
		// still validates against the Baseline before anybody acts on it.
	}
}

/**
 * The blob SHA a passive check has for a path it knows only that Ballastella changed.
 *
 * ⚠ **Not a SHA, and deliberately not one anything could mistake for a SHA.** The index records that
 * a path changed, never what it now holds, so the comparison table is handed a value that is equal to
 * no Baseline and no Remote entry: `L != B`, which is all the index actually knows.
 */
export const LOCALLY_CHANGED = 'locally-changed-bytes-unknown';

/** The three inputs an automatic check has: the index, the Remote tree, and the Baseline. */
export interface AutomaticStatusInput {
	readonly changes: LocalChangeSource;
	readonly remote: Iterable<InventoryEntry>;
	/** `null` for no valid Baseline, which is `cannot-tell` however much the index holds. */
	readonly baseline: SynchronizationBaseline | null;
}

/** A passive Remote Status, and the evidence it was reached from. */
export interface AutomaticStatus {
	readonly status: SourceStatus;
	/** Every source path any side recognises. A locally changed one carries {@link LOCALLY_CHANGED}. */
	readonly paths: readonly SourcePath[];
	readonly written: readonly string[];
	readonly deleted: readonly string[];
	/**
	 * Where the Remote's site-owned output differs from what the Baseline last shared, sorted.
	 *
	 * **Never part of {@link status}**: a site built by another editor version has
	 * different chunk names, which means "the next Sync will rebuild it" and never "somebody changed your
	 * scholarship". Empty where the Baseline is no evidence about generated output — see
	 * {@link checkSourceStatus}.
	 */
	readonly publishedSiteStale: readonly string[];
	/**
	 * Whether the **Remote's** tree carries a Published Site: the Remote's half of Share Links
	 * (ADR-0045).
	 *
	 * Read off the listing this check has already paid for, so a surface that asks whether the
	 * Workspace has Share Links can answer the two-sided rule without a request of its own. It says
	 * nothing about what this Workspace holds, and nothing about what the author has asked for.
	 */
	readonly shareLinks: boolean;
}

/**
 * The Workspace's Remote Status **without reading one local byte**.
 *
 * The local inventory is *reconstructed* rather than gathered: the Baseline says what every path held
 * when the two sides last agreed, and the index says which of those Ballastella has since changed and
 * which it has removed. That is a complete local inventory for comparison purposes, with
 * {@link LOCALLY_CHANGED} standing in for the bytes it cannot name — so the whole three-way table is
 * reached by the same {@link compareWorkspace} a deliberate transfer uses, rather than by a second
 * implementation of it that could disagree.
 *
 * ⚠ **A path changed on both sides comes back `conflict`, not `converged`.** Two changes this cannot
 * compare are not evidence that they agree, and a passive check that guessed they did would report
 * `In sync` over a genuine Conflict. The deliberate pass hashes and may downgrade it, which is the
 * one revision allowed before transfer.
 *
 * ⚠ **Published Site staleness is answered only where the Baseline is evidence about it.** A
 * Baseline holding no generated output at all is no evidence about generated output, and every
 * `_app/**` chunk on the Remote would otherwise be reported as drift by a Workspace that holds the
 * identical bytes — so {@link AutomaticStatus.publishedSiteStale} is empty in that case
 * rather than long and wrong. Both a get and a send record source paths only, so a
 * passive check answers nothing here today; a Baseline that did carry generated output would be
 * compared by the same rule.
 */
export async function checkSourceStatus(input: AutomaticStatusInput): Promise<AutomaticStatus> {
	const changes = await input.changes.localChanges();
	const written = new Set(changes.written);
	const deleted = new Set(changes.deleted);
	const baseline = input.baseline?.files ?? new Map<string, string>();
	const local: InventoryEntry[] = [];
	for (const [path, sha] of baseline) {
		if (deleted.has(path)) continue;
		local.push({ path, sha: written.has(path) ? LOCALLY_CHANGED : sha });
	}
	// Written paths the Baseline never held: local additions, which is `B` absent rather than a SHA.
	for (const path of written) {
		if (!baseline.has(path)) local.push({ path, sha: LOCALLY_CHANGED });
	}
	const remote = [...input.remote];
	const comparison = compareWorkspace({ local, remote, baseline: input.baseline });
	// The reconstruction's own generated output, which is what decides whether the drift
	// `compareWorkspace` computed is evidence or merely the Remote's whole site listed back.
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
