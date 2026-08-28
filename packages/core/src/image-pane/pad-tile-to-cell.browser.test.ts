// The ragged-edge tile placement, asserted on **canvas pixels**.
//
// It runs in the browser project because `OffscreenCanvas`, `createImageBitmap` and the
// downscaling filter are the subject, not an obstacle: what is being checked is where the content
// of a ragged tile ends up, and the only witness to that is the bitmap.
//
// It exists because the assertion it replaces read the wrong thing. The browser suite asserted
// ragged placement out of `window.ballastellaServedTiles` — the app's own log of the `placement` it
// was *handed* — so replacing `placement.width` with the served width inside the drawing code left
// the log identical and the suite green, while every horizontally ragged tile of every Map
// Image came out stretched. And the one committed fixture geometry could not have caught it anyway:
// 700 × 500 yields nine tiles whose every region divides by its scale factor, so `placement` is
// integral everywhere and the two numbers are the same number.
//
// So the fixture here is deliberately fractional in both axes: 300 × 1300 at scale factor 8 has a
// single tile covering the whole image, served at 38 × 163 and placed at 37.5 × 162.5.

import { describe, expect, it } from 'vitest';

import { padTileToCell } from './pad-tile-to-cell.js';

const TILE_SIZE = 256;

/** The ragged tile of a 300 × 1300 pyramid at scale factor 8: `0,0,300,1300` → `38,163`. */
const SERVED = { width: 38, height: 163 };
const PLACEMENT = { width: 300 / 8, height: 1300 / 8 };

/**
 * A served tile whose top-left `whiteWidth` × `whiteHeight` pixels are white and the rest black,
 * as a lossless PNG.
 *
 * PNG rather than JPEG so that the measurements below are of the placement and not of the
 * encoder's ringing. `padTileToCell` only ever calls `createImageBitmap`, which does not care.
 */
async function servedTile(whiteWidth: number, whiteHeight: number): Promise<Blob> {
	const canvas = new OffscreenCanvas(SERVED.width, SERVED.height);
	const context = canvas.getContext('2d');
	if (!context) throw new Error('no 2d context');

	context.fillStyle = 'black';
	context.fillRect(0, 0, SERVED.width, SERVED.height);
	context.fillStyle = 'white';
	context.fillRect(0, 0, whiteWidth, whiteHeight);

	return canvas.convertToBlob({ type: 'image/png' });
}

/** The pixels of a padded tile, as un-premultiplied RGBA. */
function pixelsOf(bitmap: ImageBitmap): ImageData {
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const context = canvas.getContext('2d');
	if (!context) throw new Error('no 2d context');
	context.drawImage(bitmap, 0, 0);
	return context.getImageData(0, 0, bitmap.width, bitmap.height);
}

/**
 * How much white a row (or a column) holds, in whole-pixel equivalents.
 *
 * The sum of coverage-weighted brightness, which is the right statistic for the same reason it is
 * in the streaming tiler's tests: a normalised resampling kernel preserves the total, and a partly
 * covered pixel contributes exactly its coverage. Alpha is part of the weight because the padded
 * tile is transparent outside the content, and canvas `getImageData` reports coverage there in the
 * alpha channel rather than in the colour.
 */
const whiteExtent = (
	pixels: ImageData,
	at: number,
	along: 'row' | 'column',
	limit: number
): number => {
	let total = 0;
	for (let index = 0; index < limit; index++) {
		const x = along === 'row' ? index : at;
		const y = along === 'row' ? at : index;
		const offset = (y * pixels.width + x) * 4;
		total += (pixels.data[offset]! / 255) * (pixels.data[offset + 3]! / 255);
	}
	return total;
};

