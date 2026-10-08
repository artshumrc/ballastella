import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseAnnotation, validateAnnotation } from '@allmaps/annotation';
import {
	transformationTypeToTypeAndOrder,
	typeAndOrderToTransformationType
} from '@allmaps/transform';

import {
	ROUND_TRIP_TOLERANCE_PX,
	createSyntheticProjection
} from '../image-pane/synthetic-projection.js';
import { decode as text, encode } from '../test-support.js';
import { imageServiceId } from '../tiler/pyramid.js';
import {
	TRANSFORMATION_CHOICES,
	collectControlPoints,
	insertMaskVertexAfter,
	moveMaskVertex,
	newAlignment,
	type Alignment,
	type DraftControlPoint
} from './alignment.js';
import {
	AlignmentUnreadableError,
	AlignmentUnpreservableError,
	AlignmentUnwritableError,
	parseAlignment,
	serialiseAlignment
} from './georeference-annotation.js';

const fixture = (name: string): Uint8Array =>
	readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)));

const fixtureJson = (name: string) => JSON.parse(text(fixture(name)));

const parsedFixture = (name: string, imageId = name): Alignment =>
	parseAlignment(fixture(name), { imageId });

const parsedDocument = (document: unknown, imageId = 'floride-1657'): Alignment =>
	parseAlignment(encode(JSON.stringify(document)), { imageId });

const SHEET = { width: 1200, height: 851 };
const writtenJson = (alignment: Alignment) => JSON.parse(text(serialiseAlignment(alignment)));

const afterPasses = (alignment: Alignment, imageId: string, passes = 5): Alignment => {
	for (let pass = 0; pass < passes; pass += 1) {
		alignment = parseAlignment(serialiseAlignment(alignment), { imageId });
	}
	return alignment;
};

const threePairs = collectControlPoints([
	{ id: 'a', resource: { x: 10, y: 20 }, geo: { lng: 4.1, lat: 52.1 } },
	{ id: 'b', resource: { x: 30, y: 40 }, geo: { lng: 4.2, lat: 52.2 } },
	{ id: 'c', resource: { x: 50, y: 60 }, geo: { lng: 4.3, lat: 52.3 } }
]);

const withThreePairs = (): Alignment => ({
	...newAlignment('floride-1657', SHEET),
	controlPoints: threePairs
});

const FIXTURES = [
	{ name: 'floride-1657', points: 6, vertices: 4, byteIdentical: true },
	{ name: 'awkward-coordinates', points: 5, vertices: 6, byteIdentical: true },
	{ name: 'allmaps-shaped', points: 4, vertices: 4 },
	{ name: 'third-party-with-unknown-fields', imageId: 'floride-1657', points: 6, vertices: 4 }
].map((row) => ({ imageId: row.name, byteIdentical: false, ...row }));

describe('the committed fixture Alignments round-trip', () => {
	it.each(FIXTURES)(
		'$name parses into the Control Points and Resource Mask the document carries',
		({ name, imageId, points, vertices }) => {
			const alignment = parsedFixture(name, imageId);
			expect(alignment.controlPoints).toHaveLength(points);
			expect(alignment.resourceMask).toHaveLength(vertices);
			expect(alignment.imageId).toBe(imageId);
			expect(alignment.controlPoints.map((point) => point.ordinal)).toEqual(
				Array.from({ length: points }, (_, index) => index + 1)
			);
		}
	);

	it.each(FIXTURES)(
		'$name survives one and five round-trips identically, as a valid Georeference Annotation',
		({ name, imageId, byteIdentical }) => {
			const original = parsedFixture(name, imageId);
			expect(afterPasses(original, imageId, 1)).toStrictEqual(original);
			expect(afterPasses(original, imageId)).toStrictEqual(original);
			const written = writtenJson(original);
			expect(() => validateAnnotation(written)).not.toThrow();
			expect(parseAnnotation(written)).toHaveLength(1);
			if (byteIdentical) expect(text(serialiseAlignment(original))).toBe(text(fixture(name)));
		}
	);
});

