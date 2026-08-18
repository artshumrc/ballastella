import { describe, expect, it, vi } from 'vitest';
import { GcpTransformer } from '@allmaps/transform';

import {
	OPENING_VIEW_MAX_ZOOM,
	OPENING_VIEW_PADDING,
	alignmentOpeningBounds,
	alignmentOpeningFit,
	applyOpeningFit,
	openingViewFit,
	projectOpeningBounds,
	projectOpeningFit,
	type ContentLayer,
	type OpeningViewFit
} from './opening-view';
import { newAnnotationLayer, newMapLayer, type AnnotationLayer, type MapLayer } from './layer';
import type { Alignment, ControlPoint, TransformationType } from '../alignment/alignment';
import type {
	Annotation,
	AnnotationCollection,
	AnnotationGeometry
} from '../annotation/annotation';

// Numbers, never screenshots. The failure mode of an opening view is a *plausible wrong answer* —
// a box that is somewhere real and not where the work is — which no "the map moved" assertion can
// see. So every case below states the coordinates it expects, the same discipline
// `synthetic-projection.test.ts` uses and for the same reason.

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures

const annotationLayerNamed = (id: string, visible = true): AnnotationLayer => ({
	...newAnnotationLayer({ id, name: id }),
	visible
});

const mapLayerNamed = (id: string, visible = true): MapLayer => ({
	...newMapLayer({ id, name: id, imageId: 'sheet' }),
	visible
});

const feature = (id: string, geometry: AnnotationGeometry): Annotation => ({
	id,
	geometry,
	properties: {}
});

const pin = (id: string, lng: number, lat: number): Annotation =>
	feature(id, { type: 'Point', coordinates: [lng, lat] });

const collection = (...annotations: Annotation[]): AnnotationCollection => ({ annotations });

/** The whole of a 1000 × 800 sheet, as a Resource Mask. */
const WHOLE_SHEET = [
	{ x: 0, y: 0 },
	{ x: 1000, y: 0 },
	{ x: 1000, y: 800 },
	{ x: 0, y: 800 }
] as const;

/**
 * An Alignment over a 1000 × 800 sheet, with the mask left at the whole image.
 *
 * Each Control Point is written `[x, y, lng, lat]` — the resource pixel it is pinned to and the
 * place on the earth it names.
 */
const alignedSheet = (
	controlPoints: readonly (readonly [number, number, number, number])[],
	options: {
		type?: TransformationType;
		mask?: readonly { x: number; y: number }[];
	} = {}
): Alignment => ({
	imageId: 'sheet',
	image: { width: 1000, height: 800 },
	controlPoints: controlPoints.map(([x, y, lng, lat], index): ControlPoint => ({
		id: `point-${index}`,
		ordinal: index + 1,
		resource: { x, y },
		geo: { lng, lat }
	})),
	resourceMask: options.mask ?? WHOLE_SHEET,
	transformationType: options.type ?? 'polynomial1'
});

/**
 * Boston, aligned so that the Control Points cover only the middle half of the sheet.
 *
 * The margins are therefore *outside* the Control Points' extent, which is the whole point of the
 * Resource-Mask-versus-Control-Points criterion: a fit to the points understates the sheet by a
 * quarter in each direction, and both boxes are plausible.
 */
const BOSTON_SHEET = alignedSheet([
	[250, 200, -71.1, 42.36],
	[750, 200, -71.02, 42.36],
	[750, 600, -71.02, 42.32],
	[250, 600, -71.1, 42.32]
]);

/** What the Control Points alone span. Every assertion about the mask is made against this. */
const BOSTON_CONTROL_POINTS = { west: -71.1, south: 42.32, east: -71.02, north: 42.36 };

