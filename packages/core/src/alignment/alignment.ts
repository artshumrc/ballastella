// The Alignment: what a scholar makes when they say "this feature on the map is *there* on the
// earth", and the artifact that records it (CONTEXT.md, Align / Alignment).
//
// Nothing here knows the file format. The words "Georeference Annotation" and
// `GeoreferencedMap` belong to `georeference-annotation.ts` alone, which is the one module
// allowed to use them (CONTEXT.md); this file is the domain, and it is deliberately free of
// `@allmaps/*` so that the shape the app reasons about is ours rather than a pre-1.0 package's.

import type { ResourcePoint } from '../image-pane/synthetic-projection.js';

/** A place on the earth, in the coordinates the Base Map pane speaks. */
export type GeoPoint = { lng: number; lat: number };

/**
 * A single correspondence between one point on a Historical Map image and one point on the
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
 * The default, and the only type this slice ever writes. Choosing another is ticket 08.
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
 * One Historical Map's correspondence with the earth: its Control Points, its Resource Mask,
 * and its transformation type (CONTEXT.md, Align / Alignment).
 */
export interface Alignment {
	/** Which Historical Map of the Project this aligns. Its identity is its file path. */
	readonly imageId: string;
	/** The image's pixel dimensions, which the Resource Mask and the renderer are both in terms of. */
	readonly image: { readonly width: number; readonly height: number };
	/** Complete pairs only, in ordinal order. */
	readonly controlPoints: readonly ControlPoint[];
	/**
	 * The outline of the part of the image to show once aligned (CONTEXT.md, Resource Mask).
	 *
	 * Defaults to the full image rectangle and is not editable in this slice — ticket 08 owns
	 * that. Never empty: an empty mask renders nothing, which reads as a broken tool on a user's
	 * first Alignment (ADR-0013).
	 */
	readonly resourceMask: readonly ResourcePoint[];
	readonly transformationType: TransformationType;
}

/** Where a Project keeps one Historical Map's Alignment, relative to the Project (ADR-0008). */
export const ALIGNMENT_DIRECTORY = 'alignments';

/** The Alignment's path within its Project. Its identity, the same way a Project's is its folder. */
export const alignmentPath = (imageId: string): string => `${ALIGNMENT_DIRECTORY}/${imageId}.json`;

/** The Alignment's path within the Workspace. */
export const alignmentStorePath = (projectDirectory: string, imageId: string): string =>
	`${projectDirectory}/${alignmentPath(imageId)}`;

/**
 * The whole image, clockwise from its top-left corner.
 *
 * The default Resource Mask, and the only one this slice produces (ADR-0013: not empty, because
 * an empty mask renders nothing and reads as the tool being broken).
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
