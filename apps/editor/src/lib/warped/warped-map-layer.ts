// Warped rendering's half of the injection layer (ADR-0011).
//
// `@allmaps/maplibre` renders a Historical Map onto the Base Map from a IIIF Georeference
// Annotation, and it reaches the image's tiles by building URLs from the `id` in `info.json` —
// which for a locally ingested pyramid is the `https://unset.invalid/<image-id>` placeholder
// (ADR-0004). There is no seam inside `WarpedMapLayer` at which `Image#uri` could be overridden,
// and that is precisely why the placeholder is the routing key rather than something we assign:
// the layer's documented `fetchFn` option is handed the same `ProjectStore` shim the image pane's
// MapLibre source gets, and the placeholder resolves out of the store.
//
// This module is the editor's boundary for the file format's vocabulary. `addGeoreferencedMap` is
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
import {
	COMPUTED_DISTORTION_MEASURES,
	DEFAULT_DISTORTION_VIEW,
	MINIMUM_CONTROL_POINTS,
	toRendererDocument,
	type Alignment,
	type DistortionView,
	type FetchFn
} from '@ballastella/core';

import { distortionRamp } from './distortion-ramp';

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
 * Two of these carry real weight and the rest are display.
 *
 * **`transformationType` is not redundant with the document, and omitting it silently downgrades
 * the warp.** `WarpedMap` reads `georeferencedMap.transformation?.type` and ignores the order
 * beside it, so `{ type: 'polynomial', options: { order: 3 } }` — the only shape the format has for
 * a third-order polynomial — reaches the solver as plain `polynomial`, which is first order. Map
 * options win over what the layer read from the document (`mergeOptionsUnlessUndefined(defaults,
 * georeferencedMapOptions, listOptions, mapOptions)`), so passing the canonical name here is what
 * makes Higher-order (2nd) and (3rd) actually second and third order. Without it the picker would
 * offer two options that changed the file and not the map.
 *
 * **`distortionMeasures` is what is COMPUTED and `distortionMeasure` is what is DISPLAYED.**
 * Conflating them is the obvious mistake (ADR-0013) and it fails silently: display a measure that
 * was never computed and the map draws with no colouring at all, which reads as "this Alignment has
 * no distortion". So the computed set is always every measure the interface can display, whatever is
 * being displayed now — including when nothing is.
 */
function mapOptionsFor(alignment: Alignment, distortion: DistortionView) {
	return {
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
 */
export function showAlignment(
	layer: WarpedMapLayer,
	alignment: Alignment,
	/**
	 * How to colourise it. Defaults to nothing colourised, which is the right default for any caller
	 * that has no distortion view of its own — a Layer of the stack, for instance, where the overlay
	 * belongs to the Alignment being edited rather than to every Historical Map on the map.
	 *
	 * Note that the *other* two options this fills in are not display settings and are applied
	 * regardless: `transformationType`, without which a second- or third-order Alignment is silently
	 * drawn as affine, and `distortionMeasures`, without which nothing could be colourised later.
	 */
	distortion: DistortionView = DEFAULT_DISTORTION_VIEW
): WarpedRender {
	const need = MINIMUM_CONTROL_POINTS[alignment.transformationType];
	const have = alignment.controlPoints.length;
	if (have < need) return { status: 'too-few-points', have, need };

	try {
		// Typed `string` upstream, but it **returns** an `Error` for a document it will not take —
		// which is a claim rather than a guarantee, so it is widened and checked rather than trusted.
		// Believing the declared type here would surface a rejected Alignment as a map id, and the
		// symptom would be an empty Base Map with the page reporting success.
		const mapId: unknown = layer.addGeoreferencedMap(
			toRendererDocument(alignment),
			mapOptionsFor(alignment, distortion)
		);
		if (mapId instanceof Error) return { status: 'refused', reason: mapId.message };
		if (typeof mapId !== 'string' || mapId === '') {
			return { status: 'refused', reason: 'the renderer accepted the Alignment but named no map' };
		}
		return { status: 'drawn', mapId };
	} catch (cause) {
		return { status: 'refused', reason: cause instanceof Error ? cause.message : String(cause) };
	}
}

/**
 * Change what the drawn map is colourised with, without rebuilding it.
 *
 * Turning the overlay on must not re-add the map: `addGeoreferencedMap` is keyed on the document's
 * content, so a rebuild discards the tile cache and the user watches their Historical Map disappear
 * and come back for a display toggle. `setMapOptions` reaches the same options in place.
 *
 * Deliberately silent about a map id the layer has forgotten — a theme change calls `setStyle`,
 * which takes our layer off with everything else, so a display update racing that is normal.
 */
export function showDistortion(
	layer: WarpedMapLayer,
	mapId: string,
	alignment: Alignment,
	distortion: DistortionView
): void {
	try {
		layer.setMapOptions(mapId, mapOptionsFor(alignment, distortion));
	} catch {
		// Nothing to report: there is no map to colourise, which is not a failure of colourising.
	}
}
