import { recordServedTile } from '../browser-test-handles.js';

import { padTileToCell, type FetchFn, type ImagePane } from '@ballastella/core';
import { addProtocol, type GetResourceResponse, type RequestParameters } from 'maplibre-gl';

const PROTOCOL = 'ballastella-image';
const TILE_URL = /^ballastella-image:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/;

type RegisteredPane = { pane: ImagePane; fetchTile: FetchFn };

const panes = new Map<string, RegisteredPane>();
let protocolRegistered = false;
export const imagePaneTileTemplate = (paneId: string) => `${PROTOCOL}://${paneId}/{z}/{x}/{y}`;

export function registerImagePaneTiles(
	paneId: string,
	pane: ImagePane,
	fetchTile: FetchFn = (input, init) => fetch(input, init)
): () => void {
	if (!protocolRegistered) {
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
