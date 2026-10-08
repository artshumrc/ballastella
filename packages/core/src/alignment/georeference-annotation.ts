import { generateAnnotation, parseAnnotation, validateAnnotation } from '@allmaps/annotation';
import {
	transformationTypeToTypeAndOrder,
	typeAndOrderToTransformationType
} from '@allmaps/transform';

import type { ResourcePoint } from '../image-pane/synthetic-projection.js';
import {
	isRecord,
	messageOf,
	parseJsonBytes,
	serialiseJson,
	type Bytes
} from '../store/project-store.js';
import { imageServiceId } from '../tiler/pyramid.js';
import {
	DEFAULT_TRANSFORMATION_TYPE,
	MINIMUM_CONTROL_POINTS,
	fullImageResourceMask,
	type Alignment,
	type ControlPoint,
	type TransformationType
} from './alignment.js';

export class AlignmentUnreadableError extends Error {
	override readonly name = 'AlignmentUnreadableError';
	constructor(imageId: string, reason: string) {
		super(`The Alignment for “${imageId}” could not be read: ${reason}`);
	}
}

export class AlignmentUnwritableError extends Error {
	override readonly name = 'AlignmentUnwritableError';
	constructor(imageId: string, reason: string) {
		super(
			`The Alignment for “${imageId}” was not saved, because it would not have been readable ` +
				`again: ${reason}`
		);
	}
}

export class AlignmentUnpreservableError extends Error {
	override readonly name = 'AlignmentUnpreservableError';
	constructor(
		readonly imageId: string,
		readonly member: string
	) {
		super(
			`The Alignment for “${imageId}” was not saved, because it carries “${member}” — something ` +
				`this version does not understand and cannot write back without discarding. The file ` +
				`has been left exactly as it is.`
		);
	}
}

export type AlignmentAddress = { readonly imageService?: string };

export function toRendererDocument(
	alignment: Alignment,
	{ imageService = '' }: AlignmentAddress = {}
): unknown {
	return {
		'@context': 'https://schemas.allmaps.org/map/2/context.json',
		type: 'GeoreferencedMap',
		resource: {
			id: imageService === '' ? imageServiceId(alignment.imageId) : imageService,
			type: 'ImageService3',
			width: alignment.image.width,
			height: alignment.image.height
		},
		gcps: toRendererControlPoints(alignment),
		resourceMask: toRendererResourceMask(alignment),
		transformation: transformationTypeToTypeAndOrder(alignment.transformationType)
	};
}

type RendererControlPoint = { resource: [number, number]; geo: [number, number] };

export function toRendererControlPoints(alignment: Alignment): RendererControlPoint[] {
	return alignment.controlPoints.map((point) => ({
		resource: [point.resource.x, point.resource.y],
		geo: [point.geo.lng, point.geo.lat]
	}));
}

export function toRendererResourceMask(alignment: Alignment): [number, number][] {
	return alignment.resourceMask.map((point) => [point.x, point.y]);
}

export function serialiseAlignment(alignment: Alignment, address: AlignmentAddress = {}): Bytes {
	if (alignment.unpreservable !== undefined) {
		throw new AlignmentUnpreservableError(alignment.imageId, alignment.unpreservable);
	}
	const annotation = generateAnnotation(toRendererDocument(alignment, address));
	rewriteResourceMaskInPlainDecimal(annotation, alignment.resourceMask);
	restoreUnmodelledMembers(annotation, alignment.unmodelled);
	try {
		validateAnnotation(annotation);
	} catch (cause) {
		throw new AlignmentUnwritableError(alignment.imageId, messageOf(cause));
	}
	return serialiseJson(annotation);
}

function residue(
	source: Record<string, unknown>,
	generated: Record<string, unknown>
): Record<string, unknown> | undefined {
	const carried: Record<string, unknown> = {};
	for (const [member, value] of Object.entries(source)) {
		const mine = generated[member];
		if (mine === undefined) {
			carried[member] = value;
			continue;
		}
		if (!isRecord(value) || !isRecord(mine)) continue;
		const deeper = residue(value, mine);
		if (deeper) carried[member] = deeper;
	}
	return Object.keys(carried).length > 0 ? carried : undefined;
}

function unpreservableArrayMember(
	source: Record<string, unknown>,
	generated: Record<string, unknown>,
	at = ''
): string {
	for (const [member, value] of Object.entries(source)) {
		const mine = generated[member];
		if (mine === undefined) continue;
		const here = at === '' ? member : `${at}.${member}`;
		if (Array.isArray(value) && Array.isArray(mine)) {
			for (const [index, element] of value.entries()) {
				if (!isRecord(element)) continue;
				const known = mine.filter(isRecord);
				const extra = residue(element, mergedShape(known));
				if (extra) return `${here}[${index}].${deepestPath(extra)}`;
			}
			continue;
		}
		if (!isRecord(value) || !isRecord(mine)) continue;
		const deeper = unpreservableArrayMember(value, mine, here);
		if (deeper !== '') return deeper;
	}
	return '';
}

