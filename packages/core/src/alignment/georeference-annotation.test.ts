// The `@allmaps/*` fixture round-trips: one of the epic's four named risk items (SPEC, ADR-0010).
//
// Every `@allmaps/*` package is pre-1.0, so the Georeference Annotation shape and the parser API
// can still move under us. **A bump that changed either would not show as an error.** It would
// show as Alignments in the field being subtly misplaced — a Control Point quantised, a mask
// vertex dropped, a transformation type silently defaulted — which is why this file asserts a
// real round-trip against committed fixture bytes rather than the shape of an object we just
// built.
//
// What makes these fixtures load-bearing is that they are **frozen documents on disk**. A test
// that serialised and immediately deserialised its own output would keep passing through any
// upstream change that was merely self-consistent; these bytes were written once and cannot move,
// so a parser that starts reading them differently fails here.

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
import { imageServiceId } from '../tiler/pyramid.js';
import {
	TRANSFORMATION_CHOICES,
	collectControlPoints,
	insertMaskVertexAfter,
	moveMaskVertex,
	newAlignment,
	withTransformationType,
	type Alignment,
	type DraftControlPoint
} from './alignment.js';
import {
	AlignmentUnreadableError,
	parseAlignment,
	serialiseAlignment
} from './georeference-annotation.js';

const fixture = (name: string): Uint8Array =>
	readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)));

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Every committed fixture, and which Historical Map each one aligns. */
const FIXTURES = [
	{ name: 'floride-1657', imageId: 'floride-1657', controlPoints: 6, maskVertices: 4 },
	{ name: 'awkward-coordinates', imageId: 'awkward-coordinates', controlPoints: 5, maskVertices: 6 }
] as const;

describe('the committed fixture Alignments round-trip', () => {
	for (const { name, imageId, controlPoints, maskVertices } of FIXTURES) {
		describe(name, () => {
			it('parses into the Control Points and Resource Mask the document carries', () => {
				const alignment = parseAlignment(fixture(name), { imageId });

				expect(alignment.controlPoints).toHaveLength(controlPoints);
				expect(alignment.resourceMask).toHaveLength(maskVertices);
				expect(alignment.imageId).toBe(imageId);
				expect(alignment.controlPoints.map((point) => point.ordinal)).toEqual(
					Array.from({ length: controlPoints }, (_, index) => index + 1)
				);
			});

			// The criterion: serialise → deserialise with **identical** Control Points and Resource
			// Mask. Exact equality, not a tolerance — every one of these numbers travels as a JSON
			// number or as a plain-decimal string, both of which are lossless for a float64, so there
			// is no error budget to spend and any inexactness at all is a defect.
			it('survives serialise → deserialise with identical Control Points and Resource Mask', () => {
				const first = parseAlignment(fixture(name), { imageId });
				const second = parseAlignment(serialiseAlignment(first), { imageId });

				expect(second.controlPoints).toStrictEqual(first.controlPoints);
				expect(second.resourceMask).toStrictEqual(first.resourceMask);
				expect(second.image).toStrictEqual(first.image);
				expect(second.transformationType).toStrictEqual(first.transformationType);
				expect(second).toStrictEqual(first);
			});

			// Byte-identity, which is stronger than value-identity and is what pins the fixture. If an
			// upstream bump changes how the document is written, the committed bytes stop matching and
			// this fails — which is precisely the alarm ADR-0010 asks for on an Allmaps upgrade.
			it('re-serialises to the committed bytes exactly', () => {
				const alignment = parseAlignment(fixture(name), { imageId });
				expect(text(serialiseAlignment(alignment))).toBe(text(fixture(name)));
			});

			it('stays a valid Georeference Annotation after a round-trip', () => {
				const alignment = parseAlignment(fixture(name), { imageId });
				const written = JSON.parse(text(serialiseAlignment(alignment)));

				// Upstream's own validator, not ours: the criterion is that the file is parseable by
				// `@allmaps/annotation`, so it is `@allmaps/annotation` that has to say so.
				expect(() => validateAnnotation(written)).not.toThrow();
				expect(parseAnnotation(written)).toHaveLength(1);
			});

			it('is idempotent under repeated round-trips', () => {
				// Drift that only appears on the second or third save is the shape this class of bug
				// usually takes — a coordinate re-quantised each time it passes through.
				let alignment = parseAlignment(fixture(name), { imageId });
				const original = alignment;
				for (let pass = 0; pass < 5; pass += 1) {
					alignment = parseAlignment(serialiseAlignment(alignment), { imageId });
				}
				expect(alignment).toStrictEqual(original);
			});
		});
	}

	it('measures the worst coordinate disagreement across every fixture as exactly zero', () => {
		// Reported as a number rather than asserted only as equality, because "how far did it move"
		// is the question a future Allmaps bump has to answer, and `ROUND_TRIP_TOLERANCE_PX` is the
		// budget the rest of the coordinate pipeline is held to (ADR-0005's drift failure).
		let worstResource = 0;
		let worstGeo = 0;
		let worstMask = 0;

		for (const { name, imageId } of FIXTURES) {
			const before = parseAlignment(fixture(name), { imageId });
			const after = parseAlignment(serialiseAlignment(before), { imageId });

			before.controlPoints.forEach((point, index) => {
				const other = after.controlPoints[index];
				if (!other) throw new Error(`Control Point ${index} vanished from ${name}.`);
				worstResource = Math.max(
					worstResource,
					Math.abs(point.resource.x - other.resource.x),
					Math.abs(point.resource.y - other.resource.y)
				);
				worstGeo = Math.max(
					worstGeo,
					Math.abs(point.geo.lng - other.geo.lng),
					Math.abs(point.geo.lat - other.geo.lat)
				);
			});

			before.resourceMask.forEach((vertex, index) => {
				const other = after.resourceMask[index];
				if (!other) throw new Error(`Resource Mask vertex ${index} vanished from ${name}.`);
				worstMask = Math.max(worstMask, Math.abs(vertex.x - other.x), Math.abs(vertex.y - other.y));
			});
		}

		expect(worstResource).toBe(0);
		expect(worstGeo).toBe(0);
		expect(worstMask).toBe(0);
		// Restated against the pipeline's own budget, so this test also fails if the tolerance is
		// ever widened to accommodate a regression here rather than fixing it.
		expect(worstResource).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
		expect(worstMask).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
	});
});

