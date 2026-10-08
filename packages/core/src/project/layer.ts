import { asRecord, serialiseJson, type Bytes } from '../store/project-store.js';

export interface SimpleStyle {
	readonly 'marker-size'?: string;
	readonly 'marker-symbol'?: string;
	readonly 'marker-color'?: string;
	readonly stroke?: string;
	readonly 'stroke-opacity'?: number;
	readonly 'stroke-width'?: number;
	readonly fill?: string;
	readonly 'fill-opacity'?: number;
	readonly 'stroke-dasharray'?: readonly [number, number];
}

interface LayerCommon {
	readonly id: string;
	readonly name: string;
	readonly visible: boolean;
	readonly order: number;
	readonly unknownFields?: Readonly<Record<string, unknown>>;
}

export interface MapLayer extends LayerCommon {
	readonly kind: 'map';
	readonly opacity: number;
	readonly imageId: string;
}

export interface AnnotationLayer extends LayerCommon {
	readonly kind: 'annotation';
	readonly geojsonRef: string;
}

interface ForeignLayer extends LayerCommon {
	readonly kind: 'foreign';
	readonly declaredKind: string;
}

export type Layer = MapLayer | AnnotationLayer | ForeignLayer;

export const ANNOTATION_DIRECTORY = 'annotations';

export const annotationPath = (layerId: string): string =>
	`${ANNOTATION_DIRECTORY}/${layerId}.geojson`;

export const annotationStorePath = (projectDirectory: string, layerId: string): string =>
	`${projectDirectory}/${annotationPath(layerId)}`;

export const emptyAnnotationCollection = (): Bytes =>
	serialiseJson({ type: 'FeatureCollection', features: [] });

export function newMapLayer(fields: { id: string; name: string; imageId: string }): MapLayer {
	return {
		kind: 'map',
		id: fields.id,
		name: fields.name,
		visible: true,
		order: 0,
		opacity: 1,
		imageId: fields.imageId
	};
}

export function newAnnotationLayer(fields: { id: string; name: string }): AnnotationLayer {
	return {
		kind: 'annotation',
		id: fields.id,
		name: fields.name,
		visible: true,
		order: 0,
		geojsonRef: annotationPath(fields.id)
	};
}

export function layerReferences(layer: Layer): readonly string[] {
	switch (layer.kind) {
		case 'map':
			return [];
		case 'annotation':
			return [layer.geojsonRef];
		case 'foreign':
			return ['geojsonRef']
				.map((key) => layer.unknownFields?.[key])
				.filter((reference): reference is string => typeof reference === 'string');
	}
}

// A map Layer's Alignment is shared across Projects, so deleting one must not name it.
export const layerFileRef = (layer: Layer): string =>
	layer.kind === 'annotation' ? layer.geojsonRef : '';

export function drawingOrder<T>(stack: readonly T[]): readonly T[] {
	return [...stack].reverse();
}

function renumber(layers: readonly Layer[]): readonly Layer[] {
	return layers.map((layer, order) => (layer.order === order ? layer : { ...layer, order }));
}

function replace(
	layers: readonly Layer[],
	id: string,
	change: (layer: Layer) => Layer
): readonly Layer[] {
	return renumber(layers.map((layer) => (layer.id === id ? change(layer) : layer)));
}

export function addLayer(layers: readonly Layer[], layer: Layer): readonly Layer[] {
	return renumber([layer, ...layers]);
}

export function removeLayer(layers: readonly Layer[], id: string): readonly Layer[] {
	return renumber(layers.filter((layer) => layer.id !== id));
}

export function renameLayer(layers: readonly Layer[], id: string, name: string): readonly Layer[] {
	return replace(layers, id, (layer) => ({ ...layer, name }));
}

export function setLayerVisible(
	layers: readonly Layer[],
	id: string,
	visible: boolean
): readonly Layer[] {
	return replace(layers, id, (layer) => ({ ...layer, visible }));
}

export function setMapLayerOpacity(
	layers: readonly Layer[],
	id: string,
	opacity: number
): readonly Layer[] {
	const clamped = clampOpacity(opacity);
	return replace(layers, id, (layer) =>
		layer.kind === 'map' ? { ...layer, opacity: clamped } : layer
	);
}

export function moveLayer(layers: readonly Layer[], id: string, toIndex: number): readonly Layer[] {
	const from = layers.findIndex((layer) => layer.id === id);
	if (from === -1) return layers;
	const to = Math.min(layers.length - 1, Math.max(0, toIndex));
	if (to === from) return layers;
	const moved = [...layers];
	const [layer] = moved.splice(from, 1);
	if (layer === undefined) return layers;
	moved.splice(to, 0, layer);
	return renumber(moved);
}

const readString = (value: unknown, fallback: string): string =>
	typeof value === 'string' ? value : fallback;

const readNumber = (value: unknown, fallback: number): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const carried = (rest: Record<string, unknown>): { unknownFields?: Record<string, unknown> } =>
	Object.keys(rest).length === 0 ? {} : { unknownFields: rest };

const clampOpacity = (opacity: number): number => Math.min(1, Math.max(0, opacity));

export function parseLayers(raw: unknown): readonly Layer[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const read: { layer: Layer; at: number; order: number }[] = [];
	for (const [at, element] of raw.entries()) {
		const record = asRecord(element);
		if (record === null) continue;
		const id = readString(record['id'], '');
		if (id === '' || seen.has(id)) continue;
		seen.add(id);
		read.push({ layer: parseLayer(record, id), at, order: readNumber(record['order'], at) });
	}

	read.sort((a, b) => a.order - b.order || a.at - b.at);
	return renumber(read.map(({ layer }) => layer));
}

const COMMON_KEYS: readonly string[] = ['kind', 'id', 'name', 'visible', 'order'];

function parseLayer(record: Readonly<Record<string, unknown>>, id: string): Layer {
	const kind = record['kind'];
	const rest = Object.fromEntries(
		Object.entries(record).filter(([key]) => !COMMON_KEYS.includes(key))
	);
	const common = {
		id,
		name: readString(record['name'], ''),
		visible: record['visible'] !== false,
		order: 0
	};

	if (kind === 'map') {
		const { opacity, imageId, ...carriedRest } = rest;
		return {
			...common,
			kind: 'map',
			opacity: clampOpacity(readNumber(opacity, 1)),
			imageId: readString(imageId, ''),
			...carried(carriedRest)
		};
	}

	if (kind === 'annotation') {
		const { geojsonRef, ...carriedRest } = rest;
		return {
			...common,
			kind: 'annotation',
			geojsonRef: readString(geojsonRef, ''),
			...carried(carriedRest)
		};
	}

	return { ...common, kind: 'foreign', declaredKind: readString(kind, ''), ...carried(rest) };
}

function serialiseLayer(layer: Layer): Record<string, unknown> {
	const { id, name, visible, order, unknownFields } = layer;
	const specific =
		layer.kind === 'map'
			? { opacity: layer.opacity, imageId: layer.imageId }
			: layer.kind === 'annotation'
				? { geojsonRef: layer.geojsonRef }
				: {};
	const kind = layer.kind === 'foreign' ? layer.declaredKind : layer.kind;
	return { kind, id, name, visible, order, ...specific, ...unknownFields };
}

export function serialiseLayers(layers: readonly Layer[]): unknown[] {
	return layers.map(serialiseLayer);
}
