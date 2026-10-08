import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import { decode, imageService3, jpegHeader, rejection, stubTiler } from '../test-support.js';
import { readImageHeader } from '../tiler/image-header.js';
import { ingestImageFile } from '../tiler/ingest.js';
import { buildImageInfo, pyramidScaleFactors } from '../tiler/pyramid.js';
import { acceptCaptured, corpus } from './corpus-fixture.js';
import { acceptRemoteImageService, type RemoteImageService } from './image-service.js';
import {
	ESTIMATED_OFFLINE_COPY_BYTES_PER_PIXEL,
	OFFLINE_COPY_LIMITS,
	OfflineCopyRefusedError,
	estimateOfflineCopyBytes,
	makeOfflineCopy,
	planOfflineCopy,
	type AssembleImage,
	type OfflineCopyProgress
} from './offline-copy.js';

const accept = (
	info: unknown,
	uri = 'https://images.test/iiif/3/chart'
): Promise<RemoteImageService> =>
	acceptRemoteImageService(info, { requestedUrl: `${uri}/info.json`, fallbackUri: uri });

const levelZero = (width: number, height: number, uri = 'https://static.test/pyramid') =>
	accept({ ...buildImageInfo({ imageId: 'x', width, height }), id: uri }, uri);

const levelTwo = (
	width: number,
	height: number,
	extra: Record<string, unknown> = {},
	uri = 'https://images.test/iiif/3/chart'
) =>
	accept(
		{
			...imageService3({ id: uri, profile: 'level2', width, height }),
			tiles: [
				{ width: 256, height: 256, scaleFactors: pyramidScaleFactors({ width, height }, 256) }
			],
			...extra
		},
		uri
	);

describe('planOfflineCopy: which of the two paths, and what it costs the host', () => {
	it('takes one full/max request, with no many-requests note, from a level-2 Image API 3 service', async () => {
		const plan = planOfflineCopy(await levelTwo(700, 500));
		expect(plan.path).toBe('full-max');
		expect(plan.requests).toEqual(['https://images.test/iiif/3/chart/full/max/0/default.jpg']);
		expect(plan.refusal).toBe('');
		expect(plan.notes.join(' ')).not.toMatch(/requests to/i);
	});

	it('asks an Image API 2 service for full/full', async () => {
		const two = planOfflineCopy(await acceptCaptured('bodleian'));
		expect(two.requests[0]).toMatch(/\/full\/full\/0\/default\.jpg$/);
	});

	it('pulls the whole finest level of a level-0 service, one request per tile it has cut', async () => {
		const plan = planOfflineCopy(await levelZero(700, 500));
		expect(plan.path).toBe('assembled');
		expect(plan.requests).toHaveLength(6);
		expect(plan.pieces.map(({ region: { x, y, width, height } }) => [x, y, width, height])).toEqual(
			[
				[0, 0, 256, 256],
				[256, 0, 256, 256],
				[512, 0, 188, 256],
				[0, 256, 256, 244],
				[256, 256, 256, 244],
				[512, 256, 188, 244]
			]
		);
		for (const {
			url,
			region: { x, y, width, height }
		} of plan.pieces) {
			expect(url).toContain(`/${x},${y},${width},${height}/${width},${height}/`);
		}
	});

	it('names the host and the number of requests in the warning, because that is the obligation', async () => {
		const plan = planOfflineCopy(await levelZero(4000, 3000));
		const note = plan.notes.join(' ');
		expect(plan.requests).toHaveLength(Math.ceil(4000 / 256) * Math.ceil(3000 / 256));
		expect(note).toContain('static.test');
		expect(note).toContain(String(plan.requests.length));
		expect(note).toMatch(/request/i);
	});

	describe('a service that caps what it will serve in one request', () => {
		it.each([
			{ cap: 'a side', service: () => acceptCaptured('cambridge'), size: '2000' },
			{ cap: 'an area', service: () => acceptCaptured('rijks-micrio'), size: '17550000' },
			{
				cap: 'maxWidth alone',
				service: () => levelTwo(500, 4000, { maxWidth: 1000 }),
				size: '1000'
			}
		])('is respected, as assembled requests, when the cap is $cap', async ({ service, size }) => {
			const plan = planOfflineCopy(await service());
			expect(plan.cappedBy).toContain(size);
			expect(plan.path).toBe('assembled');
			expect(plan.requests.length).toBeGreaterThan(1);
			expect(plan.notes.join(' ')).toContain(size);
		});
	});

	it('is the expensive path for exactly two of the fourteen real services, and level 0 for none', async () => {
		const paths = await Promise.all(
			corpus.services.map(async (entry) => [
				entry.name,
				planOfflineCopy(await acceptCaptured(entry.name)).path
			])
		);

		expect(paths.filter(([, path]) => path === 'assembled').map(([name]) => name)).toEqual([
			'cambridge',
			'rijks-micrio'
		]);
	});
});

