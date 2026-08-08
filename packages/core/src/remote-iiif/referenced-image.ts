// Where one Historical Map's tiles come from — and the one function that answers it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE DISTINCTION, AND WHY IT IS A UNION RATHER THAN A NULLABLE FIELD
//
// A Workspace Historical Map is a local copy or it is `'referenced'`. Those two are not variations on
// a theme; they are different answers to "what URL do this image's tiles have", and getting them the
// wrong way round is silent:
//
//   * A **local copy** has no URL at all. Its `info.json` carries the deliberately unusable
//     `https://unset.invalid/<image-id>` placeholder, and its tiles are reached through the
//     ADR-0011 injection layer, whose routing key *is* that placeholder. A global guard refuses
//     any request that escapes to the network with it (ADR-0004), naming the missing override.
//   * A **referenced** remote image has a real, absolute URL that a stranger operates, and it
//     must **not** go through that shim — `createStoreImageFetch` passes it straight to the
//     network unmodified, which is the half of that function that is easy to get wrong.
//
// So the model says which, `tileBaseFor` turns that into ticket 03's {@link ImagePaneTileBase},
// and ticket 03's own guard is where the mistake becomes an exception rather than a blank pane:
// pass a local image's placeholder as a *string* base and `createImagePane` throws, because a
// string means "served over HTTP from here" and `{ storedImageId }` means "in the Project, reach
// it through the shim". Forgetting and choosing cannot look alike, because they are different
// types.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHERE A REFERENCED IMAGE'S ADDRESS LIVES, AND WHY NOT IN `project.json`
//
// Beside the image, in `images/<image-id>/remote.json` at the Workspace root, exactly where a locally
// ingested image keeps its `info.json` and `manifest.json`. Three reasons, in order of how much they
// matter:
//
//   1. **It makes an offline copy a re-tiling job and not a migration.** Making an offline copy writes a pyramid
//      into that same directory; the record of where the image came from stays, which is the canonical
//      citation ADR-0007 is protecting.
//   2. **`project.json` has one writer** (`EditorSession`), and adding a second kind of thing to
//      it is how that rule gets bent. A referenced image's address is not display state.
//   3. **It is what makes "referenced or local copy?" observable rather than stored** (ADR-0023).
//      An image directory with an `info.json` of ours has its tiles here; one with only a
//      `remote.json` has them on a Library's server. There is no flag to disagree with the bytes.
//
// This is not a contradiction of ADR-0004. That ADR is about *our own* tiles, whose address
// depends on where the Workspace is later published and therefore cannot be baked in. A remote
// service's URI is not our address; it is the citation, and it is the intent.

import type { Alignment } from '../alignment/alignment.js';
import { toRendererDocument, type AlignmentAddress } from '../alignment/georeference-annotation.js';
import type { ImagePaneTileBase } from '../image-pane/iiif-image-pane.js';
import { imageDirectory, IMAGE_DIRECTORY } from '../project/image-files.js';
import type { Bytes, StorePath } from '../store/project-store.js';
import { serialiseJson } from '../tiler/pyramid.js';
import { canonicalServiceUri } from './service-uri.js';

/**
 * One Historical Map of the Workspace, said in terms of where its bytes are.
 *
 * A discriminated union, so the two cases carry different fields: only a referenced image has a
 * `service`, and there is no way to hold a referenced image without one. That is the point —
 * "referenced, address unknown" is a Layer that draws nothing, and it is unrepresentable here.
 *
 * **In memory only.** ADR-0023 deleted the stored `imageMode`: which case a Historical Map is in is
 * read off the files beside it — see `tileLocation` in `project/historical-maps.ts` — so this type
 * describes an observation rather than a claim a `project.json` could get wrong.
 */
export type HistoricalMapSource =
	| { readonly imageMode: 'offline-copy'; readonly imageId: string }
	| {
			readonly imageMode: 'referenced';
			readonly imageId: string;
			/** The canonical remote image service URI. No trailing slash, no `/info.json`. */
			readonly service: string;
	  };

