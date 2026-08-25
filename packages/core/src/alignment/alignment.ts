// The Alignment: what a scholar makes when they say "this feature on the map is *there* on the
// earth", and the artifact that records it (CONTEXT.md, Align / Alignment).
//
// Nothing here knows the file format. The words "Georeference Annotation" and
// `GeoreferencedMap` belong to `georeference-annotation.ts` alone, which is the one module
// allowed to use them (CONTEXT.md); this file is the domain, and it is deliberately free of
// `@allmaps/*` so that the shape the app reasons about is ours rather than a pre-1.0 package's.

import type { ResourcePoint } from '../image-pane/synthetic-projection.js';
import type { AlignmentPath } from '../store/project-store.js';

/** A place on the earth, in the coordinates the Base Map pane speaks. */
export type GeoPoint = { lng: number; lat: number };

/**
 * A single correspondence between one point on a Map Image and one point on the
 * earth (CONTEXT.md, Control Point).
 *
 * **Both halves are required, and that is structural rather than validated.** A Control Point
 * without both halves is incomplete, not merely empty (ADR-0022), and it cannot exist in the
 * file at all — so the type that reaches storage cannot express one. The half a user has
 * clicked but not yet matched is a {@link DraftControlPoint}, which is UI state.
 */
export interface ControlPoint {
	readonly id: string;
	/**
	 * 1-based and visible to the user, so an instructor can say "look at point 7" (ADR-0022).
	 *
	 * **Derived from position, never stored.** A Georeference Annotation has nowhere to put an
	 * ordinal, and inventing a place — a sidecar index, or a private `_allmaps` key — would put a
	 * proprietary index in a file a librarian is meant to be able to preserve (SPEC story 94). So
	 * the order of the pairs in the file *is* the numbering, which is what makes ordinals stable
	 * across a reload without anything being written to hold them. The cost is that deleting
	 * point 3 of 5 renumbers the two after it; the benefit is that there is no second source of
	 * truth to drift.
	 */
	readonly ordinal: number;
	/** Image pixels. Never a lng/lat: the pane's synthetic geography must not escape (ADR-0005). */
	readonly resource: ResourcePoint;
	readonly geo: GeoPoint;
}

/**
 * A Control Point being made, which may still be missing a half.
 *
 * This is the shape the pairing UI holds, and the only shape in which an incomplete pair
 * exists. It is separate from {@link ControlPoint} rather than being the same type with
 * optional fields, because the whole point of ADR-0022's rule is that the incomplete state
 * cannot reach the file — and a type with two optional halves would reach it happily, once,
 * and write an invalid GCP.
 */
export interface DraftControlPoint {
	readonly id: string;
	readonly resource: ResourcePoint | null;
	readonly geo: GeoPoint | null;
}

/**
 * The canonical Allmaps transformation-type names (ADR-0013).
 *
 * These are the names `@allmaps/transform` uses, and they are what this codebase holds in
 * memory and shows the user. They are **not** what the file carries: the annotation encodes a
 * type and an order separately, and `georeference-annotation.ts` is where the two meet.
 *
 * `straight` is deliberately absent — ADR-0013: it is not round-trippable, and
 * `typeAndOrderToTransformationType` throws on it. So is the bare alias `polynomial`, which
 * means `polynomial1` and is ambiguous about the order.
 */
export type TransformationType =
	| 'helmert'
	| 'polynomial1'
	| 'polynomial2'
	| 'polynomial3'
	| 'projective'
	| 'thinPlateSpline'
	/** Recognised upstream and distinct from `polynomial1`, but never offered (ADR-0013). Kept so
	 * that reading a colleague's Alignment does not silently change its type. */
	| 'linear';

/**
 * The default: what a new Alignment starts as, and what an unreadable type falls back to.
 */
export const DEFAULT_TRANSFORMATION_TYPE: TransformationType = 'polynomial1';

/**
 * How many Control Points each transformation type needs before it can be solved (ADR-0013).
 *
 * Below this the solve is under-determined and yields either a thrown error or a garbage warp,
 * so the count gates the type rather than the type being settable into a state the solver
 * cannot handle.
 */
export const MINIMUM_CONTROL_POINTS: Readonly<Record<TransformationType, number>> = {
	helmert: 2,
	polynomial1: 3,
	polynomial2: 6,
	polynomial3: 10,
	projective: 4,
	thinPlateSpline: 3,
	linear: 3
};

