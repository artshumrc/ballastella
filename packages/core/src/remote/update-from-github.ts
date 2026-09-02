// The inbound half of a Sync: bringing a Remote's own additions, replacements and deletions into a
// Workspace that is already synchronized with it (ADR-0038, ADR-0044).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// EXPLICIT, INBOUND, AND NEITHER HALF OF THAT IS NEGOTIABLE
//
// A Remote Status check lists metadata and stops. This is the operation that acts on what the check
// found, and it happens because somebody pressed *Get changes* on the Sync modal having read what
// it found. Nothing here is reachable from a status check, a window focus, an open or a send. Work
// coming in from a Remote never changes a Workspace silently.
//
// And it is inbound only. Nothing in this module posts a blob, writes a tree, moves a ref, generates
// a Published Site, or touches a repository file outside Ballastella's namespace. Receiving somebody
// else's work must not be able to make this author's own work public, so there is deliberately no
// code path from here to the publish engine at all.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// IT NEEDS NO ACCOUNT, WHICH IS THE CASE IT IS MOST LIKELY TO BE USED FOR
//
// The reads are `clone-from-remote.ts`'s reads: an anonymous tree listing and anonymous
// `raw.githubusercontent.com` bytes. Nothing here takes a token, and none may be added. The case to
// keep in view is a student whose instructor publishes to a repository they cannot push to — inbound
// synchronization is not publishing authority, and a refusal for want of write permission would be
// this app inventing a rule GitHub does not have.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE PLAN IS THE PLANNER'S, AND IT IS REPLANNED HERE RATHER THAN INHERITED
//
// {@link planWorkspaceUpdate} owns every three-way decision, and this module reimplements none of
// them. What it does own is the two inventories that plan is made from, and both are gathered again
// at the moment of transfer:
//
//   * **The local side is read and hashed completely**, however recently a status check ran. The write
//     index (`local-change-index.ts`) is evidence about Ballastella's own writes and nothing else — a
//     chosen folder can be edited by any program on the machine — so a plan built from it would take
//     an inbound change over an out-of-band local edit and call it safe. A deliberate transfer is
//     entitled to this pass, and to revising the status already on screen.
//   * **The Remote side is read at one commit.** The head commit is read first and the tree and every
//     blob are then read *at that SHA* rather than at the branch, so a branch that moves mid-transfer
//     cannot hand this a file from one commit and a file from another. Every byte is still checked
//     against the SHA the listing named, which is what catches a rewritten copy from a proxy.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A DELETION IS SHOWN BEFORE THE PRESS, NOT CONFIRMED AFTER IT
//
// Every path this would remove is named in the Sync modal the author read before pressing — Projects
// and Map Images rather than paths (ADR-0044) — so there is no confirmation here and no preview type
// for one. A deletion discovered *after* a press is the failure the modal's shape exists to prevent,
// and a second question in front of a decision already taken is the confirmation people learn to
// press through.
//
// ⚠ **A removal is Baseline-narrowed, which is what makes showing it enough.** A path is removed
// from here only where the Baseline recorded it and the Remote no longer holds it, so with no
// Baseline nothing is removed at all — and the plan's own construction, not a check here, is what
// guarantees it.
//
// A path the Remote deleted whose local bytes have *changed* is not a deletion at all. It is
// `comparePath`'s Conflict row — baseline, local and remote all differ — so the whole get is
// refused and neither side is touched.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE TRANSACTION, AND WHY IT IS NOT IMPORT'S
//
// `project-import-transaction.ts` writes provisional bytes straight to their final paths, and that
// is available to it only because every path an Import writes is freshly allocated. An Update
// replaces and removes paths that already hold the author's work, so the same trick would overwrite
// the thing it is supposed to be able to give back. So every path that is about to be replaced *or
// removed* has its previous bytes copied to a reserved before-image first, and one durable marker
// names the whole operation:
//
//   1. the marker, `'writing'`, naming every addition, replacement and deletion;
//   2. a before-image of every path being replaced and every path being removed;
//   3. every planned file, fetched and SHA-checked, written to its final path;
//   4. every deletion carried out;
//   5. the marker rewritten `'committed'` — the boundary, past which nothing is rolled back;
//   6. the before-images removed, then the marker.
//
// Anything that fails before step 5 restores every before-image, removes every addition, and then
// refuses — so the Workspace the caller is told about is the Workspace they started with. **The
// deletions are inside that window rather than after it**, which is what the before-images of the
// paths being removed are for: a deletion list is carried out one path at a time, and a failure part
// way along it — or a write that failed while a deletion had already gone through — has to be able to
// put every one of them back.
//
// A marker left behind by a tab that died is resolved by {@link recoverWorkspaceUpdate}, which runs
// before this plans anything *and* before the application enumerates the Workspace at all:
// `'writing'` is rolled back and `'committed'` is finished, exactly as an Import's two states are
// opposite instructions. So a reader of this Workspace sees the complete old state or the complete
// new one, never a Project list assembled out of both.

import { alignmentImageId } from '../alignment/alignment.js';
import { writeAlignmentBytes } from '../alignment/alignment-file.js';
import { PROJECT_FILE_NAME } from '../project/project-file.js';
import { describeBytes } from '../project/workspace-size.js';
import { createHttpProjectStore } from '../store/http-project-store.js';
import {
	PathNotFoundError,
	type Bytes,
	type ProjectStore,
	type StorePath
} from '../store/project-store.js';
import { gitBlobSha } from './blob-sha.js';
import { GITHUB_RAW_ORIGIN, describeReset } from './github-api.js';
import { DEFAULT_REMOTE_BRANCH, describeRemote } from './remote-binding.js';
import {
	RemoteTreeRefusedError,
	readRemoteHeadCommit,
	readRemoteTree,
	urlPath
} from './remote-tree.js';
import {
	describeConflict,
	describeGraphFailure,
	describeGraphViolations,
	planWorkspaceSync
} from './synchronization-planner.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import type { EstimateStorage } from '../transfer/restore-workspace-tar.js';
import type { TransferProgressListener } from '../transfer/transfer.js';
import type { RemoteRelationship, SynchronizationBaseline } from './synchronization-metadata.js';
import type { InventoryEntry, PathChoice, WorkspaceSyncPlan } from './synchronization-planner.js';

/** The repository this reads from. Its branch is the Remote relationship's. */
export type UpdateReference = {
	readonly owner: string;
	readonly repository: string;
	readonly branch?: string;
};

