// A one-canvas IIIF Presentation Manifest over a Historical Map **as this site serves it**, so a
// Reader can read the sheet unwarped (SPEC story 85).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT DECIDES WHERE THE TILES COME FROM, AND WHY IT IS NOT THIS MODULE
//
// Measured against `triiiceratops@1.0.0-rc.35` and the OpenSeadragon it bundles, because the answer is
// the opposite of what the code reads like:
//
//   1. `getCanvasTileSources` turns a canvas's image service into the **string**
//      `` `${serviceId}/info.json` `` (`dist/utils/resolveCanvasImage.js`). There is no path on which an
//      inline service *object* is handed to OpenSeadragon.
//   2. OpenSeadragon fetches that URL and then builds every tile URL from
//      `this._id = this['@id'] || this.id || this.identifier` — **the fetched document's own id**, not
//      the URL it was fetched from. (The URL wins only when the document carries no `@context`, which a
//      generated `info.json` always does.)
//
// So a Published Site cannot redirect a pyramid's tiles by describing it differently: whatever
// `images/<image-id>/info.json` says its `id` is, that is where OpenSeadragon goes. For a locally
// ingested pyramid that is the ADR-0004 placeholder `https://unset.invalid/<image-id>`, and every tile
// request fails at DNS — measured: eight `ERR_NAME_NOT_RESOLVED`, and triiiceratops reports "Image load
// aborted" per tile.
//
// {@link servedImageServiceId} is therefore the whole of this module's honesty: it reports where the
// tiles will *really* come from, and the page refuses to open a viewer that could only draw nothing.
// ADR-0004's own remedy is the opt-in canonical stamp (SPEC story 92), which rewrites that `id` to the
// address the Workspace is published at — a stamped Project reads unwarped here, and an unstamped one
// says why it cannot. That limitation is upstream's and is recorded on ticket 17 rather than improvised
// around: the editor's own `UnwarpedView` already asks for the same missing prop (a `TileSource` it can
// pass in), and one upstream change closes both.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS BUILT FROM
//
// The published `info.json`, which is the document that *describes the pyramid*: its pixel dimensions
// and the tile sizes and scale factors it actually holds. Nothing is guessed and nothing is recomputed
// from a tiler — `apps/viewer` must never acquire one (ADR-0019), which is why the coarsest scale factor
// below is read out of the document's own `scaleFactors` rather than derived.
//
// It is not written anywhere and it is not portable data: it exists for the length of one view. The
// editor has a sibling of this for a *remote* image service (`unwarped-manifest.ts` there), built from a
// `remote.json` rather than from an `info.json`, and the two are deliberately separate because they
// answer different questions — "where does the library serve this?" and "where does this site serve
// this?".

/**
 * A published `info.json`: the whole document, plus the two facts this module reads out of it.
 *
 * Read structurally rather than through `@allmaps/iiif-parser`, because value-importing the parser is how
 * the tiler reaches the viewer (ADR-0019).
 *
 * **`document` is the whole record and is carried rather than rebuilt**, because it is what goes into the
 * Manifest's `service` entry — and a service entry describing a level-0 pyramid has to carry `tiles`,
 * `width`, and `height` or nothing can compute a tile URL from it. Measured: an entry of
 * `{ id, type, profile }` alone mounts OpenSeadragon over an empty area and requests **not one tile**,
 * silently. Carrying the document whole also means a field a newer build added survives into the viewer
 * rather than being dropped by this module's idea of what an `info.json` contains.
 */
export type ServedImageInfo = {
	readonly width: number;
	readonly height: number;
	readonly tiles: readonly { readonly width: number; readonly scaleFactors: readonly number[] }[];
	/**
	 * The `id` the document itself declares, verbatim.
	 *
	 * **This is where the tiles will come from, whatever anything else says** — see the note at the top
	 * of this file. Carried so that {@link servedImageServiceId} can answer honestly rather than the page
	 * discovering it as eight DNS failures.
	 */
	readonly declaredId: string;
	/** The document as published. Handed to the Manifest's service entry unchanged. */
	readonly document: Readonly<Record<string, unknown>>;
};

