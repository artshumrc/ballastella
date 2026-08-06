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
// **Wired before there is anything to warp**, on purpose. No Alignment exists until ticket 07, so
// this layer draws nothing yet; the seam is built now because it is the same shim, and doing it
// later means coming back through this code with alignment work in flight. What it establishes
// today is that the option exists and is accepted, that the package resolves against the one
// MapLibre copy in the page, and that a layer added to a real map issues no request to the
// placeholder host.

import { WarpedMapLayer } from '@allmaps/maplibre';
import type { FetchFn } from '@ballastella/core';

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
