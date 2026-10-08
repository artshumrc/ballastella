import { alignmentImageId } from '../alignment/alignment.js';
import { parseAlignment } from '../alignment/georeference-annotation.js';
import {
	ANNOTATION_DIRECTORY,
	addLayer,
	annotationPath,
	moveLayer,
	newAnnotationLayer,
	type Layer
} from '../project/layer.js';
import {
	parseProjectFile,
	projectFilePath,
	serialiseProjectFile,
	isProjectManifest
} from '../project/project-file.js';
import { foldName, takenDirectoryNames, unusedDirectoryName } from '../project/workspace.js';
import {
	topLevelSegment,
	type Bytes,
	type ProjectStore,
	type StorePath
} from '../store/project-store.js';
import { rawReader } from './github-api.js';
import { readRemoteCommitDate } from './remote-tree.js';
import { byPath, recognisedProjectDirectories } from './synchronization-paths.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import type { RemoteRelationship } from './synchronization-metadata.js';
import type { SourcePath } from './synchronization-planner.js';

const CONFLICT_COPY_SUFFIX = '(from GitHub)';
const conflictCopyName = (name: string): string => `${name} ${CONFLICT_COPY_SUFFIX}`;

interface ContestedProject {
	readonly directory: string;
	readonly path: string;
}

interface ContestedLayer {
	readonly project: string;
	readonly layerId: string;
	readonly path: string;
}

interface ContestedAlignment {
	readonly imageId: string;
	readonly path: string;
}

interface ContestedThings {
	readonly projects: readonly ContestedProject[];
	readonly layers: readonly ContestedLayer[];
	readonly alignments: readonly ContestedAlignment[];
	readonly other: readonly string[];
}

const LAYER_FILE = new RegExp(`^([^/]*)/${ANNOTATION_DIRECTORY}/([^/]+)\\.geojson$`);

function classifyConflicts(conflicts: readonly SourcePath[]): ContestedThings {
	const contested = conflicts
		.filter((row) => row.remote !== null)
		.map((row) => row.path)
		.sort();
	const projects = contested
		.filter(isProjectManifest)
		.map((path) => ({ directory: topLevelSegment(path), path }));
	const doubled = new Set(projects.map((project) => project.directory));
	const layers: ContestedLayer[] = [];
	const alignments: ContestedAlignment[] = [];
	const other: string[] = [];

	for (const path of contested) {
		const imageId = alignmentImageId(path);
		if (imageId !== null) {
			alignments.push({ imageId, path });
			continue;
		}
		if (doubled.has(topLevelSegment(path))) continue;
		const [, project, layerId] = LAYER_FILE.exec(path) ?? [];
		if (project !== undefined && layerId !== undefined) layers.push({ project, layerId, path });
		else other.push(path);
	}

	return { projects, layers, alignments, other };
}

interface ConflictCopyFile {
	readonly path: string;
	readonly bytes: Bytes;
	readonly effect: 'add' | 'replace';
}

export type ConflictCopy =
	| {
			readonly kind: 'layer';
			readonly contested: string;
			readonly project: string;
			readonly name: string;
			readonly path: string;
	  }
	| {
			readonly kind: 'project';
			readonly contested: string;
			readonly name: string;
			readonly directory: string;
	  };

export interface ConflictResolution {
	readonly copies: readonly ConflictCopy[];
	readonly files: readonly ConflictCopyFile[];
	readonly settled: readonly string[];
	readonly alignments: readonly ContestedAlignment[];
	readonly unresolved: readonly string[];
}

