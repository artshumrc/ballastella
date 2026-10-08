import { ALIGNMENT_DIRECTORY, alignmentPath } from '../alignment/alignment.js';
import { imageDirectory, imageInfoPath } from '../project/image-files.js';
import { layerReferences, type Layer } from '../project/layer.js';
import {
	PROJECT_FILE_NAME,
	ProjectFormatTooNewError,
	parseProjectFile,
	projectFilePath,
	type ProjectFile
} from '../project/project-file.js';
import {
	describeReviewSubject,
	type ReviewMark,
	type ReviewOrigin
} from '../project/review-workspace.js';
import { hoistedImageId } from '../project/workspace.js';
import { imageDescriptionPaths } from '../remote-iiif/referenced-image.js';
import {
	PathNotFoundError,
	messageOf,
	readIfPresent,
	type Bytes,
	type EnumerableReadOnlyProjectStore,
	type ProjectStore
} from '../store/project-store.js';
import { unsafeArchivePathReason } from './archive.js';
import { isViewerFile } from './viewer-files.js';

export type ClosurePath = string;

export type ProjectImportOrigin =
	| {
			readonly kind: 'github';
			readonly owner: string;
			readonly repository: string;
			readonly branch: string;
			readonly directory: string;
			readonly commit: string;
			readonly projectName: string;
	  }
	| {
			readonly kind: 'review';
			readonly projectName: string;
			readonly directory: string;
	  };

export const isSharedClosurePath = (path: ClosurePath): boolean => hoistedImageId(path) !== null;

export interface ClosureFile {
	readonly path: ClosurePath;
	readonly bytes: Bytes;
}

export interface ProjectImportSource {
	readonly origin: ProjectImportOrigin;
	readonly project: ProjectFile;
	readonly projectFileBytes: Bytes;
	readonly paths: readonly ClosurePath[];
	readonly totalBytes: number;
	files(): AsyncIterable<ClosureFile>;
}

type ImportSourceRefusal =
	| 'unsafe-path'
	| 'no-project-file'
	| 'malformed-project-file'
	| 'duplicate-entry'
	| 'missing-annotation'
	| 'missing-image'
	| 'incomplete-image'
	| 'missing-alignment'
	| 'incomplete';

export class ImportSourceRefusedError extends Error {
	override readonly name = 'ImportSourceRefusedError';
	constructor(
		readonly refusal: ImportSourceRefusal,
		message: string
	) {
		super(`${message} Nothing has been added to your Workspace.`);
	}
}

export interface OfferedFile {
	readonly path: string;
	readonly bytes: number;
}

interface UnmetClosureReference {
	readonly reference: ClosurePath;
	readonly layer: string;
	readonly refusal: Extract<
		ImportSourceRefusal,
		'missing-annotation' | 'missing-image' | 'incomplete-image'
	>;
}

export function parseImportedProjectFile(bytes: Bytes): ProjectFile {
	try {
		return parseProjectFile(bytes, 'Nothing has been added to your Workspace.');
	} catch (cause) {
		if (cause instanceof ProjectFormatTooNewError) throw cause;
		throw new ImportSourceRefusedError(
			'malformed-project-file',
			`The ${PROJECT_FILE_NAME} in this source could not be read as a Ballastella Project: ` +
				`${messageOf(cause).replace(/\.$/, '')}.`
		);
	}
}

export async function projectClosureFiles(
	store: EnumerableReadOnlyProjectStore,
	directory: string,
	layers: readonly Layer[]
): Promise<string[]> {
	const files = [...(await store.list(`${directory}/`))];
	const imageIds = new Set(
		layers.flatMap((layer) => (layer.kind === 'map' && layer.imageId !== '' ? [layer.imageId] : []))
	);
	for (const imageId of imageIds) {
		files.push(...(await store.list(`${imageDirectory(imageId)}/`)));
		if ((await sizeIfPresent(store, alignmentPath(imageId))) !== null) {
			files.push(alignmentPath(imageId));
		}
	}
	return files;
}

async function sizeIfPresent(
	store: EnumerableReadOnlyProjectStore,
	path: string
): Promise<number | null> {
	try {
		return await store.size(path);
	} catch (cause) {
		if (cause instanceof PathNotFoundError) return null;
		throw cause;
	}
}

