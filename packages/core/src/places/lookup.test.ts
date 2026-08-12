import { describe, expect, it } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import { lookUpPlaces } from './lookup';
import type { PlaceService } from './place';
import { PLACE_SERVICE } from './service';

/**
 * A service that is not this deployment's, so every test below drives the shape rather than the
 * host — the same property `resolve.test.ts` gets from driving fixture catalogs.
 */
const SERVICE: PlaceService = {
	searchUrl: (query) => `https://places.example.test/search?q=${encodeURIComponent(query)}`,
	attribution: { text: '© Somebody', href: null }
};

/** One result in the shape the service sends: coordinates as strings, `[s, n, w, e]` for the box. */
const result = (fields: Record<string, unknown> = {}) => ({
	display_name: 'Springfield, Sangamon County, Illinois, United States',
	lat: '39.7990175',
	lon: '-89.6439575',
	boundingbox: ['39.6536560', '39.8741700', '-89.7731820', '-89.5685100'],
	...fields
});

/** A service that answers with `payload`, and a record of what it was asked. */
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

describe('lookUpPlaces', () => {
	it('reads a name, a point and a box out of each result', async () => {
		const { fetch, urls } = answering([result()]);

		const outcome = await lookUpPlaces('Springfield', { fetch, service: SERVICE });

		expect(outcome).toEqual({
			kind: 'places',
			places: [
				{
					name: 'Springfield, Sangamon County, Illinois, United States',
					point: { lng: -89.6439575, lat: 39.7990175 },
					// `[south, north, west, east]` as sent, in `GeoBounds`' own order. Getting this pair
					// the wrong way round frames the map on the Indian Ocean and throws nothing.
					bounds: { west: -89.773182, south: 39.653656, east: -89.56851, north: 39.87417 }
				}
			]
		});
		expect(urls).toEqual(['https://places.example.test/search?q=Springfield']);
	});

	it('carries a box that crosses the antimeridian with its east above 180', async () => {
		// `GeoBounds` says a box crossing ±180 is written with `east` above 180, because a box whose
		// east is numerically west of its west is not a box — and it is what `fitBounds` reads.
		const { fetch } = answering([result({ boundingbox: ['-18', '-16', '177', '-179'] })]);

		const outcome = await lookUpPlaces('Taveuni', { fetch, service: SERVICE });

		expect(outcome.kind === 'places' && outcome.places[0]?.bounds).toEqual({
			west: 177,
			south: -18,
			east: 181,
			north: -16
		});
	});

	it('reports a service that answered with nothing as none, not as a failure', async () => {
		const { fetch } = answering([]);

		await expect(lookUpPlaces('Nowhere at all', { fetch, service: SERVICE })).resolves.toEqual({
			kind: 'none'
		});
	});

	it('reports a status that is not a success as unanswered', async () => {
		const { fetch } = answering([result()], 503);

		await expect(lookUpPlaces('Springfield', { fetch, service: SERVICE })).resolves.toEqual({
			kind: 'unanswered'
		});
	});

	it('reports a fetch that rejects as unanswered rather than throwing', async () => {
		const fetch: FetchFn = () => Promise.reject(new TypeError('Failed to fetch'));

		await expect(lookUpPlaces('Springfield', { fetch, service: SERVICE })).resolves.toEqual({
			kind: 'unanswered'
		});
	});

	it('reports a body that is not JSON as unanswered', async () => {
		const fetch: FetchFn = async () => new Response('<html>a login page</html>', { status: 200 });

		await expect(lookUpPlaces('Springfield', { fetch, service: SERVICE })).resolves.toEqual({
			kind: 'unanswered'
		});
	});

	it('reports a payload that is not a list of results as unanswered', async () => {
		// A fork pointed at something that is not a geocoder. It is the instance operator's problem,
		// and a sentence about response schemas would reach the wrong person (ADR-0029).
		const { fetch } = answering({ error: 'unknown parameter' });

		await expect(lookUpPlaces('Springfield', { fetch, service: SERVICE })).resolves.toEqual({
			kind: 'unanswered'
		});
	});

	it('reports results that cannot be read at all as unanswered, not as none', async () => {
		const { fetch } = answering([{ display_name: 'Somewhere' }, { lat: '1', lon: '2' }]);

		await expect(lookUpPlaces('Springfield', { fetch, service: SERVICE })).resolves.toEqual({
			kind: 'unanswered'
		});
	});

	it('drops one unreadable result and keeps the rest', async () => {
		// A candidate with no box cannot be framed on; it is not evidence about the other one.
		const { fetch } = answering([result({ boundingbox: undefined }), result({ lat: '1' })]);

		const outcome = await lookUpPlaces('Springfield', { fetch, service: SERVICE });

		expect(outcome.kind === 'places' && outcome.places.map((place) => place.point.lat)).toEqual([
			1
		]);
	});

	it('gives up on a request that never answers, rather than waiting for the socket', async () => {
		// Without the timeout a hung request leaves the field looking things up for as long as the
		// connection stays open, and a scholar is watching it.
		const fetch: FetchFn = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
			});

		await expect(
			lookUpPlaces('Springfield', { fetch, service: SERVICE, timeoutMs: 1 })
		).resolves.toEqual({ kind: 'unanswered' });
	});

	it('asks nothing at all for a blank query', async () => {
		const { fetch, urls } = answering([result()]);

		await expect(lookUpPlaces('   ', { fetch, service: SERVICE })).resolves.toEqual({
			kind: 'none'
		});
		expect(urls).toEqual([]);
	});
});

describe('the configured service', () => {
	it('escapes the query into the URL it builds', async () => {
		// The host itself is deliberately not named here: `service.ts` is the one module that may.
		expect(PLACE_SERVICE.searchUrl('Boston Common & the Public Garden')).toContain(
			'Boston%20Common%20%26%20the%20Public%20Garden'
		);
	});

	it('carries the credit its own answers need', () => {
		expect(PLACE_SERVICE.attribution.text).not.toBe('');
	});
});
