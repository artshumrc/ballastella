// SPEC's Seam 1 for Annotations: the domain model and the file, in Node, with the bytes as the
// assertion.
//
// The sanitisation half of ADR-0009 is in `markdown.browser.test.ts`, which has to be a browser
// project because DOMPurify sanitises by parsing into a real DOM — see the note at the top of it.

import { describe, expect, test } from 'vitest';

import { newAnnotationLayer, type SimpleStyle } from '../project/layer.js';
import type { Bytes } from '../store/project-store.js';

import {
	DASHED_DASHARRAY,
	DOTTED_DASHARRAY,
	MARKER_SIZES,
	SIMPLESTYLE_DEFAULTS,
	addAnnotation,
	dashArrayFor,
	emptyCollection,
	findAnnotation,
	lineStyleOf,
	newAnnotation,
	removeAnnotation,
	resolveStyle,
	setGeometry,
	setLineStyle,
	setStyle,
	setText,
	simpleStyleViolations,
	withLineStyle,
	type AnnotationCollection,
	type AnnotationProperties
} from './annotation.js';
import { AnnotationsUnreadableError, parseAnnotations, serialiseAnnotations } from './geojson.js';
import {
	ANNOTATION_ID_PROPERTY,
	LINE_STYLE_PROPERTY,
	mapLibreDashArray,
	toRenderCollection
} from './render.js';

const utf8 = (encoded: Uint8Array): string => new TextDecoder().decode(encoded);
// Annotated as `Bytes`, which is `Uint8Array<ArrayBuffer>`: Node's `TextEncoder` is typed as returning
// the wider `ArrayBufferLike`, so an unannotated helper infers a type the store's own does not accept.
const bytes = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;

/** Ids are handed in, so every assertion about the written file is about a fixed document. */
const counting = () => {
	let next = 0;
	return () => `a${(next += 1)}`;
};

const pin = (id: string, lng = 4.9, lat = 52.37) =>
	newAnnotation({ id, geometry: { type: 'Point', coordinates: [lng, lat] } });

const collectionOf = (...annotations: ReturnType<typeof pin>[]): AnnotationCollection =>
	annotations.reduce(addAnnotation, emptyCollection());

describe('drawing (SPEC stories 57, 58, 59)', () => {
	test('a point, a line, and a polygon all round-trip through the file', () => {
		const drawn = collectionOf(
			pin('a1'),
			newAnnotation({
				id: 'a2',
				geometry: {
					type: 'LineString',
					coordinates: [
						[4.9, 52.37],
						[5.1, 52.4]
					]
				}
			}),
			newAnnotation({
				id: 'a3',
				geometry: {
					type: 'Polygon',
					coordinates: [
						[
							[4.9, 52.3],
							[5, 52.3],
							[5, 52.4],
							[4.9, 52.3]
						]
					]
				}
			})
		);

		const read = parseAnnotations(serialiseAnnotations(drawn));

		expect(read.annotations.map((annotation) => annotation.geometry?.type)) //
			.toEqual(['Point', 'LineString', 'Polygon']);
		expect(read).toEqual(drawn);
	});

	test('a new Annotation carries no style properties at all', () => {
		// A criterion rather than an omission: precedence is what lets a Layer be restyled in bulk, and
		// stamping defaults at creation time would break that on the first thing drawn (ADR-0009).
		const drawn = pin('a1');

		expect(drawn.properties).toEqual({});
		expect(utf8(serialiseAnnotations(collectionOf(drawn)))).toContain('"properties": {}');
		expect(utf8(serialiseAnnotations(collectionOf(drawn)))).not.toContain('stroke');
	});

	test('the written file is a valid GeoJSON FeatureCollection', () => {
		const written = JSON.parse(utf8(serialiseAnnotations(collectionOf(pin('a1')))));

		expect(written.type).toBe('FeatureCollection');
		expect(Array.isArray(written.features)).toBe(true);
		expect(written.features[0]).toMatchObject({
			type: 'Feature',
			id: 'a1',
			geometry: { type: 'Point', coordinates: [4.9, 52.37] }
		});
	});

	test('reshaping replaces the geometry and nothing else', () => {
		const before = setText(collectionOf(pin('a1')), 'a1', { title: 'The quay' });

		const after = setGeometry(before, 'a1', { type: 'Point', coordinates: [5, 52.4] });

		expect(after.annotations[0]?.geometry).toEqual({ type: 'Point', coordinates: [5, 52.4] });
		expect(after.annotations[0]?.properties).toEqual({ title: 'The quay' });
	});

	test('deleting an Annotation removes it from the file (SPEC story 66)', () => {
		const before = collectionOf(pin('a1'), pin('a2'), pin('a3'));

		const after = removeAnnotation(before, 'a2');

		expect(after.annotations.map((annotation) => annotation.id)).toEqual(['a1', 'a3']);
		expect(utf8(serialiseAnnotations(after))).not.toContain('a2');
		expect(findAnnotation(after, 'a2')).toBeUndefined();
	});

	test('deleting an Annotation that is not there is the same collection, so nothing is written', () => {
		// Identity, not equality: the caller writes only when the collection changed, which is what
		// keeps an untouched file byte-identical.
		const before = collectionOf(pin('a1'));

		expect(removeAnnotation(before, 'nobody')).toBe(before);
		expect(setText(before, 'nobody', { title: 'x' })).toBe(before);
		expect(setStyle(before, 'nobody', { stroke: '#000000' })).toBe(before);
	});
});