/**
 * The three names upstream recognises that are **never** offered and never written (ADR-0013).
 *
 * Kept as data rather than as prose so the rule is assertable: `straight` throws in
 * `typeAndOrderToTransformationType`, so offering it produces Alignments that fail to
 * deserialize; the bare `polynomial` is an alias for `polynomial1` that leaves the order to be
 * inferred; and `linear` is recognised as distinct but has no documented user-facing meaning.
 *
 * Two of the three are structurally unreachable — {@link TransformationType} excludes them — and
 * `linear` is reachable only by *reading* a colleague's file, never by choosing it.
 */
export const NEVER_OFFERED_TRANSFORMATION_NAMES = ['straight', 'polynomial', 'linear'] as const;

/** Whether a type is behind the Advanced disclosure (ADR-0013's two tiers). */
export type TransformationTier = 'primary' | 'advanced';

/**
 * One row of the transformation picker (ADR-0013).
 *
 * **The guidance is the primary text and the label is secondary**, which is a decision about the
 * interface but is recorded here rather than in a component: it is the ADR's table, it is the one
 * place the six offered types are enumerated, and "these four are primary, these two are behind
 * Advanced, and none of the three banned names appears" is then a question a unit test can ask.
 */
export interface TransformationChoice {
	/** The canonical Allmaps name, and what is stored. */
	readonly type: TransformationType;
	readonly tier: TransformationTier;
	/** Secondary text. "Standard" is not what a historian can act on; the guidance is. */
	readonly label: string;
	/** The primary text (ADR-0013). */
	readonly guidance: string;
	/** Below this the solve is under-determined, so the count gates the type. */
	readonly minimumControlPoints: number;
}

/**
 * The picker, in the order it is offered: four primary, then two behind Advanced (ADR-0013).
 *
 * `minimumControlPoints` is read out of {@link MINIMUM_CONTROL_POINTS} rather than repeated, so
 * the number the picker gates on and the number {@link canSolve} gates on cannot drift apart —
 * which would mean an option the user is allowed to choose and the renderer then refuses.
 */
export const TRANSFORMATION_CHOICES: readonly TransformationChoice[] = [
	{
		type: 'helmert',
		tier: 'primary',
		label: 'Simple',
		guidance: 'Accurate modern maps — rotate, scale, and move only',
		minimumControlPoints: MINIMUM_CONTROL_POINTS.helmert
	},
	{
		type: 'polynomial1',
		tier: 'primary',
		label: 'Standard',
		guidance: 'Most printed and scanned maps',
		minimumControlPoints: MINIMUM_CONTROL_POINTS.polynomial1
	},
	{
		type: 'projective',
		tier: 'primary',
		label: 'Perspective',
		guidance: 'Maps photographed at an angle',
		minimumControlPoints: MINIMUM_CONTROL_POINTS.projective
	},
	{
		type: 'thinPlateSpline',
		tier: 'primary',
		label: 'Flexible',
		guidance: 'Hand-drawn or geometrically inconsistent maps',
		minimumControlPoints: MINIMUM_CONTROL_POINTS.thinPlateSpline
	},
	{
		type: 'polynomial2',
		tier: 'advanced',
		label: 'Higher-order (2nd)',
		guidance: 'Only with many well-spread points',
		minimumControlPoints: MINIMUM_CONTROL_POINTS.polynomial2
	},
	{
		type: 'polynomial3',
		tier: 'advanced',
		label: 'Higher-order (3rd)',
		guidance: 'Only with many well-spread points',
		minimumControlPoints: MINIMUM_CONTROL_POINTS.polynomial3
	}
];

/** Whether `name` is a type the user may choose. `false` for the three banned names. */
export function isTransformationOffered(name: string): boolean {
	return TRANSFORMATION_CHOICES.some((choice) => choice.type === name);
}

/**
 * Why `type` cannot be chosen with `controlPointCount` points, or `''` when it can.
 *
 * **The shortfall is named, not merely implied by a disabled control** (ADR-0013): "Flexible needs
 * at least 3 Control Points — you have 2" tells the user what to do next, where a greyed-out
 * option tells them only that something is wrong. It matters most in the Advanced tier, where ten
 * points is a lot to accumulate before the option becomes legible.
 */
export function transformationShortfall(
	type: TransformationType,
	controlPointCount: number
): string {
	const needed = MINIMUM_CONTROL_POINTS[type];
	if (controlPointCount >= needed) return '';
	const choice = TRANSFORMATION_CHOICES.find((one) => one.type === type);
	const name = choice ? choice.label : type;
	const points = needed === 1 ? 'Control Point' : 'Control Points';
	return `${name} needs at least ${needed} ${points} — you have ${controlPointCount}`;
}

