// The planning half of Project Import: one validated incoming closure turned into a **detached**
// destination closure (ADR-0037).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY EVERY INCOMING MAP IMAGE GETS A FRESH IDENTITY, WITHOUT LOOKING AT IT
//
// A Workspace's Map Images are a shared pool (ADR-0023): `images/<id>/` and `alignments/<id>.json`
// belong to the Workspace, and every Project that names `<id>` draws the same pyramid and the same
// placement on the earth. So an Import that reused an incoming identity would be handing a stranger's
// Alignment authority over a map the user already has — and an Import that *deduplicated*, however
// carefully, would do the same thing on purpose.
//
// Nothing about the incoming image is therefore consulted: not its service URI, not its bytes, not its
// label, not its provenance, not its Alignment. Two Imports of the same Project are two Map Images,
// which is ADR-0015's own rule for two ingests of one file.
//
// ⚠ **Fresh is also what `project-import-transaction.ts`'s protocol is built on.** Provisional bytes
// go straight to their final paths because no byte an Import writes can be a byte the user already
// has; that argument rests on this allocation and on nothing else.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT "REMAPPED" MEANS DOCUMENT BY DOCUMENT
//
// An identity is spelled in five places, and each one is rewritten through the module that owns that
// document rather than by reaching into JSON:
//
//   * `project.json`'s map Layers — `parseProjectFile` / `serialiseProjectFile`, so a Project or
//     Layer field a later build added survives (ADR-0010).
//   * the pyramid's path, `images/<id>/…` — a path join, and the only thing here that is one.
//   * the pyramid's `info.json` `id` — reset to the ADR-0004 placeholder for the fresh identity, the
//     same one-field rewrite `stampCanonicalUrl` makes on the same document and for the mirror
//     reason. An imported pyramid must claim neither the source's Published Site nor the source's
//     local identity, or the ADR-0011 injection layer looks for tiles under a name nothing wrote.
//   * the Alignment's path and its `resource.id` — `parseAlignment` with the **source** path's
//     identity, then `serialiseAlignment` with the fresh one, so the Control Points, the Resource
//     Mask, the transformation type and every unmodelled member come back through the one module
//     that owns the format (CONTEXT.md).
//   * a referenced Map Image's `remote.json` — `parseReferencedImage` / `serialiseReferencedImage`.
//     The record holds no identity of its own (the path is the identity), so what this pass is really
//     for is the other direction: the canonical Library service, the rights, the attribution, the
//     Manifest and the Canvas are the citation ADR-0007 exists to protect and must arrive intact.
//
// `manifest.json` beside a pyramid is carried verbatim at its new path. Its `unset.invalid` ids are
// inert — nothing resolves them, `readImageLabel` reads only the label — and publishing's own stamp
// leaves them alone for the same reason.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE ALIGNMENTS ARE HELD BACK TO THE END OF THE STREAM
//
// A source hands its files over in whatever order it is cheapest in (a tar's is the order its author
// packed it), and an Alignment's address depends on a *different* file: for a Map Image the source
// only references, `resource.id` has to be the Library service its `images/<id>/remote.json` records.
// So each Alignment is buffered until the stream ends and then emitted. That is one small JSON
// document per Map Image — Control Points and a mask — rather than the pyramid, so peak memory is
// still one tile plus the closure's Alignments.

import { generateRandomId } from '@allmaps/id';

import type { Alignment } from '../alignment/alignment.js';
import { alignmentPath } from '../alignment/alignment.js';
import {
	parseAlignment,
	serialiseAlignment,
	type AlignmentAddress
} from '../alignment/georeference-annotation.js';
import { IMAGE_DIRECTORY } from '../project/image-files.js';
import { tileLocation } from '../project/map-images.js';
import type { Layer } from '../project/layer.js';
import {
	PROJECT_FILE_NAME,
	serialiseProjectFile,
	type ProjectFile
} from '../project/project-file.js';
import { hoistedImageId } from '../project/workspace.js';
import {
	REFERENCED_IMAGE_FILE,
	parseReferencedImage,
	referencedAlignmentAddress,
	serialiseReferencedImage
} from '../remote-iiif/referenced-image.js';
import { imageServiceId, serialiseJson } from '../tiler/pyramid.js';
import type { Bytes } from '../store/project-store.js';
import {
	gatherProjectClosure,
	type ClosureFile,
	type ClosurePath,
	type ProjectImportSource
} from './project-import-source.js';

