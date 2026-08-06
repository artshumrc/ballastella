// Getting a level-0 IIIF pyramid into a MapLibre raster source.
//
// Two things stand between an XYZ raster source and a IIIF pyramid, and both are handled here.
//
// **IIIF tile URLs are not a `{z}/{x}/{y}` template.** They are
// `{region}/{size}/0/default.jpg`, and they must be built by `getTileImageRequest` rather than
// by string arithmetic, because that is the same function the tiler uses to decide what to
// *write* (ADR-0003). So the source is given a template under our own protocol and this
// handler maps each XYZ tile to the IIIF request `@ballastella/core` says it is.
//
// **MapLibre stretches a raster tile to fill its cell.** A ragged edge tile at the right or
// bottom margin is smaller than a full tile — 176×256 rather than 256×256 — and drawn as-is it
// would be stretched by 45%, putting the content near the image's edges tens of pixels away
// from where a Control Point placed there would think it was. Those tiles are therefore drawn
// into a transparent full-size tile at the size they actually cover. That size is
// `tile.placement`, not the size the tile was served at: IIIF rounds a served tile up to whole
// pixels, and using the rounded number would leave a systematic sub-pixel stretch, which is
// exactly the kind of thing that reads as imprecision rather than as a bug.
//
// Interior tiles — the overwhelming majority — are passed through as bytes without being
// decoded here at all.
//
// This is deliberately *not* the injection layer of ADR-0011. Tiles here come from the app's
// static assets over ordinary HTTP, which keeps the projection isolated from the storage
// layer; ticket 06 replaces the `fetch` below with a `ProjectStore` read, and nothing else in
// this file has to change for it.

import type { ImagePane } from '@ballastella/core';
import { addProtocol, type GetResourceResponse, type RequestParameters } from 'maplibre-gl';

const PROTOCOL = 'ballastella-image';

/** `ballastella-image://<pane id>/<z>/<x>/<y>` */
const TILE_URL = /^ballastella-image:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/;

const panes = new Map<string, ImagePane>();
let protocolRegistered = false;

/** The `tiles` entry for a MapLibre raster source reading this pane's pyramid. */
export const imagePaneTileTemplate = (paneId: string) => `${PROTOCOL}://${paneId}/{z}/{x}/{y}`;

/**
 * Makes a pane's pyramid reachable by `imagePaneTileTemplate(paneId)`. Returns the function
 * that unregisters it again, for component teardown.
 */
export function registerImagePaneTiles(paneId: string, pane: ImagePane): () => void {
	if (!protocolRegistered) {
		// MapLibre's protocol registry is one object for the whole page, so the pane registry
		// rather than the protocol is what varies: panes come and go, `PROTOCOL` is installed once.
		//
		// It does *not* throw on a second registration — maplibre-gl 5.24's `addProtocol` is a
		// plain assignment into `config.REGISTERED_PROTOCOLS` (`src/source/protocol_crud.ts`), so
		// re-registering silently replaces the handler. This flag is therefore a tidiness measure,
		// not a guard against an exception. The one consequence worth knowing: under Vite HMR the
		// flag and `panes` are module state and reset together while the page-global registry does
		// not, so a map still alive from before the reload finds no pane registered and is served
		// transparent tiles until the component remounts. Dev only.
		addProtocol(PROTOCOL, loadTile);
		protocolRegistered = true;
	}

	panes.set(paneId, pane);

	return () => {
		panes.delete(paneId);
	};
}

async function loadTile(
	{ url }: RequestParameters,
	abortController: AbortController
): Promise<GetResourceResponse<ArrayBuffer | ImageBitmap>> {
	const parsed = TILE_URL.exec(url);

	if (!parsed) {
		throw new Error(`Not an image pane tile URL: ${url}`);
	}

	const [, paneId, z, x, y] = parsed as unknown as [string, string, string, string, string];
	const pane = panes.get(paneId);

	if (!pane) {
		throw new Error(`No image pane is registered as "${paneId}".`);
	}

	const tile = pane.tileAt({ z: Number(z), x: Number(x), y: Number(y) });

	if (!tile) {
		// The source's `bounds` and zoom range should mean this never happens. Answering with a
		// transparent tile rather than throwing keeps a stray request from becoming a console
		// full of errors; a hole in the pyramid would show up as a hole in the pane.
		return { data: transparentTile(pane.tileSize) };
	}

	const response = await fetch(tile.url, { signal: abortController.signal });

	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText} fetching ${tile.url}`);
	}

	const fillsItsCell =
		tile.placement.width === pane.tileSize && tile.placement.height === pane.tileSize;

	if (fillsItsCell) {
		return { data: await response.arrayBuffer() };
	}

	return { data: await padToCell(await response.blob(), tile.placement, pane.tileSize) };
}

/** Draws a ragged edge tile into a transparent full-size tile, at the size it covers. */
async function padToCell(
	body: Blob,
	placement: { width: number; height: number },
	tileSize: number
): Promise<ImageBitmap> {
	const served = await createImageBitmap(body);

	try {
		const canvas = new OffscreenCanvas(tileSize, tileSize);
		const context = canvas.getContext('2d');

		if (!context) {
			throw new Error('No 2d context on an OffscreenCanvas — cannot place ragged edge tiles.');
		}

		context.imageSmoothingQuality = 'high';
		context.drawImage(served, 0, 0, placement.width, placement.height);

		// Then clamp the edge outward by a pixel. MapLibre samples the tile texture with linear
		// filtering, so along the boundary between the content and the transparent remainder it
		// blends the two — and transparent black darkens, leaving a roughly one-screen-pixel dark
		// fringe down the image's right and bottom edges at full resolution. Replicating the last
		// column and row into the dead area is the standard clamp-to-edge remedy and changes
		// nothing about geometry: `placement` is untouched, and the replicated pixels sit outside
		// the image's own extent, which only ragged margin tiles have.
		const edge = 1;

		if (placement.width < tileSize) {
			context.drawImage(
				served,
				served.width - 1,
				0,
				1,
				served.height,
				placement.width,
				0,
				edge,
				placement.height
			);
		}

		if (placement.height < tileSize) {
			context.drawImage(
				served,
				0,
				served.height - 1,
				served.width,
				1,
				0,
				placement.height,
				placement.width + edge,
				edge
			);
		}

		return canvas.transferToImageBitmap();
	} finally {
		served.close();
	}
}

const transparentTile = (tileSize: number) =>
	new OffscreenCanvas(tileSize, tileSize).transferToImageBitmap();