/** The `info.json` could not be read, so this Historical Map cannot be shown as a document. */
export class ServedImageInfoUnreadableError extends Error {
	constructor(reason: string) {
		super(`This Historical Map’s info.json could not be read: ${reason}`);
		this.name = 'ServedImageInfoUnreadableError';
	}
}

/**
 * Parse a published `info.json` down to the four facts a Manifest needs.
 *
 * Strict about exactly those four and indifferent to everything else, which is the same tolerance every
 * other parser in this codebase has: a document written by a newer build must still be readable, and a
 * field this build has never heard of is not a reason to refuse a Reader their scholar's map. What it
 * will not do is invent a dimension — a Manifest with a zero-sized canvas renders an empty viewer, which
 * is the unactionable blank rectangle this whole path exists to avoid.
 */
export function parseServedImageInfo(bytes: Uint8Array): ServedImageInfo {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch (cause) {
		throw new ServedImageInfoUnreadableError(
			cause instanceof Error ? cause.message : String(cause)
		);
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new ServedImageInfoUnreadableError('it does not contain a JSON object');
	}
	const record = raw as Record<string, unknown>;
	const width = positive(record.width);
	const height = positive(record.height);
	if (width === 0 || height === 0) {
		throw new ServedImageInfoUnreadableError('it gives no pixel dimensions for the image');
	}

	const tiles = (Array.isArray(record.tiles) ? record.tiles : []).flatMap((entry) => {
		const tile = entry as Record<string, unknown> | null;
		const tileWidth = positive(tile?.width);
		const scaleFactors = (Array.isArray(tile?.scaleFactors) ? tile.scaleFactors : []).filter(
			(factor): factor is number => positive(factor) > 0
		);
		if (tileWidth === 0 || scaleFactors.length === 0) return [];
		return [{ width: tileWidth, scaleFactors }];
	});
	if (tiles.length === 0) {
		throw new ServedImageInfoUnreadableError('it declares no tiles, so nothing can be fetched');
	}

	return {
		width,
		height,
		tiles,
		declaredId: typeof record.id === 'string' ? record.id : '',
		document: record
	};
}

const positive = (value: unknown): number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;

/**
 * Where a tiling viewer will actually fetch this pyramid's tiles from, or `null` when nowhere.
 *
 * `null` for the ADR-0004 placeholder host, which is what a locally ingested pyramid's `info.json`
 * carries unless the author opted into the canonical stamp (SPEC story 92). It is `null` rather than "the
 * site's own address" because **the site's own address is not an answer OpenSeadragon would accept** —
 * see the note at the top of this file. A page that opened a viewer anyway would show a Reader an empty
 * rectangle and eight DNS failures they have no way to interpret, which is the unactionable outcome this
 * whole path exists to avoid.
 *
 * Matched on the reserved host exactly, or on a subdomain of it — the same rule
 * `isImageServicePlaceholderUrl` uses in `core`, restated here rather than imported because that module
 * is the *injection layer's* and this is a question about a document.
 */
