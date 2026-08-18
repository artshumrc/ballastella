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

import { generateAnnotation, parseAnnotation, validateAnnotation } from '@allmaps/annotation';
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
 * partially understood Alignment is a Map Image placed somewhere wrong, which is worse than
 * one that will not open, because nothing says it happened.
 */
export class AlignmentUnreadableError extends Error {
	constructor(imageId: string, reason: string) {
		super(`The Alignment for “${imageId}” could not be read: ${reason}`);
		this.name = 'AlignmentUnreadableError';
	}
}

/**
 * The bytes this module was about to write are not a document upstream would read back.
 *
 * **Refusing the write is the point.** Autosave fires on every gesture end, and the failure this
 * guards is not "one save was lost" but "the entire Alignment, including every Control Point, is
 * unreachable on the next open" — silently, with the file sitting there looking fine. Refusing
 * leaves the last good file on disk and puts the reason in front of the user, which is the only
 * outcome of the three in which nothing is lost.
 *
 * Two concrete holes are already plugged upstream of this — a mask vertex below 1e-6 written in
 * exponential notation, and a fractional image dimension in an `<svg width>` — and both were found
 * by reading upstream's regexes rather than by anything failing. This is the guard for the next one.
 */
export class AlignmentUnwritableError extends Error {
	constructor(imageId: string, reason: string) {
		super(
			`The Alignment for “${imageId}” was not saved, because it would not have been readable ` +
				`again: ${reason}`
		);
		this.name = 'AlignmentUnwritableError';
	}
}

/**
 * The document holds something this build can neither model nor carry, so it will not be rewritten.
 *
 * **A different failure from {@link AlignmentUnwritableError}, and it must say so.** That one means
 * "the bytes we were about to write would not be readable again". This one means the opposite: the
 * file is perfectly good, and it is *ours* that would be worse — a rewrite would drop something the
 * author put there. SPEC story 60 allows exactly two answers for an unmodelled field, preserve or
 * refuse-with-a-reason, and this is the refusal.
 *
 * The user can still open, view and export the Alignment. Only writing over it is refused.
 */
