import { describe, expect, test } from 'vitest';

import type { Bytes } from '../store/project-store.js';
import { decode, encode } from '../test-support.js';
import {
	ANNOTATION_COLORS,
	DASHED_DASHARRAY,
	DEFAULT_ANNOTATION_COLOR,
	DOTTED_DASHARRAY,
	LABEL_MARKER_SYMBOL,
	MARKER_SIZES,
	SIMPLESTYLE_DEFAULTS,
	addAnnotation,
	annotationAnchor,
	annotationColorName,
	circleGeometry,
	circleRadiusMeters,
	dashArrayFor,
	emptyCollection,
	findAnnotation,
	isLabel,
	isLabelFeature,
	lineStyleOf,
	newAnnotation,
	moveAnnotation,
	removeAnnotation,
	resolveStyle,
	setGeometry,
	setLineStyle,
	setStyle,
	setText,
	styleForNewAnnotation,
	styleForNewLabel,
	simpleStyleViolations,
	type Annotation,
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

const pairs = (...flat: number[]): [number, number][] =>
	Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i]!, flat[2 * i + 1]!]);

const pin = (id: string, lng = 4.9, lat = 52.37) =>
	newAnnotation({ id, geometry: { type: 'Point', coordinates: [lng, lat] } });

const zuiderzee = newAnnotation({
	id: 'a1',
	geometry: { type: 'Point', coordinates: [4.9, 52.37] },
	title: 'Zuiderzee',
	style: {
		'marker-symbol': LABEL_MARKER_SYMBOL,
		'marker-color': '#ffffff',
		fill: '#1976d2',
		'fill-opacity': 0.8,
		'marker-size': 'large'
	}
});

const collectionOf = (...annotations: Annotation[]): AnnotationCollection =>
	annotations.reduce(addAnnotation, emptyCollection());

const at = (id: string, properties: Record<string, unknown>) => ({
	id,
	geometry: { type: 'Point' as const, coordinates: [0, 0] as [number, number] },
	properties
});

const withGeometry = (geometry: unknown, properties: object = {}): Annotation =>
	({ id: 'a1', geometry, properties }) as Annotation;

const pointWith = (properties: object): Annotation =>
	withGeometry({ type: 'Point', coordinates: [4.9, 52.37] }, properties);

const feature = (id: string, properties: object = {}, geometry: unknown = null) => ({
	type: 'Feature',
	id,
	properties,
	geometry
});

const written = (collection: AnnotationCollection): string =>
	decode(serialiseAnnotations(collection));

const writtenJson = (collection: AnnotationCollection) => JSON.parse(written(collection));

const featuresFile = (...features: unknown[]): Bytes =>
	encode(JSON.stringify({ type: 'FeatureCollection', features }));

const tabbed = (document: unknown): string => `${JSON.stringify(document, null, '\t')}\n`;
const tabbedFile = (...features: unknown[]) => tabbed({ type: 'FeatureCollection', features });
const rewritten = (original: string): string => written(parseAnnotations(encode(original)));

const renderProperties = (collection: AnnotationCollection) =>
	toRenderCollection(collection).features.map(
		(feature) => feature['properties'] as Record<string, unknown>
	);

const idsOf = (collection: AnnotationCollection) =>
	collection.annotations.map((annotation) => annotation.id);

