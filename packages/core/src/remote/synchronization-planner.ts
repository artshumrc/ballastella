// The three-way comparison between a Workspace, its Remote, and what the two last shared (ADR-0033).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// PURE, AND THAT IS THE WHOLE DESIGN
//
// Nothing here reads a `ProjectStore`, fetches GitHub, writes a file, or advances a Baseline. It is
// handed three `path → blob SHA` inventories and returns a value. Every hard question in
// synchronization — *is this my work or somebody else's, and what happens if I take theirs* — is
// then answerable in a table-driven test with no browser, no network, and no transfer, which is the
// only way the states below can be exhaustively covered at all.
//
// The callers supply the I/O: an Open, a status check, and the two halves of a Sync. They all ask
// the same three functions the same question.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ONE TABLE, AND ADDITIONS AND DELETIONS ARE ROWS OF IT
//
// A path's evidence on each of the three sides is *absent, or a blob SHA*. That is deliberate and it
// is the load-bearing simplification: an addition is `B` absent, a deletion is `L` absent, and both
// are compared by the same equality as an edit. The alternative — separate rules for added, changed
// and deleted — is three tables that have to agree, and the row they disagreed on was "deleted here,
// edited there", which is a Conflict under the table and was an ordinary deletion under the rules.
//
// The table, per path, against Baseline `B`, local `L` and Remote `R`:
//
//   L = B and R = B                     shared
//   L != B and R = B                    outbound     (changes to send)
//   L = B and R != B                    inbound      (changes to get)
//   L != B and R != B and L = R         converged    (shared bytes; a Baseline may advance)
//   L != B and R != B and L != R        conflict
//
// with `B` absent throughout where there is no Baseline at all — see below.
//
// The Workspace's status is that table aggregated: no Baseline is Cannot tell, then outbound *and*
// inbound together is Changes both ways, then whichever of the two is present alone, and otherwise
// In sync. `converged` is In sync on purpose — the two sides agree about the bytes and only the
// Baseline is behind. A `conflict` row counts as **both** directions at once, which is what it is:
// there is something here the Remote has not got and something there this Workspace has not got.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE COMBINATION CAN BE BROKEN WHEN NO SINGLE PATH IS
//
// A combination of individually separate changes is refused when it would violate a Workspace
// invariant — as a {@link GraphVerdict} rather than as a status, because "these two changes do not
// add up" is not a direction and a badge that reported it as one would be wrong about which side has
// work outstanding. A map Layer added here while its pyramid is deleted there is two
// perfectly attributable changes at two different paths, and the Workspace they add up to cannot
// draw. So the plan's chosen bytes are assembled into a prospective path set and the Workspace's own
// invariants are asked of it, through `gatherProjectClosure` — the same closure check Import uses, so
// a Layer kind added later cannot mean one thing to an Import and another to a get.
//
// ⚠ **A Remote that cannot be read is an operation failure, never a verdict.** A `project.json` that
// will not parse, one from a newer format version, or one whose bytes were never supplied is not
// `In sync` and not `Conflict`: those two are claims about scholarship, and this is a claim about
// the transfer. {@link GraphVerdict} keeps them apart.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// NO BASELINE IS AN EMPTY BASELINE TO A PLAN, AND `Cannot tell` TO A STATUS
//
// The two questions are different and were once answered by one value. *What has changed* is a claim
// about **attribution**, and with no record of what the two sides last shared there is none to make:
// the Remote Status is `Cannot tell` and stays so. *What would move* is a claim about **bytes**, and
// the table answers every row of it honestly against an empty Baseline — a path only one side holds
// is that side's to offer, and a path both hold differently is a Conflict.
//
// ⚠ **And nothing may be removed, by construction rather than by a check.** A removal is an
// `outbound` or `inbound` row whose own side holds nothing, and both rows require the path to be in
// the Baseline — so an empty one yields neither. That is what makes a first Sync to a populated
// repository safe (ADR-0044), and it is why the removal rule cannot be widened "to be safe": widening
// it re-opens the case for splitting Sync back into two gestures.