export async function resolveConflicts(options: {
	readonly conflicts: readonly SourcePath[];
	readonly remote: Iterable<string>;
	readonly local: Iterable<string>;
	readonly baseline?: Iterable<string>;
	readonly readRemote: (path: string) => Promise<Bytes>;
	readonly readManifest: (path: string) => Promise<Bytes>;
	readonly mintLayerId?: () => string;
}): Promise<ConflictResolution> {
	const contested = classifyConflicts(options.conflicts);
	const mintLayerId = options.mintLayerId ?? ((): string => crypto.randomUUID());
	const remote = [...options.remote];
	const copies: ConflictCopy[] = [];
	const files: ConflictCopyFile[] = [];
	const settled: string[] = [];
	const taken = takenDirectoryNames(options.local);
	for (const directory of recognisedProjectDirectories({
		remote,
		baseline: [...(options.baseline ?? [])]
	})) {
		taken.add(foldName(directory));
	}

	const contestedPaths = new Set(contested.projects.map((project) => project.path));
	for (const row of options.conflicts) contestedPaths.add(row.path);

	for (const project of contested.projects) {
		const manifest = parseProjectFile(await options.readRemote(project.path));
		const name = conflictCopyName(manifest.name);
		const directory = unusedDirectoryName(name, taken);
		taken.add(foldName(directory));

		for (const path of remote) {
			if (!path.startsWith(`${project.directory}/`)) continue;
			const destination = `${directory}/${path.slice(project.directory.length + 1)}`;
			files.push({
				path: destination,
				bytes:
					path === project.path
						? serialiseProjectFile({ ...manifest, name, onFrontPage: false })
						: await options.readRemote(path),
				effect: 'add'
			});
			if (contestedPaths.has(path)) settled.push(path);
		}
		settled.push(project.path);
		copies.push({ kind: 'project', contested: project.path, name, directory });
	}

	const byProject = new Map<string, ContestedLayer[]>();
	for (const layer of contested.layers) {
		const held = byProject.get(layer.project);
		if (held === undefined) byProject.set(layer.project, [layer]);
		else held.push(layer);
	}

	for (const [directory, contestedLayers] of [...byProject].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const path = projectFilePath(directory);
		const manifest = parseProjectFile(await options.readManifest(path));
		let layers = manifest.layers;
		for (const contestedLayer of contestedLayers) {
			const original = layers.find((layer) => layer.id === contestedLayer.layerId);
			const copy = newAnnotationLayer({
				id: mintLayerId(),
				name: conflictCopyName(original?.name ?? contestedLayer.layerId)
			});
			layers = beside(addLayer(layers, copy), copy.id, original?.id);
			files.push({
				path: `${directory}/${annotationPath(copy.id)}`,
				bytes: await options.readRemote(contestedLayer.path),
				effect: 'add'
			});
			settled.push(contestedLayer.path);
			copies.push({
				kind: 'layer',
				contested: contestedLayer.path,
				project: directory,
				name: copy.name,
				path: `${directory}/${annotationPath(copy.id)}`
			});
		}
		files.push({
			path,
			bytes: serialiseProjectFile({ ...manifest, layers }),
			effect: 'replace'
		});
	}

	return {
		copies,
		files: files.sort(byPath),
		settled: settled.sort(),
		alignments: contested.alignments,
		unresolved: contested.other
	};
}

function beside(
	layers: readonly Layer[],
	copyId: string,
	originalId: string | undefined
): readonly Layer[] {
	if (originalId === undefined) return layers;
	const at = layers.findIndex((layer) => layer.id === originalId);
	return at === -1 ? layers : moveLayer(layers, copyId, at);
}

interface AlignmentSide {
	readonly controlPoints: number;
	readonly at: Date | null;
}

export interface AlignmentQuestion {
	readonly imageId: string;
	readonly path: string;
	readonly mine: AlignmentSide;
	readonly theirs: AlignmentSide;
}

export type AlignmentChoice = 'keep-mine' | 'take-theirs';

// Never throws: an unreadable side counts nought points and no date, so the Sync carries on.
export async function readAlignmentQuestions(options: {
	readonly contested: readonly ContestedAlignment[];
	readonly store: ProjectStore;
	readonly readRemote: (path: string) => Promise<Bytes>;
	readonly remoteAt?: Date | null;
}): Promise<readonly AlignmentQuestion[]> {
	const questions: AlignmentQuestion[] = [];
	for (const contested of options.contested) {
		questions.push({
			imageId: contested.imageId,
			path: contested.path,
			mine: {
				controlPoints: countControlPoints(
					await options.store.read(contested.path as StorePath).catch(() => null),
					contested.imageId
				),
				at: await modifiedAt(options.store, contested.path)
			},
			theirs: {
				controlPoints: countControlPoints(
					await options.readRemote(contested.path).catch(() => null),
					contested.imageId
				),
				at: options.remoteAt ?? null
			}
		});
	}
	return questions;
}

function countControlPoints(bytes: Bytes | null, imageId: string): number {
	if (bytes === null) return 0;
	try {
		return parseAlignment(bytes, { imageId }).controlPoints.length;
	} catch {
		return 0;
	}
}

async function modifiedAt(store: ProjectStore, path: string): Promise<Date | null> {
	const at = await store.modifiedAt?.(path as StorePath).catch(() => null);
	return typeof at === 'number' ? new Date(at) : null;
}

export async function readContestedAlignments(
	store: ProjectStore,
	options: {
		readonly remote: RemoteRelationship;
		readonly commit: string | null;
		readonly conflicts: readonly SourcePath[];
		readonly fetch?: FetchFn;
	}
): Promise<readonly AlignmentQuestion[]> {
	const contested = classifyConflicts(options.conflicts).alignments;
	if (contested.length === 0) return [];

	return readAlignmentQuestions({
		contested,
		store,
		readRemote: rawReader(options.remote, options.commit ?? options.remote.branch, options.fetch),
		remoteAt:
			options.commit === null
				? null
				: await readRemoteCommitDate(options.remote, options.commit, options.fetch)
	});
}
