// The streaming tiler, against real libvips.
//
// It runs in the Node project rather than the browser one, and that is not a convenience: the
// published `wasm-vips` is the **threaded** build, which needs `SharedArrayBuffer` and therefore
// a cross-origin isolated document. Node always has `SharedArrayBuffer`; a browser served from
// GitHub Pages never will, because Pages cannot send COOP/COEP. See the header comment of
// `streaming-tiler.ts` for the measurement and what it blocks.
//
// What this file is for is the half that does not depend on where it runs: that the streaming
// tiler writes the same paths and the same tile geometry as the plan every other consumer uses,
// and that its ragged tiles obey IIIF `size=w,h` semantics rather than scaling by 1 / scaleFactor
// and padding.

import { beforeAll, describe, expect, it } from 'vitest';

import { readImageHeader } from './image-header.js';
import { buildImageInfo, planPyramid, type PlannedTile } from './pyramid.js';
import { streamingTiler, type VipsImage, type VipsModule } from './streaming-tiler.js';

/** Only what these tests need on top of the slice the tiler itself uses. */
type TestImage = VipsImage & {
	invert(): TestImage;
	join(other: VipsImage, direction: string): TestImage;
	avg(): number;
};

type TestVips = VipsModule & {
	Image: VipsModule['Image'] & { black(width: number, height: number): TestImage };
};

let vips: TestVips;

const loadVips = async () => vips;

/** 1200 × 851, white down to row `edge` and black below it, as a JPEG. */
function edgeImage(edge: number, width = 1200, height = 851): Uint8Array {
	const white = vips.Image.black(width, edge).invert();
	const black = vips.Image.black(width, height - edge);
	const joined = white.join(black, 'vertical');
	try {
		// Quality 100 so that the assertions below measure the tiler's geometry rather than the
		// encoder's ringing. The tiler's own output stays at the shared TILE_JPEG_QUALITY.
		return new Uint8Array(joined.writeToBuffer('.jpg', { Q: 100 }));
	} finally {
		joined.delete();
		white.delete();
		black.delete();
	}
}

/**
 * Where the white-to-black edge sits in a decoded tile, in output rows, to sub-pixel precision.
 *
 * The sum of every row's mean brightness is the number of white-equivalent rows, and therefore
 * the edge's position measured from the top. It is the right statistic here because it survives
 * the resampling kernel and the JPEG: a normalised kernel preserves the total, and a partly
 * covered row contributes exactly its coverage.
 */
function edgePosition(jpeg: Uint8Array): number {
	const image = vips.Image.newFromBuffer(jpeg, '', { access: vips.Access.random });
	try {
		let total = 0;
		for (let y = 0; y < image.height; y++) {
			const row = image.crop(0, y, image.width, 1) as TestImage;
			try {
				total += row.avg() / 255;
			} finally {
				row.delete();
			}
		}
		return total;
	} finally {
		image.delete();
	}
}

beforeAll(async () => {
	const Vips = (await import('wasm-vips')).default;
	vips = (await Vips({ dynamicLibraries: [] })) as unknown as TestVips;
}, 120_000);

