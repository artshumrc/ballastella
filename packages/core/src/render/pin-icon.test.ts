// The arithmetic behind the pin's signed distance field.
//
// Worth its own tests because the failure mode is not a crash: a wrong field still registers, still
// draws, and produces pins with soft or bitten edges that nobody can trace back to a transform. The
// rasterising needs a canvas and is exercised by the e2e suite through what MapLibre actually draws;
// this is the half that is pure arithmetic and can be checked exactly.

import { describe, expect, test } from 'vitest';

import { PIN_ICON_SIZE, distanceTransform1d, signedDistanceAlpha } from './pin-icon.js';

/** The exact distance transform, computed the slow obvious way, to check the fast one against. */
const bruteForce = (mask: number[], width: number, height: number): number[] =>
	mask.map((_, index) => {
		const x = index % width;
		const y = Math.floor(index / width);
		let best = Infinity;
		for (let j = 0; j < height; j += 1) {
			for (let i = 0; i < width; i += 1) {
				if (!mask[j * width + i]) continue;
				best = Math.min(best, Math.hypot(x - i, y - j));
			}
		}
		return best;
	});

describe('the one-dimensional transform', () => {
	test('a single seed gives the squared distance from it', () => {
		const f = new Float64Array([1e20, 1e20, 0, 1e20, 1e20]);

		expect([...distanceTransform1d(f)]).toEqual([4, 1, 0, 1, 4]);
	});

	test('two seeds give the nearer of the two, which is what the lower envelope is for', () => {
		const f = new Float64Array([0, 1e20, 1e20, 1e20, 0]);

		expect([...distanceTransform1d(f)]).toEqual([0, 1, 4, 1, 0]);
	});
});

describe('the field', () => {
	test('matches a brute-force Euclidean distance transform exactly', () => {
		// The claim the two-pass transform makes: it is *exact*, not an approximation. A chamfer or an
		// 8SSEDT would be close and would drift diagonally, which shows up as a pin whose point is
		// blunter than its sides.
		const width = 9;
		const height = 7;
		const mask = Array.from({ length: width * height }, (_, index) => {
			const x = index % width;
			const y = Math.floor(index / width);
			return (x === 2 && y === 2) || (x === 7 && y === 5) ? 1 : 0;
		});

		// Read back out of the alpha the shape is encoded in: inside is above the halfway value.
		const spread = 4;
		const alpha = signedDistanceAlpha(Uint8Array.from(mask), width, height, spread);
		const expected = bruteForce(mask, width, height);

		for (let index = 0; index < mask.length; index += 1) {
			if (mask[index]) continue;
			const decoded = ((alpha[index] as number) / 255 - 0.5) * 2 * spread * -1;
			// Only where the field has range left to say it: further out it clamps, on purpose.
			if ((expected[index] as number) > spread) continue;
			expect(decoded).toBeCloseTo(expected[index] as number, 1);
		}
	});

	test('inside is above the halfway value and outside is below it', () => {
		// The convention MapLibre's shader thresholds against. Getting it inverted draws the negative
		// of the pin — everything except the shape — which is a striking way to find out.
		const width = 5;
		const height = 5;
		const mask = Uint8Array.from(
			Array.from({ length: 25 }, (_, index) => {
				const x = index % width;
				const y = Math.floor(index / width);
				return x >= 1 && x <= 3 && y >= 1 && y <= 3 ? 1 : 0;
			})
		);

		const alpha = signedDistanceAlpha(mask, width, height);

		expect(alpha[2 * width + 2]).toBeGreaterThan(128); // the middle of the block
		expect(alpha[0]).toBeLessThan(128); // a corner, outside it
	});

	test('an empty mask is entirely outside, and a full one entirely inside', () => {
		const empty = signedDistanceAlpha(new Uint8Array(16), 4, 4);
		const full = signedDistanceAlpha(new Uint8Array(16).fill(1), 4, 4);

		expect([...empty].every((value) => value < 128)).toBe(true);
		expect([...full].every((value) => value > 128)).toBe(true);
	});
});

describe('the sizes', () => {
	test('the three marker sizes are ordered, so large is larger', () => {
		expect(PIN_ICON_SIZE['small']).toBeLessThan(PIN_ICON_SIZE['medium'] as number);
		expect(PIN_ICON_SIZE['medium']).toBeLessThan(PIN_ICON_SIZE['large'] as number);
	});
});