/**
 * The same Alignment under a different transformation type.
 *
 * **Every Control Point and the Resource Mask survive**, which is the whole reason this exists as
 * a named function rather than an object spread at the call site. ADR-0013: the Control Points are
 * the user's actual labour and the transformation is a lens over them, so the obvious
 * implementation — reset on change — destroys work.
 */
export function withTransformationType(
	alignment: Alignment,
	transformationType: TransformationType
): Alignment {
	return { ...alignment, transformationType };
}

/**
 * One Map Image's correspondence with the earth: its Control Points, its Resource Mask,
 * and its transformation type (CONTEXT.md, Align / Alignment).
 */
export interface Alignment {
	/** Which Map Image of the Workspace this aligns. Its identity is its file path. */
	readonly imageId: string;
	/** The image's pixel dimensions, which the Resource Mask and the renderer are both in terms of. */
	readonly image: { readonly width: number; readonly height: number };
	/** Complete pairs only, in ordinal order. */
	readonly controlPoints: readonly ControlPoint[];
	/**
	 * The outline of the part of the image to show once aligned (CONTEXT.md, Resource Mask).
	 *
	 * Defaults to the full image rectangle and is editable from there — never empty, because an
	 * empty mask renders nothing, which reads as a broken tool on a user's first Alignment
	 * (ADR-0013). {@link MINIMUM_MASK_VERTICES} is what keeps it from being emptied by editing.
	 */
	readonly resourceMask: readonly ResourcePoint[];
	readonly transformationType: TransformationType;
	/**
	 * The top-level members of the file this Alignment was read from that this build does not model
	 * — **carried rather than understood**, and written back verbatim (SPEC story 60, ticket 18).
	 *
	 * Absent for an Alignment this build made; present only for one parsed from a document somebody
	 * else wrote. Nothing reads it but `serialiseAlignment`, which puts every member back exactly as
	 * it found it and never lets one overwrite a field this build authors.
	 *
	 * **Why it exists at all.** ADR-0023 made `alignments/<image-id>.json` the Workspace's, shared by
	 * every Project, and `serialiseAlignment` regenerates the whole document from this type — so
	 * before this field, any member of a third-party Georeference Annotation that `Alignment` does
	 * not model was dropped the first time anybody nudged a Control Point. Silently, and in a file a
	 * librarian is meant to be able to preserve. Story 60 asks that an Alignment made here stay
	 * usable by other IIIF tools; that has to include the ones that put something in the file.
	 *
	 * It is deliberately the *whole* member and not a parsed shape: this build has no idea what the
	 * member means, and the only safe thing to do with a value you do not understand is hand it back
	 * unchanged.
	 */
	readonly unmodelled?: Readonly<Record<string, unknown>>;
	/**
	 * The path of a member of the source document that **cannot** be carried, or absent.
	 *
	 * SPEC story 60's criterion is that an unmodelled field survives a read-and-write cycle **or**
	 * that the write is refused with a message saying why. {@link unmodelled} is the first half.
	 * This is the second, and it exists because there is exactly one shape the first half cannot
	 * cover: a member inside an element of an array both documents have — in practice something a
	 * colleague's tool wrote into `body.features[].properties`. The features are regenerated one per
	 * Control Point, so there is no element that reliably corresponds to the source's, and carrying
	 * the member anyway would attach their note about point 3 to whatever ends up third.
	 *
	 * So the Alignment still **reads** — the user can open it, see it, and export it — and
	 * `serialiseAlignment` refuses to write it, naming the member. Refusing to save is a bad day;
	 * silently rewriting somebody's file with their annotations missing is a worse one, and is the
	 * failure this whole ticket is about.
	 */
	readonly unpreservable?: string;
}

/**
 * Where the **Workspace** keeps one Map Image's Alignment (ADR-0023).
 *
 * At the Workspace root rather than inside a Project, because "where is this map on the earth" has to
 * have one answer. The rejected shape copied the Alignment into each Project, and *N* answers drift:
 * a referenced map's Alignment records the Library's service as its `resource.id`, so one offline copy
 * left every other Project naming a Library whose tiles were already on disk.
 */
export const ALIGNMENT_DIRECTORY = 'alignments';

/**
 * The Alignment's path in the Workspace. A store path, complete — nothing prefixes a Project
 * directory onto it, and `scripts/check-workspace-rooted-paths.mjs` refuses anything that does.
 *
 * The path is the Alignment's identity, the same way a Project's is its folder, which is why
 * `parseAlignment` takes the image id from the caller and never from the document's own
 * `resource.id`.
 *
 * **{@link AlignmentPath}, not `string`, and that is the fence** (ticket 18). The brand is a phantom
 * property — the value is the same string it always was — and its whole job is that `store.write`
 * and `Autosave.commit` take a `WritablePath`, which an `AlignmentPath` is not. Reading, listing,
 * sizing and deleting take it unchanged; writing does not compile. `alignment-file.ts` is the only
 * module that may cross, and it will not do so without being told which of create / update /
 * replace the caller means.
 */
