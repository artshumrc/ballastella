// The needle. One drawing, drawn by two renderers.
//
// A Control Point in the align view and a Pin in the project view are the same mark: a round head
// over a slender shaft standing on the pixel being claimed. They are *drawn* by two mechanisms that
// have nothing in common — a Control Point is a focusable, draggable DOM `<button>` because a
// keyboard has to be able to reach it (`overlay-points.ts`), and a Pin is a signed distance field in
// a MapLibre symbol layer because each one takes the scholar's own colour (`pin-icon.ts`). Neither
// can become the other.
//
// So the *shape* lives here, once, and both renderers derive from it. Held apart, the two drifted
// three times in a row: matched by proportion they came out at different widths, matched by width at
// different lengths, and each time the mismatch was only visible on a screenshot. Numbers in one
// file and paths computed from them is the only version of this that cannot drift, because there is
// no second place to edit.
//
// **Units are the 24-unit grid, not pixels.** That is Lucide's grid, which the sidebar glyph is
// drawn on, and it is the SDF's grid; the DOM renderer scales it to {@link NEEDLE_PIXELS}.

/** The square the needle is drawn on. */
export const NEEDLE_GRID = 24;

/** The head: a solid disc, and where a Control Point's ordinal is centred. */
export const NEEDLE_HEAD = { cx: 12, cy: 8.25, r: 6.5 } as const;

/**
 * The shaft: a straight column, not a taper.
 *
 * A shaft that narrows to a point spends its last units thinner than the hairline drawn around it,
 * so the end of the mark blurs exactly where it is making its claim — worst at `marker-size: small`,
 * which is the size a dense Layer of Pins is usually drawn at. A column ends where it ends.
 *
 * `top` is *inside* the head, so the two read as one object with no seam to open up.
 */
export const NEEDLE_SHAFT = { width: 3.6, top: 12 } as const;

/**
 * How wide the white hairline around the mark is, in screen pixels at any size.
 *
 * Screen pixels rather than grid units, in both renderers: it is there to separate the mark from
 * whatever is under it, and a separator that scales with the mark is thinner than it needs to be on
 * the small ones and heavier than it should be on the large.
 */
export const NEEDLE_HALO_PIXELS = 1;

/**
 * How big the needle is drawn, in CSS pixels, where nothing else decides.
 *
 * A Pin's size is the scholar's — `marker-size` scales the icon — and this is what `medium` comes
 * out at, so it is also what a Control Point is drawn at: the align view has one size, and the size
 * it shares should be the one a Pin is usually seen at.
 */
export const NEEDLE_PIXELS = 34;

/**
 * The foot: the bottom edge of the grid, which is the pixel the mark claims.
 *
 * **On the edge, not a unit above it.** Both renderers anchor the mark by the bottom of its box — a
 * DOM marker through MapLibre's `anchor: 'bottom'`, a symbol through `icon-anchor: 'bottom'` — so a
 * foot short of the edge is a mark drawn systematically above the place it names. In the align view
 * that is the whole subject: a scholar clicks a pixel and the mark has to be on it.
 *
 * ⚠ It costs the Pin the underside of its halo: MapLibre draws `icon-halo` inside the image, so the
 * ring is clipped where the shape touches the edge. One pixel of white missing under the foot, in
 * exchange for the foot being where it says it is.
 */
export const NEEDLE_FOOT = NEEDLE_GRID;

/** The disc, as an SVG path. */
export const NEEDLE_HEAD_PATH = ((): string => {
	const { cx, cy, r } = NEEDLE_HEAD;
	const across = r * 2;
	return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${across} 0 ${r} ${r} 0 1 0-${across} 0Z`;
})();

/** The column, as an SVG path. */
export const NEEDLE_SHAFT_PATH = ((): string => {
	const { cx } = NEEDLE_HEAD;
	const { width, top } = NEEDLE_SHAFT;
	const [left, right] = [cx - width / 2, cx + width / 2];
	return `M${left} ${top} ${right} ${top} ${right} ${NEEDLE_FOOT} ${left} ${NEEDLE_FOOT}Z`;
})();

/**
 * The class names the DOM renderer puts on the parts of the drawing.
 *
 * The stylesheet matches these (`apps/editor/src/routes/layout.css`), because the colours are the
 * theme's and a MapLibre paint value is not — which is also why the SDF cannot share them.
 */
export const NEEDLE_PART = {
	halo: 'needle-halo',
	body: 'needle-body',
	ordinal: 'needle-ordinal'
} as const;

/**
 * The needle as a detached `<svg>`, for a renderer that draws it in the DOM.
 *
 * `document` is a parameter rather than a global because both apps prerender: a module
 * that reached for `document` at import time would be reached from a build step, and this way it
 * cannot be.
 *
 * **The halo is two paths of its own, drawn under two filled ones**, rather than a stroke on the
 * filled paths: stroking each part would draw a white line across the join where the shaft enters
 * the head. Painted in document order, the fills cover the strokes' inner halves and what is left is
 * a hairline around the silhouette.
 *
 * The ordinal is `<text>` in the same drawing, centred on the head, so what a Control Point wears is
 * placed by the same numbers as the head it sits in — not by a percentage in a stylesheet that has
 * to be edited when the head moves.
 */
export function needleSvg(document: Document): SVGSVGElement {
	const namespace = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(namespace, 'svg');
	svg.setAttribute('viewBox', `0 0 ${NEEDLE_GRID} ${NEEDLE_GRID}`);
	svg.setAttribute('width', String(NEEDLE_PIXELS));
	svg.setAttribute('height', String(NEEDLE_PIXELS));
	// Decoration: the mark's name is on the button around it, and a focusable `<svg>` in Internet
	// Explorer's descendants is a second tab stop for the same thing.
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');

	for (const part of [NEEDLE_PART.halo, NEEDLE_PART.body]) {
		for (const d of [NEEDLE_HEAD_PATH, NEEDLE_SHAFT_PATH]) {
			const path = document.createElementNS(namespace, 'path');
			path.setAttribute('d', d);
			path.setAttribute('class', part);
			svg.append(path);
		}
	}

	const text = document.createElementNS(namespace, 'text');
	text.setAttribute('class', NEEDLE_PART.ordinal);
	text.setAttribute('x', String(NEEDLE_HEAD.cx));
	text.setAttribute('y', String(NEEDLE_HEAD.cy));
	text.setAttribute('text-anchor', 'middle');
	text.setAttribute('dominant-baseline', 'central');
	svg.append(text);
	return svg;
}

/** Where the ordinal is written, in an `<svg>` built by {@link needleSvg}. */
export const needleOrdinal = (svg: SVGSVGElement): SVGTextElement | null =>
	svg.querySelector(`.${NEEDLE_PART.ordinal}`);
