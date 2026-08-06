// The Alignment's file format: a IIIF Georeference Annotation, read and written by
// `@allmaps/annotation`.
//
// **This is the only module in the codebase permitted the words "Georeference Annotation" and
// `GeoreferencedMap`** (CONTEXT.md). They are a file format, never a user-facing concept, and
// keeping them behind this boundary is what stops a pre-1.0 package's document shape from
// becoming the shape the application reasons about. Everything above this file sees `Alignment`.
//
// The format is standard and stands on its own: the file is readable by Allmaps and by anything
// else that implements the IIIF Georeference Extension (SPEC story 91), and a Project therefore
// consists of standard formats with no proprietary index (story 94).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE TRANSFORMATION TYPE IS NOT WRITTEN AS ITS OWN NAME, AND CANNOT BE
//
// ADR-0013 says to store the canonical Allmaps string `polynomial1`, never the alias
// `polynomial`. Taken literally that is impossible, and taking it literally silently destroys
// the field. Measured against the pinned `@allmaps/annotation@1.0.0-beta.37`:
//
//   * The annotation's `transformation` is validated by a Zod enum of
//     `helmert | polynomial | thinPlateSpline | projective | straight | linear`. **`polynomial1`
//     is not in it.** The schema is `parseIfValid(ValidTransformationSchema).or(…)`, and
//     `parseIfValid` wraps `z.unknown().transform(…)`, which always *succeeds* — returning
//     `undefined` when the inner parse failed. So the `.or(…)` fallback, which does know how to
//     read `polynomial1`, is unreachable dead code.
//   * Consequently `generateAnnotation({ …, transformation: { type: 'polynomial1' } })` writes
//     **no transformation at all**, and `parseAnnotation` of a hand-built file containing
//     `polynomial1` returns `transformation: undefined`. Verified both directions.
//
// So writing the literal name loses the type — the same failure ADR-0013 cites as its reason for
// banning `straight`, arriving by a different route. What the format actually carries is a type
// and an order as separate fields, and the translation between that pair and the canonical name
// is `transformationTypeToTypeAndOrder` / `typeAndOrderToTransformationType` — the two upstream
// functions ADR-0013 itself names. `polynomial1` therefore round-trips as
// `{ type: 'polynomial', options: { order: 1 } }`, which:
//
//   * survives `generateAnnotation` and `parseAnnotation` unchanged,
//   * comes back as exactly `polynomial1` through `typeAndOrderToTransformationType`,
//   * is **not** the bare alias ADR-0013 forbids — the order is explicit, so nothing is left to
//     be inferred, which is the ambiguity the ADR is actually written against, and
//   * is what `@allmaps/render` reads: `WarpedMap` takes `transformation.type` directly and
//     treats `polynomial` and `polynomial1` as the same transformer.
//
// `straight` is never written, and cannot be: it is unreachable from
// `TransformationType`, which excludes it.

import { generateAnnotation, parseAnnotation } from '@allmaps/annotation';
import {
	transformationTypeToTypeAndOrder,
	typeAndOrderToTransformationType
} from '@allmaps/transform';

import type { ResourcePoint } from '../image-pane/synthetic-projection.js';
import type { Bytes } from '../store/project-store.js';
import { imageServiceId } from '../tiler/pyramid.js';
import {
	DEFAULT_TRANSFORMATION_TYPE,
	fullImageResourceMask,
	type Alignment,
	type ControlPoint,
	type GeoPoint,
	type TransformationType
} from './alignment.js';

/**
 * The file is not an Alignment — truncated, not JSON, or not a Georeference Annotation.
 *
 * Refused rather than half-read, and for the same reason `ProjectFileUnreadableError` is: a
 * partially understood Alignment is a Historical Map placed somewhere wrong, which is worse than
 * one that will not open, because nothing says it happened.
 */
export class AlignmentUnreadableError extends Error {
	constructor(imageId: string, reason: string) {
		super(`The Alignment for “${imageId}” could not be read: ${reason}`);
		this.name = 'AlignmentUnreadableError';
	}
}

/** The transformation types this codebase can hold, for narrowing what upstream hands back. */
const KNOWN_TRANSFORMATION_TYPES: readonly TransformationType[] = [
	'helmert',
	'polynomial1',
	'polynomial2',
	'polynomial3',
	'projective',
	'thinPlateSpline',
	'linear'
];

