// Warped rendering's half of the injection layer (ADR-0011).
//
// **In `core` rather than in either app, because both draw the same warped Historical Maps.** The
// editor draws one being aligned and a Project's whole stack; the Published Site draws that same
// stack for a Reader (ticket 17). Two copies of the rules below would be two answers to "what
// document and which options does upstream get?" — and every one of the three upstream defects
// documented here fails *silently*, so the copies would agree right up to the day one of them was
// edited and the other rendered blank. `apps/viewer` therefore imports this rather than reimplementing
// it, which is the same argument ADR-0019 makes for `renderAnnotationPopup` and `toRenderCollection`.
//
// `@allmaps/maplibre` renders a Historical Map onto the Base Map from a IIIF Georeference
// Annotation, and it reaches the image's tiles by building URLs from the `id` in `info.json` —
// which for a locally ingested pyramid is the `https://unset.invalid/<image-id>` placeholder
// (ADR-0004). There is no seam inside `WarpedMapLayer` at which `Image#uri` could be overridden,
// and that is precisely why the placeholder is the routing key rather than something we assign:
// the layer's documented `fetchFn` option is handed the same `ProjectStore` shim the image pane's
// MapLibre source gets, and the placeholder resolves out of the store.
//
// This module is the render layer's boundary for the file format's vocabulary. `addGeoreferencedMap` is
// upstream's method name so the word is unavoidable at this one call, exactly as `Marker` is in the
// overlay layer; it goes no further, and everything above this file passes an `Alignment`
// (CONTEXT.md — "Georeference Annotation" appears only where the format is read and written).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE TILE PATH DEPENDS ON A LOCAL PATCH
//
// **`fetchFn` reaches a stored pyramid's `info.json` on the main thread, but its tiles only reach
// the renderer because of `patches/@allmaps__render@1.0.0-beta.83.patch`.**
//
// `WarpedMapLayer.onAdd` builds a `WebGL2Renderer` whose tile factory is
// `CacheableWorkerImageDataTile`. As shipped, its `fetch()` calls into a Comlink worker and passes
// `this.fetchFn` **unproxied** — the abort callback in the very same argument list *is* wrapped in
// `Comlink.proxy()` — so `postMessage` refuses to clone it and every tile fails with a
// `DataCloneError` that upstream logs and swallows. The symptom was a blank warped map with nothing
// surfaced. The patch runs a supplied `fetchFn` on the main thread, where the closure lives, and
// hands the worker a `blob:` URL, so the JPEG decode stays off the main thread.
//
// Two consequences for anyone reading this later. `scripts/check-allmaps-patch.mjs` runs in `pnpm
// lint` and fails the build if the patch stops applying — that guard is not decoration, because the
// failure it catches is silent. And ticket 19 owns getting the fix upstream and deleting the patch;
// it is not something to attempt from here.
//
// {@link WarpedRender} still carries the outcome up to the page rather than logging it. That is not
// left over from the broken state: an Alignment with two Control Points is a normal thing to render,
// and the page has to be able to say "one more point and the map appears".

import { WarpedMapLayer } from '@allmaps/maplibre';
import { MINIMUM_CONTROL_POINTS, type Alignment } from '../alignment/alignment.js';
import {
	COMPUTED_DISTORTION_MEASURES,
	DEFAULT_DISTORTION_VIEW,
	type DistortionView
} from '../alignment/distortion.js';
import {
	toRendererControlPoints,
	toRendererDocument,
	toRendererResourceMask
} from '../alignment/georeference-annotation.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import { referencedRendererDocument } from '../remote-iiif/referenced-image.js';

import { distortionRamp } from './distortion-ramp.js';

/**
 * A `WarpedMapLayer` that reads its tiles through `fetchTile`.
 *
 * `fetchTile` is not optional, and that is the whole value of this function. The option is a
 * `Partial<…>` field several types deep in `@allmaps/maplibre`'s option chain, so omitting it is
 * silent — the layer falls back to the global `fetch`, every tile URL goes to `unset.invalid`,
 * and the map is blank with nothing to say why. Requiring it here makes the omission a type
 * error instead.
 *
 * @param layerId MapLibre's id for the layer. Named by the caller when a Project's Layer stack puts
 *   more than one of these on a map (ticket 09), because MapLibre keys everything — the drawing
 *   order included — on that id, and two layers minting the same default would collide.
 */
export function createWarpedMapLayer(fetchTile: FetchFn, layerId?: string): WarpedMapLayer {
	return new WarpedMapLayer({ fetchFn: fetchTile, ...(layerId === undefined ? {} : { layerId }) });
}

/** What became of an attempt to draw an Alignment warped. */
export type WarpedRender =
	| {
			readonly status: 'drawn';
			/** The layer's own id for this Alignment, needed to remove it again. */
			readonly mapId: string;
	  }
	| {
			/** Fewer Control Points than the transformation type can be solved with (ADR-0013). */
			readonly status: 'too-few-points';
			readonly have: number;
			readonly need: number;
	  }
	| { readonly status: 'refused'; readonly reason: string };