describe('persistence spends none of the coordinate pipeline’s precision headroom', () => {
	it.each([
		{
			label: 'a small pyramid',
			tileWidth: 256,
			maxScaleFactor: 4,
			width: 700,
			height: 500,
			worstAtMost: 1e-9
		},
		{
			label: 'the largest window',
			tileWidth: 256,
			maxScaleFactor: 256,
			width: 60000,
			height: 24000,
			worstAtMost: 5e-8
		}
	])('round-trips a stored Control Point through $label within tolerance', (pyramid) => {
		const projection = createSyntheticProjection({
			width: pyramid.width,
			height: pyramid.height,
			tileWidth: pyramid.tileWidth,
			tileHeight: pyramid.tileWidth,
			maxScaleFactor: pyramid.maxScaleFactor
		});

		const steps = 37;
		const samples: DraftControlPoint[] = Array.from({ length: steps }, (_, index) => {
			const fraction = (index + 1 / 3) / (steps + 0.5);
			return {
				id: `s${index}`,
				resource: { x: fraction * pyramid.width, y: (1 - fraction) * pyramid.height },
				geo: { lng: -87.216 + fraction * 7.025, lat: 30.401 - fraction * 5.358 }
			};
		});

		const stored = parseAlignment(
			serialiseAlignment({
				...newAlignment('measurement', { width: pyramid.width, height: pyramid.height }),
				controlPoints: collectControlPoints(samples)
			}),
			{ imageId: 'measurement' }
		);

		let worst = 0;
		stored.controlPoints.forEach((point, index) => {
			const original = samples[index]?.resource;
			if (!original) throw new Error('a sample went missing');
			const returned = projection.syntheticToResource(
				projection.resourceToSynthetic(point.resource)
			);
			worst = Math.max(worst, Math.abs(returned.x - original.x), Math.abs(returned.y - original.y));
		});

		expect(worst).toBeGreaterThan(0);
		expect(worst).toBeLessThan(pyramid.worstAtMost);
		expect(worst).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
	});
});

describe('the Resource Mask’s SVG round-trip, which is the one lossy-looking path', () => {
	it('writes a vertex below 1e-6 in plain decimal, and recovers it exactly', () => {
		const alignment = parsedFixture('awkward-coordinates');
		expect(alignment.resourceMask[0]).toStrictEqual({ x: 1.5e-7, y: 2.5e-7 });
		const written = text(serialiseAlignment(alignment));
		expect(written).toContain('0.00000015,0.00000025');
		expect(written).not.toMatch(/points="[^"]*e-/);
	});

	it('survives an edited vertex below 1e-6, dragged there and inserted there', () => {
		const dragged = moveMaskVertex(newAlignment('sheet', SHEET), 0, {
			x: 1.5e-7,
			y: 2.5e-7
		});

		const written = text(serialiseAlignment(dragged));
		expect(written).toContain('0.00000015,0.00000025');
		expect(written).not.toMatch(/points="[^"]*e-/);
		const back = parseAlignment(serialiseAlignment(dragged), { imageId: 'sheet' });
		expect(back.resourceMask[0]).toStrictEqual({ x: 1.5e-7, y: 2.5e-7 });
		expect(back.resourceMask).toStrictEqual(dragged.resourceMask);
		expect(back.controlPoints).toStrictEqual(dragged.controlPoints);
		const inserted = insertMaskVertexAfter(moveMaskVertex(dragged, 1, { x: 3.5e-7, y: 4.5e-7 }), 0);
		expect(inserted.resourceMask[1]).toStrictEqual({ x: 2.5e-7, y: 3.5e-7 });
		const reread = parseAlignment(serialiseAlignment(inserted), { imageId: 'sheet' });
		expect(reread.resourceMask).toStrictEqual(inserted.resourceMask);
		expect(text(serialiseAlignment(reread))).toBe(text(serialiseAlignment(inserted)));
	});

	it('keeps an edited mask a valid Georeference Annotation', () => {
		let alignment = newAlignment('sheet', SHEET);
		alignment = insertMaskVertexAfter(alignment, 1);
		alignment = moveMaskVertex(alignment, 2, { x: 1199.999999, y: 425.0000001 });
		alignment = insertMaskVertexAfter(alignment, 3);
		alignment = moveMaskVertex(alignment, 4, { x: 600.5, y: 300.25 });
		const document = writtenJson(alignment);
		expect(() => validateAnnotation(document)).not.toThrow();
		expect(parseAnnotation(document)).toHaveLength(1);
		const back = parseAlignment(serialiseAlignment(alignment), { imageId: 'sheet' });
		expect(back.resourceMask).toStrictEqual(alignment.resourceMask);
		expect(back.resourceMask).toHaveLength(6);
	});

	it.each([
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
		['-Infinity', Number.NEGATIVE_INFINITY]
	])('is refused outright by upstream when a vertex is %s', (_label, bad) => {
		const alignment: Alignment = {
			...newAlignment('floride-1657', SHEET),
			resourceMask: [
				{ x: 0, y: 0 },
				{ x: bad, y: 10 },
				{ x: 10, y: 10 }
			]
		};

		expect(() => serialiseAlignment(alignment)).toThrow();
	});
});

