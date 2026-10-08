import { describe, expect, test } from 'vitest';

import { decode } from '../test-support.js';
import {
	addAnnotation,
	emptyCollection,
	newAnnotation,
	removeAnnotation,
	type AnnotationCollection
} from './annotation.js';
import { serialiseAnnotations } from './geojson.js';
import { annotationOrdinal } from './ordinal.js';

const pin = (id: string) =>
	newAnnotation({ id, geometry: { type: 'Point', coordinates: [4.9, 52] } });

const collectionOf = (...ids: string[]): AnnotationCollection =>
	ids.reduce((collection, id) => addAnnotation(collection, pin(id)), emptyCollection());

const ordinalsOf = (collection: AnnotationCollection): number[] =>
	collection.annotations.map((_, index) => annotationOrdinal(index));

describe('an Annotation’s number is its place in the collection', () => {
	test('numbering starts at 1 and follows the order the collection already has', () => {
		expect(ordinalsOf(collectionOf('a1', 'a2', 'a3'))).toEqual([1, 2, 3]);
	});

	test('a newly drawn Annotation takes the next number, because it goes on the end', () => {
		expect(ordinalsOf(addAnnotation(collectionOf('a1', 'a2', 'a3'), pin('a4')))).toEqual([
			1, 2, 3, 4
		]);
	});

	test('deleting one renumbers the ones after it, by counting again rather than by writing', () => {
		const three = collectionOf('a1', 'a2', 'a3');
		const two = removeAnnotation(three, 'a1');
		expect(two.annotations.map((annotation) => annotation.id)).toEqual(['a2', 'a3']);
		expect(ordinalsOf(two)).toEqual([1, 2]);
		expect(two.annotations[0]).toBe(three.annotations[1]);
		expect(two.annotations[1]).toBe(three.annotations[2]);
	});
});

describe('the ordinal is display state and reaches no file (ADR-0002)', () => {
	test('the bytes an Annotation Layer is written as carry no number at all', () => {
		const written = decode(serialiseAnnotations(collectionOf('a1', 'a2', 'a3')));
		expect(written).not.toMatch(/ordinal/i);
		const document = JSON.parse(written) as {
			features: { properties: Record<string, unknown> }[];
		};
		expect(document.features.map((feature) => feature.properties)).toEqual([{}, {}, {}]);
		expect(document.features.map((feature) => Object.keys(feature).sort())).toEqual(
			Array(3).fill(['geometry', 'id', 'properties', 'type'])
		);
	});

	test('deleting the first Annotation renumbers the rest without changing their bytes', () => {
		const three = collectionOf('a1', 'a2', 'a3');
		const survivorsBefore = decode(
			serialiseAnnotations({ annotations: three.annotations.slice(1) })
		);
		const two = removeAnnotation(three, 'a1');
		expect(ordinalsOf(three).slice(1)).toEqual([2, 3]);
		expect(ordinalsOf(two)).toEqual([1, 2]);
		expect(decode(serialiseAnnotations(two))).toBe(survivorsBefore);
	});
});
