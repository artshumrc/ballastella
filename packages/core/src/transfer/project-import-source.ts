// The read-only source boundary for Project Import (ADR-0037).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ONE VALIDATED CLOSURE, THREE PLACES IT CAN COME FROM, AND NOTHING TO WRITE INTO
//
// A Project can arrive from a Project Bundle, from a Project on somebody's Published Site, or from
// the Review Workspace a reviewer already has open. Those three differ only in where the bytes are
// and how they are named; what a Project *is* — `project.json`, the Annotations its Layers name, and
// the Map Images those Layers draw — is the same question, and it is answered once here.
//
// ⚠ **The structural fence moved; it did not go away.** ADR-0024 forbade promotion outright, so the
// bundle and Review readers were built to be handed no store they could write into. ADR-0037 replaces
// that prohibition with a boundary: a source reader still cannot receive an ordinary writable
// destination, and only the Import engine may hold a validated closure and a writable Workspace at
// the same time. That is why nothing in this module names a `ProjectStore`, and why
// `ProjectImportSource` exposes no `write` and no `delete` — there is no destination here to pass one
// to.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CLOSURE IS PROJECT-RELATIVE, WHICH IS WHAT MAKES THE THREE SOURCES COMPARABLE
//
// A bundle's entries are already Project-relative (`project.json` at the root, `images/<id>/…` and
// `alignments/<id>.json` hoisted); a Workspace and a Remote's tree spell the Project's own files
// under `<directory>/` and share the same pool at the same names. So an adapter over a
// Workspace-shaped source strips the Project's directory and everything else lines up — and the same
// Project offered as a bundle, as a Remote's tree, and as a Review Workspace reports the *same* path
// set rather than three that have to be trusted to agree.
//
// ⚠ **This closure is narrower than what a Review downloads, deliberately.** `reviewFromRemote` and
// `openProjectBundle` carry every file in the Project's directory, because a reviewer is being shown
// what an author shared. An Import copies work into a Workspace the user owns, and ADR-0037
// defines what it copies: the Project, the Annotations its Layers *reference*, and the Map Images
// those Layers draw. An unreferenced file in a stranger's Project directory is not part of the
// Project.

import { ALIGNMENT_DIRECTORY, alignmentPath } from '../alignment/alignment.js';
import { imageDirectory } from '../project/image-files.js';
import {
	BALLASTELLA_CANONICAL_URL,
	PROJECT_FILE_NAME,
	ProjectFormatTooNewError,
	parseProjectFile,
	type ProjectFile
} from '../project/project-file.js';
import { hoistedImageId } from '../project/workspace.js';
import { REFERENCED_IMAGE_FILE } from '../remote-iiif/referenced-image.js';
import { layerReferences } from './open-project-bundle.js';
import { BundleRejectedError, assertSafeBundlePath } from './project-bundle.js';
import { isViewerFile } from './viewer-files.js';

/**
 * A path inside a validated closure, relative to the Project.
 *
 * `project.json` and `annotations/…` for the Project's own files; `images/<id>/…` and
 * `alignments/<id>.json` for the shared material, at the names a Workspace gives them.
 */
export type ClosurePath = string;

/**
 * What was **observed** about where a closure came from. Nothing that could be acted on.
 *
 * ⚠ **Facts, not a relationship.** This carries no credential, no writable destination, and no Remote
 * a destination Workspace could connect itself to: an imported Project keeps no relationship with
 * its source (ADR-0037), and the only thing these fields are for is the provenance entry the Import
 * engine appends. Nothing here may become a relationship.
 */
export type ProjectImportOrigin =
	| {
			readonly kind: 'project-bundle';
			/** The file the user picked, untrusted and for display only. `''` when unknown. */
			readonly fileName: string;
			readonly projectName: string;
	  }
	| {
			readonly kind: 'github';
			readonly owner: string;
			readonly repository: string;
			readonly branch: string;
			/** The Project's directory on the Remote, which is a Project's identity (ADR-0008). */
			readonly directory: string;
			/**
			 * The commit the branch stood at when the Project was read.
			 *
			 * **Which state of it, where the fields above say which Project.** A commit is not a
			 * relationship: nothing fetches from it, nothing tracks it, and an Import that records one
			 * gains no way to hear about the next one.
			 */
			readonly commit: string;
			readonly projectName: string;
	  }
	| {
			readonly kind: 'review';
			readonly projectName: string;
			/** The Project's directory inside the Review Workspace. */
			readonly directory: string;
	  };

/**
 * Whether a closure path is the Workspace's **shared material** rather than the Project's own.
 *
 * `hoistedImageId` is the codebase's one answer to that split — it is what a bundle's entries are
 * hoisted by — so an adapter mapping a closure path back onto a Workspace or Remote path cannot
 * disagree with the mapping that produced it.
 */
