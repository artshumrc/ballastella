// Distortion: where the Historical Map is stretched worst, and whether the Alignment has folded
// over itself (ADR-0013).
//
// Two different things live here, and keeping them apart is the point of the module.
//
// The **overlay** is built into the renderer and is not built here: `@allmaps/render` colourises
// the drawn map from a five-stop ramp, so all this file owns of it is *which measures exist*,
// *which one is displayed by default*, and *which must be computed* — three settings that the
// renderer takes and that the editor passes through. Conflating the last two is the obvious
// mistake: nothing displays if the measure was never computed.
//
// The **fold warning** is computed here, and deliberately not read out of the renderer. ADR-0013
// makes it continuous and independent of the overlay — "the colour overlay is a toggle, off by
// default, because a colourised map is not what you want while placing Control Points, but
// `signDetJ` is computed continuously and surfaces a plain warning" — and a warning that is
// derived from the layer's triangulation is a warning that exists only while a layer does, only in
// a browser, and only after the style has loaded. A fold is a property of the Alignment: of these
// Control Points under this transformation type. So it is answered from the Alignment, by the same
// solver the renderer uses, in a function a unit test can drive.
//
// `thetaa` is absent on purpose and must stay absent: it is an angle, angles are cyclic, and a
// linear five-stop ramp renders 359° and 1° at opposite ends of the scale. `twoOmega` and
// `airyKavr` are omitted as redundant for this audience.

import { GcpTransformer } from '@allmaps/transform';

import type { ResourcePoint } from '../image-pane/synthetic-projection.js';
import { canSolve, type Alignment } from './alignment.js';

/**
 * A measure of distortion the interface can show. Upstream offers five; these are the two
 * ADR-0013 exposes, because they answer different questions.
 */
export type DistortionMeasure = 'log2sigma' | 'signDetJ';

/** One entry of the distortion picker: the measure, its label, and the question it answers. */
export interface DistortionMeasureChoice {
	readonly measure: DistortionMeasure;
	readonly label: string;
	/** What a user learns from it. The reason two are offered rather than one. */
	readonly question: string;
}

/** The measures offered, in the order they are offered. `log2sigma` first, and the default. */
export const DISTORTION_MEASURES: readonly DistortionMeasureChoice[] = [
	{
		measure: 'log2sigma',
		label: 'Stretching',
		question: 'Where is this map drawn too big or too small? — how faithful is it?'
	},
	{
		measure: 'signDetJ',
		label: 'Folds',
		question: 'Where has the Alignment folded over itself? — did I make a mistake?'
	}
];

/** What the overlay shows unless the user changes it (ADR-0013). */
export const DEFAULT_DISTORTION_MEASURE: DistortionMeasure = 'log2sigma';

/**
 * Every measure the renderer must **compute**, which is every measure the interface can display.
 *
 * `distortionMeasure` selects what is *displayed*; `distortionMeasures` selects what is
 * *computed*. They are two different renderer settings, and the failure from conflating them is
 * silent: switching the display to a measure that was never computed draws the map with no
 * colouring at all, which is indistinguishable from "this map has no distortion".
 *
 * So this is derived from {@link DISTORTION_MEASURES} rather than written out, and a measure added
 * to the picker is computed by construction.
 */
export const COMPUTED_DISTORTION_MEASURES: readonly DistortionMeasure[] = DISTORTION_MEASURES.map(
	(choice) => choice.measure
);

/**
 * The measure the fold check reads: the sign of the Jacobian determinant, negative where the warp
 * has turned the map over.
 */
export const FOLD_DISTORTION_MEASURE: DistortionMeasure = 'signDetJ';

/**
 * The five-stop ramp the renderer colourises with, and the colour of the warped graticule.
 *
 * Values come from the theme rather than being hardcoded (ADR-0013), so this is the *shape* of the
 * setting and not the setting itself — the editor fills it in from the theme the user chose. The
 * keys are upstream's own option names, because they are what the renderer takes and renaming them
 * here would only add a mapping that can be wrong.
 *
 * What each stop does, read off the fragment shader, because the names do not say:
 * `distortionColor00` is where `log2sigma` is **positive** (drawn too big) and `distortionColor01`
 * where it is negative (too small) — one diverging pair, not two ramps. `distortionColor1` and
 * `distortionColor2` belong to `twoOmega` and `airyKavr`, which are not offered, and are set only
 * so that nothing is left at upstream's literal red. `distortionColor3` is the fold colour: it is
 * painted flat wherever `signDetJ` is exactly −1.
 */