describe('an unchanged file serialises byte-identically', () => {
	// Ticket 09 asserts that reordering, renaming, toggling, and setting opacity leave
	// `annotations/*.geojson` byte-identical. That is a claim about the write path never being reached;
	// this is the stronger claim that reaching it with nothing changed costs nothing either, which is
	// what makes a Workspace in git produce readable diffs and what ADR-0010 asks for.

	test('a file this app wrote parses and writes back to the identical bytes', () => {
		const original = serialiseAnnotations(
			setStyle(
				setText(collectionOf(pin('a1'), pin('a2')), 'a1', {
					title: 'Warehouses',
					description: 'The *west* quay.'
				}),
				'a2',
				{ stroke: '#aa3311', 'stroke-dasharray': DASHED_DASHARRAY }
			)
		);

		const again = serialiseAnnotations(parseAnnotations(original));

		expect(utf8(again)).toBe(utf8(original));
		expect([...again]).toEqual([...original]);
	});

	test('an empty Layer written at creation round-trips identically', () => {
		// `emptyAnnotationCollection` in `layer.ts` is what ticket 09 writes when a Layer is added, and
		// this module has to agree with it byte for byte or the first edit reformats the file.
		const asCreated = bytes(
			`${JSON.stringify({ type: 'FeatureCollection', features: [] }, null, '\t')}\n`
		);

		expect(utf8(serialiseAnnotations(parseAnnotations(asCreated)))).toBe(utf8(asCreated));
		expect(utf8(serialiseAnnotations(emptyCollection()))).toBe(utf8(asCreated));
	});

	test('tab indented with a trailing newline, like project.json and the Alignment', () => {
		const written = utf8(serialiseAnnotations(collectionOf(pin('a1'))));

		expect(written.endsWith('\n')).toBe(true);
		expect(written).toContain('\n\t"type": "FeatureCollection"');
	});

	test('an unknown collection field and an unknown Annotation field both survive', () => {
		const original = `${JSON.stringify(
			{
				type: 'FeatureCollection',
				features: [
					{
						type: 'Feature',
						id: 'a1',
						properties: { title: 'x', 'stroke-linecap': 'round' },
						geometry: { type: 'Point', coordinates: [1, 2] },
						bbox: [1, 2, 1, 2]
					}
				],
				name: 'trade routes'
			},
			null,
			'\t'
		)}\n`;

		expect(utf8(serialiseAnnotations(parseAnnotations(bytes(original))))).toBe(original);
	});

	test('a geometry kind this build cannot draw is written back unchanged', () => {
		const original = `${JSON.stringify(
			{
				type: 'FeatureCollection',
				features: [
					{
						type: 'Feature',
						id: 'a1',
						properties: {},
						geometry: {
							type: 'MultiPolygon',
							coordinates: [
								[
									[
										[1, 2],
										[3, 4],
										[1, 2]
									]
								]
							]
						}
					}
				]
			},
			null,
			'\t'
		)}\n`;

		const read = parseAnnotations(bytes(original));

		expect(read.annotations[0]?.geometry).toMatchObject({
			type: 'foreign',
			declaredType: 'MultiPolygon'
		});
		expect(utf8(serialiseAnnotations(read))).toBe(original);
	});
});

