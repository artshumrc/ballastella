import { describe, expect, test } from 'vitest';

import type { Annotation } from '../annotation/annotation.js';

import { annotationMarkBox } from './annotation-mark.js';
import { pinHeight } from './pin-icon.js';

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
const dot = (x: number, y: number) => ({ left: x, top: y, right: x, bottom: y });

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
		expect(annotationMarkBox(map(), line)).toEqual(dot(110, 80));
	});

	test("the middle of a bent line's extent is not on the line, which is why a vertex is used", () => {
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
		expect(annotationMarkBox(map(), meridian)).toEqual(dot(130, 60));
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
		expect(annotationMarkBox(map(), shape)).toEqual(dot(120, 60));
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
		const label = annotation(point.geometry, { 'marker-symbol': 'label' });
		expect(annotationMarkBox(map(), label)).toEqual(dot(140, 70));
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