export function servedImageServiceId(info: ServedImageInfo): string | null {
	let url: URL;
	try {
		url = new URL(info.declaredId);
	} catch {
		// A relative or empty id. Not something a tiling viewer can concatenate tile paths onto.
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	const placeholder = 'unset.invalid';
	if (url.hostname === placeholder || url.hostname.endsWith(`.${placeholder}`)) return null;
	return info.declaredId.replace(/\/+$/, '');
}

/**
 * The largest whole-image derivative a level-0 pyramid actually has: the single tile at the coarsest
 * scale factor the document declares.
 *
 * A Presentation body needs a fetchable `id`, and the obvious choice — `/full/max/0/default.jpg` — does
 * not exist here. A level-0 service serves only the regions and sizes its `info.json` declares, and the
 * whole image at full resolution is not one of them; naming a URL that 404s would make the Manifest
 * worse than useless, because a viewer that cannot tile would show a broken image rather than nothing.
 *
 * The same reasoning as `wholeImageDerivative` in core's tiler, deliberately not that function: this one
 * reads the coarsest factor out of the document rather than recomputing the pyramid's geometry, so the
 * viewer does not import the tiler to draw a picture (ADR-0019).
 */
function wholeImage(info: ServedImageInfo): { path: string; width: number; height: number } {
	const factors = info.tiles.flatMap((tile) => [...tile.scaleFactors]);
	const coarsest = Math.max(...factors);
	const width = Math.ceil(info.width / coarsest);
	const height = Math.ceil(info.height / coarsest);
	return {
		path: `0,0,${info.width},${info.height}/${width},${height}/0/default.jpg`,
		width,
		height
	};
}

/**
 * A Presentation 3 Manifest over the image service at `serviceId`.
 *
 * @param serviceId the image service the tiles really come from, from {@link servedImageServiceId} —
 *   the document's own `id`, and never a URL this app composed. Composing one would produce a Manifest
 *   that *looks* right and a viewer that fetches from somewhere else entirely, which is the trap the note
 *   at the top of this file exists to describe.
 * @param label what the Reader sees this Historical Map called. The Layer's name, which is the author's
 *   own words for it (SPEC story 54) — never the image id, which is a random identifier (ADR-0015).
 */
export function servedImageManifest(options: {
	serviceId: string;
	label: string;
	info: ServedImageInfo;
}): unknown {
	const { label, info } = options;
	const serviceId = options.serviceId.replace(/\/+$/, '');
	const canvasId = `${serviceId}/canvas/1`;
	const derivative = wholeImage(info);

	return {
		'@context': 'http://iiif.io/api/presentation/3/context.json',
		id: `${serviceId}/manifest.json`,
		type: 'Manifest',
		// `none` rather than a language tag: the label is the author's own words and claiming a language
		// for it would be a guess. An empty label is left absent rather than blank, so triiiceratops falls
		// back to its own numbering instead of showing an empty heading.
		...(label === '' ? {} : { label: { none: [label] } }),
		items: [
			{
				id: canvasId,
				type: 'Canvas',
				width: info.width,
				height: info.height,
				items: [
					{
						id: `${canvasId}/annotation-page/1`,
						type: 'AnnotationPage',
						items: [
							{
								id: `${canvasId}/annotation/1`,
								type: 'Annotation',
								motivation: 'painting',
								target: canvasId,
								body: {
									id: `${serviceId}/${derivative.path}`,
									type: 'Image',
									format: 'image/jpeg',
									width: derivative.width,
									height: derivative.height,
									// The service entry is what a tiling viewer draws from; the `id` above is the
									// fallback for one that cannot tile.
									//
									// **The whole published `info.json`, with only its `id` replaced.** A level-0
									// service serves exactly the regions and sizes its own document declares, so an
									// entry of `{ id, type, profile }` alone gives a viewer nothing to compute a tile
									// URL from. Measured against triiiceratops 1.0.0-rc.35: OpenSeadragon mounts over
									// an empty area and requests **not one tile**, with nothing logged — the blank
									// rectangle this whole path exists to avoid.
									//
									// Embedding the document also means nothing fetches `<id>/info.json` for itself,
									// which matters: the copy on disk still carries the ADR-0004 `unset.invalid`
									// placeholder, and every tile URL built from *that* goes nowhere. `profile` and
									// `tiles` come from the document rather than being asserted here — claiming level 2
									// for a level-0 pyramid would have OpenSeadragon ask for regions that exist as no
									// file.
									service: [{ ...info.document, id: serviceId }]
								}
							}
						]
					}
				]
			}
		]
	};
}