describe('the transformation type in the file', () => {
	it('is written as polynomial with an explicit order, never straight, and read back as polynomial1', () => {
		expect(writtenJson(withThreePairs()).body.transformation).toStrictEqual({
			type: 'polynomial',
			options: { order: 1 }
		});
		expect(text(serialiseAlignment(withThreePairs()))).not.toContain('straight');
		expect(afterPasses(withThreePairs(), 'floride-1657', 1).transformationType).toBe('polynomial1');
	});

	it('is dropped outright by upstream when written as the literal string polynomial1', () => {
		const document = fixtureJson('floride-1657');
		document.body.transformation = { type: 'polynomial1' };

		expect(parseAnnotation(document)[0]?.transformation).toBeUndefined();
	});

	it.each([
		['when the document carries none', undefined],
		['rather than throwing on straight', { type: 'straight' }]
	])('falls back to the default %s', (_name, transformation) => {
		const document = fixtureJson('floride-1657');
		document.body.transformation = transformation;

		const alignment = parsedDocument(document);
		expect(alignment.transformationType).toBe('polynomial1');
		expect(alignment.controlPoints).toHaveLength(6);
	});
});

describe('every offered transformation type round-trips through @allmaps/annotation', () => {
	const base = (type: (typeof TRANSFORMATION_CHOICES)[number]['type']): Alignment => ({
		...newAlignment('floride-1657', SHEET),
		controlPoints: collectControlPoints(
			Array.from({ length: 10 }, (_, index) => ({
				id: `p${index}`,
				resource: { x: 40 + index * 90, y: 30 + index * 60 },
				geo: { lng: -87.2 + index * 0.7, lat: 30.4 - index * 0.5 }
			}))
		),
		transformationType: type
	});

	it.each(TRANSFORMATION_CHOICES.map((choice) => choice.type))(
		'%s survives as itself, idempotently over five passes, under no banned name',
		(type) => {
			const written = text(serialiseAlignment(base(type)));
			const document = JSON.parse(written);
			const back = parseAlignment(encode(written), { imageId: 'floride-1657' });
			expect(back.transformationType).toBe(type);
			expect(() => validateAnnotation(document)).not.toThrow();
			expect(parseAnnotation(document)).toHaveLength(1);
			const pairs = (alignment: Alignment) =>
				alignment.controlPoints.map(({ ordinal, resource, geo }) => ({ ordinal, resource, geo }));
			expect(pairs(back)).toStrictEqual(pairs(base(type)));
			expect(afterPasses(back, 'floride-1657')).toStrictEqual(back);

			expect(written).not.toContain('straight');
			expect(written).not.toContain('linear');
			const transformation = document.body.transformation as
				{ type?: string; options?: { order?: number } } | undefined;
			if (transformation?.type === 'polynomial') {
				expect(transformation.options?.order).toBeGreaterThanOrEqual(1);
			}
		}
	);

	it.each([
		['polynomial2', 2],
		['polynomial3', 3]
	])('has its order dropped by upstream’s own inverse for %s', (name, order) => {
		const written = transformationTypeToTypeAndOrder(name as 'polynomial2' | 'polynomial3');
		expect(written).toStrictEqual({ type: 'polynomial', options: { order } });
		const document = writtenJson(base(name as 'polynomial2'));
		expect(document.body.transformation).toStrictEqual({ type: 'polynomial', options: { order } });
		expect(parseAnnotation(document)[0]?.transformation).toStrictEqual({
			type: 'polynomial',
			options: { order }
		});

		expect(typeAndOrderToTransformationType(written)).toBe('polynomial1');

		expect(
			parseAlignment(serialiseAlignment(base(name as 'polynomial2')), { imageId: 'floride-1657' })
				.transformationType
		).toBe(name);
	});

	it('is why straight is banned: upstream throws turning it back into a name', () => {
		expect(() => typeAndOrderToTransformationType({ type: 'straight' })).toThrow(
			/Unrecognised transformationType/
		);
	});
});

