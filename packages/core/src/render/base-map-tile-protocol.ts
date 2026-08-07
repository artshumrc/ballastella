// The cached Base Map's tiles reaching MapLibre (ADR-0011, ADR-0025).
//
// ADR-0011's pattern verbatim, and the third instance of it in this repository: a private scheme
// registered once, a registry that varies, and bytes through an injected reader. The other two are
// `apps/editor/src/lib/image-pane/tile-protocol.ts` for a Historical Map's IIIF pyramid and
// `pmtiles-protocol.ts` beside this file for the deployment's archive. This one reads
// `base-map/tiles/{z}/{x}/{y}.mvt` out of the Workspace.
//
// **The bytes are decompressed MVT and are served as they are stored.** ADR-0025 makes compression an
// explicit decision because getting it wrong is a silent blank map: PMTiles stores tiles gzipped and
// its `Protocol` decompresses on the way out, so the bytes MapLibre has always been handed for this
// dataset are decompressed, and that is what the cache holds. Nothing here compresses or
// decompresses anything, which is the point — there is no conversion to get backwards. See the note
// at the top of `../base-map/tile-cache.ts` for the measurement behind the decision.
//
// **A tile outside the cache is answered with an empty tile, never a throw.** That is what
// `tile-protocol.ts` does for a request outside the pyramid, and what `pmtiles`' own `Protocol` does
// for a tile an archive does not carry (`return { data: new Uint8Array }`). A stray request must not
// fill the console. It is also why the *Project-level* claim is computed from which files exist
// rather than from whether anything complained: a partial cache draws holes and says nothing, so
// `offlineCoverage` decides "available offline" and this handler decides nothing at all.

import { addProtocol } from 'maplibre-gl';
import type { GetResourceResponse, RequestParameters } from 'maplibre-gl';

/** The scheme cached Base Map tiles are reached under. */
export const BASE_MAP_TILE_PROTOCOL = 'ballastella-base-map';

/** `ballastella-base-map://tiles/<z>/<x>/<y>` */
const TILE_URL = new RegExp(`^${BASE_MAP_TILE_PROTOCOL}://tiles/(\\d+)/(\\d+)/(\\d+)$`);

/**
 * The `tiles` entry for a MapLibre vector source reading the Workspace's cache.
 *
 * A template rather than a URL, because MapLibre substitutes `{z}/{x}/{y}` itself — the same shape
 * `imagePaneTileTemplate` produces for a Historical Map's pyramid.
 */
export const cachedBaseMapTileTemplate = (): string =>
	`${BASE_MAP_TILE_PROTOCOL}://tiles/{z}/{x}/{y}`;

/** Where a cached tile's bytes come from. `null` when the cache has nothing at that tile. */
export type ReadCachedTile = (tile: {
	z: number;
	x: number;
	y: number;
}) => Promise<Uint8Array | null>;

let reader: ReadCachedTile | null = null;
let protocolRegistered = false;

/**
 * Serve the cached Base Map through {@link cachedBaseMapTileTemplate} from `readTile`.
 *
 * Returns the function that stops serving, for component teardown. One reader at a time, because
 * there is one Workspace: unlike the image pane's registry, which is keyed by pane because a page can
 * hold two, the Base Map cache is a single place and a second registration replacing the first is the
 * correct behaviour when a pane remounts.
 *
 * MapLibre's protocol registry is page-global and `addProtocol` does not throw on a second
 * registration — in maplibre-gl 5 it is a plain assignment into `config.REGISTERED_PROTOCOLS` — so
 * the flag is tidiness rather than a guard, exactly as it is in the other two protocol modules.
 */
export function registerCachedBaseMapTiles(readTile: ReadCachedTile): () => void {
	if (!protocolRegistered) {
		addProtocol(BASE_MAP_TILE_PROTOCOL, loadTile);
		protocolRegistered = true;
	}
	reader = readTile;
	const mine = readTile;
	return () => {
		// Only if nothing has replaced it since: a pane that mounts before the outgoing one tears down
		// would otherwise be unregistered by its predecessor's cleanup.
		if (reader === mine) reader = null;
	};
}

/** An empty vector tile: no layers, no features. MapLibre draws nothing and reports no error. */
const EMPTY_TILE = (): ArrayBuffer => new ArrayBuffer(0);

async function loadTile(
	{ url }: RequestParameters,
	abortController: AbortController
): Promise<GetResourceResponse<ArrayBuffer>> {
	const parsed = TILE_URL.exec(url);
	if (!parsed) throw new Error(`Not a cached Base Map tile URL: ${url}`);
	const [, z, x, y] = parsed as unknown as [string, string, string, string];

	const tile = { z: Number(z), x: Number(x), y: Number(y) };

	const readTile = reader;
	if (readTile === null) {
		recordMissedBaseMapTile(tile);
		return { data: EMPTY_TILE() };
	}

	const bytes = await readTile(tile);
	if (abortController.signal.aborted || bytes === null || bytes.byteLength === 0) {
		if (!abortController.signal.aborted) recordMissedBaseMapTile(tile);
		return { data: EMPTY_TILE() };
	}
	recordServedBaseMapTile({ ...tile, bytes: bytes.byteLength });
	// A fresh buffer, because the store's `Uint8Array` may be a view into a larger one and MapLibre
	// takes the whole `ArrayBuffer` it is given.
	return { data: bytes.slice().buffer };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The Playwright handle
//
// SPEC's Seam 2 rules out a map abstraction, so a browser test asking "did a cached tile actually
// reach MapLibre" needs the live thing to have said so.
//
// **Two lists, because served and requested are different questions and each is vacuous for the
// other's claim.** `ballastellaServedBaseMapTiles` records only tiles answered *with bytes*, which is
// what makes "the map drew from the cache" mean something: the criterion ADR-0025 warns about is
// bytes served and nothing drawn, and an assertion that the map has a source, or that no error
// appeared, passes in exactly that case.
//
// `ballastellaMissedBaseMapTiles` records the tiles MapLibre **asked for and did not get** — and that
// list is the only way to see a request that produced nothing, because an empty tile is not an error
// and leaves no other trace. It is what "the source's `maxzoom` stops MapLibre asking past the
// pyramid" is asserted with: written first without it, that assertion filtered the *served* list for
// deep tiles, which cannot contain a miss by construction and so passed with `maxzoom` removed.

declare global {
	interface Window {
		/** Cached Base Map tiles served with bytes, in order. Read only by `e2e/`; not an API. */
		ballastellaServedBaseMapTiles?: { z: number; x: number; y: number; bytes: number }[];
		/** Cached Base Map tiles requested and answered empty. Read only by `e2e/`; not an API. */
		ballastellaMissedBaseMapTiles?: { z: number; x: number; y: number }[];
	}
}

function recordServedBaseMapTile(tile: { z: number; x: number; y: number; bytes: number }): void {
	if (typeof window === 'undefined') return;
	(window.ballastellaServedBaseMapTiles ??= []).push(tile);
}

function recordMissedBaseMapTile(tile: { z: number; x: number; y: number }): void {
	if (typeof window === 'undefined') return;
	(window.ballastellaMissedBaseMapTiles ??= []).push(tile);
}