describe('drawing', () => {
	test('a point, a line, and a polygon all round-trip through a GeoJSON FeatureCollection', () => {
		const drawn = setText(
			collectionOf(
				pin('a1'),
				newAnnotation({
					id: 'a2',
					geometry: { type: 'LineString', coordinates: pairs(4.9, 52.37, 5.1, 52.4) }
				}),
				newAnnotation({
					id: 'a3',
					geometry: {
						type: 'Polygon',
						coordinates: [pairs(4.9, 52.3, 5, 52.3, 5, 52.4, 4.9, 52.3)]
					}
				})
			),
			'a1',
			{
				title: 'Warehouses',
				description: 'The *west* quay, per [the survey](https://example.org/s).'
			}
		);

		const file = writtenJson(drawn);
		expect(file.type).toBe('FeatureCollection');
		expect(file.features[0]).toMatchObject({
			type: 'Feature',
			id: 'a1',
			geometry: { type: 'Point', coordinates: [4.9, 52.37] }
		});
		const read = parseAnnotations(serialiseAnnotations(drawn));
		expect(read.annotations.map((annotation) => annotation.geometry?.type)).toEqual([
			'Point',
			'LineString',
			'Polygon'
		]);
		expect(read).toEqual(drawn);
	});

	test('a Circle round-trips as a portable polygon with semantic center and radius', () => {
		const center: [number, number] = [4.9, 52.37];
		const geometry = circleGeometry(center, 1_000);
		const encoded = serialiseAnnotations({
			annotations: [newAnnotation({ id: 'circle', geometry })]
		});

		const file = JSON.parse(decode(encoded));
		expect(file.features[0].geometry.type).toBe('Polygon');
		expect(file.features[0].geometry.coordinates[0]).toHaveLength(65);
		expect(file.features[0]['ballastella:circle']).toEqual({ center, radiusMeters: 1_000 });
		const read = parseAnnotations(encoded);
		expect(read.annotations[0]?.geometry).toEqual(geometry);
		expect(written(read)).toBe(decode(encoded));
	});

	test('every point of a generated Circle is the stored radius from its center', () => {
		const geometry = circleGeometry([4.9, 52.37], 2_500);
		for (const point of geometry.coordinates[0]!.slice(0, -1)) {
			expect(circleRadiusMeters(geometry.center, point)).toBeCloseTo(geometry.radiusMeters, 5);
		}
	});

	test('a new Annotation carries no style properties at all', () => {
		const drawn = pin('a1');
		expect(drawn.properties).toEqual({});
		expect(written(collectionOf(drawn))).toContain('"properties": {}');
		expect(written(collectionOf(drawn))).not.toContain('stroke');
	});

	test('reshaping replaces the geometry and nothing else', () => {
		const before = setText(collectionOf(pin('a1')), 'a1', { title: 'The quay' });
		const after = setGeometry(before, 'a1', { type: 'Point', coordinates: [5, 52.4] });
		expect(after.annotations[0]?.geometry).toEqual({ type: 'Point', coordinates: [5, 52.4] });
		expect(after.annotations[0]?.properties).toEqual({ title: 'The quay' });
	});

	test('deleting an Annotation removes it from the file', () => {
		const after = removeAnnotation(collectionOf(pin('a1'), pin('a2'), pin('a3')), 'a2');
		expect(idsOf(after)).toEqual(['a1', 'a3']);
		expect(written(after)).not.toContain('a2');
		expect(findAnnotation(after, 'a2')).toBeUndefined();
	});

	test('deleting an Annotation that is not there is the same collection, so nothing is written', () => {
		const before = collectionOf(pin('a1'));
		expect(removeAnnotation(before, 'nobody')).toBe(before);
		expect(setText(before, 'nobody', { title: 'x' })).toBe(before);
		expect(setStyle(before, 'nobody', { stroke: '#000000' })).toBe(before);
	});
});

describe('reordering the Annotations in one Layer', () => {
	const before = collectionOf(pin('a1'), pin('a2'), pin('a3'));
	const two = collectionOf(pin('a1'), pin('a2'));

	test.each([
		['a3', 0, ['a3', 'a1', 'a2']],
		['a1', 2, ['a2', 'a3', 'a1']],
		['a2', 0, ['a2', 'a1', 'a3']],
		['a2', -1, ['a2', 'a1', 'a3']],
		['a2', 99, ['a1', 'a3', 'a2']]
	])('%s dropped at %i, clamped to the collection, gives %j', (id, to, expected) => {
		expect(idsOf(moveAnnotation(before, id, to))).toEqual(expected);
	});

	test('a move that changes nothing is the same collection, so nothing is written', () => {
		expect(moveAnnotation(two, 'a1', 0)).toBe(two);
		expect(moveAnnotation(two, 'a2', 5)).toBe(two);
		expect(moveAnnotation(two, 'nobody', 0)).toBe(two);
	});

	test('the Annotations that moved are the same objects, so no property is rewritten', () => {
		const after = moveAnnotation(two, 'a2', 0);
		expect(after.annotations[0]).toBe(two.annotations[1]);
		expect(after.annotations[1]).toBe(two.annotations[0]);
	});
});

