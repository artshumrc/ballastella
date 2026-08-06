// "Import existing alignment — 3 found." The Allmaps community lookup (ADR-0015).
//
// This is the authoring-versus-importing split paying out: authoring always happens in this app,
// and importing an Alignment somebody else already made is a separate, cheap path. It is cheap
// because of one fact established in `image-service.ts` — our remote image id *is* the identifier
// Allmaps keys its annotations on — so finding existing work is a single request rather than a
// feature.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// IT IS DISCLOSED, IT IS SWITCHABLE, AND OFF MEANS NO REQUEST
//
// ADR-0015 is explicit, and the reason is not abstract. For a tool whose premise is "your work
// lives in a folder you own", quietly telling a third party which manifests this person is
// looking at is a real contradiction — and for a scholar working on unpublished or embargoed
// material, that list is not nothing.
//
// `fetchAnnotationsFromApi` reaches the network through the page's own `fetch` and takes no
// injection point, so **the only way to guarantee no request is not to call it.** That is why
// {@link findCommunityAlignments} returns before touching `lookup` rather than passing a flag
// down: the guarantee is structural, and `no request is made when the setting is off` is a claim
// a test can prove by watching the network.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// A MEASURED HAZARD IN `fetchAnnotationsFromApi`, WHICH IS WHY MANIFESTS ARE NOT LOOKED UP HERE
//
// Measured against the pinned `@allmaps/stdlib@1.0.0-beta.41` and the live API on 2026-08-06:
// `https://annotations.allmaps.org/?url=…` answers **404** for a resource it has nothing for,
// and `fetchJson` throws on a 404. `fetchAnnotationsForManifest` catches that and falls back to
// **one API request per canvas** — so the ordinary case, a manifest nobody has georeferenced,
// turns one paste into one third-party request per page of the volume. A Collection is worse: it
// fans out over every manifest, each of which fans out over every canvas.
//
// On a privacy-sensitive path that is the opposite of what ADR-0015 asks for, so the lookup here
// is made **for the one image the user actually selected** and never for a Manifest or a
// Collection. That is also the only lookup whose answer is usable: an Alignment applies to one
// image, and the user has already told us which one. Reported upstream — see the ticket.

import { generateId } from '@allmaps/id';
import type { Image } from '@allmaps/iiif-parser';

import type { Alignment } from '../alignment/alignment.js';
import { parseAlignment } from '../alignment/georeference-annotation.js';

/** The third party this asks. Named as a constant so a test can watch for exactly this host. */
export const COMMUNITY_ALIGNMENT_HOST = 'annotations.allmaps.org';

/**
 * The one-line disclosure to show at the point of use (ADR-0015).
 *
 * Held here rather than written into a component, because the sentence and the request are one
 * decision: whoever changes what is asked has to change what the user is told, in the same file.
 */
export const COMMUNITY_ALIGNMENT_DISCLOSURE =
	`Checking ${COMMUNITY_ALIGNMENT_HOST} for existing georeferences of this image. ` +
	`That sends a hash of its address to the Allmaps community service. You can turn this off.`;

/**
 * Most Alignments this will offer from one lookup.
 *
 * The API's answer is an untrusted document like any other. Twenty-five is far more than any real
 * image has — the largest observed is three — and it bounds the work of parsing before a list is
 * built out of it.
 */
export const MAX_COMMUNITY_ALIGNMENTS = 25;

/**
 * `fetchAnnotationsFromApi` from `@allmaps/stdlib`, as a seam.
 *
 * Injected for one reason and it is not tidiness: the real function calls the global `fetch`
 * against a live third-party host, so a test that used it directly would either hit the network
 * or prove nothing. The default is wired at the app's edge.
 */
export type FetchCommunityAnnotations = (parsed: Image) => Promise<unknown[]>;

/** One Alignment somebody else has already made for this image. */
export type CommunityAlignment = {
	/** Stable within one lookup, for keying a list. Its position in what the API returned. */
	readonly index: number;
	/** The Alignment, ready to write. Its `imageId` is *this* Project's id for the image. */
	readonly alignment: Alignment;
};

/**
 * What the lookup found, or why it did not run.
 *
 * `'off'` is a distinct state from "found nothing", and both are distinct from "the service could
 * not be reached". A user who has switched the lookup off should not be told there are no
 * community alignments — that would be a claim made without asking.
 */
export type CommunityAlignmentOffer =
	| { readonly state: 'off' }
	| { readonly state: 'found'; readonly alignments: readonly CommunityAlignment[] }
	| { readonly state: 'unavailable'; readonly detail: string };