import { ALIGNMENT_DIRECTORY, alignmentPath } from '../alignment/alignment.js';
import { BASE_MAP_TILE_ROOT } from '../base-map/tile-cache.js';
import { IMAGE_DIRECTORY, imageDirectory } from '../project/image-files.js';
import {
	PROJECT_FILE_NAME,
	ProjectFormatTooNewError,
	parseProjectFile,
	projectFilePath
} from '../project/project-file.js';
import { hoistedImageId } from '../project/workspace.js';
import { REFERENCED_IMAGE_FILE } from '../remote-iiif/referenced-image.js';
import { topLevelSegment } from '../store/project-store.js';
import { gatherProjectClosure } from '../transfer/project-import-source.js';
import {
	classifyInventory,
	publishedOutputDrift,
	recognisedProjectDirectories
} from './synchronization-paths.js';
import type { SynchronizationBaseline } from './synchronization-metadata.js';

/** One path and the blob SHA the side holding it gives its bytes. */
export interface InventoryEntry {
	readonly path: string;
	readonly sha: string;
}

/** What one path's three pieces of evidence add up to. See this module's header for the table. */
export type PathComparison =
	'shared' | 'outbound' | 'inbound' | 'converged' | 'conflict' | 'cannot-tell';

/**
 * The Workspace's Remote Status, as a stable value.
 *
 * ⚠ **These are not labels.** `remote-status.ts` owns the words a user reads — "In sync", "Cannot
 * tell" — and projects them from exactly these five. Nothing here should grow a sentence about a
 * status.
 *
 * ⚠ **A Conflict is not one of them** (ADR-0046). A path changed on both sides is something a Sync
 * *resolves*, into a second copy the scholar can look at or — for an Alignment — a question; so it
 * is outstanding work in both directions, which is `changes-both-ways`, and never a state of its own
 * that a badge could report as an obstruction.
 *
 * ⚠ **They are the scholar's directions, not Git's graph.** `ahead` and `behind` describe a commit
 * history nobody here is looking at, and *connected* reports that a repository was named rather than
 * that any work reached it (ADR-0044). What a Workspace has is something to send, something to get,
 * both, or neither.
 */
export type SourceStatus =
	'in-sync' | 'changes-to-send' | 'changes-to-get' | 'changes-both-ways' | 'cannot-tell';

/** One source path, with the evidence the verdict was reached from. */
export interface SourcePath {
	readonly path: string;
	readonly comparison: PathComparison;
	/** `null` for absent, on each of the three sides. */
	readonly baseline: string | null;
	readonly local: string | null;
	readonly remote: string | null;
}

/**
 * A Workspace invariant the prospective result would break.
 *
 * The kinds are the Workspace's own: a Project's files with no `project.json`, a Layer whose
 * Annotation or Map Image is not there, a pyramid nothing can open, and an Alignment left behind for
 * a map that is gone — which `deleteMapImage` calls out as the one leftover it exists to prevent.
 */
export interface GraphViolation {
	readonly kind:
		| 'missing-project-file'
		| 'missing-annotation'
		| 'missing-image'
		| 'incomplete-image'
		| 'orphan-alignment';
	/** The path that is missing, or the one left dangling. */
	readonly path: string;
	/** One sentence naming what would break, for the caller's refusal. */
	readonly detail: string;
}

/** Why the prospective result could not be judged at all. Never a verdict about scholarship. */
export interface GraphFailure {
	readonly kind: 'malformed' | 'unsupported' | 'unreadable';
	readonly path: string;
	readonly detail: string;
}

/**
 * What asking the Workspace's invariants of the prospective result answered.
 *
 * `not-checked` is what {@link SynchronizationInput.projectFiles} being absent means: a passive
 * status check has no `project.json` bytes and is not pretending to have validated anything. Supplying
 * the map — even an empty one — is a claim that it holds every `project.json` the plan chooses, so a
 * missing entry is `unreadable` rather than silently unchecked.
 */