// ── The transaction ───────────────────────────────────────────────────────────────────────────

/**
 * Where the marker lives, relative to the Workspace root.
 *
 * A top-level *file*, which cannot collide with a Project for `import.json`'s reason: `listProjects`
 * matches only `<directory>/project.json` (ADR-0008), and no Project directory can be called this.
 */
export const UPDATE_TRANSACTION_PATH = 'update.json' as StorePath;

/**
 * Where a replaced path's previous bytes are kept while an Update is in flight.
 *
 * ⚠ **A directory of its own rather than a sibling of each file**, so a before-image is never mistaken
 * for Workspace content: nothing under it is a Project directory, an `images/` or `alignments/`
 * entry, or a cached Base Map tile, so `synchronization-paths.ts` classifies the whole subtree
 * outside Ballastella's namespace — which is also what keeps the write index from marking it.
 *
 * ⚠ **The dot is what makes that true, and it is the marker file's argument applied to a directory.**
 * `toDirectoryName` emits lowercase ASCII, digits and hyphens only, so no display name can ever be
 * allocated a Project directory spelled with one — where a Project called “Update before” would be
 * given `update-before` and then have this transaction stage its rollback inside it, sweep it, and
 * hide it from `hashWorkspace`'s local inventory.
 */
export const UPDATE_BEFORE_DIRECTORY = 'update.before/';

/**
 * The format version of the marker itself, separate from a Project's.
 *
 * `2` carries the deletions, which a build that only knows `1` would leave out of a rollback — so
 * the number is what tells a reader of a stray marker which of the two wrote it.
 */
export const UPDATE_TRANSACTION_FORMAT_VERSION = 2;

/** How far an Update had got. The two states are opposite instructions — see the module header. */
export type UpdateTransactionState =
	/** Bytes are being written and nothing is durable yet, so every change is taken back. */
	| 'writing'
	/** Every inbound path is durable and **nothing may be rolled back**; the residue is swept. */
	| 'committed';

/** One path this Update replaces or removes, and where its previous bytes are being kept. */
export interface UpdateBeforeImage {
	readonly path: StorePath;
	readonly image: StorePath;
}

/** What an unresolved Update says about itself. **The authoritative inventory of what changed.** */
export interface UpdateTransaction {
	readonly formatVersion: number;
	/** Names this transaction, so a report can say which one it means. */
	readonly transaction: string;
	/**
	 * Which Workspace this Update was aimed at, or `''` when the caller named none.
	 *
	 * Recorded for `startedAt`'s reason rather than compared against anything: the marker lives inside
	 * the Workspace it belongs to, so nothing can hand it to another one. What it buys is a stray file
	 * in a chosen folder that says which Workspace it is a record of, in a report and to whoever finds
	 * it with a file browser open.
	 */
	readonly workspace: string;
	readonly state: UpdateTransactionState;
	/**
	 * The Remote commit this Update was bringing in, or `''`.
	 *
	 * With the three path sets below, the whole of the state it intended to leave: those paths, at
	 * this commit's bytes. A marker is then legible on its own — which commit, which files, how far —
	 * without the Baseline it never got as far as writing.
	 */
	readonly commit: string;
	/** Paths the Update creates that the Workspace did not hold. Removed on a rollback. */
	readonly added: readonly StorePath[];
	/** Paths the Update replaces, each with the before-image restored on a rollback. */
	readonly replaced: readonly UpdateBeforeImage[];
	/**
	 * Paths the Update removes, each with the before-image restored on a rollback.
	 *
	 * Separate from {@link replaced} because the two are undone from the same evidence but *done*
	 * differently, and a rollback that could not tell them apart would put a deleted path back as an
	 * addition to remove next time.
	 */
	readonly deleted: readonly UpdateBeforeImage[];
	/** ISO 8601, for a report and for whoever is reading the Workspace with a file browser open. */
	readonly startedAt: string;
}

/**
 * There is a marker and it cannot be read as one.
 *
 * A separate member rather than a transaction with an empty inventory, because those are opposite
 * instructions: an empty inventory says "nothing to undo", and this says "something was in flight
 * and what it changed cannot be named".
 */
export interface UnreadableUpdateTransaction {
	readonly state: 'unreadable';
}

export type UpdateTransactionMark = UpdateTransaction | UnreadableUpdateTransaction;

export function serialiseUpdateTransaction(transaction: UpdateTransaction): Bytes {
	return new TextEncoder().encode(`${JSON.stringify(transaction, null, '\t')}\n`) as Bytes;
}

/**
 * Read a marker's bytes, or `null` when they are not a marker this build can act on.
 *
 * Tolerant about everything except the shape a recovery needs. A marker from a newer build carrying
 * members this one has never heard of keeps its state and its two inventories, because those are
 * what decide what happens to the files.
 */
export function parseUpdateTransaction(bytes: Bytes): UpdateTransaction | null {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		return null;
	}
	if (typeof raw !== 'object' || raw === null) return null;
	const record = raw as Record<string, unknown>;
	const state = record['state'];
	if (typeof record['formatVersion'] !== 'number') return null;
	if (state !== 'writing' && state !== 'committed') return null;
	const added = record['added'];
	const replaced = record['replaced'];
	if (!Array.isArray(added) || added.some((path) => typeof path !== 'string' || path === '')) {
		return null;
	}
	const replacedImages = beforeImages(replaced);
	// ⚠ **Absent is an empty list and unreadable is not.** A marker written by the build before ticket
	// 15 has no `deleted` member at all and had no deletions to undo, so reading it as none is exact;
	// a member that is there and will not parse is a marker whose deletions cannot be named, and
	// reading *that* as none is a file that never gets given back.
	const deleted = record['deleted'];
	const deletedImages = deleted === undefined ? [] : beforeImages(deleted);
	if (replacedImages === null || deletedImages === null) return null;
	return {
		formatVersion: record['formatVersion'],
		transaction: typeof record['transaction'] === 'string' ? record['transaction'] : '',
		workspace: typeof record['workspace'] === 'string' ? record['workspace'] : '',
		state,
		commit: typeof record['commit'] === 'string' ? record['commit'] : '',
		added: added as StorePath[],
		replaced: replacedImages,
		deleted: deletedImages,
		startedAt: typeof record['startedAt'] === 'string' ? record['startedAt'] : ''
	};
}

