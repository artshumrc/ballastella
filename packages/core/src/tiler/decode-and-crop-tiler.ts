// The default tiler: decode the image once, then crop and resize one tile at a time.
//
// Zero bundle cost — every browser already has this — and it is what every image that fits under
// the measured decode ceiling uses (ADR-0003, `decode-ceiling.ts`).
//
// Two things about this path are worth knowing before changing it.
//
// **The blob is decoded once, not once per tile.** ADR-0003 describes the mechanism as
// `createImageBitmap(blob, sx, sy, sw, sh)`, and that call really does decode the entire image
// before applying the crop rect — so calling it per tile from the blob would decode a gigapixel
// scan several thousand times over. The decoded `ImageBitmap` is held instead, and the crop
// rects are taken from it. That is also exactly why the binding constraint of this path is
// full-image **decode memory**, roughly 4 bytes per pixel, which is what the ceiling measures.
//
// **The resize is `createImageBitmap`'s, not the canvas's.** A tile at scale factor 8 is an
// eight-fold reduction, and a single `drawImage` step of that ratio aliases badly in Firefox:
// measured against an exact box filter on 3-pixel diagonal hatching, one `drawImage` step scores
// MSE 275 in Firefox 153 against 2 in Chromium 151, while `createImageBitmap`'s own
// `resizeQuality: 'high'` scores 1.3 and 2. Aliasing here is not a rendering artefact that goes
// away on the next frame — these tiles *are* the archive. So the reduction is asked for in the
// same call as the crop, and the canvas below only ever draws 1:1.
//
// Known, and not addressed here: WebKit honours the resize options but resamples them poorly at
// large ratios — MSE 1047 on the same probe, roughly a bilinear reduction. Fixing that means
// reducing in repeated halving steps, which for the coarse levels of a large pyramid would need
// intermediates far larger than one tile and is a slice of its own.

import type { OpenTileSource, TileSource } from './ingest.js';
import type { PlannedTile } from './pyramid.js';
import { TILE_JPEG_QUALITY, TILE_MEDIA_TYPE } from './pyramid.js';

/**
 * Whether this browser honours `createImageBitmap`'s `resizeWidth` / `resizeHeight`.
 *
 * Feature-detected rather than assumed, because a browser that ignores the options returns a
 * bitmap at the *source* size, and drawing that into the tile canvas would silently fall back
 * to the aliasing path. Detected once and remembered: the probe is a 2×2 decode.
 */
let resizeSupport: Promise<boolean> | undefined;

const supportsBitmapResize = (): Promise<boolean> =>
	(resizeSupport ??= (async () => {
		try {
			const probe = new OffscreenCanvas(4, 4);
			probe.getContext('2d')?.fillRect(0, 0, 4, 4);
			const bitmap = await createImageBitmap(probe.transferToImageBitmap(), 0, 0, 4, 4, {
				resizeWidth: 2,
				resizeHeight: 2,
				resizeQuality: 'high'
			});
			const honoured = bitmap.width === 2 && bitmap.height === 2;
			bitmap.close();
			return honoured;
		} catch {
			return false;
		}
	})());

/**
 * Opens an image by decoding it whole.
 *
 * Rejects for an image above the browser's decode ceiling, which is the failure `MAX_INGEST_PIXELS`
 * exists to keep a user from ever reaching — `ingestImageFile` refuses from the container's header
 * before this is opened, so arriving here above the ceiling means a format whose header nothing
 * read (ADR-0027).
 */
export const openDecodeAndCropSource: OpenTileSource = async (file: Blob): Promise<TileSource> => {
	const decoded = await createImageBitmap(file);
	const canResize = await supportsBitmapResize();

	return {
		dimensions: { width: decoded.width, height: decoded.height },

		async encodeTile(tile: PlannedTile) {
			const { region, size } = tile;

			// One call: crop to the region and reduce it to the size IIIF says the tile is served at.
			// The reduction being part of the crop is what makes the geometry exact — IIIF Image API
			// 3.0 `size=w,h` means the returned image *is* w by h, an exact resize of the whole
			// region onto those dimensions, which for a ragged tile is a hair over 1 / scaleFactor.
			// See PlannedTile.size for what goes wrong if it is anything else.
			const cropped = canResize
				? await createImageBitmap(decoded, region.x, region.y, region.width, region.height, {
						resizeWidth: size.width,
						resizeHeight: size.height,
						resizeQuality: 'high'
					})
				: await createImageBitmap(decoded, region.x, region.y, region.width, region.height);

			try {
				const canvas = new OffscreenCanvas(size.width, size.height);
				const context = canvas.getContext('2d');

				if (!context) {
					throw new Error('No 2d context on an OffscreenCanvas — cannot encode a tile.');
				}

				if (cropped.width === size.width && cropped.height === size.height) {
					context.drawImage(cropped, 0, 0);
				} else {
					// Only reached where `resizeWidth` is ignored. Same geometry — the region's full
					// extent onto the tile's full extent — at the cost of this browser's `drawImage`
					// filtering, which for a large reduction may alias.
					context.imageSmoothingEnabled = true;
					context.imageSmoothingQuality = 'high';
					context.drawImage(cropped, 0, 0, size.width, size.height);
				}

				const blob = await canvas.convertToBlob({
					type: TILE_MEDIA_TYPE,
					quality: TILE_JPEG_QUALITY / 100
				});

				return new Uint8Array(await blob.arrayBuffer());
			} finally {
				cropped.close();
			}
		},

		async close() {
			decoded.close();
		}
	};
};