describe('projectOpeningBounds', () => {
	it('frames a Project whose Annotations are all in one city on that city', () => {
		// Three pins around Boston Common, the Charles, and the harbour — nothing anywhere else.
		const content: ContentLayer[] = [
			{
				layer: annotationLayerNamed('walk'),
				annotations: collection(
					pin('common', -71.0656, 42.3554),
					pin('charles', -71.0912, 42.3601),
					pin('harbour', -71.0402, 42.3522)
				)
			}
		];

		const bounds = projectOpeningBounds(content);

		expect(bounds).not.toBeNull();
		expect(bounds?.west).toBeCloseTo(-71.0912, 6);
		expect(bounds?.east).toBeCloseTo(-71.0402, 6);
		expect(bounds?.south).toBeCloseTo(42.3522, 6);
		expect(bounds?.north).toBeCloseTo(42.3601, 6);
	});

	it('spans every geometry kind a Layer can hold, not only its first', () => {
		const content: ContentLayer[] = [
			{
				layer: annotationLayerNamed('mixed'),
				annotations: collection(
					pin('pin', -71.06, 42.35),
					feature('route', {
						type: 'LineString',
						coordinates: [
							[-71.2, 42.3],
							[-71.0, 42.4]
						]
					}),
					feature('parcel', {
						type: 'Polygon',
						coordinates: [
							[
								[-71.15, 42.25],
								[-70.9, 42.25],
								[-70.9, 42.45],
								[-71.15, 42.45]
							]
						]
					}),
					// Neither of these has coordinates this build can read, and neither may contribute.
					feature('unknown', { type: 'foreign', declaredType: 'MultiPolygon', raw: {} }),
					feature('placeless', null)
				)
			}
		];

		const bounds = projectOpeningBounds(content);

		expect(bounds).toEqual({ west: -71.2, south: 42.25, east: -70.9, north: 42.45 });
	});

	it('frames an aligned Map Image on its Resource Mask, not on its Control Points', () => {
		const content: ContentLayer[] = [{ layer: mapLayerNamed('sheet'), alignment: BOSTON_SHEET }];

		const bounds = projectOpeningBounds(content);

		expect(bounds).not.toBeNull();
		// The sheet is twice as wide and twice as tall as the block its Control Points cover, so the
		// mask's extent overshoots each Control Point edge by half the point span. These are the
		// numbers the transformer produces, stated rather than derived.
		expect(bounds?.west).toBeCloseTo(-71.14, 6);
		expect(bounds?.east).toBeCloseTo(-70.98, 6);
		expect(bounds?.south).toBeCloseTo(42.3, 6);
		expect(bounds?.north).toBeCloseTo(42.38, 6);

		// And said as the distinction rather than only as coordinates: fitting to the Control Points
		// would leave a quarter of the sheet off screen on each side, which is a plausible wrong answer.
		expect(bounds!.west).toBeLessThan(BOSTON_CONTROL_POINTS.west);
		expect(bounds!.east).toBeGreaterThan(BOSTON_CONTROL_POINTS.east);
		expect(bounds!.south).toBeLessThan(BOSTON_CONTROL_POINTS.south);
		expect(bounds!.north).toBeGreaterThan(BOSTON_CONTROL_POINTS.north);
	});

	it('follows an edited Resource Mask in, when the author has cropped the margins off', () => {
		// The same sheet with the mask pulled to exactly the Control Point block. The extent must
		// follow the mask down — otherwise "the mask is what is used" is only true when the mask is
		// the whole image, which is the default and would make the criterion vacuous.
		const cropped = alignedSheet(
			[
				[250, 200, -71.1, 42.36],
				[750, 200, -71.02, 42.36],
				[750, 600, -71.02, 42.32],
				[250, 600, -71.1, 42.32]
			],
			{
				mask: [
					{ x: 250, y: 200 },
					{ x: 750, y: 200 },
					{ x: 750, y: 600 },
					{ x: 250, y: 600 }
				]
			}
		);

		const bounds = projectOpeningBounds([{ layer: mapLayerNamed('sheet'), alignment: cropped }]);

		expect(bounds?.west).toBeCloseTo(BOSTON_CONTROL_POINTS.west, 6);
		expect(bounds?.east).toBeCloseTo(BOSTON_CONTROL_POINTS.east, 6);
		expect(bounds?.south).toBeCloseTo(BOSTON_CONTROL_POINTS.south, 6);
		expect(bounds?.north).toBeCloseTo(BOSTON_CONTROL_POINTS.north, 6);
	});

	it('gives a single pin a zero-area box, and leaves the zoom cap to the fit', () => {
		const content: ContentLayer[] = [
			{ layer: annotationLayerNamed('one'), annotations: collection(pin('only', 4.9041, 52.3676)) }
		];

		const bounds = projectOpeningBounds(content);

		expect(bounds).toEqual({ west: 4.9041, south: 52.3676, east: 4.9041, north: 52.3676 });

		// Nothing here invents a neighbourhood-sized box out of a point: the cap is what keeps a fit to
		// zero area off four roof tiles, and it travels with the fit so the editor and the published
		// viewer cannot cap differently.
		const fit = openingViewFit(bounds!);
		expect(fit.maxZoom).toBe(OPENING_VIEW_MAX_ZOOM);
		expect(OPENING_VIEW_MAX_ZOOM).toBeLessThanOrEqual(16);
		expect(fit.padding).toBe(OPENING_VIEW_PADDING);
		expect(OPENING_VIEW_PADDING).toBeGreaterThan(0);
		expect(fit.animate).toBe(false);
		expect(fit.bounds).toEqual([
			[4.9041, 52.3676],
			[4.9041, 52.3676]
		]);
	});

	it('has nothing to say about a Project with no Layers', () => {
		expect(projectOpeningBounds([])).toBeNull();
	});

	it('has nothing to say about an unaligned Map Image', () => {
		// Three shapes of "not aligned": no Alignment file at all, an Alignment with no Control Points,
		// and one with too few for its transformation type to be solved. None has a place on the earth.
		expect(projectOpeningBounds([{ layer: mapLayerNamed('sheet'), alignment: null }])).toBeNull();
		expect(
			projectOpeningBounds([{ layer: mapLayerNamed('sheet'), alignment: alignedSheet([]) }])
		).toBeNull();
		expect(
			projectOpeningBounds([
				{
					layer: mapLayerNamed('sheet'),
					alignment: alignedSheet([
						[250, 200, -71.1, 42.36],
						[750, 200, -71.02, 42.36]
					])
				}
			])
		).toBeNull();
	});

	it('has nothing to say about an Annotation Layer with no Annotations in it', () => {
		expect(
			projectOpeningBounds([
				{ layer: annotationLayerNamed('empty'), annotations: collection() },
				{ layer: annotationLayerNamed('unread'), annotations: null }
			])
		).toBeNull();
	});

	it('prefers the visible Layers, and ignores what is hidden beside them', () => {
		const content: ContentLayer[] = [
			{
				layer: annotationLayerNamed('boston', true),
				annotations: collection(pin('common', -71.0656, 42.3554))
			},
			{
				layer: annotationLayerNamed('tokyo', false),
				annotations: collection(pin('ginza', 139.7671, 35.6812))
			}
		];

		const bounds = projectOpeningBounds(content);

		// Boston alone. A box that also contained Tokyo would be half the planet and would still look
		// like "it fitted to something".
		expect(bounds).toEqual({
			west: -71.0656,
			south: 42.3554,
			east: -71.0656,
			north: 42.3554
		});
	});

	it('falls back to the hidden Layers when everything is hidden', () => {
		const content: ContentLayer[] = [
			{
				layer: annotationLayerNamed('boston', false),
				annotations: collection(pin('common', -71.0656, 42.3554), pin('harbour', -71.04, 42.35))
			},
			{ layer: mapLayerNamed('sheet', false), alignment: BOSTON_SHEET }
		];

		const bounds = projectOpeningBounds(content);

		// Framed on the work, not on the deployment default: a Project whose author has hidden
		// everything to look at the Base Map still opens where the work is.
		expect(bounds).not.toBeNull();
		expect(bounds?.west).toBeCloseTo(-71.14, 6);
		expect(bounds?.east).toBeCloseTo(-70.98, 6);
		expect(bounds?.south).toBeCloseTo(42.3, 6);
		expect(bounds?.north).toBeCloseTo(42.38, 6);
	});

	it('takes the short way round the antimeridian', () => {
		const content: ContentLayer[] = [
			{
				layer: annotationLayerNamed('pacific'),
				annotations: collection(
					pin('tokyo', 139.7671, 35.6812),
					pin('san-francisco', -122.4194, 37.7749)
				)
			}
		];

		const bounds = projectOpeningBounds(content);

		expect(bounds).not.toBeNull();
		// Tokyo eastwards to San Francisco: 97.8° of longitude across the Pacific, expressed with an
		// `east` beyond 180 rather than wrapped, because a box whose `east` is numerically west of its
		// `west` cannot be drawn. The long way round is 262.2°, and it is the answer a naive
		// min/max gives.
		expect(bounds?.west).toBeCloseTo(139.7671, 6);
		expect(bounds?.east).toBeCloseTo(237.5806, 6);
		expect(bounds!.east - bounds!.west).toBeLessThan(180);
		expect(bounds?.south).toBeCloseTo(35.6812, 6);
		expect(bounds?.north).toBeCloseTo(37.7749, 6);
	});

	it('frames a whole-world Polygon on the world, not on the sliver between its corners', () => {
		// The regression that made two `editor-layers` tests fail: a rectangle with corners at ±179 is
		// the whole world, because GeoJSON cuts content at the antimeridian (RFC 7946 §3.1.9) and this
		// one is not cut — so its bottom edge runs from −179 all the way east to 179, and MapLibre draws
		// it that way. A rule that read only the four corners saw a 358° "empty" gap that the edge runs
		// straight through, and framed the Project on what was left.
		const content: ContentLayer[] = [
			{
				layer: annotationLayerNamed('everywhere'),
				annotations: collection(
					feature('world', {
						type: 'Polygon',
						coordinates: [
							[
								[-179, -85],
								[179, -85],
								[179, 85],
								[-179, 85],
								[-179, -85]
							]
						]
					}),
					// Amsterdam as well, exactly as the e2e Project has it: the sheet sits inside the
					// polygon and the gap the old rule chose ran from −179 to it.
					pin('dam', 4.9041, 52.3676)
				)
			}
		];

		expect(projectOpeningBounds(content)).toEqual({
			west: -179,
			south: -85,
			east: 179,
			north: 85
		});
	});

	it('follows a two-vertex LineString the way it is written, however far that is', () => {
		// More than half the planet, and the segment really does go that way: MapLibre draws a line
		// from −170 to 170 straight across the map through 0°, not through the antimeridian. Framing on
		// the 20° between its endpoints the other way round would put the entire line off screen while
		// looking like a confident answer.
		const theLongWay: ContentLayer[] = [
			{
				layer: annotationLayerNamed('transect'),
				annotations: collection(
					feature('line', {
						type: 'LineString',
						coordinates: [
							[-170, 10],
							[170, 20]
						]
					})
				)
			}
		];

		expect(projectOpeningBounds(theLongWay)).toEqual({
			west: -170,
			south: 10,
			east: 170,
			north: 20
		});

		// And the same line written the way RFC 7946 has an author write one that *does* cross the
		// antimeridian — past 180 rather than wrapped — is 20° wide and framed as such.
		const acrossTheAntimeridian: ContentLayer[] = [
			{
				layer: annotationLayerNamed('transect'),
				annotations: collection(
					feature('line', {
						type: 'LineString',
						coordinates: [
							[170, 10],
							[190, 20]
						]
					})
				)
			}
		];

		expect(projectOpeningBounds(acrossTheAntimeridian)).toEqual({
			west: 170,
			south: 10,
			east: 190,
			north: 20
		});
	});

	it('keeps two separate Annotations separate, however close their edges would have been', () => {
		// The other half of the edge rule, and the one that must not be broken by it: two pins are not
		// a line. 179 and −179 are 2° apart across the antimeridian and 358° apart the other way, and
		// nothing joins them, so the box is the short one.
		const content: ContentLayer[] = [
			{
				layer: annotationLayerNamed('pair'),
				annotations: collection(pin('east', 179, 10), pin('west', -179, 12))
			}
		];

		expect(projectOpeningBounds(content)).toEqual({ west: 179, south: 10, east: 181, north: 12 });
	});

	it('frames three continents on the complement of the widest gap between them', () => {
		const content: ContentLayer[] = [
			{
				layer: annotationLayerNamed('continents'),
				annotations: collection(
					pin('lisbon', -9.1393, 38.7223),
					pin('boston', -71.0589, 42.3601),
					pin('nairobi', 36.8219, -1.2921)
				)
			}
		];

		// The gaps are 61.9° (Boston→Lisbon), 46.0° (Lisbon→Nairobi) and 252.1° (Nairobi→Boston, the
		// long way across the Pacific). The complement of the widest is Boston eastward to Nairobi.
		expect(projectOpeningBounds(content)).toEqual({
			west: -71.0589,
			south: -1.2921,
			east: 36.8219,
			north: 42.3601
		});
	});

	it('leaves exactly antipodal content on the arc that does not cross ±180', () => {
		// Nothing distinguishes the two answers, so the tie is decided and written down — here, in the
		// module, and in ADR-0026. The wrap gap is the starting candidate and only a strictly wider gap
		// displaces it, which means the box is the one that stays inside ±180.
		const antipodal = (west: number, east: number): ContentLayer[] => [
			{
				layer: annotationLayerNamed('antipodal'),
				annotations: collection(pin('a', west, 0), pin('b', east, 0))
			}
		];

		expect(projectOpeningBounds(antipodal(0, 180))).toEqual({
			west: -180,
			south: 0,
			east: 0,
			north: 0
		});
		expect(projectOpeningBounds(antipodal(-90, 90))).toEqual({
			west: -90,
			south: 0,
			east: 90,
			north: 0
		});
		expect(projectOpeningBounds(antipodal(45, -135))).toEqual({
			west: -135,
			south: 0,
			east: 45,
			north: 0
		});
	});

	it('gives ±180 one longitude, however it was written', () => {
		// 180 and −180 are the same meridian. Two pins there are one place, not a pair to choose a way
		// round between.
		const content: ContentLayer[] = [
			{
				layer: annotationLayerNamed('dateline'),
				annotations: collection(pin('plus', 180, 10), pin('minus', -180, 12))
			}
		];

		expect(projectOpeningBounds(content)).toEqual({
			west: -180,
			south: 10,
			east: -180,
			north: 12
		});
	});

	it('takes the short way for a degree either side of the prime meridian', () => {
		const content: ContentLayer[] = [
			{
				layer: annotationLayerNamed('greenwich'),
				annotations: collection(pin('west', -1, 51), pin('east', 1, 52))
			}
		];

		expect(projectOpeningBounds(content)).toEqual({ west: -1, south: 51, east: 1, north: 52 });
	});

	it('still takes the ordinary way round for content that does not cross the antimeridian', () => {
		const content: ContentLayer[] = [
			{
				layer: annotationLayerNamed('atlantic'),
				annotations: collection(pin('lisbon', -9.1393, 38.7223), pin('amsterdam', 4.9041, 52.3676))
			}
		];

		// The widest empty gap here runs the other way round the world, so the box is the plain one.
		expect(projectOpeningBounds(content)).toEqual({
			west: -9.1393,
			south: 38.7223,
			east: 4.9041,
			north: 52.3676
		});
	});

	it('breaks a path at a damaged position rather than joining across it', () => {
		// A truncated LineString. Dropping the bad position and closing the line up would invent a
		// segment the author never drew — here a 250° one — and that invented edge would then be used
		// to decide which way round the world the box goes.
		const content: ContentLayer[] = [
			{
				layer: annotationLayerNamed('torn'),
				annotations: collection(
					feature('route', {
						type: 'LineString',
						coordinates: [
							[-71.2, 42.3],
							[Number.NaN, 42.35],
							[179, 42.4]
						]
					})
				)
			}
		];

		// Two surviving places and no edge between them, so the box is the short way round: 109.8°
		// across the Pacific. Joining them would have given the 250.2° box `west: -71.2, east: 179`.
		expect(projectOpeningBounds(content)).toEqual({
			west: 179,
			south: 42.3,
			east: 288.8,
			north: 42.4
		});
	});

	it('refuses coordinates that are not numbers rather than producing a NaN box', () => {
		const content: ContentLayer[] = [
			{
				layer: annotationLayerNamed('damaged'),
				annotations: collection(
					pin('good', 4.9041, 52.3676),
					// A hand-edited or truncated file. A NaN reaching `fitBounds` moves the map nowhere
					// and logs nothing.
					pin('broken', Number.NaN, 52.4)
				)
			}
		];

		expect(projectOpeningBounds(content)).toEqual({
			west: 4.9041,
			south: 52.3676,
			east: 4.9041,
			north: 52.3676
		});
	});

	it('says nothing when a degenerate Alignment throws the sheet off the earth', () => {
		// Three Control Points on a diagonal, all mapped to one place: enough of them for
		// `polynomial1`, and a singular system. Upstream does **not** throw on it — it returns
		// `[-71.1, 42.3], [428.9, -207.7], [28.9, 192.3], [-471.1, 442.3]` for the sheet's corners,
		// latitudes that are not places. The answer must be "no opinion", never a box built from
		// whichever corners happened to survive a filter.
		const collinear = alignedSheet([
			[100, 100, -71.1, 42.3],
			[200, 200, -71.1, 42.3],
			[300, 300, -71.1, 42.3]
		]);

		expect(
			projectOpeningBounds([{ layer: mapLayerNamed('sheet'), alignment: collinear }])
		).toBeNull();
	});

	it('says nothing when the solver refuses the Control Points outright', () => {
		// The other shape of a degenerate Alignment, and the one that reaches the `catch`: three Control
		// Points on the *same pixel* under `thinPlateSpline` make a singular matrix, and upstream throws
		// `LU matrix is singular` rather than returning nonsense. Both shapes exist, and a guard against
		// only one of them leaves the other producing a box.
		const coincident = alignedSheet(
			[
				[100, 100, -71.1, 42.3],
				[100, 100, -71.0, 42.3],
				[100, 100, -71.0, 42.4]
			],
			{ type: 'thinPlateSpline' }
		);

		expect(
			projectOpeningBounds([{ layer: mapLayerNamed('sheet'), alignment: coincident }])
		).toBeNull();
	});

	it('declines a sheet whose solve is singular on either axis, and keeps the Project', () => {
		// Both collinear axes, because the guard used to bound latitude only and the two axes fail
		// differently. Measured with the real `GcpTransformer` on a 1000 × 800 sheet:
		//
		//   vertically collinear   → [[-64, 56], [-564, 56], [-563.2, 56.4], [-63.2, 56.4]]
		//   horizontally collinear → [[-32, 48], [-31, 48.5], [-231, 198.5], [-232, 198]]
		//
		// Neither throws. The horizontal one is caught by the latitude bound — 198.5° is not a place —
		// which is why the diagonal case above passed and this hole survived. The vertical one has
		// latitudes 56 to 56.4, which are perfectly ordinary, and longitudes spanning 500.8°: with
		// longitude unchecked it returned `{west: 156, east: 296.8, south: 56, north: 56.4}` and a
		// Boston Project opened on the Bering Strait.
		const verticallyCollinear = alignedSheet([
			[100, 100, -71.1, 42.3],
			[100, 200, -71.0, 42.35],
			[100, 300, -70.9, 42.4]
		]);
		const horizontallyCollinear = alignedSheet([
			[100, 100, -71.1, 42.3],
			[200, 100, -71.0, 42.35],
			[300, 100, -70.9, 42.4]
		]);

		for (const singular of [verticallyCollinear, horizontallyCollinear]) {
			expect(
				projectOpeningBounds([{ layer: mapLayerNamed('sheet'), alignment: singular }])
			).toBeNull();

			// And the sheet alone is declined, not the Project: the Annotations beside it still decide
			// where it opens. That is the whole reason the guard matters — a sheet that is *kept* drags
			// the union with it, and no Annotation can pull the box back.
			expect(
				projectOpeningBounds([
					{ layer: mapLayerNamed('sheet'), alignment: singular },
					{
						layer: annotationLayerNamed('walk'),
						annotations: collection(pin('common', -71.0656, 42.3554))
					}
				])
			).toEqual({ west: -71.0656, south: 42.3554, east: -71.0656, north: 42.3554 });
		}
	});

	it('follows a warped edge outside the quadrilateral its corners describe', () => {
		// The Resource Mask is a ring rather than a box because a `thinPlateSpline` bends its *edges*,
		// and a box built from four transformed corners cuts the sheet off along them. That protection
		// is upstream's refinement, and upstream does none unless it is asked: `maxDepth` defaults to 0.
		const spline = alignedSheet(
			[
				[100, 100, -71.12, 42.4],
				[900, 120, -70.98, 42.398],
				[920, 700, -70.985, 42.305],
				[120, 680, -71.115, 42.31],
				[500, 400, -71.02, 42.36]
			],
			{ type: 'thinPlateSpline' }
		);

		const bounds = projectOpeningBounds([{ layer: mapLayerNamed('sheet'), alignment: spline }]);

		// The four corners transformed one at a time — which is exactly what `transformToGeo` returns
		// with refinement off, so this is the box the module would produce if the option were dropped.
		const transformer = new GcpTransformer(
			spline.controlPoints.map((point) => ({
				resource: [point.resource.x, point.resource.y] as [number, number],
				geo: [point.geo.lng, point.geo.lat] as [number, number]
			})),
			'thinPlateSpline'
		);
		const corners = WHOLE_SHEET.map((vertex) =>
			transformer.transformToGeo([vertex.x, vertex.y] as [number, number])
		);
		const cornersEast = Math.max(...corners.map(([lng]) => lng as number));
		const cornersNorth = Math.max(...corners.map(([, lat]) => lat as number));

		// Stated as numbers, because "a box was produced" is what a wrong opening view also looks like.
		expect(cornersEast).toBeCloseTo(-70.9696766, 6);
		expect(cornersNorth).toBeCloseTo(42.4153825, 6);
		expect(bounds?.east).toBeCloseTo(-70.9672005, 6);
		expect(bounds?.north).toBeCloseTo(42.4186507, 6);

		// And as the distinction: the bowed edges reach 0.00248° further east and 0.00327° further
		// north than the corners do — a couple of hundred metres of the sheet's own edge that a
		// four-corner box leaves off screen.
		expect(bounds!.east).toBeGreaterThan(cornersEast);
		expect(bounds!.north).toBeGreaterThan(cornersNorth);
	});

	it('says nothing when a Control Point’s own coordinate is not a number', () => {
		// A hand-edited Alignment. The solve succeeds and every transformed corner comes back with a
		// `null` longitude — which is not a place, and which `Math.min` would turn into 0°.
		const broken = alignedSheet([
			[100, 100, Number.NaN, 42.38],
			[400, 100, -71.06, 42.38],
			[400, 300, -71.06, 42.36]
		]);

		expect(projectOpeningBounds([{ layer: mapLayerNamed('sheet'), alignment: broken }])).toBeNull();
	});
});