/** One of the marker's two before-image lists, or `null` when it is not one. */
function beforeImages(raw: unknown): UpdateBeforeImage[] | null {
	if (!Array.isArray(raw)) return null;
	const images: UpdateBeforeImage[] = [];
	for (const entry of raw) {
		if (typeof entry !== 'object' || entry === null) return null;
		const { path, image } = entry as Record<string, unknown>;
		// One unreadable entry is a foreign or truncated marker rather than an Update missing one path,
		// and read as the latter it is a file that never gets given back.
		if (typeof path !== 'string' || path === '') return null;
		if (typeof image !== 'string' || image === '') return null;
		images.push({ path: path as StorePath, image: image as StorePath });
	}
	return images;
}

/**
 * The Update this Workspace has outstanding, or `null` when it has none.
 *
 * ⚠ **Unreadable is not absent**, pointing the same way it points in `project-import-transaction.ts`:
 * a marker that will not parse, and a backing that will not answer, both come back as
 * {@link UnreadableUpdateTransaction}. Only {@link PathNotFoundError} means there is genuinely
 * nothing outstanding.
 */
export async function readUpdateTransaction(
	store: ProjectStore
): Promise<UpdateTransactionMark | null> {
	let bytes: Bytes;
	try {
		bytes = await store.read(UPDATE_TRANSACTION_PATH);
	} catch (cause) {
		if (cause instanceof PathNotFoundError) return null;
		return { state: 'unreadable' };
	}
	return parseUpdateTransaction(bytes) ?? { state: 'unreadable' };
}

/** Remove the marker, which is the last step of both a commit and a rollback. Idempotent. */
export async function clearUpdateTransaction(store: ProjectStore): Promise<void> {
	await store.delete(UPDATE_TRANSACTION_PATH);
}

/** What resolving an outstanding Update did. */
export type UpdateRecovery =
	| { readonly outcome: 'nothing' }
	/** An unfinished Update was taken back and the Workspace is as it was before it started. */
	| { readonly outcome: 'rolled-back'; readonly transaction: string }
	/** A finished Update's residue was swept; every inbound path was already durable. */
	| { readonly outcome: 'completed'; readonly transaction: string };

/**
 * Resolve an Update a dead tab left behind: roll back what was still being written, sweep what was
 * durably committed.
 *
 * ⚠ **The order in a rollback is the order the commit made durable, reversed.** Before-images go
 * back before the additions go away, and the marker goes **last** — so an interruption inside a
 * rollback leaves the inventory intact for the next attempt, and running this twice is the same as
 * running it once.
 *
 * @throws UpdateRefusedError `'unresolved-transaction'`, leaving the marker exactly where it is
 */
export async function recoverWorkspaceUpdate(store: ProjectStore): Promise<UpdateRecovery> {
	const mark = await readUpdateTransaction(store);
	if (mark === null) return { outcome: 'nothing' };
	if (mark.state === 'unreadable') {
		throw new UpdateRefusedError(
			'unresolved-transaction',
			'This Workspace has a record of an Update from GitHub that cannot be read, so Ballastella ' +
				'cannot tell which files it had changed and will not start another until it can. Reload ' +
				'this page to try again. Nothing has been lost.'
		);
	}
	try {
		if (mark.state === 'writing') await rollBack(store, mark);
		else await sweep(store, mark);
	} catch (cause) {
		throw new UpdateRefusedError(
			'unresolved-transaction',
			`An earlier Update from GitHub did not finish, and this Workspace's record of it could not ` +
				'be resolved — so another Update will not start over the top of it. Reload this page to ' +
				'try again.',
			{ cause }
		);
	}
	return {
		outcome: mark.state === 'writing' ? 'rolled-back' : 'completed',
		transaction: mark.transaction
	};
}

/**
 * Put every displaced path back, remove every addition, and only then remove the marker.
 *
 * ⚠ **A removed path and a replaced one are restored identically and from the same evidence.** The
 * two lists are separate because they are *applied* differently — see {@link UpdateTransaction.deleted} —
 * and undoing either is the same act: the before-image's bytes go back where they came from.
 */
async function rollBack(store: ProjectStore, marker: UpdateTransaction): Promise<void> {
	for (const { path, image } of [...marker.replaced, ...marker.deleted]) {
		let bytes: Bytes;
		try {
			bytes = await store.read(image);
		} catch (cause) {
			// The before-image was never taken, which is a path this Update had not reached yet: its
			// bytes are the author's own and untouched. Anything else is a rollback that cannot finish.
			if (!(cause instanceof PathNotFoundError)) throw cause;
			continue;
		}
		await writeInbound(store, path, bytes, 'restore');
	}
	for (const path of marker.added) await store.delete(path);
	await sweep(store, marker);
}

/** Remove the before-images and then the marker. The whole of finishing a committed Update. */
async function sweep(store: ProjectStore, marker: UpdateTransaction): Promise<void> {
	for (const { image } of [...marker.replaced, ...marker.deleted]) await store.delete(image);
	await clearUpdateTransaction(store);
}

// ── Refusals ──────────────────────────────────────────────────────────────────────────────────

/** Why an Update did not happen. See {@link UpdateRefusedError} for what each leaves behind. */
export type UpdateRefusal =
	/** No such public repository, or one no anonymous reader can see — which look the same. */
	| 'no-repository'
	/** The repository holds no commits, so there is nothing in it to take. */
	| 'empty'
	/** GitHub's hourly limit for anonymous readers is used up. The remedy is waiting. */
	| 'rate-limited'
	/** GitHub could only list part of the tree, so nothing built from it can be trusted. */
	| 'truncated'
	/** Anything else GitHub said, or a request that never got an answer. */
	| 'refused'
	/** A path changed differently on both sides. Neither side is changed. */
	| 'conflict'
	/** A file the tree listed could not be fetched, or arrived as bytes the tree did not name. */
	| 'incomplete'
	/** What would arrive would not be a Workspace this app can open. */
	| 'invalid'
	/** A `project.json` in the result was written by a newer Ballastella, so this build cannot judge it. */
	| 'unsupported'
	/** There is not enough room for the inbound files and the before-images they need. */
	| 'insufficient-quota'
	/** The Workspace itself could not be read, so no honest plan can be made from it. */
	| 'unreadable'
	/** A write into the Workspace failed. The Workspace has been put back as it was. */
	| 'write-failed'
	/**
	 * It failed, and the changes already made could not be taken back.
	 *
	 * The one refusal that does **not** leave the Workspace as it was, which is why it is said
	 * differently: the marker is still there, so the next attempt resolves it before planning.
	 */
	| 'unresolved-residue'
	/** A marker from an earlier Update is outstanding and could not be resolved. */
	| 'unresolved-transaction';