describe('an unchanged file serialises byte-identically', () => {
	test.each([
		[
			'a file this app wrote',
			setStyle(
				setText(collectionOf(pin('a1'), pin('a2')), 'a1', {
					title: 'Warehouses',
					description: 'The *west* quay, per [the survey](https://example.org/s).'
				}),
				'a2',
				{ stroke: '#aa3311', 'stroke-dasharray': DASHED_DASHARRAY }
			)
		],
		['a Layer containing a Label', collectionOf(zuiderzee)]
	])('%s parses and writes back to the identical bytes', (_name, collection) => {
		const original = serialiseAnnotations(collection);
		expect([...serialiseAnnotations(parseAnnotations(original))]).toEqual([...original]);
	});

	test('an empty Layer written at creation round-trips identically', () => {
		const asCreated = tabbedFile();
		expect(rewritten(asCreated)).toBe(asCreated);
		expect(written(emptyCollection())).toBe(asCreated);
	});

	test('tab indented with a trailing newline, like project.json and the Alignment', () => {
		const file = written(collectionOf(pin('a1')));
		expect(file.endsWith('\n')).toBe(true);
		expect(file).toContain('\n\t"type": "FeatureCollection"');
	});

	test.each([
		[
			'an unknown collection field and an unknown Annotation field both survive',
			tabbed({
				type: 'FeatureCollection',
				features: [
					{
						...feature(
							'a1',
							{ title: 'x', 'stroke-linecap': 'round' },
							{ type: 'Point', coordinates: [1, 2] }
						),
						bbox: [1, 2, 1, 2]
					}
				],
				name: 'trade routes'
			})
		],
		[
			'a tuple from another tool is not rewritten',
			tabbedFile(feature('a1', { 'stroke-dasharray': [4, 2, 1, 2] }))
		]
	])('%s', (_name, original) => {
		expect(rewritten(original)).toBe(original);
	});

	test('a geometry kind this build cannot draw is written back unchanged', () => {
		const original = tabbedFile(
			feature('a1', {}, { type: 'MultiPolygon', coordinates: [[pairs(1, 2, 3, 4, 1, 2)]] })
		);

		const read = parseAnnotations(encode(original));

		expect(read.annotations[0]?.geometry).toMatchObject({
			type: 'foreign',
			declaredType: 'MultiPolygon'
		});
		expect(written(read)).toBe(original);
	});
});

describe('reading somebody else’s document', () => {
	const point = { type: 'Point', coordinates: [4.9, 52.37] };

	test('a Point with marker-symbol label and a title opens as a Label', () => {
		const read = parseAnnotations(
			featuresFile(feature('a1', { 'marker-symbol': 'label', title: 'Zuiderzee' }, point))
		);

		expect(isLabel(read.annotations[0]!)).toBe(true);
	});

	test('an unrecognised marker-symbol stays on its Pin after another Annotation changes', () => {
		const read = parseAnnotations(
			featuresFile(
				feature('harbor', { 'marker-symbol': 'harbor' }, point),
				feature('other', {}, point)
			)
		);

		const harbor = findAnnotation(
			parseAnnotations(
				serialiseAnnotations(setText(read, 'other', { title: 'An unrelated edit' }))
			),
			'harbor'
		)!;

		expect(isLabel(harbor)).toBe(false);
		expect(harbor.properties['marker-symbol']).toBe('harbor');
	});

	test('bytes that are not JSON are surfaced, never replaced with an empty collection', () => {
		expect(() => parseAnnotations(encode('{not json'), { path: 'annotations/x.geojson' })).toThrow(
			AnnotationsUnreadableError
		);
		expect(() => parseAnnotations(encode('[]'))).toThrow(/not a JSON object/);
	});

	test('an id-less Feature is given one, and an integer id becomes its string', () => {
		const read = parseAnnotations(
			featuresFile(
				{ type: 'Feature', properties: {}, geometry: null },
				{ type: 'Feature', id: 17, properties: {}, geometry: null }
			),
			{ mintId: () => 'a1' }
		);

		expect(idsOf(read)).toEqual(['a1', '17']);
	});

	test('a null geometry is kept, which RFC 7946 permits and geojson.io writes', () => {
		const read = parseAnnotations(featuresFile(feature('a1', { title: 'x' })));

		expect(read.annotations[0]?.geometry).toBeNull();
		expect(read.annotations[0]?.properties).toEqual({ title: 'x' });
	});

	test('an element that is not an object is dropped, having nothing in it to keep', () => {
		expect(parseAnnotations(featuresFile(null, 7, 'x')).annotations).toEqual([]);
	});

	test('a Point whose coordinates are not two numbers is foreign rather than repaired', () => {
		const read = parseAnnotations(
			featuresFile(feature('a1', {}, { type: 'Point', coordinates: ['a', 'b'] }))
		);

		expect(read.annotations[0]?.geometry).toMatchObject({ type: 'foreign' });
	});
});

