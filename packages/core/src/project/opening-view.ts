// The view a Project opens on, computed from what that Project has placed on the earth (ADR-0026).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A PURE FUNCTION IN `core` AND NOT A RENDERER QUESTION
//
// An aligned Historical Map's geographic extent is its **Resource Mask** put through the same
// `GcpTransformer` the renderer solves with — not its Control Points' extent, which understates the
// sheet by however much of it lies outside the points, and not the drawn layer's own bounds, which
// would mean waiting for an asynchronous render before the map could be framed. `@allmaps/transform`
// is already a direct dependency and already used by `alignment/distortion.ts`, so the whole
// computation runs in Node, is asserted numerically by `opening-view.test.ts`, and is shared by the
// editor and the published viewer (ADR-0019) — which is the only way a Published Site can open the
// same way the editor does.
//
// **Nothing here is reactive and nothing here is written.** ADR-0026's fit happens once, on open; the
// callers own that, and the deliberate absence of any store or clock in this module is what keeps
// "opening a Project modifies no byte" (ADR-0010) true of the opening view too.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ANTIMERIDIAN, DECIDED
//
// Longitudes are points on a circle, so "the bounding box" of a set of them is ambiguous: a map in
// Japan and a map in California are 98° apart across the Pacific and 262° apart the other way, and
// `Math.min`/`Math.max` picks the second — a first sight of the whole planet with the work at both
// edges. **The box is the shortest arc containing every longitude**, found by taking the widest
// *empty* gap between neighbouring longitudes and keeping its complement.
//
// When that arc crosses ±180° the box is expressed with an `east` **above 180** — Tokyo to San
// Francisco is `west: 139.77, east: 237.58` — rather than wrapped back into range. That is not a
// convenience: a box whose `east` is numerically west of its `west` is not a box, and MapLibre's
// `fitBounds` reads longitudes beyond 180 as exactly this case. {@link GeoBounds} says so in its type.
//
// Two consequences worth knowing before changing this. Content genuinely spread over more than half
// the planet is framed on the *complement* of its widest gap, which is the same rule and is the
// right answer for "three cities on three continents" but is not the whole world. And when two gaps
// tie exactly — antipodal content — the wrap gap wins, so the box is the eastward one; nothing
// distinguishes the two answers, and a deterministic choice beats an arbitrary one.

import { GcpTransformer } from '@allmaps/transform';

import { canSolve, type Alignment } from '../alignment/alignment.js';
import type { AnnotationCollection, AnnotationGeometry } from '../annotation/annotation.js';
import type { ResourcePoint } from '../image-pane/synthetic-projection.js';
import type { Layer } from './layer.js';

/**
 * A box on the earth, in degrees.
 *
 * `east` is **greater than `west` and may exceed 180**, which is how a box that crosses the
 * antimeridian is said — see the note at the top of this file. `west` is always in `[-180, 180)`.
 */
export interface GeoBounds {
	readonly west: number;
	readonly south: number;
	/** Greater than or equal to {@link west}. Above 180 when the box crosses the antimeridian. */
	readonly east: number;
	readonly north: number;
}

/**
 * One Layer of a Project with the documents that give it a place on the earth.
 *
 * The documents are read by the caller, for the same reason `DrawnLayer`'s are: reaching the store
 * is the app's business, and this module has to run in Node. **Both are optional and `null` is
 * ordinary** — a Historical Map nobody has aligned yet, or an Annotation Layer nobody has drawn in,
 * simply contributes nothing.
 *
 * Unlike the drawn stack, hidden Layers belong in this list. Hiding everything must not make a
 * Project open on the deployment default (ADR-0026), so visibility is read off `layer` here rather
 * than expressed by absence.
 */
export interface ContentLayer {
	readonly layer: Layer;
	/** The Alignment a map Layer draws, or `null`/absent when it has none. */
	readonly alignment?: Alignment | null;
	/** The Annotations an Annotation Layer draws, or `null`/absent when it has none. */
	readonly annotations?: AnnotationCollection | null;
}

/**
 * The furthest in the opening fit will go.
 *
 * A Project whose only content is one pin has a zero-area box, and fitting to zero area goes to the
 * map's maximum zoom — a first sight of four roof tiles, with no way to tell that anything is even
 * being shown. z16 is a neighbourhood: the pin is in a place a reader can recognise.
 */
export const OPENING_VIEW_MAX_ZOOM = 16;

/** Pixels of breathing room around the content, so nothing sits against the edge of the pane. */
export const OPENING_VIEW_PADDING = 48;