export interface DistortionRamp {
	/** `log2sigma` positive: the map is drawn larger than reality here. */
	readonly distortionColor00: string;
	/** `log2sigma` negative: drawn smaller than reality. */
	readonly distortionColor01: string;
	readonly distortionColor1: string;
	readonly distortionColor2: string;
	/** Painted flat where the warp has folded. */
	readonly distortionColor3: string;
}

/** How the distortion view is currently set. **Never persisted** — see {@link Alignment}. */
export interface DistortionView {
	/**
	 * The measure being displayed, or `null` for no colourising at all.
	 *
	 * `null` is the default, because a colourised map is not what you want while placing Control
	 * Points (ADR-0013).
	 */
	readonly measure: DistortionMeasure | null;
	/** The warped graticule: a regular grid bent by the transformation. */
	readonly grid: boolean;
}

/** The distortion view a page opens with: no colouring, no graticule (ADR-0013). */
export const DEFAULT_DISTORTION_VIEW: DistortionView = { measure: null, grid: false };

/**
 * Where an Alignment folds over itself, described for a reader.
 *
 * Deliberately not a list of coordinates. What a student can act on is "near the top-right" —
 * ADR-0013's own example — because it sends them to a part of their own sheet to look at. A set of
 * projected coordinates sends them nowhere.
 */
export interface FoldWarning {
	/**
	 * Whether the whole sheet is turned over, or only part of it folds.
	 *
	 * The two have different causes and different fixes. `mirrored` is the "I swapped two Control
	 * Points" error and shows up even under an affine transformation, which cannot fold locally.
	 * `local` is a single Control Point in the wrong place, and needs `projective` or
	 * `thinPlateSpline` to be possible at all.
	 */
	readonly kind: 'mirrored' | 'local';
	/**
	 * Which part of the Historical Map the folding is centred in, in the words the message uses —
	 * `top-right`, `bottom`, `centre`, and so on.
	 *
	 * Always populated, but only put in front of the user for a `local` fold: telling somebody whose
	 * whole sheet is turned over to go and look at the top-right would send them to the wrong
	 * problem. It is here for both because it is the same measurement either way, and because a
	 * mirrored Alignment is the case in which the region can be asserted deterministically.
	 */
	readonly where: string;
	/** The whole warning, as a sentence. */
	readonly message: string;
	/** How many sample points folded, and out of how many. For the tests, and for diagnosis. */
	readonly foldedSamples: number;
	readonly sampleCount: number;
}

/** How many sample points across the mask's width and height the fold check evaluates. */
const FOLD_SAMPLE_STEPS = 11;

/**
 * Whether this Alignment folds over itself, and where.
 *
 * `null` when it does not, when there are too few Control Points to solve at all, or when the
 * solver refuses the Control Points outright — a warning is feedback on a working Alignment, and
 * turning a failed solve into "your Alignment folds" would be a claim the measurement does not
 * support.
 *
 * **Not suppressed for the non-warping types.** `nonWarpingTransformationTypes` is
 * `['helmert', 'polynomial', 'polynomial1']` and those cannot fold *locally*, so it is tempting to
 * skip them. They can still be **globally mirrored**, which is exactly the swapped-Control-Point
 * error and the single most useful thing this can catch (ADR-0013).
 */
export function detectFold(alignment: Alignment): FoldWarning | null {
	if (!canSolve(alignment)) return null;

	const samples = maskSamples(alignment.resourceMask);
	if (samples.length === 0) return null;

	let signs: readonly (number | undefined)[];
	try {
		const transformer = new GcpTransformer(
			alignment.controlPoints.map((point) => ({
				resource: [point.resource.x, point.resource.y] as [number, number],
				geo: [point.geo.lng, point.geo.lat] as [number, number]
			})),
			alignment.transformationType
		);
		signs = transformer.transformToGeo(
			samples.map((point) => [point.x, point.y] as [number, number]),
			// `isMultiGeometry` is what makes this a set of independent points rather than a line
			// string. Without it the transformer refines *between* the samples, which is both slower
			// and a different question: a fold is evaluated at points, not along a path.
			{ distortionMeasures: [FOLD_DISTORTION_MEASURE], isMultiGeometry: true },
			(gcp) => gcp.distortions?.get(FOLD_DISTORTION_MEASURE)
		);
	} catch {
		// An under-determined or degenerate solve — collinear Control Points, for instance. Nothing
		// is claimed, because nothing was measured.
		return null;
	}

	const folded: ResourcePoint[] = [];
	let measured = 0;
	signs.forEach((sign, index) => {
		if (typeof sign !== 'number') return;
		measured += 1;
		if (sign < 0) folded.push(samples[index] as ResourcePoint);
	});

	if (measured === 0 || folded.length === 0) return null;

	const where = describeRegion(folded, alignment.image);
	const everywhere = folded.length === measured;

	return {
		kind: everywhere ? 'mirrored' : 'local',
		where,
		message: everywhere
			? 'This Alignment turns the whole Historical Map over — it is mirrored. Two Control Points ' +
				'are probably swapped.'
			: `This Alignment folds over itself near the ${where} of the Historical Map. A Control ` +
				'Point there is probably in the wrong place.',
		foldedSamples: folded.length,
		sampleCount: measured
	};
}

