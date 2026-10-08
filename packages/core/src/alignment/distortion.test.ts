import { describe, expect, it } from 'vitest';

import {
	collectControlPoints,
	newAlignment,
	type Alignment,
	type DraftControlPoint,
	type TransformationType
} from './alignment.js';
import {
	COMPUTED_DISTORTION_MEASURES,
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
	return {
		...newAlignment('sheet', IMAGE),
		controlPoints: collectControlPoints(drafts),
		transformationType
	};
};

const rect = (x0: number, y0: number, x1: number, y1: number) => [
	{ x: x0, y: y0 },
	{ x: x1, y: y0 },
	{ x: x1, y: y1 },
	{ x: x0, y: y1 }
];

const UPRIGHT = [
	[0, 0, 0, 1],
	[100, 0, 1, 1],
	[100, 100, 1, 0],
	[0, 100, 0, 0]
] as const;

const MIRRORED = [
	[0, 0, 1, 1],
	[100, 0, 0, 1],
	[100, 100, 0, 0],
	[0, 100, 1, 0]
] as const;

describe('which distortion measures exist', () => {
	it('offers and computes exactly the two ADR-0013 exposes, with log2sigma the default', () => {
		expect(DISTORTION_MEASURES.map((choice) => choice.measure)).toEqual(['log2sigma', 'signDetJ']);
		expect([...COMPUTED_DISTORTION_MEASURES].sort()).toEqual(['log2sigma', 'signDetJ']);
		expect(FOLD_DISTORTION_MEASURE).toBe('signDetJ');
	});

	it('opens with no colouring and no graticule', () => {
		expect(DEFAULT_DISTORTION_VIEW).toStrictEqual({ measure: null, grid: false });
	});
});

describe('the fold check', () => {
	it('says nothing about an Alignment that does not fold', () => {
		expect(detectFold(alignmentOf(UPRIGHT))).toBeNull();
	});

	it('catches a mirrored pair set under an affine transformation', () => {
		const warning = detectFold(alignmentOf(MIRRORED, 'polynomial1'));
		expect(warning).not.toBeNull();
		expect(warning?.kind).toBe('mirrored');
		expect(warning?.message).toContain('mirrored');
		expect(warning?.message).toContain('Two Control Points');
		expect(warning?.foldedSamples).toBe(warning?.sampleCount);
		expect(warning?.message).not.toContain('near the');
	});

	it('catches it under thinPlateSpline and projective too, and cannot under helmert, which cannot express one', () => {
		expect(detectFold(alignmentOf(MIRRORED, 'thinPlateSpline'))?.kind).toBe('mirrored');
		expect(detectFold(alignmentOf(MIRRORED, 'projective'))?.kind).toBe('mirrored');
		expect(detectFold(alignmentOf(MIRRORED, 'helmert'))).toBeNull();
	});

	it('reports a fold that covers only part of the sheet as local, and names the part', () => {
		const folded = detectFold(
			alignmentOf([...UPRIGHT, [85, 15, -3, 4]] as const, 'thinPlateSpline')
		);

		expect(folded).not.toBeNull();
		expect(folded?.kind).toBe('local');
		expect(folded?.foldedSamples).toBeGreaterThan(0);
		expect(folded?.foldedSamples).toBeLessThan(folded?.sampleCount ?? 0);
		expect(folded?.where).not.toBe('');
		expect(folded?.message).toContain(`folds over itself near the ${folded?.where}`);
		expect(folded?.message).toContain('Control Point');
	});

	it.each([
		{ where: 'top-right', mask: [0.6, 0.0, 1.0, 0.3] },
		{ where: 'bottom-left', mask: [0.0, 0.7, 0.35, 1.0] },
		{ where: 'top', mask: [0.4, 0.0, 0.6, 0.25] },
		{ where: 'centre', mask: [0.4, 0.4, 0.6, 0.6] }
	])('names a fold confined to the $where of the image as exactly that', ({ where, mask }) => {
		const [x0, y0, x1, y1] = mask.map((fraction) => fraction * IMAGE.width) as [
			number,
			number,
			number,
			number
		];

		const warning = detectFold({ ...alignmentOf(MIRRORED), resourceMask: rect(x0, y0, x1, y1) });
		expect(warning?.kind).toBe('mirrored');
		expect(warning?.where).toBe(where);
	});

	it('says nothing when there are too few Control Points to solve at all', () => {
		const twoPairs = alignmentOf(MIRRORED.slice(0, 2), 'polynomial1');
		expect(twoPairs.controlPoints).toHaveLength(2);
		expect(detectFold(twoPairs)).toBeNull();
	});

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

	it('does not report a fold that lies only in a margin the mask excludes', () => {
		const withMargin = alignmentOf([...UPRIGHT, [15, 50, -2, 0.5]] as const, 'thinPlateSpline');
		const whole = detectFold(withMargin);
		expect(whole, 'the fold has to be there before excluding it can mean anything').not.toBeNull();
		expect(whole?.kind).toBe('local');
		expect(whole?.where).toContain('left');
		expect(detectFold({ ...withMargin, resourceMask: rect(40, 0, 100, 100) })).toBeNull();
	});

	it('samples inside the Resource Mask rather than across the whole image', () => {
		const whole = detectFold(alignmentOf(MIRRORED));
		const narrowed = detectFold({ ...alignmentOf(MIRRORED), resourceMask: rect(0, 0, 20, 20) });
		expect(whole?.sampleCount).toBeGreaterThan(0);
		expect(narrowed?.sampleCount).toBe(whole?.sampleCount);

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
});
