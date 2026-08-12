import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from './test.js';

// Driving the place lookup from a committed fixture (ADR-0029).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE HOST IS NOT NAMED HERE, AND WHAT IS MATCHED INSTEAD
//
// The service URL lives in `packages/core/src/places/service.ts` and in no other module, so that a
// fork repointing the lookup edits one file. A harness that hardcoded the host would be a second
// place to edit — and the one nobody would think to look in — so the match is on the request's
// **path**, which is a property of every geocoder's search endpoint rather than of this one's
// address. `support/editor-deployment.ts` matches `/\.pmtiles$/` for the same reason.
//
// ⚠ **The fixture is one captured real response**, for a query with several candidates, so that
// disambiguation is exercised against real data rather than two hand-written entries that are always
// unambiguous. A fixture is a snapshot of an assumption, and the hand-run check that would notice
// when the service's shape moves under it **is not written yet** (ticket 04) — so at present nothing
// anywhere would say that this file had stopped describing the service.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = path.join(repoRoot, 'e2e/fixtures/places/springfield.json');

/** The query the committed fixture is a real answer to. Several candidates, deliberately. */
export const AMBIGUOUS_QUERY = 'Springfield';

/** Whether a request is a lookup. The endpoint, not the host — see the note above. */
const isPlaceLookup = (url: URL): boolean => url.pathname.endsWith('/search');

/** The captured response, as text. */
async function placeFixture(): Promise<string> {
	return readFile(fixture, 'utf8');
}

/**
 * The committed fixture's first candidate, **moved to a point a test already knows**.
 *
 * ⚠ **What the byte-identity claim needs, and the only reason it is honest.** A Pin placed from a
 * lookup is asserted byte-identical to one drawn by hand with the same title, and two files whose
 * coordinates differ cannot be compared byte for byte at all — so the hand-drawn Pin goes first, its
 * written coordinates are read back out of OPFS, and the service is made to answer with exactly
 * those. Anything left over from the real capture is still the real capture's: this moves a
 * candidate, it does not invent one.
 *
 * The bounding box is a small one around the point rather than the fixture's, so the framing that
 * follows the placement lands on the Pin instead of on Illinois.
 */
export async function candidateAt(point: {
	readonly lng: number;
	readonly lat: number;
}): Promise<string> {
	const [first] = JSON.parse(await placeFixture()) as Record<string, unknown>[];
	return JSON.stringify([
		{
			...first,
			lat: String(point.lat),
			lon: String(point.lng),
			boundingbox: [
				String(point.lat - 0.01),
				String(point.lat + 0.01),
				String(point.lng - 0.01),
				String(point.lng + 0.01)
			]
		}
	]);
}

/** The routed service: what it has been asked, and what it answers next. */
export type PlaceLookupService = {
	/** How many lookups have been requested. The measurement "typing issues no request" rests on. */
	count(): number;
	/** The `q` of each lookup, in order. */
	queries(): string[];
	/** Answer everything from here on with this body and status, instead of the fixture. */
	answerWith(body: string, status?: number): void;
	/** Go back to answering with the committed fixture, as this service began. */
	answerFromFixture(): Promise<void>;
};

/**
 * Route every place lookup to the committed fixture.
 *
 * Takes a `Page` or a `BrowserContext`, because both carry `route` with the same contract and the
 * choice is per-suite.
 */
export async function routePlaceLookup(target: Pick<Page, 'route'>): Promise<PlaceLookupService> {
	let body = await placeFixture();
	let status = 200;
	const queries: string[] = [];

	await target.route(isPlaceLookup, async (route) => {
		queries.push(new URL(route.request().url()).searchParams.get('q') ?? '');
		await route.fulfill({
			status,
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'access-control-allow-origin': '*'
			},
			body
		});
	});

	return {
		count: () => queries.length,
		queries: () => [...queries],
		answerWith: (next, nextStatus = 200) => {
			body = next;
			status = nextStatus;
		},
		answerFromFixture: async () => {
			body = await placeFixture();
			status = 200;
		}
	};
}
