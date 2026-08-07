// Reading tiles out of the deployment's PMTiles archive, one at a time, so they can be cached
// (ADR-0025).
//
// `pmtiles@4.4.1` has no writer — which is why the cache is files rather than an archive — but its
// read side is exactly what enumerating and pulling needs: `PMTiles` over a `FetchSource` resolves
// each `{z}/{x}/{y}` through the root and leaf directories with byte-range requests, and returns the
// tile **already decompressed**, because `getZxyAttempt` ends with
// `this.decompress(data, header.tileCompression)`.
//
// That last fact is the compression decision ADR-0025 demands be explicit. What comes out of here is
// what goes into the cache and what the protocol handler serves: decompressed MVT, unconverted at
// every step. See the note at the top of `@ballastella/core`'s `base-map/tile-cache.ts` for the
// measurement and the cost.
//
// **This is the one module in the editor that opens the archive for anything other than rendering.**
// It names no catalog entry and no archive URL of its own — it is handed a `BaseMapEntry`, which is
// what `scripts/check-base-map-catalog.mjs` requires of everything outside the catalog (ADR-0020).

import { archiveUrl, type BaseMapEntry, type Bytes, type TileCoordinate } from '@ballastella/core';
import { PMTiles } from 'pmtiles';

import { resolveDeploymentAsset } from './deployment-assets';

/** An opened archive: how deep it goes, and how to pull one tile out of it. */
export interface ArchiveTileSource {
	/**
	 * The deepest zoom the archive carries.
	 *
	 * Read from the header rather than assumed, and it is what the cache is filled to and what the
	 * cached style's `maxzoom` is set to — "every zoom level from 0 to the source's maximum" is
	 * ADR-0025's wording, and the source is the only thing that knows what its maximum is. Guessing 14
	 * would under-fill a deeper archive and ask a shallower one for tiles it has none of.
	 */
	readonly maxZoom: number;
	/** One tile's decompressed bytes, or `null` when the archive has nothing there. */
	readTile(tile: TileCoordinate): Promise<Bytes | null>;
}

/**
 * Open the archive one catalog entry names.
 *
 * Rejects when the archive cannot be read at all — no network, or a URL that answers nothing — which
 * is a state the caller has to render rather than swallow: "make this Project available offline"
 * needs the network *now*, and failing silently would leave a progress bar at zero with no account of
 * itself.
 */
export async function openArchiveTiles(entry: BaseMapEntry): Promise<ArchiveTileSource> {
	const archive = new PMTiles(archiveUrl(entry, resolveDeploymentAsset));
	const header = await archive.getHeader();
	return {
		maxZoom: header.maxZoom,
		async readTile(tile) {
			const found = await archive.getZxy(tile.z, tile.x, tile.y);
			if (!found) return null;
			// A copy rather than a view: `getZxy` may hand back a buffer the cache also holds, and the
			// store's `Bytes` is written straight through to disk.
			return new Uint8Array(found.data.slice(0)) as Bytes;
		}
	};
}