describe('style resolution: properties → simplestyle (ADR-0009, as amended)', () => {
	test('an Annotation with no properties of its own draws with simplestyle’s defaults', () => {
		expect(resolveStyle({})).toMatchObject(SIMPLESTYLE_DEFAULTS);
		expect(resolveStyle(undefined)).toMatchObject(SIMPLESTYLE_DEFAULTS);
	});

	test('a feature property is what it draws with, and the rest stay at the spec’s own', () => {
		const resolved = resolveStyle({ stroke: '#ff0000' });
		expect(resolved.stroke).toBe('#ff0000');
		expect(resolved['stroke-width']).toBe(SIMPLESTYLE_DEFAULTS['stroke-width']);
		expect(resolved.fill).toBe(SIMPLESTYLE_DEFAULTS.fill);
	});

	test('a zero opacity is honoured rather than falling through as falsy', () => {
		expect(resolveStyle({ 'fill-opacity': 0 })['fill-opacity']).toBe(0);
		expect(resolveStyle({ 'stroke-width': 0 })['stroke-width']).toBe(0);
	});
});

describe('a new Annotation is drawn with the last one’s style (ADR-0009, as amended)', () => {
	test('the first Annotation in an empty Layer starts on the palette’s grey, and only colours', () => {
		const grey = {
			'marker-color': DEFAULT_ANNOTATION_COLOR,
			stroke: DEFAULT_ANNOTATION_COLOR,
			fill: DEFAULT_ANNOTATION_COLOR
		};
		expect(styleForNewAnnotation({ annotations: [] })).toEqual(grey);
		expect(styleForNewAnnotation(null)).toEqual(grey);
	});

	test('the next one takes the last one’s colour, size, opacity and dash, across kinds, and nothing else', () => {
		const style = {
			'marker-size': 'large',
			'marker-color': '#d32f2f',
			stroke: '#d32f2f',
			'stroke-opacity': 0.5,
			'stroke-width': 3,
			fill: '#1976d2',
			'fill-opacity': 0.25,
			'stroke-dasharray': [8, 4]
		};
		const collection = {
			annotations: [
				at('a', { stroke: '#111111' }),
				at('b', {
					'marker-symbol': LABEL_MARKER_SYMBOL,
					...style,
					title: 'The old mill',
					description: 'Built 1780.',
					unknownProperties: { source: 'a survey' }
				})
			]
		};

		expect(styleForNewAnnotation(collection)).toEqual(style);
		expect(
			styleForNewAnnotation({ annotations: [at('a', { 'marker-symbol': 'harbor' })] })
		).not.toHaveProperty('marker-symbol');
	});

	test('an Annotation made with it carries the style as its own properties', () => {
		const annotation = newAnnotation({
			id: 'n1',
			geometry: { type: 'Point', coordinates: [4.9, 52.37] },
			style: { stroke: '#ff0000' },
			title: 'Fort'
		});

		expect(annotation.properties).toEqual({ stroke: '#ff0000', title: 'Fort' });
		expect(resolveStyle(annotation.properties).stroke).toBe('#ff0000');
	});
});