describe('streamingTiler', () => {
	it('writes exactly the paths and tile geometry the plan describes', async () => {
		const jpeg = edgeImage(700);
		const source = await streamingTiler(loadVips)(new Blob([jpeg as BlobPart]));

		try {
			expect(source.dimensions).toEqual({ width: 1200, height: 851 });

			const info = buildImageInfo({ imageId: 'floride', width: 1200, height: 851 });
			const tiles = planPyramid(info, 'images/floride');
			expect(tiles).toHaveLength(29);

			for (const tile of tiles) {
				const bytes = await source.encodeTile(tile);
				// The bytes' own dimensions, read from the JPEG frame header. A tile whose pixels
				// disagree with its own URL is unreadable by every IIIF client, this app included, and
				// no assertion about regions would catch it.
				expect(readImageHeader(bytes), tile.path).toEqual({
					width: tile.size.width,
					height: tile.size.height,
					format: 'jpeg'
				});
			}
		} finally {
			await source.close();
		}
	}, 180_000);

	it('resizes a ragged tile onto exactly its served size, not by 1 ÷ scaleFactor', async () => {
		// The forward contract from ticket 03's review, asserted rather than inherited.
		//
		// The coarsest tile covers the whole 1200 × 851 image and is served at 150 × 107. 851 ÷ 8 is
		// 106.375, so the two candidate semantics put the same edge in measurably different places:
		//
		//   IIIF size=w,h  — the region's full extent onto the file's full extent: 800 × 107/851
		//   1 ÷ scaleFactor — content occupying 106.375 rows, remainder padded: 800 ÷ 8
		//
		// 0.59 of a row apart, which is exactly the 0.6% margin error the reviewer warned about,
		// and far above this measurement's noise.
		const edge = 700;
		const jpeg = edgeImage(edge);
		const source = await streamingTiler(loadVips)(new Blob([jpeg as BlobPart]));

		try {
			const info = buildImageInfo({ imageId: 'floride', width: 1200, height: 851 });
			const coarsest = planPyramid(info, 'images/floride').find(
				(tile) => tile.scaleFactor === 8
			) as PlannedTile;
			expect(coarsest.size).toEqual({ width: 150, height: 107 });

			const measured = edgePosition(await source.encodeTile(coarsest));
			const iiifSemantics = (edge * coarsest.size.height) / coarsest.region.height;
			const scaleFactorSemantics = edge / coarsest.scaleFactor;

			expect(iiifSemantics).toBeCloseTo(88.017, 2);
			expect(scaleFactorSemantics).toBeCloseTo(87.5, 2);
			expect(measured).toBeCloseTo(iiifSemantics, 1);
			expect(Math.abs(measured - scaleFactorSemantics)).toBeGreaterThan(0.3);
		} finally {
			await source.close();
		}
	}, 180_000);

	it('holds for every ragged level, not only the coarsest', async () => {
		const edge = 800;
		const jpeg = edgeImage(edge);
		const source = await streamingTiler(loadVips)(new Blob([jpeg as BlobPart]));

		try {
			const info = buildImageInfo({ imageId: 'floride', width: 1200, height: 851 });
			const tiles = planPyramid(info, 'images/floride');

			// Every tile whose region reaches the bottom margin and does not divide by its scale
			// factor: the ones where the two semantics differ at all.
			const ragged = tiles.filter(
				(tile) =>
					tile.region.y + tile.region.height === 851 &&
					tile.region.height % tile.scaleFactor !== 0 &&
					tile.region.y < edge
			);
			expect(ragged.length).toBeGreaterThan(0);

			for (const tile of ragged) {
				const withinRegion = edge - tile.region.y;
				const expected = (withinRegion * tile.size.height) / tile.region.height;
				const measured = edgePosition(await source.encodeTile(tile));
				expect(measured, `scale factor ${tile.scaleFactor} at ${tile.path}`).toBeCloseTo(
					expected,
					1
				);
			}
		} finally {
			await source.close();
		}
	}, 180_000);

	it('refuses to write a tile whose pixels disagree with its own URL', async () => {
		const jpeg = edgeImage(400);
		const source = await streamingTiler(loadVips)(new Blob([jpeg as BlobPart]));

		try {
			await expect(
				source.encodeTile({
					scaleFactor: 1,
					column: 0,
					row: 0,
					region: { x: 0, y: 0, width: 256, height: 256 },
					// A size no rounding of the region produces. The guard is what stops a change in
					// libvips' rounding from silently producing an unreadable pyramid.
					size: { width: 0, height: 0 },
					path: 'images/x/0,0,256,256/0,0/0/default.jpg'
				})
			).rejects.toThrow();
		} finally {
			await source.close();
		}
	}, 120_000);
});
