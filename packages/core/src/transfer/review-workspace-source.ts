// One Project in a Review Workspace, offered as a read-only Import source (ADR-0037).
//
// The cheapest of the three adapters and the one that shows the boundary most plainly: the bytes are
// already on this computer, in a Workspace this build wrote, so there is nothing to fetch, no archive
// to walk and no listing to distrust. What there is instead is a *capability* question — a Review
// Workspace source is handed `EnumerableReadOnlyProjectStore`, which has a `read`, a `list` and a
// `size` and no way to write anything anywhere. Under ADR-0024 the fence was that no reader was given
// a store at all; under ADR-0037 the fence is that the store a reader is given cannot write.
//
// ⚠ **This reads the Review Workspace's *current* state, which is the point.** A reviewer may have
// edited what they were sent before deciding to keep it, and what they keep is what is on screen
// rather than what arrived.

import { PROJECT_FILE_NAME, projectFilePath, type ProjectFile } from '../project/project-file.js';
import type { ReviewMark } from '../project/review-workspace.js';
import { imageDirectory } from '../project/image-files.js';
import { alignmentPath } from '../alignment/alignment.js';
import {
	PathNotFoundError,
	type Bytes,
	type EnumerableReadOnlyProjectStore,
	type StorePath
} from '../store/project-store.js';
import {
	ImportSourceRefusedError,
	createProjectImportSource,
	isSharedClosurePath,
	parseImportedProjectFile,
	type ClosureFile,
	type ClosurePath,
	type OfferedFile,
	type ProjectImportSource
} from './project-import-source.js';

/**
 * Which Project in which Review Workspace to Import.
 *
 * ⚠ **The store is the read-only capability and not `ProjectStore`.** There is no destination
 * parameter here and no way to add one: a Review Workspace source can be built while the reviewer's
 * own Workspace is nowhere in scope, and combining the two is the Import engine's business alone
 * (ADR-0037).
 */
export interface ReviewWorkspaceSourceOptions {
	readonly store: EnumerableReadOnlyProjectStore;
	/** The Review Workspace's own mark, which is where the Project's directory is recorded. */
	readonly mark: ReviewMark;
}

/**
 * Read the Project a Review Workspace holds, validated and ready for Import.
 *
 * The mark names the directory. **A mark that names none is refused rather than guessed at**: an
 * interrupted open writes a mark with an empty `directory` before any Project byte lands
 * (`open-project-bundle.ts`, step 2), so a Workspace in that state holds a partial Project and
 * choosing a directory for it by scanning would be adopting exactly the half-written work the mark
 * exists to warn about.
 *
 * @throws ImportSourceRefusedError
 * @throws ProjectFormatTooNewError for a Project from a newer version of the app (ADR-0010)
 */
export async function readReviewWorkspaceSource(
	options: ReviewWorkspaceSourceOptions
): Promise<ProjectImportSource> {
	const { store, mark } = options;
	const directory = mark.directory;
	if (directory === '') {
		throw new ImportSourceRefusedError(
			'no-project-file',
			`This review copy does not record which Project it holds, so it was interrupted before the ` +
				`Project was complete.`
		);
	}

	const prefix = `${directory}/`;
	let projectFileBytes: Bytes;
	try {
		projectFileBytes = await store.read(projectFilePath(directory) as StorePath);
	} catch (cause) {
		if (!(cause instanceof PathNotFoundError)) throw cause;
		throw new ImportSourceRefusedError(
			'no-project-file',
			`This review copy holds no ${PROJECT_FILE_NAME} for “${directory}”.`
		);
	}
	const project = parseImportedProjectFile(projectFileBytes);

	const offered = await offer(store, project, prefix);
	return createProjectImportSource({
		origin: { kind: 'review', projectName: mark.project || project.name, directory },
		project,
		projectFileBytes,
		offered,
		files: (paths) => read(store, prefix, paths)
	});
}

/**
 * What the Review Workspace holds for this Project, Project-relative.
 *
 * **One `list` per referenced Map Image rather than one walk of `images/`**, the rule
 * `export-project-bundle.ts` follows for the same reason: a Review Workspace holds one Project today,
 * but the shared pool is the Workspace's (ADR-0023) and a source that enumerated all of it would be
 * asking a question whose answer it must not use.
 */
async function offer(
	store: EnumerableReadOnlyProjectStore,
	project: ProjectFile,
	prefix: string
): Promise<OfferedFile[]> {
	const sized = async (path: string): Promise<OfferedFile | null> => {
		try {
			return { path, bytes: await store.size(path as StorePath) };
		} catch (cause) {
			// Gone between the `list` and the `size`. Left out, so it is either not in the closure at all
			// or refused as a missing reference — never offered as a path with a size nobody measured.
			if (cause instanceof PathNotFoundError) return null;
			throw cause;
		}
	};

	const offered: OfferedFile[] = [];
	for (const path of await store.list(prefix)) {
		const file = await sized(path);
		if (file !== null) offered.push({ path: path.slice(prefix.length), bytes: file.bytes });
	}

	const imageIds = new Set(
		project.layers.flatMap((layer) =>
			layer.kind === 'map' && layer.imageId !== '' ? [layer.imageId] : []
		)
	);
	for (const imageId of imageIds) {
		for (const path of await store.list(`${imageDirectory(imageId)}/`)) {
			const file = await sized(path);
			if (file !== null) offered.push(file);
		}
		// A Map Image nobody has placed yet has no Alignment, which is ordinary (ADR-0023).
		const alignment = await sized(alignmentPath(imageId));
		if (alignment !== null) offered.push(alignment);
	}
	return offered;
}

/** The closure's bytes, one file at a time, back at the Workspace paths they live at. */
async function* read(
	store: EnumerableReadOnlyProjectStore,
	prefix: string,
	paths: readonly ClosurePath[]
): AsyncIterable<ClosureFile> {
	for (const path of paths) {
		const at = (isSharedClosurePath(path) ? path : `${prefix}${path}`) as StorePath;
		try {
			yield { path, bytes: await store.read(at) };
		} catch (cause) {
			// Skipped rather than rethrown, so the one place that decides what an incomplete source means
			// is `createProjectImportSource`'s delivery check — which names every file that failed rather
			// than the first one to throw.
			if (!(cause instanceof PathNotFoundError)) throw cause;
		}
	}
}