/** Mints one destination Map Image identity. Nothing about the incoming image is passed to it. */
export type MintImageId = () => string | Promise<string>;

export interface RemapProjectImportOptions {
	/**
	 * Where a fresh Map Image identity comes from. `@allmaps/id`'s `generateRandomId` by default,
	 * which is what an ingest with no URI to derive an identity from already uses.
	 *
	 * Injected so a test's identities are the ones its expectations name, and for no other reason:
	 * production has one answer and a caller choosing a different one would be choosing the
	 * destination identity, which is the decision this module exists to take away from everybody.
	 */
	readonly imageId?: MintImageId;
}

/** One incoming closure, replanned onto identities the destination Workspace has never used. */
export interface RemappedProjectImport {
	/**
	 * Each distinct source Map Image identity and the fresh one it was given, in the order the
	 * closure's paths name them.
	 *
	 * One-to-one in both directions: a repeated reference resolves to one entry, and no two source
	 * identities share a destination.
	 */
	readonly images: ReadonlyMap<string, string>;
	/**
	 * The closure as it will be written, ready for `commitProjectImport`.
	 *
	 * Still Project-relative, because the destination Project's directory is not this module's to
	 * choose: `project.json` and `annotations/…` are the Project's own files and `images/…` and
	 * `alignments/…` are the Workspace's (ADR-0023), exactly as they are on the way in.
	 */
	readonly closure: ProjectImportSource;
}

/**
 * Replan one validated closure onto fresh Map Image identities.
 *
 * Pure in the sense that matters: no store, no destination, nothing written. The identities are
 * allocated up front — the destination path set has to be known before `commitProjectImport` can
 * plan a transaction over it — and the documents are rewritten as the source hands its files over.
 *
 * @throws Error if the remapped graph does not resolve, which is a defect in this module rather than
 *   anything a user did. Checked because the path set it produces is what the transaction's inventory
 *   and `project-import-recovery.ts`'s sweep are both built from.
 */
export async function remapProjectImport(
	source: ProjectImportSource,
	options: RemapProjectImportOptions = {}
): Promise<RemappedProjectImport> {
	const mint = options.imageId ?? generateRandomId;
	const images = await allocate(source.paths, mint);
	const remapPath = (path: ClosurePath): ClosurePath => remapClosurePath(path, images);

	const project = remapProjectFile(source.project, images);
	const projectFileBytes = serialiseProjectFile(project);
	const paths = source.paths.map(remapPath);
	assertRemappedGraphResolves(project, paths);

	return {
		images,
		closure: {
			origin: source.origin,
			project,
			projectFileBytes,
			paths,
			// The source's own declared bound, carried rather than recomputed. It is what a quota check
			// is for and it is a *bound*: the only files whose length this pass changes are the closure's
			// small documents, and no byte of a pyramid moves.
			totalBytes: source.totalBytes,
			files: () => remapFiles(source, images, projectFileBytes)
		}
	};
}

/**
 * One fresh identity per distinct source Map Image, in the order the closure's sorted paths name
 * them.
 *
 * The pool is the closure's own paths rather than the Project's map Layers, because the paths are what
 * has to be rewritten — and the source has already refused a Layer whose Map Image it does not hold,
 * so the two agree.
 */
