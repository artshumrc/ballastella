import type { SimpleStyle } from '../project/layer.js';

interface PointGeometry {
	readonly type: 'Point';
	readonly coordinates: readonly [number, number];
}

export interface LineStringGeometry {
	readonly type: 'LineString';
	readonly coordinates: readonly (readonly [number, number])[];
}

interface PolygonGeometry {
	readonly type: 'Polygon';
	readonly coordinates: readonly (readonly (readonly [number, number])[])[];
}

interface CircleGeometry {
	readonly type: 'Circle';
	readonly center: readonly [number, number];
	readonly radiusMeters: number;
	readonly coordinates: PolygonGeometry['coordinates'];
}

interface ForeignGeometry {
	readonly type: 'foreign';
	readonly declaredType: string;
	readonly raw: Readonly<Record<string, unknown>>;
}

export type AnnotationGeometry =
	PointGeometry | LineStringGeometry | PolygonGeometry | CircleGeometry | ForeignGeometry | null;

export const plainGeometry = (
	geometry: Exclude<AnnotationGeometry, ForeignGeometry | null>
): { type: string; coordinates: unknown } => ({
	type: geometry.type === 'Circle' ? 'Polygon' : geometry.type,
	coordinates: geometry.coordinates
});

const EARTH_RADIUS_METERS = 6_371_008.8;
const CIRCLE_SEGMENTS = 64;

export function circleRadiusMeters(
	center: readonly [number, number],
	edge: readonly [number, number]
): number {
	const toRadians = Math.PI / 180;
	const latitude1 = center[1] * toRadians;
	const latitude2 = edge[1] * toRadians;
	const latitudeDelta = (edge[1] - center[1]) * toRadians;
	const longitudeDelta = (edge[0] - center[0]) * toRadians;
	const a =
		Math.sin(latitudeDelta / 2) ** 2 +
		Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
	const bounded = Math.min(1, Math.max(0, a));
	return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
}

export function circleGeometry(
	center: readonly [number, number],
	radiusMeters: number
): CircleGeometry {
	const toRadians = Math.PI / 180;
	const toDegrees = 180 / Math.PI;
	const longitude = center[0] * toRadians;
	const latitude = center[1] * toRadians;
	const angularRadius = radiusMeters / EARTH_RADIUS_METERS;
	const ring = Array.from({ length: CIRCLE_SEGMENTS }, (_, index): [number, number] => {
		const bearing = (index / CIRCLE_SEGMENTS) * Math.PI * 2;
		const atLatitude = Math.asin(
			Math.sin(latitude) * Math.cos(angularRadius) +
				Math.cos(latitude) * Math.sin(angularRadius) * Math.cos(bearing)
		);
		const longitudeDelta = Math.atan2(
			Math.sin(bearing) * Math.sin(angularRadius) * Math.cos(latitude),
			Math.cos(angularRadius) - Math.sin(latitude) * Math.sin(atLatitude)
		);
		return [(longitude + longitudeDelta) * toDegrees, atLatitude * toDegrees];
	});
	return {
		type: 'Circle',
		center,
		radiusMeters,
		coordinates: [[...ring, ring[0] ?? center]]
	};
}

export interface AnnotationProperties extends SimpleStyle {
	readonly title?: string;
	readonly description?: string;
	readonly unknownProperties?: Readonly<Record<string, unknown>>;
}

export interface Annotation {
	readonly id: string;
	readonly geometry: AnnotationGeometry;
	readonly properties: AnnotationProperties;
	readonly unknownFields?: Readonly<Record<string, unknown>>;
}

export interface AnnotationCollection {
	readonly annotations: readonly Annotation[];
	readonly unknownFields?: Readonly<Record<string, unknown>>;
}

export const emptyCollection = (): AnnotationCollection => ({ annotations: [] });

export const SIMPLESTYLE_DEFAULTS = {
	'marker-color': '#7e7e7e',
	stroke: '#555555',
	'stroke-opacity': 1,
	'stroke-width': 2,
	fill: '#555555',
	'fill-opacity': 0.6
} as const;

export const MARKER_SIZES: readonly string[] = ['small', 'medium', 'large'];
export const LABEL_MARKER_SYMBOL = 'label';

export const isLabelFeature = (
	properties: { 'marker-symbol'?: unknown } | null | undefined
): boolean => properties?.['marker-symbol'] === LABEL_MARKER_SYMBOL;

export const isLabel = (annotation: Annotation): boolean =>
	annotation.geometry?.type === 'Point' && isLabelFeature(annotation.properties);

export const ANNOTATION_COLORS: readonly { readonly name: string; readonly value: string }[] = [
	{ name: 'Black', value: '#000000' },
	{ name: 'Grey', value: '#555555' },
	{ name: 'White', value: '#ffffff' },
	{ name: 'Red', value: '#d32f2f' },
	{ name: 'Orange', value: '#ef6c00' },
	{ name: 'Yellow', value: '#fbc02d' },
	{ name: 'Green', value: '#388e3c' },
	{ name: 'Blue', value: '#1976d2' },
	{ name: 'Purple', value: '#7b1fa2' }
];