/**
 * A grid of points inside the mask, in image pixels.
 *
 * Inside the *mask* rather than across the whole image, because a fold in the margin the user has
 * excluded is not drawn and is not their problem — reporting it would send them to look at a part
 * of the sheet the Alignment does not use.
 */
function maskSamples(mask: readonly ResourcePoint[]): readonly ResourcePoint[] {
	const box = boundingBox(mask);
	if (box === null) return [];

	const samples: ResourcePoint[] = [];
	for (let row = 0; row < FOLD_SAMPLE_STEPS; row += 1) {
		for (let column = 0; column < FOLD_SAMPLE_STEPS; column += 1) {
			// Offset off the edges and off the exact centre, so a sample never lands on a mask vertex
			// or on an edge, where point-in-polygon is a coin toss.
			const fx = (column + 0.5) / FOLD_SAMPLE_STEPS;
			const fy = (row + 0.5) / FOLD_SAMPLE_STEPS;
			const point: ResourcePoint = {
				x: box.minX + fx * (box.maxX - box.minX),
				y: box.minY + fy * (box.maxY - box.minY)
			};
			if (isInside(point, mask)) samples.push(point);
		}
	}
	return samples;
}

interface BoundingBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

function boundingBox(points: readonly ResourcePoint[]): BoundingBox | null {
	const first = points[0];
	if (!first) return null;
	const box: BoundingBox = { minX: first.x, minY: first.y, maxX: first.x, maxY: first.y };
	for (const point of points) {
		box.minX = Math.min(box.minX, point.x);
		box.minY = Math.min(box.minY, point.y);
		box.maxX = Math.max(box.maxX, point.x);
		box.maxY = Math.max(box.maxY, point.y);
	}
	if (box.maxX === box.minX || box.maxY === box.minY) return null;
	return box;
}

/** The even-odd ray-crossing test. Enough for a mask, which is a simple closed ring. */
function isInside(point: ResourcePoint, ring: readonly ResourcePoint[]): boolean {
	let inside = false;
	for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
		const a = ring[index] as ResourcePoint;
		const b = ring[previous] as ResourcePoint;
		const crosses = a.y > point.y !== b.y > point.y;
		if (crosses && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
			inside = !inside;
		}
	}
	return inside;
}

/**
 * Which ninth of the **image** the folded samples are centred in, as words.
 *
 * Of the image and not of the mask, deliberately: the user is looking at the whole sheet in the
 * image pane, and "the top-right" has to mean the top-right of what they can see. Against the
 * mask's own bounding box, a mask covering only the corner of a sheet would have its own top-right
 * — a different place from the one the words send the reader to.
 *
 * Nine regions rather than four, because "the top" and "the top-right" are different places to
 * look and both are things a student can find on their own sheet. Image y points **down**, so the
 * smallest third of y is the top of the map.
 */
function describeRegion(
	folded: readonly ResourcePoint[],
	image: { readonly width: number; readonly height: number }
): string {
	let sumX = 0;
	let sumY = 0;
	for (const point of folded) {
		sumX += point.x;
		sumY += point.y;
	}
	const third = (total: number, extent: number): 0 | 1 | 2 => {
		const fraction = extent === 0 ? 0.5 : total / folded.length / extent;
		if (fraction < 1 / 3) return 0;
		if (fraction < 2 / 3) return 1;
		return 2;
	};

	const column = third(sumX, image.width);
	const row = third(sumY, image.height);
	const vertical = ['top', 'middle', 'bottom'][row] as string;
	const horizontal = ['left', 'centre', 'right'][column] as string;

	if (row === 1 && column === 1) return 'centre';
	if (row === 1) return horizontal;
	if (column === 1) return vertical;
	return `${vertical}-${horizontal}`;
}