describe('reading somebody else’s document', () => {
	test('bytes that are not JSON are surfaced, never replaced with an empty collection', () => {
		// Silently substituting an empty collection would show a scholar none of their Annotations and
		// then overwrite them on the next save.
		expect(() => parseAnnotations(bytes('{not json'), { path: 'annotations/x.geojson' })) //
			.toThrow(AnnotationsUnreadableError);
		expect(() => parseAnnotations(bytes('[]'))).toThrow(/not a JSON object/);
	});

	test('an id-less Feature is given one, and an integer id becomes its string', () => {
		const read = parseAnnotations(
			bytes(
				JSON.stringify({
					type: 'FeatureCollection',
					features: [
						{ type: 'Feature', properties: {}, geometry: null },
						{ type: 'Feature', id: 17, properties: {}, geometry: null }
					]
				})
			),
			{ mintId: counting() }
		);

		expect(read.annotations.map((annotation) => annotation.id)).toEqual(['a1', '17']);
	});

	test('a null geometry is kept, which RFC 7946 permits and geojson.io writes', () => {
		const read = parseAnnotations(
			bytes(
				JSON.stringify({
					type: 'FeatureCollection',
					features: [{ type: 'Feature', id: 'a1', properties: { title: 'x' }, geometry: null }]
				})
			)
		);

		expect(read.annotations[0]?.geometry).toBeNull();
		expect(read.annotations[0]?.properties).toEqual({ title: 'x' });
	});

	test('an element that is not an object is dropped, having nothing in it to keep', () => {
		const read = parseAnnotations(
			bytes(JSON.stringify({ type: 'FeatureCollection', features: [null, 7, 'x'] }))
		);

		expect(read.annotations).toEqual([]);
	});

	test('a Point whose coordinates are not two numbers is foreign rather than repaired', () => {
		const read = parseAnnotations(
			bytes(
				JSON.stringify({
					type: 'FeatureCollection',
					features: [
						{
							type: 'Feature',
							id: 'a1',
							properties: {},
							geometry: { type: 'Point', coordinates: ['a', 'b'] }
						}
					]
				})
			)
		);

		expect(read.annotations[0]?.geometry).toMatchObject({ type: 'foreign' });
	});
});

describe('style precedence: properties → defaultStyle → simplestyle (ADR-0009)', () => {
	const layerDefault: SimpleStyle = { stroke: '#112233', 'stroke-width': 5, fill: '#445566' };

	test('a Layer defaultStyle reaches an Annotation with no properties of its own', () => {
		const resolved = resolveStyle({}, layerDefault);

		expect(resolved.stroke).toBe('#112233');
		expect(resolved['stroke-width']).toBe(5);
		expect(resolved.fill).toBe('#445566');
	});

	test('a feature property overrides the Layer default', () => {
		const resolved = resolveStyle({ stroke: '#ff0000' }, layerDefault);

		expect(resolved.stroke).toBe('#ff0000');
	});

	test('overriding one property keeps the Layer’s others', () => {
		// Per property, not per object. An object-level fallback would make setting one colour silently
		// discard every other value the Layer carried.
		const resolved = resolveStyle({ stroke: '#ff0000' }, layerDefault);

		expect(resolved['stroke-width']).toBe(5);
		expect(resolved.fill).toBe('#445566');
	});

	test('simplestyle’s own defaults are the last step', () => {
		expect(resolveStyle({}, {})).toMatchObject(SIMPLESTYLE_DEFAULTS);
		expect(resolveStyle(undefined, undefined)).toMatchObject(SIMPLESTYLE_DEFAULTS);
	});

	test('a zero opacity is honoured rather than falling through as falsy', () => {
		// The bug a `??`-with-`||` implementation has, and the reason `pick` compares with `undefined`:
		// 0 and '' are meaningful values here, and "fully transparent" is a thing a user chooses.
		expect(resolveStyle({ 'fill-opacity': 0 }, { 'fill-opacity': 0.9 })['fill-opacity']).toBe(0);
		expect(resolveStyle({}, { 'stroke-width': 0 })['stroke-width']).toBe(0);
	});

	test('a new Annotation Layer starts with an empty defaultStyle, so the spec’s defaults apply', () => {
		const layer = newAnnotationLayer({ id: 'l1', name: 'Trade routes' });

		expect(resolveStyle({}, layer.defaultStyle)).toMatchObject(SIMPLESTYLE_DEFAULTS);
	});
});

