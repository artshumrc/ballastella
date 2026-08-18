import type { ImagePaneTile } from '@ballastella/core';
import type { Map as MapLibreMap } from 'maplibre-gl';

/** One tile the pane actually drew, as the Playwright suite reads it back. */
export type ServedTile = {
	paneId: string;
	scaleFactor: number;
	column: number;
	row: number;
	url: string;
	/** Size in tile pixels the bytes occupy in their cell — smaller than a tile at a ragged edge. */
	placement: { width: number; height: number };
};

declare global {
	interface Window {
		/** The live Image Pane map, exposed only for browser assertions. */
		ballastellaImagePane?: MapLibreMap;
		/**
		 * Every tile the image pane has been served, in order, for the Playwright suite.
		 *
		 * This exists because ticket 06 makes the tiles **unobservable from outside the page**. Up
		 * to ticket 05 the browser suite asserted "tiles at every scale factor load, ragged edges
		 * included" through Playwright's `response` event, because the pyramid was served over HTTP
		 * from static assets. A pyramid read out of OPFS issues no request at all, so the same
		 * criterion has no network to be asserted on — and dropping it would quietly retire the one
		 * check that catches the reader and the writer disagreeing about which tile is where.
		 *
		 * The alternative was a map-abstraction layer, which SPEC's Seam 2 rules out on purpose: it
		 * would test a fake instead of the thing that ships. So this is the same bargain
		 * `ballastellaBaseMap` struck in ticket 04 — one property, written only here, read only by
		 * `e2e/`.
		 *
		 * It is not an API. Nothing in `src/` may read it.
		 */
		ballastellaServedTiles?: ServedTile[];
	}
}

/** Expose the live Image Pane map while it exists, for assertions on its rendered sources. */
export function exposeImagePaneToBrowserTests(map: MapLibreMap): () => void {
	window.ballastellaImagePane = map;
	return () => {
		if (window.ballastellaImagePane === map) delete window.ballastellaImagePane;
	};
}

/**
 * Note that a tile's bytes arrived. Called on the success path of the tile protocol, so a tile
 * that 404ed or was answered as transparent filler is deliberately absent.
 */
export function recordServedTile(paneId: string, tile: ImagePaneTile): void {
	// Only ever appended to a list somebody else created: the suite calls
	// `window.ballastellaServedTiles = []` before it starts watching, which also gives it a way to
	// clear the log between navigations. Absent means nobody is watching.
	window.ballastellaServedTiles?.push({
		paneId,
		scaleFactor: tile.scaleFactor,
		column: tile.column,
		row: tile.row,
		url: tile.url,
		placement: { ...tile.placement }
	});
}