describe('persistence spends none of the coordinate pipeline’s precision headroom', () => {
	// The Control Point a user places on the Historical Map is a point in the pane's synthetic
	// geography, recovered as an image pixel by `syntheticToResource`, stored as that pixel, and
	// converted back the next time the pane draws it. **Storage is in the middle of the loop the
	// drift failure lives in** (ADR-0005: control points that drift as you zoom, which reads as
	// imprecision rather than as a bug), so the number worth knowing is the error of the whole
	// composite — pane → file → pane — and not of the file alone.
	//
	// Ticket 06 measured the projection's own contribution at 2.32e-10 px on a 700 × 500 pyramid
	// and 1.49e-8 px on a 60000 × 24000 one. Since the file is exact to the bit (asserted above),
	// the composite must land on those same figures; if it ever exceeds them, serialisation has
	// started quantising something.
	it.each([
		{ label: 'a small pyramid', tileWidth: 256, maxScaleFactor: 4, width: 700, height: 500 },
		{
			label: 'the largest window',
			tileWidth: 256,
			maxScaleFactor: 256,
			width: 60000,
			height: 24000
		}
	])('round-trips a stored Control Point through $label within tolerance', (pyramid) => {
		const projection = createSyntheticProjection({
			width: pyramid.width,
			height: pyramid.height,
			tileWidth: pyramid.tileWidth,
			tileHeight: pyramid.tileWidth,
			maxScaleFactor: pyramid.maxScaleFactor
		});

		// Sampled off the binary grid on purpose. Integers on a power-of-two window come out exact,
		// and a measurement that reads 0 for that reason asserts nothing — the pitfall ticket 03's
		// review recorded and ticket 06 repeated.
		const samples: DraftControlPoint[] = [];
		const steps = 37;
		for (let index = 0; index < steps; index += 1) {
			const fraction = (index + 1 / 3) / (steps + 0.5);
			const resource = {
				x: fraction * pyramid.width,
				y: (1 - fraction) * pyramid.height
			};
			samples.push({
				id: `s${index}`,
				resource,
				// A real place on the earth, so the geo half is exercised at realistic magnitudes.
				geo: { lng: -87.216 + fraction * 7.025, lat: 30.401 - fraction * 5.358 }
			});
		}

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
			// The full loop: the stored image pixel out to the pane's geography and back again.
			const returned = projection.syntheticToResource(
				projection.resourceToSynthetic(point.resource)
			);
			worst = Math.max(worst, Math.abs(returned.x - original.x), Math.abs(returned.y - original.y));
		});

		expect(worst).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
	});
});

