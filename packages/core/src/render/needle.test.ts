// The needle's geometry: the numbers two renderers agree through.
//
// Worth its own tests because the failure they guard is the one that actually happened, three times
// running: a Control Point in the DOM and a Pin as a signed distance field came out visibly
// different, and nothing failed — the mismatch was only ever visible on a screenshot. These are the
// invariants each renderer relies on and neither can check.

import { describe, expect, test } from 'vitest';

import {
	NEEDLE_FOOT,
	NEEDLE_GRID,
	NEEDLE_HEAD,
	NEEDLE_HEAD_PATH,
	NEEDLE_SHAFT,
	NEEDLE_SHAFT_PATH
} from './needle.js';

/** Every number in a path, which is enough to ask where the drawing reaches. */
const numbersIn = (path: string): number[] =>
	[...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));

describe('the drawing', () => {
	test('stands on the bottom of its grid, which is the coordinate it claims', () => {
		// Both renderers anchor the mark by the bottom of its box. A foot short of the edge is a mark
		// drawn systematically above the pixel a scholar clicked, at every size.
		expect(NEEDLE_FOOT).toBe(NEEDLE_GRID);
		expect(NEEDLE_SHAFT_PATH).toContain(`${NEEDLE_GRID}`);
	});

	test('fits inside the grid, so neither renderer clips it', () => {
		// The SDF rasterises the grid and nothing outside it exists; the DOM `<svg>` has the grid as
		// its viewBox and clips the same way.
		const reach = [...numbersIn(NEEDLE_HEAD_PATH), ...numbersIn(NEEDLE_SHAFT_PATH)].map(Math.abs);

		expect(Math.max(...reach)).toBeLessThanOrEqual(NEEDLE_GRID);
		expect(NEEDLE_HEAD.cy - NEEDLE_HEAD.r).toBeGreaterThan(0);
		expect(NEEDLE_HEAD.cx + NEEDLE_HEAD.r).toBeLessThan(NEEDLE_GRID);
	});

	test('is a shaft under a head, on one axis and overlapping', () => {
		// Centred: a shaft off the head's axis is a mark that leans, and the axis is also where the
		// ordinal is centred. Overlapping: a gap between the two opens a seam at every size.
		expect(NEEDLE_SHAFT.top).toBeLessThan(NEEDLE_HEAD.cy + NEEDLE_HEAD.r);
		expect(NEEDLE_SHAFT.top).toBeGreaterThan(NEEDLE_HEAD.cy);
		expect(NEEDLE_SHAFT.width).toBeLessThan(NEEDLE_HEAD.r);

		const shaft = numbersIn(NEEDLE_SHAFT_PATH);
		const [left, right] = [Math.min(...shaft), Math.max(...shaft.slice(0, 4))];
		expect((left + right) / 2).toBeCloseTo(NEEDLE_HEAD.cx, 5);
	});
});
