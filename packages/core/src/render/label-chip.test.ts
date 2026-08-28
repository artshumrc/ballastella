// The arithmetic behind the Label chip's distance field.
//
// Worth its own tests for `pin-icon.test.ts`'s reason and one more: the failure mode is not a crash but
// a chip whose corners are square, or one MapLibre's shader draws inset from what was authored — both
// of which were caught only by eye in a browser, after code that looked right had already been
// written. Everything here is arithmetic, so it can be checked exactly — and it is the same arithmetic
// the browser draws, because the chip is generated rather than rasterised.
//
// What still needs a real map is that the image *registers*, tints per feature, and grows to its words:
// `e2e/editor-annotations.e2e.ts`.

import { describe, expect, test } from 'vitest';

import {
	LABEL_CHIP_CONTENT,
	LABEL_CHIP_PIXEL_RATIO,
	LABEL_CHIP_STRETCH,
	LABEL_TEXT_SIZE,
	chipAlpha,
	labelChipImage,
	roundedBoxDistance
} from './label-chip.js';

/** Where MapLibre's SDF shader puts an icon's edge: `(256 - 64) / 256` of full alpha. */
const SHADER_EDGE = 192;

/**
 * How much of full alpha the shader reads per CSS pixel: `halo_edge = (6 - halo_width) / SDF_PX`,
 * `SDF_PX` being 8. The field is authored in image pixels, so a halo of `w` CSS pixels reaches
 * `w × PIXEL_RATIO` image pixels only if the ramp is that eighth spread over `PIXEL_RATIO` texels.
 */
const SHADER_SLOPE_PER_CSS_PIXEL = 255 / 8;

const SIZE = labelChipImage().width;

const alphaAt = (alpha: Uint8ClampedArray, x: number, y: number): number =>
	alpha[y * SIZE + x] as number;

/** How far in from the left edge of `alpha` the shape starts, on row `y`. */
const insetOn = (alpha: Uint8ClampedArray, y: number): number => {
	for (let x = 0; x < SIZE; x += 1) if (alphaAt(alpha, x, y) >= SHADER_EDGE) return x;
	return SIZE;
};

describe('the distance to a rounded rectangle', () => {
	test('is zero on the outline, positive inside it, and negative outside', () => {
		// A 20 × 20 box with a radius of 5, measured from its centre.
		const at = (x: number, y: number) => roundedBoxDistance(x, y, 10, 10, 5);

		expect(at(10, 0)).toBeCloseTo(0);
		expect(at(8, 0)).toBeCloseTo(2);
		expect(at(12, 0)).toBeCloseTo(-2);
		// The corner: the outline is a radius away from the arc's own centre, at (5, 5).
		expect(at(5 + 5 * Math.SQRT1_2, 5 + 5 * Math.SQRT1_2)).toBeCloseTo(0);
		// And the square corner it is not: (10, 10) would be on the outline of an unrounded box.
		expect(at(10, 10)).toBeCloseTo(5 - Math.hypot(5, 5));
	});
});