describe('solid, dashed, and dotted (SPEC story 61)', () => {
	test('solid is the absence of stroke-dasharray, not a tuple that looks continuous', () => {
		expect(dashArrayFor('solid')).toBeUndefined();

		const written = JSON.parse(
			utf8(serialiseAnnotations(setLineStyle(collectionOf(pin('a1')), 'a1', 'solid')))
		);

		expect('stroke-dasharray' in written.features[0].properties).toBe(false);
	});

	test('dashed and dotted store tuples, never a keyword', () => {
		const dashed = setLineStyle(collectionOf(pin('a1')), 'a1', 'dashed');
		const dotted = setLineStyle(collectionOf(pin('a1')), 'a1', 'dotted');

		expect(dashed.annotations[0]?.properties['stroke-dasharray']).toEqual([8, 4]);
		expect(dotted.annotations[0]?.properties['stroke-dasharray']).toEqual([1, 3]);
		expect(utf8(serialiseAnnotations(dashed))).toContain('"stroke-dasharray"');
		for (const keyword of ['"dashed"', '"dotted"', '"solid"']) {
			expect(utf8(serialiseAnnotations(dashed))).not.toContain(keyword);
			expect(utf8(serialiseAnnotations(dotted))).not.toContain(keyword);
		}
	});

	test('choosing solid after dashed removes the property rather than blanking it', () => {
		const back = setLineStyle(setLineStyle(collectionOf(pin('a1')), 'a1', 'dashed'), 'a1', 'solid');

		expect('stroke-dasharray' in back.annotations[0]!.properties).toBe(false);
	});

	test('a Layer’s default style takes the same rule, through the same function', () => {
		// The Layer's `defaultStyle` is a bare `SimpleStyle` with no collection around it, so the
		// Layers pane used to spell the rule out again where it stood — and a second statement of
		// "solid is the property being absent" is where a `[0, 0]` eventually gets written.
		const dashed = withLineStyle({ stroke: '#112233' }, 'dashed');
		expect(dashed).toEqual({ stroke: '#112233', 'stroke-dasharray': [8, 4] });

		const solid = withLineStyle(dashed, 'solid');
		expect('stroke-dasharray' in solid).toBe(false);
		// Everything else the Layer carried survives the change, which is what makes this a *default*
		// style rather than a two-property one.
		expect(solid).toEqual({ stroke: '#112233' });
		// And an unchanged style is returned as it was, so nothing writes a file that says the same.
		expect(withLineStyle(solid, 'solid')).toBe(solid);
	});

	test('the three options round-trip through the tuple', () => {
		expect(lineStyleOf(dashArrayFor('solid'))).toBe('solid');
		expect(lineStyleOf(dashArrayFor('dashed'))).toBe('dashed');
		expect(lineStyleOf(dashArrayFor('dotted'))).toBe('dotted');
	});

	test('a tuple from another tool reads as dashed and is not rewritten', () => {
		expect(lineStyleOf([4, 2])).toBe('dashed');
		expect(lineStyleOf([])).toBe('solid');

		const original = `${JSON.stringify(
			{
				type: 'FeatureCollection',
				features: [
					{
						type: 'Feature',
						id: 'a1',
						properties: { 'stroke-dasharray': [4, 2, 1, 2] },
						geometry: null
					}
				]
			},
			null,
			'\t'
		)}\n`;

		expect(utf8(serialiseAnnotations(parseAnnotations(bytes(original))))).toBe(original);
	});

	test('dashes are converted into MapLibre’s line-width units', () => {
		// A stored [8, 4] is 8px on and 4px off at simplestyle's own default width of 2, and MapLibre
		// wants that as a multiple of the width. The two patterns stay distinguishable by their ratio,
		// which is what makes a dotted line read as dots rather than as short dashes.
		expect(mapLibreDashArray(DASHED_DASHARRAY)).toEqual([4, 2]);
		expect(mapLibreDashArray(DOTTED_DASHARRAY)).toEqual([0.5, 1.5]);
	});
});

