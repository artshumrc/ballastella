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
	isFullImageResourceMask,
	isTransformationOffered,
	maskEdgeMidpoints,
	MINIMUM_CONTROL_POINTS,
	MINIMUM_MASK_VERTICES,
	moveMaskVertex,
	NEVER_OFFERED_TRANSFORMATION_NAMES,
	newAlignment,
	removeMaskVertex,
	resetMaskToFullImage,
	toDraftControlPoints,
	TRANSFORMATION_CHOICES,
	transformationShortfall,
	type Alignment,
	type DraftControlPoint,
	type TransformationType,
	withTransformationType
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
	// ADR-0023: one Alignment per Map Image, at the **Workspace** root, so that "where is this map
	// on the earth" has one answer whichever Projects draw it. The path is complete — there is no
	// Project-rooted spelling of it any more, which is what makes two Projects reading the same image id
	// read the same file rather than two that drift apart.
	it('is one file per Map Image, at the Workspace root (ADR-0023)', () => {
		expect(alignmentPath('floride-1657')).toBe('alignments/floride-1657.json');
		expect(alignmentPath('floride-1657').startsWith(`${ALIGNMENT_DIRECTORY}/`)).toBe(true);
		expect(alignmentPath('floride-1657')).not.toContain('amsterdam-1625');
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

		expect(canSolve({ ...base, controlPoints: pairs(2) })).toBe(false);
		expect(canSolve({ ...base, controlPoints: pairs(3) })).toBe(true);
		expect(canSolve({ ...base, controlPoints: pairs(4) })).toBe(true);
	});

	it('gates each offered type on its own minimum, not on the default’s', () => {
		const base = newAlignment('floride-1657', { width: 1200, height: 851 });

		for (const choice of TRANSFORMATION_CHOICES) {
			const justBelow = withTransformationType(
				{ ...base, controlPoints: pairs(choice.minimumControlPoints - 1) },
				choice.type
			);
			const justAt = withTransformationType(
				{ ...base, controlPoints: pairs(choice.minimumControlPoints) },
				choice.type
			);

			expect(canSolve(justBelow), `${choice.type} below its minimum`).toBe(false);
			expect(canSolve(justAt), `${choice.type} at its minimum`).toBe(true);
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
	it('offers four primary types and two behind Advanced, in the ADR’s order', () => {
		expect(
			TRANSFORMATION_CHOICES.filter((choice) => choice.tier === 'primary').map(
				(choice) => choice.type
			)
		).toEqual(['helmert', 'polynomial1', 'projective', 'thinPlateSpline']);

		expect(
			TRANSFORMATION_CHOICES.filter((choice) => choice.tier === 'advanced').map(
				(choice) => choice.type
			)
		).toEqual(['polynomial2', 'polynomial3']);
	});

	// **The guidance is the primary text and the label is secondary** (ADR-0013): "Most printed maps"
	// is what a historian can act on; "Standard" is not. Both exist for every type, so a component
	// cannot render a picker with one of them missing.
	it('gives every type both a label and guidance, matching the ADR’s table', () => {
		expect(
			TRANSFORMATION_CHOICES.map((choice) => [choice.type, choice.label, choice.guidance])
		).toEqual([
			['helmert', 'Simple', 'Accurate modern maps — rotate, scale, and move only'],
			['polynomial1', 'Standard', 'Most printed and scanned maps'],
			['projective', 'Perspective', 'Maps photographed at an angle'],
			['thinPlateSpline', 'Flexible', 'Hand-drawn or geometrically inconsistent maps'],
			['polynomial2', 'Higher-order (2nd)', 'Only with many well-spread points'],
			['polynomial3', 'Higher-order (3rd)', 'Only with many well-spread points']
		]);
	});

	// `straight` throws in `typeAndOrderToTransformationType`, so offering it produces Alignments that
	// fail to deserialize; the bare `polynomial` leaves the order to be inferred; `linear` has no
	// documented user-facing meaning. None may be offered under any interaction (ADR-0013).
	it('offers none of the three banned names', () => {
		for (const banned of NEVER_OFFERED_TRANSFORMATION_NAMES) {
			expect(isTransformationOffered(banned), banned).toBe(false);
		}
		expect(NEVER_OFFERED_TRANSFORMATION_NAMES).toEqual(['straight', 'polynomial', 'linear']);
	});

	it('offers every type it gates, and gates every type it offers', () => {
		for (const choice of TRANSFORMATION_CHOICES) {
			expect(isTransformationOffered(choice.type), choice.type).toBe(true);
			// One source of truth for the minimum. Two would mean an option the user is allowed to
			// choose and `canSolve` then refuses — or the reverse.
			expect(choice.minimumControlPoints).toBe(MINIMUM_CONTROL_POINTS[choice.type]);
		}
	});

	it('is silent about a type that can be chosen', () => {
		expect(transformationShortfall('polynomial1', 3)).toBe('');
		expect(transformationShortfall('polynomial1', 40)).toBe('');
		expect(transformationShortfall('polynomial3', 10)).toBe('');
	});

	// The shortfall is *named*, not merely implied by a disabled control: a greyed-out option says
	// only that something is wrong, where this says what to do next.
	it('names the shortfall, by label and by both numbers', () => {
		expect(transformationShortfall('thinPlateSpline', 2)).toBe(
			'Flexible needs at least 3 Control Points — you have 2'
		);
		expect(transformationShortfall('polynomial3', 0)).toBe(
			'Higher-order (3rd) needs at least 10 Control Points — you have 0'
		);
		expect(transformationShortfall('projective', 3)).toBe(
			'Perspective needs at least 4 Control Points — you have 3'
		);
	});
});

describe('changing the transformation type', () => {
	const withPoints = (): Alignment => ({
		...newAlignment('floride-1657', { width: 1200, height: 851 }),
		controlPoints: pairs(6),
		resourceMask: [
			{ x: 5, y: 7 },
			{ x: 900, y: 11 },
			{ x: 880, y: 700 },
			{ x: 20, y: 690 }
		]
	});

	// The obvious implementation — reset on change — destroys the user's actual labour. ADR-0013:
	// the Control Points are the work and the transformation is a lens over them.
	it('keeps every Control Point, and the Resource Mask, and the image', () => {
		const before = withPoints();

		let after = before;
		for (const choice of TRANSFORMATION_CHOICES) {
			after = withTransformationType(after, choice.type);
			expect(after.controlPoints, choice.type).toStrictEqual(before.controlPoints);
			expect(after.resourceMask, choice.type).toStrictEqual(before.resourceMask);
			expect(after.image, choice.type).toStrictEqual(before.image);
			expect(after.imageId, choice.type).toBe(before.imageId);
			expect(after.transformationType).toBe(choice.type);
		}

		// Round the houses and back again: still the same six pairs, in the same order.
		expect(withTransformationType(after, before.transformationType)).toStrictEqual(before);
	});

	it('leaves the Alignment it was given alone', () => {
		const before = withPoints();
		const snapshot = structuredClone(before);
		withTransformationType(before, 'projective');
		expect(before).toStrictEqual(snapshot);
	});

	it('can be set below its own minimum, because the picker is what gates that', () => {
		// `withTransformationType` is a lens change and nothing else: refusing here would mean the
		// stored type of a colleague's Alignment could not be held while its Control Points loaded.
		// The gate belongs to the picker, and `canSolve` is what stops the renderer being asked.
		const thin = withTransformationType(
			{ ...newAlignment('a', { width: 10, height: 10 }), controlPoints: pairs(1) },
			'polynomial3'
		);
		expect(thin.transformationType).toBe('polynomial3');
		expect(canSolve(thin)).toBe(false);
	});
});

describe('editing the Resource Mask', () => {
	const square = (): Alignment => newAlignment('floride-1657', { width: 100, height: 80 });

	it('starts as the whole image, and says so', () => {
		expect(isFullImageResourceMask(square())).toBe(true);
		expect(square().resourceMask).toHaveLength(4);
	});

	it('moves one vertex and nothing else', () => {
		const moved = moveMaskVertex(square(), 1, { x: 90, y: 4 });

		expect(moved.resourceMask).toStrictEqual([
			{ x: 0, y: 0 },
			{ x: 90, y: 4 },
			{ x: 100, y: 80 },
			{ x: 0, y: 80 }
		]);
		expect(isFullImageResourceMask(moved)).toBe(false);
		// The Control Points and the type are not the mask's business.
		expect(moved.controlPoints).toStrictEqual([]);
		expect(moved.transformationType).toBe(DEFAULT_TRANSFORMATION_TYPE);
	});

	it('ignores a vertex index that is not there', () => {
		expect(moveMaskVertex(square(), 9, { x: 1, y: 1 })).toStrictEqual(square());
		expect(moveMaskVertex(square(), -1, { x: 1, y: 1 })).toStrictEqual(square());
	});

	// Inserting a vertex must change the outline by nothing at all until the user moves it: an
	// insertion that also moved the mask would be an edit nobody asked for.
	it('inserts a vertex at an edge midpoint, leaving the outline unchanged', () => {
		const grown = insertMaskVertexAfter(square(), 0);

		expect(grown.resourceMask).toStrictEqual([
			{ x: 0, y: 0 },
			{ x: 50, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 80 },
			{ x: 0, y: 80 }
		]);
	});

	it('inserts on the closing edge too, which is the one an index does not obviously reach', () => {
		const grown = insertMaskVertexAfter(square(), 3);

		expect(grown.resourceMask).toHaveLength(5);
		expect(grown.resourceMask.at(-1)).toStrictEqual({ x: 0, y: 40 });
	});

	it('offers a midpoint handle per edge, including the closing one', () => {
		expect(maskEdgeMidpoints(square().resourceMask)).toStrictEqual([
			{ x: 50, y: 0 },
			{ x: 100, y: 40 },
			{ x: 50, y: 80 },
			{ x: 0, y: 40 }
		]);
	});

	it('removes a vertex', () => {
		const smaller = removeMaskVertex(square(), 2);

		expect(smaller.resourceMask).toStrictEqual([
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 0, y: 80 }
		]);
	});

	// **A mask can be made smaller but never emptied.** Upstream refuses a ring of fewer than three
	// vertices outright, so an edit that removed the third would produce an Alignment that cannot be
	// written — and the user would learn about it as a failed save with their outline already gone.
	it('refuses to take the mask below three vertices', () => {
		const triangle = removeMaskVertex(square(), 3);
		expect(triangle.resourceMask).toHaveLength(MINIMUM_MASK_VERTICES);

		expect(removeMaskVertex(triangle, 0)).toStrictEqual(triangle);
		expect(removeMaskVertex(triangle, 1)).toStrictEqual(triangle);
		expect(removeMaskVertex(triangle, 2)).toStrictEqual(triangle);
	});

	it('resets to the whole image, for a user who has outlined themselves into a corner', () => {
		const mangled = moveMaskVertex(moveMaskVertex(square(), 0, { x: 40, y: 40 }), 1, {
			x: 41,
			y: 41
		});
		expect(isFullImageResourceMask(mangled)).toBe(false);

		const reset = resetMaskToFullImage(mangled);
		expect(isFullImageResourceMask(reset)).toBe(true);
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

	it('does not confuse a mask that has the right vertices in the wrong order with the full image', () => {
		const reordered: Alignment = {
			...square(),
			resourceMask: [
				{ x: 100, y: 0 },
				{ x: 0, y: 0 },
				{ x: 100, y: 80 },
				{ x: 0, y: 80 }
			]
		};
		expect(isFullImageResourceMask(reordered)).toBe(false);
	});
});

describe('every offered type is one this codebase can hold', () => {
	it('types the picker against TransformationType, so a typo is a compile error', () => {
		// Not a runtime check so much as a statement that the two agree: the assignment is what
		// carries it, and the assertion is here so the file is not silently vacuous.
		const held: readonly TransformationType[] = TRANSFORMATION_CHOICES.map((choice) => choice.type);
		expect(held).toHaveLength(6);
		expect(new Set(held).size).toBe(6);
	});
});

/**
 * The positive control for the one function five modules across core ask the same question of.
 *
 * It lives here, beside the function, because here is where a maintainer tightening what counts as
 * an Alignment path will edit — and every one of those call sites moves with it. `replay.ts` is the
 * sharpest: the routing in its `write` and the refusal in its `writePlain` both consult it, so
 * loosening or narrowing moves the branch and its guard together and in the same direction, the
 * guard stops catching exactly the paths the branch stopped routing, and nothing anywhere goes red.
 * `clone-from-remote.ts`, `update-from-github.ts`, `review-from-remote.ts` and
 * `restore-workspace-tar.ts` each route a write the same way from the same answer. The specimens
 * below are the spellings on either side of the line, taken from `hoistedImageId`, which answers the
 * same question for the two tar readers.
 */
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
