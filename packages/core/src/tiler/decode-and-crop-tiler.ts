import type { OpenTileSource, TileSource } from './ingest.js';
import type { PlannedTile } from './pyramid.js';
import { TILE_JPEG_QUALITY, TILE_MEDIA_TYPE } from './pyramid.js';

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

// Decodes the whole image once; a per-tile createImageBitmap(blob) would re-decode it every time.
export const openDecodeAndCropSource: OpenTileSource = async (file: Blob): Promise<TileSource> => {
	const decoded = await createImageBitmap(file);
	const canResize = await supportsBitmapResize();

	return {
		dimensions: { width: decoded.width, height: decoded.height },

		async encodeTile(tile: PlannedTile) {
			const { region, size } = tile;

			// Resizing within the crop keeps IIIF's exact `size=w,h` geometry for ragged tiles.
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
