// Making an offline copy, in real browsers, on the pixels of a real 1657 chart.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS FOR, AND WHY IT IS NOT THE NODE TESTS AGAIN
//
// `offline-copy.test.ts` asserts the *job*: which path, how many requests, what is written, what is
// refused. It cannot assert the one claim this ticket makes that matters most, because the claim is
// about pixels: **an offline copy's pyramid honours IIIF's exact-resize semantics the way ticket 05's tiler
// does, so ticket 03's `placement = region ÷ scaleFactor` is the right number for it.**
//
// Ticket 14 could only check the checkable half of that against a stranger's server — a ragged probe
// tile's decoded dimensions must equal what was asked for — and had to tolerate the undetectable half:
// a server returning the right dimensions having padded rather than resized within them, bounded at
// 0.6% of one tile along two margins. Its own note says an offline copy removes that outright. This is
// where "removes it" stops being a claim.
//
// The fixture is `apps/editor/static/fixtures/images/floride-1657`, which is a **level-0 service** —
// `profile: "level0"`, no ability to serve anything it did not pre-cut — so it drives the expensive
// path of ADR-0007 with real bytes, and it is a real engraved chart rather than a gradient, which is
// what makes the resampling statistics below able to separate 0.6%.
//
// The two statistics are ticket 05's, deliberately: `decode-and-crop-tiler.browser.test.ts` explains
// at length why absolute pixel positions cannot separate the two hypotheses (each engine's resampler
// carries its own sub-pixel sampling offset) and why extent and a per-row profile comparison can.
// Using the same two here is what makes "the same way ticket 05's tiler does" a comparison rather than
// a form of words.

import { beforeAll, describe, expect, it } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import { openDecodeAndCropSource } from '../tiler/decode-and-crop-tiler.js';
import { ingestImageFile } from '../tiler/ingest.js';
import { buildImageInfo, planPyramid, type PlannedTile } from '../tiler/pyramid.js';
import { acceptRemoteImageService, type RemoteImageService } from './image-service.js';
import { OfflineCopyRefusedError, assembleWithCanvas, makeOfflineCopy, planOfflineCopy } from './offline-copy.js';

declare global {
	interface ImportMeta {
		glob(
			pattern: string,
			options: { query: string; import: string; eager: true }
		): Record<string, string>;
	}
}

const fixtureTileUrls = import.meta.glob(
	'../../../../apps/editor/static/fixtures/images/floride-1657/**/default.jpg',
	{ query: '?url', import: 'default', eager: true }
) as Record<string, string>;

const FLORIDE = { width: 1200, height: 851 };
const SERVICE_URI = 'https://library.test/iiif/floride-1657';

/** The fixture's own `info.json`, re-homed on a host so it describes a remote service. */
const fixtureInfo = {
	'@context': 'http://iiif.io/api/image/3/context.json',
	id: SERVICE_URI,
	type: 'ImageService3',
	protocol: 'http://iiif.io/api/image',
	profile: 'level0',
	width: FLORIDE.width,
	height: FLORIDE.height,
	tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4, 8] }]
};

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

/** How many rows (or columns) of content a tile holds, to sub-pixel precision. Ticket 05's statistic. */
function contentExtent(pixels: Pixels, axis: 'rows' | 'columns'): number {
	const outer = axis === 'rows' ? pixels.height : pixels.width;
	const inner = axis === 'rows' ? pixels.width : pixels.height;
	let total = 0;
	for (let a = 0; a < outer; a++) {
		let sum = 0;
		for (let b = 0; b < inner; b++)
			sum += axis === 'rows' ? luma(pixels, b, a) : luma(pixels, a, b);
		total += sum / inner / 255;
	}
	return total;
}

/** The bundled URL of one fixture tile, found by its IIIF path. */
function fixtureUrlFor(iiifPath: string): string | undefined {
	const relative = iiifPath.split('/').slice(-4).join('/');
	return Object.entries(fixtureTileUrls).find(([path]) => path.endsWith(relative))?.[1];
}

/** A host that serves the committed fixture pyramid, and nothing else. */
function fixtureHost(): { fetch: FetchFn; requested: string[] } {
	const requested: string[] = [];
	const fetch: FetchFn = async (input) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		requested.push(url);
		const bundled = fixtureUrlFor(new URL(url).pathname);
		if (!bundled) return new Response('no such tile', { status: 404 });
		return new Response(await (await globalThis.fetch(bundled)).blob(), {
			status: 200,
			headers: { 'content-type': 'image/jpeg' }
		});
	};
	return { fetch, requested };
}

