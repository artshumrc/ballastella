import type { Annotation, AnnotationProperties } from '../annotation/annotation.js';
import { parseAnnotations, serialiseAnnotations } from '../annotation/geojson.js';
import type { Layer } from '../project/layer.js';
import { parseProjectFile, serialiseProjectFile } from '../project/project-file.js';
import type { Bytes, StorePath } from '../store/project-store.js';

export function carryProjectText(before: Bytes, current: Bytes | null): Bytes {
	const pair = parsePair(before, current, parseProjectFile);
	if (pair === null) return before;
	const [image, typed] = pair;

	const names = new Map(typed.layers.map((layer) => [layer.id, layer.name]));
	let carried = image.name !== typed.name || image.baseMap !== typed.baseMap;
	const layers: Layer[] = image.layers.map((layer) => {
		const name = names.get(layer.id);
		if (name === undefined || name === layer.name) return layer;
		carried = true;
		return { ...layer, name };
	});

	return carried
		? serialiseProjectFile({ ...image, name: typed.name, baseMap: typed.baseMap, layers })
		: before;
}

export function carryAnnotationText(before: Bytes, current: Bytes | null): Bytes {
	const pair = parsePair(before, current, (bytes, side) =>
		parseAnnotations(bytes, { path: 'annotations', mintId: sequence(`${side}:`) })
	);
	if (pair === null) return before;
	const [image, typed] = pair;

	const words = new Map(typed.annotations.map((one) => [one.id, one.properties]));
	let carried = false;
	const annotations: Annotation[] = image.annotations.map((one) => {
		const now = words.get(one.id);
		if (now === undefined || !differs(one.properties, now)) return one;
		carried = true;
		return { ...one, properties: withText(one.properties, now) };
	});

	return carried ? serialiseAnnotations({ ...image, annotations }) : before;
}

export function carryAcross(path: StorePath, before: Bytes, current: Bytes | null): Bytes {
	if (basename(path) === 'project.json') return carryProjectText(before, current);
	if (/(^|\/)annotations\/[^/]+\.geojson$/.test(path)) return carryAnnotationText(before, current);
	return before;
}

const basename = (path: StorePath): string => path.slice(path.lastIndexOf('/') + 1);

function parsePair<T>(
	before: Bytes,
	current: Bytes | null,
	parse: (bytes: Bytes, side: 'image' | 'current') => T
): [T, T] | null {
	if (current === null || current.byteLength === 0) return null;
	try {
		return [parse(before, 'image'), parse(current, 'current')];
	} catch {
		return null;
	}
}

function sequence(prefix: string): () => string {
	let next = 0;
	return () => `${prefix}${next++}`;
}

const differs = (image: AnnotationProperties, typed: AnnotationProperties): boolean =>
	image.title !== typed.title || image.description !== typed.description;

function withText(image: AnnotationProperties, typed: AnnotationProperties): AnnotationProperties {
	const properties: Record<string, unknown> = { ...image };
	for (const key of ['title', 'description'] as const) {
		if (typed[key] === undefined) delete properties[key];
		else properties[key] = typed[key];
	}
	return properties as AnnotationProperties;
}