/**
 * How to frame a map on {@link GeoBounds}. The shape MapLibre's `fitBounds` takes, minus MapLibre.
 *
 * Carried as data rather than applied here because this module must stay free of `maplibre-gl` — the
 * barrel it is exported from is evaluated in Node during both apps' prerender (see the note at the
 * bottom of `src/index.ts`). It also means the editor and the published viewer cannot cap or pad
 * differently: there is one object, built in one place.
 */
export interface OpeningViewFit {
	/** `[[west, south], [east, north]]`, MapLibre's `LngLatBoundsLike`. */
	readonly bounds: [[number, number], [number, number]];
	readonly padding: number;
	readonly maxZoom: number;
	/** Always `false`. ADR-0026's fit lands; it does not fly (nothing was on screen to fly from). */
	readonly animate: false;
}

/** {@link OpeningViewFit} for a box. */
export function openingViewFit(bounds: GeoBounds): OpeningViewFit {
	return {
		bounds: [
			[bounds.west, bounds.south],
			[bounds.east, bounds.north]
		],
		padding: OPENING_VIEW_PADDING,
		maxZoom: OPENING_VIEW_MAX_ZOOM,
		animate: false
	};
}

/**
 * Where a Project's own work is, or `null` when it has none on the earth.
 *
 * **The fallback chain is visible Layers → all Layers → nothing** (ADR-0026). `null` is the caller's
 * cue to leave the map where the deployment put it — `BASE_MAP_CATALOG.initialView` in the editor,
 * the Published Site's own catalog in the viewer — so a brand-new Project opens somewhere deliberate
 * rather than at 0°, 0°.
 *
 * Pure, and called **once, on open**. A `$derived` over this is the bug ADR-0026 names: the map would
 * jump away from wherever the user had put it every time a Layer was toggled or an Annotation moved.
 */
export function projectOpeningBounds(content: readonly ContentLayer[]): GeoBounds | null {
	const visible = boundsOf(content.filter((entry) => entry.layer.visible).flatMap(placesOf));
	return visible ?? boundsOf(content.flatMap(placesOf));
}

/**
 * Where the alignment view opens: on the Alignment being worked on, or on the Project around it.
 *
 * The Alignment's **Control Points** rather than its Resource Mask, and that is the difference from
 * {@link projectOpeningBounds}: the mask is where the sheet has *ended up*, and what somebody
 * returning to a half-finished Alignment needs is where they were *working* — which with two points
 * placed is a couple of streets, and with a mask is the whole warped sheet flung across a continent
 * by an under-determined solve.
 *
 * One point is enough, and gives a zero-area box the zoom cap resolves. Falling through to the
 * Project only when there are none at all is what makes reopening land where the work was left.
 */
