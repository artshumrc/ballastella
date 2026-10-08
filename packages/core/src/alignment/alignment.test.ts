import { describe, expect, it } from 'vitest';

import {
	ALIGNMENT_DIRECTORY,
	alignmentImageId,
	alignmentPath,
	canSolve,
	collectControlPoints,
	DEFAULT_TRANSFORMATION_TYPE,
	fullImageResourceMask,
	insertMaskVertexAfter,
	maskEdgeMidpoints,
	MINIMUM_CONTROL_POINTS,
	MINIMUM_MASK_VERTICES,
	moveMaskVertex,
	newAlignment,
	removeMaskVertex,
	resetMaskToFullImage,
	toDraftControlPoints,
	TRANSFORMATION_CHOICES,
	transformationShortfall,
	type Alignment,
	type DraftControlPoint
} from './alignment.js';

const resource = (x: number, y: number) => ({ x, y });
const geo = (lng: number, lat: number) => ({ lng, lat });

describe('a new Alignment', () => {
	it('starts with no Control Points, the whole image masked, and the default type', () => {
		const alignment = newAlignment('floride-1657', { width: 1200, height: 851 });
		expect(alignment.controlPoints).toEqual([]);
		expect(alignment.transformationType).toBe('polynomial1');
		expect(alignment.resourceMask).toEqual([
			{ x: 0, y: 0 },
			{ x: 1200, y: 0 },
			{ x: 1200, y: 851 },
			{ x: 0, y: 851 }
		]);
		expect(alignment.resourceMask).toStrictEqual(fullImageResourceMask(alignment.image));
	});

	it('lives in one file per Map Image, at the Workspace root (ADR-0023)', () => {
		expect(ALIGNMENT_DIRECTORY).toBe('alignments');
		expect(alignmentPath('floride-1657')).toBe('alignments/floride-1657.json');
	});
});

