// SPEC's Seam 1 for mirroring: the job driven against an in-memory ProjectStore and a stub host,
// with the assertions on the files that land.
//
// The corpus is ticket 14's — the same fourteen `info.json` documents captured from live services —
// because the question "which of the two paths does a real library's service take, and what does that
// cost the host" can only be answered against what real services actually declare. Two of those
// fourteen turn out to cap `full/max` below full resolution, which is the case the ticket asks about
// and which no invented fixture would have produced.
//
// The level-0 case has no member in that corpus, and that is a finding rather than a gap: all
// fourteen report `supportsAnyRegionAndSize`. The level-0 fixture here is therefore **this app's own
// generated `info.json`** — which is exactly what a level-0 service in the wild is, a statically cut
// pyramid with `profile: 'level0'` and no ability to serve anything it did not pre-cut.

import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import { readImageHeader } from '../tiler/image-header.js';
import { ingestImageFile, type OpenTileSource, type TileSource } from '../tiler/ingest.js';
import { buildImageInfo, type PlannedTile } from '../tiler/pyramid.js';
import { acceptRemoteImageService, type RemoteImageService } from './image-service.js';
import {
	ESTIMATED_MIRROR_BYTES_PER_PIXEL,
	MIRROR_LIMITS,
	MirrorRefusedError,
	estimateMirrorBytes,
	mirrorRemoteImage,
	planMirror,
	type AssembleImage,
	type MirrorProgress
} from './mirror.js';

const corpus = JSON.parse(
	readFileSync(new URL('fixtures/real-world-image-services.json', import.meta.url), 'utf8')
) as { services: { name: string; fetchedFrom: string; info: unknown }[] };

const captured = (name: string): { fetchedFrom: string; info: unknown } => {
	const entry = corpus.services.find((service) => service.name === name);
	if (!entry) throw new Error(`No captured service called ${name}`);
	return entry;
};

const accept = (
	info: unknown,
	uri = 'https://images.test/iiif/3/chart'
): Promise<RemoteImageService> =>
	acceptRemoteImageService(info, { requestedUrl: `${uri}/info.json`, fallbackUri: uri });

const acceptCaptured = (name: string): Promise<RemoteImageService> => {
	const entry = captured(name);
	return acceptRemoteImageService(entry.info, {
		requestedUrl: entry.fetchedFrom,
		fallbackUri: entry.fetchedFrom.replace(/\/info\.json$/, '')
	});
};

/** A level-0 service: this app's own pyramid, which is what one in the wild looks like. */
const levelZero = (width: number, height: number, uri = 'https://static.test/pyramid') =>
	accept({ ...buildImageInfo({ imageId: 'x', width, height }), id: uri }, uri);

/** A level-2 service that declares everything and caps nothing. */
const levelTwo = (
	width: number,
	height: number,
	extra: Record<string, unknown> = {},
	uri = 'https://images.test/iiif/3/chart'
) =>
	accept(
		{
			'@context': 'http://iiif.io/api/image/3/context.json',
			id: uri,
			type: 'ImageService3',
			protocol: 'http://iiif.io/api/image',
			profile: 'level2',
			width,
			height,
			tiles: [{ width: 256, height: 256, scaleFactors: scaleFactorsFor(width, height, 256) }],
			...extra
		},
		uri
	);

function scaleFactorsFor(width: number, height: number, tile: number): number[] {
	const factors = [1];
	while (
		Math.ceil(width / (tile * factors[factors.length - 1]!)) > 1 ||
		Math.ceil(height / (tile * factors[factors.length - 1]!)) > 1
	) {
		factors.push(factors[factors.length - 1]! * 2);
	}
	return factors;
}