describe('what the written document says about the image', () => {
	it('is a georeferencing annotation naming the image by the ADR-0004 placeholder', () => {
		const document = writtenJson(withThreePairs());
		expect(document.type).toBe('Annotation');
		expect(document.motivation).toBe('georeferencing');
		expect(document['@context']).toContain('http://iiif.io/api/extension/georef/1/context.json');
		expect(document.target.source.id).toBe(imageServiceId('floride-1657'));
		expect(document.target.source).toMatchObject({
			id: 'https://unset.invalid/floride-1657',
			type: 'ImageService3',
			width: 1200,
			height: 851
		});
	});

	it('carries no clock and is tab-indented with a final newline, so git diffs it readably', () => {
		const first = text(serialiseAlignment(withThreePairs()));
		expect(text(serialiseAlignment(withThreePairs()))).toBe(first);
		expect(first).not.toContain('"created"');
		expect(first).not.toContain('"modified"');
		expect(first.endsWith('\n')).toBe(true);
		expect(first).toContain('\n\t"type": "Annotation"');
	});
});

it('writes a valid Annotation excluding a half-pair, and does not throw (ADR-0022)', () => {
	const alignment: Alignment = {
		...newAlignment('floride-1657', SHEET),
		controlPoints: collectControlPoints([
			...threePairs,
			{ id: 'pending', resource: { x: 70, y: 80 }, geo: null }
		])
	};

	const written = text(serialiseAlignment(alignment));
	expect(() => validateAnnotation(JSON.parse(written))).not.toThrow();
	expect(parseAlignment(encode(written), { imageId: 'floride-1657' }).controlPoints).toHaveLength(
		3
	);
	const document = JSON.parse(written) as {
		body: { features: { properties: { resourceCoords: [number, number] } }[] };
	};
	expect(document.body.features.map((feature) => feature.properties.resourceCoords)).toStrictEqual([
		[10, 20],
		[30, 40],
		[50, 60]
	]);
});

describe('reading an Alignment written by Allmaps itself', () => {
	const imageId = 'allmaps-shaped';

	it('reads Control Points and Resource Mask out of a document full of fields we never write, dropping a repeated closing vertex', () => {
		const alignment = parsedFixture(imageId);
		expect(alignment.controlPoints).toHaveLength(4);
		expect(alignment.controlPoints[0]?.resource).toStrictEqual({ x: 1204, y: 892 });
		expect(alignment.controlPoints[0]?.geo).toStrictEqual({ lng: 4.88969, lat: 52.37403 });
		expect(alignment.image).toStrictEqual({ width: 5120, height: 4096 });
		expect(alignment.transformationType).toBe('polynomial1');
		expect(alignment.resourceMask).toHaveLength(4);
		expect(alignment.resourceMask[0]).toStrictEqual({ x: 312, y: 204 });
		expect(alignment.resourceMask.at(-1)).toStrictEqual({ x: 296, y: 3914 });
	});

	it('re-writes a foreign document with a fractional image width into one upstream still accepts', () => {
		const document = fixtureJson('allmaps-shaped');
		document.target.source.width = 5120.25;
		document.target.source.height = 4096.75;
		document.target.selector.value =
			'<svg><polygon points="312,204 4832,196 4844,3902 296,3914" /></svg>';

		const alignment = parsedDocument(document, imageId);
		expect(alignment.controlPoints).toHaveLength(4);
		expect(alignment.controlPoints[0]?.resource).toStrictEqual({ x: 1204, y: 892 });
		expect(alignment.resourceMask[0]).toStrictEqual({ x: 312, y: 204 });
		const written = text(serialiseAlignment(alignment));
		expect(alignment.image).toStrictEqual({ width: 5120, height: 4097 });
		expect(written).toContain('width=\\"5120\\" height=\\"4097\\"');
		expect(() => validateAnnotation(JSON.parse(written))).not.toThrow();
		expect(parseAnnotation(JSON.parse(written))).toHaveLength(1);
		const back = parseAlignment(encode(written), { imageId });
		expect(back.controlPoints).toStrictEqual(alignment.controlPoints);
		expect(back.resourceMask).toStrictEqual(alignment.resourceMask);
	});
});

it('refuses to write an Alignment upstream would not read back, rather than writing it', () => {
	const alignment: Alignment = {
		...newAlignment('floride-1657', { width: 1200.5, height: 851 }),
		controlPoints: threePairs
	};

	expect(() => serialiseAlignment(alignment)).toThrow(AlignmentUnwritableError);
	expect(() => serialiseAlignment(alignment)).toThrow(/floride-1657/);
	expect(() => serialiseAlignment(alignment)).toThrow(/was not saved/);
	expect(() => validateAnnotation(writtenJson(withThreePairs()))).not.toThrow();
});