function deepestPath(carried: Record<string, unknown>): string {
	const member = Object.keys(carried)[0] as string;
	const value = carried[member];
	return isRecord(value) ? `${member}.${deepestPath(value)}` : member;
}

function mergedShape(objects: readonly Record<string, unknown>[]): Record<string, unknown> {
	const shape: Record<string, unknown> = {};
	for (const one of objects) {
		for (const [member, value] of Object.entries(one)) {
			if (shape[member] === undefined) shape[member] = value;
		}
	}
	return shape;
}

function restoreUnmodelledMembers(
	annotation: unknown,
	unmodelled: Readonly<Record<string, unknown>> | undefined
): void {
	if (!unmodelled || !isRecord(annotation)) return;
	for (const [member, value] of Object.entries(unmodelled)) {
		const mine = annotation[member];
		if (mine === undefined) {
			annotation[member] = value;
			continue;
		}
		if (isRecord(mine) && isRecord(value)) restoreUnmodelledMembers(mine, value);
	}
}

function rewriteResourceMaskInPlainDecimal(
	annotation: unknown,
	resourceMask: readonly ResourcePoint[]
): void {
	const selector = (annotation as { target?: { selector?: { value?: unknown } } }).target?.selector;
	if (!selector || typeof selector.value !== 'string') return;
	const points = resourceMask
		.map((point) => `${toPlainDecimal(point.x)},${toPlainDecimal(point.y)}`)
		.join(' ');
	selector.value = selector.value.replace(/points="[^"]*"/, `points="${points}"`);
}

function toPlainDecimal(value: number): string {
	const shortest = String(value);
	const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(shortest);
	if (!match) return shortest;

	const [, sign, whole, fraction = '', exponentText] = match;
	const digits = `${whole}${fraction}`;
	const pointAt = (whole as string).length + Number(exponentText);

	if (pointAt <= 0) return `${sign}0.${'0'.repeat(-pointAt)}${digits}`;
	if (pointAt >= digits.length) return `${sign}${digits}${'0'.repeat(pointAt - digits.length)}`;
	return `${sign}${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
}

export function parseAlignment(bytes: Uint8Array, { imageId }: { imageId: string }): Alignment {
	let raw: unknown;
	try {
		raw = parseJsonBytes(bytes);
	} catch (cause) {
		throw new AlignmentUnreadableError(imageId, messageOf(cause));
	}

	let maps;
	try {
		maps = parseAnnotation(raw);
	} catch (cause) {
		throw new AlignmentUnreadableError(
			imageId,
			`it is not a Georeference Annotation (${messageOf(cause)})`
		);
	}

	const map = maps[0];
	if (!map) throw new AlignmentUnreadableError(imageId, 'it contains no georeferenced map');

	const { width, height } = map.resource;
	if (typeof width !== 'number' || typeof height !== 'number') {
		throw new AlignmentUnreadableError(imageId, 'it does not say how large the Map Image is');
	}

	// Whole pixels: a fractional `<svg width>` would make the written document unreadable.
	const image = { width: Math.round(width), height: Math.round(height) };

	const modelled: Alignment = {
		imageId,
		image,
		controlPoints: map.gcps.map(({ resource: [x, y], geo: [lng, lat] }, index): ControlPoint => ({
			id: `${index}`,
			ordinal: index + 1,
			resource: { x, y },
			geo: { lng, lat }
		})),
		resourceMask:
			map.resourceMask.length >= 3
				? map.resourceMask.map(([x, y]) => ({ x, y }) as ResourcePoint)
				: fullImageResourceMask(image),
		transformationType: readTransformationType(map.transformation)
	};

	const generated = generateAnnotation(toRendererDocument(modelled)) as Record<string, unknown>;
	const unmodelled =
		isRecord(raw) && raw['type'] === 'Annotation' ? residue(raw, generated) : undefined;
	const unpreservable = isRecord(raw) ? unpreservableArrayMember(raw, generated) : '';

	return {
		...modelled,
		...(unmodelled ? { unmodelled } : {}),
		...(unpreservable === '' ? {} : { unpreservable })
	};
}

// Upstream's inverse drops the polynomial order, so it is read here directly.
function readTransformationType(transformation: unknown): TransformationType {
	if (!transformation) return DEFAULT_TRANSFORMATION_TYPE;

	const { type, options } = transformation as {
		type?: unknown;
		options?: { order?: unknown };
	};

	if (type === 'polynomial' || type === 'polynomial1') {
		const order = options?.order;
		if (order === undefined || order === 1) return 'polynomial1';
		return order === 2 || order === 3 ? `polynomial${order}` : DEFAULT_TRANSFORMATION_TYPE;
	}

	let name: string;
	try {
		name = typeAndOrderToTransformationType(
			transformation as Parameters<typeof typeAndOrderToTransformationType>[0]
		);
	} catch {
		return DEFAULT_TRANSFORMATION_TYPE;
	}
	return Object.hasOwn(MINIMUM_CONTROL_POINTS, name)
		? (name as TransformationType)
		: DEFAULT_TRANSFORMATION_TYPE;
}
