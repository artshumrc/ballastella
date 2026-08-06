import type { WarpedMapLayer } from '@allmaps/maplibre';
import type { Map as MapLibreMap } from 'maplibre-gl';

/**
 * The live Layer stack, for the Playwright suite.
 *
 * Same bargain as `ballastellaWarped` in ticket 07 and `ballastellaBaseMap` in ticket 04: SPEC's
 * Seam 2 is the real thing in a real browser and rules out a map abstraction, so a browser test needs
 * a handle on the objects themselves. This one exists for three questions that cannot be asked any
 * other way, and each is about what *rendered* rather than about what did not throw:
 *
 * - **What order did the stack end up in?** `map.getLayersOrder()` is MapLibre's own answer, and
 *   MapLibre's layer order *is* the mechanism by which one Layer draws above another. Asserting on
 *   the app's own array instead would only prove the app agrees with itself.
 * - **Did an aligned Historical Map actually carry bytes?** Each `WarpedMapLayer`'s tile cache
 *   answers, per Layer. The failure this path used to have was an error `@allmaps/render` logged and
 *   swallowed, so a check for an absence of console errors went green while the map rendered blank.
 * - **Was the stack torn down and rebuilt?** {@link builds} counts, so "dragging the opacity slider
 *   does not refetch every tile" is a claim with a number behind it (ADR-0017 rule 1).
 *
 * It is not an API. Nothing in `src/` may read it.
 */
export interface LayerStackHandle {
	readonly map: MapLibreMap;
	/** The live warped layer for each `kind: 'map'` Layer of the stack, by Layer id. */
	readonly warped: Readonly<Record<string, WarpedMapLayer>>;
	/** How many times the whole stack has been built since the page loaded. */
	readonly builds: number;
}

declare global {
	interface Window {
		ballastellaLayerStack?: LayerStackHandle;
	}
}

let builds = 0;

export function exposeLayerStackToBrowserTests(
	map: MapLibreMap,
	warped: Readonly<Record<string, WarpedMapLayer>>
): () => void {
	builds += 1;
	window.ballastellaLayerStack = { map, warped, builds };
	return () => {
		delete window.ballastellaLayerStack;
	};
}
