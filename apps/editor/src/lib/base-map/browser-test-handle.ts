import type { Map as MapLibreMap } from 'maplibre-gl';

declare global {
	interface Window {
		/**
		 * The live MapLibre map behind the Base Map pane, for the Playwright suite.
		 *
		 * The second of the two test seams `CONTRIBUTING.md` names is the running app in a real browser
		 * with real MapLibre, and it rules out a map-abstraction layer on purpose: inventing one to
		 * enable testing is the premature boundary ADR-0019 argues against, and it would test a fake
		 * instead of the thing that ships. That leaves the browser tests needing a handle on the real
		 * map to ask what is rendered, and this is it — one property, set once, read only by `e2e/`.
		 *
		 * It is not an API. Nothing in `src/` may read it.
		 */
		ballastellaBaseMap?: MapLibreMap;
		/**
		 * Cached Base Map tiles the protocol handler answered **with bytes**, in order (ADR-0025).
		 *
		 * Only tiles that carried bytes, which is the whole of its value: the failure ADR-0025 names is
		 * bytes served and nothing drawn, so a list of *requests* would be satisfied by exactly the
		 * broken case. Paired with a rendered-geometry check on a Base Map layer, it says the cache fed
		 * the map.
		 */
		ballastellaServedBaseMapTiles?: { z: number; x: number; y: number; bytes: number }[];
		/**
		 * Cached Base Map tiles requested and answered empty.
		 *
		 * The only trace such a request leaves anywhere — an empty tile is not an error and logs
		 * nothing — and the reason the served list cannot answer "did MapLibre ask past the pyramid?".
		 */
		ballastellaMissedBaseMapTiles?: { z: number; x: number; y: number }[];
	}
}

export function exposeBaseMapToBrowserTests(map: MapLibreMap): () => void {
	window.ballastellaBaseMap = map;
	return () => {
		delete window.ballastellaBaseMap;
	};
}

/**
 * The listeners `registerCachedBaseMapTiles` takes, recording into the two lists above.
 *
 * **Here rather than in `@ballastella/core`**, which is the rule `StackBuiltListener` states: a
 * `declare global` on `Window` inside core would put this app's test scaffolding into the viewer's
 * types and into the Reader's bundle, and `ReaderMapPane` imports that module. So core takes
 * the listeners and this file owns the arrays.
 */
export const recordCachedBaseMapTiles = () => ({
	onServed: (tile: { z: number; x: number; y: number; bytes: number }) => {
		(window.ballastellaServedBaseMapTiles ??= []).push(tile);
	},
	onMissed: (tile: { z: number; x: number; y: number }) => {
		(window.ballastellaMissedBaseMapTiles ??= []).push(tile);
	}
});
