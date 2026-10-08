import type { GeoPoint } from '../alignment/alignment.js';
import type { GeoBounds } from '../project/opening-view.js';

export interface Place {
	readonly name: string;
	readonly point: GeoPoint;
	readonly bounds: GeoBounds;
}

export type LookupOutcome =
	| { readonly kind: 'places'; readonly places: readonly Place[] }
	| { readonly kind: 'none' }
	| { readonly kind: 'unanswered' }
	| { readonly kind: 'too-fast' };

interface PlaceAttribution {
	readonly text: string;
	readonly href: string | null;
}

export interface PlaceService {
	readonly searchUrl: (query: string) => string;
	readonly attribution: PlaceAttribution;
}
