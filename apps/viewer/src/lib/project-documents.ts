// Reading one Project's referenced documents over HTTP, and saying plainly what could not be read.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FOLLOWS REFERENCES AND NEVER LISTS ANYTHING
//
// A static host has no directory listing, so ADR-0006's HTTP `ProjectStore` has no `list` — see
// `packages/core/src/store/http-project-store.ts` for why an implementation returning `[]` would be a
// lie in the worst direction. Everything below is therefore reached by a path `project.json` itself
// names, or derived from one: a map Layer's `alignmentRef`, an Annotation Layer's `geojsonRef`, and
// `images/<image-id>/` derived from the Alignment's own path by `imageIdFromAlignmentRef`.
//
// That has a consequence the editor's Layers pane does not have and is better for it: `listReferencedImages`
// walks `images/` and cannot be used here, so a `'referenced'` Layer's `remote.json` is fetched by name
// — which is how the state below can tell "not read yet" from "not there".
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS MODULE EXISTS TO NOT INHERIT
//
// Recorded on ticket 09 and carried into ticket 17's own degradation table: *a `'referenced'` Layer
// whose `remote.json` is missing or unreadable renders blank while the page reports it drawn.* The
// editor cannot tell those apart because `EditorSession` exposes no signal for "the remote records have
// not been read yet", so its Layers pane hands the stack `service: ''`, and `''` on a referenced Layer
// is a warped layer that asks the injection shim for a pyramid a referenced image by definition does not
// have locally: blank, and reported as drawn.
//
// So {@link ReadDocuments} has three states per Layer and not two. `'loading'` is the state that was
// missing: while it holds, the Layer is **not handed to the map at all**, so nothing can be reported
// drawn from an address that has not arrived. `'unreadable'` carries the reason, including the host that
// did not answer, which is what ticket 17's table asks for.

import {
	PathNotFoundError,
	SiteFileUnreachableError,
	imageIdFromAlignmentRef,
	parseAlignment,
	parseAnnotations,
	parseReferencedImage,
	referencedImagePath,
	type Alignment,
	type AnnotationCollection,
	type AnnotationLayer,
	type Layer,
	type MapLayer,
	type ReadOnlyProjectStore
} from '@ballastella/core';

/** What a Layer's own documents amount to: something to draw, nothing yet, or a reason. */
export type LayerDocuments =
	| { readonly status: 'loading' }
	| {
			readonly status: 'ready';
			/** The Alignment a map Layer draws. */
			readonly alignment?: Alignment;
			/** The Annotations an Annotation Layer draws. `null` for a Layer with no file. */
			readonly annotations?: AnnotationCollection | null;
			/**
			 * The remote image service a `'referenced'` map Layer's tiles come from, `''` for a local copy.
			 *
			 * `''` on a `'referenced'` Layer is unreachable by construction here: the read that would produce
			 * it fails, and the Layer is `'unreadable'` instead. That is the ticket 09 defect not inherited.
			 */
			readonly service?: string;
	  }
	| {
			readonly status: 'unreadable';
			readonly reason: string;
			/** True when a host failed to answer rather than a file being absent. */
			readonly hostUnreachable: boolean;
	  };

/** Every Layer's documents, by Layer id. A Layer absent from this has not been asked for. */
export type ReadDocuments = Readonly<Record<string, LayerDocuments>>;

/**
 * Read the documents every drawable Layer of `layers` references.
 *
 * One Layer's failure is that Layer's, never the Project's — ticket 17: "A missing or broken single
 * Layer must never take down the whole Project view." So every read is caught into that Layer's own
 * entry, and this function does not reject.
 *
 * `foreign` Layers are skipped: this build cannot draw a kind it has never heard of, and it has nothing
 * to fetch for one (ADR-0014). The Layer is still listed, named, and toggleable.
 */
export async function readLayerDocuments(
	store: ReadOnlyProjectStore,
	directory: string,
	layers: readonly Layer[]
): Promise<ReadDocuments> {
	const read: Record<string, LayerDocuments> = {};
	await Promise.all(
		layers.map(async (layer) => {
			if (layer.kind === 'foreign') return;
			read[layer.id] =
				layer.kind === 'map'
					? await readMapLayer(store, directory, layer)
					: await readAnnotationLayer(store, directory, layer);
		})
	);
	return read;
}

async function readMapLayer(
	store: ReadOnlyProjectStore,
	directory: string,
	layer: MapLayer
): Promise<LayerDocuments> {
	const imageId = imageIdFromAlignmentRef(layer.alignmentRef);
	if (imageId === null) {
		return {
			status: 'unreadable',
			reason:
				`This Layer’s Historical Map is recorded as “${layer.alignmentRef}”, which does not name ` +
				`an Alignment this site can find.`,
			hostUnreachable: false
		};
	}

	let alignment: Alignment;
	try {
		// The image id comes from the path and never from the document's own `resource.id` — the same
		// discipline the editor reads an Alignment with, so a file copied under another name cannot claim
		// the image it used to describe.
		alignment = parseAlignment(await store.read(`${directory}/${layer.alignmentRef}`), { imageId });
	} catch (cause) {
		return unreadable(
			cause,
			`“${layer.name || layer.id}” is aligned, but this site does not carry the Alignment that ` +
				`places it`
		);
	}

	// A local copy needs no address: its tiles are files of this site, and ADR-0011's shim resolves the
	// `unset.invalid` placeholder in its `info.json` against them.
	if (layer.imageMode !== 'referenced') return { status: 'ready', alignment, service: '' };

	try {
		const record = parseReferencedImage(
			await store.read(`${directory}/${referencedImagePath(imageId)}`),
			{ imageId }
		);
		return { status: 'ready', alignment, service: record.service };
	} catch (cause) {
		// **Not `service: ''`.** See the module comment: `''` here is a blank warped Layer reported as
		// drawn, which is the defect recorded on ticket 09.
		return unreadable(
			cause,
			`“${layer.name || layer.id}” is held on another server rather than in this site, and the ` +
				`record of which server that is could not be read`
		);
	}
}

async function readAnnotationLayer(
	store: ReadOnlyProjectStore,
	directory: string,
	layer: AnnotationLayer
): Promise<LayerDocuments> {
	try {
		const annotations = parseAnnotations(await store.read(`${directory}/${layer.geojsonRef}`));
		return { status: 'ready', annotations };
	} catch (cause) {
		// An Annotation Layer with no file is an ordinary first state — the author made the Layer and has
		// not drawn in it — so it draws nothing rather than complaining. A file that is *there* and will
		// not parse is scholarship a Reader is not being shown, which is said.
		if (cause instanceof PathNotFoundError) return { status: 'ready', annotations: null };
		return unreadable(cause, `The Annotations in “${layer.name || layer.id}” could not be read`);
	}
}

/**
 * One failed read as something a Reader can act on.
 *
 * The host is named when a host is what failed, which is ticket 17's degradation table in one line: "Say
 * so, naming the host; keep the rest of the site working". A Reader on a train and a Reader visiting
 * after a library reorganised both need the name — it is the difference between "the tool is broken" and
 * "that server is down".
 */
function unreadable(cause: unknown, context: string): LayerDocuments {
	if (cause instanceof SiteFileUnreachableError) {
		return {
			status: 'unreadable',
			reason:
				`${context}: ${cause.host === '' ? 'this site' : cause.host} did not answer. The rest of ` +
				`this Project is unaffected.`,
			hostUnreachable: true
		};
	}
	const detail = cause instanceof Error ? cause.message : String(cause);
	return { status: 'unreadable', reason: `${context}. ${detail}`, hostUnreachable: false };
}
