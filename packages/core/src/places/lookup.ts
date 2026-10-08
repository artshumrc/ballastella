import type { FetchFn } from '../injection/store-image-fetch.js';
import type { GeoBounds } from '../project/opening-view.js';
import { asRecord } from '../store/project-store.js';
import type { LookupOutcome, Place, PlaceService } from './place';
import { PLACE_SERVICE } from './service';

const PLACE_LOOKUP_TIMEOUT_MS = 10_000;
export const PLACE_LOOKUP_MIN_INTERVAL_MS = 1_000;

interface LookupRateLimiter {
	admit(): boolean;
}

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

let sharedLimiter = createLookupRateLimiter();

export function withSharedLookupRateLimiter(limiter: LookupRateLimiter): () => void {
	const previous = sharedLimiter;
	sharedLimiter = limiter;
	return () => {
		sharedLimiter = previous;
	};
}

export interface LookUpPlacesOptions {
	readonly fetch?: FetchFn;
	readonly service?: PlaceService;
	readonly timeoutMs?: number;
	readonly limiter?: LookupRateLimiter;
}

export async function lookUpPlaces(
	query: string,
	options: LookUpPlacesOptions = {}
): Promise<LookupOutcome> {
	const asked = query.trim();
	if (asked === '') return { kind: 'none' };

	if (!(options.limiter ?? sharedLimiter).admit()) return { kind: 'too-fast' };
	const service = options.service ?? PLACE_SERVICE;
	const request = options.fetch ?? ((input, init) => fetch(input, init));
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? PLACE_LOOKUP_TIMEOUT_MS);
	let payload: unknown;
	try {
		const response = await request(service.searchUrl(asked), { signal: abort.signal });
		if (response.status === 429) return { kind: 'too-fast' };
		if (!response.ok) return { kind: 'unanswered' };
		payload = await response.json();
	} catch {
		return { kind: 'unanswered' };
	} finally {
		clearTimeout(timer);
	}

	if (!Array.isArray(payload)) return { kind: 'unanswered' };
	if (payload.length === 0) return { kind: 'none' };
	const places = payload.map(readPlace).filter((place): place is Place => place !== null);
	if (places.length === 0) return { kind: 'unanswered' };
	return { kind: 'places', places };
}

function readPlace(entry: unknown): Place | null {
	const record = asRecord(entry);
	if (record === null) return null;
	const name = record['display_name'];
	const lat = degrees(record['lat']);
	const lng = degrees(record['lon']);
	const bounds = readBounds(record['boundingbox']);
	if (typeof name !== 'string' || name === '' || lat === null || lng === null || bounds === null) {
		return null;
	}
	return { name, point: { lng, lat }, bounds };
}

function readBounds(value: unknown): GeoBounds | null {
	if (!Array.isArray(value) || value.length !== 4) return null;
	const south = degrees(value[0]);
	const north = degrees(value[1]);
	const west = degrees(value[2]);
	const east = degrees(value[3]);
	if (south === null || north === null || west === null || east === null) return null;
	return { west, south, east: east >= west ? east : east + 360, north };
}

function degrees(value: unknown): number | null {
	const parsed =
		typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	return Number.isFinite(parsed) ? parsed : null;
}
