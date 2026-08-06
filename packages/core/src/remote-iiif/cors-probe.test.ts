import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
	PROBE_ATTEMPTS,
	RemoteImageUnusableError,
	probeRemoteImageService,
	type MeasureTile
} from './cors-probe';
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

/**
 * A host that never answers — what a `fetch` does when the timeout aborts it.
 *
 * The probe distinguishes this from {@link corsRejection} by the abort signal rather than by the
 * error, so the signal is what this honours. It must not resolve, or the case under test is a fast
 * host rather than a hanging one.
 */
const hangs = (init?: RequestInit) =>
	new Promise<Response>((_resolve, reject) => {
		init?.signal?.addEventListener('abort', () =>
			reject(new DOMException('The user aborted a request.', 'AbortError'))
		);
	});

/** Records the waits instead of taking them, so a retry test costs no wall-clock time. */
const instantly = () => {
	const waits: number[] = [];
	return {
		waits,
		delay: async (ms: number) => {
			waits.push(ms);
		}
	};
};

/** Nothing in a transient refusal may read as a verdict on the host's CORS policy. */
const saysNothingAboutCors = (message: string | undefined) => {
	expect(message).not.toContain('Access-Control-Allow-Origin');
	expect(message).not.toContain('cross-origin');
	expect(message).not.toContain('completely blank');
};

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

// The host that prompted all of this is `cdm17272.contentdm.oclc.org`: it serves its pyramid with
// `Access-Control-Allow-Origin: *`, and roughly one cold-derivative request in five hangs for a
// minute and then answers 502. Because the probe asks for the far-corner ragged tile — by
// construction the coldest tile in the pyramid — it walked into that failure and refused a map that
// works, with a sentence blaming CORS headers that were already correct.
describe('a host that is briefly broken rather than refusing', () => {
	it('is accepted when a retry succeeds, and the map is not refused for one bad request', async () => {
		const remote = await service();
		const tile = remote.probeTiles[0]!.url;
		let tileRequests = 0;
		const clock = instantly();

		const probe = await probeRemoteImageService(remote, {
			measureTile: measuring(remote.probeTiles[0]!.request.size),
			timeoutMs: 10,
			delay: clock.delay,
			fetch: async (input, init) => {
				if (String(input) !== tile) return jpeg();
				tileRequests += 1;
				// Exactly the observed behaviour: hang, then 502, then serve it perfectly.
				if (tileRequests === 1) return hangs(init);
				if (tileRequests === 2) return new Response('Bad Gateway', { status: 502 });
				return jpeg();
			}
		});

		expect(probe.tileUrls).toEqual([tile]);
		expect(tileRequests).toBe(3);
		// Backoff between attempts, not a hot loop against a host that is already struggling.
		expect(clock.waits).toEqual([500, 2000]);
	});

	it('is refused only after every attempt, and the refusal blames the host and not CORS', async () => {
		const remote = await service();
		const tile = remote.probeTiles[0]!.url;
		let tileRequests = 0;

		const failure = await probeRemoteImageService(remote, {
			measureTile: measuring(remote.probeTiles[0]!.request.size),
			timeoutMs: 10,
			delay: instantly().delay,
			fetch: async (input, init) => {
				if (String(input) !== tile) return jpeg();
				tileRequests += 1;
				return hangs(init);
			}
		}).then(
			() => null,
			(cause: unknown) => cause as RemoteImageUnusableError
		);

		expect(tileRequests).toBe(PROBE_ATTEMPTS);
		expect(failure?.stage).toBe('tile');
		expect(failure?.attempts).toBe(PROBE_ATTEMPTS);
		// The field a "Try again" button would read, and the difference between this refusal and a
		// host that genuinely will not allow the read.
		expect(failure?.transient).toBe(true);
		expect(failure?.message).toContain('fault at the host');
		expect(failure?.message).toContain('trying again');
		expect(failure?.message).toContain(tile);
		// **The regression this whole section exists for.** A timeout is evidence about nothing but
		// the host's responsiveness, and the sentence it produced used to be a confident, wrong
		// diagnosis of the host's CORS policy — which sent a user to argue about headers that were
		// already correct.
		saysNothingAboutCors(failure?.message);
	});

	it('names the status it kept receiving when the host answers 5xx', async () => {
		const remote = await service();
		const failure = await probeRemoteImageService(remote, {
			measureTile: measuring(remote.probeTiles[0]!.request.size),
			delay: instantly().delay,
			fetch: async (input) =>
				String(input).endsWith('/info.json') ? jpeg() : new Response('Bad Gateway', { status: 502 })
		}).then(
			() => null,
			(cause: unknown) => cause as RemoteImageUnusableError
		);

		expect(failure?.transient).toBe(true);
		expect(failure?.attempts).toBe(PROBE_ATTEMPTS);
		expect(failure?.message).toContain('the last answer was 502');
		saysNothingAboutCors(failure?.message);
	});

	it('retries a 429, because that is the host asking to be asked more slowly', async () => {
		const remote = await service();
		const tile = remote.probeTiles[0]!.url;
		let tileRequests = 0;

		const probe = await probeRemoteImageService(remote, {
			measureTile: measuring(remote.probeTiles[0]!.request.size),
			delay: instantly().delay,
			fetch: async (input) => {
				if (String(input) !== tile) return jpeg();
				tileRequests += 1;
				return tileRequests === 1 ? new Response('Slow down', { status: 429 }) : jpeg();
			}
		});

		expect(probe.tileUrls).toEqual([tile]);
		expect(tileRequests).toBe(2);
	});
});

