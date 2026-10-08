import { describe, expect, test } from 'vitest';

import type { Annotation, AnnotationCollection } from '../annotation/annotation.js';
import type { Map as MapLibreMap } from 'maplibre-gl';

import { LABEL_MARKER_SYMBOL } from '../annotation/annotation.js';
import { PIN_IMAGE_ID } from './pin-icon.js';
import type { AnnotationLayer } from '../project/layer.js';

import {
	annotationDrawKey,
	annotationLayerIds,
	drawLayerStack,
	stackLayerId
} from './stack-layers.js';

const pin = (id: string, properties: Record<string, unknown> = {}): Annotation =>
	({ id, geometry: { type: 'Point', coordinates: [4.9, 52.4] }, properties }) as Annotation;

const line = (id: string, properties: Record<string, unknown> = {}): Annotation =>
	({
		id,
		geometry: {
			type: 'LineString',
			coordinates: [
				[4.8, 52.3],
				[5, 52.4]
			]
		},
		properties
	}) as Annotation;

const shape = (id: string): Annotation =>
	({
		id,
		geometry: {
			type: 'Polygon',
			coordinates: [
				[
					[4.8, 52.3],
					[5, 52.3],
					[5, 52.4],
					[4.8, 52.3]
				]
			]
		},
		properties: {}
	}) as Annotation;

const label = (id: string, properties: Record<string, unknown> = {}): Annotation =>
	pin(id, { 'marker-symbol': LABEL_MARKER_SYMBOL, ...properties });

const of = (...annotations: Annotation[]): AnnotationCollection => ({ annotations });

describe('what does not move the key', () => {
	test.each([
		['a title, which is typed a character at a time', { title: 'The' }, { title: 'The old mill' }],
		['a colour, which is dragged', { 'marker-color': '#ff0000' }, { 'marker-color': '#0000ff' }],
		[
			'a marker size, which changes how big a pin is and not which layers exist',
			{ 'marker-size': 'small' },
			{ 'marker-size': 'large' }
		]
	])('%s', (_, before, after) => {
		expect(annotationDrawKey(of(pin('a', before)))).toBe(annotationDrawKey(of(pin('a', after))));
	});

	test('a moved vertex, or another Annotation of a kind already drawn', () => {
		expect(annotationDrawKey(of(pin('a')))).toBe(annotationDrawKey(of(pin('a'), pin('b'))));
	});

	test('a label’s text, colour or size, which are the source’s data and not its shape', () => {
		const key = annotationDrawKey(of(label('a', { title: 'Zuider' })));
		expect(annotationDrawKey(of(label('a', { title: 'Zuiderzee' })))).toBe(key);
		expect(annotationDrawKey(of(label('a', { title: 'Zuider', fill: '#1976d2' })))).toBe(key);
		expect(annotationDrawKey(of(label('a', { title: 'Zuider', 'marker-size': 'large' })))).toBe(
			key
		);
	});
});

describe('what does move it', () => {
	test('the first Annotation of a kind the Layer did not have', () => {
		const keys = [
			annotationDrawKey(of(pin('a'))),
			annotationDrawKey(of(line('b'))),
			annotationDrawKey(of(shape('c'))),
			annotationDrawKey(of(pin('a'), line('b')))
		];

		expect(new Set(keys).size).toBe(keys.length);
	});

	test('the first dashed line, because a dash pattern is a layer of its own', () => {
		const solid = annotationDrawKey(of(line('a')));
		const dashed = annotationDrawKey(of(line('a', { 'stroke-dasharray': [8, 4] })));
		expect(dashed).not.toBe(solid);
	});

	test('a Layer of labels and a Layer of pins ask for different layers', () => {
		const labels = annotationDrawKey(of(label('a')));
		const pins = annotationDrawKey(of(pin('a')));
		const both = annotationDrawKey(of(label('a'), pin('b')));
		expect(new Set([labels, pins, both]).size).toBe(3);
		expect(labels).not.toContain('point');
		expect(pins).not.toContain('label');
		expect(both).toContain('point');
		expect(both).toContain('label');
	});

	test('an empty Layer and one with something in it', () => {
		expect(annotationDrawKey(of())).not.toBe(annotationDrawKey(of(pin('a'))));
		expect(annotationDrawKey(null)).toBe(annotationDrawKey(of()));
	});
});

function recordingMap(style: { glyphs?: string } | undefined): {
	readonly added: string[];
	readonly map: MapLibreMap;
} {
	const added: string[] = [];
	const images = new Set([PIN_IMAGE_ID]);
	return {
		added,
		map: {
			getStyle: () => style,
			addSource: () => undefined,
			addLayer: (spec: { id: string }) => void added.push(spec.id),
			hasImage: (id: string) => images.has(id),
			addImage: (id: string) => void images.add(id)
		} as unknown as MapLibreMap
	};
}

const draw = (map: MapLibreMap, annotations: AnnotationCollection) =>
	drawLayerStack({
		map,
		layers: [
			{
				layer: {
					kind: 'annotation',
					id: 'layer-1',
					name: 'Warehouses',
					visible: true,
					order: 0,
					geojsonRef: 'annotations/layer-1.geojson'
				} satisfies AnnotationLayer,
				annotations
			}
		],
		fetchTile: () => Promise.reject(new Error('no Map Image is drawn in these tests'))
	});

describe('a style with no glyphs in it', () => {
	const bucketsFor = (
		style: { glyphs?: string } | undefined,
		collection: AnnotationCollection
	): string[] => {
		const recording = recordingMap(style);
		draw(recording.map, collection);
		return recording.added;
	};

	const everything = of(label('a', { title: 'Zuiderzee' }), pin('b'), line('c'), shape('d'));

	test('omits the Label bucket, and adds every other bucket the Layer needs', () => {
		const added = bucketsFor({}, everything);
		expect(added).not.toContain(stackLayerId('layer-1', 'label'));
		expect(added).toContain(stackLayerId('layer-1', 'point'));
		expect(added).toContain(stackLayerId('layer-1', 'fill'));
		expect(added).toContain(stackLayerId('layer-1', 'line-solid'));
	});

	test('adds the Label bucket where the style does carry glyphs', () => {
		expect(bucketsFor({ glyphs: 'base-map/fonts/{fontstack}/{range}.pbf' }, everything)) //
			.toContain(stackLayerId('layer-1', 'label'));
	});

	test('treats an unloaded style and an empty glyph template as no glyphs', () => {
		for (const style of [undefined, { glyphs: '' }]) {
			const added = bucketsFor(style, everything);
			expect(added).not.toContain(stackLayerId('layer-1', 'label'));
			expect(added).toContain(stackLayerId('layer-1', 'point'));
		}
	});

	test('leaves a Layer of nothing but Labels a Layer that is showing and empty', () => {
		const recording = recordingMap({});
		const render = draw(recording.map, of(label('a', { title: 'Zuiderzee' })));
		expect(recording.added).toEqual([]);
		expect(render.outcomes['layer-1']).toEqual({ status: 'drawn' });
	});
});

describe('what a click can be tested against', () => {
	test('every bucket a Layer could draw is offered for hit-testing, the label’s included', () => {
		const ids = annotationLayerIds('layer-1');
		expect(ids).toContain(stackLayerId('layer-1', 'label'));
		expect(ids).toContain(stackLayerId('layer-1', 'point'));
		expect(ids).not.toContain(stackLayerId('layer-1', 'selected'));
	});
});
