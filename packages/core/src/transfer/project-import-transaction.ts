// The destination half of Project Import: one closure written once, under one recoverable marker
// (ADR-0037).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS ONE-COPY STAGING AND NOT A STAGING TREE
//
// `ProjectStore` has an atomic single-file `write` (ADR-0017 rule 4) and no multi-file transaction,
// deliberately: the interface is six methods and a folder-like backend has to fit it unchanged. So
// "either the whole Project arrives or none of it does" has to be built out of one-file writes, and
// there are only two ways to do that. The usual one — write everything to a staging tree, then move
// it into place — needs room for **two copies of the closure**, and a closure here is a pyramid: an
// author importing a 600 MB scan on an iPad would be refused for want of 1.2 GB, to protect them
// from a failure that costs them nothing but a retry.
//
// The other way is available only because every destination path is *fresh*. Import allocates a new
// Project directory and a new identity for every incoming Map Image (ADR-0037, and the allocation is
// `project-import-remapping.ts`'s and `project-import-allocation.ts`'s), so no byte it writes can be
// a byte the user already has. Provisional bytes can therefore go straight to their final paths, and
// what makes them provisional is not where they are but that **one durable marker names them**. The
// marker is the transaction: while it is unresolved the Workspace does not open, and the closure is
// either finished or swept.
//
// ⚠ **This is not Update's protocol and must not be generalised into one.** Update replaces paths
// that already hold the user's work, so it cannot write provisionally at the destination and needs
// recoverable before-images instead. The whole argument above rests on freshness.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE WORKSPACE IS GATED RATHER THAN THE READERS FILTERED
//
// Provisional files sit at ordinary Workspace paths, so *every* reader would otherwise see them: the
// Project list is whichever directories hold a `project.json` (ADR-0008), the Map Image list is
// whatever is under `images/`, and Workspace size, Backup and Publish all walk `list`. Teaching each
// of those to skip a transaction's paths is five filters, and the sixth reader written next year is
// the bug — the same argument `review-workspace.ts` makes about containment being structural rather
// than filtered.
//
// So there is one gate: an unresolved marker means the Workspace is **unavailable**, and nothing
// enumerates anything until startup recovery resolves it (`project-import-recovery.ts`).
// {@link readImportTransaction} is the whole of the question a caller asks, and a marker that will
// not parse counts as one — "unreadable is not absent", pointing the same way it points in
// `review-workspace.ts` and `alignment-file.ts`.

import { alignmentPath } from '../alignment/alignment.js';
import { writeAlignmentBytes } from '../alignment/alignment-file.js';
import { PROJECT_FILE_NAME } from '../project/project-file.js';
import { describeBytes } from '../project/workspace-size.js';
import { foldName, hoistedImageId } from '../project/workspace.js';
import {
	InvalidPathError,
	PathNotFoundError,
	assertStorePath,
	type Bytes,
	type ProjectStore,
	type ReadOnlyProjectStore,
	type StorePath
} from '../store/project-store.js';
import type { ClosurePath, ProjectImportSource } from './project-import-source.js';
import type { EstimateStorage } from './restore-workspace-tar.js';

/**
 * Where the marker lives, relative to the Workspace root.
 *
 * A top-level *file*, which cannot collide with a Project for the same reason `review.json` cannot:
 * `listProjects` matches only `<directory>/project.json` (ADR-0008), and `toDirectoryName` produces
 * a slug with no `.` in it, so no Project directory can be called this.
 */
export const IMPORT_TRANSACTION_PATH = 'import.json' as StorePath;

/**
 * The format version of the marker itself.
 *
 * Separate from a Project's `formatVersion` and deliberately not refused for being from the future.
 * A marker this build cannot read must still count as a marker — see {@link readImportTransaction} —
 * because the safe direction is to keep a Workspace shut over one that turned out to be fine, never
 * to open one holding half a Project.
 */
export const IMPORT_TRANSACTION_FORMAT_VERSION = 1;