export const DEFAULT_ANNOTATION_COLOR = '#555555';

export function annotationColorName(value: string): string | null {
	const wanted = value.toLowerCase();
	return ANNOTATION_COLORS.find((colour) => colour.value === wanted)?.name ?? null;
}

interface ResolvedStyle {
	readonly 'marker-size'?: string;
	readonly 'marker-symbol'?: string;
	readonly 'marker-color': string;
	readonly stroke: string;
	readonly 'stroke-opacity': number;
	readonly 'stroke-width': number;
	readonly fill: string;
	readonly 'fill-opacity': number;
	readonly 'stroke-dasharray'?: readonly [number, number];
}

export function resolveStyle(properties: AnnotationProperties | undefined): ResolvedStyle {
	const own = (properties ?? {}) as Record<string, unknown>;
	const resolved: Record<string, unknown> = {};
	for (const [key, fallback] of Object.entries(SIMPLESTYLE_DEFAULTS)) {
		resolved[key] = own[key] === undefined ? fallback : own[key];
	}
	for (const key of ['stroke-dasharray', 'marker-size', 'marker-symbol']) {
		if (own[key] !== undefined) resolved[key] = own[key];
	}
	return resolved as unknown as ResolvedStyle;
}

export type LineStyle = 'solid' | 'dashed' | 'dotted';

export const DASHED_DASHARRAY: readonly [number, number] = [8, 4];
export const DOTTED_DASHARRAY: readonly [number, number] = [1, 3];

export const dashArrayFor = (style: LineStyle): readonly [number, number] | undefined =>
	({ solid: undefined, dashed: DASHED_DASHARRAY, dotted: DOTTED_DASHARRAY })[style];

export function lineStyleOf(dash: readonly number[] | undefined): LineStyle {
	const [on, off] = dash ?? [];
	if (on === undefined || off === undefined) return 'solid';
	return on === DOTTED_DASHARRAY[0] && off === DOTTED_DASHARRAY[1] ? 'dotted' : 'dashed';
}

export function findAnnotation(
	collection: AnnotationCollection,
	id: string
): Annotation | undefined {
	return collection.annotations.find((annotation) => annotation.id === id);
}

export function newAnnotation(fields: {
	id: string;
	geometry: AnnotationGeometry;
	title?: string;
	style?: SimpleStyle;
}): Annotation {
	return {
		id: fields.id,
		geometry: fields.geometry,
		properties: {
			...(fields.style ?? {}),
			...(fields.title === undefined || fields.title === '' ? {} : { title: fields.title })
		}
	};
}

const INHERITED_STYLE_NAMES = [
	'marker-size',
	'marker-color',
	'stroke',
	'stroke-opacity',
	'stroke-width',
	'fill',
	'fill-opacity',
	'stroke-dasharray'
] as const satisfies readonly (keyof SimpleStyle)[];

export function styleForNewAnnotation(
	collection: AnnotationCollection | null | undefined
): SimpleStyle {
	const last = collection?.annotations.at(-1);
	if (last === undefined) {
		return {
			'marker-color': DEFAULT_ANNOTATION_COLOR,
			stroke: DEFAULT_ANNOTATION_COLOR,
			fill: DEFAULT_ANNOTATION_COLOR
		};
	}
	const style: Record<string, unknown> = {};
	for (const name of INHERITED_STYLE_NAMES) {
		const value = last.properties[name];
		if (value !== undefined) style[name] = value;
	}
	return style as SimpleStyle;
}

const DEFAULT_LABEL_COLORS = {
	'marker-color': '#000000',
	fill: '#ffffff'
} as const satisfies Pick<SimpleStyle, 'marker-color' | 'fill'>;

export function styleForNewLabel(collection: AnnotationCollection | null | undefined): SimpleStyle {
	const inherited = styleForNewAnnotation(collection);
	const untouchedDefault =
		inherited['marker-color'] === DEFAULT_ANNOTATION_COLOR &&
		inherited.fill === DEFAULT_ANNOTATION_COLOR;
	return {
		...inherited,
		...(untouchedDefault ? DEFAULT_LABEL_COLORS : {}),
		'marker-symbol': LABEL_MARKER_SYMBOL
	};
}

export function annotationAnchor(annotation: Annotation): { lng: number; lat: number } | null {
	const geometry = annotation.geometry;
	if (geometry === null || geometry.type === 'foreign') return null;
	const points: readonly (readonly [number, number])[] =
		geometry.type === 'Point'
			? [geometry.coordinates]
			: geometry.type === 'LineString'
				? geometry.coordinates
				: geometry.type === 'Circle'
					? [geometry.center]
					: (geometry.coordinates[0] ?? []);
	if (points.length === 0) return null;
	const middle = (values: number[]) => (Math.min(...values) + Math.max(...values)) / 2;
	return { lng: middle(points.map(([lng]) => lng)), lat: middle(points.map(([, lat]) => lat)) };
}

export function addAnnotation(
	collection: AnnotationCollection,
	annotation: Annotation
): AnnotationCollection {
	return { ...collection, annotations: [...collection.annotations, annotation] };
}

