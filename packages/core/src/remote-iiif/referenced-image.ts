// Where one Historical Map's tiles come from — and the one function that answers it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE DISTINCTION, AND WHY IT IS A UNION RATHER THAN A NULLABLE FIELD
//
// A map Layer's image is a local copy or it is `'referenced'` (ticket 09's {@link ImageMode}).
// Those two are not variations on a theme; they are different answers to "what URL do this
// image's tiles have", and getting them the wrong way round is silent:
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
// Beside the image, in `images/<image-id>/remote.json`, exactly where a locally ingested image
// keeps its `info.json` and `manifest.json`. Three reasons, in order of how much they matter:
//
//   1. **It makes ticket 15 a re-tiling job and not a migration.** Mirroring writes a pyramid
//      into that same directory and the Layer's `imageMode` becomes a local copy; the record of
//      where the image came from stays, which is the canonical citation ADR-0007 is protecting.
//   2. **`project.json` has one writer** (`EditorSession`), and adding a second kind of thing to
//      it is how that rule gets bent. A referenced image's address is not display state.
//   3. It keeps ticket 09's Layer type as it is. `assertReferencesPresent` already treats a
//      `'referenced'` image as claiming no local pyramid — which is true, and stays true: this
//      record is not a pyramid.
//
// This is not a contradiction of ADR-0004. That ADR is about *our own* tiles, whose address
// depends on where the Project is later published and therefore cannot be baked in. A remote
// service's URI is not our address; it is the citation, and it is the intent.

import type { Alignment } from '../alignment/alignment.js';
import { serialiseAlignment, toRendererDocument } from '../alignment/georeference-annotation.js';
import type { ImagePaneTileBase } from '../image-pane/iiif-image-pane.js';
import { imageDirectory } from '../project/image-files.js';
import type { ImageMode } from '../project/layer.js';
import type { Bytes, StorePath } from '../store/project-store.js';
import { serialiseJson } from '../tiler/pyramid.js';
import { canonicalServiceUri } from './service-uri.js';

/**
 * One Historical Map of a Project, said in terms of where its bytes are.
 *
 * A discriminated union on ticket 09's `imageMode`, so the two cases carry different fields:
 * only a referenced image has a `service`, and there is no way to hold a referenced image without
 * one. That is the point — "referenced, address unknown" is a Layer that draws nothing, and it is
 * unrepresentable here.
 */
export type HistoricalMapSource =
	| { readonly imageMode: 'mirrored'; readonly imageId: string }
	| {
			readonly imageMode: 'referenced';
			readonly imageId: string;
			/** The canonical remote image service URI. No trailing slash, no `/info.json`. */
			readonly service: string;
	  };

/**
 * The two modes above are spelled as literals rather than as `typeof LOCAL_COPY`, because ticket
 * 09 declares that constant as the wide {@link ImageMode} — and a wide member would stop the union
 * discriminating, which is the entire mechanism here: `source.service` would not narrow.
 *
 * This line is what stops the two files drifting. It is a **compile error the day `ImageMode`
 * gains a third member**, in the one place that has to answer "and where are *that* kind's tiles?"
 * — which is the same question ADR-0014 makes every call site answer about a third Layer kind.
 */
const _everyImageModeHasASource: ImageMode extends HistoricalMapSource['imageMode'] ? true : never =
	true;
void _everyImageModeHasASource;

/**
 * Where this Historical Map's tiles are served from, in the form ticket 03's reader takes.
 *
 * **The whole distinction, in one expression**, so that the rule lives in one place rather than one
 * per pane — and the `ImagePaneTileBase` union means the answer cannot be mistaken for the other
 * kind downstream.
 *
 * **Not yet every consumer, and the exception is worth knowing.** `HistoricalMapPane.svelte` builds
 * `{ storedImageId }` for itself, so the pane the Alignment workspace draws a Historical Map in
 * always reaches into the Project — correct for a local copy, and for a referenced image the pane
 * asks the injection layer for a pyramid that is not there. Routing it through here is what would
 * make aligning a referenced Historical Map work; recorded on ticket 14 rather than claimed here.
 */
export function tileBaseFor(source: HistoricalMapSource): ImagePaneTileBase {
	return source.imageMode === 'referenced' ? source.service : { storedImageId: source.imageId };
}

/**
 * Whether this Historical Map's tiles are on somebody else's server.
 *
 * No production caller: every place that asks reads `imageMode` directly, or asks
 * {@link partitionByLocalCopy} what is on disk, which is the better question. Kept only because it
 * is part of the package's published surface; a follow-up that drops it from `index.ts` should drop
 * it from here in the same change.
 */
export const isReferenced = (source: HistoricalMapSource): boolean =>
	source.imageMode === 'referenced';

/** The file name of the record beside a referenced image. */
export const REFERENCED_IMAGE_FILE = 'remote.json';

/** The record's path within a Project. */
export const referencedImagePath = (imageId: string): StorePath =>
	`${imageDirectory(imageId)}/${REFERENCED_IMAGE_FILE}`;

/** The record's path within the Workspace. */
export const referencedImageStorePath = (projectDirectory: string, imageId: string): StorePath =>
	`${projectDirectory}/${referencedImagePath(imageId)}`;