/** How far a transaction has got. */
export type ImportTransactionState =
	/** The closure is being written. Nothing about it is durable yet, so it is swept on recovery. */
	| 'writing'
	/** Every final path is durable. What is left is bookkeeping, so it is finished on recovery. */
	| 'committed';

/** What an unresolved Import transaction says about itself. */
export interface ImportTransaction {
	readonly formatVersion: number;
	/** Names this transaction, so a log or a recovery report can say which one it means. */
	readonly transaction: string;
	readonly state: ImportTransactionState;
	/**
	 * Where the imported `project.json` goes.
	 *
	 * Named apart from {@link ImportTransaction.paths} — which also holds it — because it is the file
	 * whose *order* is load-bearing at both ends: written last so an interrupted Import leaves
	 * orphaned files rather than a Project that lists on the hub with half its Layers missing, and
	 * removed first when a transaction is discarded, for the same reason in reverse.
	 */
	readonly project: StorePath;
	/**
	 * Every provisional final path, sorted. **The authoritative inventory.**
	 *
	 * Recovery deletes exactly these and never infers a path from a name: a sweep by prefix would
	 * delete a Map Image the user happens to have in the same shared pool (ADR-0023), and there is
	 * nothing in a path that says which transaction put it there.
	 */
	readonly paths: readonly StorePath[];
	/** ISO 8601. What a recovery report names when it says what it swept. */
	readonly startedAt: string;
}

/**
 * There is a marker and it cannot be read as one.
 *
 * A separate member rather than an {@link ImportTransaction} with an empty inventory, because those
 * are opposite instructions: an empty inventory says "nothing to sweep, open the Workspace", and this
 * says "something was in flight and what it wrote cannot be named". `project-import-recovery.ts`
 * keeps the Workspace unavailable on this rather than guessing it is safe.
 */
export interface UnreadableImportTransaction {
	readonly state: 'unreadable';
}

/** What a Workspace's marker says, when it has one. */
export type ImportTransactionMark = ImportTransaction | UnreadableImportTransaction;

/** Why an Import will not be committed. Every one of them leaves the Workspace as it was. */
export type ImportRefusal =
	/** The Workspace already has an unresolved transaction, so it is not open for another. */
	| 'import-in-progress'
	/** The planned destinations are not one fresh path per closure path. A defect, not a user error. */
	| 'plan-mismatch'
	/**
	 * A bound Workspace's Remote could not be inventoried, so nothing may be allocated against it.
	 *
	 * Refused before anything here runs (`project-import-own-remote.ts`): the directories a Project may
	 * not take include those a Remote nobody has looked at is using, and a listing that failed is no
	 * evidence that they are free.
	 */
	| 'remote-unavailable'
	/**
	 * The Project is the one this Workspace already synchronizes with its own Remote.
	 *
	 * Not an Import at all but a second, detached copy of the author's own work
	 * (`project-import-own-remote.ts`). Also refused before anything here runs.
	 */
	| 'own-remote'
	/** A destination is taken, or would be taken on a filesystem that folds names. */
	| 'destination-exists'
	/** The browser does not have room for the closure and its marker. */
	| 'insufficient-quota'
	/**
	 * It failed, and the provisional bytes could not be taken back.
	 *
	 * The one refusal that does **not** leave the Workspace as it was, which is why it is said
	 * differently: the marker is still there, so the Workspace stays shut and startup recovery gets
	 * another attempt. Announcing an ordinary failure here would be announcing it over residue.
	 */
	| 'unresolved-residue'
	/**
	 * The closure is durable and the marker naming it could not be cleared.
	 *
	 * **The other side of the commit boundary, and the reason it is a boundary.** Nothing may be
	 * rolled back from here — the Project is on disk and complete — but the Workspace is still shut,
	 * because the marker is what shuts it. So this is neither a success to announce nor a failure:
	 * recovery finishes the bookkeeping on the next open and the Project is there.
	 */
	| 'unresolved-commit';

