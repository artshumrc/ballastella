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
// *empty* gap and keeping its complement.
//
// **Empty is judged against edges, not only against vertices**, and that is not a refinement — it is
// the difference between a right answer and a wrong one. A Polygon Annotation whose corners are at
// ±179 occupies every longitude between them; a rule that saw only the four corners would find a
// 358°-wide "gap" that the polygon's own bottom edge runs straight through, and would frame the
// Project on the 2° sliver at the antimeridian instead of on the world. So a run of positions is
// carried through as a {@link GeoPath} and each segment contributes the arc between its endpoints
// **as written** — `-179 → 179` is the 358° way round, because that is where GeoJSON puts it (RFC
// 7946 §3.1.9 has content that crosses the antimeridian *cut* at it, so an uncut edge does not) and
// because that is where MapLibre draws it. An edge written `170 → 190` is the 20° way, for the same
// reason. Two separate Annotations are not an edge and never join up: Tokyo and San Francisco are
// still framed across the Pacific.
//
// When the arc crosses ±180° the box is expressed with an `east` **above 180** — Tokyo to San
// Francisco is `west: 139.77, east: 237.58` — rather than wrapped back into range. That is not a
// convenience: a box whose `east` is numerically west of its `west` is not a box, and MapLibre's
// `fitBounds` reads longitudes beyond 180 as exactly this case. {@link GeoBounds} says so in its type.
//
// Two consequences worth knowing before changing this. Content genuinely spread over more than half
// the planet is framed on the *complement* of its widest gap, which is the same rule and is the
// right answer for "three cities on three continents" but is not the whole world. And when two gaps
// tie exactly — antipodal content — **the wrap gap wins, so the box is the one that does not cross
// ±180**: content at 0° and 180° opens on `west: -180, east: 0`, and content at ±90° opens on
// `west: -90, east: 90`. Nothing distinguishes the two answers, and a deterministic choice beats an
// arbitrary one. ADR-0026 records the same rule in the same words.

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
 *
 * **An Alignment that parses is placeable content, whatever else about the Layer failed to read.**
 * A sheet whose tiles cannot be fetched still has a place on the earth, and both apps have to agree
 * about that or a Published Site frames a Project differently from the editor that made it — see
 * `apps/viewer/src/lib/project-documents.ts`, where the two once disagreed.
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

/**
 * What the opening view settled on, for the sentence beside the map.
 *
 * Here rather than in either app because both publish that sentence and ADR-0026's whole point is
 * that they answer one question the same way — the viewer used to re-declare this union inline, and
 * a union re-declared is a union that drifts.
 */
export type OpeningViewOutcome = 'pending' | 'content' | 'default';

/**
 * What a live region says about where the map ended up, or `''` while nothing has been settled.
 *
 * A WebGL canvas announces nothing about what it is showing, so "the map jumped to Boston" is
 * otherwise available only to somebody who can see it — and "it did not jump, because this Project
 * has nothing on the earth" is the more useful of the two sentences and the one nobody would guess
 * (SPEC story 112). Here rather than in either app for the same reason {@link OpeningViewOutcome} is:
 * the editor and the Published Site were saying the same thing in two nearly-identical sentences,
 * which is a difference a Reader comparing the two would have to explain to themselves.
 *
 * @param refitted whether the framing was asked for rather than automatic.
 */
export function openingViewSentence(outcome: OpeningViewOutcome, refitted: boolean): string {
	switch (outcome) {
		case 'pending':
			return '';
		case 'content':
			return `${refitted ? 'Framed on' : 'Opened framed on'} this Project’s own content.`;
		case 'default':
			return 'This Project has nothing placed on the earth, so the map is on the default view.';
	}
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
	const visible = boundsOf(content.filter((entry) => entry.layer.visible).flatMap(pathsOf));
	return visible ?? boundsOf(content.flatMap(pathsOf));
}

/**
 * How to frame a map on a Project's content, or `null` when it has none.
 *
 * {@link projectOpeningBounds} and {@link openingViewFit} in one call, because every caller wanted
 * both and each was writing `bounds === null ? null : openingViewFit(bounds)` for itself — four
 * copies across two apps of the one line that decides whether a Project opens on its work or on the
 * deployment default.
 */
export function projectOpeningFit(content: readonly ContentLayer[]): OpeningViewFit | null {
	const bounds = projectOpeningBounds(content);
	return bounds === null ? null : openingViewFit(bounds);
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
	// One path per Control Point, never one path through all of them: Control Points are placed
	// independently and no edge runs between them, so two of them either side of the antimeridian are
	// framed the short way just as two Annotations would be.
	const points = (alignment?.controlPoints ?? []).map((point): GeoPath => [
		[point.geo.lng, point.geo.lat]
	]);
	return boundsOf(points) ?? projectOpeningBounds(content);
}

