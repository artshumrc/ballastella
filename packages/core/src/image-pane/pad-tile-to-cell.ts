// Drawing a ragged edge tile into the cell a raster renderer gives it.
//
// MapLibre stretches a raster tile to fill its cell. A ragged tile at the right or bottom margin
// is smaller than a full tile — 176 × 256 rather than 256 × 256 — and drawn as-is it would be
// stretched by 45%, putting the content near the image's edges tens of pixels from where a
// Control Point placed there would think it was. So those tiles are drawn into a transparent
// full-size tile at the size they actually cover.
//
// That size is {@link ImagePaneTile.placement} — `region / scaleFactor`, 106.375 for a tile served
// at 107 — and **not** the size the tile was served at. IIIF rounds a served tile up to whole
// pixels; using the rounded number leaves a systematic sub-pixel stretch at every ragged margin of
// every Map Image, which reads as imprecision rather than as a bug. It is the silent-drift
// failure SPEC ranks first among the project's risks.
//
// ## Chromium rounds a fractional `drawImage` destination, so asking for one is not enough
//
// Measured 2026-08-06 against `OffscreenCanvas` in both engines, drawing a 38 × 163 bitmap:
//
// | destination size | Chromium 151 draws | Firefox 153 draws |
// | ---------------- | ------------------ | ----------------- |
// | 37.5 × 162.5     | **38 × 163**       | 37.502 × 162.502  |
// | 150 × 106.375    | **150 × 106**      | 150 × 106.377     |
// | 99.1 / 99.9      | **99 / 100**       | 99.102 / 99.902   |
// | 99.6 / 99.4      | **100 / 99**       | 99.604 / 99.400   |
//
// Chromium rounds the destination rectangle to whole pixels — to nearest, so it is not even
// consistently the served size — and does so identically for `drawImage(…, dw, dh)`, for a source
// sub-rect, for `setTransform` and for `scale`. Firefox honours the fraction to within 0.02 px.
//
// The consequence is that `placement` was a comment rather than a behaviour in the browser this
// app is developed and tested in: for the 300 × 1300 pyramid below, 37.5 and the served 38 produce
// **the same bitmap**, and up to half a cell pixel of the ragged margin is displaced. Chromium
// rounding down (106.375 → 106) is the worse direction, since it is a stretch of the content
// *outwards* past its own region.
//
// So the drawing is staged at an integer multiple of the cell and blitted down by exactly that
// multiple. `placement` is `region / scaleFactor` and `scaleFactor` is a power of two, so the
// multiple that makes the placement whole is a power of two too — and the final blit's destination
// is an integer, which is the one thing both engines place exactly. What survives is a residual of
// half a staged pixel at levels whose scale factor exceeds {@link MAX_SUPERSAMPLE}: at worst
// 1/16 of a cell pixel, against half a cell pixel before.

/**
 * Largest multiple of the cell the staging canvas may use.
 *
 * 8 keeps a 256-pixel tile's staging area to 2056 × 2056 at the very worst — 4.2 megapixels,
 * inside the 5,242,880-pixel canvas area limit ADR-0003 records for Safari, which is the same
 * limit the decode-and-crop tiler is shaped around. The staging canvas is in practice much
 * smaller, because it is only as large as the content and its clamp, not as large as the cell.
 */
const MAX_SUPERSAMPLE = 8;

/** One tile pixel of clamp beyond the content — see the note on the fringe below. */
const EDGE = 1;

/**
 * The smallest power-of-two multiple at which `extent` is a whole number of staged pixels, capped.
 *
 * 1 for an integral placement, which is every tile at scale factor 1 and every interior tile at
 * any level: `placement` is `region / scaleFactor`, so it is fractional only where a ragged
 * region does not divide by its own scale factor.
 */
function supersampleFor(extent: number): number {
	let multiple = 1;
	while (multiple < MAX_SUPERSAMPLE && !Number.isInteger(extent * multiple)) multiple *= 2;
	return multiple;
}

function context2dOf(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
	const context = canvas.getContext('2d');
	if (!context) {
		throw new Error('No 2d context on an OffscreenCanvas — cannot place ragged edge tiles.');
	}
	context.imageSmoothingQuality = 'high';
	return context;
}

/**
 * Draw a ragged edge tile into a transparent `tileSize`-square tile, at the size it covers.
 *
 * `placement` is in cell pixels and is expected to be fractional at a ragged margin; `body` is the
 * tile's bytes exactly as they were served, at whatever whole-pixel size IIIF rounded them up to.
 * An interior tile fills its cell and does not need this at all.
 */
export async function padTileToCell(
	body: Blob,
	placement: { width: number; height: number },
	tileSize: number
): Promise<ImageBitmap> {
	const served = await createImageBitmap(body);

	try {
		const multiple = {
			x: supersampleFor(placement.width),
			y: supersampleFor(placement.height)
		};

		// The part of the cell the content and its clamp occupy, in whole cell pixels. Only this much
		// is staged: the rest of the cell is transparent and blitting transparency costs nothing.
		const cell = {
			width: Math.min(tileSize, Math.ceil(placement.width) + EDGE),
			height: Math.min(tileSize, Math.ceil(placement.height) + EDGE)
		};

		const stage = context2dOf(
			new OffscreenCanvas(cell.width * multiple.x, cell.height * multiple.y)
		);
		const staged = { width: placement.width * multiple.x, height: placement.height * multiple.y };

		stage.drawImage(served, 0, 0, staged.width, staged.height);

		// Then clamp the edge outward by a pixel. MapLibre samples the tile texture with linear
		// filtering, so along the boundary between the content and the transparent remainder it
		// blends the two — and transparent black darkens, leaving a roughly one-screen-pixel dark
		// fringe down the image's right and bottom edges at full resolution. Replicating the last
		// column and row into the dead area is the standard clamp-to-edge remedy and changes
		// nothing about geometry: `placement` is untouched, and the replicated pixels sit outside
		// the image's own extent, which only ragged margin tiles have.
		if (placement.width < tileSize) {
			stage.drawImage(
				served,
				served.width - 1,
				0,
				1,
				served.height,
				staged.width,
				0,
				EDGE * multiple.x,
				staged.height
			);
		}

		if (placement.height < tileSize) {
			stage.drawImage(
				served,
				0,
				served.height - 1,
				served.width,
				1,
				0,
				staged.height,
				staged.width + EDGE * multiple.x,
				EDGE * multiple.y
			);
		}

		const canvas = new OffscreenCanvas(tileSize, tileSize);
		// Integral destination, and an exact power-of-two reduction: the one placement both engines
		// honour to the pixel.
		context2dOf(canvas).drawImage(stage.canvas, 0, 0, cell.width, cell.height);

		return canvas.transferToImageBitmap();
	} finally {
		served.close();
	}
}