export type GraphVerdict =
	| { readonly outcome: 'valid' }
	| { readonly outcome: 'not-checked' }
	| { readonly outcome: 'invalid'; readonly violations: readonly GraphViolation[] }
	| { readonly outcome: 'failed'; readonly failures: readonly GraphFailure[] };

/**
 * The three inventories, and the material to validate the result with.
 *
 * ⚠ **`local` must be a *complete* hashing of the Workspace for a deliberate Sync.** A
 * chosen folder can be edited by anything on the machine, so the write index `local-change-index.ts`
 * maintains is evidence about Ballastella's own writes and nothing else; a plan built from it would
 * take an inbound change over an out-of-band local edit and call it safe. The requirement is
 * on the caller because the planner has no I/O to make the pass itself — and it holds regardless of
 * the status already displayed, which the complete pass is entitled to revise.
 */
export interface SynchronizationInput {
	readonly local: Iterable<InventoryEntry>;
	readonly remote: Iterable<InventoryEntry>;
	/** `null` for no valid Baseline, which is `cannot-tell`. */
	readonly baseline: SynchronizationBaseline | null;
	/** `project.json` bytes by blob SHA. Absent means the graph is not checked at all. */
	readonly projectFiles?: ReadonlyMap<string, Uint8Array>;
}

/** The whole comparison: the Workspace's status, the table it came from, and what else differs. */
export interface WorkspaceComparison {
	readonly status: SourceStatus;
	/** Every source path any of the three inventories recognises, sorted. */
	readonly paths: readonly SourcePath[];
	/**
	 * Where the two sides' generated Published Site output differs, sorted.
	 *
	 * It never touches {@link status}: a site built by another editor version has
	 * different chunk names, which means "republish when you like" and never "somebody changed your
	 * scholarship".
	 */
	readonly publishedSiteStale: readonly string[];
	readonly graph: GraphVerdict;
}

/** One path the plan settles, and what settling it does to the Workspace. */
export interface PathChoice {
	readonly path: string;
	/** The blob SHA the plan chooses, or `null` for a path it removes. */
	readonly sha: string | null;
	readonly effect: 'add' | 'replace' | 'delete' | 'keep';
}

/** One side of a Sync: what it writes, what it removes, and what it may then record. */
export interface SyncDirection {
	/**
	 * What this direction settles, sorted.
	 *
	 * A get's are the paths to write and remove, and nothing else. A send's are every local source
	 * path its commit will hold — `keep` included, because a whole tree is posted — and deliberately
	 * *not* the paths the other side has moved past: see {@link WorkspaceSyncPlan.leftAlone}.
	 */
	readonly changes: readonly PathChoice[];
	/**
	 * Paths this direction takes off the side receiving it, sorted.
	 *
	 * ⚠ **Baseline-narrowed by construction, not by a check.** A removal is an `outbound` or
	 * `inbound` row whose own side has nothing — and both rows require a Baseline entry, so a
	 * Workspace with no Baseline has none of either. See this module's header.
	 */
	readonly removed: readonly string[];
	/** `path → blob SHA` the Baseline may advance to on success, and **only** these paths. */
	readonly advances: ReadonlyMap<string, string>;
	/** Paths the Baseline may drop, because neither side holds them any more. */
	readonly retires: readonly string[];
}

/**
 * What a Sync would settle, in both directions, from one three-way comparison.
 *
 * ⚠ **It never refuses.** A Conflict is *reported* here — {@link conflicts} — and the engine that
 * moves the bytes is what resolves it, into a copy or a question (ADR-0046). That is what lets one
 * plan answer for all four modes.
 */