/** An Import that was not committed, with a message for the person who asked for it. */
export class ImportRefusedError extends Error {
	readonly refusal: ImportRefusal;
	/**
	 * What the closure and its marker needed, in bytes. Only on `'insufficient-quota'`.
	 *
	 * Carried so a caller can say the figure the check actually used rather than re-deriving it, and
	 * so the one-copy accounting is assertable rather than described.
	 */
	readonly requiredBytes: number;

	constructor(
		refusal: ImportRefusal,
		message: string,
		options: { readonly requiredBytes?: number; readonly cause?: unknown } = {}
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'ImportRefusedError';
		this.refusal = refusal;
		this.requiredBytes = options.requiredBytes ?? 0;
	}
}

export function serialiseImportTransaction(transaction: ImportTransaction): Bytes {
	return new TextEncoder().encode(`${JSON.stringify(transaction, null, '\t')}\n`) as Bytes;
}

/**
 * Read a marker's bytes, or `null` when they are not a marker this build can act on.
 *
 * Tolerant about everything except the shape recovery needs. A marker from a newer build carrying
 * members this one has never heard of keeps its state and its inventory, because those are the two
 * things that decide what happens to the files; what it must not do is come back as `null`, which
 * would report the Workspace as available.
 */
export function parseImportTransaction(bytes: Bytes): ImportTransaction | null {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		return null;
	}
	if (typeof raw !== 'object' || raw === null) return null;
	const record = raw as Record<string, unknown>;
	const formatVersion = record['formatVersion'];
	const state = record['state'];
	const paths = record['paths'];
	const project = record['project'];
	if (typeof formatVersion !== 'number') return null;
	if (state !== 'writing' && state !== 'committed') return null;
	if (typeof project !== 'string' || project === '') return null;
	if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string' || path === '')) {
		return null;
	}
	return {
		formatVersion,
		transaction: typeof record['transaction'] === 'string' ? record['transaction'] : '',
		state,
		project: project as StorePath,
		paths: paths as StorePath[],
		startedAt: typeof record['startedAt'] === 'string' ? record['startedAt'] : ''
	};
}

/**
 * The transaction this Workspace has outstanding, or `null` when it has none.
 *
 * **A non-`null` answer means the Workspace is unavailable**, and that is the whole of the gate: no
 * Project list, no Map Image list, no size, no Backup, no Publish and no Project open until recovery
 * resolves it (`project-import-recovery.ts`). Nothing filters provisional paths per reader — see the
 * note at the top of this file for why that is one gate rather than six filters.
 *
 * ⚠ **Unreadable is not absent.** A marker that will not parse, and a backing that will not answer,
 * both come back as {@link UnreadableImportTransaction} rather than as `null`. Only
 * {@link PathNotFoundError} — the file genuinely is not there — means the Workspace is the user's own
 * and whole. A backing that is down therefore reports a Workspace as unavailable, which a reload
 * corrects; the cost the other way round is a Project list holding half a Project.
 */
export async function readImportTransaction(
	store: ReadOnlyProjectStore
): Promise<ImportTransactionMark | null> {
	let bytes: Bytes;
	try {
		bytes = await store.read(IMPORT_TRANSACTION_PATH);
	} catch (cause) {
		if (cause instanceof PathNotFoundError) return null;
		return { state: 'unreadable' };
	}
	return parseImportTransaction(bytes) ?? { state: 'unreadable' };
}

export interface CommitProjectImportOptions {
	/**
	 * `navigator.storage.estimate()`, injected so the quota refusal is provokable in a test.
	 *
	 * Silent when the browser will not answer: refusing because the API is unavailable would refuse
	 * on Safari, and an Import that fails part way is recoverable while one that cannot be attempted
	 * is not. Same decision, and the same reason, as `openProjectBundle`'s.
	 */
	readonly estimateStorage?: EstimateStorage;
	readonly now?: () => Date;
	/** Names the transaction. Injected so a test's marker is byte-for-byte predictable. */
	readonly transaction?: () => string;
}

