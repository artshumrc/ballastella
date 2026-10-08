import { GcpTransformer } from '@allmaps/transform';

import type { ResourcePoint } from '../image-pane/synthetic-projection.js';
import { canSolve, type Alignment } from './alignment.js';
import { toRendererControlPoints } from './georeference-annotation.js';

type DistortionMeasure = 'log2sigma' | 'signDetJ';

interface DistortionMeasureChoice {
	readonly measure: DistortionMeasure;
	readonly label: string;
	readonly question: string;
}

export const DISTORTION_MEASURES: readonly DistortionMeasureChoice[] = [
	{
		measure: 'log2sigma',
		label: 'Stretching',
		question: 'Where is this map drawn too big or too small? — how faithful is it?'
	},
	{
		measure: 'signDetJ',
		label: 'Folds',
		question: 'Where has the Alignment folded over itself? — did I make a mistake?'
	}
];

export const COMPUTED_DISTORTION_MEASURES: readonly DistortionMeasure[] = DISTORTION_MEASURES.map(
	(choice) => choice.measure
);

export const FOLD_DISTORTION_MEASURE: DistortionMeasure = 'signDetJ';

export interface DistortionRamp {
	readonly distortionColor00: string;
	readonly distortionColor01: string;
	readonly distortionColor1: string;
	readonly distortionColor2: string;
	readonly distortionColor3: string;
}

export interface DistortionView {
	readonly measure: DistortionMeasure | null;
	readonly grid: boolean;
}

export const DEFAULT_DISTORTION_VIEW: DistortionView = { measure: null, grid: false };

interface FoldWarning {
	readonly kind: 'mirrored' | 'local';
	readonly where: string;
	readonly message: string;
	readonly foldedSamples: number;
	readonly sampleCount: number;
}

const FOLD_SAMPLE_STEPS = 11;

export function detectFold(alignment: Alignment): FoldWarning | null {
	if (!canSolve(alignment)) return null;
	const samples = maskSamples(alignment.resourceMask);
	if (samples.length === 0) return null;
	let signs: readonly (number | undefined)[];
	try {
		const transformer = new GcpTransformer(
			toRendererControlPoints(alignment),
			alignment.transformationType
		);
		signs = transformer.transformToGeo(
			samples.map((point) => [point.x, point.y] as [number, number]),
			{ distortionMeasures: [FOLD_DISTORTION_MEASURE], isMultiGeometry: true },
			(gcp) => gcp.distortions?.get(FOLD_DISTORTION_MEASURE)
		);
	} catch {
		return null;
	}

	const folded: ResourcePoint[] = [];
	let measured = 0;
	signs.forEach((sign, index) => {
		if (typeof sign !== 'number') return;
		measured += 1;
		if (sign < 0) folded.push(samples[index] as ResourcePoint);
	});

	if (measured === 0 || folded.length === 0) return null;
	const where = describeRegion(folded, alignment.image);
	const everywhere = folded.length === measured;

	return {
		kind: everywhere ? 'mirrored' : 'local',
		where,
		message: everywhere
			? 'This Alignment turns the whole Map Image over — it is mirrored. Two Control Points ' +
				'are probably swapped.'
			: `This Alignment folds over itself near the ${where} of the Map Image. A Control ` +
				'Point there is probably in the wrong place.',
		foldedSamples: folded.length,
		sampleCount: measured
	};
}

function maskSamples(mask: readonly ResourcePoint[]): readonly ResourcePoint[] {
	const box = boundingBox(mask);
	if (box === null) return [];
	const samples: ResourcePoint[] = [];
	for (let row = 0; row < FOLD_SAMPLE_STEPS; row += 1) {
		for (let column = 0; column < FOLD_SAMPLE_STEPS; column += 1) {
			const point: ResourcePoint = {
				x: box.minX + ((column + 0.5) / FOLD_SAMPLE_STEPS) * (box.maxX - box.minX),
				y: box.minY + ((row + 0.5) / FOLD_SAMPLE_STEPS) * (box.maxY - box.minY)
			};
			if (isInside(point, mask)) samples.push(point);
		}
	}
	return samples;
}

function boundingBox(points: readonly ResourcePoint[]) {
	if (points.length === 0) return null;
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const box = {
		minX: Math.min(...xs),
		minY: Math.min(...ys),
		maxX: Math.max(...xs),
		maxY: Math.max(...ys)
	};
	return box.maxX === box.minX || box.maxY === box.minY ? null : box;
}

function isInside(point: ResourcePoint, ring: readonly ResourcePoint[]): boolean {
	let inside = false;
	for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
		const a = ring[index] as ResourcePoint;
		const b = ring[previous] as ResourcePoint;
		const crosses = a.y > point.y !== b.y > point.y;
		if (crosses && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
			inside = !inside;
		}
	}
	return inside;
}

function describeRegion(
	folded: readonly ResourcePoint[],
	image: { readonly width: number; readonly height: number }
): string {
	const third = (axis: 'x' | 'y', extent: number): number => {
		const total = folded.reduce((sum, point) => sum + point[axis], 0);
		const fraction = extent === 0 ? 0.5 : total / folded.length / extent;
		return fraction < 1 / 3 ? 0 : fraction < 2 / 3 ? 1 : 2;
	};

	const column = third('x', image.width);
	const row = third('y', image.height);
	const vertical = ['top', 'middle', 'bottom'][row] as string;
	const horizontal = ['left', 'centre', 'right'][column] as string;

	if (row === 1 && column === 1) return 'centre';
	if (row === 1) return horizontal;
	if (column === 1) return vertical;
	return `${vertical}-${horizontal}`;
}
