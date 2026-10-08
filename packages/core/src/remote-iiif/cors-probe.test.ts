import { describe, expect, it } from 'vitest';

import { rejection } from '../test-support.js';
import { acceptCaptured } from './corpus-fixture.js';
import {
	PROBE_ATTEMPTS,
	RemoteImageUnusableError,
	probeRemoteImageService,
	type MeasureTile
} from './cors-probe';

const corsRejection = (url: string) =>
	Promise.reject(
		new TypeError(`Failed to fetch ${url}: No 'Access-Control-Allow-Origin' header is present`)
	);

const jpeg = () => new Response(new Blob([new Uint8Array([0xff, 0xd8, 0xff])]), { status: 200 });

const hangs = (init?: RequestInit) =>
	new Promise<Response>((_resolve, reject) => {
		init?.signal?.addEventListener('abort', () =>
			reject(new DOMException('The user aborted a request.', 'AbortError'))
		);
	});

const saysNothingAboutCors = (message: string | undefined) => {
	expect(message).not.toContain('Access-Control-Allow-Origin');
	expect(message).not.toContain('cross-origin');
	expect(message).not.toContain('completely blank');
};

const measuring =
	(size: { width: number; height: number }): MeasureTile =>
	async () =>
		size;

type Options = Partial<Parameters<typeof probeRemoteImageService>[1]>;

async function probing(
	tile: (url: string, attempt: number, init?: RequestInit) => Response | Promise<Response>,
	options: (remote: Awaited<ReturnType<typeof acceptCaptured>>) => Options = () => ({}),
	name = 'bodleian'
) {
	const remote = await acceptCaptured(name);
	const coarse = remote.probeTiles[1]?.url;
	const requested: string[] = [];
	const waits: number[] = [];
	let tileRequests = 0;
	const run = probeRemoteImageService(remote, {
		measureTile: measuring(remote.probeTiles[0]!.request.size),
		delay: async (ms: number) => {
			waits.push(ms);
		},
		fetch: async (input, init) => {
			const url = String(input);
			requested.push(url);
			if (url.endsWith('/info.json')) return jpeg();
			tileRequests += 1;
			return tile(url === coarse ? 'coarse' : url, tileRequests, init);
		},
		...options(remote)
	});
	return {
		remote,
		run,
		failure: () => rejection(RemoteImageUnusableError, run),
		requested,
		waits,
		tileRequests: () => tileRequests,
		tileUrl: remote.probeTiles[0]!.url
	};
}

describe('a host that serves its info.json cross-origin and its tiles not', () => {
	it('is refused by the tile probe once, naming the host and the tile, without retrying', async () => {
		const probe = await probing(corsRejection);
		const failure = await probe.failure();

		expect(failure.stage).toBe('tile');
		expect(failure.host).toBe('iiif.bodleian.ox.ac.uk');
		expect(failure.message).toContain('iiif.bodleian.ox.ac.uk');
		expect(failure.message).toContain('completely blank');
		expect(failure.message).toContain(probe.tileUrl);
		expect(probe.requested).toHaveLength(2);
		expect(probe.requested[0]).toMatch(/\/info\.json$/);
		expect(probe.requested[1]).toBe(probe.tileUrl);
		expect(probe.waits).toEqual([]);
		expect(failure.attempts).toBe(1);
		expect(failure.transient).toBe(false);
	});

	it('is refused by the info.json probe when that is what fails', async () => {
		const failure = await (
			await probing(jpeg, () => ({ fetch: async (input) => corsRejection(String(input)) }))
		).failure();
		expect(failure.stage).toBe('info');
		expect(failure.message).toContain('Access-Control-Allow-Origin');
	});
});

describe('a host that serves everything readably', () => {
	it('is accepted, and reports what it fetched', async () => {
		const probe = await probing(jpeg);
		const result = await probe.run;
		expect(result.host).toBe('iiif.bodleian.ox.ac.uk');
		expect(result.tileUrls).toEqual([probe.tileUrl]);
		expect(result.checkedGeometry).toBe(true);
	});

	it('probes the synthesised coarse level too, and refuses when the service will not serve it', async () => {
		const probe = await probing(
			(url) => (url === 'coarse' ? new Response('not this size', { status: 400 }) : jpeg()),
			undefined,
			'iiif-cookbook'
		);
		expect(probe.remote.synthesisedCoarsestScaleFactor).toBe(8);
		const failure = await probe.failure();

		expect(failure.stage).toBe('tile');
		expect(failure.url).toBe(probe.remote.probeTiles[1]!.url);
		expect(failure.message).toContain('serves any region at any size');
		expect(failure.message).toContain('the answer was no');
	});
});