export const isSharedClosurePath = (path: ClosurePath): boolean => hoistedImageId(path) !== null;

/** One file of a closure, as it comes off its source. */
export interface ClosureFile {
	readonly path: ClosurePath;
	readonly bytes: Uint8Array<ArrayBuffer>;
}

/**
 * A validated Project closure, offered for reading and for nothing else.
 *
 * ⚠ **The public shape is the fence.** There is no `write`, no `delete`, no destination store and no
 * credential on it, so a holder of one cannot put a byte anywhere; combining this with a writable
 * ordinary Workspace is the Import engine's job and only its (ADR-0037).
 */
export interface ProjectImportSource {
	readonly origin: ProjectImportOrigin;
	/** The parsed `project.json`, already refused if it is from a newer build (ADR-0010). */
	readonly project: ProjectFile;
	/**
	 * The manifest's bytes, verbatim.
	 *
	 * Held rather than re-serialised from {@link ProjectImportSource.project}, and available apart
	 * from {@link ProjectImportSource.files} so a consumer can keep every transfer path's discipline
	 * of writing `project.json` last: a Workspace's list of Projects *is* whichever directories hold
	 * one (ADR-0008).
	 */
	readonly projectFileBytes: Uint8Array<ArrayBuffer>;
	/** Every path in the closure, sorted, `project.json` included. */
	readonly paths: readonly ClosurePath[];
	/**
	 * What the closure weighs, as its source declares it.
	 *
	 * A bound for a quota check rather than a measurement: a tar's headers and a GitHub tree listing
	 * both declare sizes, and no file is read to answer this.
	 */
	readonly totalBytes: number;
	/**
	 * The closure's files, one at a time, in whatever order the source can produce them cheapest in.
	 *
	 * **Iteration rather than random access, because a tar has no index**: a bundle answers this in
	 * one further pass over the archive, where a `read(path)` per file would walk the archive once per
	 * file. Peak memory is one file, for every source.
	 *
	 * Yields exactly {@link ProjectImportSource.paths}. A source that runs out before it has delivered
	 * them all refuses rather than ending quietly — see {@link ImportSourceRefusal} `'incomplete'`.
	 */
	files(): AsyncIterable<ClosureFile>;
}

/** Why a source will not be offered for Import. Every one of them leaves the Workspace untouched. */
export type ImportSourceRefusal =
	/** A path that would not stay inside the Project it claims to be part of. */
	| 'unsafe-path'
	/** No `project.json` where this kind of source keeps one, so there is no Project here. */
	| 'no-project-file'
	/** `project.json` is not a Project this build can read. */
	| 'malformed-project-file'
	/** The source names one closure path twice, so which bytes are the Project's cannot be decided. */
	| 'duplicate-entry'
	/** A Layer names an Annotation the source does not hold. */
	| 'missing-annotation'
	/** A map Layer names a Map Image the source does not hold at all. */
	| 'missing-image'
	/** A Map Image directory that describes itself as neither a local copy nor a referenced image. */
	| 'incomplete-image'
	/** An Alignment the closure counted on turned out not to be there when it was read. */
	| 'missing-alignment'
	/** The source stopped short of the closure it declared. */
	| 'incomplete';

/**
 * A source that will not be Imported, with a message for the person who asked for it.
 *
 * Every message ends on the same sentence, and unlike the Review's it is unconditional: validation
 * finishes before the Import engine is given the closure, so a refusal here lands before any
 * destination path has been allocated, let alone written.
 */
export class ImportSourceRefusedError extends Error {
	readonly refusal: ImportSourceRefusal;

	constructor(refusal: ImportSourceRefusal, message: string) {
		super(`${message} Nothing has been added to your Workspace.`);
		this.name = 'ImportSourceRefusedError';
		this.refusal = refusal;
	}
}

/** One path a source is offering, with the byte length it declares for it. */
export interface OfferedFile {
	/** Project-relative. */
	readonly path: string;
	readonly bytes: number;
}

/**
 * A file the Project references that the source does not hold.
 *
 * Named in the same words the Review path uses — the Layer as its card names it, and the path its
 * author would have to supply — because a refusal a user cannot act on is worse than one that names
 * the file.
 */
export interface UnmetClosureReference {
	readonly reference: ClosurePath;
	readonly layer: string;
	readonly refusal: Extract<
		ImportSourceRefusal,
		'missing-annotation' | 'missing-image' | 'incomplete-image'
	>;
}

/** A closure and what it could not resolve. */
export interface ProjectClosure {
	readonly paths: readonly ClosurePath[];
	readonly unmet: readonly UnmetClosureReference[];
}