describe('the controls write simplestyle property names exactly', () => {
	test('every name the style controls write is one simplestyle defines', () => {
		const styled = setStyle(collectionOf(pin('a1')), 'a1', {
			'marker-size': 'large',
			'marker-symbol': 'harbor',
			'marker-color': '#7e7e7e',
			stroke: '#aa3311',
			'stroke-opacity': 0.8,
			'stroke-width': 3,
			fill: '#223344',
			'fill-opacity': 0.5,
			'stroke-dasharray': DOTTED_DASHARRAY
		});

		const written = JSON.parse(utf8(serialiseAnnotations(styled)));

		expect(Object.keys(written.features[0].properties).sort()).toEqual(
			[
				'fill',
				'fill-opacity',
				'marker-color',
				'marker-size',
				'marker-symbol',
				'stroke',
				'stroke-dasharray',
				'stroke-opacity',
				'stroke-width'
			].sort()
		);
		expect(simpleStyleViolations(written.features[0].properties)).toEqual([]);
	});

	test('no camelCase name reaches the file', () => {
		// The failure this guards is a control written as `strokeWidth`, which would look right in the
		// app and make the file unreadable to every other tool — the whole portability claim.
		const styled = setStyle(collectionOf(pin('a1')), 'a1', {
			'stroke-width': 3,
			'fill-opacity': 0.5
		});

		const written = utf8(serialiseAnnotations(styled));

		for (const wrong of ['strokeWidth', 'fillOpacity', 'markerColor', 'strokeDasharray']) {
			expect(written).not.toContain(wrong);
		}
	});

	test('setting a property to undefined removes it, which is "back to the Layer default"', () => {
		const before = setStyle(collectionOf(pin('a1')), 'a1', { stroke: '#ff0000' });

		const after = setStyle(before, 'a1', { stroke: undefined });

		expect('stroke' in after.annotations[0]!.properties).toBe(false);
	});

	test('a title or description typed and then cleared leaves no empty string behind', () => {
		const typed = setText(collectionOf(pin('a1')), 'a1', { title: 'x', description: 'y' });

		const cleared = setText(typed, 'a1', { title: '', description: '' });

		expect(cleared.annotations[0]?.properties).toEqual({});
		expect(utf8(serialiseAnnotations(cleared))).not.toContain('"title"');
	});

	test('title and description persist through the file', () => {
		const written = setText(collectionOf(pin('a1')), 'a1', {
			title: 'Warehouses',
			description: 'The *west* quay, per [the survey](https://example.org/s).'
		});

		const read = parseAnnotations(serialiseAnnotations(written));

		expect(read.annotations[0]?.properties.title).toBe('Warehouses');
		expect(read.annotations[0]?.properties.description).toContain('[the survey]');
	});
});

