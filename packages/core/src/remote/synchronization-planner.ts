// The three-way comparison between a Workspace, its Remote, and what the two last shared (ADR-0038).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// PURE, AND THAT IS THE WHOLE DESIGN
//
// Nothing here reads a `ProjectStore`, fetches GitHub, writes a file, or advances a Baseline. It is
// handed three `path → blob SHA` inventories and returns a value. Every hard question in
// synchronization — *is this my work or somebody else's, and what happens if I take theirs* — is
// then answerable in a table-driven test with no browser, no network, and no transfer, which is the
// only way the six states below can be exhaustively covered at all.
//
// The callers supply the I/O: ticket 11 opens, ticket 12 checks, tickets 14 and 15 fetch and commit,
// ticket 16 publishes. They all ask the same three functions the same question.
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
// SPEC's table, per path, against Baseline `B`, local `L` and Remote `R`:
//
//   no valid B                          cannot-tell
//   L = B and R = B                     shared
//   L != B and R = B                    outbound     (Changes to publish)
//   L = B and R != B                    inbound      (Update available)
//   L != B and R != B and L = R         converged    (shared bytes; a Baseline may advance)
//   L != B and R != B and L != R        conflict
//
// The Workspace's status is that table aggregated: any conflict wins, then outbound *and* inbound
// together is Changes on both sides, then whichever of the two is present alone, and otherwise Up to
// date. `converged` is Up to date on purpose — the two sides agree about the bytes and only the
// Baseline is behind.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE COMBINATION CAN BE BROKEN WHEN NO SINGLE PATH IS
//
// SPEC: *"a combination of individually separate changes reported as Conflict when it would violate
// a Workspace invariant."* A map Layer added here while its pyramid is deleted there is two
// perfectly attributable changes at two different paths, and the Workspace they add up to cannot
// draw. So the plan's chosen bytes are assembled into a prospective path set and the Workspace's own
// invariants are asked of it, through `gatherProjectClosure` — the same closure check Import uses, so
// a Layer kind added later cannot mean one thing to an Import and another to an Update.
//
// ⚠ **A Remote that cannot be read is an operation failure, never a verdict.** A `project.json` that
// will not parse, one from a newer format version, or one whose bytes were never supplied is not
// `Up to date` and not `Conflict`: those two are claims about scholarship, and this is a claim about
// the transfer. {@link GraphVerdict} keeps them apart.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// NO BASELINE: WHICH SIDE'S EMPTINESS LICENSES WHICH OPERATION
//
// SPEC: *"A deliberate Update or Publish planning pass may establish a Baseline when both source
// namespaces are byte-for-byte equal or one side is empty."* Read with stories 152 and 153, "one
// side" is **the side the operation would destroy**, and the two operations therefore differ:
//
//   Update  refuses when local and Remote source are both non-empty and differ (story 153). An empty
//           Workspace takes everything; an empty Remote leaves the local work as Changes to publish.
//   Publish refuses whenever the Remote's source namespace is non-empty and differs (story 152's
//           "safe refusal for a non-empty Remote"), which is exactly `detectConflict`'s existing
//           `unknown` refusal — and it keeps its existing remedy, Publish anyway.
//
// Both establish the Baseline only for what the two sides genuinely share, which is empty when
// nothing is shared. An empty Baseline is honest evidence; a fabricated one is not.

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
 * ⚠ **These are not labels.** Ticket 12 owns the words a user reads — "Up to date", "Cannot tell" —
 * and projects them from exactly these six. Nothing here should grow a sentence about a status.
 */
export type SourceStatus =
	| 'up-to-date'
	| 'changes-to-publish'
	| 'update-available'
	| 'changes-on-both-sides'
	| 'conflict'
	| 'cannot-tell';

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
 * ⚠ **`local` must be a *complete* hashing of the Workspace for a deliberate Update or Publish**
 * (SPEC story 160). A chosen folder can be edited by anything on the machine, so the write index
 * ticket 10 maintains is evidence about Ballastella's own writes and nothing else; a plan built from
 * it would take an inbound change over an out-of-band local edit and call it safe. The requirement is
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
	 * SPEC story 120, and it never touches {@link status}: a site built by another editor version has
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

