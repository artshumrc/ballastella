import type { GeoPoint } from '../alignment/alignment.js';
import type { GeoBounds } from '../project/opening-view.js';

/**
 * One candidate answer to a place name a scholar typed (CONTEXT.md, Place; ADR-0029).
 *
 * **Transient.** Choosing one moves the camera, and nothing about it is written to a Project: a Pin
 * placed from a lookup is byte-identical to a Pin drawn by hand, which is what ADR-0029 exists to
 * protect. There is deliberately no id, no provenance, and no licence carried through — the licence
 * obligation is discharged by {@link PlaceService.attribution} on screen while the candidates are.
 */
export interface Place {
	/** The service's display name — for the candidate list only. Never a Pin's title. */
	readonly name: string;
	/** Where a Pin would go. */
	readonly point: GeoPoint;
	/** Where the camera goes. Never written to any file. */
	readonly bounds: GeoBounds;
}

/**
 * What one submitted query produced, as a **value rather than an exception**.
 *
 * `none` and `unanswered` are the distinction that matters and the one an implementation collapses
 * first, because both end in no candidates: telling a scholar there is no such place when the
 * request never left the building is the inversion `nothing-fails-silently` story 10 forbids. They
 * are told apart here, and by two different sentences in `placeLookupNotice`.
 *
 * Three members, because this is what the lookup can currently produce. ADR-0029 describes a fourth
 * — *too many searches, too fast* — which arrives with the rate limiter; declaring it before
 * anything emits it is the mistake `overlay-points.ts` records, a kind that is styled, promised, and
 * never produced.
 */
export type LookupOutcome =
	| { readonly kind: 'places'; readonly places: readonly Place[] }
	| { readonly kind: 'none' }
	| { readonly kind: 'unanswered' };

/** Who the place data belongs to, as visible text beside the candidates (SPEC story 22). */
export interface PlaceAttribution {
	/** The credit line itself. Plain text, so nothing here is inserted as HTML. */
	readonly text: string;
	/** Where the terms are, or `null` for a service whose credit is not a link. */
	readonly href: string | null;
}

/**
 * The service that answers a place name, and the credit its answers carry.
 *
 * **One value, because repointing one half without the other is a real bug** (ADR-0029): a fork
 * serving its own Base Map tiles while keeping the default lookup would display the wrong credit and
 * leave the lookup's data uncredited. The type is here and the value is in `service.ts`, exactly as
 * `base-map/entry.ts` and `base-map/catalog.ts` are split.
 */
export interface PlaceService {
	/** The whole request URL for a submitted query — the only place a service host is named. */
	readonly searchUrl: (query: string) => string;
	readonly attribution: PlaceAttribution;
}