/**
 * What a Project records about a Historical Map it references rather than holds.
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
 * Every referenced Historical Map in a Project, read from the records beside them.
 *
 * The companion of `listIngestedImages`, which looks for `info.json`. A referenced image has no
 * `info.json` in the Project — its tiles and its description are both on somebody else's server —
 * so before ticket 15 the two lists were disjoint and together they were the Project's Historical
 * Maps. That is also why {@link mapLayerImageInfoPath} returns `null` for a referenced Layer and
 * why ticket 13's import check is right not to look for one.
 *
 * **They are no longer disjoint, and that is mirroring working rather than a defect.** An offline copy
 * writes a pyramid into the same directory and deliberately leaves this record where it is: the record
 * is the citation ADR-0007 exists to protect, and a copy that deleted it would have orphaned the one
 * thing that says where the map came from. An image in *both* lists is one that has been mirrored,
 * which is what {@link partitionByLocalCopy} exists to say. This function answers "what does the
 * Project record about where its images came from" and nothing about where their bytes are now.
 *
 * A record that will not parse is **skipped rather than fatal**, and its id is returned separately:
 * one unreadable `remote.json` must not stop the Project opening, but it must not vanish either —
 * the caller has a Layer that names an image nothing can draw and has to be able to say so.
 */
export async function listReferencedImages(
	store: {
		list(prefix: string): Promise<readonly string[]> | readonly string[];
		read(path: string): Promise<Uint8Array>;
	},
	projectDirectory: string
): Promise<{ images: ReferencedImage[]; unreadable: { imageId: string; reason: string }[] }> {
	const prefix = `${projectDirectory}/images/`;
	const paths = await store.list(prefix);
	const images: ReferencedImage[] = [];
	const unreadable: { imageId: string; reason: string }[] = [];

	for (const path of paths) {
		if (!path.endsWith(`/${REFERENCED_IMAGE_FILE}`)) continue;
		const imageId = path.slice(prefix.length, -`/${REFERENCED_IMAGE_FILE}`.length);
		// A nested `images/<id>/…/remote.json` is not an image of this Project; only the top level is.
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

/**
 * Split a Project's remote-origin records by whether its own pyramid is beside them (ticket 15).
 *
 * **The one place that answers "referenced or local copy?" from what is on disk**, rather than from
 * what a Layer claims. That direction matters: `imageMode` in `project.json` is a claim, and mirroring
 * is the one action that changes the answer — so if the pyramid landed and the document write that
 * followed it did not, this says "mirrored" and the Layer says `'referenced'`, and the disagreement is
 * repaired by the next copy rather than being permanent. The alternative — trusting the Layer — would
 * mean an image whose tiles are right here being fetched from a library on every load.
 *
 * `mirrored` keeps its record for the citation, which is why it is a partition of the records rather
 * than a removal from them: a mirrored Historical Map must still be able to say where it came from
 * (ADR-0007, and the ticket in as many words: "mirroring must not orphan the copy").
 */
export function partitionByLocalCopy(
	images: readonly ReferencedImage[],
	ingested: readonly { readonly imageId: string }[]
): { referenced: ReferencedImage[]; mirrored: ReferencedImage[] } {
	const local = new Set(ingested.map((image) => image.imageId));
	return {
		referenced: images.filter((image) => !local.has(image.imageId)),
		mirrored: images.filter((image) => local.has(image.imageId))
	};
}

/**
 * The source of a Historical Map whose pyramid is in the Project.
 *
 * `'mirrored'` written out rather than `LOCAL_COPY`, for the reason above: the constant's declared
 * type is the whole union, and the narrow member is what makes `tileBaseFor` reach the store rather
 * than the network. The two are held together by `_everyImageModeHasASource`.
 */
export const localCopySource = (imageId: string): HistoricalMapSource => ({
	imageMode: 'mirrored',
	imageId
});

/**
 * The Layer's `imageMode` for this source — ticket 09's field, derived rather than restated.
 *
 * One line, and it exists so that no call site writes the string `'referenced'` next to a
 * `service` it did not check. `layer.imageMode` and `tileBaseFor` then cannot disagree, which is
 * the disagreement that makes a Layer claim a local pyramid it does not have and fail ticket 13's
 * import check.
 */
export const imageModeOf = (source: HistoricalMapSource): ImageMode => source.imageMode;

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
 * An Alignment of a referenced image, as a file naming the **remote** service.
 *
 * This is what makes ADR-0007's interoperability claim true rather than aspirational: Allmaps' own
 * model is a Georeference Annotation pointing at a remote IIIF resource, so for a referenced image —
 * the one case where the resource has a real public URI — the file we write is directly consumable
 * by Allmaps and by anything else implementing the extension (SPEC stories 91, 92). The
 * `unset.invalid` placeholder would produce a standard-shaped document nothing in the world can
 * resolve.
 *
 * A delegation for the same reason as above, so the Resource Mask's plain-decimal fix, the absent
 * timestamps, the write-path validation and the byte-for-byte formatting all still come from the
 * single writer that owns them — and now the address goes *through* that writer rather than being
 * edited into its output afterwards, which is what stops a second reader of the format existing.
 */
export const serialiseReferencedAlignment = (alignment: Alignment, service: string): Bytes =>
	serialiseAlignment(alignment, { imageService: canonicalServiceUri(service) });

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const positiveInteger = (value: unknown): number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;

const message = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);
