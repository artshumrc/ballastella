// What decides whether a change to an Annotation Layer needs the stack rebuilt.
//
// `annotationDrawKey` is a small function carrying an expensive consequence: everything it *does not*
// distinguish is applied to a live source in place, and everything it does tears the stack down and
// builds it again. Getting it too coarse makes the map thrash while somebody types a title; getting
// it too fine leaves an Annotation undrawn because the MapLibre layer it needs was never added.
//
// Mostly this function is tested here. The rest of `stack-layers.ts` talks to a live map and is
// asserted through what MapLibre reports it drew, in `e2e/editor-annotations.e2e.ts` — except
// **which buckets a build asks for**, which is a decision about a list of layer ids and is driven
// below against a map that only records them.

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

/** A Label: a Point whose `marker-symbol` says the marker shows its own words. */
const label = (id: string, properties: Record<string, unknown> = {}): Annotation =>
	pin(id, { 'marker-symbol': LABEL_MARKER_SYMBOL, ...properties });

const of = (...annotations: Annotation[]): AnnotationCollection => ({ annotations });

describe('what does not move the key', () => {
	test('a title, which is typed a character at a time', () => {
		// The regression this exists for: the collection itself used to be the key, so every keystroke
		// rebuilt every layer in the stack, Map Images included.
		expect(annotationDrawKey(of(pin('a', { title: 'The' })))).toBe(
			annotationDrawKey(of(pin('a', { title: 'The old mill' })))
		);
	});

	test('a colour, which is dragged', () => {
		expect(annotationDrawKey(of(pin('a', { 'marker-color': '#ff0000' })))).toBe(
			annotationDrawKey(of(pin('a', { 'marker-color': '#0000ff' })))
		);
	});

	test('a moved vertex, or another Annotation of a kind already drawn', () => {
		expect(annotationDrawKey(of(pin('a')))).toBe(annotationDrawKey(of(pin('a'), pin('b'))));
	});

	test('a label’s text, colour or size, which are the source’s data and not its shape', () => {
		// The same regression the title case above is for, for the kind whose title *is* the drawing:
		// typing into a Label must reach `setAnnotations` rather than rebuild the stack per keystroke.
		const key = annotationDrawKey(of(label('a', { title: 'Zuider' })));
		expect(annotationDrawKey(of(label('a', { title: 'Zuiderzee' })))).toBe(key);
		expect(annotationDrawKey(of(label('a', { title: 'Zuider', fill: '#1976d2' })))).toBe(key);
		expect(annotationDrawKey(of(label('a', { title: 'Zuider', 'marker-size': 'large' })))).toBe(
			key
		);
	});

	test('a marker size, which changes how big a pin is and not which layers exist', () => {
		expect(annotationDrawKey(of(pin('a', { 'marker-size': 'small' })))).toBe(
			annotationDrawKey(of(pin('a', { 'marker-size': 'large' })))
		);
	});
});

describe('what does move it', () => {
	test('the first Annotation of a kind the Layer did not have', () => {
		// Each needs a MapLibre layer that is added only when something in the Layer needs it.
		const keys = [
			annotationDrawKey(of(pin('a'))),
			annotationDrawKey(of(line('b'))),
			annotationDrawKey(of(shape('c'))),
			annotationDrawKey(of(pin('a'), line('b')))
		];

		expect(new Set(keys).size).toBe(keys.length);
	});

	test('the first dashed line, because a dash pattern is a layer of its own', () => {
		// `line-dasharray` is the one paint property MapLibre will not evaluate per feature, so solid,
		// dashed and dotted are three layers filtered on a bucket — and a Layer of solid lines has no
		// dashed layer to put a newly dashed Annotation in.
		const solid = annotationDrawKey(of(line('a')));
		const dashed = annotationDrawKey(of(line('a', { 'stroke-dasharray': [8, 4] })));

		expect(dashed).not.toBe(solid);
	});

	test('a Layer of labels and a Layer of pins ask for different layers', () => {
		// A Label draws from a `symbol` layer of its own and a Pin from the pin layer, and neither pays
		// for the other's: the two buckets' filters split on the same `marker-symbol` this key does.
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

/**
 * A map that records the layer ids a build asked for, and says whether its style carries glyphs.
 *
 * ⚠ **Not a map abstraction for the application to use** (ADR-0019 forbids one): it exists only so
 * that "which buckets does this Layer's contents ask for" can be read off a list. Everything about
 * how those layers *draw* is Seam 2's, in `e2e/editor-annotations.e2e.ts`.
 *
 * The pin image is reported already registered, because `pinImage` rasterises through a canvas and
 * Node has none — an unseeded fake would drop the pin bucket for a reason that has nothing to do
 * with glyphs, and hide the very assertion these tests make. The Label's chip is *not* seeded: its
 * field is closed-form arithmetic with no canvas in it, so registration is exercised for real.
 */
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

/** One visible Annotation Layer holding `annotations`, drawn onto `map`. */
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
	// A Published Site written before ADR-0025 carries no `base-map/` assets, and the viewer builds its
	// style without `glyphs` rather than 404ing at fonts that are not there. A Label's words are shaped
	// from those very typefaces, so the bucket is omitted — and the rest of the Layer is not.
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
		// The control, without which the assertion above passes on a stack that drew nothing at all.
		expect(bucketsFor({ glyphs: 'base-map/fonts/{fontstack}/{range}.pbf' }, everything)) //
			.toContain(stackLayerId('layer-1', 'label'));
	});

	test('treats an unloaded style and an empty glyph template as no glyphs', () => {
		// `Map#getStyle()` returns `undefined` until the style has loaded, and MapLibre's types declare
		// it non-nullable, so nothing but this stops a `TypeError` mid-loop from abandoning the
		// remaining Layers with sources added and no layers of their own. An empty template is the other
		// edge: a string MapLibre can never shape text from, and therefore a Label bucket that would be
		// invisible to every assertion about the map.
		for (const style of [undefined, { glyphs: '' }]) {
			const added = bucketsFor(style, everything);

			expect(added).not.toContain(stackLayerId('layer-1', 'label'));
			expect(added).toContain(stackLayerId('layer-1', 'point'));
		}
	});

	test('leaves a Layer of nothing but Labels a Layer that is showing and empty', () => {
		// The state a Layer of pins is in when the pin image cannot be made: drawn, and with no MapLibre
		// layer of its own. Its absence is not a refusal, and the page's notice is what explains it.
		const recording = recordingMap({});
		const render = draw(recording.map, of(label('a', { title: 'Zuiderzee' })));

		expect(recording.added).toEqual([]);
		expect(render.outcomes['layer-1']).toEqual({ status: 'drawn' });
	});
});

describe('what a click can be tested against', () => {
	test('every bucket a Layer could draw is offered for hit-testing, the label’s included', () => {
		// Hit-testing is by layer id, so a bucket absent from this list is a mark nobody can click — in
		// either app, and silently.
		const ids = annotationLayerIds('layer-1');

		expect(ids).toContain(stackLayerId('layer-1', 'label'));
		expect(ids).toContain(stackLayerId('layer-1', 'point'));
		// The selection halo is deliberately not among them; see the note on `annotationLayerIds`.
		expect(ids).not.toContain(stackLayerId('layer-1', 'selected'));
	});
});