/**
 * Every option a warped Historical Map is given, beyond the document itself.
 *
 * **The Alignment's own three fields are here, and that is the whole of why editing one does not
 * rebuild the layer.** `gcps`, `resourceMask` and `transformationType` are map options that win over
 * whatever the layer read from the document (`mergeOptionsUnlessUndefined(defaults,
 * georeferencedMapOptions, listOptions, mapOptions)`), and upstream routes each of them to a method
 * that does the work in place: `setGcps` and `setResourceMask` are overridden by
 * `TriangulatedWarpedMap` to re-triangulate, and `setTransformationType` re-solves. So a moved
 * Control Point, a dragged or inserted mask vertex, a reset mask and a changed transformation type
 * all reach the same drawn map through {@link updateAlignment} — see `BaseMapPane.svelte` for what
 * that saves, which is every renderer and every warped tile, on every drag.
 *
 * **`transformationType` is not redundant with the document, and omitting it silently downgrades
 * the warp.** `WarpedMap` reads `georeferencedMap.transformation?.type` and ignores the order
 * beside it, so `{ type: 'polynomial', options: { order: 3 } }` — the only shape the format has for
 * a third-order polynomial — reaches the solver as plain `polynomial`, which is first order. Passing
 * the canonical name here is what makes Higher-order (2nd) and (3rd) actually second and third
 * order. Without it the picker would offer two options that changed the file and not the map.
 *
 * **`distortionMeasures` is what is COMPUTED and `distortionMeasure` is what is DISPLAYED.**
 * Conflating them is the obvious mistake (ADR-0013) and it fails silently: display a measure that
 * was never computed and the map draws with no colouring at all, which reads as "this Alignment has
 * no distortion". So the computed set is always every measure the interface can display, whatever is
 * being displayed now — including when nothing is.
 */
function mapOptionsFor(alignment: Alignment, distortion: DistortionView) {
	return {
		gcps: toRendererControlPoints(alignment),
		resourceMask: toRendererResourceMask(alignment),
		transformationType: alignment.transformationType,
		distortionMeasures: [...COMPUTED_DISTORTION_MEASURES],
		distortionMeasure: distortion.measure ?? undefined,
		renderGrid: distortion.grid,
		...distortionRamp()
	};
}

/**
 * Hand an Alignment to the layer, and say what happened.
 *
 * The outcome is returned rather than thrown or logged because every one of these states is a
 * normal thing for the page to render. An Alignment with two Control Points is not an error — it
 * is a user halfway through their first pairing, who needs to be told that a third point is what
 * makes the map appear.
 *
 * `service` is the **remote** image service URI for a `'referenced'` image (ticket 14), and `''` for
 * a local copy. It has to be here rather than inside the Alignment because `@allmaps/maplibre`
 * builds every tile URL from the document's `resource.id`, and the two cases want different
 * answers: the ADR-0004 placeholder, which the injection layer resolves out of the store, or the
 * library's own address, which goes to the network. Passing `''` for a referenced image is a blank
 * warped Layer — the same silent failure ticket 06 spent a patch on — so the caller derives it from
 * the Layer's `imageMode` rather than deciding per call site.
 */
export function showAlignment(
	layer: WarpedMapLayer,
	alignment: Alignment,
	/**
	 * Named rather than positional. Tickets 08 and 14 each added a third parameter independently — a
	 * distortion view and a remote service address — and collided; a caller that passed one in the
	 * other's position would get a blank warped Layer, which is the failure this file exists to
	 * prevent. A future third concern is a field rather than another collision.
	 */
	{
		distortion = DEFAULT_DISTORTION_VIEW,
		service = ''
	}: {
		/**
		 * How to colourise it. Defaults to nothing colourised, which is the right default for any caller
		 * that has no distortion view of its own — a Layer of the stack, for instance, where the overlay
		 * belongs to the Alignment being edited rather than to every Historical Map on the map.
		 *
		 * Note that the *other* options this fills in are not display settings and are applied
		 * regardless: the Alignment's own `gcps`, `resourceMask` and `transformationType` — without the
		 * last of which a second- or third-order Alignment is silently drawn as affine — and
		 * `distortionMeasures`, without which nothing could be colourised later.
		 */
		distortion?: DistortionView;
		/**
		 * The remote image service URI for a `'referenced'` image (ticket 14), or `''` for a local copy.
		 * It cannot live inside the Alignment — see the note above this function.
		 */
		service?: string;
	} = {}
): WarpedRender {
	const need = MINIMUM_CONTROL_POINTS[alignment.transformationType];
	const have = alignment.controlPoints.length;
	if (have < need) return { status: 'too-few-points', have, need };

	try {
		// Typed `string` upstream, but it **returns** an `Error` for a document it will not take —
		// which is a claim rather than a guarantee, so it is widened and checked rather than trusted.
		// Believing the declared type here would surface a rejected Alignment as a map id, and the
		// symptom would be an empty Base Map with the page reporting success.
		// Ticket 14 chooses the document (placeholder id versus the service's own address); ticket 08
		// chooses the options. Both apply to either document — a referenced image needs
		// `transformationType` just as much as a local copy does, and dropping the options for it was
		// how the two changes first collided.
		const document =
			service === ''
				? toRendererDocument(alignment)
				: referencedRendererDocument(alignment, service);
		const mapId: unknown = layer.addGeoreferencedMap(
			document,
			mapOptionsFor(alignment, distortion)
		);
		if (mapId instanceof Error) return { status: 'refused', reason: mapId.message };
		if (typeof mapId !== 'string' || mapId === '') {
			return { status: 'refused', reason: 'the renderer accepted the Alignment but named no map' };
		}
		reassertDistortionMeasure(layer, mapId, distortion);
		return { status: 'drawn', mapId };
	} catch (cause) {
		return { status: 'refused', reason: cause instanceof Error ? cause.message : String(cause) };
	}
}