/** What an Import put in the Workspace. */
export interface ImportedProject {
	readonly transaction: string;
	readonly files: number;
	readonly bytes: number;
}

/**
 * Copy one validated closure into the Workspace, atomically as far as any reader can tell.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * **THE ORDER IS THE DESIGN, AND IT IS THE OPPOSITE ORDER FROM A REVIEW**
 *
 * `openProjectBundle` cannot validate before it writes, because a tar has no index and its
 * destination is a Review Workspace that gets discarded whole if anything is wrong. Neither excuse
 * is available here: the closure was validated from a listing before this was called
 * (`project-import-source.ts`), and the destination is the user's own Workspace, where nothing may be
 * discarded. So:
 *
 * 1. **A Workspace with an unresolved transaction is refused outright.** A second marker would
 *    overwrite the first's inventory, which is the one record of what the first wrote.
 * 2. **The complete final path set is computed and validated**: one fresh destination for every
 *    closure path and nothing else, each a usable store path, none of them the marker's, and no two
 *    of them the same file on a filesystem that folds case or composition.
 * 3. **No destination may exist or alias something that exists.** One `list` of the Workspace, folded
 *    on both sides — `foldName`'s rule, because a destination that is `Images/x` to this code and
 *    `images/x` to APFS is an overwrite of the user's work that does not throw, does not log, and
 *    shows up as somebody's Control Points quietly gone.
 * 4. **Quota is checked for one closure plus the marker**, and refused with the numbers in it.
 * 5. **The marker is written, durably, naming every provisional path.** From here the Workspace is
 *    unavailable, so nothing the following steps write can be enumerated by anything.
 * 6. **Every closure file except the manifest is written to its final path**, one at a time, peak
 *    memory one file. An Alignment goes through `writeAlignmentBytes` like every other copier of a
 *    document somebody else's build wrote (ADR-0023, `alignment-file.ts`).
 * 7. **`project.json` is written last**, from the bytes the source held back verbatim.
 * 8. **The marker is rewritten as committed, and only then removed.** Between those two the
 *    transaction is durably finished, so an interruption there is completed rather than swept.
 *
 * Anything that fails from step 5 on takes back every path the marker names and then removes the
 * marker, so the failure the caller sees is one the Workspace has already been restored from. If that
 * cleanup cannot finish, the marker stays and the refusal says so instead: announcing an ordinary
 * failure over residue is the one thing this must not do.
 *
 * @throws ImportRefusedError
 * @throws ImportSourceRefusedError if the source stops short of the closure it declared
 */
export async function commitProjectImport(
	store: ProjectStore,
	source: ProjectImportSource,
	destinations: ReadonlyMap<ClosurePath, StorePath>,
	options: CommitProjectImportOptions = {}
): Promise<ImportedProject> {
	const outstanding = await readImportTransaction(store);
	if (outstanding !== null) {
		throw new ImportRefusedError(
			'import-in-progress',
			'This Workspace has an Import that has not finished, so another cannot start until it has ' +
				'been recovered. Reopen the Workspace and try again.'
		);
	}

	const plan = validatePlan(source, destinations);
	await assertDestinationsFree(store, plan.paths);

	const now = options.now ?? (() => new Date());
	const marker: ImportTransaction = {
		formatVersion: IMPORT_TRANSACTION_FORMAT_VERSION,
		transaction: options.transaction?.() ?? crypto.randomUUID(),
		state: 'writing',
		project: plan.project,
		paths: plan.paths,
		startedAt: now().toISOString()
	};
	await assertRoomToImport(source, marker, options.estimateStorage);

	await store.write(IMPORT_TRANSACTION_PATH, serialiseImportTransaction(marker));
	let written: WrittenClosure;
	try {
		written = await writeClosure(store, source, destinations, plan.project);
		await store.write(
			IMPORT_TRANSACTION_PATH,
			serialiseImportTransaction({ ...marker, state: 'committed' })
		);
	} catch (cause) {
		// `return` rather than a bare call: `discardOrRefuse` always throws, and a `never` return is
		// how that is said to the compiler as well as to a reader.
		return discardOrRefuse(store, marker, cause);
	}

	// ⚠ **Past the commit boundary, and the `try` above deliberately ends here.** The marker is
	// durably committed, so every final path is durable and there is nothing left to undo. Clearing
	// it inside that `try` would put a failed `delete` on the rollback path, where it would discard a
	// Project that had arrived complete — the loss this whole protocol exists to prevent, reached
	// through the machinery built to prevent it.
	try {
		await clearImportTransaction(store);
	} catch (cause) {
		throw new ImportRefusedError(
			'unresolved-commit',
			'The Project was Imported and this Workspace’s record of the Import could not be cleared, ' +
				'so it stays closed until it is reopened. Nothing has been lost — reopen the Workspace ' +
				'and the Project will be there.',
			{ cause }
		);
	}
	return { transaction: marker.transaction, ...written };
}