/**
 * Where this Historical Map's tiles are served from, in the form ticket 03's reader takes.
 *
 * **The whole distinction, in one expression**, so that the rule lives in one place rather than one
 * per pane — and the `ImagePaneTileBase` union means the answer cannot be mistaken for the other
 * kind downstream.
 *
 * **Not yet every consumer, and the exception is worth knowing.** `HistoricalMapPane.svelte` builds
 * `{ storedImageId }` for itself, so the pane the Alignment workspace draws a Historical Map in always
 * reaches into the Workspace's own pyramids — correct for a local copy, and for a referenced image the
 * pane asks the injection layer for a pyramid that is not there. Routing it through here is what would
 * make aligning a referenced Historical Map work; that is ticket 07's, not claimed here.
 */
export function tileBaseFor(source: HistoricalMapSource): ImagePaneTileBase {
	return source.imageMode === 'referenced' ? source.service : { storedImageId: source.imageId };
}

/**
 * Whether this Historical Map's tiles are on somebody else's server.
 *
 * No production caller: every place that asks reads `imageMode` directly, or asks
 * `tileLocation` what is on disk, which is the better question. Kept only because it
 * is part of the package's published surface; a follow-up that drops it from `index.ts` should drop
 * it from here in the same change.
 */
export const isReferenced = (source: HistoricalMapSource): boolean =>
	source.imageMode === 'referenced';

/** The file name of the record beside a referenced image. */
export const REFERENCED_IMAGE_FILE = 'remote.json';

/**
 * The record's path in the Workspace. A store path, complete (ADR-0023).
 *
 * Its **presence beside a missing `info.json`** is what makes "these tiles are on a Library's server"
 * observable rather than stored, which is why `MapLayer` needs no `imageMode`.
 */
export const referencedImagePath = (imageId: string): StorePath =>
	`${imageDirectory(imageId)}/${REFERENCED_IMAGE_FILE}`;

/**
 * What the Workspace records about a Historical Map it references rather than holds.
 *
 * Everything here except `service` is provenance a scholar needs and cannot recover once the
 * remote resource is out of reach: which Manifest it was in, what the library called it, and what
 * the library said about rights. ADR-0007 asks for `rights` and `requiredStatement` at the moment
 * the user chooses to make an offline copy, and that moment is ticket 15's — long after the
 * Manifest has been navigated away from. So they are written now.
 */
export type ReferencedImage = {
	readonly imageId: string;
	/** The canonical remote image service URI. */
	readonly service: string;
	/** What the library calls this image, for the Layer's starting name. `''` when unlabelled. */
	readonly label: string;
	/** The Manifest or Collection the user browsed to reach it, if any. */
	readonly partOf: string;
	/** The Canvas selected, if the resource was a Manifest. */
	readonly canvas: string;
	/** The Manifest's `rights` URI, verbatim. `''` when it stated none. */
	readonly rights: string;
	/** The Manifest's `requiredStatement`, flattened to text. `''` when it stated none. */
	readonly attribution: string;
	readonly width: number;
	readonly height: number;
};

/** Everything a caller must say to record a referenced image. `id`s are never invented here. */
export type ReferencedImageFields = Omit<
	ReferencedImage,
	'label' | 'partOf' | 'canvas' | 'rights' | 'attribution'
> &
	Partial<Pick<ReferencedImage, 'label' | 'partOf' | 'canvas' | 'rights' | 'attribution'>>;

export const referencedImage = (fields: ReferencedImageFields): ReferencedImage => ({
	imageId: fields.imageId,
	service: canonicalServiceUri(fields.service),
	label: fields.label ?? '',
	partOf: fields.partOf ?? '',
	canvas: fields.canvas ?? '',
	rights: fields.rights ?? '',
	attribution: fields.attribution ?? '',
	width: fields.width,
	height: fields.height
});

