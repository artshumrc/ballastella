// The coloured chip a Label's words are drawn on, and how big those words are.
//
// **One image for every Label in the application**, registered as an SDF and tinted per feature by
// `icon-color`, exactly as `pin-icon.ts` does for the pin: MapLibre honours `icon-color` only on an
// SDF, so the alternative is an image per distinct background colour, registered and invalidated as a
// scholar drags a colour input. Sized to the words by `icon-text-fit`, which is what makes a long name
// grow its background instead of being clipped by a box drawn for a short one.
//
// **The numbers below were measured in a real browser, not chosen**, and the paragraphs that follow
// are the three facts they encode. Change one only against a fresh measurement: they encode how a
// chip's background sits under text at the sizes a scholar actually uses, and a plausible-looking
// round number here has been wrong before.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. THE CORNERS SURVIVE STRETCHING BECAUSE OF WHERE THE STRETCH ZONES ARE
//
// A chip fitted to its text is a stretched image, and a distance field is only linear along an axis
// where nothing curves. {@link LABEL_CHIP_STRETCH} confines the stretching to the flat middle band, so
// the four corner arcs are carried at their own aspect however wide the words are — measured off the
// proof at chip widths from 44 to 188 CSS pixels, the same arc within a pixel of antialiasing.
//
// ⚠ **`content` and the stretch zones are in the image's OWN pixels, not the icon's CSS pixels.**
// Halving them for `pixelRatio` bites a notch out of the top-left corner and leaves an arc that never
// closes; that is row three of `evidence/label-chip-corners.png`.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 2. THE FIELD'S EDGE IS AT 192/256, AND ITS SLOPE IS PER CSS PIXEL
//
// MapLibre's SDF shader thresholds an icon's fill at `(256 - 64) / 256`. A field built around the
// halfway value therefore draws a shape *inset* from the one authored, which on a large solid teardrop
// is invisible and on a small corner radius eats the arc that is the chip's whole visual identity.
// `pin-icon.ts`'s `signedDistanceAlpha` uses the halfway convention and is deliberately left alone.
//
// The same shader reads the field's *slope* as an eighth of full alpha per **CSS** pixel:
// `halo_edge = (6.0 - halo_width / fontScale) / SDF_PX` with `SDF_PX 8.0` and `halo_width` in CSS
// pixels, so an `icon-halo-width` of `w` is drawn out to wherever the field has fallen `w / 8` below
// the edge value. The field here is authored in *image* pixels, so {@link SPREAD} must be
// `8 × LABEL_CHIP_PIXEL_RATIO` — at 8 the ramp is an eighth per image pixel, a quarter per CSS pixel,
// and every halo comes out half the width asked for.
//
// **So the chip encodes its own field, and analytically rather than from a raster.** A rounded
// rectangle's signed distance has a closed form, so there is no mask to threshold, no Euclidean
// transform to run, and — unlike the pin — no canvas needed at all, which puts the corner geometry
// within reach of a Node test.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 3. THE SHAPE DOES NOT FILL THE IMAGE, BECAUSE A HALO NEEDS SOMEWHERE TO BE
//
// A distance field clipped at the shape's own outline carries no outward distance along a flat edge,
// and `icon-halo-width` then finds field to draw on only in the corners — four small arcs with nothing
// between them, which is not the aura the selected chip is meant to have. {@link MARGIN} is the
// transparent border that gives the falloff room: 12 image pixels, which at {@link SPREAD} 16 is the
// whole ramp from the edge value down to zero, so a halo of any width the selection uses is drawn in
// full.
//
// The margin costs nothing in the fitted chip's size, because it is paid for in `content`.
// Everything outside `content` hangs *outside* the box `icon-text-fit` fits, at its natural size —
// so `content` inset by the margin as well as the radius puts the visible outline exactly where it
// was before the margin existed, and {@link LABEL_CHIP_PADDING} is unchanged. What does grow is the
// icon's total extent, and with it the box a click is tested against: by the margin, on each side.

/** The image id both apps register the chip under. */
export const LABEL_CHIP_IMAGE_ID = 'ballastella-label-chip';

/**
 * How many image pixels there are per CSS pixel — handed to `addImage` as `pixelRatio`.
 *
 * At 2, the 72 px image is a 36 CSS-pixel icon before `icon-text-fit` grows it.
 */
export const LABEL_CHIP_PIXEL_RATIO = 2;

/** The corner radius, in image pixels: 8 CSS pixels, which is the proof's own arc. */
const CORNER_RADIUS = 16;

/**
 * How far, in image pixels, the field carries usable distance either side of the edge.
 *
 * `8 × LABEL_CHIP_PIXEL_RATIO`, because the shader reads an eighth of full alpha per **CSS** pixel —
 * fact 2 in this file's header, and the whole of why this is not 8.
 */
const SPREAD = 8 * LABEL_CHIP_PIXEL_RATIO;

/** Where MapLibre's SDF shader puts the edge: `(256 - 64) / 256`, and not the halfway value. */
const EDGE_ALPHA = 192 / 256;

/**
 * The transparent border between the shape and the image's edge, in image pixels.
 *
 * {@link EDGE_ALPHA} × {@link SPREAD} rounded up, so the outward ramp reaches zero inside the image
 * and a halo of any width the selection asks for has field to be drawn on — fact 3 in this file's
 * header.
 */
