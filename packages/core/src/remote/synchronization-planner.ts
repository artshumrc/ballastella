import { ALIGNMENT_DIRECTORY, alignmentPath } from '../alignment/alignment.js';
import { BASE_MAP_TILE_ROOT } from '../base-map/tile-cache.js';
import { IMAGE_DIRECTORY } from '../project/image-files.js';
import {
	PROJECT_FILE_NAME,
	ProjectFormatTooNewError,
	parseProjectFile,
	projectFilePath
} from '../project/project-file.js';
import { hoistedImageId } from '../project/workspace.js';
import { imageDescriptionPaths } from '../remote-iiif/referenced-image.js';
import { topLevelSegment } from '../store/project-store.js';
import { gatherProjectClosure } from '../transfer/project-import-source.js';
import {
	byPath,
	classifyInventory,
	projectDirectories,
	publishedOutputDrift,
	recognisedProjectDirectories
} from './synchronization-paths.js';
import type { SynchronizationBaseline } from './synchronization-metadata.js';

export interface InventoryEntry {
	readonly path: string;
	readonly sha: string;
}

export type PathComparison =
	'shared' | 'outbound' | 'inbound' | 'converged' | 'conflict' | 'cannot-tell';

export type SourceStatus =
	'in-sync' | 'changes-to-send' | 'changes-to-get' | 'changes-both-ways' | 'cannot-tell';

export interface SourcePath {
	readonly path: string;
	readonly comparison: PathComparison;
	readonly baseline: string | null;
	readonly local: string | null;
	readonly remote: string | null;
}

interface GraphViolation {
	readonly kind:
		| 'missing-project-file'
		| 'missing-annotation'
		| 'missing-image'
		| 'incomplete-image'
		| 'orphan-alignment';
	readonly path: string;
	readonly detail: string;
}

interface GraphFailure {
	readonly kind: 'malformed' | 'unsupported' | 'unreadable';
	readonly path: string;
	readonly detail: string;
}

export type GraphVerdict =
	| { readonly outcome: 'valid' }
	| { readonly outcome: 'not-checked' }
	| { readonly outcome: 'invalid'; readonly violations: readonly GraphViolation[] }
	| { readonly outcome: 'failed'; readonly failures: readonly GraphFailure[] };

export interface SynchronizationInput {
	readonly local: Iterable<InventoryEntry>;
	readonly remote: Iterable<InventoryEntry>;
	readonly baseline: SynchronizationBaseline | null;
	readonly projectFiles?: ReadonlyMap<string, Uint8Array>;
}

export interface WorkspaceComparison {
	readonly status: SourceStatus;
	readonly paths: readonly SourcePath[];
	readonly publishedSiteStale: readonly string[];
	readonly graph: GraphVerdict;
}

export interface PathChoice {
	readonly path: string;
	readonly sha: string | null;
	readonly effect: 'add' | 'replace' | 'delete' | 'keep';
}

interface SyncDirection {
	readonly changes: readonly PathChoice[];
	readonly removed: readonly string[];
	readonly advances: ReadonlyMap<string, string>;
	readonly retires: readonly string[];
}

export interface WorkspaceSyncPlan {
	readonly toGet: SyncDirection;
	readonly toSend: SyncDirection;
	readonly leftAlone: readonly string[];
	readonly preserved: readonly string[];
	readonly toOverwrite: SyncDirection;
	readonly conflicts: readonly SourcePath[];
	readonly prospective: ReadonlyMap<string, string>;
	readonly retained: readonly string[];
	readonly comparison: WorkspaceComparison;
}

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

interface SourceComparison {
	readonly paths: readonly SourcePath[];
	readonly rows: readonly SourcePath[];
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

	const rows = union.map((path): SourcePath => {
		const evidence = {
			baseline: baselineSource.get(path) ?? null,
			local: localSource.get(path) ?? null,
			remote: remoteSource.get(path) ?? null
		};
		return {
			path,
			comparison: comparePath(evidence.baseline, evidence.local, evidence.remote),
			...evidence
		};
	});