/**
 * Parse a source's `project.json`, refusing one this build must not touch.
 *
 * {@link ProjectFormatTooNewError} passes through as itself, with the source path's closing sentence:
 * ADR-0010's refusal already names the remedy, and every caller that catches it still does. Anything
 * else `parseProjectFile` objects to is a source refusal, because a manifest that will not parse is
 * not a Project however the bytes arrived.
 *
 * @throws ImportSourceRefusedError `'malformed-project-file'`
 * @throws ProjectFormatTooNewError for a Project from a newer version of the app (ADR-0010)
 */
export function parseImportedProjectFile(bytes: Uint8Array<ArrayBuffer>): ProjectFile {
	try {
		return parseProjectFile(bytes);
	} catch (cause) {
		if (cause instanceof ProjectFormatTooNewError) {
			throw new ProjectFormatTooNewError(
				cause.formatVersion,
				BALLASTELLA_CANONICAL_URL,
				'Nothing has been added to your Workspace.'
			);
		}
		throw new ImportSourceRefusedError(
			'malformed-project-file',
			`The ${PROJECT_FILE_NAME} in this source could not be read as a Ballastella Project: ` +
				`${cause instanceof Error ? cause.message.replace(/\.$/, '') : String(cause)}.`
		);
	}
}

/**
 * What Import copies, out of what a source offers. **The one answer to that question.**
 *
 * ADR-0037's closure and no more: the manifest, every Annotation a Layer names, and each *distinct*
 * referenced Map Image with its image description, its pyramid, and its Alignment if it has one. A
 * Map Image no Layer of this Project draws does not travel — a Workspace holds a shared pool
 * (ADR-0023) and the recipient has no business receiving a pyramid this Project never points at.
 *
 * The references come from `layerReferences`, shared with the bundle reader, so a Layer kind added
 * later cannot mean one thing to a bundle and another to an Import.
 *
 * ⚠ **An Alignment is taken when it is there and never required.** A Map Image added to a Project is
 * a Layer from that moment, aligned or not (ADR-0023), so an unaligned map legitimately has no
 * `alignments/<id>.json` and its absence is not a missing reference. The Layer carries no
 * `alignmentRef` either — the path is derived from `imageId` — so there is no Alignment *reference*
 * that can dangle. What can still go wrong is a source losing one between declaring it and delivering
 * it, which {@link createProjectImportSource} refuses as `'missing-alignment'`.
 *
 * ⚠ **Generated Published Site files are dropped rather than refused.** `isViewerFile` is asked of the
 * Project-relative name, exactly as the exporter and the Review reader ask it, because a Project
 * directory somebody unpacked a Published Site into holds the viewer's own output — and that is
 * the site's, regenerated by the next Sync, not the author's scholarship (ADR-0045).
 *
 * One pass over what is offered, bucketed by what each path is under, so a Project with fifty maps
 * does not walk a fifty-thousand-file listing fifty times.
 */