const planFor = (dimensions: { width: number; height: number }) =>
	planPyramid(buildImageInfo({ imageId: 'x', ...dimensions }), 'images/x');

let service: RemoteImageService;

beforeAll(async () => {
	service = await acceptRemoteImageService(fixtureInfo, {
		requestedUrl: `${SERVICE_URI}/info.json`,
		fallbackUri: SERVICE_URI
	});
});

describe('assembleWithCanvas', () => {
	it('puts the pieces back exactly where they came from', async () => {
		// A source cut into its own tiles and stitched back together must be the source again. 1:1
		// everywhere, so there is no resampling anywhere in this and the comparison can be strict.
		const dimensions = { width: 700, height: 500 };
		const original = new OffscreenCanvas(dimensions.width, dimensions.height);
		const context = original.getContext('2d')!;
		for (let y = 0; y < dimensions.height; y += 25) {
			for (let x = 0; x < dimensions.width; x += 25) {
				context.fillStyle = `rgb(${(x * 7) % 256} ${(y * 11) % 256} ${(x + y) % 256})`;
				context.fillRect(x, y, 25, 25);
			}
		}
		const originalPixels = await pixelsOf(await original.convertToBlob({ type: 'image/png' }));

		const pieces = [];
		for (const tile of planFor(dimensions).filter((tile) => tile.scaleFactor === 1)) {
			const crop = new OffscreenCanvas(tile.region.width, tile.region.height);
			crop
				.getContext('2d')!
				.drawImage(
					original,
					tile.region.x,
					tile.region.y,
					tile.region.width,
					tile.region.height,
					0,
					0,
					tile.region.width,
					tile.region.height
				);
			pieces.push({
				url: tile.path,
				region: tile.region,
				bytes: await crop.convertToBlob({ type: 'image/png' })
			});
		}
		expect(pieces).toHaveLength(6);

		const stitched = await pixelsOf(await assembleWithCanvas(dimensions, pieces));

		expect({ width: stitched.width, height: stitched.height }).toEqual(dimensions);
		let worst = 0;
		for (let index = 0; index < originalPixels.data.length; index++) {
			worst = Math.max(worst, Math.abs(originalPixels.data[index]! - stitched.data[index]!));
		}
		expect(worst).toBe(0);
	});

	it('refuses a piece that is not the size its region says it is', async () => {
		// The exact-resize check applied to every piece rather than to one probe tile. A piece drawn at a
		// size it was not served at shifts everything to the right of it, which is a misplaced map rather
		// than a broken one.
		const wrong = new OffscreenCanvas(100, 100);
		wrong.getContext('2d')!.fillRect(0, 0, 100, 100);

		await expect(
			assembleWithCanvas({ width: 512, height: 256 }, [
				{
					url: 'https://library.test/iiif/x/0,0,256,256/256,256/0/default.jpg',
					region: { x: 0, y: 0, width: 256, height: 256 },
					bytes: await wrong.convertToBlob({ type: 'image/png' })
				}
			])
		).rejects.toThrow(/arrived as 100×100/);
	});
});

