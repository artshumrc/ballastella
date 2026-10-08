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

const SHADER_EDGE = 192;
const SHADER_SLOPE_PER_CSS_PIXEL = 255 / 8;
const SIZE = labelChipImage().width;

const alphaAt = (alpha: Uint8ClampedArray, x: number, y: number): number =>
	alpha[y * SIZE + x] as number;

const insetOn = (alpha: Uint8ClampedArray, y: number): number => {
	for (let x = 0; x < SIZE; x += 1) if (alphaAt(alpha, x, y) >= SHADER_EDGE) return x;
	return SIZE;
};

describe('the distance to a rounded rectangle', () => {
	test('is zero on the outline, positive inside it, and negative outside', () => {
		const at = (x: number, y: number) => roundedBoxDistance(x, y, 10, 10, 5);
		expect(at(10, 0)).toBeCloseTo(0);
		expect(at(8, 0)).toBeCloseTo(2);
		expect(at(12, 0)).toBeCloseTo(-2);
		expect(at(5 + 5 * Math.SQRT1_2, 5 + 5 * Math.SQRT1_2)).toBeCloseTo(0);
		expect(at(10, 10)).toBeCloseTo(5 - Math.hypot(5, 5));
	});
});

describe('the chip’s field', () => {
	const alpha = chipAlpha();
	const midRow = SIZE / 2;
	const shapeEdge = insetOn(alpha, midRow);
	const flatBegins = LABEL_CHIP_CONTENT[0];

	test('puts its edge where the shader looks for it, and not at the halfway value', () => {
		expect(alphaAt(alpha, shapeEdge, midRow)).toBe(199);
		expect(alphaAt(alpha, shapeEdge, midRow)).toBeGreaterThan(SHADER_EDGE);
		expect(alphaAt(alpha, shapeEdge - 1, midRow)).toBe(183);
	});

	test('ramps by an eighth of full alpha per CSS pixel, which is what sizes every halo', () => {
		const perCssPixel =
			alphaAt(alpha, shapeEdge - 1, midRow) -
			alphaAt(alpha, shapeEdge - 1 - LABEL_CHIP_PIXEL_RATIO, midRow);
		expect(perCssPixel).toBeCloseTo(SHADER_SLOPE_PER_CSS_PIXEL, 0);
	});

	test('falls off outward along a flat edge, so the selected chip has an aura and not four wedges', () => {
		const outward = Array.from({ length: shapeEdge }, (_, x) =>
			alphaAt(alpha, shapeEdge - 1 - x, midRow)
		);

		expect(outward.length).toBeGreaterThan(0);
		for (const value of outward) expect(value).toBeLessThan(SHADER_EDGE);
		for (let step = 1; step < outward.length; step += 1) {
			expect(outward[step]).toBeLessThan(outward[step - 1] as number);
		}
		expect(outward.at(-1)).toBeLessThan(SHADER_SLOPE_PER_CSS_PIXEL);
		expect(outward.length / LABEL_CHIP_PIXEL_RATIO).toBeGreaterThanOrEqual(5);
	});

	test('rounds its corners: the shape is inside its own corner and outside its middle', () => {
		expect(alphaAt(alpha, shapeEdge, shapeEdge)).toBeLessThan(SHADER_EDGE);
		expect(alphaAt(alpha, SIZE - 1 - shapeEdge, SIZE - 1 - shapeEdge)).toBeLessThan(SHADER_EDGE);
		expect(alphaAt(alpha, SIZE / 2, SIZE / 2)).toBe(255);
		expect(alphaAt(alpha, 0, 0)).toBe(0);
	});

	test('draws an arc rather than a chamfer, closing within the corner’s own radius', () => {
		const profile = Array.from(
			{ length: flatBegins - shapeEdge + 1 },
			(_, step) => insetOn(alpha, shapeEdge + step) - shapeEdge
		);

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
		const [from, to] = LABEL_CHIP_STRETCH[0] as [number, number];
		const column = (x: number) => Array.from({ length: SIZE }, (_, y) => alphaAt(alpha, x, y));
		const row = (y: number) => Array.from({ length: SIZE }, (_, x) => alphaAt(alpha, x, y));

		for (let at = from + 1; at < to; at += 1) {
			expect(column(at)).toEqual(column(from));
			expect(row(at)).toEqual(row(from));
		}
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