/** An Update that will not go ahead, with a message for the person who asked for it. */
export class UpdateRefusedError extends Error {
	readonly refusal: UpdateRefusal;
	/** The paths the refusal is about, sorted, or empty. Named so a scholar can act on it. */
	readonly paths: readonly string[];

	constructor(
		refusal: UpdateRefusal,
		message: string,
		options: { readonly paths?: readonly string[]; readonly cause?: unknown } = {}
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'UpdateRefusedError';
		this.refusal = refusal;
		this.paths = options.paths ?? [];
	}
}

// ── The operation ─────────────────────────────────────────────────────────────────────────────

export interface UpdateFromGitHubOptions {
	readonly remote: UpdateReference;
	/**
	 * What this installation last saw the two sides share, or `null` for no valid Baseline.
	 *
	 * `null` is not a refusal. Nothing may be removed in either direction without a Baseline, so a
	 * get against a populated repository with no record of what the two last shared brings in what
	 * this Workspace has not got and takes nothing away — and a path the two hold differently is a
	 * Conflict, which is refused for the reason every Conflict is.
	 */
	readonly baseline: SynchronizationBaseline | null;
	readonly fetch?: FetchFn;
	readonly onProgress?: TransferProgressListener;
	readonly estimateStorage?: EstimateStorage;
	readonly now?: () => Date;
	/** Names the transaction. Injected so a test's marker is byte-for-byte predictable. */
	readonly transaction?: () => string;
	/** Which Workspace this is, recorded in the marker. See {@link UpdateTransaction.workspace}. */
	readonly workspace?: string;
}

/** What an Update brought in, and what it entitles the caller to record. */
export interface WorkspaceUpdate {
	/** The repository it was read from — the one the caller named, never one read off the wire. */
	readonly remote: RemoteRelationship;
	/** The commit every byte was read at, which is the state this Update describes. */
	readonly commit: string;
	/** Source paths the Remote holds and this Workspace did not, sorted. */
	readonly added: readonly string[];
	/** Paths whose locally unchanged bytes were replaced by the Remote's, sorted. */
	readonly replaced: readonly string[];
	/** Paths the Remote no longer holds, removed here after the author confirmed it, sorted. */
	readonly removed: readonly string[];
	/** Local-only changes this Update left alone. Still Changes to publish afterwards. */
	readonly retained: readonly string[];
	readonly totalFiles: number;
	readonly totalBytes: number;
	/**
	 * The complete Baseline a successful Update may now record.
	 *
	 * ⚠ **The previous Baseline, advanced only where the two sides now share bytes.** A local-only
	 * change keeps whatever the Baseline said about it, so it still reports as Changes to publish; a
	 * path neither side holds any more is dropped. Recording the whole prospective
	 * inventory instead would claim the author's unpublished work had been shared.
	 */
	readonly baseline: ReadonlyMap<string, string>;
	/** Paths now shared, so their local-change marks may be cleared and **only** theirs. */
	readonly shared: readonly string[];
	/** What the user has to be told, in the words they should see. */
	readonly notice: string;
}

/** One planned inbound file, with the bytes if they were already fetched for the graph check. */
type PlannedFile = {
	readonly path: StorePath;
	readonly sha: string;
	readonly bytes: number;
	readonly effect: 'add' | 'replace';
	readonly fetched: Bytes | null;
};

/**
 * How many blobs are fetched at once.
 *
 * Bounded rather than unbounded for the reason every transfer in this codebase is: a Workspace is
 * tens of thousands of pyramid tiles, and `Promise.all` over the plan would open a request per file
 * — which the browser queues anyway, having first built the whole plan's worth of promises and
 * whatever each one closes over.
 */
export const UPDATE_DOWNLOAD_CONCURRENCY = 6;

/**
 * Bring a Remote's own additions, replacements and deletions into this Workspace.
 *
 * The order is the design, and it is what makes every refusal before step 7 free:
 *
 * 1. **Any outstanding transaction is resolved**, so nothing is planned over a half-finished Update.
 * 2. **The Remote's commit, then its tree at that commit** — two anonymous requests.
 * 3. **The Workspace is listed, read and hashed completely.** The write index cannot see an
 *    out-of-band edit to a chosen folder, and this pass is entitled to revise the status the author
 *    was shown.
 * 4. **The plan** — `synchronization-planner.ts`'s, which owns every three-way decision, for both
 *    directions at once. Only the inbound half is acted on. A Conflict is refused here; a path the
 *    Remote deleted and this Workspace changed is one of those.
 * 5. **Every prospective `project.json` is gathered and the whole graph validated**, so a combination
 *    that would not open is refused before a byte of it is visible.
 * 6. **The transaction**: the marker, the before-images, the fetch-and-verify, the deletions, the
 *    commit.
 * 7. **The Baseline the caller may record**, advanced only where the two sides now share bytes.
 *
 * @throws UpdateRefusedError for every refusal there is. Only `'unresolved-residue'` leaves the
 *   Workspace other than exactly as it was.
 */
