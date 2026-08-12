// A submitted query goes out, and Places or a sentence comes back (ADR-0029).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// SUBMIT-ONLY, AND WHY THAT IS RECORDED AS CONTINGENT
//
// Nothing here is debounced, throttled, or called from a keystroke, and the surfaces above it call
// it on submit alone. **That is what the default service requires, not a claim that
// search-as-you-type is wrong**: Nominatim's policy states that autocomplete "is not yet supported
// by Nominatim and you must not implement such a service on the client side using the API", partly
// because its index parses complete, structured queries and answers a partial token badly.
//
// Photon exists precisely for search-as-you-type over the same OpenStreetMap data, and a fork
// pointing `service.ts` at one would be doing something entirely legitimate. So a maintainer who
// swaps the service is looking at a fence that was a **consequence of this service** and may be
// re-opened deliberately, rather than at a rule whose reason has been lost.
//
// The rate limiter below is what holds that fence up on the implementer's own machine: an
// autocomplete built on top of this visibly does not work, the first time it is tried, without
// anybody having to read this comment.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// OUTCOMES ARE VALUES
//
// Nothing here throws. A caller that had to wrap this in a `try` would be a caller deciding what a
// failed lookup means, in a component, next to the one that got it right — which is how "no results
// for Boston Common" comes to be shown for a request that never left the building. The four
// outcomes are told apart by evidence and rendered by `placeLookupNotice`.

import type { FetchFn } from '../injection/store-image-fetch.js';
import type { GeoBounds } from '../project/opening-view.js';
import type { LookupOutcome, Place, PlaceService } from './place';
import { PLACE_SERVICE } from './service';

/** How long a lookup waits before calling the service unanswered. A person is watching a field. */
export const PLACE_LOOKUP_TIMEOUT_MS = 10_000;

/** The shortest gap between two requests. The default service's policy: one a second, absolutely. */
export const PLACE_LOOKUP_MIN_INTERVAL_MS = 1_000;

/**
 * What decides whether a request may go out at all.
 *
 * **Per tab**, because that is what a module holding a timestamp can honestly be, and ADR-0029
 * accepts the hole: two tabs can exceed one request a second, and a scholar with two tabs open is
 * not the abuse case the service's policy is written against. Closing it would need coordination
 * between tabs, which is a great deal of machinery for a case that is not the problem.
 */
export interface LookupRateLimiter {
	/** Whether a request may go out now — and, when it may, that it is going out. */
	admit(): boolean;
}

/**
 * A limiter refusing a second request inside {@link PLACE_LOOKUP_MIN_INTERVAL_MS}.
 *
 * @param now the clock, injected for the same reason `fetch` is: a test asserting that a request was
 *   refused should not have to spend a real second to do it.
 */
export function createLookupRateLimiter(now: () => number = Date.now): LookupRateLimiter {
	let issuedAt: number | null = null;
	return {
		admit() {
			const at = now();
			if (issuedAt !== null && at - issuedAt < PLACE_LOOKUP_MIN_INTERVAL_MS) return false;
			issuedAt = at;
			return true;
		}
	};
}

/** The one every surface shares, so two search fields in a tab cannot each have their own second. */
let sharedLimiter = createLookupRateLimiter();

/**
 * Stand another limiter in for the shared one, and hand back the restore.
 *
 * ⚠ **The seam a test of the *default* path needs.** The shared limiter is module state paced by the
 * real clock, so without this the only way to watch it refuse anything is to make two calls inside a
 * real second — an assertion about a rate limiter that a garbage collection pause can turn red — and
 * whatever second a test left on it would go on pacing the next test that reached the default.
 */
export function withSharedLookupRateLimiter(limiter: LookupRateLimiter): () => void {
	const previous = sharedLimiter;
	sharedLimiter = limiter;
	return () => {
		sharedLimiter = previous;
	};
}

export interface LookUpPlacesOptions {
	/** How the request is made. Injected so tests hand it an answer rather than reach a service. */
	readonly fetch?: FetchFn;
	/** Which service answers. Defaults to this deployment's (`service.ts`). */
	readonly service?: PlaceService;
	/** How long to wait for an answer. Defaults to {@link PLACE_LOOKUP_TIMEOUT_MS}. */
	readonly timeoutMs?: number;
	/**
	 * What paces the requests. Defaults to the one this tab shares between its surfaces.
	 *
	 * **Package-internal.** `LookupRateLimiter` is deliberately not exported from `places/index.ts`,
	 * so nothing outside this package can build a value for it: the pace is the service's policy and
	 * not a consumer's choice. The tests in this directory are the only callers that pass one.
	 */
	readonly limiter?: LookupRateLimiter;
}