describe('a level-0 remote service, copied end to end', () => {
	let store: MemoryProjectStore;
	let requested: string[];
	let directory: string;
	/** The stitched source, as the real `assembleWithCanvas` produced it inside the copy. */
	let stitched: Blob;

	beforeAll(async () => {
		expect(Object.keys(fixtureTileUrls)).toHaveLength(29);
		store = new MemoryProjectStore();
		const host = fixtureHost();
		requested = host.requested;

		const result = await makeOfflineCopy({
			store,
			service,
			label: 'floride-1657',
			fetch: host.fetch,
			// Wrapped only to keep the stitched image for the assertions below. The copy uses the real one.
			assemble: async (dimensions, pieces) => {
				stitched = await assembleWithCanvas(dimensions, pieces);
				return stitched;
			},
			openDecodeAndCrop: openDecodeAndCropSource
		});

		directory = result.ingest.directory;
		expect(result.path).toBe('assembled');
	});

	it('asked the host only for its full-resolution tiles, one each', async () => {
		// ADR-0007's expensive case, and the number is the politeness obligation: 1200×851 at 256-pixel
		// tiles is 5 columns by 4 rows.
		expect(requested).toHaveLength(20);
		expect(new Set(requested).size).toBe(20);
		for (const url of requested) expect(url).toMatch(/\/(\d+),(\d+),(\d+),(\d+)\/\3,\4\/0\//);
	});

	it('wrote the 29 files a locally ingested image has, and nothing else', async () => {
		const written = (await store.list(`${directory}/`))
			.map((path) => path.slice(`${directory}/`.length))
			.sort();

		expect(written.filter((path) => path.endsWith('/default.jpg'))).toHaveLength(29);
		expect(written).toContain('info.json');
		expect(written).toContain('manifest.json');
		expect(written).toHaveLength(31);
	});

	it('kept generateId(uri) as the image id and the placeholder as the pyramid id', async () => {
		expect(directory).toBe(`images/${service.imageId}`);
		const info = JSON.parse(new TextDecoder().decode(await store.read(`${directory}/info.json`)));
		expect(info.id).toBe(`https://unset.invalid/${service.imageId}`);
		expect(info.profile).toBe('level0');
		expect(JSON.stringify(info)).not.toContain('library.test');
	});

	it('serves every tile at exactly the size its own URL claims', async () => {
		// The half of exact-resize that is checkable by measurement alone, on every tile of the pyramid
		// rather than on one probe. `placement` is `region ÷ scaleFactor`, which is only the right number
		// if the file's extent is the region's extent.
		for (const tile of planFor(FLORIDE)) {
			const path = `${directory}/${tile.path.split('/').slice(-4).join('/')}`;
			const decoded = await pixelsOf(await store.read(path));
			expect({ width: decoded.width, height: decoded.height }, path).toEqual(tile.size);
		}
	});

	it('is byte-identical to what ticket 05 writes for the same source', async () => {
		// "The output must be indistinguishable from a locally ingested image, so nothing downstream
		// needs to know how a pyramid arrived." Not similar, and not merely the same geometry: the same
		// bytes, because it is the same tiler over the same pixels. The only difference between the two
		// stores is the image id, which differs by design.
		const local = new MemoryProjectStore();
		const ingested = await ingestImageFile({
			store: local,
			file: stitched,
			label: 'floride-1657',
			openDecodeAndCrop: openDecodeAndCropSource
		});

		const copiedPaths = await store.list(`${directory}/`);
		expect(copiedPaths).toHaveLength(31);

		for (const path of copiedPaths) {
			if (path.endsWith('/info.json') || path.endsWith('/manifest.json')) continue;
			const mine = await store.read(path);
			const theirs = await local.read(
				path.replace(`images/${service.imageId}/`, `images/${ingested.imageId}/`)
			);
			expect([...mine], path).toEqual([...theirs]);
		}
	});
});

describe('IIIF exact-resize, in a pyramid that arrived by being copied', () => {
	// **The claim of this ticket, asserted directly rather than inherited.**
	//
	// `ImagePaneTile.placement` is `region ÷ scaleFactor`, which is right only under IIIF's semantics
	// for `size=w,h`: the file's full extent is the region's full extent, so a 851-pixel region at scale
	// factor 8 becomes 106.375 pixels' worth of content inside a 107-pixel file. A tiler that resized by
	// 1 ÷ scaleFactor and padded the remainder instead would stretch every ragged tile by up to 0.6% at
	// the right and bottom margins of every Historical Map — sub-pixel, systematic, in the margins.
	//
	// Ticket 14 can only check the checkable half of this against a stranger's server and has to
	// tolerate the rest. Here the whole copy is driven end to end — a level-0 host cutting 1:1 tiles,
	// the real `assembleWithCanvas`, the real tiler — and the property is measured on what came out.
	//
	// The statistic is ticket 05's **extent** measure and deliberately not its per-row profile measure.
	// The profile one did not transfer: at scale factor 4 on a 1200-wide chart it prefers the wrong
	// hypothesis, because each engine's resampler carries a constant sub-pixel sampling offset (ticket
	// 05 measures −0.12 output pixels in Chromium) and over 213 output rows that offset is larger than
	// the 0-to-1 source row the two hypotheses differ by. Extent is an integral over the whole tile, so
	// a constant offset cannot bias it — which is exactly why it separates half a pixel.

	const dimensions = { width: 1201, height: 851 };

	/**
	 * A source with a black surround and a white rectangle covering exactly `region`.
	 *
	 * The surround is what makes this an assertion about the region rather than only about padding: a
	 * resize that reached outside its own crop rect would darken the tile's margins.
	 */
	async function uniformRegionImage(region: PlannedTile['region']): Promise<OffscreenCanvas> {
		const canvas = new OffscreenCanvas(dimensions.width, dimensions.height);
		const context = canvas.getContext('2d')!;
		context.fillStyle = 'black';
		context.fillRect(0, 0, dimensions.width, dimensions.height);
		context.fillStyle = 'white';
		context.fillRect(region.x, region.y, region.width, region.height);
		return canvas;
	}

	/** A level-0 host that cuts `source` into the 1:1 tiles a static pyramid would have. */
	function hostFor(source: OffscreenCanvas): FetchFn {
		return async (input) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			const match = /\/(\d+),(\d+),(\d+),(\d+)\/(\d+),(\d+)\/0\/default\.jpg$/.exec(url);
			if (!match) return new Response('no such tile', { status: 404 });
			const [x, y, width, height] = match.slice(1, 5).map(Number) as [
				number,
				number,
				number,
				number
			];
			const crop = new OffscreenCanvas(width, height);
			crop.getContext('2d')!.drawImage(source, x, y, width, height, 0, 0, width, height);
			return new Response(await crop.convertToBlob({ type: 'image/png' }), {
				status: 200,
				headers: { 'content-type': 'image/png' }
			});
		};
	}

	it('fills a ragged tile completely — no half pixel of padding at the margins', async () => {
		// 1201 × 851 is ragged in both directions at every scale factor: 1201 − 4×256 = 177 and
		// 851 − 3×256 = 83, neither of which divides by 2, 4 or 8.
		const raggedService = await acceptRemoteImageService(
			{ ...buildImageInfo({ imageId: 'x', ...dimensions }), id: SERVICE_URI },
			{ requestedUrl: `${SERVICE_URI}/info.json`, fallbackUri: SERVICE_URI }
		);
		expect(planOfflineCopy(raggedService).path).toBe('assembled');

		const ragged = planFor(dimensions).filter(
			(tile) =>
				tile.region.width % tile.scaleFactor !== 0 || tile.region.height % tile.scaleFactor !== 0
		);
		expect(ragged.length).toBeGreaterThan(3);

		for (const tile of ragged) {
			const store = new MemoryProjectStore();
			const result = await makeOfflineCopy({
				store,
				service: raggedService,
				fetch: hostFor(await uniformRegionImage(tile.region)),
				assemble: assembleWithCanvas,
				openDecodeAndCrop: openDecodeAndCropSource
			});

			const path = `${result.ingest.directory}/${tile.path.split('/').slice(-4).join('/')}`;
			const pixels = await pixelsOf(await store.read(path));
			const rows = contentExtent(pixels, 'rows');
			const columns = contentExtent(pixels, 'columns');
			const label = `${tile.path} (scale factor ${tile.scaleFactor})`;

			// Under IIIF `size=w,h` the region covers the whole tile.
			expect(rows, label).toBeCloseTo(tile.size.height, 1);
			expect(columns, label).toBeCloseTo(tile.size.width, 1);

			// Under a 1 ÷ scaleFactor resize with the remainder padded it would cover
			// region ÷ scaleFactor instead. How far apart the two are is `ceil(x) − x` for that tile, so
			// the assertion is that the measurement lands nearer the served size than the padded one by a
			// wide margin — the same form ticket 05's own version of this takes, and for the same reason.
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
		}
	});
});

describe('a level-0 remote service that will not serve what it declared', () => {
	it('refuses the copy and writes nothing', async () => {
		const store = new MemoryProjectStore();
		let served = 0;
		const host = fixtureHost();

		await expect(
			makeOfflineCopy({
				store,
				service,
				fetch: async (input, init) => {
					// The fifth tile 404s, which is what a pyramid with a missing file does.
					if (++served === 5) return new Response('gone', { status: 404 });
					return host.fetch(input, init);
				},
				assemble: assembleWithCanvas,
				openDecodeAndCrop: openDecodeAndCropSource
			})
		).rejects.toThrow(OfflineCopyRefusedError);

		expect(await store.list('images/')).toEqual([]);
	});
});

describe('planOfflineCopy against the fixture service', () => {
	it('takes the per-tile path, because a level-0 service serves nothing it did not cut', () => {
		const plan = planOfflineCopy(service);

		expect(plan.path).toBe('assembled');
		expect(plan.requests).toHaveLength(20);
		expect(plan.notes.join(' ')).toContain('library.test');
	});
});