/**
 * Remove a transaction's provisional paths and then its marker.
 *
 * **The manifest goes first**, so no moment exists in which a Project directory holds a
 * `project.json` and none of the files its Layers name; **the marker goes last**, so an interruption
 * part way through this leaves the inventory intact for the next attempt. Both `delete`s are
 * idempotent (ADR-0001), which is what makes running this twice — a failed Import, then startup
 * recovery — the same as running it once.
 *
 * Deletes exactly what the marker names. Never a prefix sweep: `images/` and `alignments/` are the
 * Workspace's shared pool (ADR-0023) and hold the user's own maps beside the provisional ones.
 */
export async function discardImportTransaction(
	store: ProjectStore,
	transaction: ImportTransaction
): Promise<void> {
	await store.delete(transaction.project);
	for (const path of transaction.paths) {
		if (path !== transaction.project) await store.delete(path);
	}
	await clearImportTransaction(store);
}

/**
 * Remove the marker, which is what makes the Workspace available again.
 *
 * The last step of a commit and the last step of a recovery, so it is one function rather than the
 * same `delete` written twice. Idempotent, like every `ProjectStore.delete`.
 */
export async function clearImportTransaction(store: ProjectStore): Promise<void> {
	await store.delete(IMPORT_TRANSACTION_PATH);
}

/** The final path set, once it has been proved to be one. */
interface DestinationPlan {
	readonly project: StorePath;
	readonly paths: readonly StorePath[];
}

/**
 * Prove the plan is one fresh destination per closure path, and nothing else.
 *
 * ⚠ **A refusal here is a defect in the caller, not something a user did.** Allocating the paths is
 * `remapProjectImport` and `allocateProjectImport`'s job and this consumes what they allocated; the
 * checks exist because the inventory this produces is the only record of what an interrupted Import
 * wrote, and an inventory that is missing a path or names one twice cannot be recovered from.
 */