describe('alignmentOpeningBounds', () => {
	it('lands on the Control Points of a half-finished Alignment', () => {
		const bounds = alignmentOpeningBounds(BOSTON_SHEET, [
			// The rest of the Project is in Amsterdam, and must not win.
			{
				layer: annotationLayerNamed('elsewhere'),
				annotations: collection(pin('dam', 4.9041, 52.3676))
			}
		]);

		expect(bounds).toEqual(BOSTON_CONTROL_POINTS);
	});

	it('lands on a single Control Point, which is where the work was left', () => {
		const started = alignedSheet([[250, 200, -71.1, 42.36]]);

		expect(alignmentOpeningBounds(started, [])).toEqual({
			west: -71.1,
			south: 42.36,
			east: -71.1,
			north: 42.36
		});
	});

	it('falls through to the Project when the Alignment has no Control Points yet', () => {
		const bounds = alignmentOpeningBounds(alignedSheet([]), [
			{
				layer: annotationLayerNamed('elsewhere'),
				annotations: collection(pin('dam', 4.9041, 52.3676))
			}
		]);

		expect(bounds).toEqual({ west: 4.9041, south: 52.3676, east: 4.9041, north: 52.3676 });
	});

	it('has nothing to say when neither the Alignment nor the Project has a place', () => {
		expect(alignmentOpeningBounds(null, [])).toBeNull();
	});
});