describe('an Alignment that cannot be read is refused, not half-read', () => {
	it.each([
		['bytes that are not JSON', '{ not json'],
		['a JSON document that is not a Georeference Annotation', '{"hello":"world"}']
	])('refuses %s, naming the Map Image since one Project has several', (_name, bytes) => {
		const read = () => parseAlignment(encode(bytes), { imageId: 'floride-1657' });
		expect(read).toThrow(AlignmentUnreadableError);
		expect(read).toThrow(/floride-1657/);
	});

	it('refuses a document that does not say how large the image is', () => {
		const document = fixtureJson('floride-1657');
		delete document.target.source.width;
		delete document.target.source.height;

		expect(() => parsedDocument(document)).toThrow(/how large the Map Image is/);
	});

	it('takes the image identity from the path and not from the document', () => {
		expect(parsedFixture('floride-1657', 'a-different-image').imageId).toBe('a-different-image');
	});
});

describe('the members of a third party’s document that this build does not model', () => {
	const NAME = 'third-party-with-unknown-fields';
	const imageId = 'floride-1657';

	it('are carried on the Alignment rather than quietly discarded at the door', () => {
		expect(Object.keys(parsedFixture(NAME, imageId).unmodelled ?? {}).sort()).toEqual([
			'body',
			'created',
			'creator',
			'http://example.org/vocab#sheetNumber',
			'target'
		]);
	});

	it('come back out exactly, nested or not, beside the members this build recomputes, still valid', () => {
		const source = fixtureJson(NAME);
		const out = writtenJson(parsedFixture(NAME, imageId));

		expect(out['target']['source']['partOf']).toEqual([
			{ id: 'https://iiif.library.example/iiif/3/manifest/plan-1657', type: 'Manifest' }
		]);
		expect(out['body']['_allmaps']).toEqual({
			note: 'A private extension key, nested inside body.'
		});
		expect(out['target']['source']).toMatchObject({
			id: 'https://unset.invalid/floride-1657',
			width: 1200,
			height: 851
		});
		expect(out['created']).toBe(source['created']);
		expect(out['creator']).toEqual(source['creator']);
		expect(out['http://example.org/vocab#sheetNumber']).toBe(7);
		expect(() => validateAnnotation(out)).not.toThrow();
	});

	it('survive five passes, so an autosave loop cannot erode them', () => {
		const alignment = afterPasses(parsedFixture(NAME, imageId), imageId);
		expect(alignment.unmodelled?.['http://example.org/vocab#sheetNumber']).toBe(7);
		expect(alignment.unmodelled?.['creator']).toEqual({
			id: 'https://scholar.example/people/vermeer',
			type: 'Person',
			name: 'A colleague'
		});
	});

	it('never overwrite a member this build authors', () => {
		const alignment = parsedFixture(NAME, imageId);
		const out = writtenJson({
			...alignment,
			unmodelled: { ...alignment.unmodelled, target: 'a stale target', type: 'NotAnAnnotation' }
		});
		expect(out['type']).toBe('Annotation');
		expect(out['target']).toMatchObject({ type: 'SpecificResource' });
	});

	it('that cannot be carried still read, but refuse the write, naming the member', () => {
		const alignment = parsedFixture('third-party-with-unwritable-field', imageId);
		expect(alignment.controlPoints).toHaveLength(6);
		expect(alignment.unpreservable).toContain('body.features[0]');
		expect(alignment.unpreservable).toContain('confidence');
		expect(() => serialiseAlignment(alignment)).toThrow(AlignmentUnpreservableError);
		expect(() => serialiseAlignment(alignment)).toThrow(/confidence/);
		expect(() => serialiseAlignment(alignment)).toThrow(/left exactly as it is/);
	});

	it('that are all carryable do not refuse the write', () => {
		expect(parsedFixture(NAME, imageId).unpreservable).toBeUndefined();
		expect(() => serialiseAlignment(parsedFixture(NAME, imageId))).not.toThrow();
	});

	it('are absent from an Alignment this build made itself', () => {
		expect(newAlignment('fresh', { width: 10, height: 10 }).unmodelled).toBeUndefined();
	});
});