/**
 * Serialise an Alignment as a IIIF Georeference Annotation.
 *
 * Tab-indented with a trailing newline, matching `serialiseProjectFile`, so a Workspace kept in
 * git produces diffs a human can read.
 *
 * **Deterministic: there is no clock in the output.** `created` and `modified` are deliberately
 * omitted, so serialising an unchanged Alignment is byte-identical. Two things need that. A
 * timestamp would make every write a diff even when nothing moved, which ADR-0010 objects to for
 * `project.json` and objects to here for the same reason; and ticket 09 has to show that
 * reordering or renaming a Layer leaves `alignments/*.json` byte-identical, which is not a
 * testable claim against a file that stamps the time it was written. When the Project was last
 * touched is already recorded, once, in `project.json`'s `updatedAt`.
 *
 * The annotation carries no `id` either: an Alignment's identity is its path, the same discipline
 * ADR-0008 applies to a Project, and minting a second identifier would create something that can
 * disagree with the filename.
 */
export function serialiseAlignment(alignment: Alignment): Bytes {
	const georeferencedMap = {
		'@context': 'https://schemas.allmaps.org/map/2/context.json',
		type: 'GeoreferencedMap',
		resource: {
			// The ADR-0004 placeholder, on purpose. It is what a locally stored pyramid's `info.json`
			// declares, and it is the routing key the ADR-0011 injection layer matches on — so the
			// Alignment names its image exactly the way every other consumer of that image does.
			id: imageServiceId(alignment.imageId),
			type: 'ImageService3',
			width: alignment.image.width,
			height: alignment.image.height
		},
		gcps: alignment.controlPoints.map((point) => ({
			resource: [point.resource.x, point.resource.y],
			geo: [point.geo.lng, point.geo.lat]
		})),
		resourceMask: alignment.resourceMask.map((point) => [point.x, point.y]),
		transformation: transformationTypeToTypeAndOrder(alignment.transformationType)
	};

	const annotation = generateAnnotation(georeferencedMap);
	rewriteResourceMaskInPlainDecimal(annotation, alignment.resourceMask);
	return new TextEncoder().encode(`${JSON.stringify(annotation, null, '\t')}\n`);
}

/**
 * Rewrite the mask's `points` so every vertex is in plain decimal notation.
 *
 * **Without this, a Resource Mask vertex very close to the image origin produces a file that
 * `@allmaps/annotation` writes happily and then cannot read.** The mask is the one part of the
 * document that does not travel as JSON numbers: `generateAnnotation` stringifies it into an SVG
 * `polygon points` attribute with `Array#join`, and `Annotation1Schema` then validates that
 * attribute against a regex whose number pattern is `-?\d+(\.\d+)?` — **plain decimal only**.
 * `Number#toString` switches to exponential notation below 1e-6, so a vertex at, say, 1.5e-7
 * image pixels is emitted as `1.5e-7`, matches no branch of that regex, and takes the *entire*
 * Alignment down with it: `parseAnnotation` throws on the selector and the Control Points are
 * unreachable. Verified against the pinned `@allmaps/annotation@1.0.0-beta.37`.
 *
 * Nothing in this slice can reach that state — the mask is the full image rectangle and its
 * vertices are integers (ADR-0013; editing it is ticket 08). It is fixed here anyway because the
 * failure is silent, arrives on *reopening* rather than on saving, and costs the user everything
 * rather than the one vertex that provoked it.
 *
 * **No precision is given up.** This changes the notation and not the value: the shortest
 * representation of a float64 round-trips by definition, and expanding it to plain decimal is an
 * exact decimal transformation, so `parseFloat` recovers the identical double. That is asserted
 * on the `awkward-coordinates` fixture, whose first vertex is exactly this case.
 */
function rewriteResourceMaskInPlainDecimal(
	annotation: unknown,
	resourceMask: readonly ResourcePoint[]
): void {
	const selector = (annotation as { target?: { selector?: { value?: unknown } } }).target?.selector;
	if (!selector || typeof selector.value !== 'string') return;
	const points = resourceMask
		.map((point) => `${toPlainDecimal(point.x)},${toPlainDecimal(point.y)}`)
		.join(' ');
	selector.value = selector.value.replace(/points="[^"]*"/, `points="${points}"`);
}

/**
 * `value` in plain decimal notation, never exponential, with every significant digit kept.
 *
 * Built from `String(value)` — the shortest representation that round-trips — and then expanded,
 * so the result parses back to the identical double.
 */