export function removeAnnotation(
	collection: AnnotationCollection,
	id: string
): AnnotationCollection {
	const annotations = collection.annotations.filter((annotation) => annotation.id !== id);
	return annotations.length === collection.annotations.length
		? collection
		: { ...collection, annotations };
}

export function moveAnnotation(
	collection: AnnotationCollection,
	id: string,
	toIndex: number
): AnnotationCollection {
	const from = collection.annotations.findIndex((annotation) => annotation.id === id);
	if (from === -1) return collection;
	const to = Math.min(collection.annotations.length - 1, Math.max(0, toIndex));
	if (to === from) return collection;
	const annotations = [...collection.annotations];
	const [moved] = annotations.splice(from, 1);
	if (moved === undefined) return collection;
	annotations.splice(to, 0, moved);
	return { ...collection, annotations };
}

function replace(
	collection: AnnotationCollection,
	id: string,
	change: (annotation: Annotation) => Annotation
): AnnotationCollection {
	let changed = false;
	const annotations = collection.annotations.map((annotation) => {
		if (annotation.id !== id) return annotation;
		const next = change(annotation);
		if (next !== annotation) changed = true;
		return next;
	});
	return changed ? { ...collection, annotations } : collection;
}

export function setGeometry(
	collection: AnnotationCollection,
	id: string,
	geometry: AnnotationGeometry
): AnnotationCollection {
	return replace(collection, id, (annotation) => ({ ...annotation, geometry }));
}

function restyle(
	collection: AnnotationCollection,
	id: string,
	change: (properties: AnnotationProperties) => AnnotationProperties
): AnnotationCollection {
	return replace(collection, id, (annotation) => {
		const properties = change(annotation.properties);
		return properties === annotation.properties ? annotation : { ...annotation, properties };
	});
}

export function setText(
	collection: AnnotationCollection,
	id: string,
	text: { title?: string; description?: string }
): AnnotationCollection {
	return restyle(collection, id, (properties) => {
		for (const key of ['title', 'description'] as const) {
			if (text[key] !== undefined) properties = withProperty(properties, key, text[key]);
		}
		return properties;
	});
}

function withProperty<Style extends SimpleStyle>(
	properties: Style,
	key: string,
	value: unknown
): Style {
	const remove = value === undefined || value === '';
	const raw = properties as Record<string, unknown>;
	if (remove && !(key in properties)) return properties;
	if (!remove && raw[key] === value) return properties;
	const next: Record<string, unknown> = { ...raw };
	if (remove) delete next[key];
	else next[key] = value;
	return next as Style;
}

export function setStyle(
	collection: AnnotationCollection,
	id: string,
	style: Readonly<Record<string, unknown>>
): AnnotationCollection {
	return restyle(collection, id, (properties) =>
		Object.entries(style).reduce((next, [key, value]) => withProperty(next, key, value), properties)
	);
}

export function setLineStyle(
	collection: AnnotationCollection,
	id: string,
	line: LineStyle
): AnnotationCollection {
	return restyle(collection, id, (properties) =>
		withProperty(properties, 'stroke-dasharray', dashArrayFor(line))
	);
}

const isHexColour = (value: unknown): boolean =>
	typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);

const isNonNegative = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isFraction = (value: unknown): boolean => isNonNegative(value) && value <= 1;

export function simpleStyleViolations(properties: AnnotationProperties): string[] {
	const raw = properties as Record<string, unknown>;
	const problems: string[] = [];

	const wrongType = (key: string, expected: string) =>
		problems.push(`${key} should be ${expected}, and is ${JSON.stringify(raw[key])}`);

	if ('title' in raw && typeof raw['title'] !== 'string') wrongType('title', 'a string');
	if ('description' in raw && typeof raw['description'] !== 'string') {
		wrongType('description', 'a string');
	}
	if ('marker-size' in raw && !MARKER_SIZES.includes(raw['marker-size'] as string)) {
		wrongType('marker-size', 'small, medium, or large');
	}
	if ('marker-symbol' in raw && !/^([0-9]|[a-z]|[\w-]{2,})$/.test(String(raw['marker-symbol']))) {
		wrongType('marker-symbol', 'an icon id, 0–9, or a–z');
	}
	for (const key of ['marker-color', 'stroke', 'fill']) {
		if (key in raw && !isHexColour(raw[key])) wrongType(key, 'a #RRGGBB colour');
	}
	for (const key of ['stroke-opacity', 'fill-opacity']) {
		if (key in raw && !isFraction(raw[key])) wrongType(key, 'a number from 0.0 to 1.0');
	}
	if ('stroke-width' in raw && !isNonNegative(raw['stroke-width'])) {
		wrongType('stroke-width', 'a number ≥ 0');
	}
	if ('stroke-dasharray' in raw) {
		const dash = raw['stroke-dasharray'];
		const ok = Array.isArray(dash) && dash.length === 2 && dash.every(isNonNegative);
		if (!ok) wrongType('stroke-dasharray', 'a [dash, gap] tuple of two numbers, never a keyword');
	}

	return problems;
}