export interface WorkspaceSyncPlan {
	/** What getting would bring in and take away here. */
	readonly toGet: SyncDirection;
	/** What sending would put there and take away there. */
	readonly toSend: SyncDirection;
	/**
	 * Owned Remote source paths a send leaves exactly as they are, sorted.
	 *
	 * ⚠ **This is what "sending moves nothing it should not" actually means, and it is two rules at
	 * once.** A path the Remote has moved past since the two last agreed is neither *overwritten*
	 * with this Workspace's older copy nor *removed* by being left out of the tree — a send posts a
	 * whole tree rather than an incremental one, so omission is deletion. Every one of these appears
	 * in {@link toGet} instead, which is where the author can act on it.
	 */
	readonly leftAlone: readonly string[];
	/** Remote paths outside Ballastella's namespace, carried into a send's tree untouched. */
	readonly preserved: readonly string[];
	/**
	 * What an `overwrite` would settle: the one mode whose removals come from the Workspace alone.
	 *
	 * ⚠ **{@link SyncDirection.removed} here is the one removal set that is not Baseline-narrowed.**
	 * Inside the owned namespace the Remote becomes exactly the Workspace, which is why it is named
	 * before it is carried out — and why {@link SyncDirection.advances} is the whole local source
	 * namespace rather than the part the two sides can be said to have agreed on.
	 */
	readonly toOverwrite: SyncDirection;
	/** One path changed on both sides of the Baseline. Detected here, never resolved here. */
	readonly conflicts: readonly SourcePath[];
	/**
	 * The `path → blob SHA` set a get would leave behind, which is what the graph was judged against.
	 *
	 * On the plan so that a caller adding files of its own — the Conflict Copies of ADR-0046 — can ask
	 * {@link validateProspectiveWorkspace} the same question of the result *including* them, rather
	 * than assembling a second prospective set that could disagree with this one.
	 */
	readonly prospective: ReadonlyMap<string, string>;
	/** Local-only changes a get leaves alone. Still changes to send afterwards. */
	readonly retained: readonly string[];
	readonly comparison: WorkspaceComparison;
}

/**
 * One path's three pieces of evidence, compared. `null` is absent on any of the three sides.
 *
 * **The one implementation of the table**, called by the Workspace comparison here and by
 * the send's own refusal — which asks the same question of the same three values and must not
 * answer it differently. See this module's header for the rows.
 */
export function comparePath(
	baseline: string | null,
	local: string | null,
	remote: string | null
): Exclude<PathComparison, 'cannot-tell'> {
	const localChanged = local !== baseline;
	const remoteChanged = remote !== baseline;
	if (!localChanged) return remoteChanged ? 'inbound' : 'shared';
	if (!remoteChanged) return 'outbound';
	return local === remote ? 'converged' : 'conflict';
}

// ── The comparison ────────────────────────────────────────────────────────────────────────────

/** The source inventories, split out and compared, with everything the plans need from them. */
interface SourceComparison {
	/** The rows as the caller of {@link compareWorkspace} sees them: masked where there is no Baseline. */
	readonly paths: readonly SourcePath[];
	/** The same rows carrying the table's own answer, which is what a plan is built from. */
	readonly rows: readonly SourcePath[];
	readonly byComparison: ReadonlyMap<Exclude<PathComparison, 'cannot-tell'>, readonly string[]>;
	readonly localSource: ReadonlyMap<string, string>;
	readonly remoteSource: ReadonlyMap<string, string>;
	readonly preserved: readonly string[];
	readonly publishedSiteStale: readonly string[];
	readonly hasBaseline: boolean;
}