describe('planOfflineCopy: what the copy will cost the Workspace', () => {
	it('carries the dimensions to estimate from, over-stating rather than under-stating', async () => {
		expect(ESTIMATED_OFFLINE_COPY_BYTES_PER_PIXEL).toBeGreaterThan(0.5633);
		const plan = planOfflineCopy(await levelTwo(1200, 851));
		expect([plan.width, plan.height]).toEqual([1200, 851]);
		expect(estimateOfflineCopyBytes(plan.width, plan.height)).toBeGreaterThan(575_261);
	});

	it('refuses a source above the decode ceiling, on both paths', async () => {
		for (const [name, service] of [
			['full-max', await levelTwo(4000, 4000)],
			['assembled', await levelZero(4000, 4000)]
		] as const) {
			const under = planOfflineCopy(service, { maxIngestPixels: 100_000_000 });
			const over = planOfflineCopy(service, { maxIngestPixels: 1_000_000 });
			expect(under.refusal, name).toBe('');
			expect(over.refusal, name).not.toBe('');
			expect(over.refusal, name).toMatch(/megapixel/i);
			expect(over.refusal, name).toContain('outside the browser');
			for (const word of ['COOP', 'COEP', 'SharedArrayBuffer', 'streaming tiler']) {
				expect(over.refusal, `${name}: ${word}`).not.toContain(word);
			}
			expect(over.notes.join(' '), name).not.toContain('SharedArrayBuffer');
		}
	});

	it('refuses to stitch, or start copying, a level-0 source too large to hold in one image', async () => {
		const service = await levelZero(30_000, 30_000);
		const plan = planOfflineCopy(service);
		expect(plan.refusal).toMatch(/megapixel/i);
		expect(plan.refusal).toContain('reassembled at full resolution');
		const host = stubHost();
		await expect(makeCopy(service, {}, host)).rejects.toThrow(OfflineCopyRefusedError);
		expect(host.requested).toEqual([]);
	});
});

const jpeg = (width: number, height: number): Blob =>
	new Blob([jpegHeader(width, height) as BlobPart], { type: 'image/jpeg' });

function stubHost(
	options: { whole?: { width: number; height: number }; bytes?: (url: string) => Blob } = {}
) {
	const requested: string[] = [];
	const fetch: FetchFn = async (input) => {
		const url = String(input);
		requested.push(url);
		const size = /\/(\d+),(\d+)\/0\/default\.jpg$/.exec(url);
		const body =
			options.bytes?.(url) ??
			(size
				? jpeg(Number(size[1]), Number(size[2]))
				: jpeg(options.whole?.width ?? 0, options.whole?.height ?? 0));
		return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg' } });
	};
	return { fetch, requested };
}

const stubAssemble =
	(regions: unknown[] = []): AssembleImage =>
	async ({ width, height }, pieces) => {
		let covered = 0;
		for (const { region } of pieces) {
			regions.push(region);
			if (
				region.x < 0 ||
				region.y < 0 ||
				region.x + region.width > width ||
				region.y + region.height > height
			) {
				throw new Error(`piece ${JSON.stringify(region)} falls outside the image`);
			}
			covered += region.width * region.height;
		}
		if (covered !== width * height)
			throw new Error(`pieces cover ${covered} of ${width * height} pixels`);
		return jpeg(width, height);
	};

