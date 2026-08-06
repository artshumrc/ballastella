import type { WarpedMapLayer } from '@allmaps/maplibre';
import type { Map as MapLibreMap } from 'maplibre-gl';

declare global {
	interface Window {
		/**
		 * The live warped-map layer and the map it is on, for the Playwright suite.
		 *
		 * Same bargain as `ballastellaBaseMap` in ticket 04: SPEC's Seam 2 is the real thing in a
		 * real browser and rules out a map abstraction, so a browser test needs a handle on the
		 * object itself. This one exists for a specific question that cannot be asked any other way
		 * — whether a `fetchFn` handed to `@allmaps/maplibre` actually delivers bytes — and asking it
		 * needs a georeferenced map, which the app cannot make until Alignments exist in ticket 07.
		 * The suite supplies one; nothing in the app does.
		 *
		 * It is not an API. Nothing in `src/` may read it.
		 */
		ballastellaWarped?: { map: MapLibreMap; layer: WarpedMapLayer };
	}
}

export function exposeWarpedLayerToBrowserTests(
	map: MapLibreMap,
	layer: WarpedMapLayer
): () => void {
	window.ballastellaWarped = { map, layer };
	return () => {
		delete window.ballastellaWarped;
	};
}
