// The fold warning (ADR-0013): the correctness signal a student gets for free.
//
// These are Seam 1 tests on purpose. The fold check is deliberately not read out of the renderer's
// triangulation — a warning that exists only while a WebGL layer does is a warning that cannot be
// asserted here, and that is absent at exactly the moments the user most needs it. So it is a
// function over an Alignment, and this file drives it with Control Points that fold and Control
// Points that do not.

import { describe, expect, it } from 'vitest';

import {
	collectControlPoints,
	newAlignment,
	withTransformationType,
	type Alignment,
	type DraftControlPoint,
	type TransformationType
} from './alignment.js';
import {
	COMPUTED_DISTORTION_MEASURES,
	DEFAULT_DISTORTION_MEASURE,
	DEFAULT_DISTORTION_VIEW,
	DISTORTION_MEASURES,
	FOLD_DISTORTION_MEASURE,
	detectFold
} from './distortion.js';

const IMAGE = { width: 100, height: 100 };

const alignmentOf = (
	pairs: readonly (readonly [number, number, number, number])[],
	transformationType: TransformationType = 'polynomial1'
): Alignment => {
	const drafts: DraftControlPoint[] = pairs.map(([x, y, lng, lat], index) => ({
		id: `p${index}`,
		resource: { x, y },
		geo: { lng, lat }
	}));
	return withTransformationType(
		{ ...newAlignment('sheet', IMAGE), controlPoints: collectControlPoints(drafts) },
		transformationType
	);
};

/**
 * The image's four corners onto a square of earth, the right way up.
 *
 * Image y points down and geographic latitude points up, so the top of the image is the *north*
 * edge — which is what makes this the well-behaved case rather than a mirrored one.
 */
const UPRIGHT = [
	[0, 0, 0, 1],
	[100, 0, 1, 1],
	[100, 100, 1, 0],
	[0, 100, 0, 0]
] as const;

/** The same four corners with the left and right edges exchanged: a mirrored sheet. */
const MIRRORED = [
	[0, 0, 1, 1],
	[100, 0, 0, 1],
	[100, 100, 0, 0],
	[0, 100, 1, 0]
] as const;

describe('which distortion measures exist', () => {
	// The one that would be a real defect: `distortionMeasure` chooses what is DISPLAYED and
	// `distortionMeasures` chooses what is COMPUTED, and displaying a measure that was never
	// computed draws the map with no colouring — indistinguishable from "this map has no
	// distortion". So the computed set is derived from the picker rather than written out.
	it('computes every measure the picker can display', () => {
		expect([...COMPUTED_DISTORTION_MEASURES].sort()).toEqual(
			DISTORTION_MEASURES.map((choice) => choice.measure).sort()
		);
	});

	it('offers exactly the two ADR-0013 exposes, with log2sigma the default', () => {
		expect(DISTORTION_MEASURES.map((choice) => choice.measure)).toEqual(['log2sigma', 'signDetJ']);
		expect(DEFAULT_DISTORTION_MEASURE).toBe('log2sigma');
		expect(FOLD_DISTORTION_MEASURE).toBe('signDetJ');
	});

	// `thetaa` is an angle and angles are cyclic, so a linear five-stop ramp would render 359° and
	// 1° at opposite ends of the scale. `twoOmega` and `airyKavr` are redundant for this audience.
	it('exposes neither thetaa nor the two redundant measures', () => {
		const offered = COMPUTED_DISTORTION_MEASURES as readonly string[];
		expect(offered).not.toContain('thetaa');
		expect(offered).not.toContain('twoOmega');
		expect(offered).not.toContain('airyKavr');
	});

	it('opens with no colouring and no graticule', () => {
		expect(DEFAULT_DISTORTION_VIEW).toStrictEqual({ measure: null, grid: false });
	});
});

