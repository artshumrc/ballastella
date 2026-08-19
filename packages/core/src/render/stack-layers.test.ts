// What decides whether a change to an Annotation Layer needs the stack rebuilt.
//
// `annotationDrawKey` is a small function carrying an expensive consequence: everything it *does not*
// distinguish is applied to a live source in place, and everything it does tears the stack down and
// builds it again. Getting it too coarse makes the map thrash while somebody types a title; getting
// it too fine leaves an Annotation undrawn because the MapLibre layer it needs was never added.
//
// Only this function is tested here. The rest of `stack-layers.ts` talks to a live map and is
// asserted through what MapLibre reports it drew, in `e2e/editor-annotations.e2e.ts`.

import { describe, expect, test } from 'vitest';

import type { Annotation, AnnotationCollection } from '../annotation/annotation.js';

import { LABEL_MARKER_SYMBOL } from '../annotation/annotation.js';

import { annotationDrawKey, annotationLayerIds, stackLayerId } from './stack-layers.js';

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