/** The record's bytes. Tab indented with a trailing newline, like every other JSON this app writes. */
export const serialiseReferencedImage = (image: ReferencedImage): Bytes =>
	serialiseJson({
		service: image.service,
		label: image.label,
		partOf: image.partOf,
		canvas: image.canvas,
		rights: image.rights,
		attribution: image.attribution,
		width: image.width,
		height: image.height
	});

/**
 * The record could not be read, so the Layer that needs it cannot be drawn.
 *
 * Refused rather than defaulted. A referenced image whose service URI is missing or is not an
 * absolute `https:` URL has no tiles anywhere, and the two ways of being wrong about that are
 * both worse than saying so: an empty base makes `@allmaps/iiif-parser` build relative tile URLs
 * against *this* app's origin, which quietly requests tiles from ourselves; and falling back to
 * the ADR-0004 placeholder would send them into the injection layer, which would look for a
 * pyramid that by definition is not there.
 */
export class ReferencedImageUnreadableError extends Error {
	constructor(imageId: string, reason: string) {
		super(
			`The record of where “${imageId}” is served from could not be read: ${reason}. This ` +
				`Historical Map is referenced rather than copied into this Project, so without it there ` +
				`is nowhere to fetch its tiles from.`
		);
		this.name = 'ReferencedImageUnreadableError';
	}
}

/**
 * Read a `remote.json`. `imageId` comes from the caller — the path is the identity, the same
 * discipline `parseAlignment` follows and for the same reason.
 *
 * Tolerant about provenance and strict about the address. Losing the label or the rights
 * statement costs a field; getting the service URI wrong costs the map, silently, so it is the
 * one thing that refuses.
 */
export function parseReferencedImage(
	bytes: Uint8Array,
	options: { imageId: string }
): ReferencedImage {
	const { imageId } = options;

	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch (cause) {
		throw new ReferencedImageUnreadableError(imageId, message(cause));
	}

	const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
	const service = typeof record['service'] === 'string' ? record['service'].trim() : '';

	let parsed: URL;
	try {
		parsed = new URL(service);
	} catch {
		throw new ReferencedImageUnreadableError(
			imageId,
			service === '' ? 'it names no image service' : `“${service}” is not an absolute web address`
		);
	}

	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new ReferencedImageUnreadableError(
			imageId,
			`its image service is ${parsed.protocol.replace(':', '')}:, and only http and https can be fetched`
		);
	}

	return referencedImage({
		imageId,
		service,
		label: text(record['label']),
		partOf: text(record['partOf']),
		canvas: text(record['canvas']),
		rights: text(record['rights']),
		attribution: text(record['attribution']),
		width: positiveInteger(record['width']),
		height: positiveInteger(record['height'])
	});
}

/**
 * Every referenced Historical Map **in the Workspace**, read from the records beside them (ADR-0023).
 *
 * The companion of `listIngestedImages`, which looks for `info.json` under the same `images/` root.
 * A referenced image has no `info.json` of ours — its tiles and its description are both on somebody
 * else's server — so the two lists start out disjoint and together they are the Workspace's Historical
 * Maps.
 *
 * **They stop being disjoint the moment an offline copy is made, and that is making an offline copy working rather
 * than a defect.** A copy writes a pyramid into the same directory and deliberately leaves this record
 * where it is: the record is the citation ADR-0007 exists to protect, and a copy that deleted it would
 * have orphaned the one thing that says where the map came from. An image in *both* lists is one that
 * has been copied, which is what `partitionByOfflineCopy` exists to say. This function answers
 * "what does the Workspace record about where its images came from" and nothing about where their bytes
 * are now.
 *
 * A record that will not parse is **skipped rather than fatal**, and its id is returned separately:
 * one unreadable `remote.json` must not stop the Workspace listing, but it must not vanish either —
 * the caller has a Layer that names an image nothing can draw and has to be able to say so.
 */