describe('the Resource Mask’s SVG round-trip, which is the one lossy-looking path', () => {
	// The mask does not travel as JSON numbers. `generateAnnotation` stringifies it into an SVG
	// `polygon points` attribute, and `Annotation1Schema` validates that attribute against a regex
	// whose number pattern is `-?\d+(\.\d+)?` — plain decimal only. `Number#toString` switches to
	// exponential below 1e-6, so a vertex near the image origin would be written as `1.5e-7`, match
	// no branch of that regex, and make the **whole** Alignment unreadable on the next open.
	it('writes a vertex below 1e-6 in plain decimal, and recovers it exactly', () => {
		const alignment = parseAlignment(fixture('awkward-coordinates'), {
			imageId: 'awkward-coordinates'
		});

		expect(alignment.resourceMask[0]).toStrictEqual({ x: 1.5e-7, y: 2.5e-7 });

		const written = text(serialiseAlignment(alignment));
		expect(written).toContain('0.00000015,0.00000025');
		expect(written).not.toMatch(/points="[^"]*e-/);
	});

	// **The path that makes the defect reachable in the field.** Ticket 07 fixed it while the mask
	// was still the full image rectangle and its vertices were therefore integers; editing the mask
	// is what lets a user put a vertex under 1e-6 — by dragging one towards the image origin, or by
	// inserting one at the midpoint of an edge that already has a tiny coordinate. So the assertion
	// is made through the editing operations, not by hand-building a mask.
	it('survives an edited vertex below 1e-6, dragged there and inserted there', () => {
		const dragged = moveMaskVertex(newAlignment('sheet', { width: 1200, height: 851 }), 0, {
			x: 1.5e-7,
			y: 2.5e-7
		});

		const written = text(serialiseAlignment(dragged));
		// Plain decimal, every significant digit kept — the notation changes, the value does not.
		expect(written).toContain('0.00000015,0.00000025');
		expect(written).not.toMatch(/points="[^"]*e-/);

		const back = parseAlignment(serialiseAlignment(dragged), { imageId: 'sheet' });
		expect(back.resourceMask[0]).toStrictEqual({ x: 1.5e-7, y: 2.5e-7 });
		// Exactly zero error, not a tolerance: an exponential vertex does not lose precision, it makes
		// the *entire* Alignment unreadable, so there is nothing to be within.
		expect(back.resourceMask).toStrictEqual(dragged.resourceMask);
		expect(back.controlPoints).toStrictEqual(dragged.controlPoints);

		// Inserting on the edge that leaves it halves the coordinate again, taking the new vertex
		// under 1e-6 as well — the second way a user reaches this without doing anything unusual.
		const inserted = insertMaskVertexAfter(moveMaskVertex(dragged, 1, { x: 3.5e-7, y: 4.5e-7 }), 0);
		expect(inserted.resourceMask[1]).toStrictEqual({ x: 2.5e-7, y: 3.5e-7 });

		const reread = parseAlignment(serialiseAlignment(inserted), { imageId: 'sheet' });
		expect(reread.resourceMask).toStrictEqual(inserted.resourceMask);
		expect(text(serialiseAlignment(reread))).toBe(text(serialiseAlignment(inserted)));
	});

	// An edited mask has to be readable by upstream's own validator, not merely by us: a mask with
	// five or six vertices, sub-pixel coordinates, and a concave corner is the ordinary product of
	// outlining a real sheet.
	it('keeps an edited mask a valid Georeference Annotation', () => {
		let alignment = newAlignment('sheet', { width: 1200, height: 851 });
		alignment = insertMaskVertexAfter(alignment, 1);
		alignment = moveMaskVertex(alignment, 2, { x: 1199.999999, y: 425.0000001 });
		alignment = insertMaskVertexAfter(alignment, 3);
		alignment = moveMaskVertex(alignment, 4, { x: 600.5, y: 300.25 });

		const document = JSON.parse(text(serialiseAlignment(alignment)));
		expect(() => validateAnnotation(document)).not.toThrow();
		expect(parseAnnotation(document)).toHaveLength(1);

		const back = parseAlignment(serialiseAlignment(alignment), { imageId: 'sheet' });
		expect(back.resourceMask).toStrictEqual(alignment.resourceMask);
		expect(back.resourceMask).toHaveLength(6);
	});

	// Pinned because `toPlainDecimal` relies on it: it does no non-finite check of its own, since
	// one would be unreachable. `String(NaN)` is the text `NaN`, which matches no branch of
	// upstream's polygon regex, so a vertex that got through would make the file unreadable.
	it.each([
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
		['-Infinity', Number.NEGATIVE_INFINITY]
	])('is refused outright by upstream when a vertex is %s', (_label, bad) => {
		const alignment: Alignment = {
			...newAlignment('floride-1657', { width: 1200, height: 851 }),
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
	const drafts: DraftControlPoint[] = [
		{ id: 'a', resource: { x: 10, y: 20 }, geo: { lng: 4.1, lat: 52.1 } },
		{ id: 'b', resource: { x: 30, y: 40 }, geo: { lng: 4.2, lat: 52.2 } },
		{ id: 'c', resource: { x: 50, y: 60 }, geo: { lng: 4.3, lat: 52.3 } }
	];

	const written = (): Record<string, never> & { body: { transformation?: unknown } } =>
		JSON.parse(
			text(
				serialiseAlignment({
					...newAlignment('floride-1657', { width: 1200, height: 851 }),
					controlPoints: collectControlPoints(drafts)
				})
			)
		);

	it('comes back as the canonical name polynomial1', () => {
		const alignment = parseAlignment(
			serialiseAlignment({
				...newAlignment('floride-1657', { width: 1200, height: 851 }),
				controlPoints: collectControlPoints(drafts)
			}),
			{ imageId: 'floride-1657' }
		);

		expect(alignment.transformationType).toBe('polynomial1');
	});

	// **The order is explicit, and that is the whole point.** ADR-0013 forbids the bare alias
	// `polynomial` because it leaves the order to be inferred. It is present here, so nothing is
	// inferred — and `typeAndOrderToTransformationType` maps this pair back to exactly
	// `polynomial1`, which the assertion above shows.
	it('carries the order explicitly, never the bare alias', () => {
		expect(written().body.transformation).toStrictEqual({
			type: 'polynomial',
			options: { order: 1 }
		});
	});

	it('never writes straight, which is not round-trippable (ADR-0013)', () => {
		expect(
			text(
				serialiseAlignment({
					...newAlignment('floride-1657', { width: 1200, height: 851 }),
					controlPoints: collectControlPoints(drafts)
				})
			)
		).not.toContain('straight');
	});

	// The measurement behind `georeference-annotation.ts`'s long comment, kept as a test so that an
	// upstream fix is noticed rather than assumed. When `@allmaps/annotation` learns to carry
	// `polynomial1` as its own name, **this test fails** — and the writer can be simplified.
	it('is dropped outright by upstream when written as the literal string polynomial1', () => {
		const document = JSON.parse(text(fixture('floride-1657')));
		document.body.transformation = { type: 'polynomial1' };

		expect(parseAnnotation(document)[0]?.transformation).toBeUndefined();
	});

	it('falls back to the default when the document carries none', () => {
		const document = JSON.parse(text(fixture('floride-1657')));
		delete document.body.transformation;
		const bytes = new TextEncoder().encode(JSON.stringify(document));

		// The Control Points are the user's labour; the transformation is a lens over them with a
		// safe default, so a missing lens must not discard the labour.
		const alignment = parseAlignment(bytes, { imageId: 'floride-1657' });
		expect(alignment.transformationType).toBe('polynomial1');
		expect(alignment.controlPoints).toHaveLength(6);
	});

	it('falls back to the default rather than throwing on straight', () => {
		const document = JSON.parse(text(fixture('floride-1657')));
		document.body.transformation = { type: 'straight' };
		const bytes = new TextEncoder().encode(JSON.stringify(document));

		expect(parseAlignment(bytes, { imageId: 'floride-1657' }).transformationType).toBe(
			'polynomial1'
		);
	});
});

describe('every offered transformation type round-trips through @allmaps/annotation', () => {
	// The criterion, and the one that would otherwise silently misplace every Alignment in the field.
	// Six types are offered, and every one is measured rather than assumed: `@allmaps/annotation`'s
	// `transformation` is a Zod enum that does not contain four of the six names, so what survives
	// the file is a question about upstream and not about our writer.
	const base = (type: (typeof TRANSFORMATION_CHOICES)[number]['type']): Alignment =>
		withTransformationType(
			{
				...newAlignment('floride-1657', { width: 1200, height: 851 }),
				controlPoints: collectControlPoints(
					// Ten pairs, so that even `polynomial3` is above its minimum and the document is one a
					// user could actually have produced.
					Array.from({ length: 10 }, (_, index) => ({
						id: `p${index}`,
						resource: { x: 40 + index * 90, y: 30 + index * 60 },
						geo: { lng: -87.2 + index * 0.7, lat: 30.4 - index * 0.5 }
					}))
				)
			},
			type
		);

	it.each(TRANSFORMATION_CHOICES.map((choice) => choice.type))(
		'%s survives serialise → deserialise as itself',
		(type) => {
			const written = serialiseAlignment(base(type));
			const back = parseAlignment(written, { imageId: 'floride-1657' });

			expect(back.transformationType).toBe(type);
			// Upstream's own validator, and its own parser: the criterion is that the document is a
			// Georeference Annotation, so it is upstream that has to say so.
			expect(() => validateAnnotation(JSON.parse(text(written)))).not.toThrow();
			expect(parseAnnotation(JSON.parse(text(written)))).toHaveLength(1);
			// And the Control Points came through unchanged, not merely the type. Compared by coordinate
			// and ordinal rather than wholesale, because the id is *derived from position* on read —
			// the file carries none, and inventing one would be the proprietary index story 94 rules out.
			expect(
				back.controlPoints.map(({ ordinal, resource, geo }) => ({ ordinal, resource, geo }))
			).toStrictEqual(
				base(type).controlPoints.map(({ ordinal, resource, geo }) => ({
					ordinal,
					resource,
					geo
				}))
			);
		}
	);

	it.each(TRANSFORMATION_CHOICES.map((choice) => choice.type))(
		'%s is idempotent over five round-trips',
		(type) => {
			let alignment = parseAlignment(serialiseAlignment(base(type)), { imageId: 'floride-1657' });
			const first = alignment;
			for (let pass = 0; pass < 5; pass += 1) {
				alignment = parseAlignment(serialiseAlignment(alignment), { imageId: 'floride-1657' });
			}
			expect(alignment).toStrictEqual(first);
		}
	);

	it('writes none of the three banned names, under any offered type', () => {
		for (const { type } of TRANSFORMATION_CHOICES) {
			const written = text(serialiseAlignment(base(type)));
			expect(written, type).not.toContain('straight');
			expect(written, type).not.toContain('linear');
			// The bare alias is forbidden only *without* an order beside it. Every polynomial is written
			// as `"type": "polynomial"` with `options.order`, which is the one form the format can carry
			// — so what is asserted is that the order is never missing.
			const document = JSON.parse(written) as { body: { transformation?: unknown } };
			const transformation = document.body.transformation as
				{ type?: string; options?: { order?: number } } | undefined;
			if (transformation?.type === 'polynomial') {
				expect(transformation.options?.order, type).toBeGreaterThanOrEqual(1);
			}
		}
	});

	// **A live upstream defect, pinned here so an upstream fix is noticed rather than assumed.**
	// `typeAndOrderToTransformationType` is the documented inverse of `transformationTypeToTypeAndOrder`
	// and for orders 2 and 3 it is not: its first branch claims `type === 'polynomial'` before the
	// order is looked at, so the `order === 2` and `order === 3` branches are unreachable. The file is
	// written correctly — the order is there and comes back — but trusting the helper to read it would
	// turn a user's Higher-order (3rd) Alignment into an affine one on reopening, with every
	// coordinate intact and the map placed wrongly. `readTransformationType` reads the order itself.
	//
	// **When upstream fixes the helper, this test fails** and the direct read can be removed.
	it.each([
		['polynomial2', 2],
		['polynomial3', 3]
	])('has its order dropped by upstream’s own inverse for %s', (name, order) => {
		const written = transformationTypeToTypeAndOrder(name as 'polynomial2' | 'polynomial3');
		expect(written).toStrictEqual({ type: 'polynomial', options: { order } });

		// Upstream writes and reads the order faithfully…
		const document = JSON.parse(text(serialiseAlignment(base(name as 'polynomial2'))));
		expect(document.body.transformation).toStrictEqual({ type: 'polynomial', options: { order } });
		expect(parseAnnotation(document)[0]?.transformation).toStrictEqual({
			type: 'polynomial',
			options: { order }
		});

		// …and then throws the order away on the way back to a name.
		expect(typeAndOrderToTransformationType(written)).toBe('polynomial1');

		// Which is exactly what `parseAlignment` must not do.
		expect(
			parseAlignment(serialiseAlignment(base(name as 'polynomial2')), { imageId: 'floride-1657' })
				.transformationType
		).toBe(name);
	});

	// `straight` is the third name ADR-0013 bans, and this is why: upstream's own inverse throws on
	// it, so a document carrying it is one that cannot be read back into a type at all.
	it('is why straight is banned: upstream throws turning it back into a name', () => {
		expect(() => typeAndOrderToTransformationType({ type: 'straight' })).toThrow(
			/Unrecognised transformationType/
		);
	});
});

describe('what the written document says about the image', () => {
	const alignment = (): Alignment => ({
		...newAlignment('floride-1657', { width: 1200, height: 851 }),
		controlPoints: collectControlPoints([
			{ id: 'a', resource: { x: 10, y: 20 }, geo: { lng: 4.1, lat: 52.1 } },
			{ id: 'b', resource: { x: 30, y: 40 }, geo: { lng: 4.2, lat: 52.2 } },
			{ id: 'c', resource: { x: 50, y: 60 }, geo: { lng: 4.3, lat: 52.3 } }
		])
	});

	it('names the image by the ADR-0004 placeholder the injection layer routes', () => {
		const document = JSON.parse(text(serialiseAlignment(alignment())));

		// The same string the pyramid's own `info.json` declares and the same one
		// `createStoreImageFetch` matches on, so the Alignment names its image exactly the way every
		// other consumer of that image does (ADR-0011).
		expect(document.target.source.id).toBe(imageServiceId('floride-1657'));
		expect(document.target.source.id).toBe('https://unset.invalid/floride-1657');
		expect(document.target.source.type).toBe('ImageService3');
		expect(document.target.source.width).toBe(1200);
		expect(document.target.source.height).toBe(851);
	});

	it('is a georeferencing annotation with the IIIF Georeference Extension context', () => {
		const document = JSON.parse(text(serialiseAlignment(alignment())));

		expect(document.type).toBe('Annotation');
		expect(document.motivation).toBe('georeferencing');
		expect(document['@context']).toContain('http://iiif.io/api/extension/georef/1/context.json');
	});

	it('carries no clock, so an unchanged Alignment writes byte-identically', () => {
		const first = text(serialiseAlignment(alignment()));
		const second = text(serialiseAlignment(alignment()));

		expect(second).toBe(first);
		expect(first).not.toContain('"created"');
		expect(first).not.toContain('"modified"');
	});

	it('ends in a newline and is tab-indented, so a Workspace in git diffs readably', () => {
		const written = text(serialiseAlignment(alignment()));

		expect(written.endsWith('\n')).toBe(true);
		expect(written).toContain('\n\t"type": "Annotation"');
	});
});

describe('a half-pair never reaches the file (ADR-0022)', () => {
	it('writes a valid Annotation excluding the incomplete pair, and does not throw', () => {
		const drafts: DraftControlPoint[] = [
			{ id: 'a', resource: { x: 10, y: 20 }, geo: { lng: 4.1, lat: 52.1 } },
			{ id: 'b', resource: { x: 30, y: 40 }, geo: { lng: 4.2, lat: 52.2 } },
			{ id: 'c', resource: { x: 50, y: 60 }, geo: { lng: 4.3, lat: 52.3 } },
			// The pending half: clicked on the Historical Map, not yet matched on the Base Map.
			{ id: 'pending', resource: { x: 70, y: 80 }, geo: null }
		];

		const alignment: Alignment = {
			...newAlignment('floride-1657', { width: 1200, height: 851 }),
			controlPoints: collectControlPoints(drafts)
		};

		const written = text(serialiseAlignment(alignment));
		expect(() => validateAnnotation(JSON.parse(written))).not.toThrow();

		const back = parseAlignment(new TextEncoder().encode(written), { imageId: 'floride-1657' });
		expect(back.controlPoints).toHaveLength(3);
		// The pending half's own coordinate is nowhere in the document, not merely absent from the
		// parsed result.
		expect(written).not.toContain('70');
		expect(written).not.toContain('80');
	});
});

describe('reading an Alignment written by Allmaps itself (SPEC story 91)', () => {
	const imageId = 'allmaps-shaped';

	it('reads the Control Points and Resource Mask out of a document full of fields we never write', () => {
		const alignment = parseAlignment(fixture('allmaps-shaped'), { imageId });

		expect(alignment.controlPoints).toHaveLength(4);
		expect(alignment.controlPoints[0]?.resource).toStrictEqual({ x: 1204, y: 892 });
		expect(alignment.controlPoints[0]?.geo).toStrictEqual({ lng: 4.88969, lat: 52.37403 });
		expect(alignment.image).toStrictEqual({ width: 5120, height: 4096 });
		expect(alignment.transformationType).toBe('polynomial1');
	});

	it('drops the repeated closing vertex an SVG polygon may carry', () => {
		// The fixture's polygon repeats its first point at the end, which is legal SVG and is what
		// some producers emit. Upstream's parser removes it; a mask that kept it would draw a
		// zero-length edge and, worse, would not compare equal to the same mask written by us.
		const alignment = parseAlignment(fixture('allmaps-shaped'), { imageId });

		expect(alignment.resourceMask).toHaveLength(4);
		expect(alignment.resourceMask[0]).toStrictEqual({ x: 312, y: 204 });
		expect(alignment.resourceMask.at(-1)).toStrictEqual({ x: 296, y: 3914 });
	});

	it('round-trips from the second generation on', () => {
		// Not byte-identical to the fixture, and it should not be: we deliberately write no `id`,
		// no timestamps, and no `_allmaps`. What has to hold is that nothing the *model* carries
		// moves once it has been through our writer once.
		const first = parseAlignment(fixture('allmaps-shaped'), { imageId });
		const second = parseAlignment(serialiseAlignment(first), { imageId });
		const third = parseAlignment(serialiseAlignment(second), { imageId });

		expect(second.controlPoints).toStrictEqual(first.controlPoints);
		expect(second.resourceMask).toStrictEqual(first.resourceMask);
		expect(third).toStrictEqual(second);
	});
});

describe('an Alignment that cannot be read is refused, not half-read', () => {
	const bytes = (value: string) => new TextEncoder().encode(value);

	it('refuses bytes that are not JSON', () => {
		expect(() => parseAlignment(bytes('{ not json'), { imageId: 'floride-1657' })).toThrow(
			AlignmentUnreadableError
		);
	});

	it('refuses a JSON document that is not a Georeference Annotation', () => {
		expect(() => parseAlignment(bytes('{"hello":"world"}'), { imageId: 'floride-1657' })).toThrow(
			AlignmentUnreadableError
		);
	});

	it('refuses a document that does not say how large the image is', () => {
		const document = JSON.parse(text(fixture('floride-1657')));
		delete document.target.source.width;
		delete document.target.source.height;

		// Both dimensions are `optional().catch(undefined)` upstream, so this parses fine and leaves
		// no pixel dimensions — and every coordinate in the file is in image pixels.
		expect(() =>
			parseAlignment(bytes(JSON.stringify(document)), { imageId: 'floride-1657' })
		).toThrow(/how large the Historical Map image is/);
	});

	it('names the Historical Map in the message, since one Project has several', () => {
		expect(() => parseAlignment(bytes('nope'), { imageId: 'floride-1657' })).toThrow(
			/floride-1657/
		);
	});

	it('takes the image identity from the path and not from the document', () => {
		// A file copied under a different name must describe the image its path names, or a Project
		// silently aligns the wrong Historical Map — which is a misplaced map, not an error.
		const alignment = parseAlignment(fixture('floride-1657'), { imageId: 'a-different-image' });
		expect(alignment.imageId).toBe('a-different-image');
	});
});
