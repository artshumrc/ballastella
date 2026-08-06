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
import { PYRAMID_TILE_SIZE, buildImageInfo, planPyramid, type PlannedTile } from './pyramid.js';
import { streamingTiler, type VipsImage, type VipsModule } from './streaming-tiler.js';

/** Only what these tests need on top of the slice the tiler itself uses. */
type TestImage = VipsImage & {
	invert(): TestImage;
	join(other: VipsImage, direction: string): TestImage;
	avg(): number;
};

type TestVips = VipsModule & {
	Image: VipsModule['Image'] & {
		black(width: number, height: number, options?: { bands?: number }): TestImage;
	};
	/** libvips' own allocation counters, which is how the memory bound below is measured. */
	Stats: { mem(): number; memHighwater(): number };
	Cache: { max(max?: number): void | number };
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

/** 849 × 1200, white across to column `edge` and black to its right, as a JPEG. */
function verticalEdgeImage(edge: number, width = 849, height = 1200): Uint8Array {
	const white = vips.Image.black(edge, height).invert();
	const black = vips.Image.black(width - edge, height);
	const joined = white.join(black, 'horizontal');
	try {
		return new Uint8Array(joined.writeToBuffer('.jpg', { Q: 100 }));
	} finally {
		joined.delete();
		white.delete();
		black.delete();
	}
}

/**
 * Where the white-to-black edge sits in a decoded tile, in output *columns*.
 *
 * The transpose of {@link edgePosition}, and it exists because the two hypotheses about a ragged
 * tile's semantics differ on each axis independently: a tiler that resizes correctly down one
 * axis and by 1 ÷ scaleFactor down the other passes every vertical measurement in this file.
 */
function edgeColumn(jpeg: Uint8Array): number {
	const image = vips.Image.newFromBuffer(jpeg, '', { access: vips.Access.random });
	try {
		let total = 0;
		for (let x = 0; x < image.width; x++) {
			const column = image.crop(x, 0, 1, image.height) as TestImage;
			try {
				total += column.avg() / 255;
			} finally {
				column.delete();
			}
		}
		return total;
	} finally {
		image.delete();
	}
}

/** A solid RGB JPEG. Content is irrelevant to the memory bound; three bands are not. */
function solidRgb(width: number, height: number): Uint8Array {
	const image = vips.Image.black(width, height, { bands: 3 });
	try {
		return new Uint8Array(image.writeToBuffer('.jpg', { Q: 80 }));
	} finally {
		image.delete();
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

	it('resizes a horizontally ragged tile onto exactly its served width', async () => {
		// The transpose of the two tests above, and it is not redundant with them.
		//
		// The committed fixture and every measurement above are 1200 × 851: every region *width* at
		// every scale factor divides by its scale factor, so the fixture has **no horizontally
		// ragged tile at all**, and both edge sweeps move a horizontal edge and measure its vertical
		// position. A tiler that resized correctly down one axis and by 1 ÷ scaleFactor down the
		// other therefore passed the whole file — while stretching the right margin of every real
		// Historical Map by up to 0.6%, which is the defect ticket 03's review identified.
		//
		// 849 × 1200 is ragged horizontally at scale factors 2, 4 and 8, and 849 is chosen over 851
		// because the rounding it leaves is larger: 849 ÷ 8 is 106.125 against a served 107, so the
		// two hypotheses are further apart than the vertical case's 106.375 against 107.
		const edge = 800;
		const jpeg = verticalEdgeImage(edge);
		const source = await streamingTiler(loadVips)(new Blob([jpeg as BlobPart]));

		try {
			const info = buildImageInfo({ imageId: 'floride', width: 849, height: 1200 });
			const tiles = planPyramid(info, 'images/floride');

			const ragged = tiles.filter(
				(tile) =>
					tile.region.x + tile.region.width === 849 &&
					tile.region.width % tile.scaleFactor !== 0 &&
					tile.region.x < edge
			);
			// Ragged at every level but the finest — a region 337 wide at scale factor 2 and 849 wide
			// at 4 and at 8 — and at every row of each, since the edge runs the full height.
			expect(ragged.map((tile) => tile.scaleFactor)).toEqual([2, 2, 2, 4, 4, 8]);

			for (const tile of ragged) {
				const withinRegion = edge - tile.region.x;
				const iiifSemantics = (withinRegion * tile.size.width) / tile.region.width;
				const scaleFactorSemantics = withinRegion / tile.scaleFactor;
				const measured = edgeColumn(await source.encodeTile(tile));
				const label = `scale factor ${tile.scaleFactor} at ${tile.path}`;

				// The two hypotheses really are far enough apart here to be told apart at all: a
				// horizontally ragged tile whose rounding happened to be tiny would assert nothing.
				expect(
					Math.abs(iiifSemantics - scaleFactorSemantics),
					`${label} cannot separate the two semantics`
				).toBeGreaterThan(0.3);
				expect(measured, label).toBeCloseTo(iiifSemantics, 1);
				expect(
					Math.abs(measured - iiifSemantics),
					`${label} reads as a 1 ÷ scaleFactor resize`
				).toBeLessThan(Math.abs(measured - scaleFactorSemantics));
			}
		} finally {
			await source.close();
		}
	}, 180_000);

	it('holds one band of the source, not the whole scan, however tall the scan is', async () => {
		// ADR-0003's entire reason for this tiler: above `STREAMING_TILER_THRESHOLD_PIXELS` the
		// decode path's full-image allocation is what kills the tab, and libvips is here because it
		// does not hold the image. That is a claim about **peak memory**, and nothing in this file
		// measured it — the only fixture is 1200 × 851, whose whole self is 3 MB.
		//
		// It is measured on libvips' own allocation counter rather than inferred, and on two heights
		// of the same width, because "regardless of how large the scan is" is the part that matters:
		// at the coarsest level a pyramid has one tile whose region is the entire image, so a band
		// computed from the *region* is the whole scan and the bound is no bound at all.
		const width = 1024;
		const bytesPerPixel = 3;

		const peakLiveBytes = async (height: number) => {
			const jpeg = solidRgb(width, height);
			const info = buildImageInfo({ imageId: 'm', width, height });
			const tiles = planPyramid(info, 'images/m');
			const source = await streamingTiler(loadVips)(new Blob([jpeg as BlobPart]));
			// `Stats.mem()` is every live tracked allocation in the module, including whatever the
			// other tests in this file are still holding, so what is measured is the **delta**. A
			// first version read the counter absolutely and produced a different number depending on
			// which tests had run before it.
			const baseline = vips.Stats.mem();
			let peak = 0;

			try {
				for (const tile of tiles) {
					await source.encodeTile(tile);
					// Sampled between tiles rather than inside one: whatever the tiler is holding on to
					// across tiles is alive here, which is exactly the allocation being bounded.
					peak = Math.max(peak, vips.Stats.mem() - baseline);
				}
			} finally {
				await source.close();
			}

			return peak;
		};

		// libvips' operation cache would otherwise keep earlier results alive and the counter would
		// be measuring the cache rather than the tiler.
		const cacheMax = vips.Cache.max() as number;
		vips.Cache.max(0);

		let short: number;
		let tall: number;
		try {
			short = await peakLiveBytes(1024);
			tall = await peakLiveBytes(16_384);
		} finally {
			vips.Cache.max(cacheMax);
		}

		const oneBand = width * PYRAMID_TILE_SIZE * bytesPerPixel;
		console.log(
			`streaming tiler peak live tracked memory, ${width} px wide:\n` +
				`  1024 rows  ${(short / 1e6).toFixed(1)} MB (whole image ` +
				`${((width * 1024 * bytesPerPixel) / 1e6).toFixed(1)} MB)\n` +
				`  16384 rows ${(tall / 1e6).toFixed(1)} MB (whole image ` +
				`${((width * 16_384 * bytesPerPixel) / 1e6).toFixed(1)} MB)\n` +
				`  one band   ${(oneBand / 1e6).toFixed(1)} MB`
		);

		// Sixteen times the taller image's tile height, which leaves room for the decoder's own
		// buffers and for libvips' reduction window without leaving room for the whole scan: a band
		// computed from the coarsest region would be 50 MB here against a bound of 12.6.
		expect(tall, 'the streaming tiler is holding more than a band of the source').toBeLessThan(
			oneBand * 16
		);
		// And the number does not grow *with* the scan. Not "does not grow at all": libvips' own
		// reduction window is a function of the scale factor, and a taller image has more levels, so
		// the taller run is legitimately somewhat higher. What must not happen is proportionality —
		// sixteen times the height for sixteen times the memory, which is what holding the whole scan
		// looks like and is exactly what this measured before the band was reduced first.
		expect(tall / short, 'peak memory grows in proportion to the scan').toBeLessThan(4);
	}, 300_000);

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