function compareSource(input: SynchronizationInput): SourceComparison {
	const local = [...input.local];
	const remote = [...input.remote];
	const baselineFiles = input.baseline?.files ?? null;
	const baseline = [...(baselineFiles ?? new Map<string, string>())].map(([path, sha]) => ({
		path,
		sha
	}));

	// The union of all three, so a Project deleted here is still recognised as ours from the Remote or
	// the Baseline and its whole directory stays in scope (ADR-0033's "additive only" leak).
	const projects = recognisedProjectDirectories({
		local: local.map((entry) => entry.path),
		remote: remote.map((entry) => entry.path),
		baseline: baseline.map((entry) => entry.path)
	});

	const here = classifyInventory(local, projects);
	const there = classifyInventory(remote, projects);
	const localSource = new Map(here.source.map((entry) => [entry.path, entry.sha]));
	const remoteSource = new Map(there.source.map((entry) => [entry.path, entry.sha]));
	const baselineSource = new Map(
		classifyInventory(baseline, projects).source.map((entry) => [entry.path, entry.sha])
	);

	const union = [
		...new Set([...baselineSource.keys(), ...localSource.keys(), ...remoteSource.keys()])
	].sort();

	const paths: SourcePath[] = [];
	const rows: SourcePath[] = [];
	const byComparison = new Map<Exclude<PathComparison, 'cannot-tell'>, string[]>();
	for (const path of union) {
		const evidence = {
			baseline: baselineSource.get(path) ?? null,
			local: localSource.get(path) ?? null,
			remote: remoteSource.get(path) ?? null
		};
		const comparison = comparePath(evidence.baseline, evidence.local, evidence.remote);
		rows.push({ path, comparison, ...evidence });
		// ⚠ **The reported row is `cannot-tell` with no Baseline; the table's answer is kept anyway.**
		// The Remote Status is a claim about *attribution*, and with no record of what the two sides
		// last shared there is none to make. A plan is a claim about *bytes*, and against an empty
		// Baseline the table answers every row of it honestly — see this module's header.
		paths.push({
			path,
			comparison: baselineFiles === null ? 'cannot-tell' : comparison,
			...evidence
		});
		const bucket = byComparison.get(comparison);
		if (bucket === undefined) byComparison.set(comparison, [path]);
		else bucket.push(path);
	}

	const held = new Set(local.map((entry) => entry.path));
	return {
		paths,
		rows,
		byComparison,
		localSource,
		remoteSource,
		preserved: there.outside
			.filter((entry) => !held.has(entry.path))
			.map((entry) => entry.path)
			.sort(),
		publishedSiteStale: publishedOutputDrift(here.publishedOutput, there.publishedOutput),
		hasBaseline: baselineFiles !== null
	};
}

const bucket = (comparison: SourceComparison, kind: Exclude<PathComparison, 'cannot-tell'>) =>
	comparison.byComparison.get(kind) ?? [];

/**
 * The path set a get would leave behind: the Remote's bytes where they are inbound, the
 * Workspace's everywhere else.
 *
 * A contested path takes the local side, which is what a get leaves there: the Remote's version of
 * it arrives as a Conflict Copy at a path of its own (ADR-0046), which the caller making those
 * copies adds to this set before asking {@link validateProspectiveWorkspace} about the result.
 */
function prospectiveSource(comparison: SourceComparison): Map<string, string> {
	const prospective = new Map<string, string>();
	for (const path of comparison.rows) {
		const chosen = path.comparison === 'inbound' ? path.remote : path.local;
		if (chosen !== null) prospective.set(path.path, chosen);
	}
	return prospective;
}

/** The status of the whole Workspace, from the per-path table. */
function aggregate(comparison: SourceComparison): SourceStatus {
	if (!comparison.hasBaseline) return 'cannot-tell';
	// A contested path is work outstanding in both directions at once, so it counts in both buckets
	// (ADR-0046). It is not a status of its own: a Sync resolves it rather than stopping at it.
	const contested = bucket(comparison, 'conflict').length > 0;
	const outbound = contested || bucket(comparison, 'outbound').length > 0;
	const inbound = contested || bucket(comparison, 'inbound').length > 0;
	if (outbound && inbound) return 'changes-both-ways';
	if (outbound) return 'changes-to-send';
	if (inbound) return 'changes-to-get';
	return 'in-sync';
}

/**
 * Compare a Workspace against its Remote: the Remote Status, the table behind it, and what else
 * differs.
 *
 * ⚠ **The status is the aggregated table and nothing else.** A prospective result that would break
 * the Workspace is {@link WorkspaceComparison.graph}'s to report, and the caller about to write
 * refuses on it — a badge cannot say "this combination would not open" in five words, and saying it
 * as a *direction* would be a lie about which side has work outstanding.
 */