/**
 * Say the displayed distortion measure again, because a map built with one is not colourised by it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * A THIRD UPSTREAM DEFECT: `distortionMeasure` PASSED AT CONSTRUCTION IS NEVER APPLIED
 *
 * `WarpedMap.applyOptions` has two branches. Its `stage: 'init'` branch — the one
 * `addGeoreferencedMap` runs — assigns `gcps`, `resourceMask`, `transformationType`, both
 * projections and the visibility fields, and **never assigns `this.distortionMeasure`**
 * (`@allmaps/render/dist/maps/WarpedMap.js`, `applyOptions`). The assignment lives only in
 * `setDistortionMeasure`, which only the `else` branch calls, and only for an option that *changed*.
 *
 * The consequence is silent and total. `TriangulatedWarpedMap.updateTrianglePointsDistortion` reads
 * the **field**, not the option — `if (!this.distortionMeasure || !distortions) return 0` — so every
 * triangle point gets 0, and `WebGL2Renderer` sets `u_distortion` from the same field, so the shader
 * is told there is nothing to colour. Meanwhile `getMapOptions(mapId).distortionMeasure` reports the
 * measure faithfully, the checkbox stays checked, and the `<select>` still names it. Measured against
 * the pinned, patched build:
 *
 *     at init                          option = log2sigma | field = undefined | worst distortion 0
 *     after setMapOptions, same value  field = undefined                     | worst distortion 0
 *     after clearing, then setting     field = log2sigma                     | worst distortion 0.15
 *
 * The middle row is why this cannot be fixed by simply saying it again: `objectDifference` compares
 * the merged options against `this.options`, which already holds the measure, so a same-value
 * `setMapOptions` returns `{}` and `setDistortionMeasure` is never reached. It has to be cleared
 * first, which routes through the `else` branch twice and leaves the field assigned.
 *
 * `BaseMapPane` no longer rebuilds the layer for an Alignment edit, so the construction path is
 * reached far less often — but it is still reached whenever a theme change takes the layer off the
 * map, and whenever an Alignment drops below its minimum Control Point count and comes back. Both
 * are ordinary, and in both the user had the overlay switched on.
 *
 * A no-op when nothing is being displayed, which is the common case and the default.
 */
function reassertDistortionMeasure(
	layer: WarpedMapLayer,
	mapId: string,
	distortion: DistortionView
): void {
	if (distortion.measure === null) return;
	layer.setMapOptions(mapId, { distortionMeasure: undefined });
	layer.setMapOptions(mapId, { distortionMeasure: distortion.measure });
}

/**
 * Change what the drawn map is drawn from, and how it is coloured, without rebuilding it.
 *
 * **This is the whole Alignment, not only the display view.** `gcps`, `resourceMask` and
 * `transformationType` are map options upstream applies in place (see {@link mapOptionsFor}), so a
 * moved Control Point, an outlined mask and a changed transformation type all arrive here rather
 * than through a rebuild. `addGeoreferencedMap` is keyed on the document's content, so re-adding
 * would mint a new map, discard every renderer and refetch every warped tile — once per drag, which
 * is the shape ADR-0017 rule 1 exists to prevent.
 *
 * Deliberately silent about a map id the layer has forgotten — a theme change calls `setStyle`,
 * which takes our layer off with everything else, so an update racing that is normal.
 */
export function updateAlignment(
	layer: WarpedMapLayer,
	mapId: string,
	alignment: Alignment,
	distortion: DistortionView
): void {
	try {
		layer.setMapOptions(mapId, mapOptionsFor(alignment, distortion));
	} catch {
		// Nothing to report: there is no map to update, which is not a failure of updating one.
	}
}
