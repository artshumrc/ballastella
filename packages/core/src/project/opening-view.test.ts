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
	type GeoBounds,
	type OpeningViewFit
} from './opening-view';
import { newAnnotationLayer, newMapLayer } from './layer';
import type { Alignment, TransformationType } from '../alignment/alignment';
import { toRendererControlPoints } from '../alignment/georeference-annotation';
import type { Annotation, AnnotationGeometry } from '../annotation/annotation';

type Position = [number, number];

const feature = (geometry: AnnotationGeometry): Annotation => ({
	id: 'a',
	geometry,
	properties: {}
});

const pin = (lng: number, lat: number): Annotation =>
	feature({ type: 'Point', coordinates: [lng, lat] });

const line = (...coordinates: Position[]): Annotation =>
	feature({ type: 'LineString', coordinates });

const notes = (annotations: Annotation[] | null, visible = true): ContentLayer => ({
	layer: { ...newAnnotationLayer({ id: 'notes', name: 'notes' }), visible },
	annotations: annotations && { annotations }
});

const sheet = (alignment: Alignment | null, visible = true): ContentLayer => ({
	layer: { ...newMapLayer({ id: 'sheet', name: 'sheet', imageId: 'sheet' }), visible },
	alignment
});

const pins = (...positions: Position[]): ContentLayer[] => [
	notes(positions.map(([lng, lat]) => pin(lng, lat)))
];

const pairs = (flat: readonly number[]): Position[] =>
	Array.from({ length: flat.length / 2 }, (_, index) => [flat[2 * index]!, flat[2 * index + 1]!]);

const box = (west: number, south: number, east: number, north: number): GeoBounds => ({
	west,
	south,
	east,
	north
});

const point = (lng: number, lat: number) => box(lng, lat, lng, lat);

const expectCloseTo = (bounds: GeoBounds | null, expected: GeoBounds) => {
	expect(bounds).not.toBeNull();
	for (const side of ['west', 'south', 'east', 'north'] as const) {
		expect(bounds?.[side]).toBeCloseTo(expected[side], 6);
	}
};

const WHOLE_SHEET = [
	{ x: 0, y: 0 },
	{ x: 1000, y: 0 },
	{ x: 1000, y: 800 },
	{ x: 0, y: 800 }
];

const alignedSheet = (
	controlPoints: readonly (readonly [number, number, number, number])[],
	options: { type?: TransformationType; mask?: readonly { x: number; y: number }[] } = {}
): Alignment => ({
	imageId: 'sheet',
	image: { width: 1000, height: 800 },
	controlPoints: controlPoints.map(([x, y, lng, lat], index) => ({
		id: `point-${index}`,
		ordinal: index + 1,
		resource: { x, y },
		geo: { lng, lat }
	})),
	resourceMask: options.mask ?? WHOLE_SHEET,
	transformationType: options.type ?? 'polynomial1'
});

const BOSTON_POINTS = [
	[250, 200, -71.1, 42.36],
	[750, 200, -71.02, 42.36],
	[750, 600, -71.02, 42.32],
	[250, 600, -71.1, 42.32]
] as const;

const BOSTON_SHEET = alignedSheet(BOSTON_POINTS);
const BOSTON_CONTROL_POINTS = box(-71.1, 42.32, -71.02, 42.36);
const BOSTON_MASK = box(-71.14, 42.3, -70.98, 42.38);