/**
 * Ask the configured service about a **submitted** query.
 *
 * A blank query is answered `none` without a request: there is nothing to ask about, and asking
 * would spend one of the service's requests to be told so — which is also why it is answered before
 * the limiter is consulted, rather than counting against a second that had a real search in it.
 */
export async function lookUpPlaces(
	query: string,
	options: LookUpPlacesOptions = {}
): Promise<LookupOutcome> {
	const asked = query.trim();
	if (asked === '') return { kind: 'none' };

	// Refused here, before anything is built: `too-fast` means **no request went out**, which is the
	// whole of what makes this a limiter rather than a message about one.
	if (!(options.limiter ?? sharedLimiter).admit()) return { kind: 'too-fast' };

	const service = options.service ?? PLACE_SERVICE;
	const request = options.fetch ?? ((input, init) => fetch(input, init));
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? PLACE_LOOKUP_TIMEOUT_MS);

	let payload: unknown;
	try {
		const response = await request(service.searchUrl(asked), { signal: abort.signal });
		// The service saying we asked too often, which is the same fact our own limiter produces and
		// therefore the same outcome and the same sentence. Everything else that is not a success is
		// *did not answer*: a scholar can do nothing about a `500` and nothing about a `403`.
		if (response.status === 429) return { kind: 'too-fast' };
		if (!response.ok) return { kind: 'unanswered' };
		payload = await response.json();
	} catch {
		// A rejected fetch, a timeout, a body that is not JSON. Each is the same fact from the
		// scholar's side — the service did not answer — and a sentence about response schemas would
		// reach the wrong person entirely (ADR-0029).
		return { kind: 'unanswered' };
	} finally {
		clearTimeout(timer);
	}

	if (!Array.isArray(payload)) return { kind: 'unanswered' };
	if (payload.length === 0) return { kind: 'none' };

	const places = payload.map(readPlace).filter((place): place is Place => place !== null);
	// The service answered with results and **none of them could be read**, which is a service that
	// is not the geocoder this deployment thinks it is. That is the instance operator's problem, so
	// it folds into "did not answer" rather than being reported as an empty result.
	if (places.length === 0) return { kind: 'unanswered' };
	return { kind: 'places', places };
}

/**
 * One result as a {@link Place}, or `null` when it is not one.
 *
 * ⚠ **These four fields are the whole of what this application depends on**, and they are what the
 * hand-run service check will ask the live service about when it exists (ticket 04, not yet
 * written — a fixture is a snapshot of an assumption, and nothing here notices when the service's
 * shape moves under it). The service answers a great deal more —
 * `place_id`, `osm_type`, `importance`, `licence` — and none of it is read, because none of it
 * survives into a Project.
 *
 * A single unreadable entry is dropped rather than failing the whole answer: a result missing a
 * bounding box is one candidate that cannot be framed on, not evidence about the other nine.
 */
function readPlace(entry: unknown): Place | null {
	if (typeof entry !== 'object' || entry === null) return null;
	const record = entry as Record<string, unknown>;
	const name = record['display_name'];
	const lat = degrees(record['lat']);
	const lng = degrees(record['lon']);
	const bounds = readBounds(record['boundingbox']);
	if (typeof name !== 'string' || name === '' || lat === null || lng === null || bounds === null) {
		return null;
	}
	return { name, point: { lng, lat }, bounds };
}

/**
 * `[south, north, west, east]`, which is the order Nominatim writes a bounding box in and is not the
 * order {@link GeoBounds} is written in.
 *
 * An `east` numerically west of its `west` is a box crossing the antimeridian, and {@link GeoBounds}
 * says such a box carries an `east` **above 180** rather than a wrapped one — a box whose east is
 * west of its west is not a box, and MapLibre's `fitBounds` reads it as this case.
 */
function readBounds(value: unknown): GeoBounds | null {
	if (!Array.isArray(value) || value.length !== 4) return null;
	const south = degrees(value[0]);
	const north = degrees(value[1]);
	const west = degrees(value[2]);
	const east = degrees(value[3]);
	if (south === null || north === null || west === null || east === null) return null;
	return { west, south, east: east >= west ? east : east + 360, north };
}

/** A coordinate, which this service sends as a string. `null` for anything that is not a number. */
function degrees(value: unknown): number | null {
	const parsed =
		typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	return Number.isFinite(parsed) ? parsed : null;
}