let store: MemoryProjectStore;
beforeEach(() => {
	store = new MemoryProjectStore();
});
const pyramid = () => store.list('amsterdam-1625/');

const makeCopy = async (
	service: RemoteImageService,
	overrides: Partial<Parameters<typeof makeOfflineCopy>[0]> = {},
	host = stubHost({ whole: { width: service.width, height: service.height } })
) => ({
	host,
	result: await makeOfflineCopy({
		store,
		service,
		fetch: host.fetch,
		assemble: stubAssemble(),
		openDecodeAndCrop: stubTiler({ width: service.width, height: service.height }),
		...overrides
	})
});

describe('makeOfflineCopy: the level-2 path', () => {
	it('makes one request, tiles locally under the same image id and placeholder, reading nothing', async () => {
		const service = await levelTwo(700, 500);
		const read = vi.spyOn(store, 'read');
		const { host, result } = await makeCopy(service);
		expect(read).not.toHaveBeenCalled();

		expect(host.requested).toEqual(['https://images.test/iiif/3/chart/full/max/0/default.jpg']);
		expect(result.path).toBe('full-max');
		expect(result.ingest.tileCount).toBe(6 + 2 + 1);
		expect(result.imageId).toBe(service.imageId);
		expect(result.ingest.imageId).toBe(service.imageId);
		expect(await store.list(`images/${service.imageId}/`)).not.toHaveLength(0);
		const info = JSON.parse(decode(await store.read(result.ingest.infoPath)));
		expect(info.id).toBe(`https://unset.invalid/${service.imageId}`);
		expect(JSON.stringify(info)).not.toContain('images.test');
	});

	it('produces the pyramid a locally ingested file would have produced, file for file', async () => {
		const service = await levelTwo(700, 500);
		await makeCopy(service);
		const copied = await pyramid();
		const local = new MemoryProjectStore();
		const ingested = await ingestImageFile({
			store: local,
			file: new File([jpegHeader(700, 500) as BlobPart], 'chart.jpg', { type: 'image/jpeg' }),
			openDecodeAndCrop: stubTiler({ width: 700, height: 500 })
		});

		const strip = (paths: readonly string[], id: string) =>
			paths.map((path) => path.replace(id, '<id>')).sort();
		expect(strip(copied, service.imageId)).toEqual(
			strip(await local.list('amsterdam-1625/'), ingested.imageId)
		);

		for (const path of copied) {
			if (path.endsWith('info.json') || path.endsWith('manifest.json')) continue;
			const here = await store.read(path);
			const there = await local.read(path.replace(service.imageId, ingested.imageId));
			expect(decode(here), path).toBe(decode(there));
		}
	});

	const oversized = new Uint8Array(9000);
	oversized.set(jpegHeader(700, 500));

	it.each([
		{
			why: 'is not the size the service said the image is',
			overrides: { openDecodeAndCrop: stubTiler({ width: 350, height: 250 }) },
			body: () => jpeg(350, 250),
			error: OfflineCopyRefusedError
		},
		{
			why: 'is larger than it will hold in memory, counting as it arrives',
			overrides: { limits: { responseBytes: 8192 } },
			body: () => new Blob([oversized as BlobPart]),
			error: /larger than/i
		}
	])('refuses, writing nothing, a response that $why', async ({ overrides, body, error }) => {
		expect(OFFLINE_COPY_LIMITS.responseBytes).toBeGreaterThan(64 * 1024 * 1024);
		const service = await levelTwo(700, 500);
		await expect(makeCopy(service, overrides, stubHost({ bytes: body }))).rejects.toThrow(error);
		expect(await pyramid()).toEqual([]);
	});

	it('refuses before it fetches when the source is above the decode ceiling', async () => {
		const service = await levelTwo(30_000, 20_000);
		const openDecodeAndCrop = vi.fn(stubTiler({ width: 30_000, height: 20_000 }));

		const failure = await rejection(
			OfflineCopyRefusedError,
			makeCopy(service, { openDecodeAndCrop })
		);

		expect(failure.message).toMatch(/600 megapixel/i);
		expect(openDecodeAndCrop).not.toHaveBeenCalled();
		expect(await store.list('')).toEqual([]);
	});
});

