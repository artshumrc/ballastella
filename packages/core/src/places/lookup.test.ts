import { describe, expect, it } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import {
	createLookupRateLimiter,
	lookUpPlaces,
	withSharedLookupRateLimiter,
	type LookUpPlacesOptions
} from './lookup';
import type { LookupOutcome, PlaceService } from './place';
import { PLACE_SERVICE } from './service';

const SERVICE: PlaceService = {
	searchUrl: (query) => `https://places.example.test/search?q=${encodeURIComponent(query)}`,
	attribution: { text: '© Somebody', href: null }
};

const result = (fields: Record<string, unknown> = {}) => ({
	display_name: 'Springfield, Sangamon County, Illinois, United States',
	lat: '39.7990175',
	lon: '-89.6439575',
	boundingbox: ['39.6536560', '39.8741700', '-89.7731820', '-89.5685100'],
	...fields
});

function answering(payload: unknown, status = 200): { fetch: FetchFn; urls: string[] } {
	const urls: string[] = [];
	const fetch: FetchFn = async (input) => {
		urls.push(String(input));
		return new Response(JSON.stringify(payload), {
			status,
			headers: { 'content-type': 'application/json' }
		});
	};
	return { fetch, urls };
}

const ask = (query: string, options: LookUpPlacesOptions = {}): Promise<LookupOutcome> =>
	lookUpPlaces(query, { service: SERVICE, limiter: createLookupRateLimiter(), ...options });

describe('lookUpPlaces', () => {
	it('reads a name, a point and a box out of each result', async () => {
		const { fetch, urls } = answering([result()]);

		const outcome = await ask('Springfield', { fetch });

		expect(outcome).toEqual({
			kind: 'places',
			places: [
				{
					name: 'Springfield, Sangamon County, Illinois, United States',
					point: { lng: -89.6439575, lat: 39.7990175 },
					bounds: { west: -89.773182, south: 39.653656, east: -89.56851, north: 39.87417 }
				}
			]
		});
		expect(urls).toEqual(['https://places.example.test/search?q=Springfield']);
	});

	it('carries a box that crosses the antimeridian with its east above 180', async () => {
		const { fetch } = answering([result({ boundingbox: ['-18', '-16', '177', '-179'] })]);

		const outcome = await ask('Taveuni', { fetch });

		expect(outcome.kind === 'places' && outcome.places[0]?.bounds).toEqual({
			west: 177,
			south: -18,
			east: 181,
			north: -16
		});
	});

	it('reports a service that answered with nothing as none, not as a failure', async () => {
		const { fetch } = answering([]);

		await expect(ask('Nowhere at all', { fetch })).resolves.toEqual({
			kind: 'none'
		});
	});

	it.each<[string, () => FetchFn, { timeoutMs?: number }?]>([
		['a status that is not a success', () => answering([result()], 503).fetch],
		[
			'a fetch that rejects, rather than throwing',
			() => () => Promise.reject(new TypeError('Failed to fetch'))
		],
		[
			'a body that is not JSON',
			() => async () => new Response('<html>a login page</html>', { status: 200 })
		],
		[
			'a payload that is not a list of results',
			() => answering({ error: 'unknown parameter' }).fetch
		],
		[
			'results that cannot be read at all, not as none',
			() => answering([{ display_name: 'Somewhere' }, { lat: '1', lon: '2' }]).fetch
		],
		[
			'a request that never answers, rather than waiting for the socket',
			() => (_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
				}),
			{ timeoutMs: 1 }
		]
	])('reports %s as unanswered', async (_, fetch, options = {}) => {
		await expect(ask('Springfield', { fetch: fetch(), ...options })).resolves.toEqual({
			kind: 'unanswered'
		});
	});

	it('drops one unreadable result and keeps the rest', async () => {
		const { fetch } = answering([result({ boundingbox: undefined }), result({ lat: '1' })]);

		const outcome = await ask('Springfield', { fetch });

		expect(outcome.kind === 'places' && outcome.places.map((place) => place.point.lat)).toEqual([
			1
		]);
	});
});

describe('the rate limiter', () => {
	it('refuses a second lookup inside one second, and issues nothing for it', async () => {
		const { fetch, urls } = answering([result()]);
		let clock = 1_000;
		const limiter = createLookupRateLimiter(() => clock);

		await expect(ask('Springfield', { fetch, limiter })).resolves.toMatchObject({ kind: 'places' });
		expect(urls).toHaveLength(1);

		clock += 999;
		await expect(ask('Springfield again', { fetch, limiter })).resolves.toEqual({
			kind: 'too-fast'
		});
		expect(urls, 'a request went out for the refused lookup').toHaveLength(1);

		clock += 1;
		await expect(ask('Springfield again', { fetch, limiter })).resolves.toMatchObject({
			kind: 'places'
		});
		expect(urls).toHaveLength(2);
	});

	it('gives the service’s own 429 the same outcome its refusal produces', async () => {
		const { fetch } = answering([], 429);

		await expect(ask('Springfield', { fetch })).resolves.toEqual({ kind: 'too-fast' });
	});

	it('spends no second on a blank query', async () => {
		const { fetch, urls } = answering([result()]);
		const limiter = createLookupRateLimiter(() => 1_000);

		await expect(ask('   ', { fetch, limiter })).resolves.toEqual({ kind: 'none' });
		await expect(ask('Springfield', { fetch, limiter })).resolves.toMatchObject({ kind: 'places' });
		expect(urls).toHaveLength(1);
	});

	it('paces a caller that brings no limiter of its own', async () => {
		const { fetch, urls } = answering([result()]);
		let clock = 1_000;
		const restore = withSharedLookupRateLimiter(createLookupRateLimiter(() => clock));

		try {
			await lookUpPlaces('Springfield', { fetch, service: SERVICE });
			clock += 999;
			await expect(lookUpPlaces('Springfield', { fetch, service: SERVICE })).resolves.toEqual({
				kind: 'too-fast'
			});
			expect(urls).toHaveLength(1);
		} finally {
			restore();
		}
	});
});

describe('the configured service', () => {
	it('escapes the query into the URL it builds', async () => {
		expect(PLACE_SERVICE.searchUrl('Boston Common & the Public Garden')).toContain(
			'Boston%20Common%20%26%20the%20Public%20Garden'
		);
	});

	it('carries the credit its own answers need', () => {
		expect(PLACE_SERVICE.attribution.text).not.toBe('');
	});
});
