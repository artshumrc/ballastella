// The decode-and-crop tiler, in real browsers, on real pixels.
//
// It runs in Chromium and Firefox, like the ProjectStore adapter suite, and for the same kind of
// reason: `createImageBitmap`, `OffscreenCanvas` and `convertToBlob` do not exist in Node, and a
// stub of them would only prove the stub agrees with itself. The two engines also disagree about
// resampling in ways that matter here — see the header comment of `decode-and-crop-tiler.ts`.
//
// ## How the resize contract is asserted, and why not by absolute pixel positions
//
// The property under test is IIIF Image API 3.0 `size=w,h`: a tile's bytes are the whole region
// resized onto exactly `w` × `h`, **not** the region scaled by 1 / scaleFactor with the leftover
// fraction padded. For the coarsest tile of a 1200 × 851 image the two differ by half a pixel at
// the bottom margin — 0.6% — which ticket 03's `ImagePaneTile.placement` depends on and no
// assertion about coordinates can see.
//
// Measuring the absolute position of a feature inside a tile turns out not to separate the two
// hypotheses cleanly: each engine's resampler carries its own sub-pixel sampling offset (fitted
// over an edge sweep: Chromium 151 maps a 177-pixel region onto 89 pixels with slope 0.50418 and
// intercept −0.12, Firefox 153 with slope 0.50255 and intercept +0.02, against 89/177 = 0.50282),
// and JPEG's ringing clips asymmetrically against black and white. Two statistics do separate
// them, and both are used below:
//
// - **Extent.** A region of one uniform colour, with a contrasting surround *outside* it, must
//   come out as a tile every pixel of which is that colour. Under `size=w,h` the content covers
//   all `w` × `h`; under 1 / scaleFactor plus padding the last row and column are a blend with
//   whatever the padding is — half a pixel of content missing, which is the whole disagreement.
//   It also catches a resize that sampled outside its own region.
// - **Slope.** Sweeping an edge across the region and fitting output position against source
//   position removes each engine's constant offset, leaving the scale. It must be nearer
//   `size ÷ region` than `1 ÷ scaleFactor`.

import { beforeAll, describe, expect, it } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import { openDecodeAndCropSource } from './decode-and-crop-tiler.js';
import { ingestImageFile } from './ingest.js';
import { buildImageInfo, planPyramid, type PlannedTile } from './pyramid.js';

// `import.meta.glob` is Vite's, and its types live in `vite/client`, which this package cannot
// reach: `vite` is a transitive dependency of vitest here, not a declared one. Declaring the one
// member used is smaller than adding a dependency to a shared manifest for a type.
declare global {
	interface ImportMeta {
		glob(
			pattern: string,
			options: { query: string; import: string; eager: true }
		): Record<string, string>;
	}
}

/** The committed fixture pyramid, as the browser fetches it. */
const fixtureTileUrls = import.meta.glob(
	'../../../../apps/editor/static/fixtures/images/floride-1657/**/default.jpg',
	{ query: '?url', import: 'default', eager: true }
) as Record<string, string>;

const FLORIDE = { width: 1200, height: 851 };

type Pixels = { width: number; height: number; data: Uint8ClampedArray };

const pixelsOf = async (bytes: Uint8Array | Blob): Promise<Pixels> => {
	const blob =
		bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart], { type: 'image/jpeg' });
	const bitmap = await createImageBitmap(blob);
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
	const data = canvas.getContext('2d')!.getImageData(0, 0, bitmap.width, bitmap.height).data;
	bitmap.close();
	return { width: canvas.width, height: canvas.height, data };
};

const luma = (pixels: Pixels, x: number, y: number): number => {
	const index = (y * pixels.width + x) * 4;
	return (
		0.299 * pixels.data[index]! + 0.587 * pixels.data[index + 1]! + 0.114 * pixels.data[index + 2]!
	);
};

/**
 * A source image with a black surround and a white rectangle covering exactly `region`.
 *
 * The surround is what makes this an assertion about the region and not only about padding: a
 * resize that reached outside its own crop rect would darken the tile's margins.
 */
async function uniformRegionImage(
	width: number,
	height: number,
	region: { x: number; y: number; width: number; height: number }
): Promise<Blob> {
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext('2d')!;
	context.fillStyle = 'black';
	context.fillRect(0, 0, width, height);
	context.fillStyle = 'white';
	context.fillRect(region.x, region.y, region.width, region.height);
	return canvas.convertToBlob({ type: 'image/png' });
}