describe('makeOfflineCopy: the level-0 path', () => {
	it('fetches every tile of the finest level and stitches them at 1:1', async () => {
		const service = await levelZero(700, 500);
		const regions: unknown[] = [];
		const { host, result } = await makeCopy(service, { assemble: stubAssemble(regions) });

		expect(result.path).toBe('assembled');
		expect(host.requested).toHaveLength(6);
		expect(regions).toHaveLength(6);
		expect(result.imageId).toBe(service.imageId);
		expect(result.ingest.width).toBe(700);
	});

	it('refuses a tile the host served at the wrong size', async () => {
		const service = await levelZero(700, 500);
		const host = stubHost({
			bytes: (url) => (url.includes('/512,0,') ? jpeg(100, 100) : jpeg(256, 256))
		});
		const assemble: AssembleImage = async (dimensions, pieces) => {
			for (const piece of pieces) {
				const measured = readImageHeader(new Uint8Array(await piece.bytes.arrayBuffer()));
				if (measured?.width !== piece.region.width || measured?.height !== piece.region.height) {
					throw new Error(
						`a tile covering ${piece.region.width}×${piece.region.height} pixels arrived as ` +
							`${measured?.width}×${measured?.height}`
					);
				}
			}
			return jpeg(dimensions.width, dimensions.height);
		};

		await expect(makeCopy(service, { assemble }, host)).rejects.toThrow(OfflineCopyRefusedError);

		expect(await pyramid()).toEqual([]);
	});
});

describe('makeOfflineCopy: progress and cancellation', () => {
	it('reports progress that reaches 1 only when the pyramid is complete', async () => {
		const service = await levelZero(700, 500);
		const reports: OfflineCopyProgress[] = [];

		await makeCopy(service, { onProgress: (progress) => reports.push(progress) });

		expect(reports.map((report) => report.phase)).toContain('fetching');
		expect(reports.map((report) => report.phase)).toContain('tiling');
		expect(reports.at(-1)?.phase).toBe('done');
		expect(reports.at(-1)?.fraction).toBe(1);
		for (const report of reports.slice(0, -1)) expect(report.fraction).toBeLessThan(1);
		const fractions = reports.map((report) => report.fraction);
		expect([...fractions].sort((a, b) => a - b)).toEqual(fractions);
	});

	it('leaves no partial pyramid when it is cancelled part way through the fetching', async () => {
		const service = await levelZero(700, 500);
		const abort = new AbortController();
		const host = stubHost();
		const fetch: FetchFn = async (input, init) => {
			const response = await host.fetch(input, init);
			if (host.requested.length === 3) abort.abort();
			return response;
		};

		await expect(makeCopy(service, { fetch, signal: abort.signal })).rejects.toThrow();

		expect(await pyramid()).toEqual([]);
		expect(host.requested).toHaveLength(3);
	});

	it('leaves no partial pyramid when it is cancelled part way through the tiling', async () => {
		const service = await levelTwo(700, 500);
		const abort = new AbortController();
		let written = 0;

		await expect(
			makeCopy(service, {
				openDecodeAndCrop: async () => ({
					dimensions: { width: 700, height: 500 },
					encodeTile: async () => {
						if (++written === 4) abort.abort();
						return new Uint8Array([1, 2, 3]);
					},
					close: async () => undefined
				}),
				signal: abort.signal
			})
		).rejects.toThrow();

		expect(await pyramid()).toEqual([]);
	});
});
