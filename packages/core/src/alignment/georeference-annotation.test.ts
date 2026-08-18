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
	AlignmentUnpreservableError,
	AlignmentUnwritableError,
	parseAlignment,
	serialiseAlignment
} from './georeference-annotation.js';

const fixture = (name: string): Uint8Array =>
	readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)));

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * Every committed fixture, and which Map Image each one aligns.
 *
 * **`allmaps-shaped` is in this list, and that is the point of the list.** It exists precisely
 * because it is a document *we did not write* — `id`, `created`, `modified`, `partOf`, `provider`,
 * `_allmaps`, and a polygon that repeats its closing vertex (SPEC story 91) — so it is the only
 * fixture that can answer "does a document from another producer, read and re-written by us, come
 * back out something upstream still accepts?" That is the migration event ADR-0010 names, arriving
 * from the direction this fixture was built for, and leaving it out of the guarantees meant nothing
 * asserted it.
 *
 * `byteIdentical` is the one guarantee it cannot carry, and should not: we mint no `id` and stamp no
 * clock of our own, so our output is a *different document* that has to mean the same thing.
 * Everything else — upstream's validator, exact Control Points and Resource Mask, exactly-zero
 * coordinate movement, and idempotence over five passes — applies to every fixture.
 *
 * **Ticket 18 narrowed what "a different document" is allowed to mean.** Those members are no longer
 * dropped: `id`, `created`, `modified`, `partOf`, `provider` and `_allmaps` are members this build
 * does not model, and they are now carried through a read-and-write cycle verbatim, because
 * `alignments/<image-id>.json` is shared by every Project and regenerating a colleague's document
 * from our own model is a silent loss (SPEC story 60). What still differs is only their *position*
 * in the file. The direct assertions are at the bottom of this file.
 */
const FIXTURES = [
	{
		name: 'floride-1657',
		imageId: 'floride-1657',
		controlPoints: 6,
		maskVertices: 4,
		byteIdentical: true
	},
	{
		name: 'awkward-coordinates',
		imageId: 'awkward-coordinates',
		controlPoints: 5,
		maskVertices: 6,
		byteIdentical: true
	},
	{
		name: 'allmaps-shaped',
		imageId: 'allmaps-shaped',
		controlPoints: 4,
		maskVertices: 4,
		byteIdentical: false
	},
	{
		// Ticket 18's fixture: `floride-1657` with five members this build does not model — a
		// timestamp, a `creator` object and a term from somebody else's vocabulary at the top level,
		// and `target.source.partOf` and `body._allmaps` nested inside. It is registered here so it
		// has to pass every guarantee above as well as the preservation tests below.
		//
		// Not `byteIdentical`, for the same reason `allmaps-shaped` is not: the members come back, but
		// `created` comes back in the slot `generateAnnotation` reserves for it rather than at the end
		// of the document where its author put it. Ordering is not what story 60 is about, and the
		// tests below assert the members and their values exactly, which is.
		name: 'third-party-with-unknown-fields',
		imageId: 'floride-1657',
		controlPoints: 6,
		maskVertices: 4,
		byteIdentical: false
	}
] as const;