export async function listReferencedImages(store: {
	list(prefix: string): Promise<readonly string[]> | readonly string[];
	read(path: string): Promise<Uint8Array>;
}): Promise<{ images: ReferencedImage[]; unreadable: { imageId: string; reason: string }[] }> {
	const prefix = `${IMAGE_DIRECTORY}/`;
	const paths = await store.list(prefix);
	const images: ReferencedImage[] = [];
	const unreadable: { imageId: string; reason: string }[] = [];

	for (const path of paths) {
		if (!path.endsWith(`/${REFERENCED_IMAGE_FILE}`)) continue;
		const imageId = path.slice(prefix.length, -`/${REFERENCED_IMAGE_FILE}`.length);
		// A nested `images/<id>/…/remote.json` is not a Historical Map; only the top level is.
		if (imageId === '' || imageId.includes('/')) continue;
		try {
			images.push(parseReferencedImage(await store.read(path), { imageId }));
		} catch (cause) {
			unreadable.push({ imageId, reason: message(cause) });
		}
	}

	return { images, unreadable };
}

/** The source this record describes, for {@link tileBaseFor}. */
export const sourceOf = (image: ReferencedImage): HistoricalMapSource => ({
	imageMode: 'referenced',
	imageId: image.imageId,
	service: image.service
});

// `partitionByOfflineCopy` used to be here, and is now `project/historical-maps.ts`'s — beside
// `tileLocation`, which is the single implementation of "referenced or local copy?" it and
// `referencedHistoricalMaps` now share. It was one of five readings of that rule; see that module's
// header for the other four and for why the split had to be a module rather than a comment.

/**
 * The document a renderer takes for a referenced Historical Map: the Alignment, addressed at the
 * remote service rather than at the ADR-0004 placeholder.
 *
 * That substitution is exactly ADR-0004's own rule applied to the other case — the address is
 * resolved at load time from wherever the tiles are really served — and the address comes from
 * `remote.json`. Without it `@allmaps/maplibre` fetches tiles from the placeholder, which asks the
 * injection layer for a pyramid the Project does not contain: a blank warped Layer, the same silent
 * failure ticket 06 spent a patch on.
 *
 * **A delegation, and it has to be.** This module names no field of the Georeference Annotation and
 * parses none of it; the address is an argument to the one module that reads and writes the format
 * (CONTEXT.md). What is left here is what this module does own — the canonical spelling of a remote
 * service's address.
 */
export const referencedRendererDocument = (alignment: Alignment, service: string): unknown =>
	toRendererDocument(alignment, { imageService: canonicalServiceUri(service) });

/**
 * Where a referenced image's Alignment says its tiles are served from.
 *
 * This is what makes ADR-0007's interoperability claim true rather than aspirational: Allmaps' own
 * model is a Georeference Annotation pointing at a remote IIIF resource, so for a referenced image —
 * the one case where the resource has a real public URI — the file we write is directly consumable
 * by Allmaps and by anything else implementing the extension (SPEC stories 91, 92). The
 * `unset.invalid` placeholder would produce a standard-shaped document nothing in the world can
 * resolve.
 *
 * **An address rather than a serialiser, and that is ticket 18.** This used to be
 * `serialiseReferencedAlignment`, which produced the bytes; but `alignment-file.ts` is now the one
 * writer of `alignments/<image-id>.json` and it takes an `AlignmentAddress`, so a function that
 * returned bytes could only be called by something that then had to write them itself. Handing the
 * writer a value keeps the Resource Mask's plain-decimal fix, the absent timestamps, the write-path
 * validation and the byte-for-byte formatting all coming from the one writer that owns them.
 *
 * `canonicalServiceUri` is applied here, once, so that "which spelling of the service URI goes in
 * the file" has one answer rather than one per call site.
 */
export const referencedAlignmentAddress = (service: string): AlignmentAddress => ({
	imageService: canonicalServiceUri(service)
});

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const positiveInteger = (value: unknown): number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;

const message = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);
