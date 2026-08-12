// Place lookup (ADR-0029): a submitted query goes out, and Places or a sentence comes back.
//
// Editor-only in practice — a Published Site never carries a lookup — but here rather than in the
// app because the outcomes, their sentences, and the deployment's own service are all things that
// must be assertable without a browser. `lookup.ts` carries the arguments; this is the door.
// `LookUpPlacesOptions.limiter` is package-internal and stays that way: `LookupRateLimiter` is not
// exported here, because the pace is the service's policy rather than a consumer's choice.
export { lookUpPlaces, type LookUpPlacesOptions } from './lookup';
export { placeLookupNotice } from './notice';
export type { LookupOutcome, Place, PlaceAttribution, PlaceService } from './place';
export { PLACE_SERVICE } from './service';