describe('styleForNewLabel: the first Label in a Layer is not grey on grey', () => {
	test('writes the discriminator and replaces the untouched default with a legible, conformant pair', () => {
		for (const style of [styleForNewLabel(null), styleForNewLabel({ annotations: [] })]) {
			expect(style['marker-symbol']).toBe(LABEL_MARKER_SYMBOL);
			expect(isLabel(pointWith(style))).toBe(true);
			expect(style['marker-color']).toBe('#000000');
			expect(style.fill).toBe('#ffffff');
			expect(annotationColorName(style['marker-color']!)).toBe('Black');
			expect(annotationColorName(style.fill!)).toBe('White');
			expect(simpleStyleViolations(style)).toEqual([]);
		}
	});

	test('a colour a scholar chose twice on purpose is kept, whatever it is', () => {
		expect(
			styleForNewLabel({
				annotations: [at('a', { 'marker-color': '#1976d2', fill: '#1976d2' })]
			})
		).toEqual({ 'marker-color': '#1976d2', fill: '#1976d2', 'marker-symbol': LABEL_MARKER_SYMBOL });

		expect(
			styleForNewLabel({
				annotations: [at('a', { 'marker-color': '#ffffff', fill: '#555555', 'fill-opacity': 0 })]
			})['marker-color']
		).toBe('#ffffff');
	});

	test.each([
		['a null text colour', { 'marker-color': null, fill: DEFAULT_ANNOTATION_COLOR }],
		['a numeric background', { 'marker-color': DEFAULT_ANNOTATION_COLOR, fill: 4 }],
		['a boolean background', { fill: true }],
		['an array background', { fill: ['#fff'] }],
		['a numeric text colour', { 'marker-color': 5, fill: '#fff' }],
		['a 3-digit hex from geojson.io', { fill: '#fff' }],
		[
			'colours inherited from a Label',
			{
				'marker-symbol': LABEL_MARKER_SYMBOL,
				'marker-color': '#ffffff',
				fill: '#1976d2',
				'marker-size': 'large'
			}
		]
	])('inherits %s exactly as they are, without throwing', (_name, properties) => {
		const style = styleForNewLabel({ annotations: [at('a', properties)] });
		expect(style).toEqual({ ...properties, 'marker-symbol': LABEL_MARKER_SYMBOL });
	});
});

describe('where a popup points', () => {
	test.each([
		['a Point is its own coordinate', { type: 'Point', coordinates: [4.9, 52.37] }, [4.9, 52.37]],
		[
			'a line is the middle of it, not either end',
			{ type: 'LineString', coordinates: pairs(4, 52, 6, 52, 6, 54) },
			[5, 53]
		],
		[
			'a shape is the middle of its outer ring',
			{ type: 'Polygon', coordinates: [pairs(4, 52, 6, 52, 6, 54, 4, 54, 4, 52)] },
			[5, 53]
		],
		['a Circle is its semantic center', circleGeometry([4.9, 52.37], 1_000), [4.9, 52.37]]
	])('%s', (_name, geometry, [lng, lat]) => {
		expect(annotationAnchor(withGeometry(geometry))).toEqual({ lng, lat });
	});

	test('a geometry this build cannot draw has none, so the caller falls back to the click', () => {
		expect(
			annotationAnchor(
				withGeometry({ type: 'foreign', declaredType: 'GeometryCollection', raw: {} })
			)
		).toBeNull();
		expect(annotationAnchor(withGeometry(null))).toBeNull();
	});
});

