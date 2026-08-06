import { describe, expect, it } from 'vitest';

import {
	alignmentPath,
	alignmentStorePath,
	canSolve,
	collectControlPoints,
	fullImageResourceMask,
	newAlignment,
	toDraftControlPoints,
	DEFAULT_TRANSFORMATION_TYPE,
	MINIMUM_CONTROL_POINTS,
	type DraftControlPoint
} from './alignment.js';

const resource = (x: number, y: number) => ({ x, y });
const geo = (lng: number, lat: number) => ({ lng, lat });

describe('a new Alignment', () => {
	it('starts with no Control Points, the whole image masked, and the default type', () => {
		const alignment = newAlignment('floride-1657', { width: 1200, height: 851 });

		expect(alignment.controlPoints).toEqual([]);
		expect(alignment.transformationType).toBe('polynomial1');
		// Not empty, per ADR-0013: an empty mask renders nothing, which reads as a broken tool on a
		// user's very first Alignment.
		expect(alignment.resourceMask).toEqual([
			{ x: 0, y: 0 },
			{ x: 1200, y: 0 },
			{ x: 1200, y: 851 },
			{ x: 0, y: 851 }
		]);
	});

	it('defaults the Resource Mask to the full image rectangle', () => {
		expect(fullImageResourceMask({ width: 4, height: 6 })).toHaveLength(4);
	});
});

describe('where an Alignment lives', () => {
	it('is one file per Historical Map, under the Project (ADR-0008)', () => {
		expect(alignmentPath('floride-1657')).toBe('alignments/floride-1657.json');
		expect(alignmentStorePath('amsterdam-1625', 'floride-1657')).toBe(
			'amsterdam-1625/alignments/floride-1657.json'
		);
	});
});

describe('collecting Control Points from drafts', () => {
	it('numbers complete pairs from 1, in order', () => {
		const points = collectControlPoints([
			{ id: 'a', resource: resource(10, 20), geo: geo(4.1, 52.1) },
			{ id: 'b', resource: resource(30, 40), geo: geo(4.2, 52.2) },
			{ id: 'c', resource: resource(50, 60), geo: geo(4.3, 52.3) }
		]);

		expect(points.map((point) => point.ordinal)).toEqual([1, 2, 3]);
		expect(points.map((point) => point.id)).toEqual(['a', 'b', 'c']);
		expect(points[0]?.resource).toEqual({ x: 10, y: 20 });
		expect(points[0]?.geo).toEqual({ lng: 4.1, lat: 52.1 });
	});

	// The behaviour ADR-0022 and ADR-0017 both turn on. Autosave fires constantly, so a version
	// that threw here — or that wrote a GCP with one half missing — would fail on the *first click
	// of every pair*, which is the single most common moment in the application.
	it('skips a half-pair rather than throwing on it', () => {
		const drafts: DraftControlPoint[] = [
			{ id: 'a', resource: resource(10, 20), geo: geo(4.1, 52.1) },
			{ id: 'pending', resource: resource(99, 99), geo: null }
		];

		expect(() => collectControlPoints(drafts)).not.toThrow();
		const points = collectControlPoints(drafts);
		expect(points).toHaveLength(1);
		expect(points.map((point) => point.id)).toEqual(['a']);
	});

	it('skips a half-pair whichever half is missing', () => {
		const points = collectControlPoints([
			{ id: 'geo-only', resource: null, geo: geo(4.1, 52.1) },
			{ id: 'resource-only', resource: resource(10, 20), geo: null },
			{ id: 'complete', resource: resource(30, 40), geo: geo(4.2, 52.2) }
		]);

		expect(points.map((point) => point.id)).toEqual(['complete']);
		expect(points[0]?.ordinal).toBe(1);
	});

	it('leaves committed ordinals contiguous while a pair is half-made', () => {
		// Numbering runs over complete pairs only, so an incomplete draft anywhere in the list — not
		// merely at the end, where click-then-click puts it — cannot make the visible numbers jump.
		const points = collectControlPoints([
			{ id: 'a', resource: resource(1, 1), geo: geo(1, 1) },
			{ id: 'half', resource: resource(2, 2), geo: null },
			{ id: 'b', resource: resource(3, 3), geo: geo(3, 3) }
		]);

		expect(points.map((point) => [point.id, point.ordinal])).toEqual([
			['a', 1],
			['b', 2]
		]);
	});

	it('produces nothing at all from nothing, without complaint', () => {
		expect(collectControlPoints([])).toEqual([]);
	});
});

describe('resuming the pairing UI from a stored Alignment', () => {
	it('turns Control Points back into drafts, both halves intact', () => {
		const alignment = {
			...newAlignment('floride-1657', { width: 1200, height: 851 }),
			controlPoints: collectControlPoints([
				{ id: 'a', resource: resource(10, 20), geo: geo(4.1, 52.1) },
				{ id: 'b', resource: resource(30, 40), geo: geo(4.2, 52.2) }
			])
		};

		expect(toDraftControlPoints(alignment)).toEqual([
			{ id: 'a', resource: { x: 10, y: 20 }, geo: { lng: 4.1, lat: 52.1 } },
			{ id: 'b', resource: { x: 30, y: 40 }, geo: { lng: 4.2, lat: 52.2 } }
		]);
	});
});

describe('the minimum Control Point count gates the transformation type (ADR-0013)', () => {
	it('agrees with ADR-0013’s table', () => {
		expect(MINIMUM_CONTROL_POINTS.helmert).toBe(2);
		expect(MINIMUM_CONTROL_POINTS.polynomial1).toBe(3);
		expect(MINIMUM_CONTROL_POINTS.projective).toBe(4);
		expect(MINIMUM_CONTROL_POINTS.thinPlateSpline).toBe(3);
		expect(MINIMUM_CONTROL_POINTS.polynomial2).toBe(6);
		expect(MINIMUM_CONTROL_POINTS.polynomial3).toBe(10);
	});

	it('defaults to the type that needs three points', () => {
		expect(DEFAULT_TRANSFORMATION_TYPE).toBe('polynomial1');
		expect(MINIMUM_CONTROL_POINTS[DEFAULT_TRANSFORMATION_TYPE]).toBe(3);
	});

	it('is not solvable below the minimum and is at it', () => {
		const base = newAlignment('floride-1657', { width: 1200, height: 851 });
		const drafts = (count: number): DraftControlPoint[] =>
			Array.from({ length: count }, (_, index) => ({
				id: `p${index}`,
				resource: resource(index, index),
				geo: geo(index, index)
			}));

		expect(canSolve({ ...base, controlPoints: collectControlPoints(drafts(2)) })).toBe(false);
		expect(canSolve({ ...base, controlPoints: collectControlPoints(drafts(3)) })).toBe(true);
		expect(canSolve({ ...base, controlPoints: collectControlPoints(drafts(4)) })).toBe(true);
	});
});
