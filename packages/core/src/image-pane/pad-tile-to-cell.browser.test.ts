import { describe, expect, it } from 'vitest';

import { padTileToCell } from './pad-tile-to-cell.js';

const TILE_SIZE = 256;
const SERVED = { width: 38, height: 163 };
const PLACEMENT = { width: 300 / 8, height: 1300 / 8 };

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

function pixelsOf(bitmap: ImageBitmap): ImageData {
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const context = canvas.getContext('2d');
	if (!context) throw new Error('no 2d context');
	context.drawImage(bitmap, 0, 0);
	return context.getImageData(0, 0, bitmap.width, bitmap.height);
}

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
		const whiteWidth = 30;
		const whiteHeight = 100;
		const padded = await padTileToCell(
			await servedTile(whiteWidth, whiteHeight),
			PLACEMENT,
			TILE_SIZE
		);
		const pixels = pixelsOf(padded);
		expect([padded.width, padded.height]).toEqual([TILE_SIZE, TILE_SIZE]);
		const acrossRow = whiteExtent(pixels, 5, 'row', TILE_SIZE);
		const downColumn = whiteExtent(pixels, 5, 'column', TILE_SIZE);

		const placed = {
			x: (whiteWidth * PLACEMENT.width) / SERVED.width,
			y: (whiteHeight * PLACEMENT.height) / SERVED.height
		};

		expect(placed.x).toBeCloseTo(29.605, 2);
		expect(placed.y).toBeCloseTo(99.693, 2);

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
		const padded = await padTileToCell(
			await servedTile(SERVED.width, SERVED.height),
			PLACEMENT,
			TILE_SIZE
		);
		const pixels = pixelsOf(padded);
		expect(whiteExtent(pixels, 5, 'row', TILE_SIZE)).toBeCloseTo(PLACEMENT.width + 1, 1);
		expect(whiteExtent(pixels, 5, 'column', TILE_SIZE)).toBeCloseTo(PLACEMENT.height + 1, 1);
		const beyond = (x: number, y: number) => pixels.data[(y * pixels.width + x) * 4 + 3];
		expect(beyond(40, 5)).toBe(0);
		expect(beyond(5, 165)).toBe(0);
	});

	it('leaves an interior tile alone, at exactly the cell size', async () => {
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
