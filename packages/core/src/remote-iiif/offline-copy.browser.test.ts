import { beforeAll, describe, expect, it } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { openDecodeAndCropSource } from '../tiler/decode-and-crop-tiler.js';
import { ingestImageFile } from '../tiler/ingest.js';
import {
	FLORIDE,
	expectRaggedTileFilled,
	fixtureTileUrls,
	fixtureUrlFor,
	pixelsOf,
	planFor,
	raggedTiles,
	uniformRegionCanvas
} from '../tiler/pixels-fixture.js';
import { buildImageInfo } from '../tiler/pyramid.js';
import { acceptRemoteImageService, type RemoteImageService } from './image-service.js';
import {
	OfflineCopyRefusedError,
	assembleWithCanvas,
	makeOfflineCopy,
	planOfflineCopy
} from './offline-copy.js';

const SERVICE_URI = 'https://library.test/iiif/floride-1657';

const serviceFor = (dimensions: { width: number; height: number }) =>
	acceptRemoteImageService(
		{ ...buildImageInfo({ imageId: 'x', ...dimensions }), id: SERVICE_URI },
		{ requestedUrl: `${SERVICE_URI}/info.json`, fallbackUri: SERVICE_URI }
	);

function fixtureHost(): { fetch: FetchFn; requested: string[] } {
	const requested: string[] = [];
	const fetch: FetchFn = async (input) => {
		const url = String(input);
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

let service: RemoteImageService;

beforeAll(async () => {
	service = await serviceFor(FLORIDE);
});

describe('assembleWithCanvas', () => {
	it('puts the pieces back exactly where they came from', async () => {
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
		for (const tile of planFor(FLORIDE)) {
			const path = `${directory}/${tile.path.split('/').slice(-4).join('/')}`;
			const decoded = await pixelsOf(await store.read(path));
			expect({ width: decoded.width, height: decoded.height }, path).toEqual(tile.size);
		}
	});

	it('is byte-identical to what a local ingest writes for the same source', async () => {
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
	const dimensions = { width: 1201, height: 851 };

	function hostFor(source: OffscreenCanvas): FetchFn {
		return async (input) => {
			const url = String(input);
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
		const raggedService = await serviceFor(dimensions);
		expect(planOfflineCopy(raggedService).path).toBe('assembled');
		const ragged = raggedTiles(dimensions);
		expect(ragged.length).toBeGreaterThan(3);

		for (const tile of ragged) {
			const store = new MemoryProjectStore();
			const result = await makeOfflineCopy({
				store,
				service: raggedService,
				fetch: hostFor(uniformRegionCanvas(dimensions, tile.region)),
				assemble: assembleWithCanvas,
				openDecodeAndCrop: openDecodeAndCropSource
			});

			const path = `${result.ingest.directory}/${tile.path.split('/').slice(-4).join('/')}`;
			expectRaggedTileFilled(await pixelsOf(await store.read(path)), tile);
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