describe('the fits both apps use', () => {
	const bostonPin: ContentLayer[] = [
		{
			layer: annotationLayerNamed('walk'),
			annotations: collection(pin('common', -71.0656, 42.3554))
		}
	];

	it('is the bounds and the fit in one call, so neither app writes that line for itself', () => {
		// Four copies of `bounds === null ? null : openingViewFit(bounds)` across two apps is how "the
		// published site frames a Project the way the editor does" stops being true.
		expect(projectOpeningFit(bostonPin)).toEqual(openingViewFit(projectOpeningBounds(bostonPin)!));
		expect(projectOpeningFit([])).toBeNull();

		expect(alignmentOpeningFit(BOSTON_SHEET, [])).toEqual(
			openingViewFit(alignmentOpeningBounds(BOSTON_SHEET, [])!)
		);
		expect(alignmentOpeningFit(null, [])).toBeNull();
	});

	it('frames the map once per request, and again when the same box is asked for again', () => {
		const map = { fitBounds: vi.fn() };
		const first = projectOpeningFit(bostonPin) as OpeningViewFit;

		let fitted = applyOpeningFit(map, first, null);

		expect(fitted).toBe(first);
		expect(map.fitBounds).toHaveBeenCalledTimes(1);
		expect(map.fitBounds).toHaveBeenLastCalledWith(first.bounds, {
			padding: OPENING_VIEW_PADDING,
			maxZoom: OPENING_VIEW_MAX_ZOOM,
			animate: false
		});

		// The same object again is the effect re-running, not the user asking, and must not move a map
		// they have since panned.
		fitted = applyOpeningFit(map, first, fitted);
		expect(map.fitBounds).toHaveBeenCalledTimes(1);

		// A *fresh* object for the same box is "Fit to this Project" pressed a second time, which is
		// exactly the case a user presses it in — they have panned away and want to come back.
		const again = projectOpeningFit(bostonPin) as OpeningViewFit;
		expect(again).toEqual(first);
		fitted = applyOpeningFit(map, again, fitted);
		expect(map.fitBounds).toHaveBeenCalledTimes(2);
		expect(fitted).toBe(again);
	});

	it('does nothing before there is a map, and nothing when there is nothing to frame on', () => {
		const map = { fitBounds: vi.fn() };

		expect(applyOpeningFit(undefined, projectOpeningFit(bostonPin), null)).toBeNull();
		expect(applyOpeningFit(map, null, null)).toBeNull();
		expect(map.fitBounds).not.toHaveBeenCalled();
	});
});