describe('the fold check', () => {
	it('says nothing about an Alignment that does not fold', () => {
		expect(detectFold(alignmentOf(UPRIGHT))).toBeNull();
	});

	// The criterion, and ADR-0013's "single most useful piece of feedback a student can get":
	// `nonWarpingTransformationTypes` includes `polynomial1`, so it cannot fold *locally* — but it
	// can be globally mirrored, and that is the swapped-Control-Point error.
	it('catches a mirrored pair set under an affine transformation', () => {
		const warning = detectFold(alignmentOf(MIRRORED, 'polynomial1'));

		expect(warning).not.toBeNull();
		expect(warning?.kind).toBe('mirrored');
		expect(warning?.message).toContain('mirrored');
		expect(warning?.message).toContain('Two Control Points');
		// Every sample folded, which is what "the whole sheet is turned over" means.
		expect(warning?.foldedSamples).toBe(warning?.sampleCount);
		// And the message does not send the reader to a corner: the problem is the whole sheet.
		expect(warning?.message).not.toContain('near the');
	});

	it('catches it under thinPlateSpline and projective too', () => {
		expect(detectFold(alignmentOf(MIRRORED, 'thinPlateSpline'))?.kind).toBe('mirrored');
		expect(detectFold(alignmentOf(MIRRORED, 'projective'))?.kind).toBe('mirrored');
	});

	// Helmert is a similarity: it has no reflection to fit, so a least-squares solve over mirrored
	// Control Points comes back unmirrored rather than folded. Recorded because it is a real limit
	// of the warning and not a defect — under Simple, a swapped pair shows as a badly placed map.
	it('cannot see a mirror under helmert, because helmert cannot express one', () => {
		expect(detectFold(alignmentOf(MIRRORED, 'helmert'))).toBeNull();
	});

	// A local fold: four corners placed sensibly and a fifth Control Point in the middle dragged
	// far outside them. This is the case the interpolating and perspective types can produce and
	// affine cannot.
	it('reports a fold that covers only part of the sheet as local, and names the part', () => {
		const folded = detectFold(
			alignmentOf([...UPRIGHT, [85, 15, -3, 4]] as const, 'thinPlateSpline')
		);

		expect(folded).not.toBeNull();
		expect(folded?.kind).toBe('local');
		// Some of the sheet folds and some does not, which is what distinguishes a misplaced Control
		// Point from a mirrored sheet. Where exactly a thin-plate spline's fold lands is a property of
		// the interpolation and not something to pin; that it is named, and that the name is in the
		// sentence the user reads, is the contract.
		expect(folded?.foldedSamples).toBeGreaterThan(0);
		expect(folded?.foldedSamples).toBeLessThan(folded?.sampleCount ?? 0);
		expect(folded?.where).not.toBe('');
		expect(folded?.message).toContain(`folds over itself near the ${folded?.where}`);
		expect(folded?.message).toContain('Control Point');
	});

	// The region is named against the **image**, not against the mask's own bounding box: the user is
	// looking at the whole sheet, so "the top-right" has to mean the top-right of what is on screen.
	// Asserted by masking a single corner of a wholly mirrored sheet, where every folded sample is
	// inside that corner and the answer is therefore not a property of the interpolation.
	it.each([
		{ where: 'top-right', mask: [0.6, 0.0, 1.0, 0.3] },
		{ where: 'bottom-left', mask: [0.0, 0.7, 0.35, 1.0] },
		{ where: 'top', mask: [0.4, 0.0, 0.6, 0.25] },
		{ where: 'centre', mask: [0.4, 0.4, 0.6, 0.6] }
	])('names a fold confined to the $where of the image as exactly that', ({ where, mask }) => {
		const [x0, y0, x1, y1] = mask as [number, number, number, number];
		const box = [
			{ x: x0 * IMAGE.width, y: y0 * IMAGE.height },
			{ x: x1 * IMAGE.width, y: y0 * IMAGE.height },
			{ x: x1 * IMAGE.width, y: y1 * IMAGE.height },
			{ x: x0 * IMAGE.width, y: y1 * IMAGE.height }
		];

		// Two Control Points swapped makes every point of the sheet fold, so which points are
		// *sampled* is entirely the mask's doing — and the mask here is one region of the image.
		const warning = detectFold({ ...alignmentOf(MIRRORED), resourceMask: box });

		// It folds everywhere it was measured, so this reads as mirrored; the region is still measured,
		// which is what is under test.
		expect(warning?.kind).toBe('mirrored');
		expect(warning?.where).toBe(where);
	});

	it('says nothing when there are too few Control Points to solve at all', () => {
		const twoPairs = alignmentOf(MIRRORED.slice(0, 2), 'polynomial1');
		expect(twoPairs.controlPoints).toHaveLength(2);
		expect(detectFold(twoPairs)).toBeNull();
	});

	// The Control Points may be degenerate — all on one line, all in one place — and the solver
	// throws on some of those. A warning is feedback on a working Alignment; turning a failed solve
	// into "your Alignment folds" would be a claim the measurement does not support.
	it('says nothing rather than throwing when the solve is refused', () => {
		const collinear = alignmentOf(
			[
				[0, 0, 0, 0],
				[10, 10, 0.1, 0.1],
				[20, 20, 0.2, 0.2],
				[30, 30, 0.3, 0.3]
			] as const,
			'projective'
		);

		expect(() => detectFold(collinear)).not.toThrow();
	});

	// **The case the title promises**, which the mirrored set cannot demonstrate: a fold that exists
	// in a margin and nowhere else. A margin is the part of the sheet the user has excluded, so a
	// warning about it would send them to look at something the Alignment does not draw.
	//
	// Built as a local fold placed deliberately in the left margin — the four well-behaved corners
	// plus one Control Point at image (15, 50) sent to a longitude nowhere near the sheet — and then
	// measured twice: once with the mask as the whole sheet, where the warning appears and names the
	// left, and once with the left margin outlined out of the map, where it is gone entirely.
	it('does not report a fold that lies only in a margin the mask excludes', () => {
		const withMargin = alignmentOf([...UPRIGHT, [15, 50, -2, 0.5]] as const, 'thinPlateSpline');

		const whole = detectFold(withMargin);
		expect(whole, 'the fold has to be there before excluding it can mean anything').not.toBeNull();
		expect(whole?.kind).toBe('local');
		expect(whole?.where).toContain('left');

		// The same Alignment, with the left third of the sheet outlined out of the map. Nothing about
		// the Control Points changes — only which part of the sheet is sampled.
		const withoutMargin = detectFold({
			...withMargin,
			resourceMask: [
				{ x: 40, y: 0 },
				{ x: 100, y: 0 },
				{ x: 100, y: 100 },
				{ x: 40, y: 100 }
			]
		});
		expect(withoutMargin).toBeNull();
	});

	it('samples inside the Resource Mask rather than across the whole image', () => {
		// The mirrored set folds everywhere, so any mask at all yields a warning; what is asserted
		// here is that the sample count follows the mask's shape rather than the image's.
		const whole = detectFold(alignmentOf(MIRRORED));
		const narrowed = detectFold({
			...alignmentOf(MIRRORED),
			resourceMask: [
				{ x: 0, y: 0 },
				{ x: 20, y: 0 },
				{ x: 20, y: 20 },
				{ x: 0, y: 20 }
			]
		});

		expect(whole?.sampleCount).toBeGreaterThan(0);
		// A quarter of the width and a quarter of the height is the same *grid*, so the counts match
		// — what has to hold is that a mask which excludes most of the sheet is still sampled, and
		// that the samples are inside it.
		expect(narrowed?.sampleCount).toBe(whole?.sampleCount);

		// And a mask with a hole cut out of the middle by concavity samples fewer points than its
		// own bounding box would.
		const concave = detectFold({
			...alignmentOf(MIRRORED),
			resourceMask: [
				{ x: 0, y: 0 },
				{ x: 100, y: 0 },
				{ x: 100, y: 100 },
				{ x: 50, y: 10 },
				{ x: 0, y: 100 }
			]
		});
		expect(concave?.sampleCount).toBeLessThan(whole?.sampleCount ?? 0);
	});

	// ADR-0013's "the fold check runs continuously and warns independently of the overlay" is not
	// asserted here, on purpose. A test doing `expect(detectFold.length).toBe(1)` would be wrong twice
	// over: CONTRIBUTING rules out assertions on module structure, and it could not fail anyway — a
	// second parameter with a default value leaves the arity at 1. The property is observable only
	// where an overlay exists to be off, so it is asserted where it is observable:
	// `editor-alignment-refinement.e2e.ts`, "appears for a mirrored pair set under an affine
	// transformation, with the overlay off", which reads the *renderer's* `distortionMeasure` as
	// `undefined` in the same breath as the visible warning.
});