export class AlignmentUnpreservableError extends Error {
	constructor(
		readonly imageId: string,
		readonly member: string
	) {
		super(
			`The Alignment for “${imageId}” was not saved, because it carries “${member}” — something ` +
				`this version does not understand and cannot write back without discarding. The file ` +
				`has been left exactly as it is.`
		);
		this.name = 'AlignmentUnpreservableError';
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
 * Where the document says this Map Image's image is served from.
 *
 * **The only thing that differs between a local copy and a referenced remote image** (ticket 14),
 * and it is an argument here rather than a rewrite performed elsewhere because CONTEXT.md confines
 * the Georeference Annotation's own fields to this module: a second module that `JSON.parse`d this
 * one's output and reassigned `target.source.id` would be a second writer of the format, and the
 * two would drift the first time upstream moved the field.
 */
export type AlignmentAddress = {
	/**
	 * The remote image service URI a `'referenced'` Map Image's tiles come from, canonical
	 * (no trailing slash, no `/info.json`). Omit — or pass `''` — for a Map Image whose pyramid
	 * is in the Project.
	 *
	 * **Omitting it writes the ADR-0004 placeholder, which for a referenced image is a blank map.**
	 * `@allmaps/maplibre` builds every tile URL from this address, so the placeholder sends a
	 * referenced image's tile requests into the ADR-0011 injection layer, which looks for a pyramid
	 * the Project by definition does not contain. In a file it is worse than blank: a document
	 * claiming `unset.invalid` is standard-shaped and unresolvable by Allmaps or by anyone else,
	 * which is exactly the interoperability ADR-0007 is claiming (SPEC stories 91, 92).
	 */
	readonly imageService?: string;
};

/**
 * The Alignment in the in-memory document shape `@allmaps/*` consumes.
 *
 * Exported for `@allmaps/maplibre`, whose `addGeoreferencedMap` takes this rather than a
 * serialised annotation. It is here, in the one module that owns the format's vocabulary, so that
 * the renderer's caller can pass an `Alignment` and never assemble a `GeoreferencedMap` of its own
 * — two places building this object is how the *stored* Alignment and the *rendered* one come to
 * disagree, which is a Map Image drawn somewhere other than where it was saved.
 *
 * **Named for what the caller wants, not for what the format calls it.** CONTEXT.md confines
 * `GeoreferencedMap` to the module that reads and writes the format, and this function is exported
 * across that boundary — so the name that travels says "the document a renderer takes" and the
 * format's own vocabulary stays behind this file.
 *
 * **The renderer must still be told the transformation type separately, and this object cannot
 * carry it.** `WarpedMap` reads `georeferencedMap.transformation?.type` and nothing else — the
 * order beside it is ignored — so `{ type: 'polynomial', options: { order: 3 } }` reaches the
 * solver as plain `polynomial`, which is first order. Everything up to `polynomial1` is therefore
 * right by accident, and second and third order are silently downgraded. The fix is the layer's
 * own `transformationType` map option, which wins over what it read from the document; see
 * `warped-map-layer.ts`. Nothing can be done about it here, because the field this object writes
 * is the field the format defines.
 */
export function toRendererDocument(
	alignment: Alignment,
	{ imageService = '' }: AlignmentAddress = {}
): unknown {
	return {
		'@context': 'https://schemas.allmaps.org/map/2/context.json',
		type: 'GeoreferencedMap',
		resource: {
			// A referenced image's own address, or — for a locally stored pyramid — the ADR-0004
			// placeholder, which is what that pyramid's `info.json` declares and the routing key the
			// ADR-0011 injection layer matches on. Either way the Alignment names its image exactly the
			// way every other consumer of that image does; see {@link AlignmentAddress}.
			id: imageService === '' ? imageServiceId(alignment.imageId) : imageService,
			type: 'ImageService3',
			width: alignment.image.width,
			height: alignment.image.height
		},
		gcps: toRendererControlPoints(alignment),
		resourceMask: toRendererResourceMask(alignment),
		transformation: transformationTypeToTypeAndOrder(alignment.transformationType)
	};
}

/**
 * One Control Point as `@allmaps/*` states it: an image pixel paired with a place on the earth.
 *
 * The tuples are mutable because upstream's `Gcp` is, and this value is handed straight to it.
 */
export type RendererControlPoint = { resource: [number, number]; geo: [number, number] };

/**
 * The Alignment's Control Points in the shape `@allmaps/*` speaks.
 *
 * **Exported because the renderer needs them twice and must not be told two different things.** The
 * document built by {@link toRendererDocument} carries them, and so does the `gcps` *map option* that
 * moves them afterwards without rebuilding the layer — see `warped-map-layer.ts`. Two call sites
 * writing `[point.resource.x, point.resource.y]` for themselves is how a Map Image comes to be
 * drawn from coordinates that are not the ones in the file.
 */
export function toRendererControlPoints(alignment: Alignment): RendererControlPoint[] {
	return alignment.controlPoints.map((point) => ({
		resource: [point.resource.x, point.resource.y],
		geo: [point.geo.lng, point.geo.lat]
	}));
}

/** The Resource Mask as the ring `@allmaps/*` speaks, for the same reason as above. */
export function toRendererResourceMask(alignment: Alignment): [number, number][] {
	return alignment.resourceMask.map((point) => [point.x, point.y]);
}

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
 *
 * `address` says where the image is served from. It is the whole of the difference between the file
 * written for a local copy and the one written for a referenced remote image — see {@link
 * AlignmentAddress} — and it goes through `generateAnnotation` with everything else, so the Resource
 * Mask's plain-decimal fix, the absent timestamps and the validation below all apply to it.
 */
export function serialiseAlignment(alignment: Alignment, address: AlignmentAddress = {}): Bytes {
	// SPEC story 60's other branch. See {@link Alignment.unpreservable}: this document holds
	// something this build can neither model nor carry, so it is refused by name rather than
	// rewritten without it. Checked before anything is generated, so the reason is the real one.
	if (alignment.unpreservable !== undefined) {
		throw new AlignmentUnpreservableError(alignment.imageId, alignment.unpreservable);
	}
	const annotation = generateAnnotation(toRendererDocument(alignment, address));
	rewriteResourceMaskInPlainDecimal(annotation, alignment.resourceMask);
	restoreUnmodelledMembers(annotation, alignment.unmodelled);
	// **The write path checks its own output, with upstream's own validator.** `generateAnnotation`
	// does not: it will happily emit a `polygon points` attribute or an `<svg width>` that
	// `Annotation1Schema` then refuses, and the two known instances of that were both found by
	// reading regexes rather than by anything failing. Since a refused document takes the whole
	// Alignment down on the *next open* rather than at the save, and since the mask now travels
	// through a bespoke string encoder, the cheap thing is to ask before the bytes leave.
	try {
		validateAnnotation(annotation);
	} catch (cause) {
		throw new AlignmentUnwritableError(
			alignment.imageId,
			cause instanceof Error ? cause.message : String(cause)
		);
	}
	return new TextEncoder().encode(`${JSON.stringify(annotation, null, '\t')}\n`);
}

/**
 * The members of the document `raw` that this build does not model, **at every depth**, or
 * `undefined` when there are none.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS RECURSES, WHICH THE FIRST CUT DID NOT
 *
 * Diffing only the top level looks sufficient and is not, and the fixture already in this
 * repository proves it: `allmaps-shaped.json` carries `target.source.partOf`,
 * `target.source.provider` and `body._allmaps` — three members, none of them at depth 1, all of
 * them silently dropped by a top-level diff. `_allmaps` is what Allmaps itself writes. So the
 * "preserve" half of SPEC story 60 has to reach into the objects or it does not hold for the
 * documents it exists for.
 *
 * The rule is the same at every depth: a member the generated document does not have is carried
 * whole; a member both have, where both are plain objects, is recursed into. **Arrays are not
 * descended into** — `body.features` is regenerated one feature per Control Point, so there is no
 * stable correspondence between a source element and a generated one, and carrying members across
 * that would attach a colleague's annotation of point 3 to whatever ends up third. An array the
 * generated document lacks entirely is a different thing and is carried whole, which is what
 * `partOf` and `provider` are.
 *
 * That leaves exactly one shape this cannot preserve — an unknown member *inside* an element of an
 * array both documents have — and story 60's criterion allows preserving **or** refusing, not
 * silently dropping. So {@link unpreservableArrayMember} finds it and the write is refused by name.
 *
 * **Only for a single `Annotation`.** An `AnnotationPage`'s own members describe the *page* — its
 * `items` above all — and copying them onto the single Annotation this module writes would produce
 * a document carrying a stale list of maps beside the one map it actually holds, which is worse
 * than dropping them. Nothing puts a page on disk: `serialiseAlignment` writes an `Annotation`, and
 * `community-alignments.ts` splits an API page into individual annotations before any of them
 * reaches {@link parseAlignment}.
 */
function unmodelledMembers(
	raw: unknown,
	generated: unknown
): Readonly<Record<string, unknown>> | undefined {
	if (!isPlainObject(raw)) return undefined;
	if (raw['type'] !== 'Annotation') return undefined;
	return residue(raw, isPlainObject(generated) ? generated : {});
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** The members of `source` that `generated` does not have, recursively. See above for the rule. */
function residue(
	source: Record<string, unknown>,
	generated: Record<string, unknown>
): Record<string, unknown> | undefined {
	const carried: Record<string, unknown> = {};
	for (const [member, value] of Object.entries(source)) {
		const mine = generated[member];
		// `undefined` rather than `in`: `generateAnnotation` puts `created` and `modified` on the
		// object and leaves them undefined, and `JSON.stringify` then drops them — so the generated
		// document does not carry them however the key behaves.
		if (mine === undefined) {
			carried[member] = value;
			continue;
		}
		if (!isPlainObject(value) || !isPlainObject(mine)) continue;
		const deeper = residue(value, mine);
		if (deeper) carried[member] = deeper;
	}
	return Object.keys(carried).length > 0 ? carried : undefined;
}

/**
 * The path of an unknown member inside an element of an array both documents carry, or `''`.
 *
 * The one shape {@link residue} cannot preserve, found so that the write can be refused rather than
 * quietly losing it (SPEC story 60 offers preserve or refuse, and nothing else). In practice this is
 * a per-Control-Point annotation somebody's tool wrote into `body.features[].properties`.
 */
function unpreservableArrayMember(
	source: Record<string, unknown>,
	generated: Record<string, unknown>,
	at = ''
): string {
	for (const [member, value] of Object.entries(source)) {
		const mine = generated[member];
		if (mine === undefined) continue;
		const here = at === '' ? member : `${at}.${member}`;
		if (Array.isArray(value) && Array.isArray(mine)) {
			for (const [index, element] of value.entries()) {
				if (!isPlainObject(element)) continue;
				// Against *every* generated element, not the one at the same index: the orders need not
				// agree, and the question is whether this member is one this build ever writes at all.
				const known = mine.filter(isPlainObject);
				const extra = residue(element, mergedShape(known));
				if (extra) return `${here}[${index}].${deepestPath(extra)}`;
			}
			continue;
		}
		if (!isPlainObject(value) || !isPlainObject(mine)) continue;
		const deeper = unpreservableArrayMember(value, mine, here);
		if (deeper !== '') return deeper;
	}
	return '';
}

/**
 * The dotted path down to the first leaf of a residue, so the refusal names the member the user's
 * tool actually wrote rather than the `properties` object it happens to sit in.
 */
function deepestPath(carried: Record<string, unknown>): string {
	const member = Object.keys(carried)[0] as string;
	const value = carried[member];
	return isPlainObject(value) ? `${member}.${deepestPath(value)}` : member;
}

/** Every member any of `objects` has, so "does this build ever write this member?" has one answer. */
function mergedShape(objects: readonly Record<string, unknown>[]): Record<string, unknown> {
	const shape: Record<string, unknown> = {};
	for (const one of objects) {
		for (const [member, value] of Object.entries(one)) {
			if (shape[member] === undefined) shape[member] = value;
		}
	}
	return shape;
}

/**
 * Put back the members {@link unmodelledMembers} carried, onto the document about to be written.
 *
 * **A member this build authors always wins**, which is why the `in` check is here rather than a
 * spread: the carried members were classified as unmodelled when the file was *read*, and if
 * upstream has since started writing one of them, the value this build just generated is the
 * current one and the carried value is a year old. Silently preferring the stale one would be the
 * same class of defect this whole preservation exists to fix, pointing the other way.
 *
 * Appended after the generated members, so a document this build authored and one it round-tripped
 * differ only by the members that were actually in the file — and serialising is still
 * deterministic, because object key order here is insertion order over a fixed input.
 */
function restoreUnmodelledMembers(
	annotation: unknown,
	unmodelled: Readonly<Record<string, unknown>> | undefined
): void {
	if (!unmodelled || !isPlainObject(annotation)) return;
	for (const [member, value] of Object.entries(unmodelled)) {
		const mine = annotation[member];
		// `!== undefined` rather than `in`, for the same reason {@link residue} tests on it: `created`
		// and `modified` are present on the generated object and undefined, so `in` would refuse to
		// restore a colleague's timestamp in favour of a member that is about to disappear.
		if (mine === undefined) {
			annotation[member] = value;
			continue;
		}
		// Both are objects and the carried one holds only what the generated one lacks, so this puts
		// `target.source.provider` back without touching the `id`, `width` and `height` beside it that
		// this build has just recomputed.
		if (isPlainObject(mine) && isPlainObject(value)) restoreUnmodelledMembers(mine, value);
	}
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
 * **Editing the mask is what makes that state reachable**, and it is now editable: a vertex
 * dragged towards the image origin, or a vertex inserted at the midpoint of an edge that already
 * has a tiny coordinate, lands under 1e-6 without anything unusual happening. This was fixed
 * before the mask was editable, on the grounds that the failure is silent, arrives on *reopening*
 * rather than on saving, and costs the user everything rather than the one vertex that provoked
 * it; the editing path is asserted against it directly.
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
 * `imageId` is the authority on which Map Image this aligns, because the Alignment's
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
		throw new AlignmentUnreadableError(imageId, 'it does not say how large the Map Image is');
	}

	// ─────────────────────────────────────────────────────────────────────────────────────
	// THE IMAGE'S PIXEL DIMENSIONS ARE FORCED TO WHOLE PIXELS, AND THAT IS NOT COSMETIC
	//
	// **Exactly the same landmine as the sub-1e-6 mask vertex, on a field this module copies rather
	// than computes.** The two halves of it, measured against the pinned
	// `@allmaps/annotation@1.0.0-beta.37`:
	//
	//   * `Source2Schema` validates `width` and `height` as `z.number().positive()` — a *fractional*
	//     dimension parses happily.
	//   * The SVG selector `generateAnnotation` writes is validated against
	//     `^<svg\s+width="\d+"\s+height="\d+"\s*>…` — **integers only** — and one of the accepted
	//     branches is `<svg>` with no dimensions at all, which is what lets a document carrying a
	//     fractional `resource.width` past the reader in the first place.
	//
	// So a colleague's Alignment with a fractional image width is readable here, and would be
	// re-written by us as `<svg width="5120.25" …>`: a file upstream refuses **entirely**, taking
	// every Control Point with it, silently, on the *next* open rather than on the save.
	//
	// Rounded rather than refused, because refusing costs the user everything to protect a field
	// nothing is placed by: an image is a whole number of pixels, no Control Point or mask vertex
	// moves, and the only things derived from these numbers are the *fallback* Resource Mask and the
	// renderer's full-image extent. The map itself is placed by the Control Points.
	const image = { width: Math.round(width), height: Math.round(height) };

	const modelled: Alignment = {
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

	// ─────────────────────────────────────────────────────────────────────────────────────
	// WHATEVER ELSE WAS IN THE FILE
	//
	// Diffed against what this build *would* write for the very Alignment just read, rather than
	// against a hand-kept list of member names. A list drifts the first time upstream adds a member:
	// this module would go on calling it unmodelled and a round trip would then write the document's
	// stale value beside the fresh one it had just generated. Asking `generateAnnotation` cannot
	// drift, because it is the same function whose output is being classified.
	//
	// The cost is one extra `generateAnnotation` per parse, and `parseAlignment` runs once per map
	// Layer when the sidebar opens (ADR-0023's accepted cost). Measured against the alternative —
	// silently discarding a colleague's `_allmaps` block — it is not close.
	const generated = generateAnnotation(toRendererDocument(modelled)) as Record<string, unknown>;
	const unmodelled = unmodelledMembers(raw, generated);
	const unpreservable = isPlainObject(raw) ? unpreservableArrayMember(raw, generated) : '';

	return {
		...modelled,
		// Carried rather than understood, and written straight back by `serialiseAlignment` — see
		// {@link Alignment.unmodelled} for why an Alignment shared by every Project cannot afford to
		// regenerate a third party's document from this build's own model.
		...(unmodelled ? { unmodelled } : {}),
		...(unpreservable === '' ? {} : { unpreservable })
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
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE POLYNOMIAL ORDER IS READ HERE, BECAUSE UPSTREAM'S OWN INVERSE DROPS IT
 *
 * `typeAndOrderToTransformationType` is the documented inverse of
 * `transformationTypeToTypeAndOrder`, and for second- and third-order polynomials **it is not**.
 * Measured against the pinned `@allmaps/transform@1.0.0-beta.52`, its first branch is
 *
 *     if (type == 'polynomial1' || type === 'polynomial') transformationType = 'polynomial1'
 *
 * and the `order === 2` and `order === 3` branches that follow are guarded on
 * `type === 'polynomial'` — which the first branch has already claimed. So they are unreachable,
 * and `{ type: 'polynomial', options: { order: 3 } }` comes back as `polynomial1`.
 *
 * **The file is fine; the helper is not.** `generateAnnotation` writes the order and
 * `parseAnnotation` reads it back unchanged, verified in both directions, so a document written by
 * this module is correct and interoperable — anything that reads the order gets the order. What
 * would be lost by trusting the helper is our *own* read: a user who chose Higher-order (3rd),
 * saved, and reopened would silently get an affine Alignment, with every coordinate in the file
 * intact and the map placed wrongly. That is precisely the failure mode ADR-0010's round-trip
 * fixtures exist to catch, so the order is read directly and pinned by a test that fails when
 * upstream fixes the helper.
 */
function readTransformationType(transformation: unknown): TransformationType {
	if (!transformation) return DEFAULT_TRANSFORMATION_TYPE;

	const { type, options } = transformation as {
		type?: unknown;
		options?: { order?: unknown };
	};

	// The polynomial family, where the order is the whole of the distinction. `polynomial` is the
	// only name upstream's Zod enum accepts for it, so this is the branch every order arrives on.
	if (type === 'polynomial' || type === 'polynomial1') {
		const order = options?.order;
		if (order === undefined || order === 1) return 'polynomial1';
		if (order === 2) return 'polynomial2';
		if (order === 3) return 'polynomial3';
		// A fourth-order polynomial is a real thing upstream's solver does not offer and this
		// codebase cannot hold. The Control Points are still readable, so the lens falls back.
		return DEFAULT_TRANSFORMATION_TYPE;
	}

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
