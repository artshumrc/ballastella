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
// WHAT DOES NOT WORK, AND WHY IT IS WIRED ANYWAY
//
// **`fetchFn` reaches a stored pyramid's `info.json` and cannot reach its tiles.** That is a defect
// in `@allmaps/render@1.0.0-beta.83`, not in this repository, and there is nothing this repository
// can pass that would work around it.
//
// `WarpedMapLayer.onAdd` builds a `WebGL2Renderer` whose tile factory is
// `CacheableWorkerImageDataTile`. Its `fetch()` calls into a Comlink worker and passes `this.fetchFn`
// **unproxied** — the abort callback in the very same argument list *is* wrapped in
// `Comlink.proxy()` — so `postMessage` refuses to clone it. A function cannot cross a
// structured-clone boundary. Verified twice for ticket 07, against the current tree: statically, in
// `dist/tilecache/CacheableWorkerImageDataTile.js`, and in Chromium, where `addGeoreferencedMap`
// succeeds and reports bounds while every tile fails with `DataCloneError` naming our own shim.
// Upstream logs and swallows those errors, so **the symptom is a blank warped map with nothing
// surfaced**.
//
// So this is wired as far as it correctly can be, and no further: the Alignment is handed over, the
// layer accepts it and computes its bounds, and {@link WarpedRender} carries the outcome up to the
// page so that "nothing was drawn" is *said* rather than merely looking like an empty map. When the
// upstream fix lands, the remaining work here is a version bump.

import { WarpedMapLayer } from '@allmaps/maplibre';
import {
	MINIMUM_CONTROL_POINTS,
	toGeoreferencedMap,
	type Alignment,
	type FetchFn
} from '@ballastella/core';

/**
 * A `WarpedMapLayer` that reads its tiles through `fetchTile`.
 *
 * `fetchTile` is not optional, and that is the whole value of this function. The option is a
 * `Partial<…>` field several types deep in `@allmaps/maplibre`'s option chain, so omitting it is
 * silent — the layer falls back to the global `fetch`, every tile URL goes to `unset.invalid`,
 * and the map is blank with nothing to say why. Requiring it here makes the omission a type
 * error instead.
 */
export function createWarpedMapLayer(fetchTile: FetchFn): WarpedMapLayer {
	return new WarpedMapLayer({ fetchFn: fetchTile });
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
 * Hand an Alignment to the layer, and say what happened.
 *
 * The outcome is returned rather than thrown or logged because every one of these states is a
 * normal thing for the page to render. An Alignment with two Control Points is not an error — it
 * is a user halfway through their first pairing, who needs to be told that a third point is what
 * makes the map appear.
 */
export function showAlignment(layer: WarpedMapLayer, alignment: Alignment): WarpedRender {
	const need = MINIMUM_CONTROL_POINTS[alignment.transformationType];
	const have = alignment.controlPoints.length;
	if (have < need) return { status: 'too-few-points', have, need };

	try {
		// Typed `string` upstream, but it **returns** an `Error` for a document it will not take —
		// which is a claim rather than a guarantee, so it is widened and checked rather than trusted.
		// Believing the declared type here would surface a rejected Alignment as a map id, and the
		// symptom would be an empty Base Map with the page reporting success.
		const mapId: unknown = layer.addGeoreferencedMap(toGeoreferencedMap(alignment));
		if (mapId instanceof Error) return { status: 'refused', reason: mapId.message };
		if (typeof mapId !== 'string' || mapId === '') {
			return { status: 'refused', reason: 'the renderer accepted the Alignment but named no map' };
		}
		return { status: 'drawn', mapId };
	} catch (cause) {
		return { status: 'refused', reason: cause instanceof Error ? cause.message : String(cause) };
	}
}