/** Why a plan will not go ahead. Each has a remedy the caller words. */
export type PlanRefusal =
	/** The Remote holds source changes this Workspace has not taken yet; Update first. */
	| 'remote-changes'
	/** Safe changes on both sides, which Publish will not resolve by overwriting one of them. */
	| 'changes-on-both-sides'
	/** One path changed differently on both sides, or the combination breaks the Workspace. */
	| 'conflict'
	/** No valid Baseline, and the two sides cannot be attributed. */
	| 'unknown-history';

/** What an Update would do, and what it would then be entitled to record. */
export interface WorkspaceUpdatePlan {
	/** Paths to write and paths to remove, sorted. Unchanged paths are not here. */
	readonly changes: readonly PathChoice[];
	/** The subset of {@link changes} that replaces or removes local bytes: confirm these by name. */
	readonly destructive: readonly string[];
	/** Local-only changes this Update leaves alone. Still Changes to publish afterwards. */
	readonly retained: readonly string[];
	/** `path → blob SHA` the Baseline may advance to, and **only** these paths. */
	readonly advances: ReadonlyMap<string, string>;
	/** Paths the Baseline may drop, because neither side holds them any more. */
	readonly retires: readonly string[];
	/** Whether this plan would establish a Baseline where there was none. */
	readonly establishesBaseline: boolean;
	readonly comparison: WorkspaceComparison;
}

/** What a Publish would send, and what it would then be entitled to record. */
export interface WorkspacePublishPlan {
	/** Every local source path the commit will hold, sorted. Local bytes win by definition. */
	readonly source: readonly PathChoice[];
	/** Remote paths outside Ballastella's namespace, carried into the new tree untouched. */
	readonly preserved: readonly string[];
	/** Owned Remote source paths the mirror removes, sorted. */
	readonly removed: readonly string[];
	/** The Baseline a successful Publish may record: the whole local source namespace. */
	readonly advances: ReadonlyMap<string, string>;
	readonly establishesBaseline: boolean;
	/** Whether this is the confirmed Publish anyway rather than an ordinary Publish. */
	readonly replacing: boolean;
	readonly comparison: WorkspaceComparison;
}

/** A plan, a refusal with its remedy, or a transfer that cannot be judged at all. */
export type PlanResult<P> =
	| { readonly outcome: 'planned'; readonly plan: P }
	| {
			readonly outcome: 'refused';
			readonly reason: PlanRefusal;
			readonly paths: readonly string[];
			readonly message: string;
	  }
	| {
			readonly outcome: 'failed';
			readonly failures: readonly GraphFailure[];
			readonly message: string;
	  };

/**
 * One path's three pieces of evidence, compared. `null` is absent on any of the three sides.
 *
 * **The one implementation of SPEC's table**, called by the Workspace comparison here and by
 * publishing's own refusal — which asks the same question of the same three values and must not
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
	readonly paths: readonly SourcePath[];
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
	const byComparison = new Map<Exclude<PathComparison, 'cannot-tell'>, string[]>();
	for (const path of union) {
		const evidence = {
			baseline: baselineSource.get(path) ?? null,
			local: localSource.get(path) ?? null,
			remote: remoteSource.get(path) ?? null
		};
		if (baselineFiles === null) {
			paths.push({ path, comparison: 'cannot-tell', ...evidence });
			continue;
		}
		const comparison = comparePath(evidence.baseline, evidence.local, evidence.remote);
		paths.push({ path, comparison, ...evidence });
		const bucket = byComparison.get(comparison);
		if (bucket === undefined) byComparison.set(comparison, [path]);
		else bucket.push(path);
	}

	const held = new Set(local.map((entry) => entry.path));
	return {
		paths,
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
 * The path set an Update would leave behind: the Remote's bytes where they are inbound, the
 * Workspace's everywhere else.
 *
 * A conflicting path takes the local side, which is arbitrary and does not matter: a conflict is
 * refused before any of this is acted on, and the prospective set exists so that the *other* rows
 * can be checked for a combination that breaks the Workspace.
 */
function prospectiveSource(comparison: SourceComparison): Map<string, string> {
	const prospective = new Map<string, string>();
	for (const path of comparison.paths) {
		const chosen = path.comparison === 'inbound' ? path.remote : path.local;
		if (chosen !== null) prospective.set(path.path, chosen);
	}
	return prospective;
}