export const alignmentPath = (imageId: string): AlignmentPath =>
	`${ALIGNMENT_DIRECTORY}/${imageId}.json` as AlignmentPath;

/**
 * The Map Image id in an `alignments/<id>.json`, or `null` for any other path.
 *
 * The inverse of {@link alignmentPath}, and the way a caller holding an arbitrary store path asks
 * whether it names an Alignment — which decides whether the write has to go through
 * `alignment-file.ts` and name an intent (ticket 18) rather than through an ordinary save.
 *
 * Deliberately as narrow as `hoistedImageId`'s Alignment half: exactly two segments, a non-empty
 * stem, and a `.json` suffix. Anything looser routes a path this application never writes into the
 * Alignment writer, which is the opposite of a guard.
 *
 * ⚠ **Narrowing or loosening this moves several branches and their guards together, in the same
 * direction, silently.** `replay.ts` is the sharpest case: both the routing in its `write` and the
 * refusal in its `writePlain` ask this one question, so a path it stopped recognising would be sent
 * to the plain write *and* waved through by the refusal that exists to catch exactly that. The
 * Update, review and tar readers consult it for the same decision. `alignment.test.ts` pins it
 * against the spellings on both sides of the line, so such a change is a red test rather than a
 * quiet hole.
 */
export function alignmentImageId(path: string): string | null {
	const segments = path.split('/');
	if (segments.length !== 2 || segments[0] !== ALIGNMENT_DIRECTORY) return null;
	const name = segments[1] ?? '';
	return name.endsWith('.json') && name.length > '.json'.length
		? name.slice(0, -'.json'.length)
		: null;
}

/**
 * The whole image, clockwise from its top-left corner.
 *
 * The Resource Mask a new Alignment starts with (ADR-0013: not empty, because an empty mask
 * renders nothing and reads as the tool being broken), and what "show the whole sheet again"
 * resets to.
 */
export function fullImageResourceMask(image: {
	width: number;
	height: number;
}): readonly ResourcePoint[] {
	return [
		{ x: 0, y: 0 },
		{ x: image.width, y: 0 },
		{ x: image.width, y: image.height },
		{ x: 0, y: image.height }
	];
}

/** An Alignment with no Control Points yet, over the whole image. */
export function newAlignment(imageId: string, image: { width: number; height: number }): Alignment {
	return {
		imageId,
		image: { width: image.width, height: image.height },
		controlPoints: [],
		resourceMask: fullImageResourceMask(image),
		transformationType: DEFAULT_TRANSFORMATION_TYPE
	};
}

/**
 * The complete pairs among `drafts`, numbered 1..n in the order they appear.
 *
 * **This is where ADR-0022's "autosave must skip incomplete pairs, not throw on them" actually
 * happens**, and it is on the path rather than beside it: the pairing UI holds drafts, every
 * write goes through here, and an incomplete pair is therefore dropped by construction. It
 * matters more than it looks: autosave fires constantly, so a version that threw — or that
 * serialised a half-pair into an invalid GCP — would fail on the *first click of every pair*,
 * which is the most common moment in the application.
 *
 * Numbering complete pairs only is what keeps the visible ordinals from jumping while a pair is
 * half-made. Click-then-click always leaves the incomplete draft last, so in practice no
 * committed ordinal moves; doing it this way means none would even if it were not last.
 */
export function collectControlPoints(
	drafts: readonly DraftControlPoint[]
): readonly ControlPoint[] {
	const complete: ControlPoint[] = [];
	for (const draft of drafts) {
		if (draft.resource === null || draft.geo === null) continue;
		complete.push({
			id: draft.id,
			ordinal: complete.length + 1,
			resource: draft.resource,
			geo: draft.geo
		});
	}
	return complete;
}

/** The drafts a stored Alignment's Control Points correspond to, for the pairing UI to resume. */
export function toDraftControlPoints(alignment: Alignment): readonly DraftControlPoint[] {
	return alignment.controlPoints.map(({ id, resource, geo }) => ({ id, resource, geo }));
}