describe('projectOpeningBounds', () => {
	it('frames a Project whose Annotations are all in one city on that city', () => {
		const bounds = projectOpeningBounds(
			pins([-71.0656, 42.3554], [-71.0912, 42.3601], [-71.0402, 42.3522])
		);
		expectCloseTo(bounds, box(-71.0912, 42.3522, -71.0402, 42.3601));
	});

	it('spans every geometry kind a Layer can hold, not only its first', () => {
		const square = pairs([-71.15, 42.25, -70.9, 42.25, -70.9, 42.45, -71.15, 42.45]);
		const content = [
			notes([
				pin(-71.06, 42.35),
				line([-71.2, 42.3], [-71.0, 42.4]),
				feature({ type: 'Polygon', coordinates: [square] }),
				feature({ type: 'foreign', declaredType: 'MultiPolygon', raw: {} }),
				feature(null)
			])
		];
		expect(projectOpeningBounds(content)).toEqual(box(-71.2, 42.25, -70.9, 42.45));
	});

	it('frames an aligned Map Image on its Resource Mask, not on its Control Points', () => {
		const bounds = projectOpeningBounds([sheet(BOSTON_SHEET)]);
		expectCloseTo(bounds, BOSTON_MASK);
		expect(bounds!.west).toBeLessThan(BOSTON_CONTROL_POINTS.west);
		expect(bounds!.east).toBeGreaterThan(BOSTON_CONTROL_POINTS.east);
		expect(bounds!.south).toBeLessThan(BOSTON_CONTROL_POINTS.south);
		expect(bounds!.north).toBeGreaterThan(BOSTON_CONTROL_POINTS.north);
	});

	it('follows an edited Resource Mask in, when the author has cropped the margins off', () => {
		const cropped = alignedSheet(BOSTON_POINTS, {
			mask: BOSTON_POINTS.map(([x, y]) => ({ x, y }))
		});
		expectCloseTo(projectOpeningBounds([sheet(cropped)]), BOSTON_CONTROL_POINTS);
	});

	it('gives a single pin a zero-area box, and leaves the zoom cap to the fit', () => {
		const bounds = projectOpeningBounds(pins([4.9041, 52.3676]));
		expect(bounds).toEqual(point(4.9041, 52.3676));
		const fit = openingViewFit(bounds!);
		expect(fit.maxZoom).toBe(OPENING_VIEW_MAX_ZOOM);
		expect(OPENING_VIEW_MAX_ZOOM).toBeLessThanOrEqual(16);
		expect(fit.padding).toBe(OPENING_VIEW_PADDING);
		expect(OPENING_VIEW_PADDING).toBeGreaterThan(0);
		expect(fit.animate).toBe(false);
		expect(fit.bounds).toEqual(pairs([4.9041, 52.3676, 4.9041, 52.3676]));
	});

	it.each([
		['a Project with no Layers', []],
		['a Map Image with no Alignment file', [sheet(null)]],
		['an Alignment with no Control Points', [sheet(alignedSheet([]))]],
		['an Alignment too short to solve', [sheet(alignedSheet(BOSTON_POINTS.slice(0, 2)))]],
		['an empty or unread Annotation Layer', [notes([]), notes(null)]]
	])('has nothing to say about %s', (_description, content: ContentLayer[]) => {
		expect(projectOpeningBounds(content)).toBeNull();
	});

	it('prefers the visible Layers, and falls back to the hidden ones when everything is hidden', () => {
		const visible = [notes([pin(-71.0656, 42.3554)]), notes([pin(139.7671, 35.6812)], false)];
		expect(projectOpeningBounds(visible)).toEqual(point(-71.0656, 42.3554));
		const hidden = [
			notes([pin(-71.0656, 42.3554), pin(-71.04, 42.35)], false),
			sheet(BOSTON_SHEET, false)
		];
		expectCloseTo(projectOpeningBounds(hidden), BOSTON_MASK);
	});

	it('takes the short way round the antimeridian', () => {
		const bounds = projectOpeningBounds(pins([139.7671, 35.6812], [-122.4194, 37.7749]));
		expectCloseTo(bounds, box(139.7671, 35.6812, 237.5806, 37.7749));
	});

	it.each([
		['keeps two separate Annotations separate', [179, 10, -179, 12], box(179, 10, 181, 12)],
		[
			'frames three continents on the complement of the widest gap between them',
			[-9.1393, 38.7223, -71.0589, 42.3601, 36.8219, -1.2921],
			box(-71.0589, -1.2921, 36.8219, 42.3601)
		],
		['leaves 0 and 180 off ±180', [0, 0, 180, 0], box(-180, 0, 0, 0)],
		['leaves -90 and 90 off ±180', [-90, 0, 90, 0], box(-90, 0, 90, 0)],
		['leaves 45 and -135 off ±180', [45, 0, -135, 0], box(-135, 0, 45, 0)],
		['gives ±180 one longitude', [180, 10, -180, 12], box(-180, 10, -180, 12)],
		['takes the short way across the prime meridian', [-1, 51, 1, 52], box(-1, 51, 1, 52)],
		[
			'takes the ordinary way for content not crossing the antimeridian',
			[-9.1393, 38.7223, 4.9041, 52.3676],
			box(-9.1393, 38.7223, 4.9041, 52.3676)
		],
		[
			'refuses coordinates that are not numbers rather than producing a NaN box',
			[4.9041, 52.3676, Number.NaN, 52.4],
			point(4.9041, 52.3676)
		]
	] as [string, number[], GeoBounds][])('%s', (_description, positions, expected) => {
		expect(projectOpeningBounds(pins(...pairs(positions)))).toEqual(expected);
	});

	it('frames a whole-world Polygon on the world, not on the sliver between its corners', () => {
		const ring = pairs([-179, -85, 179, -85, 179, 85, -179, 85, -179, -85]);
		const world = feature({ type: 'Polygon', coordinates: [ring] });
		expect(projectOpeningBounds([notes([world, pin(4.9041, 52.3676)])])).toEqual(
			box(-179, -85, 179, 85)
		);
	});

	it.each([
		['the long way', [-170, 10], [170, 20], box(-170, 10, 170, 20)],
		['across the antimeridian', [170, 10], [190, 20], box(170, 10, 190, 20)]
	] as [string, Position, Position, GeoBounds][])(
		'follows a two-vertex LineString written %s',
		(_description, from, to, expected) => {
			expect(projectOpeningBounds([notes([line(from, to)])])).toEqual(expected);
		}
	);

	it('breaks a path at a damaged position rather than joining across it', () => {
		const torn = line([-71.2, 42.3], [Number.NaN, 42.35], [179, 42.4]);
		expect(projectOpeningBounds([notes([torn])])).toEqual(box(179, 42.3, 288.8, 42.4));
	});

	const sheetOf = (flat: number[], type?: TransformationType) => {
		const points = Array.from({ length: flat.length / 4 }, (_, index) =>
			flat.slice(4 * index, 4 * index + 4)
		) as [number, number, number, number][];
		return alignedSheet(points, type ? { type } : {});
	};

	it.each([
		[
			'a degenerate Alignment throws the sheet off the earth',
			sheetOf([100, 100, -71.1, 42.3, 200, 200, -71.1, 42.3, 300, 300, -71.1, 42.3])
		],
		[
			'the solver refuses the Control Points outright',
			sheetOf(
				[100, 100, -71.1, 42.3, 100, 100, -71.0, 42.3, 100, 100, -71.0, 42.4],
				'thinPlateSpline'
			)
		],
		[
			'a Control Point’s own coordinate is not a number',
			sheetOf([100, 100, Number.NaN, 42.38, 400, 100, -71.06, 42.38, 400, 300, -71.06, 42.36])
		],
		[
			'the solve is singular vertically',
			sheetOf([100, 100, -71.1, 42.3, 100, 200, -71.0, 42.35, 100, 300, -70.9, 42.4])
		],
		[
			'the solve is singular horizontally',
			sheetOf([100, 100, -71.1, 42.3, 200, 100, -71.0, 42.35, 300, 100, -70.9, 42.4])
		]
	])('declines a sheet, and keeps the Project, when %s', (_description, alignment) => {
		expect(projectOpeningBounds([sheet(alignment)])).toBeNull();
		expect(projectOpeningBounds([sheet(alignment), notes([pin(-71.0656, 42.3554)])])).toEqual(
			point(-71.0656, 42.3554)
		);
	});

	it('follows a warped edge outside the quadrilateral its corners describe', () => {
		const spline = sheetOf(
			[
				...[100, 100, -71.12, 42.4, 900, 120, -70.98, 42.398, 920, 700, -70.985, 42.305],
				...[120, 680, -71.115, 42.31, 500, 400, -71.02, 42.36]
			],
			'thinPlateSpline'
		);

		const bounds = projectOpeningBounds([sheet(spline)]);
		const transformer = new GcpTransformer(toRendererControlPoints(spline), 'thinPlateSpline');
		const corners = WHOLE_SHEET.map(({ x, y }) => transformer.transformToGeo([x, y] as Position));
		const cornersEast = Math.max(...corners.map(([lng]) => lng as number));
		const cornersNorth = Math.max(...corners.map(([, lat]) => lat as number));
		expect(cornersEast).toBeCloseTo(-70.9696766, 6);
		expect(cornersNorth).toBeCloseTo(42.4153825, 6);
		expect(bounds?.east).toBeCloseTo(-70.9672005, 6);
		expect(bounds?.north).toBeCloseTo(42.4186507, 6);
		expect(bounds!.east).toBeGreaterThan(cornersEast);
		expect(bounds!.north).toBeGreaterThan(cornersNorth);
	});
});

describe('alignmentOpeningBounds', () => {
	const elsewhere = pins([4.9041, 52.3676]);

	it.each([
		[
			'the Control Points of a half-finished Alignment',
			BOSTON_SHEET,
			elsewhere,
			BOSTON_CONTROL_POINTS
		],
		[
			'a single Control Point, where the work was left',
			alignedSheet([[250, 200, -71.1, 42.36]]),
			[],
			point(-71.1, 42.36)
		],
		[
			'the Project when the Alignment has no Control Points yet',
			alignedSheet([]),
			elsewhere,
			point(4.9041, 52.3676)
		],
		['nothing when neither has a place', null, [], null]
	] as [string, Alignment | null, ContentLayer[], GeoBounds | null][])(
		'lands on %s',
		(_description, alignment, content, expected) => {
			expect(alignmentOpeningBounds(alignment, content)).toEqual(expected);
		}
	);
});

describe('the fits both apps use', () => {
	const bostonPin = pins([-71.0656, 42.3554]);

	it('is the bounds and the fit in one call, so neither app writes that line for itself', () => {
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

		fitted = applyOpeningFit(map, first, fitted);
		expect(map.fitBounds).toHaveBeenCalledTimes(1);
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
