// Where an Annotation's number is drawn, and which Annotations get one.
//
// The arithmetic half of `annotation-ordinals.ts`, in Node. What the marks *look* like — a numbered
// disc over a real MapLibre map, legible in both themes, still over its Annotation after a pan and a
// zoom — needs a browser and a map and is asserted in `e2e/editor-annotations.e2e.ts`, which is the
// same split `stack-layers.test.ts` already makes about the layers beside these.

import { describe, expect, test } from 'vitest';

import type { Annotation, AnnotationCollection } from '../annotation/annotation.js';

import { annotationMarks } from './annotation-ordinals.js';

const of = (...annotations: Annotation[]): AnnotationCollection => ({ annotations });

const pin = (id: string, properties: Record<string, unknown> = {}): Annotation =>
	({ id, geometry: { type: 'Point', coordinates: [4.9, 52.4] }, properties }) as Annotation;

/** A line whose middle is nowhere near either end, so "the first vertex" is a visibly wrong answer. */
const line = (id: string): Annotation =>
	({
		id,
		geometry: {
			type: 'LineString',
			coordinates: [
				[4, 52],
				[6, 52],
				[6, 54]
			]
		},
		properties: {}
	}) as Annotation;

const shape = (id: string): Annotation =>
	({
		id,
		geometry: {
			type: 'Polygon',
			coordinates: [
				[
					[4, 52],
					[6, 52],
					[6, 54],
					[4, 54],
					[4, 52]
				]
			]
		},
		properties: {}
	}) as Annotation;

describe('which Annotations carry a number, and what it is', () => {
	test('every drawable Annotation carries its place in the collection, counted from 1', () => {
		expect(annotationMarks(of(pin('a'), line('b'), shape('c'))).map((mark) => mark.ordinal)) //
			.toEqual([1, 2, 3]);
	});

	test('a Layer nobody has read yet has no marks rather than none to draw', () => {
		expect(annotationMarks(null)).toEqual([]);
		expect(annotationMarks(of())).toEqual([]);
	});

	test('a geometry this build cannot draw takes its number with it, and does not shift the rest', () => {
		// The number is the *collection's* position, so the Annotation still reads as 2 in the sidebar
		// where it is listed. It simply has nowhere on the earth to put one — see `ordinal.ts`.
		const foreign = {
			id: 'b',
			geometry: { type: 'foreign', declaredType: 'GeometryCollection', raw: {} },
			properties: {}
		} as unknown as Annotation;

		const marks = annotationMarks(of(pin('a'), foreign, shape('c')));

		expect(marks.map((mark) => [mark.id, mark.ordinal])).toEqual([
			['a', 1],
			['c', 3]
		]);
	});
});

describe('where a line’s and a shape’s number is anchored', () => {
	// ⚠ **Not the first vertex, and not the pointer.** The anchor is `annotationAnchor`'s — the middle
	// of the geometry — which is the same place the Annotation's popup already points, so the number,
	// the popup and (ticket 12) the leader all name one point rather than three.

	test('a line’s number is in the middle of it, not at either end', () => {
		const [mark] = annotationMarks(of(line('b')));

		expect(mark?.at).toEqual({ lng: 5, lat: 53 });
		// The negative control the criterion is written against: the first vertex is [4, 52].
		expect(mark?.at).not.toEqual({ lng: 4, lat: 52 });
	});

	test('a shape’s number is in the middle of its outer ring', () => {
		const [mark] = annotationMarks(of(shape('c')));

		expect(mark?.at).toEqual({ lng: 5, lat: 53 });
		expect(mark?.at).not.toEqual({ lng: 4, lat: 52 });
	});

	test('the anchor is a fact about the geometry and nothing else about the Annotation', () => {
		// The stability criterion, in the form this seam can state it. Every other thing that can change
		// about an Annotation while it sits on the map — its title, its colour, its width, and what else
		// is in the Layer beside it — leaves the coordinate where it was, so there is nothing left for a
		// viewport to be. That it is still *drawn* there after a pan and a zoom is asserted against a
		// real map in `e2e/editor-annotations.e2e.ts`, which compares the mark's own box with
		// `map.project()` of this coordinate at two zooms.
		const plain = annotationMarks(of(shape('c')))[0]?.at;
		const dressed = {
			...shape('c'),
			properties: { title: 'The west quay', stroke: '#ff0000', 'stroke-width': 9, fill: '#00ff00' }
		} as Annotation;

		expect(annotationMarks(of(dressed))[0]?.at).toEqual(plain);
		expect(annotationMarks(of(pin('a'), dressed, line('b')))[1]?.at).toEqual(plain);
	});
});

describe('a pin’s number clears the pin it belongs to', () => {
	test('it sits above the coordinate by the height of the pin standing on it', () => {
		// A pin is anchored at its tip, so a number drawn at the coordinate would sit under the mark it
		// names. The clearance is the pin's own height, asked of `pin-icon.ts` rather than measured
		// again here — which is what stops the two drifting the next time a pin is resized.
		const [small] = annotationMarks(of(pin('a', { 'marker-size': 'small' })));
		const [medium] = annotationMarks(of(pin('a')));
		const [large] = annotationMarks(of(pin('a', { 'marker-size': 'large' })));

		expect(small!.clearance).toBeGreaterThan(0);
		expect(medium!.clearance).toBeGreaterThan(small!.clearance);
		expect(large!.clearance).toBeGreaterThan(medium!.clearance);
	});

	test('a line and a shape have none, because their number sits on the middle of them', () => {
		expect(annotationMarks(of(line('b'), shape('c'))).map((mark) => mark.clearance)) //
			.toEqual([0, 0]);
	});

	test('and the pin’s own number is at the pin’s own coordinate', () => {
		expect(annotationMarks(of(pin('a')))[0]?.at).toEqual({ lng: 4.9, lat: 52.4 });
	});
});