describe('collecting Control Points from drafts', () => {
	it('numbers complete pairs from 1, in order, and nothing from nothing', () => {
		expect(collectControlPoints([])).toEqual([]);
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

	it('skips a half-pair whichever half is missing, leaving committed ordinals contiguous', () => {
		const points = collectControlPoints([
			{ id: 'a', resource: resource(1, 1), geo: geo(1, 1) },
			{ id: 'geo-only', resource: null, geo: geo(4.1, 52.1) },
			{ id: 'resource-only', resource: resource(10, 20), geo: null },
			{ id: 'b', resource: resource(3, 3), geo: geo(3, 3) }
		]);

		expect(points.map((point) => [point.id, point.ordinal])).toEqual([
			['a', 1],
			['b', 2]
		]);
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
	it('agrees with ADR-0013’s table, defaulting to the type that needs three points', () => {
		expect(DEFAULT_TRANSFORMATION_TYPE).toBe('polynomial1');
		expect(MINIMUM_CONTROL_POINTS).toMatchObject({
			helmert: 2,
			polynomial1: 3,
			projective: 4,
			thinPlateSpline: 3,
			polynomial2: 6,
			polynomial3: 10
		});
	});

	it('gates each offered type on its own minimum, not on the default’s', () => {
		const base = newAlignment('floride-1657', { width: 1200, height: 851 });
		expect(canSolve({ ...base, controlPoints: pairs(4) })).toBe(true);

		for (const { type, minimumControlPoints } of TRANSFORMATION_CHOICES) {
			const withPoints = (count: number): Alignment => ({
				...base,
				controlPoints: pairs(count),
				transformationType: type
			});
			expect(canSolve(withPoints(minimumControlPoints - 1)), `${type} below`).toBe(false);
			expect(canSolve(withPoints(minimumControlPoints)), `${type} at`).toBe(true);
		}
	});
});

const drafts = (count: number): DraftControlPoint[] =>
	Array.from({ length: count }, (_, index) => ({
		id: `p${index}`,
		resource: resource(index, index),
		geo: geo(index, index)
	}));

const pairs = (count: number) => collectControlPoints(drafts(count));

describe('the transformation picker (ADR-0013)', () => {
	it('offers four primary types and two behind Advanced, labelled and guided as the ADR’s table', () => {
		expect(
			TRANSFORMATION_CHOICES.map(({ type, tier, label, guidance }) => [type, tier, label, guidance])
		).toEqual([
			['helmert', 'primary', 'Simple', 'Accurate modern maps — rotate, scale, and move only'],
			['polynomial1', 'primary', 'Standard', 'Most printed and scanned maps'],
			['projective', 'primary', 'Perspective', 'Maps photographed at an angle'],
			['thinPlateSpline', 'primary', 'Flexible', 'Hand-drawn or geometrically inconsistent maps'],
			['polynomial2', 'advanced', 'Higher-order (2nd)', 'Only with many well-spread points'],
			['polynomial3', 'advanced', 'Higher-order (3rd)', 'Only with many well-spread points']
		]);
	});

	it.each([
		['polynomial1', 3, ''],
		['polynomial1', 40, ''],
		['polynomial3', 10, ''],
		['thinPlateSpline', 2, 'Flexible needs at least 3 Control Points — you have 2'],
		['polynomial3', 0, 'Higher-order (3rd) needs at least 10 Control Points — you have 0'],
		['projective', 3, 'Perspective needs at least 4 Control Points — you have 3']
	] as const)(
		'names any shortfall for %s at %i points, by label and both numbers',
		(type, count, said) => {
			expect(transformationShortfall(type, count)).toBe(said);
		}
	);
});

describe('editing the Resource Mask', () => {
	const square = (): Alignment => newAlignment('floride-1657', { width: 100, height: 80 });

	it('moves one vertex and nothing else', () => {
		const moved = moveMaskVertex(square(), 1, { x: 90, y: 4 });

		expect(moved.resourceMask).toStrictEqual([
			{ x: 0, y: 0 },
			{ x: 90, y: 4 },
			{ x: 100, y: 80 },
			{ x: 0, y: 80 }
		]);
		expect(moved.controlPoints).toStrictEqual([]);
		expect(moved.transformationType).toBe(DEFAULT_TRANSFORMATION_TYPE);
	});

	it('ignores a vertex index that is not there', () => {
		expect(moveMaskVertex(square(), 9, { x: 1, y: 1 })).toStrictEqual(square());
		expect(moveMaskVertex(square(), -1, { x: 1, y: 1 })).toStrictEqual(square());
	});

	it('inserts a vertex at an edge midpoint, the closing edge too, leaving the outline unchanged', () => {
		expect(insertMaskVertexAfter(square(), 0).resourceMask).toStrictEqual([
			{ x: 0, y: 0 },
			{ x: 50, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 80 },
			{ x: 0, y: 80 }
		]);
		const closing = insertMaskVertexAfter(square(), 3);
		expect(closing.resourceMask).toHaveLength(5);
		expect(closing.resourceMask.at(-1)).toStrictEqual({ x: 0, y: 40 });
	});

	it('offers a midpoint handle per edge, including the closing one', () => {
		expect(maskEdgeMidpoints(square().resourceMask)).toStrictEqual([
			{ x: 50, y: 0 },
			{ x: 100, y: 40 },
			{ x: 50, y: 80 },
			{ x: 0, y: 40 }
		]);
	});

	it('removes a vertex, but never below three', () => {
		const triangle = removeMaskVertex(square(), 2);
		expect(triangle.resourceMask).toStrictEqual([
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 0, y: 80 }
		]);
		expect(triangle.resourceMask).toHaveLength(MINIMUM_MASK_VERTICES);
		for (const index of [0, 1, 2])
			expect(removeMaskVertex(triangle, index)).toStrictEqual(triangle);
	});

	it('resets to the whole image, for a user who has outlined themselves into a corner', () => {
		const mangled = moveMaskVertex(moveMaskVertex(square(), 0, { x: 40, y: 40 }), 1, {
			x: 41,
			y: 41
		});
		const reset = resetMaskToFullImage(mangled);
		expect(reset.resourceMask).toStrictEqual(square().resourceMask);
	});

	it('leaves the Alignment it was given alone', () => {
		const before = square();
		const snapshot = structuredClone(before);
		moveMaskVertex(before, 0, { x: 9, y: 9 });
		insertMaskVertexAfter(before, 0);
		removeMaskVertex(before, 0);
		resetMaskToFullImage(before);
		expect(before).toStrictEqual(snapshot);
	});
});

describe('alignmentImageId — what counts as an Alignment path', () => {
	it.each([
		['alignments/floride-1657.json', 'floride-1657'],
		['alignments/a.b.json', 'a.b']
	])('reads %s as the Alignment of %s', (path, imageId) => {
		expect(alignmentImageId(path)).toBe(imageId);
	});

	it.each([
		'alignments/nested/thing.json',
		'alignments/.json',
		'alignments/floride-1657.geojson',
		'alignments',
		// project-rooted-path-is-the-fixture: the ADR-0023 decoy itself — a Project-rooted Alignment path, asserted here to be one `alignmentImageId` refuses to recognise
		'amsterdam-1625/alignments/floride-1657.json',
		'images/floride-1657/info.json'
	])('does not read %s as an Alignment path', (path) => {
		expect(alignmentImageId(path)).toBeNull();
	});
});
