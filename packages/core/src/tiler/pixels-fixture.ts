import { expect } from 'vitest';

import { buildImageInfo, planPyramid, type PlannedTile } from './pyramid.js';

declare global {
	interface ImportMeta {
		glob(
			pattern: string,
			options: { query: string; import: string; eager: true }
		): Record<string, string>;
	}
}

export const fixtureTileUrls = import.meta.glob(
	'../../../../apps/editor/static/fixtures/images/floride-1657/**/default.jpg',
	{ query: '?url', import: 'default', eager: true }
);

export const FLORIDE = { width: 1200, height: 851 };

export const fixtureUrlFor = (iiifPath: string): string | undefined => {
	const relative = iiifPath.split('/').slice(-4).join('/');
	return Object.entries(fixtureTileUrls).find(([path]) => path.endsWith(relative))?.[1];
};

export const planFor = (dimensions: { width: number; height: number }) =>
	planPyramid(buildImageInfo({ imageId: 'x', ...dimensions }), 'images/x');

export const raggedTiles = (dimensions: { width: number; height: number }) =>
	planFor(dimensions).filter(
		(tile) =>
			tile.region.width % tile.scaleFactor !== 0 || tile.region.height % tile.scaleFactor !== 0
	);

export type Pixels = { width: number; height: number; data: Uint8ClampedArray };

export const pixelsOf = async (bytes: Uint8Array | Blob): Promise<Pixels> => {
	const blob =
		bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type: 'image/jpeg' });
	const bitmap = await createImageBitmap(blob);
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
	const data = canvas.getContext('2d')!.getImageData(0, 0, bitmap.width, bitmap.height).data;
	bitmap.close();
	return { width: canvas.width, height: canvas.height, data };
};

export const luma = (pixels: Pixels, x: number, y: number): number => {
	const index = (y * pixels.width + x) * 4;
	return (
		0.299 * pixels.data[index]! + 0.587 * pixels.data[index + 1]! + 0.114 * pixels.data[index + 2]!
	);
};

export function contentExtent(pixels: Pixels, axis: 'rows' | 'columns'): number {
	const outer = axis === 'rows' ? pixels.height : pixels.width;
	const inner = axis === 'rows' ? pixels.width : pixels.height;
	let total = 0;
	for (let a = 0; a < outer; a++) {
		let sum = 0;
		for (let b = 0; b < inner; b++) {
			sum += axis === 'rows' ? luma(pixels, b, a) : luma(pixels, a, b);
		}
		total += sum / inner / 255;
	}
	return total;
}

export function uniformRegionCanvas(
	dimensions: { width: number; height: number },
	region: PlannedTile['region']
): OffscreenCanvas {
	const canvas = new OffscreenCanvas(dimensions.width, dimensions.height);
	const context = canvas.getContext('2d')!;
	context.fillStyle = 'black';
	context.fillRect(0, 0, dimensions.width, dimensions.height);
	context.fillStyle = 'white';
	context.fillRect(region.x, region.y, region.width, region.height);
	return canvas;
}

/** A tile cut from {@link uniformRegionCanvas} is white edge to edge, not padded to region ÷ scaleFactor. */
export function expectRaggedTileFilled(pixels: Pixels, tile: PlannedTile): void {
	const rows = contentExtent(pixels, 'rows');
	const columns = contentExtent(pixels, 'columns');
	const label = `${tile.path} (scale factor ${tile.scaleFactor})`;
	expect(rows, label).toBeCloseTo(tile.size.height, 1);
	expect(columns, label).toBeCloseTo(tile.size.width, 1);

	const padded = {
		rows: tile.region.height / tile.scaleFactor,
		columns: tile.region.width / tile.scaleFactor
	};
	if (tile.size.height - padded.rows > 0.15) {
		expect(Math.abs(rows - tile.size.height), label).toBeLessThan(Math.abs(rows - padded.rows) / 3);
	}
	if (tile.size.width - padded.columns > 0.15) {
		expect(Math.abs(columns - tile.size.width), label).toBeLessThan(
			Math.abs(columns - padded.columns) / 3
		);
	}
}