describe('the committed fixture Alignments round-trip', () => {
	for (const { name, imageId, controlPoints, maskVertices, byteIdentical } of FIXTURES) {
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
			//
			// Not asked of a document another producer wrote, and only there. Since ticket 18 those
			// members do come back — what does not come back is their *position*: `created` returns to
			// the slot `generateAnnotation` reserves for it rather than wherever its author put it. So
			// byte-identity against a foreign document would be asserting key order, which is not a
			// property of the format and not what story 60 asks for. The members and their values are
			// asserted exactly at the bottom of this file instead. Not registered at all rather than
			// skipped, so the suite carries no permanently pending test.
			if (byteIdentical) {
				it('re-serialises to the committed bytes exactly', () => {
					const alignment = parseAlignment(fixture(name), { imageId });
					expect(text(serialiseAlignment(alignment))).toBe(text(fixture(name)));
				});
			}

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
	// The Control Point a user places on the Map Image is a point in the pane's synthetic
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
	//
	// **`worstAtMost` is the assertion, not `ROUND_TRIP_TOLERANCE_PX`.** Held only against the 1e-6
	// tolerance, this test would stay green through three orders of magnitude of degradation — at the
	// 65,536-px synthetic window the headroom is roughly 67×, so "within tolerance" says almost
	// nothing about whether anything moved. The figures below are the measured error with about five
	// times' room for engine and architecture variation, which is enough to absorb a different
	// machine and not enough to absorb a regression. The ceiling of the window itself is guarded
	// elsewhere — `createSyntheticProjection` refuses a pyramid it cannot hold — not here.
	//
	// `toBeGreaterThan(0)` is the other half, and it is not ceremony: sampling on the binary grid
	// makes this measurement read exactly 0 for a reason that has nothing to do with correctness,
	// which is the pitfall ticket 03's review recorded. A 0 here means the samples stopped being
	// off-grid, not that the pipeline became exact.
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

		// Pinned to what was measured, then restated against the pipeline's own budget — so a
		// regression fails on the pin rather than being absorbed by the 1e-6 headroom.
		expect(worst).toBeGreaterThan(0);
		expect(worst).toBeLessThan(pyramid.worstAtMost);
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
			// The pending half: clicked on the Map Image, not yet matched on the Base Map.
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
		// parsed result. Asserted against the *`resourceCoords` that were written*, and not as a
		// substring scan of the whole file: `not.toContain('70')` was true by luck of which other
		// numbers happen to appear — `851`, a longitude, a mask vertex — and would have gone on
		// passing with `[70, 80]` written as `[70.0, 80]` or split across a reformat.
		const document = JSON.parse(written) as {
			body: { features: { properties: { resourceCoords: [number, number] } }[] };
		};
		const coordinates = document.body.features.map((feature) => feature.properties.resourceCoords);
		expect(coordinates).toStrictEqual([
			[10, 20],
			[30, 40],
			[50, 60]
		]);
		expect(coordinates).not.toContainEqual([70, 80]);
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

	// The round-trip guarantees themselves — upstream's validator on our output, exact Control Points
	// and Resource Mask, exactly-zero coordinate movement, and five passes — are in `FIXTURES` above,
	// which this document is a member of. It is a member because it is the *only* fixture that can
	// answer them for a producer other than us, which is the direction ADR-0010's migration event
	// arrives from.

	// **The same landmine as the sub-1e-6 mask vertex, on a field we copy rather than compute.**
	// `Source2Schema` validates `width` as `z.number().positive()`, so a fractional one parses
	// happily; the SVG selector's own regex is `width="\d+"` — **integers only** — and a document
	// whose selector omits the dimensions altogether (`<svg>`, an accepted branch) sails past the
	// reader. Put those together and a foreign Alignment with a fractional image width is readable
	// by us, re-written by us as `<svg width="5120.5" …>`, and then refused by upstream *entirely*,
	// taking every Control Point with it. Measured against the pinned `@allmaps/annotation@1.0.0-beta.37`.
	it('re-writes a foreign document with a fractional image width into one upstream still accepts', () => {
		const document = JSON.parse(text(fixture('allmaps-shaped')));
		document.target.source.width = 5120.25;
		document.target.source.height = 4096.75;
		// The selector without dimensions, which upstream accepts and which is what makes the
		// fractional source dimensions reachable at all.
		document.target.selector.value =
			'<svg><polygon points="312,204 4832,196 4844,3902 296,3914" /></svg>';

		const alignment = parseAlignment(new TextEncoder().encode(JSON.stringify(document)), {
			imageId
		});
		// The Control Points are the user's labour and none of them moved.
		expect(alignment.controlPoints).toHaveLength(4);
		expect(alignment.controlPoints[0]?.resource).toStrictEqual({ x: 1204, y: 892 });
		expect(alignment.resourceMask[0]).toStrictEqual({ x: 312, y: 204 });

		const written = text(serialiseAlignment(alignment));
		// Integers, because that is the only thing the format's own regex accepts — rounded to the
		// nearest, in both directions, so no coordinate is implied to be somewhere it is not.
		expect(alignment.image).toStrictEqual({ width: 5120, height: 4097 });
		expect(written).toContain('width=\\"5120\\" height=\\"4097\\"');
		expect(() => validateAnnotation(JSON.parse(written))).not.toThrow();
		expect(parseAnnotation(JSON.parse(written))).toHaveLength(1);

		// And it is still readable by us, with everything the user made intact.
		const back = parseAlignment(new TextEncoder().encode(written), { imageId });
		expect(back.controlPoints).toStrictEqual(alignment.controlPoints);
		expect(back.resourceMask).toStrictEqual(alignment.resourceMask);
	});
});

describe('the write path checks its own output', () => {
	// **Nothing else on the write path did.** `validateAnnotation` appeared only in tests, while the
	// failure mode is "the entire Alignment, including every Control Point, is unreachable on the next
	// open", autosave fires on every gesture end, and the Resource Mask now travels through a bespoke
	// string encoder into an attribute upstream validates with a regex. Two concrete holes are plugged
	// upstream of this — the sub-1e-6 vertex and the fractional image dimension — and both were found
	// by *reading* upstream's regexes. This is the guard for the third one.
	const threePairs = collectControlPoints([
		{ id: 'a', resource: { x: 10, y: 20 }, geo: { lng: 4.1, lat: 52.1 } },
		{ id: 'b', resource: { x: 30, y: 40 }, geo: { lng: 4.2, lat: 52.2 } },
		{ id: 'c', resource: { x: 50, y: 60 }, geo: { lng: 4.3, lat: 52.3 } }
	]);

	it('refuses to write an Alignment upstream would not read back, rather than writing it', () => {
		// A fractional image dimension: the one shape the domain type still permits and the format
		// does not, since `<svg width="…">` is validated as `\d+`. Reachable in memory — an `Alignment`
		// carries whatever pixel dimensions it was built with — and not reachable through
		// `parseAlignment`, which rounds. So this is the guard firing on the class of defect rather
		// than on a live instance of it.
		const alignment: Alignment = {
			...newAlignment('floride-1657', { width: 1200.5, height: 851 }),
			controlPoints: threePairs
		};

		expect(() => serialiseAlignment(alignment)).toThrow(AlignmentUnwritableError);
		// The message says which Map Image and that nothing was saved, because the user's next
		// question is whether they have lost the Control Points they just placed. They have not: the
		// last good file is still on disk, which is the whole reason this refuses rather than writes.
		expect(() => serialiseAlignment(alignment)).toThrow(/floride-1657/);
		expect(() => serialiseAlignment(alignment)).toThrow(/was not saved/);
	});

	it('lets a well-formed Alignment through untouched', () => {
		// The guard must not be a tax on the ordinary case: the same Alignment with whole pixels
		// writes, and writes exactly what it wrote before the guard existed.
		const alignment: Alignment = {
			...newAlignment('floride-1657', { width: 1200, height: 851 }),
			controlPoints: threePairs
		};

		expect(() => serialiseAlignment(alignment)).not.toThrow();
		expect(() => validateAnnotation(JSON.parse(text(serialiseAlignment(alignment))))).not.toThrow();
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
		).toThrow(/how large the Map Image is/);
	});

	it('names the Map Image in the message, since one Project has several', () => {
		expect(() => parseAlignment(bytes('nope'), { imageId: 'floride-1657' })).toThrow(
			/floride-1657/
		);
	});

	it('takes the image identity from the path and not from the document', () => {
		// A file copied under a different name must describe the image its path names, or a Project
		// silently aligns the wrong Map Image — which is a misplaced map, not an error.
		const alignment = parseAlignment(fixture('floride-1657'), { imageId: 'a-different-image' });
		expect(alignment.imageId).toBe('a-different-image');
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// A DOCUMENT SOMEBODY ELSE WROTE SURVIVES BEING WRITTEN BACK (SPEC story 60, ticket 18)
//
// `serialiseAlignment` regenerates the whole document from `Alignment`, so before ticket 18 every
// member of a third-party Georeference Annotation that this build does not model was dropped the
// first time anybody nudged a Control Point. ADR-0023 makes that worse than it sounds: the file
// belongs to the **Workspace** and is shared by every Project, so the nudge that discards a
// colleague's `creator` block need not even be in the Project the colleague was working in.
//
// **The unguarded direction is what these assert.** Delete `restoreUnmodelledMembers`, or the
// `unmodelled` field it reads, and every one of them fails.
describe('the members of a third party’s document that this build does not model', () => {
	const NAME = 'third-party-with-unknown-fields';
	const imageId = 'floride-1657';

	const written = () =>
		JSON.parse(text(serialiseAlignment(parseAlignment(fixture(NAME), { imageId }))));

	it('are carried on the Alignment rather than quietly discarded at the door', () => {
		const alignment = parseAlignment(fixture(NAME), { imageId });

		expect(Object.keys(alignment.unmodelled ?? {}).sort()).toEqual([
			'body',
			'created',
			'creator',
			'http://example.org/vocab#sheetNumber',
			'target'
		]);
	});

	// The first cut diffed only the top level, and this is what that missed. Every one of these is
	// nested, and `_allmaps` is what Allmaps itself writes — so a top-level-only diff did not hold
	// for the documents story 60 exists for. `allmaps-shaped.json`, already in this repository
	// before ticket 18, carries all three shapes and was silently losing them.
	it('come back from inside target and body, not only from the top level', () => {
		const out = written();

		expect(out['target']['source']['partOf']).toEqual([
			{ id: 'https://iiif.library.example/iiif/3/manifest/plan-1657', type: 'Manifest' }
		]);
		expect(out['body']['_allmaps']).toEqual({
			note: 'A private extension key, nested inside body.'
		});
	});

	it('do not displace the members beside them that this build recomputes', () => {
		// `target.source` carries a carried `partOf` and an authored `id`, `width` and `height`. A
		// restore that put the whole source object back would pin the image dimensions to whatever the
		// file said, which is the stale-value defect pointing at a nested member.
		const out = written();

		expect(out['target']['source']['id']).toBe('https://unset.invalid/floride-1657');
		expect(out['target']['source']['width']).toBe(1200);
		expect(out['target']['source']['height']).toBe(851);
	});

	it('come back out with their exact values after a read-and-write cycle', () => {
		const source = JSON.parse(text(fixture(NAME)));
		const out = written();

		// Deep equality on each, not a truthiness check: a `creator` block flattened to its `id` would
		// pass "the field survived" and still be the loss story 60 is written against.
		expect(out['created']).toBe(source['created']);
		expect(out['creator']).toEqual(source['creator']);
		expect(out['http://example.org/vocab#sheetNumber']).toBe(7);
	});

	it('survive five passes, so an autosave loop cannot erode them', () => {
		// The realistic shape of the failure: not one write, but the hundreds a session of Control
		// Point placement produces. A member that survived once and was dropped on the second pass
		// would be worse than one dropped immediately, because it would pass a one-pass test.
		let alignment = parseAlignment(fixture(NAME), { imageId });
		for (let pass = 0; pass < 5; pass += 1) {
			alignment = parseAlignment(serialiseAlignment(alignment), { imageId });
		}

		expect(alignment.unmodelled?.['http://example.org/vocab#sheetNumber']).toBe(7);
		expect(alignment.unmodelled?.['creator']).toEqual({
			id: 'https://scholar.example/people/vermeer',
			type: 'Person',
			name: 'A colleague'
		});
	});

	it('are still a valid Georeference Annotation with them in', () => {
		// Upstream's own validator: carrying a member it does not know about must not produce a file
		// it then refuses, which would take every Control Point down with it on the next open.
		expect(() => validateAnnotation(written())).not.toThrow();
	});

	it('never overwrite a member this build authors', () => {
		// The same defect pointing the other way. If upstream starts writing a member that was
		// unmodelled when the file was read, the value generated now is the current one and the
		// carried value is a year old.
		const alignment = parseAlignment(fixture(NAME), { imageId });
		const tampered = {
			...alignment,
			unmodelled: { ...alignment.unmodelled, target: 'a stale target', type: 'NotAnAnnotation' }
		};
		const out = JSON.parse(text(serialiseAlignment(tampered)));

		expect(out['type']).toBe('Annotation');
		expect(out['target']).toMatchObject({ type: 'SpecificResource' });
	});

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE OTHER BRANCH OF STORY 60'S CRITERION: REFUSE, WITH A MESSAGE SAYING WHY
	//
	// One shape cannot be carried — an unknown member inside an element of an array both documents
	// have, in practice a per-Control-Point note in `body.features[].properties`. The features are
	// regenerated one per Control Point, so no element reliably corresponds to the source's.
	// Silently dropping it is the option the criterion does not offer.
	describe('a member that cannot be carried at all', () => {
		const UNWRITABLE = 'third-party-with-unwritable-field';

		it('still reads, so the user can open and export the Alignment', () => {
			const alignment = parseAlignment(fixture(UNWRITABLE), { imageId });

			expect(alignment.controlPoints).toHaveLength(6);
			expect(alignment.unpreservable).toContain('body.features[0]');
			expect(alignment.unpreservable).toContain('confidence');
		});

		it('refuses the write, naming the member and saying the file is untouched', () => {
			const alignment = parseAlignment(fixture(UNWRITABLE), { imageId });

			expect(() => serialiseAlignment(alignment)).toThrow(AlignmentUnpreservableError);
			expect(() => serialiseAlignment(alignment)).toThrow(/confidence/);
			expect(() => serialiseAlignment(alignment)).toThrow(/left exactly as it is/);
		});

		it('does not refuse the sibling fixture, whose unknowns are all carryable', () => {
			// Or the refusal is just a broken writer wearing a message.
			expect(parseAlignment(fixture(NAME), { imageId }).unpreservable).toBeUndefined();
			expect(() => serialiseAlignment(parseAlignment(fixture(NAME), { imageId }))).not.toThrow();
		});
	});

	it('are absent from an Alignment this build made itself', () => {
		// So the starter written on the add is byte-identical to the starter `writeAlignmentFile`
		// compares against — "nothing has happened to this file since it was created" depends on it.
		expect(newAlignment('fresh', { width: 10, height: 10 }).unmodelled).toBeUndefined();
	});
});