async function allocate(
	paths: readonly ClosurePath[],
	mint: MintImageId
): Promise<ReadonlyMap<string, string>> {
	const images = new Map<string, string>();
	const taken = new Set<string>();
	for (const path of paths) {
		const source = hoistedImageId(path);
		if (source === null || images.has(source)) continue;
		const fresh = await mint();
		// Both refusals are defects rather than user errors, and both are silent if they are not
		// caught: an empty identity puts the pyramid at `images//…`, and a repeat merges two of the
		// author's Map Images into one — the hidden sharing this whole module exists to prevent.
		if (fresh === '' || fresh.includes('/')) {
			throw new Error(`“${fresh}” is not usable as a Map Image identity.`);
		}
		if (taken.has(fresh)) {
			throw new Error(
				`“${fresh}” was allocated to two of this Import's Map Images, which would merge them.`
			);
		}
		taken.add(fresh);
		images.set(source, fresh);
	}
	return images;
}

/** A closure path with its Map Image identity replaced. The Project's own files are untouched. */
function remapClosurePath(path: ClosurePath, images: ReadonlyMap<string, string>): ClosurePath {
	const source = hoistedImageId(path);
	if (source === null) return path;
	const fresh = images.get(source);
	if (fresh === undefined) return path;
	if (path === alignmentPath(source)) return alignmentPath(fresh);
	return `${IMAGE_DIRECTORY}/${fresh}/${path.slice(`${IMAGE_DIRECTORY}/${source}/`.length)}`;
}

/**
 * The Project with every map Layer pointing at its fresh Map Image, and nothing else changed.
 *
 * Through the Layer union rather than by name, so a kind added later has to answer here. A
 * {@link Layer} whose `imageId` is `''` keeps it: there is no Map Image it could be pointing at, and
 * the source already refused the case where there should have been one.
 *
 * ⚠ **Nothing about publication or the Front Page is cleared here.** `project-import-provenance.ts`
 * owns the publication reset and the provenance entry, in one place, and a second module doing half
 * of it is how a Project comes to be imported off its own front page for reasons nobody recorded.
 */
function remapProjectFile(project: ProjectFile, images: ReadonlyMap<string, string>): ProjectFile {
	return { ...project, layers: project.layers.map((layer) => remapLayer(layer, images)) };
}

function remapLayer(layer: Layer, images: ReadonlyMap<string, string>): Layer {
	if (layer.kind !== 'map' || layer.imageId === '') return layer;
	return { ...layer, imageId: images.get(layer.imageId) ?? layer.imageId };
}

/**
 * The closure's files at their remapped paths, with every identity-bearing document rewritten.
 *
 * `project.json` comes from the bytes computed up front rather than from the stream, so the manifest
 * the source delivers and the manifest this module planned cannot differ.
 */
async function* remapFiles(
	source: ProjectImportSource,
	images: ReadonlyMap<string, string>,
	projectFileBytes: Bytes
): AsyncIterable<ClosureFile> {
	const alignments = new Map<string, Bytes>();
	const services = new Map<string, string>();
	const pyramids = new Set<string>();

	for await (const file of source.files()) {
		const image = hoistedImageId(file.path);
		if (image === null) {
			yield {
				path: file.path,
				bytes: file.path === PROJECT_FILE_NAME ? projectFileBytes : file.bytes
			};
			continue;
		}
		const fresh = images.get(image) as string;
		const path = remapClosurePath(file.path, images);

		if (file.path === alignmentPath(image)) {
			alignments.set(image, file.bytes);
			continue;
		}
		if (file.path === `${IMAGE_DIRECTORY}/${image}/info.json`) {
			pyramids.add(image);
			yield { path, bytes: stampLocalPyramid(file.bytes, fresh) };
			continue;
		}
		if (file.path === `${IMAGE_DIRECTORY}/${image}/${REFERENCED_IMAGE_FILE}`) {
			const record = parseReferencedImage(file.bytes, { imageId: image });
			services.set(image, record.service);
			yield { path, bytes: serialiseReferencedImage({ ...record, imageId: fresh }) };
			continue;
		}
		yield { path, bytes: file.bytes };
	}

	for (const [image, bytes] of alignments) {
		const fresh = images.get(image) as string;
		yield {
			path: alignmentPath(fresh),
			bytes: readdressAlignment(bytes, image, fresh, addressOf(image, pyramids, services))
		};
	}
}