describe('padTileToCell', () => {
	it('draws a ragged tile at its fractional placement, not at the size it was served', async () => {
		// A sharp white-to-black edge 30 served columns in and 100 served rows down. Under the
		// fractional placement it lands at 30 × 37.5/38 = 29.605 and 100 × 162.5/163 = 99.693; drawn
		// at the served size it would land at exactly 30 and 100. Four tenths of a pixel and three
		// tenths of a pixel — sub-pixel, systematic, at the margins of every Map Image, which is
		// exactly the drift that is the project's first risk.
		const whiteWidth = 30;
		const whiteHeight = 100;
		const padded = await padTileToCell(
			await servedTile(whiteWidth, whiteHeight),
			PLACEMENT,
			TILE_SIZE
		);
		const pixels = pixelsOf(padded);

		expect([padded.width, padded.height]).toEqual([TILE_SIZE, TILE_SIZE]);

		// Measured well inside the content on the other axis, so neither reading is contaminated by
		// the far margin or by the edge clamp.
		const acrossRow = whiteExtent(pixels, 5, 'row', TILE_SIZE);
		const downColumn = whiteExtent(pixels, 5, 'column', TILE_SIZE);

		const placed = {
			x: (whiteWidth * PLACEMENT.width) / SERVED.width,
			y: (whiteHeight * PLACEMENT.height) / SERVED.height
		};

		expect(placed.x).toBeCloseTo(29.605, 2);
		expect(placed.y).toBeCloseTo(99.693, 2);

		// The tolerance is half the distance between the two hypotheses rather than a fixed number of
		// digits, because that distance is what the measurement has to resolve and it is different on
		// each axis — 0.395 px horizontally, 0.307 px vertically. A fixed 0.05 was tighter than
		// Firefox's own sub-pixel offset while asserting nothing more.
		for (const [label, measured, placedExtent, servedExtent] of [
			['width', acrossRow, placed.x, whiteWidth],
			['height', downColumn, placed.y, whiteHeight]
		] as const) {
			const separation = Math.abs(placedExtent - servedExtent);
			expect(separation, `${label}: the two hypotheses are not separable here`).toBeGreaterThan(
				0.25
			);
			expect(
				Math.abs(measured - placedExtent),
				`the tile was drawn at its served ${label}, not its placement`
			).toBeLessThan(separation / 2);
		}
	});

	it('covers exactly its placement, plus one clamped pixel against the dark fringe', async () => {
		// A wholly white tile, so coverage is the only thing being read. The content must reach
		// 37.5 × 162.5 and the clamp must carry it one pixel further — MapLibre filters the tile
		// texture linearly, and blending opaque content against transparent black is what leaves a
		// dark line down the right and bottom margins of the image at full resolution.
		const padded = await padTileToCell(
			await servedTile(SERVED.width, SERVED.height),
			PLACEMENT,
			TILE_SIZE
		);
		const pixels = pixelsOf(padded);

		expect(whiteExtent(pixels, 5, 'row', TILE_SIZE)).toBeCloseTo(PLACEMENT.width + 1, 1);
		expect(whiteExtent(pixels, 5, 'column', TILE_SIZE)).toBeCloseTo(PLACEMENT.height + 1, 1);

		// Nothing beyond the clamp: the rest of the cell is transparent, so a neighbouring tile is
		// not overdrawn and the pane shows the image's real extent.
		const beyond = (x: number, y: number) => pixels.data[(y * pixels.width + x) * 4 + 3];
		expect(beyond(40, 5)).toBe(0);
		expect(beyond(5, 165)).toBe(0);
	});

	it('leaves an interior tile alone, at exactly the cell size', async () => {
		// The overwhelming majority of tiles. Passed through here they must come out unchanged, and
		// in the tile protocol they never reach this function at all.
		const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
		const context = canvas.getContext('2d')!;
		context.fillStyle = 'white';
		context.fillRect(0, 0, TILE_SIZE, TILE_SIZE);

		const padded = await padTileToCell(
			await canvas.convertToBlob({ type: 'image/png' }),
			{ width: TILE_SIZE, height: TILE_SIZE },
			TILE_SIZE
		);
		const pixels = pixelsOf(padded);

		expect(whiteExtent(pixels, 5, 'row', TILE_SIZE)).toBeCloseTo(TILE_SIZE, 1);
		expect(whiteExtent(pixels, 5, 'column', TILE_SIZE)).toBeCloseTo(TILE_SIZE, 1);
	});
});
