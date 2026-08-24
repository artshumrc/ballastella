import { describe, expect, it } from 'vitest';

import { newAnnotation, type Annotation } from '../annotation/annotation.js';
import { parseAnnotations, serialiseAnnotations } from '../annotation/geojson.js';
import { newAnnotationLayer, newMapLayer, type Layer } from '../project/layer.js';
import { newProjectFile, parseProjectFile, serialiseProjectFile } from '../project/project-file.js';
import type { Bytes } from '../store/project-store.js';
import { carryAnnotationText, carryProjectText } from './carry-text.js';

const encode = (text: string): Bytes => new TextEncoder().encode(text);

const project = (fields: { name: string; layers: readonly Layer[] }): Bytes =>
	serialiseProjectFile({
		...newProjectFile(fields.name, new Date('2024-03-01T00:00:00.000Z')),
		layers: fields.layers
	});

const floride = newMapLayer({ id: 'l-map', name: 'La Floride', imageId: 'floride-1657' });

describe('a Project’s typed names carried across a Step (SPEC stories 33, 54)', () => {
	// The Step is a byte image taken before the gesture; the name was typed after it. Writing the
	// image verbatim would take back words the scholar never asked undo to touch.
	it('keeps a Project name typed after the image was taken', () => {
		const before = project({ name: 'Florida drafts', layers: [floride] });
		const current = project({ name: 'Florida, 1657', layers: [floride] });

		expect(parseProjectFile(carryProjectText(before, current)).name).toBe('Florida, 1657');
	});

	it('keeps a Layer name typed after the image was taken', () => {
		const before = project({ name: 'Florida', layers: [floride] });
		const current = project({
			name: 'Florida',
			layers: [{ ...floride, name: 'La Floride (Le Moyne)' }]
		});

		const carried = parseProjectFile(carryProjectText(before, current));
		expect(carried.layers.map((layer) => layer.name)).toEqual(['La Floride (Le Moyne)']);
	});

	// A Layer the image never held has nothing of the scholar's to carry: undoing its creation is
	// supposed to take the name typed onto it as well.
	it('carries nothing for a Layer absent from the image', () => {
		const notes = newAnnotationLayer({ id: 'l-notes', name: 'Trade routes' });
		const before = project({ name: 'Florida', layers: [floride] });
		const current = project({ name: 'Florida', layers: [floride, notes] });

		const carried = parseProjectFile(carryProjectText(before, current));
		expect(carried.layers.map((layer) => layer.id)).toEqual(['l-map']);
	});

	it('returns the image byte-identically when nothing carries', () => {
		const before = project({ name: 'Florida', layers: [floride] });
		const current = project({ name: 'Florida', layers: [{ ...floride, opacity: 0.4 }] });

		expect(carryProjectText(before, current)).toBe(before);
	});

	// Total, because it is called on whatever is on disk at the moment undo is pressed — which may
	// be a file another tool wrote, an empty one, or nothing at all.
	it('returns the image when the current file is absent, empty or unparseable', () => {
		const before = project({ name: 'Florida', layers: [floride] });

		expect(carryProjectText(before, null)).toBe(before);
		expect(carryProjectText(before, encode(''))).toBe(before);
		expect(carryProjectText(before, encode('{ not json'))).toBe(before);
	});
});

describe('an Annotation’s typed words carried across a Step (SPEC stories 33, 34, 54)', () => {
	const collection = (annotations: readonly Annotation[]): Bytes =>
		serialiseAnnotations({ annotations });

	const fort = newAnnotation({
		id: 'a1',
		geometry: { type: 'Point', coordinates: [4.9, 52.3] },
		title: 'Fort'
	});

	it('keeps a title and a description typed after the image was taken', () => {
		const before = collection([fort]);
		const current = collection([
			{
				...fort,
				properties: { title: 'Fort Caroline', description: 'Named in the 1564 relation.' }
			}
		]);

		const carried = parseAnnotations(carryAnnotationText(before, current), { path: 'x.geojson' });
		expect(carried.annotations[0]?.properties.title).toBe('Fort Caroline');
		expect(carried.annotations[0]?.properties.description).toBe('Named in the 1564 relation.');
	});

	// Undoing the creation of an Annotation takes its words with it, because the image it goes back
	// to has no such Annotation to carry them onto (SPEC story 34).
	it('carries nothing for an Annotation absent from the image', () => {
		const drawn = newAnnotation({
			id: 'a2',
			geometry: { type: 'Point', coordinates: [5, 52] },
			title: 'A note typed after drawing'
		});
		const before = collection([fort]);

		const carried = parseAnnotations(carryAnnotationText(before, collection([fort, drawn])), {
			path: 'x.geojson'
		});
		expect(carried.annotations.map((one) => one.id)).toEqual(['a1']);
	});

	it('returns the image byte-identically when nothing carries', () => {
		const before = collection([fort]);
		const current = collection([
			{ ...fort, properties: { ...fort.properties, stroke: '#aa0000' } }
		]);

		expect(carryAnnotationText(before, current)).toBe(before);
	});

	it('returns the image when the current file is absent, empty or unparseable', () => {
		const before = collection([fort]);

		expect(carryAnnotationText(before, null)).toBe(before);
		expect(carryAnnotationText(before, encode(''))).toBe(before);
		expect(carryAnnotationText(before, encode('{ not json'))).toBe(before);
	});
});