describe('the chip’s field', () => {
	const alpha = chipAlpha();
	const midRow = SIZE / 2;
	/** Where the shape's left edge is, which is also — the shape being square — where its top is. */
	const shapeEdge = insetOn(alpha, midRow);
	/** Where the flat band begins, so the corner arc is the rows between it and {@link shapeEdge}. */
	const flatBegins = LABEL_CHIP_CONTENT[0];

	test('puts its edge where the shader looks for it, and not at the halfway value', () => {
		// Half a pixel inside the flat left edge, so half a pixel's worth of ramp above the edge value.
		// Built around the halfway value instead, this texel would be 135 and MapLibre would draw the
		// chip inset from the one authored, eating the corner arc — fact 2 in `label-chip.ts`'s header.
		// (192/256 + 0.5/16) × 255 = 199, and one texel further out, (192/256 − 0.5/16) × 255 = 183.
		expect(alphaAt(alpha, shapeEdge, midRow)).toBe(199);
		expect(alphaAt(alpha, shapeEdge, midRow)).toBeGreaterThan(SHADER_EDGE);
		expect(alphaAt(alpha, shapeEdge - 1, midRow)).toBe(183);
	});

	test('ramps by an eighth of full alpha per CSS pixel, which is what sizes every halo', () => {
		// ⚠ **The slope the shader reads, and the reason `SPREAD` is 16 rather than 8.** `halo_edge` is
		// `(6 − halo_width) / 8`, so `icon-halo-width: 3` is drawn out to wherever the field has fallen
		// 3/8 of full alpha below the edge — and that has to be 3 *CSS* pixels away, not 3 texels. At
		// `SPREAD` 8 the ramp was an eighth per texel, a quarter per CSS pixel, and every halo came out
		// half the width asked for.
		const perCssPixel =
			alphaAt(alpha, shapeEdge - 1, midRow) -
			alphaAt(alpha, shapeEdge - 1 - LABEL_CHIP_PIXEL_RATIO, midRow);
		expect(perCssPixel).toBeCloseTo(SHADER_SLOPE_PER_CSS_PIXEL, 0);
	});

	test('falls off outward along a flat edge, so the selected chip has an aura and not four wedges', () => {
		// ⚠ **The claim the transparent margin exists for.** A field clipped at the shape's own outline
		// carries no outward distance beside a flat edge — the only sub-edge texels are in the corners —
		// and `icon-halo-width` then draws four small arcs with nothing between them. Read on the mid
		// row, which is as far from a corner as the image gets.
		const outward = Array.from({ length: shapeEdge }, (_, x) =>
			alphaAt(alpha, shapeEdge - 1 - x, midRow)
		);

		expect(outward.length).toBeGreaterThan(0);
		for (const value of outward) expect(value).toBeLessThan(SHADER_EDGE);
		for (let step = 1; step < outward.length; step += 1) {
			expect(outward[step]).toBeLessThan(outward[step - 1] as number);
		}
		// And it gets the whole way to nothing inside the image, so a halo of any width the selection
		// asks for is drawn in full rather than cut off at the atlas.
		expect(outward.at(-1)).toBeLessThan(SHADER_SLOPE_PER_CSS_PIXEL);
		expect(outward.length / LABEL_CHIP_PIXEL_RATIO).toBeGreaterThanOrEqual(5);
	});

	test('rounds its corners: the shape is inside its own corner and outside its middle', () => {
		expect(alphaAt(alpha, shapeEdge, shapeEdge)).toBeLessThan(SHADER_EDGE);
		expect(alphaAt(alpha, SIZE - 1 - shapeEdge, SIZE - 1 - shapeEdge)).toBeLessThan(SHADER_EDGE);
		expect(alphaAt(alpha, SIZE / 2, SIZE / 2)).toBe(255);
		// And the image's own corner is transparent, which is the margin.
		expect(alphaAt(alpha, 0, 0)).toBe(0);
	});

	test('draws an arc rather than a chamfer, closing within the corner’s own radius', () => {
		// Measured from the shape's own edge rather than the image's, so the margin is not read as inset.
		const profile = Array.from(
			{ length: flatBegins - shapeEdge + 1 },
			(_, step) => insetOn(alpha, shapeEdge + step) - shapeEdge
		);

		// Deepest at the top and monotonic down to nothing, which a chamfer would also satisfy — so the
		// shape of it is asserted too: an arc is nearly flat where it meets the flat edge and steep where
		// it meets the corner, so the first rows give up more than the last.
		expect(profile[0]).toBeGreaterThan(8);
		expect(profile.at(-1)).toBe(0);
		for (let step = 1; step < profile.length; step += 1) {
			expect(profile[step]).toBeLessThanOrEqual(profile[step - 1] as number);
		}
		const near = (profile[0] as number) - (profile[2] as number);
		const far = (profile.at(-3) as number) - (profile.at(-1) as number);
		expect(near).toBeGreaterThan(far);
	});

	test('is flat wherever the icon stretches, which is what keeps the corners’ aspect', () => {
		// ⚠ **The claim the stretch zones exist for.** MapLibre stretches an SDF by repeating this band,
		// and a band with any curve in it is a corner smeared along the axis it grew. Both zones are in
		// the image's own pixels; halving them for `pixelRatio` bites a notch out of the corner, which is
		// fact 1 in `label-chip.ts`'s header.
		const [from, to] = LABEL_CHIP_STRETCH[0] as [number, number];
		const column = (x: number) => Array.from({ length: SIZE }, (_, y) => alphaAt(alpha, x, y));
		const row = (y: number) => Array.from({ length: SIZE }, (_, x) => alphaAt(alpha, x, y));

		for (let at = from + 1; at < to; at += 1) {
			expect(column(at)).toEqual(column(from));
			expect(row(at)).toEqual(row(from));
		}
		// And the region fitted to the text is that same band, so the fit and the stretch agree.
		expect(LABEL_CHIP_CONTENT).toEqual([from, from, to, to]);
	});
});

describe('the image handed to MapLibre', () => {
	test('is white throughout, so `icon-color` is what colours a chip', () => {
		const image = labelChipImage();

		expect(image.width).toBe(SIZE);
		expect(image.height).toBe(SIZE);
		expect(image.data).toHaveLength(SIZE * SIZE * 4);
		const channels = new Set<number>();
		for (let index = 0; index < image.data.length; index += 4) {
			channels.add(image.data[index] as number);
			channels.add(image.data[index + 1] as number);
			channels.add(image.data[index + 2] as number);
		}
		expect([...channels]).toEqual([255]);
	});
});

describe('the three text sizes', () => {
	test('are ordered, so a large label is larger', () => {
		expect(LABEL_TEXT_SIZE.small).toBeLessThan(LABEL_TEXT_SIZE.medium);
		expect(LABEL_TEXT_SIZE.medium).toBeLessThan(LABEL_TEXT_SIZE.large);
	});
});
