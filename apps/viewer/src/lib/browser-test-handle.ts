import type { DrawnStackObjects, StackBuiltListener } from '@ballastella/core/render';

/**
 * The Reader's live map and Layer stack, for the Playwright suite.
 *
 * The same bargain the editor's handles strike, and for the same three questions — each of which is
 * about what *rendered* rather than about what did not throw, and none of which can be asked any other
 * way:
 *
 * - **What order did the stack end up in?** `map.getLayersOrder()` is MapLibre's own answer, and
 *   MapLibre's layer order *is* the mechanism by which one Layer draws above another (ADR-0002). Asking
 *   the app's own array instead would only prove the app agrees with itself.
 * - **Did an aligned Historical Map actually carry bytes?** Each `WarpedMapLayer`'s tile cache answers,
 *   per Layer. The failure this path used to have was an error `@allmaps/render` logged and swallowed,
 *   so a check for an absence of console errors went green while the map rendered blank — which is
 *   precisely the shape a Reader would never report, because a Reader has no console.
 * - **What is the Base Map painted with?** `map.getStyle()` carries the flavor, which is how "toggling
 *   the theme changes the Base Map flavor in the same action" (ADR-0016) becomes an assertion rather
 *   than a screenshot.
 *
 * It is not an API. Nothing in `src/` may read it.
 */
export interface ReaderMapHandle extends DrawnStackObjects {
	/** How many times the whole stack has been built since the page loaded. */
	readonly builds: number;
}

declare global {
	interface Window {
		ballastellaReaderMap?: ReaderMapHandle;
		/**
		 * Cached Base Map tiles the protocol handler answered **with bytes** (ADR-0025).
		 *
		 * A fourth question of the same kind: *did the site's own tiles reach the map?* Only tiles that
		 * carried bytes are recorded, because the failure ADR-0025 names is bytes served and nothing
		 * drawn — a list of requests would be satisfied by exactly the broken case.
		 */
		ballastellaServedBaseMapTiles?: { z: number; x: number; y: number; bytes: number }[];
		/** Cached Base Map tiles requested and answered empty. An empty tile leaves no other trace. */
		ballastellaMissedBaseMapTiles?: { z: number; x: number; y: number }[];
	}
}

/**
 * The listeners `registerCachedBaseMapTiles` takes, recording into the two lists above.
 *
 * **Here rather than in `@ballastella/core`.** A `declare global` on `Window` in core would ship these
 * arrays' types — and the code writing them — into every published Reader's bundle, which is the rule
 * `StackBuiltListener` is written to state. So core takes listeners and each app owns its own arrays.
 */
export const recordCachedBaseMapTiles = () => ({
	onServed: (tile: { z: number; x: number; y: number; bytes: number }) => {
		(window.ballastellaServedBaseMapTiles ??= []).push(tile);
	},
	onMissed: (tile: { z: number; x: number; y: number }) => {
		(window.ballastellaMissedBaseMapTiles ??= []).push(tile);
	}
});

let builds = 0;

export const exposeReaderMapToBrowserTests: StackBuiltListener = (map, warped) => {
	builds += 1;
	window.ballastellaReaderMap = { map, warped, builds };
	return () => {
		delete window.ballastellaReaderMap;
	};
};