export function alignmentOpeningBounds(
	alignment: Alignment | null,
	content: readonly ContentLayer[]
): GeoBounds | null {
	const points = (alignment?.controlPoints ?? []).map(
		(point) => [point.geo.lng, point.geo.lat] as const
	);
	return boundsOf(points) ?? projectOpeningBounds(content);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// What a Layer puts on the earth

/** Every `[lng, lat]` one Layer's documents place on the earth. Empty for a Layer with no place. */
function placesOf(entry: ContentLayer): (readonly [number, number])[] {
	const places: (readonly [number, number])[] = [];
	if (entry.alignment) places.push(...alignedSheetRing(entry.alignment));
	if (entry.annotations) {
		for (const annotation of entry.annotations.annotations) {
			places.push(...geometryPlaces(annotation.geometry));
		}
	}
	return places;
}

/**
 * The Resource Mask put through the Alignment's own transformation, or nothing.
 *
 * Nothing when there are too few Control Points for the transformation type to be solved, and
 * nothing when the solve throws — `detectFold` declines the same case for the same reason: a claim
 * the measurement does not support is worse than no claim, and here it would be a Project that opens
 * somewhere arbitrary.
 *
 * **Nothing, too, when a corner comes back off the earth**, and that is not defensive tidying.
 * Collinear or coincident Control Points make a singular system that upstream solves *without
 * throwing*: three points on a diagonal all mapped to one place turn a 1000 × 800 sheet into
 * `[-71.1, 42.3], [428.9, -207.7], [28.9, 192.3], [-471.1, 442.3]` — latitudes that do not exist.
 * Dropping only the impossible corners would leave a box built from whichever ones happened to
 * survive, which is the plausible wrong answer this whole module is written to avoid. The whole
 * sheet is declined instead, and the Project falls back to whatever else it has.
 *
 * Passed as a **polygon** rather than as loose points, so that upstream's refinement bends the mask's
 * *edges* the way the warp does. Under `thinPlateSpline` an edge can bow well outside the quadrilateral
 * its corners describe, and a box built from four corners would then cut the sheet.
 */
function alignedSheetRing(alignment: Alignment): (readonly [number, number])[] {
	if (!canSolve(alignment)) return [];
	if (alignment.resourceMask.length === 0) return [];
	let ring: [number, number][];
	try {
		const transformer = new GcpTransformer(
			alignment.controlPoints.map((point) => ({
				resource: [point.resource.x, point.resource.y] as [number, number],
				geo: [point.geo.lng, point.geo.lat] as [number, number]
			})),
			alignment.transformationType
		);
		ring = transformer
			.transformToGeo([
				alignment.resourceMask.map(
					(vertex: ResourcePoint) => [vertex.x, vertex.y] as [number, number]
				)
			])
			.flat();
	} catch {
		return [];
	}
	// A longitude outside ±180 is ordinary — a sheet near the antimeridian has them, and
	// `normaliseLongitude` is what they are for. A latitude outside ±90 is not a place.
	return ring.every(
		([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90
	)
		? ring
		: [];
}

/** The `[lng, lat]` positions in one Annotation's geometry. Empty for a kind this build cannot read. */
function geometryPlaces(geometry: AnnotationGeometry): (readonly [number, number])[] {
	// A `foreign` geometry carries its coordinates in a shape this build has never parsed, and a
	// `null` geometry is an Annotation with no place at all (RFC 7946 permits it). Guessing at either
	// is how a Project ends up framed on a MultiPolygon's `crs` block.
	if (geometry === null) return [];
	switch (geometry.type) {
		case 'Point':
			return [geometry.coordinates];
		case 'LineString':
			return [...geometry.coordinates];
		case 'Polygon':
			return geometry.coordinates.flat();
		case 'foreign':
			return [];
	}
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The box

/**
 * `lng` in `[-180, 180)`, whatever it arrived as.
 *
 * The already-in-range case returns the number untouched rather than running it through the
 * modulus, because `(((4.9041 + 180) % 360) + 360) % 360 - 180` is `4.904099999999971`. That is
 * invisible on a map and highly visible in a test, and a box whose edges are not the coordinates
 * that produced them is a box nothing can be asserted about exactly.
 */
function normaliseLongitude(lng: number): number {
	if (lng >= -180 && lng < 180) return lng;
	return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * The box containing every position, or `null` when there are none.
 *
 * Positions that are not finite numbers are dropped rather than propagated: a truncated or
 * hand-edited GeoJSON puts a `NaN` in here, and one `NaN` reaching `fitBounds` moves the map nowhere
 * at all and logs nothing — the failure that looks exactly like the feature not existing.
 */
function boundsOf(places: readonly (readonly [number, number])[]): GeoBounds | null {
	const usable = places.filter(
		([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90
	);
	if (usable.length === 0) return null;

	const lats = usable.map(([, lat]) => lat);
	const { west, east } = longitudeSpan(usable.map(([lng]) => lng));
	return { west, south: Math.min(...lats), east, north: Math.max(...lats) };
}

/**
 * The shortest arc of longitude containing every one of `longitudes` — see the note at the top of
 * this file for why this is not `Math.min`/`Math.max`.
 */
function longitudeSpan(longitudes: readonly number[]): { west: number; east: number } {
	const sorted = [...new Set(longitudes.map(normaliseLongitude))].sort((a, b) => a - b);
	const first = sorted[0] as number;
	const last = sorted[sorted.length - 1] as number;

	// The gap that wraps past the antimeridian, from the eastmost longitude round to the westmost. It
	// is the starting candidate, so a tie between it and any other gap leaves the box eastward.
	let widest = first + 360 - last;
	let startsAfter = sorted.length - 1;
	for (let index = 0; index < sorted.length - 1; index += 1) {
		const gap = (sorted[index + 1] as number) - (sorted[index] as number);
		if (gap > widest) {
			widest = gap;
			startsAfter = index;
		}
	}

	// Both edges are longitudes the content actually has, so a box that does not cross the
	// antimeridian comes back with exactly the numbers that went in. Deriving `east` from `widest`
	// instead — `west + 360 - widest` — is the same value in exact arithmetic and drifts by a
	// hundred-billionth of a degree in this one, which makes every assertion approximate.
	const west = sorted[(startsAfter + 1) % sorted.length] as number;
	const east = sorted[startsAfter] as number;
	return { west, east: east >= west ? east : east + 360 };
}