function validatePlan(
	source: ProjectImportSource,
	destinations: ReadonlyMap<ClosurePath, StorePath>
): DestinationPlan {
	const paths: StorePath[] = [];
	const folded = new Map<string, StorePath>();

	for (const closure of source.paths) {
		const destination = destinations.get(closure);
		if (destination === undefined) {
			throw new ImportRefusedError(
				'plan-mismatch',
				`The Import was planned without a destination for “${closure}”, so the Project would ` +
					'arrive incomplete. Nothing has been added to your Workspace.'
			);
		}
		try {
			assertStorePath(destination);
		} catch (cause) {
			if (!(cause instanceof InvalidPathError)) throw cause;
			throw new ImportRefusedError(
				'plan-mismatch',
				`The Import was planned to put “${closure}” at “${destination}”, which is not a path ` +
					`this Workspace can hold: ${cause.message}. Nothing has been added to your Workspace.`
			);
		}
		if (destination === IMPORT_TRANSACTION_PATH) {
			throw new ImportRefusedError(
				'plan-mismatch',
				`The Import was planned to put “${closure}” at “${destination}”, which is the name the ` +
					'Workspace keeps for its own record of an Import in progress. Nothing has been added ' +
					'to your Workspace.'
			);
		}
		const key = foldName(destination);
		const taken = folded.get(key);
		if (taken !== undefined) {
			throw new ImportRefusedError(
				'plan-mismatch',
				`The Import was planned to put two of its files at “${destination}”${
					taken === destination ? '' : ` and “${taken}”, which are one file on this computer`
				}, so one would overwrite the other. Nothing has been added to your Workspace.`
			);
		}
		folded.set(key, destination);
		paths.push(destination);
	}

	if (destinations.size !== paths.length) {
		throw new ImportRefusedError(
			'plan-mismatch',
			'The Import was planned to write files the Project does not hold. Nothing has been added ' +
				'to your Workspace.'
		);
	}

	const project = destinations.get(PROJECT_FILE_NAME);
	// Unreachable while the source guarantees a manifest, which `createProjectImportSource` refuses
	// without. Said anyway: `paths` is what recovery works from, and the file whose order both ends
	// depend on must be a fact about the inventory rather than one about the caller.
	if (project === undefined) {
		throw new ImportRefusedError(
			'plan-mismatch',
			`The Import was planned without a destination for ${PROJECT_FILE_NAME}. Nothing has been ` +
				'added to your Workspace.'
		);
	}

	return { project, paths: [...paths].sort() };
}

/**
 * Refuse a destination that is taken, **folded on both sides** (`foldName`'s rule).
 *
 * One `list` of the whole Workspace rather than a `size` per destination: a closure is thousands of
 * tiles, the answer needs the *existing* spellings anyway to fold them, and `list` is the one call
 * both real backings answer from directory metadata.
 */
async function assertDestinationsFree(
	store: ProjectStore,
	destinations: readonly StorePath[]
): Promise<void> {
	const existing = new Map<string, StorePath>();
	for (const path of await store.list('')) existing.set(foldName(path), path);

	for (const destination of destinations) {
		const held = existing.get(foldName(destination));
		if (held === undefined) continue;
		throw new ImportRefusedError(
			'destination-exists',
			`This Workspace already holds “${held}”, and the Import was about to write ` +
				`“${destination}” there. Nothing has been added to your Workspace.`
		);
	}
}

/**
 * Refuse an Import there is no room for, **before the marker exists**.
 *
 * ⚠ **One closure plus its marker, and not a byte more.** That figure is the point of the whole
 * one-copy protocol: a staging tree would have to ask for two closures, which for a pyramid is the
 * difference between an Import a scholar can do on an iPad and one they cannot. The marker is counted
 * *twice* because `ProjectStore.write` is a temp file and a rename (ADR-0017 rule 4), so a document
 * being written peaks at two copies of itself — which for one JSON document listing the closure's
 * paths is a bounded allowance, and for the closure's own files is a transient the source's declared
 * total does not pretend to model.
 */
async function assertRoomToImport(
	source: ProjectImportSource,
	marker: ImportTransaction,
	estimateStorage: EstimateStorage | undefined
): Promise<void> {
	if (!estimateStorage) return;
	const estimate = await estimateStorage().catch(() => null);
	const quota = estimate?.quota;
	const usage = estimate?.usage;
	if (typeof quota !== 'number' || typeof usage !== 'number') return;

	const metadata = 2 * serialiseImportTransaction({ ...marker, state: 'committed' }).byteLength;
	const required = source.totalBytes + metadata;
	const free = quota - usage;
	if (free >= required) return;

	throw new ImportRefusedError(
		'insufficient-quota',
		`This Project needs about ${describeBytes(required)} and there is ${describeBytes(
			Math.max(0, free)
		)} free — ${describeBytes(usage)} of the ${describeBytes(quota)} this browser allows is ` +
			`already in use. Delete a Project or a Workspace you no longer need, or free space on this ` +
			`device, and try again. Nothing has been added to your Workspace.`,
		{ requiredBytes: required }
	);
}