export function gatherProjectClosure(
	project: ProjectFile,
	offered: Iterable<OfferedFile>
): ProjectClosure {
	/** The Project's own files, by Project-relative path. */
	const own = new Set<string>();
	const byImage = new Map<string, string[]>();
	const alignments = new Map<string, string>();

	for (const { path } of offered) {
		const shared = hoistedImageId(path);
		if (shared === null) {
			if (!isViewerFile(path)) own.add(path);
			continue;
		}
		if (path === alignmentPath(shared)) {
			alignments.set(shared, path);
			continue;
		}
		const held = byImage.get(shared);
		if (held === undefined) byImage.set(shared, [path]);
		else held.push(path);
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

		// A map Layer is the only kind asked about a Map Image, which is the judgement
		// `layerReferences` makes about the same field: this build cannot know that a foreign kind's
		// `imageId` names a Map Image at all.
		if (layer.kind !== 'map' || layer.imageId === '') continue;
		if (taken.has(layer.imageId)) continue;
		const directory = imageDirectory(layer.imageId);
		const files = byImage.get(layer.imageId) ?? [];
		if (files.length === 0) {
			unmet.push({ reference: `${directory}/`, layer: named, refusal: 'missing-image' });
			continue;
		}
		// **Two ways to be describable, because there are two kinds of image.** A local copy has the
		// `info.json` that makes its pyramid readable; a referenced image has `remote.json` instead,
		// because its tiles and its `info.json` are on somebody else's server. A heap of tiles with
		// neither is a directory no client can open (ADR-0023's layout), and requiring `info.json` of
		// both would refuse a Project whose Map Image is referenced rather than copied.
		const describable =
			files.includes(`${directory}/info.json`) ||
			files.includes(`${directory}/${REFERENCED_IMAGE_FILE}`);
		if (!describable) {
			unmet.push({
				reference: `${directory}/info.json`,
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

/**
 * What a source has to supply for a closure to be built from it.
 *
 * ⚠ **No destination of any kind, and there is nowhere to add one.** ADR-0037's boundary is that a
 * source reader cannot receive a writable ordinary Workspace; the way that is held is that neither
 * this input nor {@link ProjectImportSource} has a store on it at all.
 */
export interface ProjectImportSourceInput {
	readonly origin: ProjectImportOrigin;
	readonly project: ProjectFile;
	readonly projectFileBytes: Uint8Array<ArrayBuffer>;
	/** Every Project-relative path the source holds, `project.json` included. */
	readonly offered: readonly OfferedFile[];
	/** The bytes of the closure, asked for once, in whatever order the source is cheapest in. */
	readonly files: (paths: readonly ClosurePath[]) => AsyncIterable<ClosureFile>;
}

/**
 * Validate what a source offers and hand back a closure that may be Imported.
 *
 * **Everything decidable from the paths is decided here, before a consumer sees any of it**, which is
 * what makes ADR-0037's "refused before installation" a fact about the order rather than a promise:
 * an unsafe path, a source naming one path twice, and every class of dangling reference are refusals
 * of the *source*, and nothing has been allocated or written when one lands.
 *
 * The graph is validated whole rather than per file: {@link gatherProjectClosure} resolves every
 * reference the retained Project holds, and a single unresolved one refuses the source. There is no
 * partial Import to fall back to.
 *
 * @throws ImportSourceRefusedError
 */
export function createProjectImportSource(input: ProjectImportSourceInput): ProjectImportSource {
	const declared = new Map<string, number>();
	for (const offer of input.offered) {
		assertSafeClosurePath(offer.path);
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

	const closure = gatherProjectClosure(input.project, input.offered);
	assertClosureResolves(closure.unmet);
	if (!closure.paths.includes(PROJECT_FILE_NAME)) {
		throw new ImportSourceRefusedError(
			'no-project-file',
			`This source holds no ${PROJECT_FILE_NAME} for the Project it names.`
		);
	}

	const paths = closure.paths;
	const totalBytes = paths.reduce((sum, path) => sum + (declared.get(path) ?? 0), 0);
	return {
		origin: input.origin,
		project: input.project,
		projectFileBytes: input.projectFileBytes,
		paths,
		totalBytes,
		files: () => deliver(input.files(paths), paths)
	};
}

/**
 * Refuse the first reference the Project holds that its source does not.
 *
 * ⚠ **Refused rather than reported, which is the opposite of what a Review does with the same
 * finding.** `reviewFromRemote` carries an unmet reference out on `unmet` and names it in the notice,
 * because a reviewer looking at somebody's shared mistake is better served by the Annotations that
 * *did* arrive. An Import puts the Project in the user's own Workspace, where a Layer drawing nothing
 * is indistinguishable from one they have not aligned yet and will outlive every memory of where it
 * came from. So a dangling reference is a refusal, and it is made before a destination path has been
 * allocated.
 */
function assertClosureResolves(unmet: readonly UnmetClosureReference[]): void {
	const first = unmet[0];
	if (first === undefined) return;
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

/**
 * Pass the source's files through, refusing a source that stops short of what it declared.
 *
 * A closure is validated from a *listing* — a tar's headers, a GitHub tree, a Workspace's `list` —
 * and the bytes are fetched afterwards. Between the two, a file can go: a tree can name a blob the
 * raw host answers 404 for, and a Workspace's file can be deleted while the dialog is open. A
 * consumer with no way to tell would install a Project whose Alignment silently never arrived, which
 * under ADR-0023's one Alignment per Map Image is the loss nobody can reconstruct.
 */
async function* deliver(
	source: AsyncIterable<ClosureFile>,
	paths: readonly ClosurePath[]
): AsyncIterable<ClosureFile> {
	const outstanding = new Set(paths);
	for await (const file of source) {
		if (!outstanding.delete(file.path)) continue;
		yield file;
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

/**
 * Refuse a path that would not stay inside the Project.
 *
 * `assertSafeBundlePath` is the rule, reused rather than restated: it is the same question about the
 * same kind of untrusted path — a traversal, a drive letter, a control character, the store's
 * reserved temporary suffix — and two spellings of it is how a bundle and a Remote's tree come to
 * disagree about what is safe. Only the refusal it is said as changes.
 */
function assertSafeClosurePath(path: string): void {
	try {
		assertSafeBundlePath(path);
	} catch (cause) {
		if (!(cause instanceof BundleRejectedError)) throw cause;
		throw new ImportSourceRefusedError(
			'unsafe-path',
			`This source holds an entry that would not stay inside the Project: “${path}”.`
		);
	}
}