describe('planMirror: which of the two paths, and what it costs the host', () => {
	it('takes one request for a service that serves any region at any size', async () => {
		const plan = planMirror(await levelTwo(700, 500));

		expect(plan.path).toBe('full-max');
		expect(plan.requests).toHaveLength(1);
		expect(plan.refusal).toBe('');
	});

	it('asks an Image API 3 service for full/max and an Image API 2 service for full/full', async () => {
		// Not cosmetic: `size=full` was **removed** in Image API 3, and `size=max` did not exist before
		// 2.1. Asking either version for the other's spelling is a 400 from a strict server. Built here
		// rather than by `Image#getImageUrl`, which emits `full/full` for a version 3 service — recorded
		// with the ticket as an upstream defect.
		const three = planMirror(await levelTwo(700, 500));
		expect(three.requests[0]).toBe('https://images.test/iiif/3/chart/full/max/0/default.jpg');

		const two = planMirror(await acceptCaptured('bodleian'));
		expect(two.requests[0]).toMatch(/\/full\/full\/0\/default\.jpg$/);
	});

	it('pulls the whole finest level of a level-0 service, one request per tile it has cut', async () => {
		// ADR-0007's expensive case. 700×500 at 256-pixel tiles is 3 columns by 2 rows.
		const plan = planMirror(await levelZero(700, 500));

		expect(plan.path).toBe('assembled');
		expect(plan.requests).toHaveLength(6);
		expect(plan.pieces.map((piece) => piece.region)).toEqual([
			{ x: 0, y: 0, width: 256, height: 256 },
			{ x: 256, y: 0, width: 256, height: 256 },
			{ x: 512, y: 0, width: 188, height: 256 },
			{ x: 0, y: 256, width: 256, height: 244 },
			{ x: 256, y: 256, width: 256, height: 244 },
			{ x: 512, y: 256, width: 188, height: 244 }
		]);
		// Every piece is a 1:1 crop, which is what makes stitching them exact rather than a resampling.
		for (const piece of plan.pieces) {
			expect(piece.url).toContain(
				`/${piece.region.x},${piece.region.y},${piece.region.width},${piece.region.height}/` +
					`${piece.region.width},${piece.region.height}/`
			);
		}
	});

	it('names the host and the number of requests in the warning, because that is the obligation', async () => {
		const plan = planMirror(await levelZero(4000, 3000));
		const note = plan.notes.join(' ');

		expect(plan.requests).toHaveLength(Math.ceil(4000 / 256) * Math.ceil(3000 / 256));
		expect(note).toContain('static.test');
		expect(note).toContain(String(plan.requests.length));
		expect(note).toMatch(/request/i);
	});

	it('says nothing about many requests when there is only one', async () => {
		expect(planMirror(await levelTwo(700, 500)).notes.join(' ')).not.toMatch(/requests to/i);
	});

	describe('a service that caps what it will serve in one request', () => {
		it('is respected rather than asked for something it has said no to', async () => {
			// Cambridge Digital Library: `maxWidth`/`maxHeight` 2000 over a 4880×6174 image. Upstream's own
			// `getImageUrl` throws "Width of requested image is too large: 4880 > 2000" for this, which is
			// the 400 a real server would send. So `full/max` is not an option and the copy takes the
			// per-tile path instead — every tile of which is 256 pixels and inside the cap.
			const plan = planMirror(await acceptCaptured('cambridge'));

			expect(plan.cappedBy).toContain('2000');
			expect(plan.path).toBe('assembled');
			expect(plan.requests.length).toBeGreaterThan(1);
			expect(plan.notes.join(' ')).toMatch(/2000/);
		});

		it('is respected when the cap is an area rather than a side', async () => {
			// Micrio, as the Rijksmuseum runs it: `maxArea` 17 550 000 over 6560×4224 = 27.7 megapixels.
			const plan = planMirror(await acceptCaptured('rijks-micrio'));

			expect(plan.cappedBy).toContain('17550000');
			expect(plan.path).toBe('assembled');
		});

		it('is not treated as a cap when the image already fits inside it', async () => {
			// The Bodleian declares maxWidth 4000 over a 1000×1500 image, and NYPL a maxArea of 400
			// megapixels over 4.8 of them. A plan that read any declared limit as a cap would send both of
			// those down the expensive path for nothing.
			expect(planMirror(await acceptCaptured('bodleian')).path).toBe('full-max');
			expect(planMirror(await acceptCaptured('nypl')).path).toBe('full-max');
			expect(planMirror(await acceptCaptured('leipzig')).path).toBe('full-max');
		});

		it('caps a height that is only implied by maxWidth', async () => {
			// Image API 3: "If maxHeight is not specified, it is assumed to be the same as maxWidth."
			// A plan that read `maxHeight` as absent would happily ask for a 4000-pixel-tall image from a
			// service that said 1000.
			const plan = planMirror(await levelTwo(500, 4000, { maxWidth: 1000 }));

			expect(plan.cappedBy).toContain('1000');
			expect(plan.path).toBe('assembled');
		});
	});

	it('is the expensive path for exactly two of the fourteen real services, and level 0 for none', async () => {
		// The measurement, kept in the tree. Every one of the captured fourteen reports
		// `supportsAnyRegionAndSize`, so nothing real in the corpus is level 0 — which is why the level-0
		// fixtures above are this app's own pyramids.
		const paths = await Promise.all(
			corpus.services.map(async (entry) => [
				entry.name,
				planMirror(await acceptCaptured(entry.name)).path
			])
		);

		expect(paths.filter(([, path]) => path === 'assembled').map(([name]) => name)).toEqual([
			'cambridge',
			'rijks-micrio'
		]);
	});
});

