import type { ResourcePoint } from '../image-pane/synthetic-projection.js';
import type { AlignmentPath } from '../store/project-store.js';

export type GeoPoint = { lng: number; lat: number };

export interface ControlPoint {
	readonly id: string;
	readonly ordinal: number;
	readonly resource: ResourcePoint;
	readonly geo: GeoPoint;
}

export interface DraftControlPoint {
	readonly id: string;
	readonly resource: ResourcePoint | null;
	readonly geo: GeoPoint | null;
}

export type TransformationType =
	| 'helmert'
	| 'polynomial1'
	| 'polynomial2'
	| 'polynomial3'
	| 'projective'
	| 'thinPlateSpline'
	| 'linear';

export const DEFAULT_TRANSFORMATION_TYPE: TransformationType = 'polynomial1';

export const MINIMUM_CONTROL_POINTS: Readonly<Record<TransformationType, number>> = {
	helmert: 2,
	polynomial1: 3,
	polynomial2: 6,
	polynomial3: 10,
	projective: 4,
	thinPlateSpline: 3,
	linear: 3
};

type TransformationTier = 'primary' | 'advanced';

interface TransformationChoice {
	readonly type: TransformationType;
	readonly tier: TransformationTier;
	readonly label: string;
	readonly guidance: string;
	readonly minimumControlPoints: number;
}

const choice = (
	type: TransformationType,
	tier: TransformationTier,
	label: string,
	guidance: string
): TransformationChoice => ({
	type,
	tier,
	label,
	guidance,
	minimumControlPoints: MINIMUM_CONTROL_POINTS[type]
});

const MANY_POINTS = 'Only with many well-spread points';

export const TRANSFORMATION_CHOICES: readonly TransformationChoice[] = [
	choice('helmert', 'primary', 'Simple', 'Accurate modern maps — rotate, scale, and move only'),
	choice('polynomial1', 'primary', 'Standard', 'Most printed and scanned maps'),
	choice('projective', 'primary', 'Perspective', 'Maps photographed at an angle'),
	choice('thinPlateSpline', 'primary', 'Flexible', 'Hand-drawn or geometrically inconsistent maps'),
	choice('polynomial2', 'advanced', 'Higher-order (2nd)', MANY_POINTS),
	choice('polynomial3', 'advanced', 'Higher-order (3rd)', MANY_POINTS)
];

export function transformationShortfall(
	type: TransformationType,
	controlPointCount: number
): string {
	const needed = MINIMUM_CONTROL_POINTS[type];
	if (controlPointCount >= needed) return '';
	const name = TRANSFORMATION_CHOICES.find((one) => one.type === type)?.label ?? type;
	const points = needed === 1 ? 'Control Point' : 'Control Points';
	return `${name} needs at least ${needed} ${points} — you have ${controlPointCount}`;
}

export interface Alignment {
	readonly imageId: string;
	readonly image: { readonly width: number; readonly height: number };
	readonly controlPoints: readonly ControlPoint[];
	readonly resourceMask: readonly ResourcePoint[];
	readonly transformationType: TransformationType;
	readonly unmodelled?: Readonly<Record<string, unknown>>;
	readonly unpreservable?: string;
}

export const ALIGNMENT_DIRECTORY = 'alignments';

export const alignmentPath = (imageId: string): AlignmentPath =>
	`${ALIGNMENT_DIRECTORY}/${imageId}.json` as AlignmentPath;

export function alignmentImageId(path: string): string | null {
	const segments = path.split('/');
	if (segments.length !== 2 || segments[0] !== ALIGNMENT_DIRECTORY) return null;
	const name = segments[1] ?? '';
	return name.endsWith('.json') && name.length > '.json'.length
		? name.slice(0, -'.json'.length)
		: null;
}

export function fullImageResourceMask(image: {
	width: number;
	height: number;
}): readonly ResourcePoint[] {
	return [
		{ x: 0, y: 0 },
		{ x: image.width, y: 0 },
		{ x: image.width, y: image.height },
		{ x: 0, y: image.height }
	];
}

export function newAlignment(imageId: string, image: { width: number; height: number }): Alignment {
	return {
		imageId,
		image: { width: image.width, height: image.height },
		controlPoints: [],
		resourceMask: fullImageResourceMask(image),
		transformationType: DEFAULT_TRANSFORMATION_TYPE
	};
}

export function collectControlPoints(
	drafts: readonly DraftControlPoint[]
): readonly ControlPoint[] {
	const complete: ControlPoint[] = [];
	for (const draft of drafts) {
		if (draft.resource === null || draft.geo === null) continue;
		complete.push({
			id: draft.id,
			ordinal: complete.length + 1,
			resource: draft.resource,
			geo: draft.geo
		});
	}
	return complete;
}

export function toDraftControlPoints(alignment: Alignment): readonly DraftControlPoint[] {
	return alignment.controlPoints.map(({ id, resource, geo }) => ({ id, resource, geo }));
}

export function canSolve(alignment: Alignment): boolean {
	return alignment.controlPoints.length >= MINIMUM_CONTROL_POINTS[alignment.transformationType];
}

export const MINIMUM_MASK_VERTICES = 3;

export function moveMaskVertex(alignment: Alignment, index: number, to: ResourcePoint): Alignment {
	if (index < 0 || index >= alignment.resourceMask.length) return alignment;
	const resourceMask = alignment.resourceMask.map((vertex, at) =>
		at === index ? { x: to.x, y: to.y } : vertex
	);
	return { ...alignment, resourceMask };
}

export function insertMaskVertexAfter(alignment: Alignment, index: number): Alignment {
	const mask = alignment.resourceMask;
	if (index < 0 || index >= mask.length) return alignment;
	const midpoint = maskEdgeMidpoints(mask)[index] as ResourcePoint;
	const resourceMask = [...mask.slice(0, index + 1), midpoint, ...mask.slice(index + 1)];
	return { ...alignment, resourceMask };
}

export function removeMaskVertex(alignment: Alignment, index: number): Alignment {
	const mask = alignment.resourceMask;
	if (index < 0 || index >= mask.length || mask.length <= MINIMUM_MASK_VERTICES) return alignment;
	return { ...alignment, resourceMask: mask.filter((_, at) => at !== index) };
}

export function resetMaskToFullImage(alignment: Alignment): Alignment {
	return { ...alignment, resourceMask: fullImageResourceMask(alignment.image) };
}

export function maskEdgeMidpoints(
	resourceMask: readonly ResourcePoint[]
): readonly ResourcePoint[] {
	return resourceMask.map((from, index) => {
		const to = resourceMask[(index + 1) % resourceMask.length] as ResourcePoint;
		return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
	});
}