export async function updateFromGitHub(
	store: ProjectStore,
	options: UpdateFromGitHubOptions
): Promise<WorkspaceUpdate> {
	const branch = options.remote.branch ?? DEFAULT_REMOTE_BRANCH;
	const remote: RemoteRelationship = { ...options.remote, branch };

	await recoverWorkspaceUpdate(store);

	// ⚠ **The commit first, and everything else read at it.** `raw.githubusercontent.com` and
	// `/git/trees/{ref}` both resolve a commit SHA, so pinning here is what makes the inventory and
	// the bytes describe one state of the repository rather than whatever the branch held at each
	// moment of a transfer that takes minutes.
	let commit: string;
	try {
		commit = await readRemoteHeadCommit(remote, options.fetch);
	} catch (cause) {
		throw asUpdateRefusal(remote, cause);
	}
	const blobs = await readRemoteInventoryAt(remote, commit, options.fetch);
	const bytesOf = new Map(blobs.map((blob) => [blob.path, blob.bytes]));

	const local = await hashWorkspace(store);
	const localShas = new Map(local.map((entry) => [entry.path, entry.sha]));
	const inventory = { local, remote: blobs.map(({ path, sha }) => ({ path, sha })) };

	// The first plan settles what would change; the second, below, judges the result it would leave.
	const planned = planWorkspaceSync({ ...inventory, baseline: options.baseline });
	assertGettable(remote, planned);

	const source = createHttpProjectStore({
		resolve: (path) =>
			`${GITHUB_RAW_ORIGIN}/${urlPath(remote.owner)}/${urlPath(remote.repository)}/` +
			`${urlPath(commit)}/${urlPath(path)}`,
		// Spread rather than assigned: under `exactOptionalPropertyTypes` an explicit `undefined` is
		// not the same as an absent property, and the store's default is "the page's own `fetch`".
		...(options.fetch === undefined ? {} : { fetch: options.fetch })
	});

	const manifests = await prospectiveManifests(store, source, remote, planned, localShas);
	// ⚠ **The same planner, asked again with the material to judge the result.** A second reading of
	// the Workspace's invariants here is how a get and an Open come to disagree about what a valid
	// Workspace is; there is exactly one, and this is the call that uses it.
	const plan = planWorkspaceSync({
		...inventory,
		baseline: options.baseline,
		projectFiles: manifests.byShaOnly
	});
	assertGettable(remote, plan);

	const files: PlannedFile[] = plan.toGet.changes
		.filter((change): change is PathChoice & { sha: string } => change.sha !== null)
		.map((change) => ({
			path: change.path as StorePath,
			sha: change.sha,
			bytes: bytesOf.get(change.path) ?? 0,
			effect: change.effect === 'replace' ? 'replace' : 'add',
			fetched: manifests.byPath.get(change.path) ?? null
		}));
	const removals = plan.toGet.removed.map((path) => path as StorePath);

	await assertRoomToUpdate(store, files, removals, options.estimateStorage);
	const transferred = await transfer(store, source, remote, files, removals, commit, options);

	return {
		remote,
		commit,
		added: files
			.filter((file) => file.effect === 'add')
			.map((file) => file.path)
			.sort(),
		replaced: files
			.filter((file) => file.effect === 'replace')
			.map((file) => file.path)
			.sort(),
		removed: removals,
		retained: plan.retained,
		totalFiles: files.length,
		totalBytes: transferred,
		baseline: advancedBaseline(options.baseline, plan),
		shared: [...plan.toGet.advances.keys(), ...plan.toGet.retires].sort(),
		notice: updateNotice(remote, plan, files, removals)
	};
}

/**
 * The Baseline a successful Update may record: the previous one, advanced where the sides now agree.
 *
 * ⚠ **Not the prospective inventory.** `toGet.advances` is exactly the paths the two sides now share
 * and `toGet.retires` exactly those neither holds; every other path keeps whatever the Baseline said,
 * which is what leaves a local-only change reporting as Changes to publish afterwards.
 */
function advancedBaseline(
	previous: SynchronizationBaseline | null,
	plan: WorkspaceSyncPlan
): ReadonlyMap<string, string> {
	const files = new Map(previous?.files ?? []);
	for (const path of plan.toGet.retires) files.delete(path);
	for (const [path, sha] of plan.toGet.advances) files.set(path, sha);
	return files;
}

/** Every file the Remote's commit holds, from one anonymous listing. */
async function readRemoteInventoryAt(
	remote: RemoteRelationship,
	commit: string,
	fetchFn: FetchFn | undefined
): Promise<readonly { path: string; sha: string; bytes: number }[]> {
	try {
		// The commit stands in for the branch deliberately: `/git/trees/{ref}` takes any ref, and this
		// one cannot move under the download the way a branch name can.
		return await readRemoteTree({ ...remote, branch: commit }, fetchFn);
	} catch (cause) {
		throw asUpdateRefusal(remote, cause);
	}
}

/**
 * Every path in this Workspace with the blob SHA of its current bytes.
 *
 * ⚠ **A complete read and hash, and the cost is the point.** A passive status check
 * must not do this — it runs on every window focus — but a transfer must: an author who edited a file
 * in their chosen folder with another program never crossed the write index's seam, and a plan that
 * did not notice would replace their edit with the Remote's and call it a safe inbound change.
 */
async function hashWorkspace(store: ProjectStore): Promise<InventoryEntry[]> {
	let paths: readonly StorePath[];
	try {
		paths = await store.list('');
	} catch (cause) {
		throw new UpdateRefusedError('unreadable', unreadableWorkspaceMessage(cause));
	}
	const inventory: InventoryEntry[] = [];
	for (const path of paths) {
		if (path === UPDATE_TRANSACTION_PATH || path.startsWith(UPDATE_BEFORE_DIRECTORY)) continue;
		let bytes: Bytes;
		try {
			bytes = await store.read(path);
		} catch (cause) {
			// A path listed and then gone is a file something else removed between the two calls, which
			// is a Workspace that no longer holds it rather than one that cannot be read.
			if (cause instanceof PathNotFoundError) continue;
			throw new UpdateRefusedError('unreadable', unreadableWorkspaceMessage(cause), {
				paths: [path]
			});
		}
		inventory.push({ path, sha: await gitBlobSha(bytes) });
	}
	return inventory;
}

/**
 * Every `project.json` the result would hold, so the whole graph can be judged before anything moves.
 *
 * The planner asks for `project.json` bytes by blob SHA and answers `'not-checked'` without them, so
 * a transfer that skipped this would write an inbound Layer whose Annotation the Remote never
 * published. An inbound manifest has to be *fetched* to be judged — it is small, and the bytes are
 * kept so the transfer below does not ask GitHub for it twice.
 */
async function prospectiveManifests(
	store: ProjectStore,
	source: { read(path: StorePath): Promise<Bytes> },
	remote: RemoteRelationship,
	plan: WorkspaceSyncPlan,
	localShas: ReadonlyMap<string, string>
): Promise<{ byShaOnly: Map<string, Bytes>; byPath: Map<string, Bytes> }> {
	const prospective = new Map(localShas);
	for (const change of plan.toGet.changes) {
		if (change.sha === null) prospective.delete(change.path);
		else prospective.set(change.path, change.sha);
	}

	const byShaOnly = new Map<string, Bytes>();
	const byPath = new Map<string, Bytes>();
	for (const [path, sha] of prospective) {
		if (!isProjectManifest(path)) continue;
		if (localShas.get(path) === sha) {
			const bytes = await store.read(path).catch(() => null);
			// Absent is unreachable — the SHA came from hashing those very bytes — and it is left as a
			// gap rather than invented: the planner reads a missing manifest as `unreadable`, which is a
			// refusal, and that is the safe direction.
			if (bytes !== null) byShaOnly.set(sha, bytes);
			continue;
		}
		const bytes = await fetchVerified(source, remote, path as StorePath, sha);
		byShaOnly.set(sha, bytes);
		byPath.set(path, bytes);
	}
	return { byShaOnly, byPath };
}