/** {@link alignmentOpeningBounds} as a fit. See {@link projectOpeningFit}. */
export function alignmentOpeningFit(
	alignment: Alignment | null,
	content: readonly ContentLayer[]
): OpeningViewFit | null {
	const bounds = alignmentOpeningBounds(alignment, content);
	return bounds === null ? null : openingViewFit(bounds);
}

/**
 * As much of MapLibre's `Map` as framing needs. Structural, so this module still imports no renderer.
 */
export interface FittableMap {
	fitBounds(
		bounds: [[number, number], [number, number]],
		options: { padding: number; maxZoom: number; animate: boolean }
	): void;
}

/**
 * Carry out `request` unless it is the one already carried out, and report what is now framed.
 *
 * **Object identity is the guard, and it has to be.** `fitBounds` moves the map, MapLibre's `moveend`
 * is nothing the caller is watching, and the *same* box asked for twice is what "Fit to this Project"
 * pressed twice means — which is precisely the case a user presses it in, having panned away and
 * wanting to come back. Comparing coordinates instead would make the second press do nothing.
 *
 * Shared by both map panes rather than written twice. The editor's `BaseMapPane` and the viewer's
 * `ReaderMapPane` held the same effect verbatim, which is how "the two apps frame a Project the same
 * way" quietly becomes "the two apps framed a Project the same way until one of them was edited".
 *
 * @returns the request now framed, to be kept and passed back as `fitted` next time.
 */