describe('solid, dashed, and dotted', () => {
	test('solid is the absence of stroke-dasharray, not a tuple that looks continuous', () => {
		expect(dashArrayFor('solid')).toBeUndefined();
		const file = writtenJson(setLineStyle(collectionOf(pin('a1')), 'a1', 'solid'));
		expect('stroke-dasharray' in file.features[0].properties).toBe(false);
	});

	test('dashed and dotted store tuples, never a keyword', () => {
		const dashed = setLineStyle(collectionOf(pin('a1')), 'a1', 'dashed');
		const dotted = setLineStyle(collectionOf(pin('a1')), 'a1', 'dotted');
		expect(dashed.annotations[0]?.properties['stroke-dasharray']).toEqual([8, 4]);
		expect(dotted.annotations[0]?.properties['stroke-dasharray']).toEqual([1, 3]);
		expect(written(dashed)).toContain('"stroke-dasharray"');
		for (const keyword of ['"dashed"', '"dotted"', '"solid"']) {
			expect(written(dashed)).not.toContain(keyword);
			expect(written(dotted)).not.toContain(keyword);
		}
	});

	test('choosing solid after dashed removes the property rather than blanking it', () => {
		const back = setLineStyle(setLineStyle(collectionOf(pin('a1')), 'a1', 'dashed'), 'a1', 'solid');
		expect('stroke-dasharray' in back.annotations[0]!.properties).toBe(false);
	});

	test('choosing the line style an Annotation already has is the same collection', () => {
		const solid = setStyle(collectionOf(pin('a1')), 'a1', { stroke: '#112233' });
		expect(setLineStyle(solid, 'a1', 'solid')).toBe(solid);
	});

	test.each(['solid', 'dashed', 'dotted'] as const)('%s round-trips through the tuple', (style) => {
		expect(lineStyleOf(dashArrayFor(style))).toBe(style);
	});

	test('a tuple from another tool reads as dashed, and an empty one as solid', () => {
		expect(lineStyleOf([4, 2])).toBe('dashed');
		expect(lineStyleOf([])).toBe('solid');
	});

	test('dashes are converted into MapLibre’s line-width units', () => {
		expect(mapLibreDashArray(DASHED_DASHARRAY)).toEqual([4, 2]);
		expect(mapLibreDashArray(DOTTED_DASHARRAY)).toEqual([0.5, 1.5]);
	});
});

describe('the controls write simplestyle property names exactly', () => {
	test('every name the style controls write is one simplestyle defines', () => {
		const style = {
			'marker-size': 'large',
			'marker-symbol': 'harbor',
			'marker-color': '#7e7e7e',
			stroke: '#aa3311',
			'stroke-opacity': 0.8,
			'stroke-width': 3,
			fill: '#223344',
			'fill-opacity': 0.5,
			'stroke-dasharray': DOTTED_DASHARRAY
		};

		const { properties } = writtenJson(setStyle(collectionOf(pin('a1')), 'a1', style)).features[0];

		expect(Object.keys(properties).sort()).toEqual(Object.keys(style).sort());
		expect(simpleStyleViolations(properties)).toEqual([]);
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
		expect(written(cleared)).not.toContain('"title"');
	});
});