export function compareWorkspace(input: SynchronizationInput): WorkspaceComparison {
	const comparison = compareSource(input);
	return {
		status: aggregate(comparison),
		paths: comparison.paths,
		publishedSiteStale: comparison.publishedSiteStale,
		graph: validateProspectiveWorkspace(prospectiveSource(comparison), input.projectFiles)
	};
}

// ── Prospective graph validation ───────────────────────────────────────────────────────────────

/** Whether a closure reference names Workspace-level shared material rather than a Project's file. */
const sharedMaterial = (reference: string): boolean =>
	reference.startsWith(`${IMAGE_DIRECTORY}/`) || reference.startsWith(`${ALIGNMENT_DIRECTORY}/`);

/** The two files either of which makes a Map Image directory openable (ADR-0023). */
const describesAnImage = (paths: ReadonlySet<string>, imageId: string): boolean =>
	paths.has(`${imageDirectory(imageId)}/info.json`) ||
	paths.has(`${imageDirectory(imageId)}/${REFERENCED_IMAGE_FILE}`);

/**
 * Ask the Workspace's own invariants of a prospective `path → blob SHA` set.
 *
 * `gatherProjectClosure` answers the Layer half, shared with Project Import so that a Layer kind
 * added later cannot mean one thing to an Import and another to a get. The two halves it does not
 * answer are structural rather than about Layers, and both are reachable from changes that are
 * individually safe: a Project's files surviving its `project.json`, and an Alignment surviving the
 * Map Image it places.
 */
export function validateProspectiveWorkspace(
	prospective: ReadonlyMap<string, string>,
	projectFiles: ReadonlyMap<string, Uint8Array> | undefined
): GraphVerdict {
	if (projectFiles === undefined) return { outcome: 'not-checked' };

	const paths = new Set(prospective.keys());
	const projects = new Set<string>();
	for (const path of paths) {
		const [directory, name, ...deeper] = path.split('/');
		if (directory !== undefined && name === PROJECT_FILE_NAME && deeper.length === 0) {
			projects.add(directory);
		}
	}

	const violations: GraphViolation[] = [];
	const failures: GraphFailure[] = [];

	// A Project's files with no `project.json`: a directory nothing can open, and every file under it
	// is unreachable work rather than a Project.
	const orphanedDirectories = new Set<string>();
	for (const path of paths) {
		if (path.startsWith(BASE_MAP_TILE_ROOT)) continue;
		const top = topLevelSegment(path);
		if (top === IMAGE_DIRECTORY || top === ALIGNMENT_DIRECTORY) continue;
		if (!projects.has(top)) orphanedDirectories.add(top);
	}
	for (const directory of [...orphanedDirectories].sort()) {
		violations.push({
			kind: 'missing-project-file',
			path: projectFilePath(directory),
			detail: `“${directory}” would hold a Project's files but no ${PROJECT_FILE_NAME}.`
		});
	}

	// An Alignment for a Map Image that is not there. `deleteMapImage` removes the Alignment first
	// precisely so this cannot happen, and a later Import deduplicates against it — so the leftover
	// would place a colleague's copy of the same map by a placement nothing explains.
	for (const path of [...paths].sort()) {
		if (topLevelSegment(path) !== ALIGNMENT_DIRECTORY) continue;
		const imageId = hoistedImageId(path);
		if (imageId === null || path !== alignmentPath(imageId)) continue;
		if (describesAnImage(paths, imageId)) continue;
		violations.push({
			kind: 'orphan-alignment',
			path,
			detail: `The Alignment ${path} would be left for a Map Image that is not there.`
		});
	}

	// Shared material is offered to every Project's closure at the Workspace-level names
	// `gatherProjectClosure` already expects — `images/<id>/…` and `alignments/<id>.json`.
	const shared = [...paths]
		.filter((path) => hoistedImageId(path) !== null)
		.map((path) => ({ path, bytes: 0 }));

	for (const directory of [...projects].sort()) {
		const path = projectFilePath(directory);
		const sha = prospective.get(path);
		/* v8 ignore next -- `projects` was derived from `prospective`, so the SHA is always there. */
		if (sha === undefined) continue;
		const bytes = projectFiles.get(sha);
		if (bytes === undefined) {
			failures.push({
				kind: 'unreadable',
				path,
				detail: `The bytes of ${path} could not be read, so the result cannot be checked.`
			});
			continue;
		}
		let project;
		try {
			project = parseProjectFile(bytes);
		} catch (cause) {
			failures.push(
				cause instanceof ProjectFormatTooNewError
					? {
							kind: 'unsupported',
							path,
							detail: `${path} was written by a newer version of Ballastella.`
						}
					: {
							kind: 'malformed',
							path,
							detail: `${path} could not be read as a Ballastella Project.`
						}
			);
			continue;
		}

		const own = [...paths]
			.filter((candidate) => candidate.startsWith(`${directory}/`))
			.map((candidate) => ({ path: candidate.slice(directory.length + 1), bytes: 0 }));
		for (const unmet of gatherProjectClosure(project, [...own, ...shared]).unmet) {
			violations.push({
				kind: unmet.refusal,
				// Back to a Workspace path: a closure reference is Project-relative, except for the shared
				// material, which is already at the names the Workspace gives it.
				path: sharedMaterial(unmet.reference) ? unmet.reference : `${directory}/${unmet.reference}`,
				detail: `The Layer “${unmet.layer}” in ${path} needs ${unmet.reference}, which would not be there.`
			});
		}
	}

	if (failures.length > 0) return { outcome: 'failed', failures };
	if (violations.length > 0) return { outcome: 'invalid', violations };
	return { outcome: 'valid' };
}