const isProjectManifest = (path: string): boolean => {
	const segments = path.split('/');
	return segments.length === 2 && segments[1] === PROJECT_FILE_NAME;
};

/**
 * Refuse an Update there is no room for, **before the marker exists**.
 *
 * ⚠ **The inbound bytes *and* a before-image of every path being replaced or removed.** The
 * before-images are the whole of what makes a failed Update recoverable, and an accounting that left
 * them out would refuse to run out of room in the one place — half way through the replacements —
 * where running out of room cannot be undone. A deletion looks free and is not: its before-image is
 * written before the file goes, so the peak is the old bytes twice over. Silent when the browser will
 * not answer, for `cloneFromRemote`'s reason.
 */
async function assertRoomToUpdate(
	store: ProjectStore,
	files: readonly PlannedFile[],
	removals: readonly StorePath[],
	estimateStorage: EstimateStorage | undefined
): Promise<void> {
	if (!estimateStorage) return;
	const estimate = await estimateStorage().catch(() => null);
	const quota = estimate?.quota;
	const usage = estimate?.usage;
	if (typeof quota !== 'number' || typeof usage !== 'number') return;

	let needed = 0;
	for (const file of files) {
		needed += file.bytes;
		if (file.effect === 'replace') needed += await store.size(file.path).catch(() => 0);
	}
	for (const path of removals) needed += await store.size(path).catch(() => 0);
	const free = quota - usage;
	if (free >= needed) return;

	throw new UpdateRefusedError(
		'insufficient-quota',
		`This Update needs about ${describeBytes(needed)} — the files coming from GitHub, and a copy ` +
			`of each file it replaces or removes so it can be undone — and there is ${describeBytes(
				Math.max(0, free)
			)} free. Nothing has been changed. Delete a Workspace you no longer need, or free space on ` +
			`this device, and try again.`
	);
}

/**
 * The transaction: the marker, the before-images, the fetch-and-verify, the deletions, the commit.
 *
 * @returns the total bytes written
 * @throws UpdateRefusedError, having put the Workspace back as it was — or `'unresolved-residue'`
 */
async function transfer(
	store: ProjectStore,
	source: { read(path: StorePath): Promise<Bytes> },
	remote: RemoteRelationship,
	files: readonly PlannedFile[],
	removals: readonly StorePath[],
	commit: string,
	options: UpdateFromGitHubOptions
): Promise<number> {
	const now = options.now ?? (() => new Date());
	const marker: UpdateTransaction = {
		formatVersion: UPDATE_TRANSACTION_FORMAT_VERSION,
		transaction: options.transaction?.() ?? crypto.randomUUID(),
		workspace: options.workspace ?? '',
		state: 'writing',
		commit,
		added: files
			.filter((file) => file.effect === 'add')
			.map((file) => file.path)
			.sort(),
		replaced: files
			.filter((file) => file.effect === 'replace')
			.map((file, index) => ({
				path: file.path,
				// Numbered rather than named after the path: a before-image whose name is derived from the
				// path it protects is a path this Workspace could already hold.
				image: `${UPDATE_BEFORE_DIRECTORY}${index}` as StorePath
			}))
			.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
		// ⚠ **A separate numbering, prefixed**, so a deletion's before-image can never be given the
		// same name as a replacement's — which would be one of the two paths silently never given back.
		deleted: removals.map((path, index) => ({
			path,
			image: `${UPDATE_BEFORE_DIRECTORY}d${index}` as StorePath
		})),
		startedAt: now().toISOString()
	};

	const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
	let written = 0;
	let bytes = 0;
	const report = (path: string | null): void =>
		options.onProgress?.({ files: written, totalFiles: files.length, bytes, totalBytes, path });

	await store.write(UPDATE_TRANSACTION_PATH, serialiseUpdateTransaction(marker));
	try {
		report(null);
		for (const { path, image } of [...marker.replaced, ...marker.deleted]) {
			await store.write(image, await store.read(path));
		}
		await eachInTurn(files, UPDATE_DOWNLOAD_CONCURRENCY, async (file) => {
			const content = file.fetched ?? (await fetchVerified(source, remote, file.path, file.sha));
			await writeInbound(store, file.path, content, file.effect);
			written += 1;
			bytes += content.byteLength;
			report(file.path);
		});
		// ⚠ **After the writes and before the commit.** Last, because an addition that fails is then a
		// rollback that has fewer paths to put back; and inside the window, because every path here has
		// a before-image and a deletion list is carried out one path at a time. Not concurrent: there is
		// nothing to wait for, and doing them in the order the marker names them is what makes an
		// interrupted deletion list a prefix rather than a scattering.
		for (const { path } of marker.deleted) await store.delete(path);
		report(null);
		await store.write(
			UPDATE_TRANSACTION_PATH,
			serialiseUpdateTransaction({ ...marker, state: 'committed' })
		);
	} catch (cause) {
		// `return` rather than a bare call: `rollBackOrRefuse` always throws, and a `never` return says
		// so to the compiler as well as to a reader.
		return rollBackOrRefuse(store, marker, cause);
	}

	// ⚠ **Past the commit boundary, and the `try` above deliberately ends here.** Every inbound path
	// is durable, so there is nothing left to undo and a failure sweeping the residue must not reach
	// the rollback — which would take back an Update that had completely succeeded. The marker stays
	// `'committed'`, and the next Update sweeps it.
	await sweep(store, marker).catch(() => {});
	return bytes;
}

/** Put the Workspace back, then refuse. See {@link UpdateRefusal} `'unresolved-residue'`. */
async function rollBackOrRefuse(
	store: ProjectStore,
	marker: UpdateTransaction,
	cause: unknown
): Promise<never> {
	try {
		await rollBack(store, marker);
	} catch (residue) {
		throw new UpdateRefusedError('unresolved-residue', unresolvedResidueMessage(), {
			cause: residue
		});
	}
	if (cause instanceof UpdateRefusedError) throw cause;
	throw new UpdateRefusedError('write-failed', writeFailedMessage(cause), { cause });
}

