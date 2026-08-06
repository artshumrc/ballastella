import { describe, expect, it } from 'vitest';

import {
	OPENING_VIEW_MAX_ZOOM,
	OPENING_VIEW_PADDING,
	alignmentOpeningBounds,
	openingViewFit,
	projectOpeningBounds,
	type ContentLayer
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

/** An Alignment over a 1000 × 800 sheet, with the mask left at the whole image. */
const alignedSheet = (
	gcps: readonly (readonly [number, number, number, number])[],
	options: {
		type?: TransformationType;
		mask?: readonly { x: number; y: number }[];
	} = {}
): Alignment => ({
	imageId: 'sheet',
	image: { width: 1000, height: 800 },
	controlPoints: gcps.map(([x, y, lng, lat], index): ControlPoint => ({
		id: `gcp-${index}`,
		ordinal: index + 1,
		resource: { x, y },
		geo: { lng, lat }
	})),
	resourceMask: options.mask ?? [
		{ x: 0, y: 0 },
		{ x: 1000, y: 0 },
		{ x: 1000, y: 800 },
		{ x: 0, y: 800 }
	],
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

	it('frames an aligned Historical Map on its Resource Mask, not on its Control Points', () => {
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

	it('has nothing to say about an unaligned Historical Map', () => {
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