/** Whether there are enough Control Points for `transformationType` to be solved (ADR-0013). */
export function canSolve(alignment: Alignment): boolean {
	return alignment.controlPoints.length >= MINIMUM_CONTROL_POINTS[alignment.transformationType];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// EDITING THE RESOURCE MASK
//
// The mask is the answer to "which part of this sheet is actually the map" — the outline that
// leaves out the margins, the title cartouche, and the decorative surround (CONTEXT.md). Every
// operation below returns a new Alignment rather than mutating one, so a mask edit is the same
// kind of thing as a Control Point edit and reaches storage through the same single write.
//
// **A mask can be made smaller but never emptied.** Upstream refuses a ring of fewer than three
// vertices outright, so an edit that removed the third one would produce an Alignment that cannot
// be written at all — and, since it would be rejected at *save* time rather than at edit time, the
// user would learn about it as a failed save with their outline already gone.

/**
 * The fewest vertices a Resource Mask can have.
 *
 * Three, because that is the fewest an area can have and because it is also what
 * `@allmaps/annotation` enforces — a two-vertex ring is refused by its own schema, so this is the
 * boundary of the format and not a preference of ours.
 */
export const MINIMUM_MASK_VERTICES = 3;

/** Move one Resource Mask vertex. Called on gesture end, so it is already one commit. */
export function moveMaskVertex(alignment: Alignment, index: number, to: ResourcePoint): Alignment {
	if (index < 0 || index >= alignment.resourceMask.length) return alignment;
	const resourceMask = alignment.resourceMask.map((vertex, at) =>
		at === index ? { x: to.x, y: to.y } : vertex
	);
	return { ...alignment, resourceMask };
}

/**
 * Add a vertex on the edge that leaves vertex `index`, at its midpoint.
 *
 * This is what makes the mask an *outline* rather than four draggable corners. A sixteenth-century
 * sheet whose map area is not a quadrilateral — an oval, a coastline traced round a cartouche —
 * cannot be described without it, and the alternative (redraw the whole ring) throws away the work
 * already in the mask.
 *
 * The new vertex lands exactly between its neighbours, so inserting one changes the polygon's
 * shape by nothing at all until the user moves it. An insertion that also moved the outline would
 * be an edit the user did not ask for.
 */
export function insertMaskVertexAfter(alignment: Alignment, index: number): Alignment {
	const mask = alignment.resourceMask;
	if (index < 0 || index >= mask.length) return alignment;
	const from = mask[index] as ResourcePoint;
	const to = mask[(index + 1) % mask.length] as ResourcePoint;
	const midpoint: ResourcePoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
	const resourceMask = [...mask.slice(0, index + 1), midpoint, ...mask.slice(index + 1)];
	return { ...alignment, resourceMask };
}

/**
 * Remove one Resource Mask vertex, unless doing so would leave fewer than
 * {@link MINIMUM_MASK_VERTICES}.
 *
 * Refused by returning the Alignment unchanged rather than by throwing: the caller is a keypress
 * on a focused vertex, and a thrown error there is an unhandled rejection in a pane. The caller
 * says why the vertex cannot go, which it can do because it knows the count.
 */
export function removeMaskVertex(alignment: Alignment, index: number): Alignment {
	const mask = alignment.resourceMask;
	if (index < 0 || index >= mask.length) return alignment;
	if (mask.length <= MINIMUM_MASK_VERTICES) return alignment;
	return { ...alignment, resourceMask: mask.filter((_, at) => at !== index) };
}

/** The mask again as the whole image, for a user who has outlined themselves into a corner. */
export function resetMaskToFullImage(alignment: Alignment): Alignment {
	return { ...alignment, resourceMask: fullImageResourceMask(alignment.image) };
}

/**
 * The midpoint of every edge of the mask, in edge order — edge `i` leaves vertex `i`.
 *
 * The handles {@link insertMaskVertexAfter} is reached through. They are computed here rather than
 * in the pane so that "the handle you grabbed is the edge that gains a vertex" is one fact with
 * one definition, instead of a pane's arithmetic that has to agree with core's.
 */
export function maskEdgeMidpoints(
	resourceMask: readonly ResourcePoint[]
): readonly ResourcePoint[] {
	return resourceMask.map((from, index) => {
		const to = resourceMask[(index + 1) % resourceMask.length] as ResourcePoint;
		return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
	});
}

/** Whether the mask is the whole image rectangle, which is what a new Alignment starts as. */
export function isFullImageResourceMask(alignment: Alignment): boolean {
	const full = fullImageResourceMask(alignment.image);
	if (alignment.resourceMask.length !== full.length) return false;
	return full.every((vertex, index) => {
		const mine = alignment.resourceMask[index];
		return mine !== undefined && mine.x === vertex.x && mine.y === vertex.y;
	});
}