describe('planMirror: what the copy will cost the Workspace', () => {
	it('estimates from the dimensions, over-stating rather than under-stating', () => {
		// Measured against the committed 1200×851 pyramid in `apps/editor/static/fixtures`: 29 tiles,
		// 575 261 bytes, which is 0.563 bytes per source pixel at quality 85. The constant is above that
		// on purpose — the number exists to warn about a hosting limit, and an estimate that came in
		// under the truth would be the one that let a user walk off the cliff unwarned.
		expect(ESTIMATED_MIRROR_BYTES_PER_PIXEL).toBeGreaterThan(0.5633);
		expect(estimateMirrorBytes(1200, 851)).toBeGreaterThan(575_261);
	});

	it('carries the dimensions that estimate is taken from', async () => {
		// The plan no longer carries the estimate itself — a stored arithmetic result is a thing that can
		// disagree with the fields it came from — so what it owes the dialog is the two numbers.
		const plan = planMirror(await levelTwo(1200, 851));

		expect([plan.width, plan.height]).toEqual([1200, 851]);
		expect(estimateMirrorBytes(plan.width, plan.height)).toBe(estimateMirrorBytes(1200, 851));
	});

	// **A refusal, where it used to be a warning** (ADR-0027). The note this replaces said a copy
	// this size "needs the streaming tiler", and then let the user start it — thousands of requests
	// to somebody else's server ending at a wall. There is no streaming tiler to need, and there is
	// nowhere for either path to escape to: a copy has to exist as one full-resolution image before
	// it can be re-cut. This is v1 ticket 15's `[~]` criterion, closed.
	it('refuses a source above the decode ceiling, on both paths', async () => {
		for (const [name, service] of [
			['full-max', await levelTwo(4000, 4000)],
			['assembled', await levelZero(4000, 4000)]
		] as const) {
			const under = planMirror(service, { maxIngestPixels: 100_000_000 });
			const over = planMirror(service, { maxIngestPixels: 1_000_000 });

			expect(under.refusal, name).toBe('');
			expect(over.refusal, name).not.toBe('');
			expect(over.refusal, name).toMatch(/megapixel/i);
			// The remedy, not the deployment. Nothing user-facing may name the headers any more.
			expect(over.refusal, name).toContain('outside the browser');
			for (const word of ['COOP', 'COEP', 'SharedArrayBuffer', 'streaming tiler']) {
				expect(over.refusal, `${name}: ${word}`).not.toContain(word);
			}
			expect(over.notes.join(' '), name).not.toContain('SharedArrayBuffer');
		}
	});

	it('refuses to stitch a level-0 source too large to hold in one image', async () => {
		// The per-tile path has to hold the whole source at full resolution to re-cut it, so it
		// inherits the decode ceiling rather than escaping it, and its refusal says so in its own
		// words. Named up front, not discovered as a dead tab part way through thousands of requests
		// to somebody else's server. 30000 × 30000 is 900 megapixels, above the real cap.
		const plan = planMirror(await levelZero(30_000, 30_000));

		expect(plan.refusal).not.toBe('');
		expect(plan.refusal).toMatch(/megapixel/i);
		expect(plan.refusal).toContain('reassembled at full resolution');
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────

/** A tiler that writes the tile's own geometry as its bytes, so a test can read it back. */
const stubTiler =
	(dimensions: { width: number; height: number }): OpenTileSource =>
	async (): Promise<TileSource> => ({
		dimensions,
		encodeTile: async (tile: PlannedTile) =>
			new TextEncoder().encode(
				JSON.stringify({ region: tile.region, size: tile.size, scaleFactor: tile.scaleFactor })
			),
		close: async () => undefined
	});

/** A JPEG header declaring `width` × `height`, which is what routes an ingest. */
function jpegHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(13);
	bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
	bytes[7] = (height >> 8) & 0xff;
	bytes[8] = height & 0xff;
	bytes[9] = (width >> 8) & 0xff;
	bytes[10] = width & 0xff;
	return bytes;
}

const jpeg = (width: number, height: number): Blob =>
	new Blob([jpegHeader(width, height) as BlobPart], { type: 'image/jpeg' });

/**
 * A host that answers every image request with a JPEG of the size the URL asked for.
 *
 * `full/max` and `full/full` name no size, so the host has to be told the image's dimensions — which
 * is exactly the asymmetry that makes those two requests worth checking: only the service's own
 * `info.json` says how big the answer should have been.
 */
function stubHost(
	options: { whole?: { width: number; height: number }; bytes?: (url: string) => Blob } = {}
): {
	fetch: FetchFn;
	requested: string[];
} {
	const requested: string[] = [];
	const fetch: FetchFn = async (input) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
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

/**
 * An {@link AssembleImage} that checks the geometry it was handed and hands back a header of the
 * assembled size.
 *
 * The real one is a canvas and is asserted in the browser. What this asserts is the contract: every
 * piece lands inside the image, the pieces cover it exactly once, and the result declares the size
 * the plan said it would.
 */
const stubAssemble = (log?: {
	regions: { x: number; y: number; width: number; height: number }[];
}): AssembleImage => {
	return async (dimensions, pieces) => {
		let covered = 0;
		for (const piece of pieces) {
			log?.regions.push(piece.region);
			if (
				piece.region.x < 0 ||
				piece.region.y < 0 ||
				piece.region.x + piece.region.width > dimensions.width ||
				piece.region.y + piece.region.height > dimensions.height
			) {
				throw new Error(`piece ${JSON.stringify(piece.region)} falls outside the image`);
			}
			covered += piece.region.width * piece.region.height;
		}
		if (covered !== dimensions.width * dimensions.height) {
			throw new Error(`pieces cover ${covered} of ${dimensions.width * dimensions.height} pixels`);
		}
		return jpeg(dimensions.width, dimensions.height);
	};
};

let store: MemoryProjectStore;

beforeEach(() => {
	store = new MemoryProjectStore();
});

const mirror = async (service: RemoteImageService, overrides: Record<string, unknown> = {}) => {
	const host = stubHost({ whole: { width: service.width, height: service.height } });
	return {
		host,
		result: await mirrorRemoteImage({
			store,
			service,
			fetch: host.fetch,
			assemble: stubAssemble(),
			openDecodeAndCrop: stubTiler({ width: service.width, height: service.height }),
			...overrides
		})
	};
};

describe('mirrorRemoteImage: the level-2 path', () => {
	it('makes exactly one request to the host and then tiles locally', async () => {
		const service = await levelTwo(700, 500);
		const { host, result } = await mirror(service);

		expect(host.requested).toEqual(['https://images.test/iiif/3/chart/full/max/0/default.jpg']);
		expect(result.path).toBe('full-max');
		expect(result.ingest.tileCount).toBe(6 + 2 + 1);
	});

	it('produces the pyramid a locally ingested file would have produced, file for file', async () => {
		// The whole of the ticket's contract in one assertion: "the output must be indistinguishable
		// from a locally ingested image, so nothing downstream needs to know how a pyramid arrived".
		const service = await levelTwo(700, 500);
		await mirror(service);
		const mirrored = [...(await store.list('amsterdam-1625/'))];

		const local = new MemoryProjectStore();
		const ingested = await ingestImageFile({
			store: local,
			file: new File([jpegHeader(700, 500) as BlobPart], 'chart.jpg', { type: 'image/jpeg' }),
			openDecodeAndCrop: stubTiler({ width: 700, height: 500 })
		});

		// Same paths once the image id is put aside — the id differs by design (a local ingest mints a
		// random one, a mirror keeps `generateId(uri)`), and nothing else may.
		const strip = (paths: readonly string[], id: string) =>
			paths.map((path) => path.replace(id, '<id>')).sort();
		expect(strip(mirrored, service.imageId)).toEqual(
			strip(await local.list('amsterdam-1625/'), ingested.imageId)
		);

		// And byte for byte: the tiler ran over the same geometry, so every tile's content matches.
		for (const path of mirrored) {
			if (path.endsWith('info.json') || path.endsWith('manifest.json')) continue;
			const here = await store.read(path);
			const there = await local.read(path.replace(service.imageId, ingested.imageId));
			expect(new TextDecoder().decode(here), path).toBe(new TextDecoder().decode(there));
		}
	});

	it('keeps the image id, so every Alignment that names it still names it', async () => {
		const service = await levelTwo(700, 500);
		const { result } = await mirror(service);

		expect(result.imageId).toBe(service.imageId);
		expect(result.ingest.imageId).toBe(service.imageId);
		expect(await store.list(`images/${service.imageId}/`)).not.toHaveLength(0);
	});

	it('writes the unset.invalid placeholder as the pyramid id, never the remote service', async () => {
		// ADR-0004. A mirrored `info.json` that kept the library's URI would send the injection shim
		// straight back out to the network — which is the one thing an offline copy must not do.
		const service = await levelTwo(700, 500);
		const { result } = await mirror(service);
		const info = JSON.parse(new TextDecoder().decode(await store.read(result.ingest.infoPath)));

		expect(info.id).toBe(`https://unset.invalid/${service.imageId}`);
		expect(JSON.stringify(info)).not.toContain('images.test');
	});

	it('refuses a response that is not the size the service said the image is', async () => {
		// A server may honour `max` with a smaller derivative — that is what `maxWidth` means, and a
		// server may cap without declaring it. Tiling that would produce a pyramid whose pixels are a
		// different size from the pixel coordinates every Control Point and every community Alignment is
		// in: a silently misplaced map, not a smaller one.
		const service = await levelTwo(700, 500);
		const host = stubHost({ bytes: () => jpeg(350, 250) });

		await expect(
			mirrorRemoteImage({
				store,
				service,
				fetch: host.fetch,
				assemble: stubAssemble(),
				openDecodeAndCrop: stubTiler({ width: 350, height: 250 })
			})
		).rejects.toThrow(MirrorRefusedError);

		expect(await store.list('amsterdam-1625/')).toEqual([]);
	});

	it('refuses a response larger than it will hold in memory, counting as it arrives', async () => {
		// Ticket 13's lesson on the other untrusted path: a declared size is a claim. This counts the
		// bytes rather than believing `content-length`, and there is no `content-length` here at all —
		// the bound is enforced against the stream, so a response with no end is abandoned rather than
		// buffered until the tab dies.
		expect(MIRROR_LIMITS.responseBytes).toBeGreaterThan(64 * 1024 * 1024);
		const service = await levelTwo(700, 500);
		const oversized = new Uint8Array(9000);
		oversized.set(jpegHeader(700, 500));
		const host = stubHost({ bytes: () => new Blob([oversized as BlobPart]) });

		await expect(
			mirrorRemoteImage({
				store,
				service,
				fetch: host.fetch,
				assemble: stubAssemble(),
				openDecodeAndCrop: stubTiler({ width: 700, height: 500 }),
				limits: { responseBytes: 8192 }
			})
		).rejects.toThrow(/larger than/i);

		expect(await store.list('amsterdam-1625/')).toEqual([]);
	});

	it('refuses before it fetches when the source is above the decode ceiling', async () => {
		// 30000 × 20000 is 600 megapixels. `mirrorRemoteImage` recomputes the plan when none is
		// passed, so the refusal has to reach the caller as an error rather than as a field nobody
		// read — and it has to happen before a byte is fetched or written.
		const service = await levelTwo(30_000, 20_000);
		const opened: string[] = [];
		const watch = (dimensions: { width: number; height: number }): OpenTileSource => {
			const inner = stubTiler(dimensions);
			return async (file) => {
				opened.push('decode-and-crop');
				return inner(file);
			};
		};

		const failure = await mirror(service, {
			openDecodeAndCrop: watch({ width: 30_000, height: 20_000 })
		}).then(
			() => undefined,
			(cause: unknown) => cause as Error
		);

		expect(failure).toBeInstanceOf(MirrorRefusedError);
		expect(failure?.message).toMatch(/600 megapixel/i);
		expect(opened).toEqual([]);
		expect(await store.list('')).toEqual([]);
	});
});

describe('mirrorRemoteImage: the level-0 path', () => {
	it('fetches every tile of the finest level and stitches them at 1:1', async () => {
		const service = await levelZero(700, 500);
		const log = { regions: [] as { x: number; y: number; width: number; height: number }[] };
		const host = stubHost();

		const result = await mirrorRemoteImage({
			store,
			service,
			fetch: host.fetch,
			assemble: stubAssemble(log),
			openDecodeAndCrop: stubTiler({ width: 700, height: 500 })
		});

		expect(result.path).toBe('assembled');
		expect(host.requested).toHaveLength(6);
		expect(log.regions).toHaveLength(6);
		// The stub refuses pieces that do not tile the image exactly once, so reaching here is the
		// geometric claim. This is the id and the count.
		expect(result.imageId).toBe(service.imageId);
		expect(result.ingest.width).toBe(700);
	});

	it('refuses a tile the host served at the wrong size', async () => {
		// The exact-resize check, applied to every piece rather than to one probe: a piece that is not
		// its region's size cannot be placed, and stitching it anyway would shift everything right of it.
		const service = await levelZero(700, 500);
		const host = stubHost({
			bytes: (url) => (url.includes('/512,0,') ? jpeg(100, 100) : jpeg(256, 256))
		});

		await expect(
			mirrorRemoteImage({
				store,
				service,
				fetch: host.fetch,
				// The real `assemble` decodes each piece and compares; this measures the bytes that actually
				// arrived — not the size the URL asked for, which is the mistake that would make this test
				// vacuous, since the URL is always right and it is the body that lies.
				assemble: async (dimensions, pieces) => {
					for (const piece of pieces) {
						const measured = readImageHeader(new Uint8Array(await piece.bytes.arrayBuffer()));
						if (
							measured?.width !== piece.region.width ||
							measured?.height !== piece.region.height
						) {
							throw new Error(
								`a tile covering ${piece.region.width}×${piece.region.height} pixels arrived as ` +
									`${measured?.width}×${measured?.height}`
							);
						}
					}
					return jpeg(dimensions.width, dimensions.height);
				},
				openDecodeAndCrop: stubTiler({ width: 700, height: 500 })
			})
		).rejects.toThrow(MirrorRefusedError);

		expect(await store.list('amsterdam-1625/')).toEqual([]);
	});

	it('will not start a copy the plan refused', async () => {
		const service = await levelZero(30_000, 30_000);
		const host = stubHost();

		await expect(
			mirrorRemoteImage({
				store,
				service,
				fetch: host.fetch,
				assemble: stubAssemble(),
				openDecodeAndCrop: stubTiler({ width: 30_000, height: 30_000 })
			})
		).rejects.toThrow(MirrorRefusedError);

		expect(host.requested).toEqual([]);
	});
});

describe('mirrorRemoteImage: progress and cancellation', () => {
	it('reports progress that reaches 1 only when the pyramid is complete', async () => {
		const service = await levelZero(700, 500);
		const reports: MirrorProgress[] = [];
		const host = stubHost();

		await mirrorRemoteImage({
			store,
			service,
			fetch: host.fetch,
			assemble: stubAssemble(),
			openDecodeAndCrop: stubTiler({ width: 700, height: 500 }),
			onProgress: (progress) => reports.push(progress)
		});

		expect(reports.map((report) => report.phase)).toContain('fetching');
		expect(reports.map((report) => report.phase)).toContain('tiling');
		expect(reports[reports.length - 1]?.phase).toBe('done');
		expect(reports[reports.length - 1]?.fraction).toBe(1);
		for (const report of reports.slice(0, -1)) expect(report.fraction).toBeLessThan(1);
		// Monotonic, so a bar cannot go backwards.
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

		await expect(
			mirrorRemoteImage({
				store,
				service,
				fetch,
				assemble: stubAssemble(),
				openDecodeAndCrop: stubTiler({ width: 700, height: 500 }),
				signal: abort.signal
			})
		).rejects.toThrow();

		expect(await store.list('amsterdam-1625/')).toEqual([]);
		// And it stopped asking the host, rather than finishing the round trip and throwing at the end.
		expect(host.requested).toHaveLength(3);
	});

	it('leaves no partial pyramid when it is cancelled part way through the tiling', async () => {
		// A partial pyramid renders with holes, which looks like corruption rather than like a cancelled
		// job. `ingestImageFile` owns the cleanup; this is the assertion that mirroring inherits it.
		const service = await levelTwo(700, 500);
		const abort = new AbortController();
		const host = stubHost({ whole: { width: 700, height: 500 } });
		let written = 0;

		await expect(
			mirrorRemoteImage({
				store,
				service,
				fetch: host.fetch,
				assemble: stubAssemble(),
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

		expect(await store.list('amsterdam-1625/')).toEqual([]);
	});

	it('never reads a file to do any of it', async () => {
		// Mirroring writes; it has no business opening what it wrote, and a version that read tiles
		// back to count bytes would make the ADR-0008 warning cost a second pass over the pyramid.
		const service = await levelTwo(700, 500);
		const read = vi.spyOn(store, 'read');

		await mirror(service);

		expect(read).not.toHaveBeenCalled();
	});
});