describe('the exact-resize assumption, which cannot be asserted of a stranger', () => {
	it('refuses a tile whose served size is not the size that was asked for', async () => {
		const probe = await probing(jpeg, (remote) => ({
			measureTile: measuring({ width: remote.tileSize, height: remote.tileSize })
		}));
		const asked = probe.remote.probeTiles[0]!.request.size;
		expect(asked.width).toBeLessThan(probe.remote.tileSize);
		const failure = await probe.failure();

		expect(failure.stage).toBe('geometry');
		expect(failure.message).toContain(`asked for ${asked.width}×${asked.height}`);
		expect(failure.message).toContain('slightly stretched');
		expect(failure.message).toContain('make an offline copy');
	});

	it('refuses a tile the browser cannot decode at all', async () => {
		const failure = await (
			await probing(jpeg, () => ({
				measureTile: async () => {
					throw new Error('The source image could not be decoded.');
				}
			}))
		).failure();
		expect(failure.stage).toBe('tile');
		expect(failure.message).toContain('could not decode it as an image');
	});
});

describe('a host that is briefly broken rather than refusing', () => {
	it.each([
		{
			when: 'a hang and a 502 are followed by an answer',
			answers: [
				(init?: RequestInit) => hangs(init),
				() => new Response('Bad Gateway', { status: 502 })
			],
			waits: [500, 2000]
		},
		{
			when: 'a 429 asks to be asked more slowly',
			answers: [() => new Response('Slow down', { status: 429 })],
			waits: [500]
		}
	])('is accepted when a retry succeeds after $when', async ({ answers, waits }) => {
		const probe = await probing(
			async (_url, attempt, init) => answers[attempt - 1]?.(init) ?? jpeg(),
			() => ({ timeoutMs: 10 })
		);
		expect((await probe.run).tileUrls).toEqual([probe.tileUrl]);
		expect(probe.tileRequests()).toBe(answers.length + 1);
		expect(probe.waits).toEqual(waits);
	});

	it.each([
		{ answer: 'nothing', tile: (init?: RequestInit) => hangs(init), said: 'trying again' },
		{
			answer: '502',
			tile: () => Promise.resolve(new Response('Bad Gateway', { status: 502 })),
			said: 'the last answer was 502'
		}
	])(
		'is refused only after every attempt at $answer, blaming the host and not CORS',
		async ({ tile, said }) => {
			const probe = await probing(
				async (_url, _attempt, init) => tile(init),
				() => ({ timeoutMs: 10 })
			);
			const failure = await probe.failure();

			expect(probe.tileRequests()).toBe(PROBE_ATTEMPTS);
			expect(failure.stage).toBe('tile');
			expect(failure.attempts).toBe(PROBE_ATTEMPTS);
			expect(failure.transient).toBe(true);
			expect(failure.message).toContain('fault at the host');
			expect(failure.message).toContain(said);
			expect(failure.message).toContain(probe.tileUrl);
			saysNothingAboutCors(failure.message);
		}
	);
});

describe('a definite answer, which is not retried', () => {
	it('asks once for a 4xx, and says the host declined rather than blaming CORS', async () => {
		const probe = await probing(async () => new Response('Not Found', { status: 404 }));
		const failure = await probe.failure();

		expect(probe.tileRequests()).toBe(1);
		expect(failure.transient).toBe(false);
		expect(failure.message).toContain('answered 404 for a tile its own image description says');
		saysNothingAboutCors(failure.message);
	});

	it('does not blame CORS for an info.json that answers 404', async () => {
		const failure = await (
			await probing(jpeg, () => ({
				fetch: async () => new Response('Not Found', { status: 404 })
			}))
		).failure();

		expect(failure.stage).toBe('info');
		expect(failure.attempts).toBe(1);
		expect(failure.message).toContain('answered 404');
		expect(failure.message).toContain('IIIF');
		saysNothingAboutCors(failure.message);
	});
});