/** The status of the whole Workspace, from the per-path table. */
function aggregate(comparison: SourceComparison): SourceStatus {
	if (!comparison.hasBaseline) return 'cannot-tell';
	if (bucket(comparison, 'conflict').length > 0) return 'conflict';
	const outbound = bucket(comparison, 'outbound').length > 0;
	const inbound = bucket(comparison, 'inbound').length > 0;
	if (outbound && inbound) return 'changes-on-both-sides';
	if (outbound) return 'changes-to-publish';
	if (inbound) return 'update-available';
	return 'up-to-date';
}

/**
 * Compare a Workspace against its Remote: the Remote Status, the table behind it, and what else
 * differs.
 *
 * The status is the aggregated table, **escalated to Conflict when the prospective result would
 * break the Workspace** (SPEC story 136). It is deliberately *not* escalated for a
 * {@link GraphVerdict} `'failed'`: that is a transfer that cannot be judged, and calling it Conflict
 * would describe unreadable Remote bytes as changed scholarship.
 */
export function compareWorkspace(input: SynchronizationInput): WorkspaceComparison {
	const comparison = compareSource(input);
	const graph = validateGraph(prospectiveSource(comparison), input.projectFiles);
	const status = aggregate(comparison);
	return {
		status: graph.outcome === 'invalid' ? 'conflict' : status,
		paths: comparison.paths,
		publishedSiteStale: comparison.publishedSiteStale,
		graph
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
 * added later cannot mean one thing to an Import and another to an Update. The two halves it does not
 * answer are structural rather than about Layers, and both are reachable from changes that are
 * individually safe: a Project's files surviving its `project.json`, and an Alignment surviving the
 * Map Image it places.
 */
function validateGraph(
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

// ── Update ────────────────────────────────────────────────────────────────────────────────────

/**
 * Work out what an Update would bring in, what it would take away, and what it could then record.
 *
 * Takes Remote-only additions, replacements and deletions; leaves local-only work alone; refuses a
 * Conflict and a combination that would break the Workspace; and identifies exactly the paths a
 * successful Update would be entitled to advance the Baseline for. Nothing here transfers a byte —
 * tickets 14 and 15 execute the plan.
 */
export function planWorkspaceUpdate(input: SynchronizationInput): PlanResult<WorkspaceUpdatePlan> {
	const comparison = compareSource(input);
	const graph = validateGraph(prospectiveSource(comparison), input.projectFiles);
	const workspace: WorkspaceComparison = {
		status: graph.outcome === 'invalid' ? 'conflict' : aggregate(comparison),
		paths: comparison.paths,
		publishedSiteStale: comparison.publishedSiteStale,
		graph
	};

	if (graph.outcome === 'failed') return failed(graph.failures);
	if (graph.outcome === 'invalid') return brokenWorkspace(graph.violations);

	if (!comparison.hasBaseline) return establishForUpdate(comparison, workspace, input.projectFiles);

	const conflicts = bucket(comparison, 'conflict');
	if (conflicts.length > 0) {
		return {
			outcome: 'refused',
			reason: 'conflict',
			paths: conflicts,
			message: conflictMessage(conflicts)
		};
	}

	const changes: PathChoice[] = [];
	const destructive: string[] = [];
	const advances = new Map<string, string>();
	const retires: string[] = [];
	for (const path of comparison.paths) {
		if (path.comparison === 'inbound') {
			if (path.remote === null) {
				changes.push({ path: path.path, sha: null, effect: 'delete' });
				destructive.push(path.path);
				retires.push(path.path);
				continue;
			}
			changes.push({
				path: path.path,
				sha: path.remote,
				effect: path.local === null ? 'add' : 'replace'
			});
			if (path.local !== null) destructive.push(path.path);
			advances.set(path.path, path.remote);
			continue;
		}
		// `outbound` is the one row a successful Update must *not* advance: the local work is still
		// unpublished, and a Baseline claiming it was shared would report it as Up to date.
		if (path.comparison === 'outbound') continue;
		// `shared` and `converged` are both already agreed between the two sides.
		if (path.local === null) retires.push(path.path);
		else advances.set(path.path, path.local);
	}

	return {
		outcome: 'planned',
		plan: {
			changes: sortChoices(changes),
			destructive: destructive.sort(),
			retained: [...bucket(comparison, 'outbound')].sort(),
			advances,
			retires: retires.sort(),
			establishesBaseline: false,
			comparison: workspace
		}
	};
}

/** The refusal an Update gives for a result that would not be a Workspace (SPEC story 136). */
const brokenWorkspace = (
	violations: readonly GraphViolation[]
): PlanResult<WorkspaceUpdatePlan> => ({
	outcome: 'refused',
	reason: 'conflict',
	paths: violations.map((violation) => violation.path),
	message:
		`Updating would leave this Workspace incomplete: ` +
		`${violations.map((violation) => violation.detail).join(' ')} ` +
		`Nothing has been changed.`
});

/**
 * An Update with no Baseline at all.
 *
 * Refuses only what cannot be attributed — both sides non-empty and different (SPEC story 153) — and
 * otherwise establishes the Baseline for what the two sides genuinely share, which is nothing at all
 * when the Remote's source namespace is empty.
 *
 * ⚠ **Its own graph check, because `prospectiveSource` cannot describe this plan.** Every row is
 * `cannot-tell` without a Baseline, so the shared prospective set is the local side alone — which for
 * the ordinary case here, an empty Workspace taking a whole Remote, is nothing at all. Judged by
 * that, a Remote whose `project.json` names a Map Image nobody ever pushed would be refused once
 * there is a Baseline and adopted whole on the one Update that establishes one (SPEC story 136).
 */
function establishForUpdate(
	comparison: SourceComparison,
	workspace: WorkspaceComparison,
	projectFiles: ReadonlyMap<string, Uint8Array> | undefined
): PlanResult<WorkspaceUpdatePlan> {
	const { localSource, remoteSource } = comparison;
	if (localSource.size > 0 && remoteSource.size > 0 && !sameNamespace(localSource, remoteSource)) {
		return {
			outcome: 'refused',
			reason: 'unknown-history',
			paths: [...new Set([...localSource.keys(), ...remoteSource.keys()])]
				.filter((path) => localSource.get(path) !== remoteSource.get(path))
				.sort(),
			message:
				`This Workspace and the Remote both hold work, and there is no record of what they last ` +
				`shared — so we cannot tell which changes are new. Nothing has been changed. Publish to ` +
				`make this Workspace the shared state, or open the Remote into a new Workspace to compare ` +
				`them side by side.`
		};
	}

	// Past the refusal above the two sides agree wherever they overlap, so the Workspace this would
	// leave is simply their union.
	const graph = validateGraph(new Map([...localSource, ...remoteSource]), projectFiles);
	if (graph.outcome === 'failed') return failed(graph.failures);
	if (graph.outcome === 'invalid') return brokenWorkspace(graph.violations);

	const changes: PathChoice[] = [];
	const advances = new Map<string, string>();
	// Nothing is destructive here: either the Workspace holds no source at all, or every path the
	// Remote holds it already holds byte for byte.
	for (const [path, sha] of remoteSource) {
		if (localSource.get(path) !== sha) changes.push({ path, sha, effect: 'add' });
		advances.set(path, sha);
	}

	return {
		outcome: 'planned',
		plan: {
			changes: sortChoices(changes),
			destructive: [],
			retained: [...localSource.keys()].filter((path) => !remoteSource.has(path)).sort(),
			advances,
			retires: [],
			establishesBaseline: true,
			comparison: { ...workspace, graph }
		}
	};
}

// ── Publish ───────────────────────────────────────────────────────────────────────────────────

/** Whether this is the confirmed Publish anyway rather than an ordinary Publish. */
export interface WorkspacePublishOptions {
	readonly replace?: boolean;
}

/**
 * Work out whether a Publish may go ahead, which paths it settles, and what it could then record.
 *
 * ⚠ **This is the *decision*, not the transfer.** `planRemotePublish` still works out blobs, budgets
 * and the tree; what is answered here is whether the Remote holds source work this Workspace has not
 * taken yet, and which of its files are ours to replace. Ticket 16 joins the two.
 *
 * An ordinary Publish refuses inbound source change — alone, alongside local work, or as a Conflict —
 * because a mirror of this Workspace would overwrite it. `replace` is the confirmed Publish anyway,
 * which takes the local side of everything owned and still preserves the repository's own files.
 */
export function planWorkspacePublish(
	input: SynchronizationInput,
	options: WorkspacePublishOptions = {}
): PlanResult<WorkspacePublishPlan> {
	const comparison = compareSource(input);
	const workspace = compareWorkspace(input);
	if (workspace.graph.outcome === 'failed') return failed(workspace.graph.failures);

	const replacing = options.replace === true;
	if (!replacing) {
		const refusal = workspacePublishRefusal(comparison);
		if (refusal !== null) return refusal;
	}

	const { localSource, remoteSource } = comparison;
	const source: PathChoice[] = [];
	for (const [path, sha] of localSource) {
		const there = remoteSource.get(path);
		source.push({
			path,
			sha,
			effect: there === undefined ? 'add' : there === sha ? 'keep' : 'replace'
		});
	}

	return {
		outcome: 'planned',
		plan: {
			source: sortChoices(source),
			preserved: comparison.preserved,
			removed: [...remoteSource.keys()].filter((path) => !localSource.has(path)).sort(),
			advances: new Map(localSource),
			establishesBaseline: !comparison.hasBaseline,
			replacing,
			comparison: workspace
		}
	};
}

/** Why an ordinary Publish will not go ahead, or `null`. */
function workspacePublishRefusal(
	comparison: SourceComparison
): PlanResult<WorkspacePublishPlan> | null {
	if (!comparison.hasBaseline) {
		const { localSource, remoteSource } = comparison;
		// The existing `unknown` refusal, in the existing shape: a Remote whose owned namespace is
		// empty is a first publish and goes ahead, and one holding exactly this Workspace has nothing
		// to lose either.
		if (remoteSource.size === 0 || sameNamespace(localSource, remoteSource)) return null;
		return {
			outcome: 'refused',
			reason: 'unknown-history',
			paths: [...remoteSource.keys()].sort(),
			message:
				`The Remote already holds ${remoteSource.size} ` +
				`${remoteSource.size === 1 ? 'file' : 'files'} of Ballastella's own, and there is no ` +
				`record of what this Workspace last shared with it — so we cannot tell whose work is ` +
				`there. Nothing has been sent. Update from GitHub to bring it in, or publish anyway to ` +
				`replace it with this Workspace.`
		};
	}

	const conflicts = bucket(comparison, 'conflict');
	if (conflicts.length > 0) {
		return {
			outcome: 'refused',
			reason: 'conflict',
			paths: conflicts,
			message: conflictMessage(conflicts)
		};
	}
	const inbound = bucket(comparison, 'inbound');
	if (inbound.length === 0) return null;
	const alsoLocal = bucket(comparison, 'outbound').length > 0;
	return {
		outcome: 'refused',
		reason: alsoLocal ? 'changes-on-both-sides' : 'remote-changes',
		paths: [...inbound].sort(),
		message:
			`The Remote has changed since this Workspace last shared state with it: ` +
			`${listPaths(inbound)}. Publishing would overwrite ${inbound.length === 1 ? 'it' : 'them'}. ` +
			`Update from GitHub first. Nothing has been sent.`
	};
}

// ── Shared wording and ordering ───────────────────────────────────────────────────────────────

const sortChoices = (choices: readonly PathChoice[]): readonly PathChoice[] =>
	[...choices].sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0
	);

/** Whether the two namespaces hold exactly the same paths at exactly the same bytes. */
const sameNamespace = (
	left: ReadonlyMap<string, string>,
	right: ReadonlyMap<string, string>
): boolean => left.size === right.size && [...left].every(([path, sha]) => right.get(path) === sha);

/** At most five paths named, because a refusal nobody reads is a refusal nobody acts on. */
function listPaths(paths: readonly string[]): string {
	const named = [...paths].sort();
	if (named.length <= 5) return named.join(', ');
	return `${named.slice(0, 5).join(', ')} and ${named.length - 5} more`;
}

const conflictMessage = (paths: readonly string[]): string =>
	`${paths.length === 1 ? 'One file has' : `${paths.length} files have`} been changed both here and ` +
	`on the Remote: ${listPaths(paths)}. Ballastella will not choose between two versions of your ` +
	`work. Nothing has been changed.`;

const failed = <P>(failures: readonly GraphFailure[]): PlanResult<P> => ({
	outcome: 'failed',
	failures,
	message:
		`The Remote's files could not be read, so nothing can be planned: ` +
		`${failures.map((failure) => failure.detail).join(' ')}`
});