const MARGIN = Math.ceil(EDGE_ALPHA * SPREAD);

/** How many image pixels of flat edge sit between the two corner arcs on each axis. */
const FLAT = 16;

/** The rasterised size, in image pixels. Square, and stretched to the words from there. */
const SIZE = 2 * (MARGIN + CORNER_RADIUS) + FLAT;

/**
 * The region of the image that `icon-text-fit` fits to the text, in **image pixels**.
 *
 * The flat band between the corner arcs. Everything outside it — the corners *and* the transparent
 * margin — hangs outside the fitted box at its natural size, which is why the padding below is small:
 * each side already carries 8 CSS pixels of corner.
 */
export const LABEL_CHIP_CONTENT: readonly [number, number, number, number] = [
	MARGIN + CORNER_RADIUS,
	MARGIN + CORNER_RADIUS,
	MARGIN + CORNER_RADIUS + FLAT,
	MARGIN + CORNER_RADIUS + FLAT
];

/** Which part of the image may stretch, in **image pixels**: the flat band between the corners. */
export const LABEL_CHIP_STRETCH: readonly (readonly [number, number])[] = [
	[MARGIN + CORNER_RADIUS, MARGIN + CORNER_RADIUS + FLAT]
];

/**
 * `icon-text-fit-padding` — top, right, bottom, left — in CSS pixels.
 *
 * Wider than it is tall, because a chip whose text touches its left edge reads as broken while one
 * whose text touches its top edge reads as tight.
 */
export const LABEL_CHIP_PADDING: readonly [number, number, number, number] = [4, 8, 4, 8];

/**
 * `text-size` for each simplestyle `marker-size`, in CSS pixels.
 *
 * simplestyle names three sizes and gives no pixel values, so these are ours, as the pin's are. The
 * ratios are what matter and they are the pin's: 0.75 and 1.375 against a medium, where
 * `PIN_ICON_SIZE` is 0.71 and 1.36 — so a small Label and a small Pin read as siblings. Medium is 16,
 * which is the interface's own body size and the smallest a name over a busy map stays legible at.
 */
export const LABEL_TEXT_SIZE: Record<'small' | 'medium' | 'large', number> = {
	small: 12,
	medium: 16,
	large: 22
};

/**
 * The signed distance from a point to a rounded rectangle's edge: **positive inside**, in pixels.
 *
 * `max(|p| - halfExtent + radius, 0)` is the offset from the nearest corner arc's centre, clamped so
 * that a point beside a flat edge measures against that edge rather than around a corner; the radius
 * less its length is then the distance to the outline, positive inside.
 *
 * ⚠ **Exact within a radius of the outline and no further.** Deeper inside than that — inside the
 * rectangle the arc centres describe — this answers `radius` for every pixel rather than the true
 * distance. The field saturates at full alpha `(1 - EDGE_ALPHA) × SPREAD` = 4 image pixels inside the
 * outline, well short of the radius, so no shader can see the difference and the extra term would buy
 * nothing.
 *
 * Exported for its own test: this is the arithmetic the corner radius is, and it is checkable exactly.
 */
export function roundedBoxDistance(
	x: number,
	y: number,
	halfWidth: number,
	halfHeight: number,
	radius: number
): number {
	const dx = Math.max(Math.abs(x) - halfWidth + radius, 0);
	const dy = Math.max(Math.abs(y) - halfHeight + radius, 0);
	return radius - Math.hypot(dx, dy);
}

/**
 * The alpha channel MapLibre's SDF shader expects, for a rounded rectangle inset by `margin`.
 *
 * `EDGE_ALPHA` on the edge, above it inside and below it outside, ramping by `1 / SPREAD` of the range
 * per image pixel — see fact 2 in this file's header for where all three of those numbers come from,
 * and fact 3 for why the shape stops short of the image's own border.
 *
 * Exported for its own test, for the reason {@link roundedBoxDistance} is.
 */
export function chipAlpha(size = SIZE, radius = CORNER_RADIUS, margin = MARGIN): Uint8ClampedArray {
	const alpha = new Uint8ClampedArray(size * size);
	const half = size / 2;
	const halfExtent = half - margin;
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			// Pixel centres, so the shape is symmetric about the image rather than half a pixel off it.
			const signed = roundedBoxDistance(
				x + 0.5 - half,
				y + 0.5 - half,
				halfExtent,
				halfExtent,
				radius
			);
			alpha[y * size + x] = Math.round((EDGE_ALPHA + signed / SPREAD) * 255);
		}
	}
	return alpha;
}

/**
 * The chip as an image MapLibre can register.
 *
 * White throughout, as the pin is: `icon-color` supplies the colour and the alpha carries the shape.
 * Never `null` — unlike `pinImage`, nothing here needs a canvas, so a prerender that imported its way
 * to this function gets a real image rather than an absence.
 */
export function labelChipImage(): { width: number; height: number; data: Uint8ClampedArray } {
	const alpha = chipAlpha();
	const data = new Uint8ClampedArray(SIZE * SIZE * 4);
	for (let index = 0; index < alpha.length; index += 1) {
		data[index * 4] = 255;
		data[index * 4 + 1] = 255;
		data[index * 4 + 2] = 255;
		data[index * 4 + 3] = alpha[index] as number;
	}
	return { width: SIZE, height: SIZE, data };
}
