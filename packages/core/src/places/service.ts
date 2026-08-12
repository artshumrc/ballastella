import type { PlaceService } from './place';

// ┌───────────────────────────────────────────────────────────────────────────────────────┐
// │ THE PLACE LOOKUP SERVICE. This module is deployment configuration (ADR-0029).         │
// │                                                                                       │
// │ Repointing the lookup must require **no change** anywhere else in the repository, and  │
// │ the service's attribution moves with it — which is the whole reason the two sit in one │
// │ value (SPEC stories 26 and 27). A fork that repointed the Base Map catalog at its own  │
// │ tiles and kept the default lookup would otherwise show the wrong credit and leave the  │
// │ candidate list's data uncredited.                                                      │
// │                                                                                       │
// │ So: change this file, and nothing else. No other module may name the service host.     │
// │                                                                                       │
// │ ⚠ **That last sentence is asserted by nobody yet.** `base-map/catalog.ts` has           │
// │ `scripts/check-base-map-catalog.mjs` failing `pnpm lint` on any module that names an    │
// │ entry; the equivalent containment scan for this host is ticket 04's and is not written,  │
// │ so at present the property is held by hand — and by the tests, which drive every lookup  │
// │ function from a service that is not this one.                                           │
// │                                                                                       │
// │ ⚠ **The address is here; the response *shape* is read in `lookup.ts`.** A fork running  │
// │ its own instance of the same software changes this line only, which is the case         │
// │ ADR-0029 is written about. A fork pointing at a service that answers a different         │
// │ document has to teach `readPlace` that document too — said here rather than left to be   │
// │ discovered, because "change this file and nothing else" would otherwise overclaim.       │
// └───────────────────────────────────────────────────────────────────────────────────────┘

/**
 * OpenStreetMap's own Nominatim, which is **borrowed**.
 *
 * Its usage policy permits this application's use and names its conditions: an absolute maximum of
 * one request per second, no bulk or systematic querying, displayed attribution, and **no
 * client-side autocomplete** — `lookup.ts` holds that last one and carries the whole argument for
 * why the fence is contingent on this service.
 *
 * A deployment that wants a lookup it controls should point this at its own service, which is a
 * change to this value and nothing else. ADR-0029 has `pnpm check:deployment` **warn and stay
 * green** about this one, unlike the Base Map archive it refuses outright — the asymmetry being
 * that repointing an archive is putting a file in a bucket, while repointing this means running a
 * planet-scale geocoder, and a check that fails with a remedy nobody can take is one people learn
 * to route around. ⚠ **That warning is not written yet** (ticket 04), so at present nothing in the
 * deployment check mentions this dependency at all.
 *
 * `jsonv2` is asked for by name rather than taken as a default, because the fields read in
 * `lookup.ts` — `display_name`, `lat`, `lon`, `boundingbox` — are that format's.
 */
const SERVICE_ORIGIN = 'https://nominatim.openstreetmap.org';

/** How many candidates are asked for. Enough to disambiguate a Springfield; not a page of results. */
const CANDIDATE_LIMIT = 10;

export const PLACE_SERVICE: PlaceService = {
	searchUrl: (query) =>
		`${SERVICE_ORIGIN}/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=${CANDIDATE_LIMIT}`,
	attribution: {
		// ODbL makes this a licence condition rather than a courtesy, and it is the lookup's own
		// credit — the Base Map catalog's attribution says nothing about where these candidates
		// came from.
		text: '© OpenStreetMap contributors',
		href: 'https://openstreetmap.org/copyright'
	}
};