function toPlainDecimal(value: number): string {
	// No guard for a non-finite vertex: `generateAnnotation` has already refused one by the time
	// this runs — `resourceMask` is `z.number()`, which rejects NaN and both infinities — so a
	// check here would be unreachable. Asserted in the test, so the day upstream stops refusing
	// them is the day this needs one.
	const shortest = String(value);
	const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(shortest);
	if (!match) return shortest;

	const [, sign, whole, fraction = '', exponentText] = match;
	const digits = `${whole}${fraction}`;
	// Where the decimal point sits, counted from the left of `digits`.
	const pointAt = (whole as string).length + Number(exponentText);

	if (pointAt <= 0) return `${sign}0.${'0'.repeat(-pointAt)}${digits}`;
	if (pointAt >= digits.length) return `${sign}${digits}${'0'.repeat(pointAt - digits.length)}`;
	return `${sign}${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
}

/**
 * Read an Alignment from a IIIF Georeference Annotation.
 *
 * `imageId` is the authority on which Historical Map this aligns, because the Alignment's
 * identity is its path. The document's `resource.id` is not consulted for identity — a file
 * copied under a different name would otherwise claim the image it used to describe.
 */
export function parseAlignment(bytes: Uint8Array, options: { imageId: string }): Alignment {
	const { imageId } = options;

	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch (cause) {
		throw new AlignmentUnreadableError(
			imageId,
			cause instanceof Error ? cause.message : String(cause)
		);
	}

	let maps;
	try {
		maps = parseAnnotation(raw);
	} catch (cause) {
		throw new AlignmentUnreadableError(
			imageId,
			`it is not a Georeference Annotation (${cause instanceof Error ? cause.message : String(cause)})`
		);
	}

	const map = maps[0];
	if (!map) {
		throw new AlignmentUnreadableError(imageId, 'it contains no georeferenced map');
	}

	const { width, height } = map.resource;
	if (typeof width !== 'number' || typeof height !== 'number') {
		// Both are `optional().catch(undefined)` upstream, so a document missing them parses fine and
		// leaves us with no pixel dimensions — and every coordinate in the file is in image pixels,
		// so without them the Resource Mask cannot be defaulted and the renderer cannot place
		// anything. Refused with the reason rather than guessed at.
		throw new AlignmentUnreadableError(
			imageId,
			'it does not say how large the Historical Map image is'
		);
	}

	const image = { width, height };

	return {
		imageId,
		image,
		controlPoints: map.gcps.map((gcp, index) => toControlPoint(gcp, index)),
		// Upstream's parser refuses a mask of fewer than three points outright, so anything that
		// arrives here is usable; the fallback covers only a document that omits it entirely.
		resourceMask:
			map.resourceMask.length >= 3
				? map.resourceMask.map(([x, y]) => ({ x, y }) as ResourcePoint)
				: fullImageResourceMask(image),
		transformationType: readTransformationType(map.transformation)
	};
}

function toControlPoint(
	gcp: { resource: readonly [number, number]; geo: readonly [number, number] },
	index: number
): ControlPoint {
	const [x, y] = gcp.resource;
	const [lng, lat] = gcp.geo;
	return {
		// The file carries no per-point identifier, and adding one would be the proprietary index
		// SPEC story 94 rules out. Position is identity, which is also what the ordinal is derived
		// from, so the two cannot disagree.
		id: `${index}`,
		ordinal: index + 1,
		resource: { x, y } satisfies ResourcePoint,
		geo: { lng, lat } satisfies GeoPoint
	};
}

/**
 * The canonical type name for what the file carried, or the default when it carried nothing
 * legible.
 *
 * Falling back rather than refusing, and only here: a missing or unrecognised transformation
 * still leaves the Control Points — the user's actual labour — perfectly readable, and
 * `@allmaps/render` itself defaults to first-order polynomial when the field is absent. Refusing
 * the whole Alignment over it would discard the work to protect a field with a safe default.
 */
function readTransformationType(transformation: unknown): TransformationType {
	if (!transformation) return DEFAULT_TRANSFORMATION_TYPE;
	let name: string;
	try {
		name = typeAndOrderToTransformationType(
			transformation as Parameters<typeof typeAndOrderToTransformationType>[0]
		);
	} catch {
		// `straight` lands here: it is a member of upstream's own union and
		// `typeAndOrderToTransformationType` throws on it (ADR-0013), so a document written by
		// something that did offer it must not take the Alignment down with it.
		return DEFAULT_TRANSFORMATION_TYPE;
	}
	return KNOWN_TRANSFORMATION_TYPES.includes(name as TransformationType)
		? (name as TransformationType)
		: DEFAULT_TRANSFORMATION_TYPE;
}
