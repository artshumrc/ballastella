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
// would be stretched by 45%. Those tiles are therefore drawn into a transparent full-size tile at
// the size they actually cover, by `padTileToCell`, which lives in `@ballastella/core` beside the
// `placement` it consumes because its correctness is a claim about pixels and pixels can only be
// asserted in a browser — see `pad-tile-to-cell.browser.test.ts`. Nothing about that geometry can
// be asserted from here: this module's only observable output is
// `window.ballastellaServedTiles`, which records what the pane *intended* to draw.
//
// Interior tiles — the overwhelming majority — are passed through as bytes without being
// decoded here at all.
//
// **Where the bytes come from is injected** (ADR-0011, ticket 06). Ticket 03 fetched them from
// the app's static assets, which kept the projection isolated from the storage layer while the
// projection was the risk; a pane over a Historical Map the user ingested is handed
// `createStoreImageFetch` instead, and the tile URLs it builds are on the `unset.invalid`
// placeholder host that shim routes. This file cannot tell the two apart, which is the point:
// one `fetch`-shaped seam, and the fixture pane and the user's own map take the same path
// through it.

import { recordServedTile } from './browser-test-handle';

import { padTileToCell, type FetchFn, type ImagePane } from '@ballastella/core';
import { addProtocol, type GetResourceResponse, type RequestParameters } from 'maplibre-gl';

const PROTOCOL = 'ballastella-image';

/** `ballastella-image://<pane id>/<z>/<x>/<y>` */
const TILE_URL = /^ballastella-image:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/;

/** A registered pane, and the `fetch` its tiles are read through. */
type RegisteredPane = { pane: ImagePane; fetchTile: FetchFn };

const panes = new Map<string, RegisteredPane>();
let protocolRegistered = false;

/** The `tiles` entry for a MapLibre raster source reading this pane's pyramid. */
export const imagePaneTileTemplate = (paneId: string) => `${PROTOCOL}://${paneId}/{z}/{x}/{y}`;

/**
 * Makes a pane's pyramid reachable by `imagePaneTileTemplate(paneId)`. Returns the function
 * that unregisters it again, for component teardown.
 *
 * `fetchTile` is where the pyramid actually lives. Pass `createStoreImageFetch(...)` for a
 * Historical Map in the user's Project — it resolves the placeholder host out of the
 * `ProjectStore` and passes anything else through — and leave it out only for a pyramid that
 * really is served over HTTP, which in this app is ticket 03's committed fixture alone.
 */
export function registerImagePaneTiles(
	paneId: string,
	pane: ImagePane,
	fetchTile: FetchFn = (input, init) => fetch(input, init)
): () => void {
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

	panes.set(paneId, { pane, fetchTile });

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
	const registered = panes.get(paneId);

	if (!registered) {
		throw new Error(`No image pane is registered as "${paneId}".`);
	}

	const { pane, fetchTile } = registered;
	const tile = pane.tileAt({ z: Number(z), x: Number(x), y: Number(y) });

	if (!tile) {
		// The source's `bounds` and zoom range should mean this never happens. Answering with a
		// transparent tile rather than throwing keeps a stray request from becoming a console
		// full of errors; a hole in the pyramid would show up as a hole in the pane.
		return { data: transparentTile(pane.tileSize) };
	}

	const response = await fetchTile(tile.url, { signal: abortController.signal });

	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText} fetching ${tile.url}`);
	}

	recordServedTile(paneId, tile);

	const fillsItsCell =
		tile.placement.width === pane.tileSize && tile.placement.height === pane.tileSize;

	if (fillsItsCell) {
		return { data: await response.arrayBuffer() };
	}

	return { data: await padTileToCell(await response.blob(), tile.placement, pane.tileSize) };
}

const transparentTile = (tileSize: number) =>
	new OffscreenCanvas(tileSize, tileSize).transferToImageBitmap();