/** A source with a white-to-black edge across it, at `edge`, along `axis`. */
async function edgeImage(
	width: number,
	height: number,
	edge: number,
	axis: 'rows' | 'columns'
): Promise<Blob> {
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext('2d')!;
	context.fillStyle = 'white';
	context.fillRect(0, 0, width, height);
	context.fillStyle = 'black';
	if (axis === 'rows') context.fillRect(0, edge, width, height - edge);
	else context.fillRect(edge, 0, width - edge, height);
	return canvas.convertToBlob({ type: 'image/png' });
}

/**
 * How many rows (or columns) of content a tile holds, to sub-pixel precision: the sum of each
 * row's mean brightness, normalised. For a uniform white region this is the extent the region's
 * pixels actually cover, and it is an integral, so it is unaffected by sampling offsets.
 */
function contentExtent(pixels: Pixels, axis: 'rows' | 'columns'): number {
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

/** Least-squares slope of `points`. */
function slopeOf(points: [number, number][]): number {
	const n = points.length;
	const sx = points.reduce((sum, [x]) => sum + x, 0);
	const sy = points.reduce((sum, [, y]) => sum + y, 0);
	const sxx = points.reduce((sum, [x]) => sum + x * x, 0);
	const sxy = points.reduce((sum, [x, y]) => sum + x * y, 0);
	return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}

const planFor = (dimensions: { width: number; height: number }) =>
	planPyramid(buildImageInfo({ imageId: 'x', ...dimensions }), 'images/x');

describe('openDecodeAndCropSource', () => {
	it('reports the decoded image dimensions', async () => {
		const source = await openDecodeAndCropSource(
			await edgeImage(FLORIDE.width, FLORIDE.height, 400, 'rows')
		);
		try {
			expect(source.dimensions).toEqual(FLORIDE);
		} finally {
			await source.close();
		}
	});

	it('writes every tile at exactly the size its own URL claims', async () => {
		const source = await openDecodeAndCropSource(
			await edgeImage(FLORIDE.width, FLORIDE.height, 400, 'rows')
		);
		try {
			const tiles = planFor(FLORIDE);
			expect(tiles).toHaveLength(29);

			for (const tile of tiles) {
				const decoded = await pixelsOf(await source.encodeTile(tile));
				expect({ width: decoded.width, height: decoded.height }, tile.path).toEqual({
					width: tile.size.width,
					height: tile.size.height
				});
			}
		} finally {
			await source.close();
		}
	});

	it('fills a ragged tile completely — no half pixel of padding at the margins', async () => {
		// 1201 × 851 is ragged in both directions at every scale factor: 1201 − 4×256 = 177 and
		// 851 − 3×256 = 83, neither of which divides by 2, 4 or 8. The committed fixture is ragged
		// only vertically, so nothing else here covers the right-hand margin.
		const dimensions = { width: 1201, height: 851 };
		const tiles = planFor(dimensions);
		const ragged = tiles.filter(
			(tile) =>
				tile.region.width % tile.scaleFactor !== 0 || tile.region.height % tile.scaleFactor !== 0
		);
		expect(ragged.length).toBeGreaterThan(3);

		for (const tile of ragged) {
			const source = await openDecodeAndCropSource(
				await uniformRegionImage(dimensions.width, dimensions.height, tile.region)
			);
			try {
				const pixels = await pixelsOf(await source.encodeTile(tile));
				const rows = contentExtent(pixels, 'rows');
				const columns = contentExtent(pixels, 'columns');
				const label = `${tile.path} (scale factor ${tile.scaleFactor})`;

				// Under IIIF size=w,h the region covers the whole tile.
				expect(rows, label).toBeCloseTo(tile.size.height, 1);
				expect(columns, label).toBeCloseTo(tile.size.width, 1);

				// Under a 1 ÷ scaleFactor resize with the remainder padded it would cover
				// region ÷ scaleFactor instead. How far apart the two are is `ceil(x) − x` for that
				// tile — anything from 0.25 of a pixel to 0.875 here — so the assertion is that the
				// measurement lands nearer the served size than the padded one by a wide margin,
				// rather than a fixed distance that would be wrong for one tile or another.
				const padded = {
					rows: tile.region.height / tile.scaleFactor,
					columns: tile.region.width / tile.scaleFactor
				};
				if (tile.size.height - padded.rows > 0.15) {
					expect(Math.abs(rows - tile.size.height), label).toBeLessThan(
						Math.abs(rows - padded.rows) / 3
					);
				}
				if (tile.size.width - padded.columns > 0.15) {
					expect(Math.abs(columns - tile.size.width), label).toBeLessThan(
						Math.abs(columns - padded.columns) / 3
					);
				}
			} finally {
				await source.close();
			}
		}
	});

	it('maps the region onto the tile at size ÷ region, not at 1 ÷ scaleFactor', async () => {
		// The interior of the mapping, not only its extent: a tiler could fill the tile and still be
		// non-linear inside it. Fitting a slope over an edge sweep removes each engine's constant
		// sampling offset, which is what made an absolute-position assertion useless here.
		const dimensions = { width: 1201, height: 851 };
		const coarsest = planFor(dimensions).find((tile) => tile.scaleFactor === 8) as PlannedTile;
		expect(coarsest.region).toEqual({ x: 0, y: 0, width: 1201, height: 851 });
		expect(coarsest.size).toEqual({ width: 151, height: 107 });

		for (const axis of ['rows', 'columns'] as const) {
			const extent = axis === 'rows' ? coarsest.region.height : coarsest.region.width;
			const served = axis === 'rows' ? coarsest.size.height : coarsest.size.width;
			const points: [number, number][] = [];

			for (let edge = 100; edge <= extent - 100; edge += Math.floor((extent - 200) / 8)) {
				const source = await openDecodeAndCropSource(
					await edgeImage(dimensions.width, dimensions.height, edge, axis)
				);
				try {
					points.push([
						edge,
						contentExtent(await pixelsOf(await source.encodeTile(coarsest)), axis)
					]);
				} finally {
					await source.close();
				}
			}

			const slope = slopeOf(points);
			const iiif = served / extent;
			const perScaleFactor = 1 / coarsest.scaleFactor;

			expect(Math.abs(slope - iiif), `${axis}: slope ${slope}`).toBeLessThan(
				Math.abs(slope - perScaleFactor) / 2
			);
			expect(Math.abs(slope - iiif) / iiif, `${axis}: slope ${slope}`).toBeLessThan(0.005);
		}
	});
});

describe('the pyramid this tiler writes, against the committed fixture', () => {
	let reconstructed: Blob;
	let sourcePixels: Pixels;

	beforeAll(async () => {
		// The fixture is a pyramid, not a source image, so the source is rebuilt from its 20
		// scale-factor-1 tiles — which between them are the full-resolution image. That is one extra
		// JPEG generation, which is why what follows compares statistics rather than bytes.
		const canvas = new OffscreenCanvas(FLORIDE.width, FLORIDE.height);
		const context = canvas.getContext('2d')!;

		for (const [path, url] of Object.entries(fixtureTileUrls)) {
			const [region, size] = path.split('/').slice(-4, -2);
			const [x, y, width, height] = region!.split(',').map(Number);
			const [servedWidth, servedHeight] = size!.split(',').map(Number);
			if (width !== servedWidth || height !== servedHeight) continue;
			const bitmap = await createImageBitmap(await (await fetch(url)).blob());
			context.drawImage(bitmap, x!, y!);
			bitmap.close();
		}

		reconstructed = await canvas.convertToBlob({ type: 'image/png' });
		sourcePixels = await pixelsOf(reconstructed);
	});

	const committedUrl = (tile: PlannedTile): string => {
		const relative = tile.path.split('/').slice(-4).join('/');
		const found = Object.entries(fixtureTileUrls).find(([path]) => path.endsWith(relative));
		if (!found) throw new Error(`the fixture has no ${relative}`);
		return found[1];
	};

	it('found the fixture', () => {
		expect(Object.keys(fixtureTileUrls)).toHaveLength(29);
	});

	it('writes the same 29 paths', async () => {
		const store = new MemoryProjectStore();
		const result = await ingestImageFile({
			store,
			projectDirectory: 'p',
			file: reconstructed,
			label: 'floride-1657',
			openDecodeAndCrop: openDecodeAndCropSource
		});

		const written = (await store.list(`${result.directory}/`))
			.filter((path) => path.endsWith('/default.jpg'))
			.map((path) => path.slice(`${result.directory}/`.length))
			.sort();

		const committed = Object.keys(fixtureTileUrls)
			.map((path) => path.split('/').slice(-4).join('/'))
			.sort();

		expect(written).toEqual(committed);
	});

	it('reproduces the committed full-resolution tiles', async () => {
		// Scale factor 1 involves no resampling at all, so these should be a JPEG generation apart
		// and nothing else. It is what proves the regions, their order, and their orientation.
		const source = await openDecodeAndCropSource(reconstructed);
		try {
			for (const tile of planFor(FLORIDE).filter((tile) => tile.scaleFactor === 1)) {
				const mine = await pixelsOf(await source.encodeTile(tile));
				const theirs = await pixelsOf(
					new Uint8Array(await (await fetch(committedUrl(tile))).arrayBuffer())
				);
				let squared = 0;
				for (let index = 0; index < mine.data.length; index += 4) {
					for (let channel = 0; channel < 3; channel++) {
						const difference = mine.data[index + channel]! - theirs.data[index + channel]!;
						squared += difference * difference;
					}
				}
				expect(squared / ((mine.data.length / 4) * 3), tile.path).toBeLessThan(30);
			}
		} finally {
			await source.close();
		}
	});

	it('agrees with the committed ragged tiles on IIIF semantics, and not on the alternative', async () => {
		// The reviewer of ticket 03 established the fixture's semantics by decoding all 29 tiles; this
		// re-establishes it from the tiler's side, and it is the assertion that would fail if a later
		// change made ragged tiles a 1 ÷ scaleFactor resize.
		//
		// The statistic is the committed tile's per-row mean brightness against the mean brightness
		// of the source rows each output row would be drawn from under each hypothesis. It compares
		// one dimension of a profile rather than pixels, so it does not depend on which resampler
		// made the fixture — which is what makes it able to separate a 0.6% difference at all.
		const ragged = planFor(FLORIDE).filter(
			(tile) => tile.scaleFactor > 1 && tile.region.height % tile.scaleFactor !== 0
		);
		expect(ragged.length).toBeGreaterThan(3);

		/** Mean brightness of source rows [from, to), area-weighted for fractional ends. */
		const sourceBand = (x: number, width: number, from: number, to: number): number => {
			let sum = 0;
			let weight = 0;
			for (let y = Math.floor(from); y < Math.min(FLORIDE.height, Math.ceil(to)); y++) {
				const coverage = Math.min(y + 1, to) - Math.max(y, from);
				if (coverage <= 0) continue;
				let row = 0;
				for (let column = x; column < x + width; column++) row += luma(sourcePixels, column, y);
				sum += (row / width) * coverage;
				weight += coverage;
			}
			return weight > 0 ? sum / weight : Number.NaN;
		};

		for (const tile of ragged) {
			const committed = await pixelsOf(
				new Uint8Array(await (await fetch(committedUrl(tile))).arrayBuffer())
			);

			let iiifError = 0;
			let perScaleFactorError = 0;

			for (let row = 0; row < committed.height; row++) {
				let actual = 0;
				for (let column = 0; column < committed.width; column++) {
					actual += luma(committed, column, row);
				}
				actual /= committed.width;

				// IIIF size=w,h: output row r covers region rows [r, r+1) × region ÷ served.
				const iiif = sourceBand(
					tile.region.x,
					tile.region.width,
					tile.region.y + (row * tile.region.height) / committed.height,
					tile.region.y + ((row + 1) * tile.region.height) / committed.height
				);
				// 1 ÷ scaleFactor: output row r covers exactly scaleFactor source rows, and the last
				// row of the tile is only fractionally covered.
				const perScaleFactor = sourceBand(
					tile.region.x,
					tile.region.width,
					tile.region.y + row * tile.scaleFactor,
					Math.min(tile.region.y + tile.region.height, tile.region.y + (row + 1) * tile.scaleFactor)
				);

				iiifError += (iiif - actual) ** 2;
				perScaleFactorError += (perScaleFactor - actual) ** 2;
			}

			expect(
				iiifError,
				`${tile.path}: IIIF ${(iiifError / committed.height).toFixed(1)} vs ` +
					`1/scaleFactor ${(perScaleFactorError / committed.height).toFixed(1)}`
			).toBeLessThan(perScaleFactorError / 2);
		}
	});
});