	const held = new Set(local.map((entry) => entry.path));
	return {
		paths:
			baselineFiles === null ? rows.map((row) => ({ ...row, comparison: 'cannot-tell' })) : rows,
		rows,
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

const bucket = (comparison: SourceComparison, kind: PathComparison): string[] =>
	comparison.rows.filter((row) => row.comparison === kind).map((row) => row.path);

function prospectiveSource(comparison: SourceComparison): Map<string, string> {
	const prospective = new Map<string, string>();
	for (const path of comparison.rows) {
		const chosen = path.comparison === 'inbound' ? path.remote : path.local;
		if (chosen !== null) prospective.set(path.path, chosen);
	}
	return prospective;
}

function aggregate(comparison: SourceComparison): SourceStatus {
	if (!comparison.hasBaseline) return 'cannot-tell';
	const contested = bucket(comparison, 'conflict').length > 0;
	const outbound = contested || bucket(comparison, 'outbound').length > 0;
	const inbound = contested || bucket(comparison, 'inbound').length > 0;
	if (outbound && inbound) return 'changes-both-ways';
	if (outbound) return 'changes-to-send';
	if (inbound) return 'changes-to-get';
	return 'in-sync';
}

const workspaceComparison = (
	comparison: SourceComparison,
	prospective: ReadonlyMap<string, string>,
	projectFiles: ReadonlyMap<string, Uint8Array> | undefined
): WorkspaceComparison => ({
	status: aggregate(comparison),
	paths: comparison.paths,
	publishedSiteStale: comparison.publishedSiteStale,
	graph: validateProspectiveWorkspace(prospective, projectFiles)
});

export function compareWorkspace(input: SynchronizationInput): WorkspaceComparison {
	const comparison = compareSource(input);
	return workspaceComparison(comparison, prospectiveSource(comparison), input.projectFiles);
}

const sharedMaterial = (reference: string): boolean =>
	reference.startsWith(`${IMAGE_DIRECTORY}/`) || reference.startsWith(`${ALIGNMENT_DIRECTORY}/`);

export function validateProspectiveWorkspace(
	prospective: ReadonlyMap<string, string>,
	projectFiles: ReadonlyMap<string, Uint8Array> | undefined
): GraphVerdict {
	if (projectFiles === undefined) return { outcome: 'not-checked' };
	const paths = new Set(prospective.keys());
	const projects = projectDirectories(paths);
	const violations: GraphViolation[] = [];
	const failures: GraphFailure[] = [];
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

	for (const path of [...paths].sort()) {
		if (topLevelSegment(path) !== ALIGNMENT_DIRECTORY) continue;
		const imageId = hoistedImageId(path);
		if (imageId === null || path !== alignmentPath(imageId)) continue;
		if (imageDescriptionPaths(imageId).some((described) => paths.has(described))) continue;
		violations.push({
			kind: 'orphan-alignment',
			path,
			detail: `The Alignment ${path} would be left for a Map Image that is not there.`
		});
	}

	const shared = [...paths]
		.filter((path) => hoistedImageId(path) !== null)
		.map((path) => ({ path, bytes: 0 }));

	for (const directory of [...projects].sort()) {
		const path = projectFilePath(directory);
		const sha = prospective.get(path);
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
				path: sharedMaterial(unmet.reference) ? unmet.reference : `${directory}/${unmet.reference}`,
				detail: `The Layer “${unmet.layer}” in ${path} needs ${unmet.reference}, which would not be there.`
			});
		}
	}

	if (failures.length > 0) return { outcome: 'failed', failures };
	if (violations.length > 0) return { outcome: 'invalid', violations };
	return { outcome: 'valid' };
}

export function planWorkspaceSync(input: SynchronizationInput): WorkspaceSyncPlan {
	const comparison = compareSource(input);
	const prospective = prospectiveSource(comparison);
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
			continue;
		}
		if (row.comparison === 'outbound') {
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
			continue;
		}
		if (row.comparison === 'conflict') continue;
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
	const settled = new Set([...sendChanges.map((choice) => choice.path), ...sendRemoved]);
	const remoteOnly = [...remoteSource.keys()].filter((path) => !localSource.has(path)).sort();

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
			removed: remoteOnly,
			advances: new Map(localSource),
			retires: remoteOnly
		},
		leftAlone: [...remoteSource.keys()].filter((path) => !settled.has(path)).sort(),
		preserved: comparison.preserved,
		conflicts: comparison.rows.filter((row) => row.comparison === 'conflict'),
		prospective,
		retained: bucket(comparison, 'outbound'),
		comparison: workspaceComparison(comparison, prospective, input.projectFiles)
	};
}

const sortChoices = (choices: readonly PathChoice[]): readonly PathChoice[] =>
	[...choices].sort(byPath);

export const describeGraphFailure = (failures: readonly GraphFailure[]): string =>
	`The Remote's files could not be read, so nothing can be planned: ` +
	`${failures.map((failure) => failure.detail).join(' ')}`;

export const describeGraphViolations = (violations: readonly GraphViolation[]): string =>
	`Getting these changes would leave this Workspace incomplete: ` +
	`${violations.map((violation) => violation.detail).join(' ')} ` +
	`Nothing has been changed.`;
