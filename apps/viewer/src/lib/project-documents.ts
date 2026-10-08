// Referenced documents by path: static hosts have no listing. info.json probed before remote.json (ADR-0023); local copy hits the renderer's own cache entry.
// Loading Layers are withheld from the map: service:'' on a not-yet-read Layer draws blank reported drawn.

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

/** Per-Layer documents: drawable, not yet read, or a reason. Absent means not asked for. */
type LayerDocuments =
	| { readonly status: 'loading' }
	| {
			readonly status: 'ready';
			readonly alignment?: Alignment;
			/** Annotations, null for a Layer with no file. */
			readonly annotations?: AnnotationCollection | null;
			/** Referenced Layer's remote service, '' for a local copy. Unreachable here: that read fails instead. */
			readonly service?: string;
			/** Tiles on another server, observed from files not claimed by project.json. */
			readonly referenced?: boolean;
	  }
	| {
			readonly status: 'unreadable';
			readonly reason: string;
			readonly hostUnreachable: boolean;
			/** Tiles on another server, when that much was observable. Absent when the image placed nowhere. */
			readonly referenced?: boolean;
			/** Parsed Alignment kept so framing still counts the sheet's place on earth. */
			readonly alignment?: Alignment;
	  };

/** Every Layer's documents, by id. One Layer's failure stays its own; this never rejects. Foreign skipped. */
export type ReadDocuments = Readonly<Record<string, LayerDocuments>>;

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

/** Framing input: every Layer with its place on earth, hidden ones included. Parsed Alignments count even when the Layer is unreadable. */
export function toContentLayers(
	layers: readonly Layer[],
	documents: ReadDocuments
): ContentLayer[] {
	return layers.map((layer): ContentLayer => {
		const read = documents[layer.id];
		if (read === undefined || read.status === 'loading') return { layer };
		if (read.status === 'unreadable') return { layer, alignment: read.alignment ?? null };
		return { layer, alignment: read.alignment ?? null, annotations: read.annotations ?? null };
	});
}

async function readMapLayer(store: ReadOnlyProjectStore, layer: MapLayer): Promise<LayerDocuments> {
	const { imageId } = layer;
	const named = `“${layer.name || layer.id}”`;
	if (imageId === '') {
		return {
			status: 'unreadable',
			reason: `${named} does not name a Map Image this site can find.`,
			hostUnreachable: false
		};
	}

	// Placement kept even when the rest fails: a place is not tiles.
	const placed = await readPlacement(store, imageId);
	const placement = 'alignment' in placed ? { alignment: placed.alignment } : {};

	// Referenced-ness reported ahead of the Alignment: the two are independent.
	// Local tiles need no address; the shim resolves the unset.invalid placeholder against them.
	const observed = { infoJson: false, remoteJson: false };
	let service = '';
	try {
		await store.read(imageInfoPath(imageId));
		observed.infoJson = true;
	} catch (cause) {
		// Unanswered host is not a held-elsewhere map; don't ask it a second question.
		if (!(cause instanceof PathNotFoundError)) {
			return {
				...unreadable(cause, `${named} is aligned, but this site did not answer for its image`),
				...placement
			};
		}
		try {
			const record = parseReferencedImage(await store.read(referencedImagePath(imageId)), {
				imageId
			});
			observed.remoteJson = true;
			service = record.service;
		} catch (second) {
			// Never service:'': blank warped Layer reported drawn.
			return {
				...unreadable(
					second,
					`${named} has neither its own tiles on this site nor a readable record of the server ` +
						`that holds them`
				),
				...placement
			};
		}
	}

	// Both false unreachable (failure returns above): referenced or in-workspace, never null.
	const referenced = tileLocation(observed) === 'referenced';

	if (!('alignment' in placed)) {
		return {
			...unreadable(
				placed.cause,
				`${named} is aligned, but this site does not carry the Alignment that places it`
			),
			referenced
		};
	}
	return { status: 'ready', alignment: placed.alignment, service, referenced };
}

/** Alignment by Layer imageId; resource.id never consulted, so a renamed copy claims nothing. */
async function readPlacement(
	store: ReadOnlyProjectStore,
	imageId: string
): Promise<{ alignment: Alignment } | { cause: unknown }> {
	try {
		return { alignment: parseAlignment(await store.read(alignmentPath(imageId)), { imageId }) };
	} catch (cause) {
		return { cause };
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
		// No file is an ordinary empty Layer; an unparsable file is said.
		if (cause instanceof PathNotFoundError) return { status: 'ready', annotations: null };
		return unreadable(cause, `The Annotations in “${layer.name || layer.id}” could not be read`);
	}
}

/** Failed read as a Reader sentence; names the host when the host failed, rest of site unaffected. */
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