export function gatherProjectClosure(
	project: ProjectFile,
	offered: Iterable<OfferedFile>
): { readonly paths: readonly ClosurePath[]; readonly unmet: readonly UnmetClosureReference[] } {
	const own = new Set<string>();
	const byImage = new Map<string, string[]>();
	const alignments = new Map<string, string>();

	for (const { path } of offered) {
		const shared = hoistedImageId(path);
		if (shared === null) {
			if (!isViewerFile(path)) own.add(path);
		} else if (path === alignmentPath(shared)) {
			alignments.set(shared, path);
		} else {
			const held = byImage.get(shared);
			if (held === undefined) byImage.set(shared, [path]);
			else held.push(path);
		}
	}

	const paths = new Set<ClosurePath>();
	if (own.has(PROJECT_FILE_NAME)) paths.add(PROJECT_FILE_NAME);
	const unmet: UnmetClosureReference[] = [];
	const taken = new Set<string>();

	for (const layer of project.layers) {
		const named = layer.name || layer.id;
		for (const reference of layerReferences(layer)) {
			if (reference === '') continue;
			if (own.has(reference)) paths.add(reference);
			else unmet.push({ reference, layer: named, refusal: 'missing-annotation' });
		}

		if (layer.kind !== 'map' || layer.imageId === '' || taken.has(layer.imageId)) continue;
		const directory = imageDirectory(layer.imageId);
		const files = byImage.get(layer.imageId) ?? [];
		if (files.length === 0) {
			unmet.push({ reference: `${directory}/`, layer: named, refusal: 'missing-image' });
			continue;
		}
		if (!imageDescriptionPaths(layer.imageId).some((path) => files.includes(path))) {
			unmet.push({
				reference: imageInfoPath(layer.imageId),
				layer: named,
				refusal: 'incomplete-image'
			});
			continue;
		}
		taken.add(layer.imageId);
		for (const path of files) paths.add(path);
		const alignment = alignments.get(layer.imageId);
		if (alignment !== undefined) paths.add(alignment);
	}

	return { paths: [...paths].sort(), unmet };
}

export function createProjectImportSource(input: {
	readonly origin: ProjectImportOrigin;
	readonly project: ProjectFile;
	readonly projectFileBytes: Bytes;
	readonly offered: readonly OfferedFile[];
	readonly files: (paths: readonly ClosurePath[]) => AsyncIterable<ClosureFile>;
}): ProjectImportSource {
	const declared = new Map<string, number>();
	for (const offer of input.offered) {
		if (unsafeArchivePathReason(offer.path, 'Project') !== null) {
			throw new ImportSourceRefusedError(
				'unsafe-path',
				`This source holds an entry that would not stay inside the Project: “${offer.path}”.`
			);
		}
		if (declared.has(offer.path)) {
			throw new ImportSourceRefusedError(
				'duplicate-entry',
				`This source holds “${offer.path}” more than once, so which copy of it belongs to the ` +
					`Project cannot be decided. Everything else in it is read against ${PROJECT_FILE_NAME}, ` +
					`so going on would be guessing.`
			);
		}
		declared.set(offer.path, offer.bytes);
	}

	const { paths, unmet } = gatherProjectClosure(input.project, input.offered);
	const [first] = unmet;
	if (first !== undefined) {
		const rest =
			unmet.length === 1
				? ''
				: ` ${unmet.length - 1} other ${unmet.length === 2 ? 'reference is' : 'references are'} ` +
					`missing too: ${unmet
						.slice(1)
						.map((one) => `“${one.reference}”`)
						.join(', ')}.`;
		throw new ImportSourceRefusedError(
			first.refusal,
			`This Project needs “${first.reference}”, which the Layer “${first.layer}” is drawn from, and ` +
				`the source does not hold it.${rest}`
		);
	}
	if (!paths.includes(PROJECT_FILE_NAME)) {
		throw new ImportSourceRefusedError(
			'no-project-file',
			`This source holds no ${PROJECT_FILE_NAME} for the Project it names.`
		);
	}

	return {
		origin: input.origin,
		project: input.project,
		projectFileBytes: input.projectFileBytes,
		paths,
		totalBytes: paths.reduce((sum, path) => sum + (declared.get(path) ?? 0), 0),
		files: () => deliver(input.files(paths), paths)
	};
}

