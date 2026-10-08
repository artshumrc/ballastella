import {
	asRecord,
	messageOf,
	parseJsonBytes,
	serialiseJson,
	type Bytes
} from '../store/project-store.js';
import {
	type Annotation,
	type AnnotationCollection,
	type AnnotationGeometry,
	type AnnotationProperties,
	circleGeometry,
	plainGeometry
} from './annotation.js';

const CIRCLE_FIELD = 'ballastella:circle';

export class AnnotationsUnreadableError extends Error {
	override readonly name = 'AnnotationsUnreadableError';
	constructor(
		readonly path: string,
		cause: unknown
	) {
		super(`The Annotations in “${path}” could not be read as GeoJSON: ${messageOf(cause)}`);
	}
}

const FEATURE_KEYS: readonly string[] = ['type', 'id', 'geometry', 'properties'];
const COLLECTION_KEYS: readonly string[] = ['type', 'features'];

const rest = (
	record: Record<string, unknown>,
	known: readonly string[]
): { unknownFields?: Record<string, unknown> } => {
	const carried = Object.fromEntries(
		Object.entries(record).filter(([key]) => !known.includes(key))
	);
	return Object.keys(carried).length === 0 ? {} : { unknownFields: carried };
};

function readPosition(value: unknown): [number, number] | null {
	if (!Array.isArray(value)) return null;
	const [lng, lat] = value;
	if (typeof lng !== 'number' || typeof lat !== 'number') return null;
	if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
	return [lng, lat];
}

function readPositions(value: unknown): [number, number][] | null {
	if (!Array.isArray(value)) return null;
	const positions = value.map(readPosition);
	return positions.every((position) => position !== null) ? positions : null;
}

function readGeometry(value: unknown, circleValue: unknown): AnnotationGeometry {
	const record = asRecord(value);
	if (record === null) return null;
	const type = record['type'];
	const foreign = (): AnnotationGeometry => ({
		type: 'foreign',
		declaredType: typeof type === 'string' ? type : '',
		raw: record
	});

	if (type === 'Point') {
		const coordinates = readPosition(record['coordinates']);
		return coordinates === null ? foreign() : { type: 'Point', coordinates };
	}
	if (type === 'LineString') {
		const coordinates = readPositions(record['coordinates']);
		return coordinates === null ? foreign() : { type: 'LineString', coordinates };
	}
	if (type === 'Polygon') {
		if (!Array.isArray(record['coordinates'])) return foreign();
		const rings = record['coordinates'].map(readPositions);
		if (!rings.every((ring) => ring !== null)) return foreign();
		const circle = asRecord(circleValue);
		const center = readPosition(circle?.['center']);
		const radiusMeters = circle?.['radiusMeters'];
		if (
			center !== null &&
			typeof radiusMeters === 'number' &&
			Number.isFinite(radiusMeters) &&
			radiusMeters >= 0
		) {
			return { ...circleGeometry(center, radiusMeters), coordinates: rings };
		}
		return { type: 'Polygon', coordinates: rings };
	}
	return foreign();
}

export function parseAnnotations(
	bytes: Bytes,
	{
		path = 'annotations',
		mintId = () => crypto.randomUUID()
	}: { path?: string; mintId?: () => string } = {}
): AnnotationCollection {
	let document: unknown;
	try {
		document = parseJsonBytes(bytes);
	} catch (cause) {
		throw new AnnotationsUnreadableError(path, cause);
	}
	const record = asRecord(document);
	if (record === null) {
		throw new AnnotationsUnreadableError(path, new Error('the document is not a JSON object'));
	}

	const features = Array.isArray(record['features']) ? record['features'] : [];
	const annotations: Annotation[] = [];
	for (const element of features) {
		const feature = asRecord(element);
		if (feature === null) continue;
		const id = feature['id'];
		const geometry = readGeometry(feature['geometry'], feature[CIRCLE_FIELD]);
		annotations.push({
			id: typeof id === 'string' && id !== '' ? id : typeof id === 'number' ? String(id) : mintId(),
			geometry,
			properties: (asRecord(feature['properties']) ?? {}) as AnnotationProperties,
			...rest(feature, geometry?.type === 'Circle' ? [...FEATURE_KEYS, CIRCLE_FIELD] : FEATURE_KEYS)
		});
	}

	return { annotations, ...rest(record, COLLECTION_KEYS) };
}

function serialiseAnnotation(annotation: Annotation): Record<string, unknown> {
	const geometry = annotation.geometry;
	return {
		type: 'Feature',
		id: annotation.id,
		properties: annotation.properties,
		geometry:
			geometry === null
				? null
				: geometry.type === 'foreign'
					? geometry.raw
					: plainGeometry(geometry),
		...(geometry?.type === 'Circle'
			? { [CIRCLE_FIELD]: { center: geometry.center, radiusMeters: geometry.radiusMeters } }
			: {}),
		...annotation.unknownFields
	};
}

export function serialiseAnnotations(collection: AnnotationCollection): Bytes {
	return serialiseJson({
		type: 'FeatureCollection',
		features: collection.annotations.map(serialiseAnnotation),
		...collection.unknownFields
	});
}
