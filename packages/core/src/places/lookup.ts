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
// ─────────────────────────────────────────────────────────────────────────────────────────────
// OUTCOMES ARE VALUES
//
// Nothing here throws. A caller that had to wrap this in a `try` would be a caller deciding what a
// failed lookup means, in a component, next to the one that got it right — which is how "no results
// for Boston Common" comes to be shown for a request that never left the building. The three
// outcomes are told apart by evidence and rendered by `placeLookupNotice`.

import type { FetchFn } from '../injection/store-image-fetch.js';
import type { GeoBounds } from '../project/opening-view.js';
import type { LookupOutcome, Place, PlaceService } from './place';
import { PLACE_SERVICE } from './service';

/** How long a lookup waits before calling the service unanswered. A person is watching a field. */
export const PLACE_LOOKUP_TIMEOUT_MS = 10_000;

export interface LookUpPlacesOptions {
	/** How the request is made. Injected so tests hand it an answer rather than reach a service. */
	readonly fetch?: FetchFn;
	/** Which service answers. Defaults to this deployment's (`service.ts`). */
	readonly service?: PlaceService;
	/** How long to wait for an answer. Defaults to {@link PLACE_LOOKUP_TIMEOUT_MS}. */
	readonly timeoutMs?: number;
}

/**
 * Ask the configured service about a **submitted** query.
 *
 * A blank query is answered `none` without a request: there is nothing to ask about, and asking
 * would spend one of the service's requests to be told so.
 */
export async function lookUpPlaces(
	query: string,
	options: LookUpPlacesOptions = {}
): Promise<LookupOutcome> {
	const asked = query.trim();
	if (asked === '') return { kind: 'none' };

	const service = options.service ?? PLACE_SERVICE;
	const request = options.fetch ?? ((input, init) => fetch(input, init));
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? PLACE_LOOKUP_TIMEOUT_MS);

	let payload: unknown;
	try {
		const response = await request(service.searchUrl(asked), { signal: abort.signal });
		// Every status that is not a success is *did not answer*, including a `429`. That is a
		// simplification this slice can afford and the rate limiter removes: ADR-0029 gives `429` its
		// own outcome, with a remedy the scholar can act on.
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