/** What the closure weighed on the way in. */
interface WrittenClosure {
	readonly files: number;
	readonly bytes: number;
}

/**
 * Write every closure file to its planned path, the manifest last.
 *
 * The manifest's bytes come from {@link ProjectImportSource.projectFileBytes} rather than from the
 * stream, which is what the source holds them apart for: a Workspace's list of Projects *is*
 * whichever directories hold a `project.json` (ADR-0008), so it cannot be written in whatever order
 * the source happens to be cheapest in.
 */
async function writeClosure(
	store: ProjectStore,
	source: ProjectImportSource,
	destinations: ReadonlyMap<ClosurePath, StorePath>,
	project: StorePath
): Promise<WrittenClosure> {
	let files = 0;
	let bytes = 0;
	for await (const file of source.files()) {
		if (file.path === PROJECT_FILE_NAME) continue;
		// Present: `validatePlan` walked the same `source.paths` the stream delivers.
		await writeImported(store, destinations.get(file.path) as StorePath, file.bytes);
		files += 1;
		bytes += file.bytes.byteLength;
	}
	await store.write(project, source.projectFileBytes);
	return { files: files + 1, bytes: bytes + source.projectFileBytes.byteLength };
}

/**
 * Put one imported file at its destination, routing an Alignment through its owner.
 *
 * The path is runtime data — the plan's, built from an identity allocated for this Import — so
 * neither `WritablePath` nor `check-alignment-writers.mjs` can see it, exactly as in the two tar
 * readers and `clone-from-remote.ts`. It is routed for the reason `alignment-file.ts` gives: "the
 * Import engine writes Alignments with the generic writer" would be a true statement about the
 * codebase that the next person reads as permission.
 *
 * The bytes go through verbatim — `writeAlignmentBytes`, not `writeAlignmentFile` — because what is
 * being copied is a document another build wrote, and re-serialising it from this build's model would
 * silently drop every member this build cannot model.
 *
 * A decline cannot happen: the destination was proved absent in preflight and no two closure paths
 * share one. It is a failure rather than a shrug if it ever does, because the Alignment it kept would
 * belong to a Map Image identity this Import invented.
 */
async function writeImported(
	store: ProjectStore,
	destination: StorePath,
	bytes: Bytes
): Promise<void> {
	const shared = hoistedImageId(destination);
	if (shared === null || destination !== alignmentPath(shared)) {
		await store.write(destination, bytes);
		return;
	}
	const outcome = await writeAlignmentBytes(
		{
			read: (at) => store.read(at),
			commit: (at, content) => store.write(at, content)
		},
		{ imageId: shared, bytes, write: { intent: 'create' } }
	);
	if (outcome !== 'written') {
		throw new Error(`${destination} already held an Alignment, which preflight ruled out`);
	}
}

/**
 * Take back what the transaction wrote and re-throw, or refuse over the residue.
 *
 * The original failure is re-thrown as itself once the Workspace has been restored: an
 * `ImportSourceRefusedError` already ends on "Nothing has been added to your Workspace", and that
 * sentence is now *true* — wrapping it would replace a message that names the missing file with one
 * that does not. Only when the residue is still there does the refusal change, because then the
 * sentence would be a lie and the Workspace is shut rather than unchanged.
 *
 * @returns never
 */
async function discardOrRefuse(
	store: ProjectStore,
	marker: ImportTransaction,
	cause: unknown
): Promise<never> {
	try {
		await discardImportTransaction(store, marker);
	} catch (residue) {
		throw new ImportRefusedError(
			'unresolved-residue',
			'The Import failed and what it had already written could not be removed, so this Workspace ' +
				'stays closed until it has been recovered. Reopen it to finish clearing the Import.',
			{ cause: residue }
		);
	}
	throw cause;
}