/**
 * Fetch one blob and check it against the SHA the listing named.
 *
 * ⚠ **The check is not optional and it is nearly free**, `cloneFromRemote`'s argument exactly: the
 * bytes are already in memory, and without it a proxy or a cache serving a rewritten copy replaces
 * the author's file with something nothing has vouched for — and the Baseline then records those
 * bytes as shared, so no later comparison can find it.
 */
async function fetchVerified(
	source: { read(path: StorePath): Promise<Bytes> },
	remote: RemoteRelationship,
	path: StorePath,
	sha: string
): Promise<Bytes> {
	let content: Bytes;
	try {
		content = await source.read(path);
	} catch (cause) {
		throw new UpdateRefusedError('incomplete', missingFileMessage(remote, path, cause), {
			paths: [path]
		});
	}
	if ((await gitBlobSha(content)) !== sha) {
		throw new UpdateRefusedError('incomplete', corruptFileMessage(remote, path), { paths: [path] });
	}
	return content;
}

/**
 * Write one inbound file, sending an Alignment through the one writer (ADR-0023).
 *
 * Routed for `restore-workspace-tar.ts`'s reason, and it is the same situation: the path arrives as
 * *data* — an entry in somebody else's tree — so neither the `AlignmentPath` brand nor
 * `scripts/check-alignment-writers.mjs` can see it, and "the Update writes Alignments with the
 * generic writer" would be a true statement about the codebase that the next person reads as
 * permission.
 *
 * The intent is the operation's, said out loud. An `'add'` is a Map Image this Workspace does not
 * have an Alignment for at all; a `'replace'` is one whose Alignment was byte-identical to the
 * Baseline, so the Control Points being written over are the ones the Remote already held; and a
 * `'restore'` is a rollback putting back the bytes this very operation displaced.
 */
async function writeInbound(
	store: ProjectStore,
	path: StorePath,
	bytes: Bytes,
	effect: 'add' | 'replace' | 'restore'
): Promise<void> {
	const imageId = alignmentImageId(path);
	if (imageId === null) {
		await store.write(path, bytes);
		return;
	}
	const outcome = await writeAlignmentBytes(
		{
			read: (at) => store.read(at),
			commit: (at, content) => store.write(at, content)
		},
		{
			imageId,
			bytes,
			write:
				effect === 'add'
					? { intent: 'create' }
					: {
							intent: 'replace',
							discarding:
								effect === 'replace'
									? 'the Alignment this Workspace and GitHub last shared for this Map Image'
									: 'the Alignment an Update from GitHub had written, which is being taken back'
						}
		}
	);
	// Unreachable while the plan is made from a complete hashing pass — an `'add'` is a path the
	// Workspace does not hold — and refused rather than counted as written, because a declined
	// Alignment that the Baseline then recorded as shared is Control Points nothing will look at again.
	if (outcome !== 'written') {
		throw new UpdateRefusedError('write-failed', declinedAlignmentMessage(path), { paths: [path] });
	}
}

/**
 * Run `work` over `items`, at most `limit` of them in flight.
 *
 * The first rejection is the one that comes out, and the workers already running are awaited before
 * it does — so a rollback never starts while a write is still on its way to the disk it is about to
 * put back.
 */