async function* deliver(
	source: AsyncIterable<ClosureFile>,
	paths: readonly ClosurePath[]
): AsyncIterable<ClosureFile> {
	const outstanding = new Set(paths);
	for await (const file of source) {
		if (outstanding.delete(file.path)) yield file;
	}
	const first = [...outstanding].sort()[0];
	if (first === undefined) return;
	throw new ImportSourceRefusedError(
		first.startsWith(`${ALIGNMENT_DIRECTORY}/`) ? 'missing-alignment' : 'incomplete',
		`This source listed “${first}” and then did not hand it over, so the Project would arrive ` +
			`incomplete. ${
				outstanding.size === 1 ? 'It' : `${outstanding.size} of its files`
			} could not be read.`
	);
}

export async function readReviewWorkspaceSource(options: {
	readonly store: EnumerableReadOnlyProjectStore;
	readonly mark: ReviewMark;
}): Promise<ProjectImportSource> {
	const { store, mark } = options;
	const directory = mark.directory;
	if (directory === '') {
		throw new ImportSourceRefusedError(
			'no-project-file',
			`This review copy does not record which Project it holds, so it was interrupted before the ` +
				`Project was complete.`
		);
	}

	const projectFileBytes = await readIfPresent(store, projectFilePath(directory));
	if (projectFileBytes === null) {
		throw new ImportSourceRefusedError(
			'no-project-file',
			`This review copy holds no ${PROJECT_FILE_NAME} for “${directory}”.`
		);
	}
	const project = parseImportedProjectFile(projectFileBytes);
	const prefix = `${directory}/`;
	const offered: OfferedFile[] = [];
	for (const path of await projectClosureFiles(store, directory, project.layers)) {
		const bytes = await sizeIfPresent(store, path);
		if (bytes === null) continue;
		offered.push({ path: path.startsWith(prefix) ? path.slice(prefix.length) : path, bytes });
	}

	return createProjectImportSource({
		origin: { kind: 'review', projectName: mark.project || project.name, directory },
		project,
		projectFileBytes,
		offered,
		files: async function* (paths) {
			for (const path of paths) {
				const bytes = await readIfPresent(store, isSharedClosurePath(path) ? path : prefix + path);
				if (bytes !== null) yield { path, bytes };
			}
		}
	});
}

export interface ReviewDestination {
	readonly name: string;
	readonly store: ProjectStore;
	readonly origin: ReviewOrigin | null;
	discard(): Promise<void>;
}

export type OpenReviewDestination = (preferredName: string) => Promise<ReviewDestination>;

type ReviewDestinationRefusal = 'no-origin' | 'gone' | 'unreachable' | 'permission-denied';

export class ReviewDestinationUnavailableError extends Error {
	override readonly name = 'ReviewDestinationUnavailableError';
	constructor(
		readonly refusal: ReviewDestinationRefusal,
		message: string
	) {
		super(`${message} Nothing has been Imported, and this review copy is still here.`);
	}
}

export function reviewImportOrigin(mark: ReviewMark): ReviewOrigin {
	if (mark.origin !== null) return mark.origin;
	throw new ReviewDestinationUnavailableError(
		'no-origin',
		`This review copy does not record which of your Workspaces it was opened from, so there is no ` +
			`one Workspace to Import ${describeReviewSubject(mark)} into — and Ballastella will not ` +
			`choose one for you. Go back to your own Workspace and Import the file or the link there ` +
			`instead.`
	);
}

export function refuseReviewDestination(
	origin: ReviewOrigin,
	refusal: Exclude<ReviewDestinationRefusal, 'no-origin'>
): never {
	const named = origin.backing === 'folder' ? `the folder “${origin.name}”` : `“${origin.name}”`;
	const because = {
		gone: `and ${named} is not there any more — deleted, or replaced by something else of the same name.`,
		unreachable: `and ${named} cannot be reached from this browser right now.`,
		'permission-denied': `and Ballastella was not given permission to write there.`
	};
	throw new ReviewDestinationUnavailableError(
		refusal,
		`This review copy was opened from ${named}, ${because[refusal]}`
	);
}

export const reviewCopyStillHere = (reviewWorkspaceName: string, projectName: string): string =>
	`“${projectName}” was Imported and is in your Workspace. The review copy ` +
	`“${reviewWorkspaceName}” could not be discarded, so it is still in your list of Workspaces — ` +
	`open it and discard it from the banner when you are ready.`;
