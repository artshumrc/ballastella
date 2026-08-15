// SPEC's Seam 1 for the number an Annotation is known by: a rule over a collection's order, and a
// claim about what it must never reach.
//
// Here rather than through a DOM because that is all an ordinal is — the one-shell-two-apps SPEC says
// so under "The seam each claim belongs at": *ordinals are computed from a collection's order and can
// be asserted at Seam 1*. What a row and a mark do with the number is asserted where they are.

import { describe, expect, test } from 'vitest';

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

/** What the whole collection is numbered, which is what both surfaces render. */
const ordinalsOf = (collection: AnnotationCollection): number[] =>
	collection.annotations.map((_, index) => annotationOrdinal(index));

const utf8 = (encoded: Uint8Array): string => new TextDecoder().decode(encoded);

describe('an Annotation’s number is its place in the collection (stories 37, 38)', () => {
	test('numbering starts at 1 and follows the order the collection already has', () => {
		expect(ordinalsOf(collectionOf('a1', 'a2', 'a3'))).toEqual([1, 2, 3]);
	});

	test('a newly drawn Annotation takes the next number, because it goes on the end', () => {
		const three = collectionOf('a1', 'a2', 'a3');

		expect(ordinalsOf(addAnnotation(three, pin('a4')))).toEqual([1, 2, 3, 4]);
	});

	test('deleting one renumbers the ones after it, by counting again rather than by writing', () => {
		// The whole of "renumbering is a re-render": the ordinal is not stored anywhere, so the second
		// Annotation *becoming* number 2 is what the same function says about a shorter list.
		const three = collectionOf('a1', 'a2', 'a3');
		const two = removeAnnotation(three, 'a1');

		expect(two.annotations.map((annotation) => annotation.id)).toEqual(['a2', 'a3']);
		expect(ordinalsOf(two)).toEqual([1, 2]);
		// And the survivors are the identical objects: nothing was rewritten to renumber them.
		expect(two.annotations[0]).toBe(three.annotations[1]);
		expect(two.annotations[1]).toBe(three.annotations[2]);
	});
});

describe('the ordinal is display state and reaches no file (ADR-0002, story 43)', () => {
	test('the bytes an Annotation Layer is written as carry no number at all', () => {
		// ⚠ **This is the assertion the mutation check breaks.** Write the ordinal into a feature's
		// `properties` — or onto the `Feature` object — and this goes red, alongside
		// `e2e/editor-annotations.e2e.ts`'s byte-identity claim over real files in OPFS.
		const collection = collectionOf('a1', 'a2', 'a3');
		expect(ordinalsOf(collection)).toEqual([1, 2, 3]);

		const written = utf8(serialiseAnnotations(collection));

		expect(written).not.toMatch(/ordinal/i);
		const document = JSON.parse(written) as {
			features: { properties: Record<string, unknown> }[];
		};
		// A pin drawn with default styling carries no properties at all (ADR-0009), so an ordinal
		// arriving in `properties` is visible as the object ceasing to be empty.
		expect(document.features.map((feature) => feature.properties)).toEqual([{}, {}, {}]);
		expect(document.features.map((feature) => Object.keys(feature).sort())).toEqual([
			['geometry', 'id', 'properties', 'type'],
			['geometry', 'id', 'properties', 'type'],
			['geometry', 'id', 'properties', 'type']
		]);
	});

	test('deleting the first Annotation renumbers the rest without changing their bytes', () => {
		// Ordinals 2 and 3 become 1 and 2, and the two Annotations that survive serialise to exactly
		// the bytes they had before — which is only possible because the number is nowhere in them.
		const three = collectionOf('a1', 'a2', 'a3');
		const survivorsBefore = utf8(serialiseAnnotations({ annotations: three.annotations.slice(1) }));

		const two = removeAnnotation(three, 'a1');

		expect(ordinalsOf(three).slice(1)).toEqual([2, 3]);
		expect(ordinalsOf(two)).toEqual([1, 2]);
		expect(utf8(serialiseAnnotations(two))).toBe(survivorsBefore);
	});
});
