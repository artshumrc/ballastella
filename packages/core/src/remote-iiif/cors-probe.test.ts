import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { RemoteImageUnusableError, probeRemoteImageService, type MeasureTile } from './cors-probe';
import { acceptRemoteImageService, type RemoteImageService } from './image-service';

// The gate this file tests is the one ADR-0007 exists for: without it, a host that serves
// `info.json` cross-origin and tiles not renders **blank with no error**. The whole trap is that a
// probe of `info.json` alone passes a naive test and ships that failure, so the fixture host below
// is deliberately built that way — CORS on the description, none on the tiles — and the assertion
// is that the resource is refused *by the tile probe*.
//
// A cross-origin `fetch` the host does not permit **rejects**; it does not resolve with a 403. So
// rejecting is what a real browser does here, and it is what the fake host does.

const corpus = JSON.parse(
	readFileSync(new URL('fixtures/real-world-image-services.json', import.meta.url), 'utf8')
) as { services: { name: string; fetchedFrom: string; info: unknown }[] };

const service = async (name = 'bodleian'): Promise<RemoteImageService> => {
	const captured = corpus.services.find((entry) => entry.name === name);
	if (!captured) throw new Error(`No captured service called “${name}”.`);
	return acceptRemoteImageService(captured.info, {
		requestedUrl: captured.fetchedFrom,
		fallbackUri: captured.fetchedFrom.replace(/\/info\.json$/, '')
	});
};

/** The browser's own failure for a cross-origin request the host does not permit. */
const corsRejection = (url: string) =>
	Promise.reject(
		new TypeError(`Failed to fetch ${url}: No 'Access-Control-Allow-Origin' header is present`)
	);

const jpeg = () => new Response(new Blob([new Uint8Array([0xff, 0xd8, 0xff])]), { status: 200 });

/** Measures whatever the caller says it measures, so Node needs no image decoder. */
const measuring =
	(size: { width: number; height: number }): MeasureTile =>
	async () =>
		size;

describe('a host that serves its info.json cross-origin and its tiles not', () => {
	it('is refused by the tile probe, naming the host and the tile', async () => {
		const remote = await service();
		const requested: string[] = [];

		const failure = await probeRemoteImageService(remote, {
			measureTile: measuring(remote.probeTiles[0]!.request.size),
			fetch: async (input) => {
				const url = String(input);
				requested.push(url);
				// The trap, exactly: the description is readable and the tiles are not.
				return url.endsWith('/info.json') ? jpeg() : corsRejection(url);
			}
		}).then(
			() => null,
			(cause: unknown) => cause as RemoteImageUnusableError
		);

		expect(failure).toBeInstanceOf(RemoteImageUnusableError);
		expect(failure?.stage).toBe('tile');
		expect(failure?.host).toBe('iiif.bodleian.ox.ac.uk');
		expect(failure?.message).toContain('iiif.bodleian.ox.ac.uk');
		expect(failure?.message).toContain('completely blank');
		expect(failure?.message).toContain(remote.probeTiles[0]!.url);

		// **The mutation guard for the whole file.** A probe that only fetched `info.json` would make
		// every assertion above unreachable, and this is what says it did not: two requests were made,
		// the second for a tile.
		expect(requested).toHaveLength(2);
		expect(requested[0]).toMatch(/\/info\.json$/);
		expect(requested[1]).toBe(remote.probeTiles[0]!.url);
	});

	it('is refused by the info.json probe when that is what fails', async () => {
		const remote = await service();
		const failure = await probeRemoteImageService(remote, {
			measureTile: measuring({ width: 1, height: 1 }),
			fetch: async (input) => corsRejection(String(input))
		}).then(
			() => null,
			(cause: unknown) => cause as RemoteImageUnusableError
		);

		expect(failure?.stage).toBe('info');
		expect(failure?.message).toContain('Access-Control-Allow-Origin');
	});
});

describe('a host that serves everything readably', () => {
	it('is accepted, and reports what it fetched', async () => {
		const remote = await service();
		const probe = await probeRemoteImageService(remote, {
			measureTile: measuring(remote.probeTiles[0]!.request.size),
			fetch: async () => jpeg()
		});

		expect(probe.host).toBe('iiif.bodleian.ox.ac.uk');
		expect(probe.tileUrls).toEqual([remote.probeTiles[0]!.url]);
		expect(probe.checkedGeometry).toBe(true);
	});

	it('probes the synthesised coarse level too, and refuses when the service will not serve it', async () => {
		// The IIIF 3.0 reference example declares scale factors 1, 2, 4 for a 4032×3024 image, so
		// `extendedTileset` adds 8 on the strength of the service's own `supportsAnyRegionAndSize`.
		// This is where that claim is checked instead of trusted: the fine tile is served and the
		// coarse one is not, and the refusal says so rather than blaming CORS.
		const remote = await service('iiif-cookbook');
		expect(remote.synthesisedCoarsestScaleFactor).toBe(8);

		const coarse = remote.probeTiles[1]!;
		const failure = await probeRemoteImageService(remote, {
			measureTile: measuring(remote.probeTiles[0]!.request.size),
			fetch: async (input) =>
				String(input) === coarse.url ? new Response('not this size', { status: 400 }) : jpeg()
		}).then(
			() => null,
			(cause: unknown) => cause as RemoteImageUnusableError
		);

		expect(failure?.stage).toBe('tile');
		expect(failure?.url).toBe(coarse.url);
		expect(failure?.message).toContain('serves any region at any size');
		expect(failure?.message).toContain('the answer was no');
	});
});

describe('the exact-resize assumption, which cannot be asserted of a stranger', () => {
	it('refuses a tile whose served size is not the size that was asked for', async () => {
		// `ImagePaneTile.placement` is `region ÷ scaleFactor`, and that is the right number only if
		// `size=w,h` really returns w×h. Ticket 05 asserts our own tiler honours it; here the server
		// belongs to somebody else, and a server that rounds a ragged tile up to a whole tile draws
		// this map stretched by up to 0.6% at the right and bottom margins — sub-pixel, systematic,
		// and indistinguishable from an imprecise alignment.
		const remote = await service();
		const asked = remote.probeTiles[0]!.request.size;
		expect(asked.width).toBeLessThan(remote.tileSize);

		const failure = await probeRemoteImageService(remote, {
			// The classic wrong answer: padded out to a whole tile.
			measureTile: measuring({ width: remote.tileSize, height: remote.tileSize }),
			fetch: async () => jpeg()
		}).then(
			() => null,
			(cause: unknown) => cause as RemoteImageUnusableError
		);

		expect(failure?.stage).toBe('geometry');
		expect(failure?.message).toContain(`asked for ${asked.width}×${asked.height}`);
		expect(failure?.message).toContain('slightly stretched');
		expect(failure?.message).toContain('make an offline copy');
	});

	it('refuses a tile the browser cannot decode at all', async () => {
		const remote = await service();
		const failure = await probeRemoteImageService(remote, {
			measureTile: async () => {
				throw new Error('The source image could not be decoded.');
			},
			fetch: async () => jpeg()
		}).then(
			() => null,
			(cause: unknown) => cause as RemoteImageUnusableError
		);

		expect(failure?.stage).toBe('tile');
		expect(failure?.message).toContain('could not decode it as an image');
	});
});