export type FindCommunityAlignmentsOptions = {
	/** The setting. `false` means **no request is made** — see the header. */
	readonly enabled: boolean;
	/** The parsed image service the user selected. Never a Manifest or Collection — see the header. */
	readonly image: Image;
	/** This Project's id for the image, which the returned Alignments are keyed to. */
	readonly imageId: string;
	readonly fetchAnnotations: FetchCommunityAnnotations;
	readonly limit?: number;
};

/**
 * Ask Allmaps whether anyone has already aligned this image.
 *
 * Never throws. A lookup is an offer of help, and a third-party service being down must not stop
 * a scholar adding a map — so a failure comes back as `'unavailable'` with the detail, which the
 * UI shows as a note beside the disclosure rather than as an error over the whole flow.
 */
export async function findCommunityAlignments(
	options: FindCommunityAlignmentsOptions
): Promise<CommunityAlignmentOffer> {
	if (!options.enabled) return { state: 'off' };

	let documents: unknown[];
	try {
		documents = await options.fetchAnnotations(options.image);
	} catch (cause) {
		return { state: 'unavailable', detail: message(cause) };
	}

	const limit = options.limit ?? MAX_COMMUNITY_ALIGNMENTS;
	const alignments: CommunityAlignment[] = [];

	for (const document of documents) {
		for (const map of await maps(document)) {
			// The API answers for a whole resource, so a page of annotations may describe images other
			// than the one the user picked. Matched on the identifier rather than on the URI string,
			// because that is the comparison that survives a service redirecting its own canonical id —
			// and it is the same identifier the API keyed the annotation on in the first place.
			if (map.imageId !== options.imageId) continue;
			let alignment: Alignment;
			try {
				alignment = parseAlignment(map.bytes, { imageId: options.imageId });
			} catch {
				// One unreadable annotation among several must not hide the others. A single bad vertex
				// took a whole Alignment down once already (see `georeference-annotation.ts`), and here
				// the document is a stranger's rather than ours.
				continue;
			}
			alignments.push({ index: alignments.length, alignment });
			if (alignments.length >= limit) return { state: 'found', alignments };
		}
	}

	return { state: 'found', alignments };
}

/**
 * Each annotation in one API answer, on its own, paired with the image id it is for.
 *
 * Split apart because the annotation reader takes one document and yields one Alignment
 * (`parseAlignment`) while the API answers with a page that may hold several. Splitting the page
 * and handing each item to that same reader keeps exactly **one** module in this codebase turning
 * a Georeference Annotation into an Alignment, rather than a second, subtly different reader
 * appearing here — which is how a stored Alignment and an imported one come to disagree about the
 * same file.
 */
async function maps(document: unknown): Promise<{ imageId: string; bytes: Uint8Array }[]> {
	const items = pageItems(document);
	const out: { imageId: string; bytes: Uint8Array }[] = [];

	for (const item of items) {
		const resourceId = readResourceId(item);
		if (resourceId === null) continue;
		let bytes: Uint8Array;
		try {
			bytes = new TextEncoder().encode(JSON.stringify(item));
		} catch {
			// A cyclic or otherwise unserialisable item. Skipped, not fatal.
			continue;
		}
		out.push({ imageId: await generateId(resourceId.replace(/\/$/, '')), bytes });
	}

	return out;
}

/**
 * The individual annotations in whatever the API sent: an `AnnotationPage`, a bare `Annotation`,
 * or an array of either.
 *
 * Tolerant on purpose. The shape of this response is a pre-1.0 third party's and is not something
 * this app can pin, so the reader accepts the three shapes it has been observed to take and
 * ignores anything else rather than throwing — a page whose fourth item is a new shape must still
 * yield the first three.
 */
function pageItems(document: unknown): unknown[] {
	if (Array.isArray(document)) return document.flatMap((entry) => pageItems(entry));
	const record = document as { type?: unknown; items?: unknown } | null;
	if (record === null || typeof record !== 'object') return [];
	if (Array.isArray(record.items)) return record.items;
	return [record];
}

/**
 * The image service `id` an annotation names as its target.
 *
 * Reads the Georeference Annotation shape (`target.source.id`) and the bare `GeoreferencedMap`
 * shape (`resource.id`), because the API has been observed to hand back both. `generateAnnotation`
 * is not used to normalise first: it would throw on a document this reader is meant to skip
 * rather than fail over.
 */
function readResourceId(item: unknown): string | null {
	const record = item as {
		target?: { source?: { id?: unknown } | string };
		resource?: { id?: unknown };
	} | null;
	const source = record?.target?.source;
	const candidates = [typeof source === 'string' ? source : source?.id, record?.resource?.id];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate !== '') return candidate;
	}
	return null;
}

const message = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);