/**
 * Where the remapped Alignment says its Map Image is served from — ADR-0023's rule, asked of the
 * files the closure actually carries.
 *
 * `tileLocation` is that rule and there is one of it, which is what makes an **Offline Copy** —
 * a pyramid *and* a `remote.json` — the local case here rather than an ambiguity: the tiles are in
 * the Workspace, so the Alignment names the placeholder the pyramid's own `info.json` declares, and
 * the `remote.json` stays beside it as the citation.
 */
function addressOf(
	image: string,
	pyramids: ReadonlySet<string>,
	services: ReadonlyMap<string, string>
): AlignmentAddress {
	const location = tileLocation({
		infoJson: pyramids.has(image),
		remoteJson: services.has(image)
	});
	if (location !== 'referenced') return {};
	return referencedAlignmentAddress(services.get(image) as string);
}

/**
 * The Alignment, read under the identity its **source** path gave it and written under its fresh one.
 *
 * `parseAlignment` is told the source identity because the Alignment's identity is its path and the
 * document's own `resource.id` is not consulted for it — so a file read under the destination name it
 * has not been given yet would be read under a lie. The image identity is then set on the *model*,
 * and `serialiseAlignment` writes the whole document from it: `resource.id` is never patched.
 *
 * A document carrying something this build can neither model nor carry refuses here, by name, so
 * that nothing is silently dropped — the Import fails and `commitProjectImport` takes back what it
 * wrote, rather than installing a Project whose Alignment lost a colleague's annotations.
 */
function readdressAlignment(
	bytes: Bytes,
	image: string,
	fresh: string,
	address: AlignmentAddress
): Bytes {
	const alignment: Alignment = parseAlignment(bytes, { imageId: image });
	return serialiseAlignment({ ...alignment, imageId: fresh }, address);
}

/**
 * The pyramid's `info.json` with its service `id` reset to the placeholder for the fresh identity
 * (ADR-0004).
 *
 * One top-level field, and the rest of the document written back exactly as it was parsed — the same
 * rewrite `stampCanonicalUrl` makes on the same field of the same document, so a member a later build
 * added survives the Import as it survives a publish. An `info.json` that is not a JSON object is
 * carried verbatim: there is no `id` in it to reset, and refusing would refuse a pyramid over a file
 * nothing places anything by.
 */
function stampLocalPyramid(bytes: Bytes, fresh: string): Bytes {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		return bytes;
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bytes;
	return serialiseJson({ ...(raw as Record<string, unknown>), id: imageServiceId(fresh) }) as Bytes;
}

/**
 * Prove the remapped graph resolves, before `commitProjectImport` plans a transaction over it.
 *
 * The same validator the source ran, asked of the remapped Project against the remapped paths, which
 * is what makes a half-finished rewrite a failure here rather than an installed Project with a Layer
 * pointing back at the Workspace it came from. `gatherProjectClosure` reads paths and never sizes, so
 * the bytes this pass has not produced yet are not needed to ask it.
 */
function assertRemappedGraphResolves(project: ProjectFile, paths: readonly ClosurePath[]): void {
	const closure = gatherProjectClosure(
		project,
		paths.map((path) => ({ path, bytes: 0 }))
	);
	const unmet = closure.unmet[0];
	if (unmet !== undefined) {
		throw new Error(
			`The remapped Project still needs “${unmet.reference}”, which the Layer “${unmet.layer}” is ` +
				`drawn from, so an identity was not rewritten.`
		);
	}
	const planned = new Set(paths);
	const missing = closure.paths.find((path) => !planned.has(path));
	if (missing !== undefined || closure.paths.length !== planned.size) {
		throw new Error(
			`The remapped closure and the remapped Project do not describe the same files: ` +
				`${missing ?? 'a planned path is not referenced'}.`
		);
	}
}
