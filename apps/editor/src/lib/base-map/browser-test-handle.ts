import type { Map as MapLibreMap } from 'maplibre-gl';

declare global {
	interface Window {
		/**
		 * The live MapLibre map behind the Base Map pane, for the Playwright suite.
		 *
		 * SPEC's Seam 2 is "the running app in a real browser, with real MapLibre", and it rules out
		 * a map-abstraction layer on purpose: inventing one to enable testing is the premature
		 * boundary ADR-0019 argues against, and it would test a fake instead of the thing that ships.
		 * That leaves the browser tests needing a handle on the real map to ask what is rendered, and
		 * this is it — one property, set once, read only by `e2e/`.
		 *
		 * It is not an API. Nothing in `src/` may read it.
		 */
		ballastellaBaseMap?: MapLibreMap;
	}
}

export function exposeBaseMapToBrowserTests(map: MapLibreMap): () => void {
	window.ballastellaBaseMap = map;
	return () => {
		delete window.ballastellaBaseMap;
	};
}
