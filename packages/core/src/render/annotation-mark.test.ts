// Where an Annotation lands on the screen, in Node against a stub camera.
//
// The projection itself is MapLibre's and is not re-derived here; what is asserted is everything
// this module adds around it — which anchor is projected, that the canvas' own offset is added, and
// that a Pin is given its pin's box rather than the ground under it. That the box really is where
// the coordinate on disk is drawn can only be checked against a running renderer, and is
// `e2e/editor-annotations.e2e.ts`'s.

import { describe, expect, test } from 'vitest';

import type { Annotation } from '../annotation/annotation.js';

import { annotationMarkBox } from './annotation-mark.js';
import { pinHeight } from './pin-icon.js';

/** A camera that puts the canvas at (100, 50) and projects one degree to ten pixels. */
const map = (): Parameters<typeof annotationMarkBox>[0] =>
	({
		getCanvasContainer: () => ({ getBoundingClientRect: () => ({ left: 100, top: 50 }) }),
		project: ([lng, lat]: [number, number]) => ({ x: lng * 10, y: lat * 10 })
	}) as never;

const annotation = (
	geometry: Annotation['geometry'],
	properties: Record<string, unknown> = {}
): Annotation => ({ id: 'a', geometry, properties }) as Annotation;

const point = annotation({ type: 'Point', coordinates: [4, 2] });

describe('annotationMarkBox', () => {
	test('a line is pointed at on the line itself, at its westmost vertex', () => {
		const line = annotation({
			type: 'LineString',
			coordinates: [
				[4, 2],
				[1, 3],
				[6, 0]
			]
		});
		// (1, 3) → (10, 30) projected → (110, 80) in the viewport.
		expect(annotationMarkBox(map(), line)).toEqual({
			left: 110,
			top: 80,
			right: 110,
			bottom: 80
		});
	});

	test("the middle of a bent line's extent is not on the line, which is why a vertex is used", () => {
		// An `L`: the extent's middle is (2, 1), a place the line passes nowhere near, and the leader
		// used to end there. The negative control for the rule above. The corner and the north end are
		// equally west, so the tie goes south to the corner — (0, 0) → (100, 50) in the viewport.
		const bent = annotation({
			type: 'LineString',
			coordinates: [
				[0, 2],
				[0, 0],
				[4, 0]
			]
		});
		const box = annotationMarkBox(map(), bent)!;
		expect({ x: box.left, y: box.top }).toEqual({ x: 100, y: 50 });
		// The middle of the extent, for comparison: (2, 1) → (120, 60).
		expect(Math.hypot(box.left - 120, box.top - 60)).toBeGreaterThan(20);
	});

	test('a north–south line has one answer rather than two: latitude breaks the tie', () => {
		const meridian = annotation({
			type: 'LineString',
			coordinates: [
				[3, 5],
				[3, 1]
			]
		});
		// Both vertices are equally west, so the southern one is chosen: (3, 1) → (130, 60).
		expect(annotationMarkBox(map(), meridian)).toEqual({
			left: 130,
			top: 60,
			right: 130,
			bottom: 60
		});
	});

	test('a shape is a point too: there is no mark around it to clear', () => {
		const shape = annotation({
			type: 'Polygon',
			coordinates: [
				[
					[0, 0],
					[4, 0],
					[4, 2],
					[0, 2],
					[0, 0]
				]
			]
		});
		const box = annotationMarkBox(map(), shape);
		expect(box).toEqual({ left: 120, top: 60, right: 120, bottom: 60 });
	});

	test('a Pin gets its pin, standing on the coordinate rather than centred on it', () => {
		const height = pinHeight('medium');
		expect(annotationMarkBox(map(), point)).toEqual({
			left: 140 - height / 2,
			top: 70 - height,
			right: 140 + height / 2,
			bottom: 70
		});
	});

	test('a label is a point too: it is centred on its coordinate and has no pin to clear', () => {
		// The leader ends on the words themselves. A Label drawn the pin's box would be pointed at half a
		// pin's height above the place it names, over ground it does not occupy.
		const label = annotation(point.geometry, { 'marker-symbol': 'label' });

		expect(annotationMarkBox(map(), label)).toEqual({
			left: 140,
			top: 70,
			right: 140,
			bottom: 70
		});
		// The negative control: the same Point without the symbol is a Pin and does get the pin's box.
		expect(annotationMarkBox(map(), point)).not.toEqual(annotationMarkBox(map(), label));
	});

	test("the pin's box follows `marker-size`, so the line stops at the edge of the pin drawn", () => {
		const heightOf = (size: string): number => {
			const box = annotationMarkBox(map(), annotation(point.geometry, { 'marker-size': size }));
			return (box?.bottom ?? 0) - (box?.top ?? 0);
		};
		expect(heightOf('small')).toBe(pinHeight('small'));
		expect(heightOf('large')).toBe(pinHeight('large'));
		expect(heightOf('small')).toBeLessThan(heightOf('large'));
	});

	test('a geometry this build cannot draw has no box, and so no line', () => {
		expect(annotationMarkBox(map(), annotation({ type: 'foreign', raw: {} } as never))).toBeNull();
		expect(
			annotationMarkBox(map(), annotation({ type: 'LineString', coordinates: [] }))
		).toBeNull();
		expect(annotationMarkBox(map(), annotation(null))).toBeNull();
	});
});