describe('simplestyle conformance, as a checkable claim', () => {
	test('conforming properties report nothing', () => {
		const conforming: AnnotationProperties = {
			title: 'x',
			description: 'y',
			'marker-size': 'medium',
			'marker-symbol': '7',
			'marker-color': '#7e7e7e',
			stroke: '#555555',
			'stroke-opacity': 1,
			'stroke-width': 2,
			fill: '#555555',
			'fill-opacity': 0.6,
			'stroke-dasharray': [8, 4]
		};

		expect(simpleStyleViolations(conforming)).toEqual([]);
	});

	test.each([
		['a colour that is not #RRGGBB', { stroke: 'red' }, /stroke should be a #RRGGBB colour/],
		['a three-digit colour', { fill: '#abc' }, /fill should be a #RRGGBB colour/],
		['an opacity above one', { 'fill-opacity': 1.5 }, /fill-opacity should be a number/],
		['an opacity as a string', { 'stroke-opacity': '0.5' }, /stroke-opacity should be a number/],
		['a negative width', { 'stroke-width': -1 }, /stroke-width should be a number/],
		['a marker size that is not one of three', { 'marker-size': 'huge' }, /marker-size should be/],
		['a title that is not a string', { title: 7 }, /title should be a string/],
		[
			'stroke-dasharray as the keyword ADR-0009 forbids',
			{ 'stroke-dasharray': 'dashed' },
			/never a keyword/
		],
		['stroke-dasharray with the wrong arity', { 'stroke-dasharray': [8] }, /\[dash, gap\] tuple/]
	])('%s is reported', (_name, properties, expected) => {
		const problems = simpleStyleViolations(properties as AnnotationProperties);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(expected);
	});

	test('the three marker sizes are the spec’s three', () => {
		expect(MARKER_SIZES).toEqual(['small', 'medium', 'large']);
	});
});

describe('the render copy', () => {
	test('resolves each Annotation’s own style, so precedence reaches the renderer', () => {
		const collection = setStyle(collectionOf(pin('a1'), pin('a2')), 'a2', { stroke: '#ff0000' });

		const render = toRenderCollection(collection, { stroke: '#112233', 'stroke-width': 5 });

		expect(render.features[0]?.['properties']).toMatchObject({
			stroke: '#112233',
			'stroke-width': 5
		});
		expect(render.features[1]?.['properties']).toMatchObject({
			stroke: '#ff0000',
			'stroke-width': 5
		});
	});

	test('buckets each Annotation by line style, because line-dasharray is not data-driven', () => {
		const collection = setLineStyle(
			setLineStyle(collectionOf(pin('a1'), pin('a2'), pin('a3')), 'a2', 'dashed'),
			'a3',
			'dotted'
		);

		const render = toRenderCollection(collection, {});

		expect(
			render.features.map(
				(feature) => (feature['properties'] as Record<string, unknown>)[LINE_STYLE_PROPERTY]
			)
		) //
			.toEqual(['solid', 'dashed', 'dotted']);
	});

	test('carries the Annotation id, so a click on the map can be traced back', () => {
		const render = toRenderCollection(collectionOf(pin('a1')), {});

		expect((render.features[0]?.['properties'] as Record<string, unknown>)[ANNOTATION_ID_PROPERTY]) //
			.toBe('a1');
	});

	test('carries title and description unrendered, because rendering happens at the popup', () => {
		const collection = setText(collectionOf(pin('a1')), 'a1', {
			title: 'x',
			description: '*not HTML yet*'
		});

		const properties = toRenderCollection(collection, {}).features[0]?.['properties'] as Record<
			string,
			unknown
		>;

		expect(properties['description']).toBe('*not HTML yet*');
		expect(properties['description']).not.toContain('<em>');
	});

	test('a geometry this build cannot draw is absent from the render copy but still in the document', () => {
		const collection = parseAnnotations(
			bytes(
				JSON.stringify({
					type: 'FeatureCollection',
					features: [
						{
							type: 'Feature',
							id: 'a1',
							properties: {},
							geometry: { type: 'MultiPoint', coordinates: [] }
						},
						{ type: 'Feature', id: 'a2', properties: {}, geometry: null }
					]
				})
			)
		);

		expect(toRenderCollection(collection, {}).features).toEqual([]);
		expect(collection.annotations).toHaveLength(2);
	});

	test('the render copy’s private property names never reach a written file', () => {
		const written = utf8(serialiseAnnotations(collectionOf(pin('a1'))));

		expect(written).not.toContain(LINE_STYLE_PROPERTY);
		expect(written).not.toContain(ANNOTATION_ID_PROPERTY);
		expect(written).not.toContain('ballastella:');
	});
});
