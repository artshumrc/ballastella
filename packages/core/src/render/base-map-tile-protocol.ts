import { addProtocol } from 'maplibre-gl';
import type { GetResourceResponse, RequestParameters } from 'maplibre-gl';

const BASE_MAP_TILE_PROTOCOL = 'ballastella-base-map';
const TILE_URL = new RegExp(`^${BASE_MAP_TILE_PROTOCOL}://tiles/(\\d+)/(\\d+)/(\\d+)$`);

export const cachedBaseMapTileTemplate = (): string =>
	`${BASE_MAP_TILE_PROTOCOL}://tiles/{z}/{x}/{y}`;

type CachedTileRef = { z: number; x: number; y: number };

export type ReadCachedTile = (tile: CachedTileRef) => Promise<Uint8Array | null>;

interface CachedTileListeners {
	readonly onServed?: (tile: CachedTileRef & { bytes: number }) => void;
	readonly onMissed?: (tile: CachedTileRef) => void;
}

let reader: ReadCachedTile | null = null;
let listeners: CachedTileListeners = {};
let protocolRegistered = false;

export function registerCachedBaseMapTiles(
	readTile: ReadCachedTile,
	watch: CachedTileListeners = {}
): () => void {
	if (!protocolRegistered) {
		addProtocol(BASE_MAP_TILE_PROTOCOL, loadTile);
		protocolRegistered = true;
	}
	reader = readTile;
	listeners = watch;
	return () => {
		if (reader === readTile) {
			reader = null;
			listeners = {};
		}
	};
}

async function loadTile(
	{ url }: RequestParameters,
	abortController: AbortController
): Promise<GetResourceResponse<ArrayBuffer>> {
	const parsed = TILE_URL.exec(url);
	if (!parsed) throw new Error(`Not a cached Base Map tile URL: ${url}`);
	const [, z, x, y] = parsed;
	const tile = { z: Number(z), x: Number(x), y: Number(y) };
	const readTile = reader;
	if (readTile === null) {
		listeners.onMissed?.(tile);
		return { data: new ArrayBuffer(0) };
	}

	const bytes = await readTile(tile);
	if (abortController.signal.aborted || bytes === null || bytes.byteLength === 0) {
		if (!abortController.signal.aborted) listeners.onMissed?.(tile);
		return { data: new ArrayBuffer(0) };
	}
	listeners.onServed?.({ ...tile, bytes: bytes.byteLength });
	return { data: bytes.slice().buffer };
}