export function applyOpeningFit(
	map: FittableMap | undefined,
	request: OpeningViewFit | null,
	fitted: OpeningViewFit | null
): OpeningViewFit | null {
	if (map === undefined || request === null || request === fitted) return fitted;
	map.fitBounds(request.bounds, {
		padding: request.padding,
		maxZoom: request.maxZoom,
		animate: request.animate
	});
	return request;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// What a Layer puts on the earth

/**
 * A run of positions on the earth, in the order they were written.
 *
 * **Consecutive positions are joined by an edge**, and an edge occupies longitude exactly as its
 * endpoints do — see the antimeridian note at the top of this file for why a bag of vertices is not
 * enough. A single-position path is a place with no edges: a pin, or a Control Point.
 */
type GeoPath = readonly (readonly [number, number])[];

/** Every path one Layer's documents place on the earth. Empty for a Layer with no place. */
function pathsOf(entry: ContentLayer): GeoPath[] {
	const paths: GeoPath[] = [];
	if (entry.alignment) {
		const ring = alignedSheetRing(entry.alignment);
		if (ring.length > 0) paths.push(closedRing(ring));
	}
	if (entry.annotations) {
		for (const annotation of entry.annotations.annotations) {
			paths.push(...geometryPaths(annotation.geometry));
		}
	}
	return paths;
}

/**
 * The Resource Mask put through the Alignment's own transformation, or nothing.
 *
 * Nothing when there are too few Control Points for the transformation type to be solved, and
 * nothing when the solve throws — `detectFold` declines the same case for the same reason: a claim
 * the measurement does not support is worse than no claim, and here it would be a Project that opens
 * somewhere arbitrary.
 *
 * **Nothing, too, when the transformed ring is not a place on the earth**, and that is not defensive
 * tidying. Collinear or coincident Control Points make a singular system that upstream solves
 * *without throwing*, and the nonsense it returns depends on which way the points are collinear.
 * Three on a **diagonal** all mapped to one place turn a 1000 × 800 sheet into
 * `[-71.1, 42.3], [428.9, -207.7], [28.9, 192.3], [-471.1, 442.3]`; three **horizontally** collinear
 * give latitudes 48 → 198.5. Both are caught by the latitude bound. Three **vertically** collinear —
 * `(100,100) → (-71.10, 42.30)`, `(100,200) → (-71.00, 42.35)`, `(100,300) → (-70.90, 42.40)` — give
 * `[-64, 56], [-564, 56], [-563.2, 56.4], [-63.2, 56.4]`: latitudes 56 to 56.4, which are perfectly
 * ordinary places, and longitudes spanning 500.8°. Bounding latitude alone let that one through, and
 * a Boston Project opened on the Bering Strait with nothing said. **So longitude is bounded too**:
 * within a revolution of the prime meridian, and spanning no more than a revolution, because a sheet
 * wider than the earth is not a sheet.
 *
 * Dropping only the impossible corners would leave a box built from whichever ones happened to
 * survive, which is the plausible wrong answer this whole module is written to avoid. **The whole
 * sheet is declined instead, and only the sheet** — the Project keeps every other Layer and falls
 * back to whatever else it has, because one unsolvable Alignment is not a reason to refuse to frame
 * a Project that also has Annotations. That distinction is what makes the guard worth having: a
 * sheet that is *kept* drags the union with it, and no Annotation can rescue the box.
 *
 * Passed as a **polygon** rather than as loose points, and refined, so that upstream bends the mask's
 * *edges* the way the warp does. Under `thinPlateSpline` an edge can bow well outside the
 * quadrilateral its corners describe, and a box built from four corners cuts the sheet — measured on
 * a five-point spline as 0.0025° of longitude and 0.0033° of latitude, a couple of hundred metres of
 * the sheet's own edge left off screen. {@link MASK_REFINEMENT} is what turns that off, and without
 * it `transformToGeo` returns exactly the four corners transformed one at a time.
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
			.transformToGeo(
				[
					alignment.resourceMask.map(
						(vertex: ResourcePoint) => [vertex.x, vertex.y] as [number, number]
					)
				],
				MASK_REFINEMENT
			)
			.flat();
	} catch {
		return [];
	}
	return isAPlace(ring) ? ring : [];
}

/**
 * How far upstream subdivides the mask's edges when transforming them.
 *
 * `maxDepth` defaults to `0`, which is no refinement at all: without this the call returns exactly
 * the vertices it was given, transformed one by one, and the "passed as a polygon" above would be a
 * comment describing a protection that is not configured. Two levels is four segments per edge and
 * captures the bow — a third level moved the measured box by a further 0.0006°, which is 46 m and
 * below the resolution of anything this decides.
 *
 * `minOffsetRatio: 0` is upstream's default and is stated rather than inherited, because it is the
 * whole mechanism: a segment is split only when its transformed midpoint misses the straight line
 * between its transformed endpoints. An **affine** Alignment — `helmert`, `polynomial1` — has no bow
 * to find, so its four-corner mask stays a four-corner mask and pays nothing.
 */
const MASK_REFINEMENT = { maxDepth: 2, minOffsetRatio: 0 } as const;

/**
 * Whether a transformed ring is somewhere on the earth at all. See {@link alignedSheetRing}.
 *
 * A longitude a little outside ±180 is ordinary — a sheet near the antimeridian has them, and the
 * arcs the box is built from carry them. A longitude a whole revolution out, or a ring wider than
 * the planet, or a latitude outside ±90, is a singular solve rather than a place.
 */
function isAPlace(ring: readonly (readonly [number, number])[]): boolean {
	let west = Number.POSITIVE_INFINITY;
	let east = Number.NEGATIVE_INFINITY;
	for (const [lng, lat] of ring) {
		if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
		if (Math.abs(lat) > 90 || Math.abs(lng) > 360) return false;
		west = Math.min(west, lng);
		east = Math.max(east, lng);
	}
	return east - west <= 360;
}

/** The `[lng, lat]` paths in one Annotation's geometry. Empty for a kind this build cannot read. */
function geometryPaths(geometry: AnnotationGeometry): GeoPath[] {
	// A `foreign` geometry carries its coordinates in a shape this build has never parsed, and a
	// `null` geometry is an Annotation with no place at all (RFC 7946 permits it). Guessing at either
	// is how a Project ends up framed on a MultiPolygon's `crs` block.
	if (geometry === null) return [];
	switch (geometry.type) {
		case 'Point':
			return [[geometry.coordinates]];
		case 'LineString':
			return [geometry.coordinates];
		case 'Polygon':
			return geometry.coordinates.map(closedRing);
		case 'foreign':
			return [];
	}
}

/**
 * A ring as a path that comes back to where it started, so its closing edge is an edge like any other.
 *
 * GeoJSON rings arrive closed already (RFC 7946 §3.1.6) and this leaves those alone; a Resource Mask
 * does not, and the segment from its last vertex back to its first is a whole side of the sheet.
 */
function closedRing(ring: GeoPath): GeoPath {
	const first = ring[0];
	const last = ring[ring.length - 1];
	if (ring.length < 2 || first === undefined || last === undefined) return ring;
	return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
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
 * The box containing every path, or `null` when there are none.
 *
 * Positions that are not finite numbers **break the path** rather than being quietly dropped from
 * it: a truncated or hand-edited GeoJSON puts a `NaN` in the middle of a LineString, and joining the
 * two positions either side of it would invent an edge the author never drew — across half the world,
 * if the gap happens to span it. One `NaN` reaching `fitBounds` moves the map nowhere at all and logs
 * nothing, which is the failure that looks exactly like the feature not existing.
 */
function boundsOf(paths: readonly GeoPath[]): GeoBounds | null {
	const runs = paths.flatMap(usableRuns);
	if (runs.length === 0) return null;

	let south = Number.POSITIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;
	for (const run of runs) {
		for (const [, lat] of run) {
			south = Math.min(south, lat);
			north = Math.max(north, lat);
		}
	}
	const { west, east } = longitudeSpan(runs);
	return { west, south, east, north };
}

/** `path` split at every position that is not a place, so no edge is invented across the gap. */
function usableRuns(path: GeoPath): GeoPath[] {
	const runs: (readonly [number, number])[][] = [];
	let current: (readonly [number, number])[] = [];
	for (const position of path) {
		const [lng, lat] = position;
		if (Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90) {
			current.push(position);
		} else if (current.length > 0) {
			runs.push(current);
			current = [];
		}
	}
	if (current.length > 0) runs.push(current);
	return runs;
}

/**
 * One stretch of longitude that content occupies, as a half-open arc running eastward.
 *
 * `start` is in `[-180, 180)`; `end` is `start` plus the arc's width and may exceed 180. `origin` and
 * `endAt` are the same two numbers **before** the arc was copied a revolution along for the sweep, so
 * that a box which does not cross ±180 comes back with exactly the coordinates that produced it
 * rather than with `x` recovered from `x + 360 - 360`.
 */
interface LongitudeArc {
	readonly start: number;
	readonly end: number;
	readonly origin: number;
	readonly endAt: number;
}

/** The arc a segment between two longitudes occupies: the one that runs from the lower to the higher. */
function longitudeArc(a: number, b: number): LongitudeArc {
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	// An exact multiple of 360, so `lo` already in range is shifted by literally zero and the arc's
	// ends are the input numbers themselves.
	const shift = Math.round((normaliseLongitude(lo) - lo) / 360) * 360;
	const start = lo + shift;
	const end = hi + shift;
	return { start, end, origin: start, endAt: end };
}

/** Everything, for content that leaves no gap to be outside of. */
const WHOLE_WORLD = { west: -180, east: 180 } as const;

/**
 * The shortest arc of longitude containing every path — see the note at the top of this file for why
 * this is not `Math.min`/`Math.max`, and why it is paths rather than points.
 *
 * The sweep works on **two copies of every arc, a revolution apart**. Coverage that crosses ±180 is
 * then merged by an ordinary left-to-right pass instead of by a special case, and the gaps that
 * remain are read off in order. Each distinct gap is considered once, by looking only at the runs
 * whose start is still in `[-180, 180)`.
 */
function longitudeSpan(runs: readonly GeoPath[]): { west: number; east: number } {
	const arcs: LongitudeArc[] = [];
	for (const run of runs) {
		const first = run[0];
		if (first === undefined) continue;
		if (run.length === 1) arcs.push(longitudeArc(first[0], first[0]));
		let previous = first;
		for (const position of run.slice(1)) {
			arcs.push(longitudeArc(previous[0], position[0]));
			previous = position;
		}
	}
	if (arcs.length === 0) return WHOLE_WORLD;

	const doubled = arcs
		.flatMap((arc): LongitudeArc[] => [
			arc,
			{ start: arc.start + 360, end: arc.end + 360, origin: arc.origin, endAt: arc.endAt }
		])
		.sort((left, right) => left.start - right.start);

	const covered: { start: number; end: number; origin: number; endAt: number }[] = [];
	for (const arc of doubled) {
		const last = covered[covered.length - 1];
		if (last !== undefined && arc.start <= last.end) {
			if (arc.end > last.end) {
				last.end = arc.end;
				last.endAt = arc.endAt;
			}
		} else {
			covered.push({ start: arc.start, end: arc.end, origin: arc.origin, endAt: arc.endAt });
		}
	}
	// A run a full revolution wide is content with no gap outside it — a LineString written across
	// more than the whole world, or coverage that closes on itself. There is nothing to be the
	// complement of, so the box is the planet.
	if (covered.some((run) => run.end - run.start >= 360)) return WHOLE_WORLD;

	// The runs whose start is still in the first revolution, which is a prefix because `covered` is
	// sorted. Each one's gap to its successor is one distinct gap on the circle, counted once.
	const period = covered.filter((run) => run.start < 180).length;
	if (period === 0 || period >= covered.length) return WHOLE_WORLD;

	// The gap that wraps past the antimeridian is the last of them, and it is the starting candidate,
	// so a tie between it and any other gap leaves the box on the arc that does not cross ±180.
	let before = covered[period - 1] as LongitudeArc;
	let after = covered[period] as LongitudeArc;
	let widest = after.start - before.end;
	for (let index = 0; index < period - 1; index += 1) {
		const candidateBefore = covered[index] as LongitudeArc;
		const candidateAfter = covered[index + 1] as LongitudeArc;
		const gap = candidateAfter.start - candidateBefore.end;
		if (gap > widest) {
			widest = gap;
			before = candidateBefore;
			after = candidateAfter;
		}
	}

	// Both edges are coordinates the content actually has, carried through the sweep unshifted, so a
	// box that does not cross the antimeridian comes back with exactly the numbers that went in.
	const west = after.origin;
	const east = before.endAt;
	return { west, east: east >= west ? east : east + 360 };
}