describe('simplestyle conformance, as a checkable claim', () => {
	test('conforming properties report nothing, and the marker sizes are the spec’s three', () => {
		expect(
			simpleStyleViolations({
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
			})
		).toEqual([]);
		expect(MARKER_SIZES).toEqual(['small', 'medium', 'large']);
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
});

describe('the render copy', () => {
	test('resolves each style, buckets by line style, and carries the id and the unrendered description', () => {
		const collection = setText(
			setLineStyle(
				setLineStyle(
					setStyle(collectionOf(pin('a1'), pin('a2'), pin('a3')), 'a2', { stroke: '#ff0000' }),
					'a2',
					'dashed'
				),
				'a3',
				'dotted'
			),
			'a1',
			{ title: 'x', description: '*not HTML yet*' }
		);
		const [first, second, third] = renderProperties(collection);
		const width = SIMPLESTYLE_DEFAULTS['stroke-width'];

		expect(first).toMatchObject({
			stroke: SIMPLESTYLE_DEFAULTS.stroke,
			'stroke-width': width,
			[ANNOTATION_ID_PROPERTY]: 'a1',
			description: '*not HTML yet*',
			[LINE_STYLE_PROPERTY]: 'solid'
		});
		expect(second).toMatchObject({
			stroke: '#ff0000',
			'stroke-width': width,
			[LINE_STYLE_PROPERTY]: 'dashed'
		});
		expect(third).toMatchObject({ [LINE_STYLE_PROPERTY]: 'dotted' });
		expect(written(collection)).not.toContain('ballastella:');
	});

	test('a geometry this build cannot draw is absent from the render copy but still in the document', () => {
		const collection = parseAnnotations(
			featuresFile(feature('a1', {}, { type: 'MultiPoint', coordinates: [] }), feature('a2'))
		);

		expect(toRenderCollection(collection).features).toEqual([]);
		expect(collection.annotations).toHaveLength(2);
	});
});

describe('the nine colours an Annotation can be', () => {
	test('nine distinct, uniquely named lowercase #rrggbb values, black, grey and white among them', () => {
		const values = ANNOTATION_COLORS.map((colour) => colour.value);
		const names = ANNOTATION_COLORS.map((colour) => colour.name);
		expect(ANNOTATION_COLORS).toHaveLength(9);
		expect(names).toEqual(expect.arrayContaining(['Black', 'Grey', 'White']));
		expect(new Set(values).size).toBe(values.length);
		expect(new Set(names).size).toBe(names.length);
		for (const value of values) {
			expect(value).toBe(value.toLowerCase());
			expect(simpleStyleViolations({ stroke: value, fill: value, 'marker-color': value })).toEqual(
				[]
			);
		}
	});

	test('the grey a new Annotation starts on is in the palette, and is simplestyle’s own', () => {
		expect(annotationColorName(DEFAULT_ANNOTATION_COLOR)).toBe('Grey');
		expect(DEFAULT_ANNOTATION_COLOR).toBe(SIMPLESTYLE_DEFAULTS.stroke);
		expect(DEFAULT_ANNOTATION_COLOR).toBe(SIMPLESTYLE_DEFAULTS.fill);
	});

	test('a colour is named case-insensitively, and one from outside the palette is not named at all', () => {
		expect(annotationColorName('#D32F2F')).toBe('Red');
		expect(annotationColorName('#d32f2f')).toBe('Red');
		expect(annotationColorName('#aa3311')).toBeNull();
		expect(annotationColorName(SIMPLESTYLE_DEFAULTS['marker-color'])).toBeNull();
	});
});

describe('a Point whose marker-symbol is label', () => {
	const withSymbol = (symbol?: string): Annotation =>
		pointWith(symbol === undefined ? {} : { 'marker-symbol': symbol });

	test('is a label, and nothing else is, whether read from an Annotation or a bare properties bag', () => {
		expect(isLabel(withSymbol(LABEL_MARKER_SYMBOL))).toBe(true);
		expect(isLabel(withSymbol())).toBe(false);
		expect(isLabel(withSymbol('harbor'))).toBe(false);
		expect(isLabel(withSymbol('Label'))).toBe(false);
		expect(isLabelFeature({ 'marker-symbol': LABEL_MARKER_SYMBOL })).toBe(true);
		expect(isLabelFeature({ 'marker-symbol': 'harbor' })).toBe(false);
		expect(isLabelFeature({})).toBe(false);
		expect(isLabelFeature(undefined)).toBe(false);
	});

	test.each([
		{ type: 'LineString', coordinates: pairs(4.8, 52.3, 5, 52.4) },
		{ type: 'Polygon', coordinates: [[]] },
		{ type: 'foreign', raw: {} },
		null
	])('is a label only as a Point, not as %j', (geometry) => {
		expect(isLabel(withGeometry(geometry, { 'marker-symbol': LABEL_MARKER_SYMBOL }))).toBe(false);
	});

	test('adds no extension to the file: a Label serialises with only simplestyle properties', () => {
		const properties = writtenJson(collectionOf(zuiderzee)).features[0]
			.properties as AnnotationProperties;
		// simplestyle 1.1.0's names; ADR-0009's `stroke-dasharray` is not among them.
		const simplestyleNames = [
			...['title', 'description', 'marker-size', 'marker-symbol', 'marker-color', 'stroke'],
			...['stroke-opacity', 'stroke-width', 'fill', 'fill-opacity']
		];

		expect(simpleStyleViolations(properties)).toEqual([]);
		expect(Object.keys(properties).filter((name) => !simplestyleNames.includes(name))).toEqual([]);
	});

	test('reaches the render copy with its symbol, and a foreign symbol stays for the Pin filter', () => {
		const [label, pinned, harbor] = renderProperties({
			annotations: [withSymbol(LABEL_MARKER_SYMBOL), withSymbol(), withSymbol('harbor')]
		});

		expect(label).toMatchObject({ 'marker-symbol': LABEL_MARKER_SYMBOL });
		expect(pinned).not.toHaveProperty('marker-symbol');
		expect(harbor?.['marker-symbol']).toBe('harbor');
		expect(isLabelFeature(harbor)).toBe(false);
	});
});