// ── The Sync ──────────────────────────────────────────────────────────────────────────────────

/**
 * Work out what a Sync would settle in both directions, and what each side could then record.
 *
 * One plan, four modes. `get` acts on {@link WorkspaceSyncPlan.toGet}, `send` on
 * {@link WorkspaceSyncPlan.toSend} together with {@link WorkspaceSyncPlan.leftAlone} and
 * {@link WorkspaceSyncPlan.preserved}, `both` on the first and then the second, and `overwrite` on
 * {@link WorkspaceSyncPlan.overwrites} — the only removal set computed from the Workspace alone.
 *
 * Nothing here refuses: a Conflict is reported and the engine that moves the bytes resolves it.
 * Nothing here transfers a byte either — `get-from-remote.ts` carries out a get and
 * `send-to-remote.ts` a send.
 */
export function planWorkspaceSync(input: SynchronizationInput): WorkspaceSyncPlan {
	const comparison = compareSource(input);
	const prospective = prospectiveSource(comparison);
	const graph = validateProspectiveWorkspace(prospective, input.projectFiles);
	const workspace: WorkspaceComparison = {
		status: aggregate(comparison),
		paths: comparison.paths,
		publishedSiteStale: comparison.publishedSiteStale,
		graph
	};

	const getChanges: PathChoice[] = [];
	const getRemoved: string[] = [];
	const getAdvances = new Map<string, string>();
	const getRetires: string[] = [];
	const sendChanges: PathChoice[] = [];
	const sendRemoved: string[] = [];
	const sendAdvances = new Map<string, string>();
	for (const row of comparison.rows) {
		if (row.comparison === 'inbound') {
			if (row.remote === null) {
				// Getting removes a path the Remote no longer holds — and the Baseline recorded it, which
				// is what an `inbound` row means. A path this Workspace never agreed to is not here.
				getChanges.push({ path: row.path, sha: null, effect: 'delete' });
				getRemoved.push(row.path);
				getRetires.push(row.path);
				continue;
			}
			getChanges.push({
				path: row.path,
				sha: row.remote,
				effect: row.local === null ? 'add' : 'replace'
			});
			getAdvances.set(row.path, row.remote);
			// ⚠ **And a send writes nothing here.** The Remote has moved past what the two last agreed
			// and this Workspace has not changed its copy, so sending the copy would put a stale file
			// over somebody's afternoon. It is left exactly as it is and offered as something to get.
			continue;
		}
		if (row.comparison === 'outbound') {
			// The destructive half of a send, and the Baseline is what licenses it: this Workspace put
			// the file there and has since deleted it.
			if (row.local === null) {
				sendRemoved.push(row.path);
				continue;
			}
			sendChanges.push({
				path: row.path,
				sha: row.local,
				effect: row.remote === null ? 'add' : 'replace'
			});
			sendAdvances.set(row.path, row.local);
			// `outbound` is the one row a successful get must **not** advance: the local work is still
			// unsent, and a Baseline claiming it was shared would report it as agreed.
			continue;
		}
		if (row.comparison === 'conflict') {
			// Neither direction settles a contested path here. The get resolves it — the Remote's version
			// becomes a Conflict Copy and the Baseline advances to it (ADR-0046) — and the row is an
			// ordinary `outbound` one on the pass after that, which is what sends this Workspace's copy.
			continue;
		}
		// `shared` and `converged` are both already agreed between the two sides.
		if (row.local === null) {
			getRetires.push(row.path);
			continue;
		}
		getAdvances.set(row.path, row.local);
		sendChanges.push({
			path: row.path,
			sha: row.local,
			effect: row.remote === row.local ? 'keep' : row.remote === null ? 'add' : 'replace'
		});
		sendAdvances.set(row.path, row.local);
	}

	const { localSource, remoteSource } = comparison;
	// Everything the Remote holds that a send neither writes nor removes: the inbound rows, and the
	// contested ones an `overwrite` is the only way past.
	const settled = new Set([...sendChanges.map((choice) => choice.path), ...sendRemoved]);

	return {
		toGet: {
			changes: sortChoices(getChanges),
			removed: getRemoved.sort(),
			advances: getAdvances,
			retires: getRetires.sort()
		},
		toSend: {
			changes: sortChoices(sendChanges),
			removed: sendRemoved.sort(),
			advances: sendAdvances,
			retires: sendRemoved.sort()
		},
		toOverwrite: {
			changes: sortChoices(
				[...localSource].map(([path, sha]) => {
					const there = remoteSource.get(path);
					return {
						path,
						sha,
						effect: there === undefined ? 'add' : there === sha ? 'keep' : 'replace'
					};
				})
			),
			removed: [...remoteSource.keys()].filter((path) => !localSource.has(path)).sort(),
			advances: new Map(localSource),
			retires: [...remoteSource.keys()].filter((path) => !localSource.has(path)).sort()
		},
		leftAlone: [...remoteSource.keys()].filter((path) => !settled.has(path)).sort(),
		preserved: comparison.preserved,
		conflicts: comparison.rows.filter((row) => row.comparison === 'conflict'),
		prospective,
		retained: [...bucket(comparison, 'outbound')].sort(),
		comparison: workspace
	};
}

// ── Shared wording and ordering ───────────────────────────────────────────────────────────────

const sortChoices = (choices: readonly PathChoice[]): readonly PathChoice[] =>
	[...choices].sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0
	);

/** What an unreadable Remote says. Never a verdict about scholarship — see {@link GraphVerdict}. */
export const describeGraphFailure = (failures: readonly GraphFailure[]): string =>
	`The Remote's files could not be read, so nothing can be planned: ` +
	`${failures.map((failure) => failure.detail).join(' ')}`;

/** What a prospective Workspace that would not open says. */
export const describeGraphViolations = (violations: readonly GraphViolation[]): string =>
	`Getting these changes would leave this Workspace incomplete: ` +
	`${violations.map((violation) => violation.detail).join(' ')} ` +
	`Nothing has been changed.`;