async function eachInTurn<T>(
	items: readonly T[],
	limit: number,
	work: (item: T) => Promise<void>
): Promise<void> {
	let next = 0;
	let failure: unknown = null;
	const worker = async (): Promise<void> => {
		while (failure === null) {
			const index = next++;
			if (index >= items.length) return;
			try {
				await work(items[index] as T);
			} catch (cause) {
				failure ??= cause;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	if (failure !== null) throw failure;
}

// ── What the refusals say ─────────────────────────────────────────────────────────────────────

/** A listing or a ref read that could not be had, in this module's own words. */
function asUpdateRefusal(remote: RemoteRelationship, cause: unknown): UpdateRefusedError {
	const named = describeRemote(remote);
	if (!(cause instanceof RemoteTreeRefusedError)) {
		return new UpdateRefusedError('refused', unreachableMessage(remote, cause));
	}
	switch (cause.refusal) {
		case 'no-repository':
			return new UpdateRefusedError(
				'no-repository',
				`GitHub has no public repository at ${named} any more, so there is nothing to update ` +
					`from. Nothing in this Workspace has been changed — your work is all still here.`
			);
		case 'not-public':
			return new UpdateRefusedError(
				'no-repository',
				`GitHub would not let this page read ${named} without signing in, so it is no longer a ` +
					`public repository. Updating reads GitHub anonymously and deliberately sends no ` +
					`credential, so a private Remote cannot be updated from. Nothing has been changed.`
			);
		case 'rate-limited': {
			const at = describeReset(cause.resetAt);
			return new UpdateRefusedError(
				'rate-limited',
				`GitHub's hourly limit for anonymous readers has been used up, so ${named} could not be ` +
					`read. Nothing is wrong with it: updating reads GitHub without signing in, which allows ` +
					`60 requests an hour for each internet connection, so on a shared one — a university ` +
					`network, a classroom — everybody's reading counts together. ` +
					`${at === '' ? 'Wait until the limit resets and try again' : `Try again after ${at}`}. ` +
					`Nothing has been changed.`
			);
		}
		case 'empty':
			return new UpdateRefusedError(
				'empty',
				`${named} has nothing in it — no files, no branches, nothing to bring down. Nothing has ` +
					`been changed.`
			);
		case 'truncated':
			return new UpdateRefusedError(
				'truncated',
				`GitHub could only list the first ${cause.listed} files in ${named}, so Ballastella ` +
					`cannot know what the rest of them are. Updating from a partial list would take some ` +
					`of somebody's work and silently treat the rest as deleted, so nothing has been ` +
					`changed. That repository has to hold fewer files before it can be updated from.`
			);
		case 'unreachable':
			return new UpdateRefusedError('refused', unreachableMessage(remote, cause.detail));
		case 'refused':
			return new UpdateRefusedError(
				'refused',
				`GitHub refused to read ${named}: ${cause.detail}. Nothing has been changed.`
			);
	}
}

/**
 * Refuse a get the plan will not support, **before anything is written**.
 *
 * ⚠ **Three refusals and no others.** A Remote holding work this Workspace has not taken in is what
 * a get is *for*; a Workspace holding work the Remote has not got is left alone; and with no
 * Baseline nothing is removed in either direction. What is left is the Conflict — the one row of the
 * three-way table with no safe answer — and the two ways the prospective Workspace cannot be
 * judged at all.
 *
 * ⚠ **No deletion confirmation.** Every removal a get would make is on the Sync modal the author
 * read before pressing, so a second question here would be the same question twice — and a
 * confirmation people meet twice is one they learn to press through (ADR-0044).
 */
function assertGettable(remote: RemoteRelationship, plan: WorkspaceSyncPlan): void {
	const named = describeRemote(remote);
	const graph = plan.comparison.graph;
	if (graph.outcome === 'failed') {
		const unsupported = graph.failures.find((failure) => failure.kind === 'unsupported');
		throw new UpdateRefusedError(
			unsupported ? 'unsupported' : 'invalid',
			unsupported
				? `${unsupported.path} on ${named} was written by a newer version of Ballastella than ` +
						`this one, so this browser cannot tell whether the result would be complete. Update ` +
						`Ballastella and try again; updating with this version could silently drop work its ` +
						`author can see. Nothing has been changed.`
				: `What ${named} holds could not be checked over: ${describeGraphFailure(graph.failures)} ` +
						`Nothing has been changed, because a result this app cannot check is one it cannot ` +
						`promise to open.`,
			{ paths: graph.failures.map((failure) => failure.path).sort() }
		);
	}
	if (graph.outcome === 'invalid') {
		throw new UpdateRefusedError('invalid', describeGraphViolations(graph.violations), {
			paths: graph.violations.map((violation) => violation.path).sort()
		});
	}
	if (plan.conflicts.length > 0) {
		const paths = plan.conflicts.map((row) => row.path);
		throw new UpdateRefusedError(
			'conflict',
			`${describeConflict(paths)} Nothing on GitHub has been changed either, and both versions ` +
				`are still where they were.`,
			{ paths }
		);
	}
}

function missingFileMessage(remote: RemoteRelationship, path: string, cause: unknown): string {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return (
		`${describeRemote(remote)} listed ${path}, but it could not be downloaded: ${detail}. The ` +
		`Update has stopped rather than leave this Workspace holding half of somebody's changes, and ` +
		`everything it had already written has been put back exactly as it was.`
	);
}

function corruptFileMessage(remote: RemoteRelationship, path: string): string {
	return (
		`${path} arrived from ${describeRemote(remote)} as different bytes from the ones its file list ` +
		`named, so the Update has stopped rather than keep a file it cannot vouch for. Something ` +
		`between this browser and GitHub — a proxy, or a cache — served a rewritten copy. Everything ` +
		`this Update had already written has been put back, and trying again fetches that file afresh.`
	);
}

function unreadableWorkspaceMessage(cause: unknown): string {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return (
		`Updating from GitHub reads every file in this Workspace first, so that a change made outside ` +
		`Ballastella is never mistaken for one of GitHub's — and this Workspace could not be read: ` +
		`${detail}. Nothing has been changed.`
	);
}

function writeFailedMessage(cause: unknown): string {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return (
		`A file could not be written into this Workspace, so the Update has stopped: ${detail}. ` +
		`Everything it had already written has been put back exactly as it was, and nothing on GitHub ` +
		`has been touched.`
	);
}

function declinedAlignmentMessage(path: string): string {
	return (
		`${path} could not be written, because this Workspace turned out to already hold an Alignment ` +
		`for that Map Image. The Update has stopped and everything it had already written has been put ` +
		`back, rather than record work as shared with GitHub that is not.`
	);
}

function unresolvedResidueMessage(): string {
	return (
		`An Update from GitHub failed, and the files it had already changed could not be put back — so ` +
		`this Workspace holds part of what GitHub sent. Nothing has been lost: reload this page and ` +
		`Ballastella will finish undoing it before anything else touches this Workspace.`
	);
}

function unreachableMessage(remote: RemoteRelationship, cause: unknown): string {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return (
		`GitHub could not be reached, so ${describeRemote(remote)} could not be read. The browser ` +
		`reported: ${detail}. This is about the connection rather than about that repository, and ` +
		`everything in this Workspace is exactly as it was.`
	);
}

/** What a successful Update says it did, in the words a scholar reads. */
function updateNotice(
	remote: RemoteRelationship,
	plan: WorkspaceSyncPlan,
	files: readonly PlannedFile[],
	removals: readonly StorePath[]
): string {
	const named = describeRemote(remote);
	if (files.length === 0 && removals.length === 0) {
		return (
			`${named} holds nothing this Workspace does not already have, so nothing has been ` +
			`downloaded.` +
			(plan.retained.length === 0
				? ''
				: ` Your own ${count(plan.retained.length, 'unpublished change')} ` +
					`${plan.retained.length === 1 ? 'is' : 'are'} still here to publish.`)
		);
	}
	const retained =
		plan.retained.length === 0
			? ''
			: ` Your own ${count(plan.retained.length, 'unpublished change')} ` +
				`${plan.retained.length === 1 ? 'was' : 'were'} left untouched and ` +
				`${plan.retained.length === 1 ? 'is' : 'are'} still there to publish.`;
	if (files.length === 0) {
		return (
			`Removed ${count(removals.length, 'file')} from this Workspace, which ${named} no longer ` +
			`has. Nothing has been published: ${named} is exactly as it was.${retained}`
		);
	}
	const added = files.filter((file) => file.effect === 'add').length;
	const replaced = files.length - added;
	const brought = [
		added === 0 ? '' : `${count(added, 'new file')}`,
		replaced === 0 ? '' : `${count(replaced, 'changed file')}`
	]
		.filter((part) => part !== '')
		.join(' and ');
	// ⚠ **A deletion is reported in the same breath as what arrived, never left implicit.** The
	// author confirmed it, which is precisely why the report has to say it happened: a confirmation
	// followed by a notice about new files only is one they cannot tell from a refusal.
	const took =
		removals.length === 0 ? '' : ` Removed ${count(removals.length, 'file')} GitHub no longer has.`;
	return (
		`Brought ${brought} into this Workspace from ${named}.${took} Nothing has been published: ` +
		`${named} is exactly as it was.${retained}`
	);
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