describe('a definite answer, which is not retried', () => {
	it('asks once when the browser refuses the read, because a missing header will not appear', async () => {
		const remote = await service();
		const tile = remote.probeTiles[0]!.url;
		let tileRequests = 0;
		const clock = instantly();

		const failure = await probeRemoteImageService(remote, {
			measureTile: measuring(remote.probeTiles[0]!.request.size),
			delay: clock.delay,
			fetch: async (input) => {
				if (String(input).endsWith('/info.json')) return jpeg();
				tileRequests += 1;
				return corsRejection(String(input));
			}
		}).then(
			() => null,
			(cause: unknown) => cause as RemoteImageUnusableError
		);

		// Retrying this would only make the commonest real failure three times slower to report.
		expect(tileRequests).toBe(1);
		expect(clock.waits).toEqual([]);
		expect(failure?.attempts).toBe(1);
		expect(failure?.transient).toBe(false);
		expect(failure?.message).toContain('completely blank');
		expect(failure?.message).toContain(tile);
	});

	it('asks once for a 4xx, and says the host declined rather than blaming CORS', async () => {
		const remote = await service();
		let tileRequests = 0;

		const failure = await probeRemoteImageService(remote, {
			measureTile: measuring(remote.probeTiles[0]!.request.size),
			delay: instantly().delay,
			fetch: async (input) => {
				if (String(input).endsWith('/info.json')) return jpeg();
				tileRequests += 1;
				return new Response('Not Found', { status: 404 });
			}
		}).then(
			() => null,
			(cause: unknown) => cause as RemoteImageUnusableError
		);

		expect(tileRequests).toBe(1);
		expect(failure?.transient).toBe(false);
		expect(failure?.message).toContain('answered 404 for a tile its own image description says');
		saysNothingAboutCors(failure?.message);
	});

	it('does not blame CORS for an info.json that answers 404', async () => {
		const remote = await service();
		const failure = await probeRemoteImageService(remote, {
			measureTile: measuring({ width: 1, height: 1 }),
			delay: instantly().delay,
			fetch: async () => new Response('Not Found', { status: 404 })
		}).then(
			() => null,
			(cause: unknown) => cause as RemoteImageUnusableError
		);

		expect(failure?.stage).toBe('info');
		expect(failure?.attempts).toBe(1);
		expect(failure?.message).toContain('answered 404');
		expect(failure?.message).toContain('IIIF');
		saysNothingAboutCors(failure?.message);
	});
});
