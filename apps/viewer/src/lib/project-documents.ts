// Reading one Project's referenced documents over HTTP, and saying plainly what could not be read.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FOLLOWS REFERENCES AND NEVER LISTS ANYTHING
//
// A static host has no directory listing, so ADR-0006's HTTP `ProjectStore` has no `list` — see
// `packages/core/src/store/http-project-store.ts` for why an implementation returning `[]` would be a
// lie in the worst direction. Everything below is therefore reached by a path `project.json` itself
// names, or derived from one: an Annotation Layer's `geojsonRef`, and — from a map Layer's `imageId` —
// `alignments/<image-id>.json` and `images/<image-id>/` at the **site root** (ADR-0023).
//
// That has a consequence the editor's Layers pane does not have and is better for it: `listReferencedImages`
// walks `images/` and cannot be used here, so a referenced map's `remote.json` is fetched by name — which
// is how the state below can tell "not read yet" from "not there".
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS PROBES FOR `info.json` RATHER THAN READING A FLAG
//
// ADR-0023 deleted `MapLayer.imageMode`, because whether a Historical Map's tiles are here is a fact
// about the files and a stored flag could disagree with them — an offline copy used to leave every other
// Project's Layer still claiming the library. So the answer is read the way it is written: an `info.json`
// of ours means the tiles are on this site, and only a `remote.json` means they are on a Library's server.
//
// **The rule itself is core's `tileLocation` and this module does not restate it.** What is local here
// is only the *observation*: the editor answers the same two booleans by walking `images/` once, and a
// static host makes that impossible, so this asks for the two files by name and reads the 404. Two
// observers, one rule — see `packages/core/src/project/historical-maps.ts` for why that seam exists and
// what happened when it did not.
//
// `info.json` is asked for first because a local copy is the common case and that request costs nothing
// extra — `@allmaps/maplibre` fetches the same file from `resource.id` to draw the map, so the probe hits
// the same cache entry. Only a referenced map pays a 404 for the question.
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
	alignmentPath,
	imageInfoPath,
	type ContentLayer,
	parseAlignment,
	parseAnnotations,
	parseReferencedImage,
	referencedImagePath,
	tileLocation,
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
			 * The remote image service a referenced map Layer's tiles come from, `''` for a local copy.
			 *
			 * `''` on a referenced Layer is unreachable by construction here: the read that would produce
			 * it fails, and the Layer is `'unreadable'` instead. That is the ticket 09 defect not inherited.
			 */
			readonly service?: string;
			/**
			 * Whether this map Layer's Historical Map is served from somebody else's server, as observed
			 * from the files on this site rather than claimed by `project.json` (ADR-0023).
			 *
			 * What the page says out loud about needing the network, and what `showAlignment` uses to refuse
			 * a referenced Layer with no address instead of drawing a blank one.
			 */
			readonly referenced?: boolean;
	  }
	| {
			readonly status: 'unreadable';
			readonly reason: string;
			/** True when a host failed to answer rather than a file being absent. */
			readonly hostUnreachable: boolean;
			/**
			 * Whether this map Layer's tiles are on somebody else's server, when that much was observable.
			 *
			 * Present on the failed case too, because the two questions are independent: a Layer whose
			 * Alignment will not parse can still be one whose tiles need the network, and SPEC story 29 is
			 * owed to the Reader either way. Absent when the image itself could not be placed.
			 */
			readonly referenced?: boolean;
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
					? await readMapLayer(store, layer)
					: await readAnnotationLayer(store, directory, layer);
		})
	);
	return read;
}

/**
 * The stack as `projectOpeningBounds` takes it: every Layer with whatever gives it a place on the
 * earth (ADR-0026).
 *
 * **Every Layer, including the ones the Reader has hidden.** ADR-0026's fallback chain ends "…failing
 * that, all Layers", so a Project whose Layers are all switched off still frames on the work rather
 * than on the deployment's default — which is a different question from what is *drawn*, and is why
 * this is not built from `drawn`.
 *
 * A Layer whose documents are still loading or could not be read contributes nothing. It is not an
 * error here: the map is framed on what is known, and the Layer's own row already says what happened.
 */
export function toContentLayers(
	layers: readonly Layer[],
	documents: ReadDocuments
): ContentLayer[] {
	return layers.map((layer): ContentLayer => {
		const read = documents[layer.id];
		if (read?.status !== 'ready') return { layer };
		return { layer, alignment: read.alignment ?? null, annotations: read.annotations ?? null };
	});
}

async function readMapLayer(store: ReadOnlyProjectStore, layer: MapLayer): Promise<LayerDocuments> {
	const { imageId } = layer;
	const named = `“${layer.name || layer.id}”`;
	if (imageId === '') {
		return {
			status: 'unreadable',
			reason: `${named} does not name a Historical Map this site can find.`,
			hostUnreachable: false
		};
	}

	// ── Where the tiles are, asked first ────────────────────────────────────────────────────────
	//
	// **Before the Alignment, so that "this Layer needs the network" survives an Alignment that will
	// not parse.** The two are independent facts and SPEC story 29 is owed to the Reader either way:
	// answering it out of the Alignment's success is how the warning quietly stopped appearing for
	// exactly the Projects most likely to have something wrong with them.
	//
	// A local copy needs no address: its tiles are files of this site, and ADR-0011's shim resolves the
	// `unset.invalid` placeholder in its `info.json` against them. The presence of that file is what says
	// so — see the module comment on why this is a probe and not a flag.
	const observed = { infoJson: false, remoteJson: false };
	let service = '';
	try {
		await store.read(imageInfoPath(imageId));
		observed.infoJson = true;
	} catch (cause) {
		// A host that did not answer is not a map held elsewhere, and asking a second question of a site
		// that is not there would only repeat the same failure under a worse sentence.
		if (!(cause instanceof PathNotFoundError)) {
			return unreadable(cause, `${named} is aligned, but this site did not answer for its image`);
		}
		try {
			const record = parseReferencedImage(await store.read(referencedImagePath(imageId)), {
				imageId
			});
			observed.remoteJson = true;
			service = record.service;
		} catch (second) {
			// **Not `service: ''`.** See the module comment: `''` here is a blank warped Layer reported as
			// drawn, which is the defect recorded on ticket 09.
			return unreadable(
				second,
				`${named} has neither its own tiles on this site nor a readable record of the server that ` +
					`holds them`
			);
		}
	}

	// The two observations, handed to the one rule. Both `false` is unreachable here — the second read
	// failing is a `return` above — so this is `'in-workspace'` or `'referenced'` and never `null`.
	const referenced = tileLocation(observed) === 'referenced';

	// ── And where on the earth it goes ──────────────────────────────────────────────────────────
	try {
		// The image id comes from the Layer and the Alignment's path is derived from it, so the document's
		// own `resource.id` is never consulted — the same discipline the editor reads an Alignment with, so
		// a file copied under another name cannot claim the image it used to describe.
		const alignment = parseAlignment(await store.read(alignmentPath(imageId)), { imageId });
		return { status: 'ready', alignment, service, referenced };
	} catch (cause) {
		return {
			...unreadable(
				cause,
				`${named} is aligned, but this site does not carry the Alignment that places it`
			),
			referenced
		};
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
function unreadable(
	cause: unknown,
	context: string
): Extract<LayerDocuments, { status: 'unreadable' }> {
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
