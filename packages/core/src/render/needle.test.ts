import { describe, expect, test } from 'vitest';

import {
	NEEDLE_GRID,
	NEEDLE_HEAD,
	NEEDLE_HEAD_PATH,
	NEEDLE_SHAFT,
	NEEDLE_SHAFT_PATH
} from './needle.js';

const numbersIn = (path: string): number[] =>
	[...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));

describe('the drawing', () => {
	test('stands on the bottom of its grid, which is the coordinate it claims', () => {
		expect(NEEDLE_SHAFT_PATH).toContain(`${NEEDLE_GRID}`);
	});

	test('fits inside the grid, so neither renderer clips it', () => {
		const reach = [...numbersIn(NEEDLE_HEAD_PATH), ...numbersIn(NEEDLE_SHAFT_PATH)].map(Math.abs);
		expect(Math.max(...reach)).toBeLessThanOrEqual(NEEDLE_GRID);
		expect(NEEDLE_HEAD.cy - NEEDLE_HEAD.r).toBeGreaterThan(0);
		expect(NEEDLE_HEAD.cx + NEEDLE_HEAD.r).toBeLessThan(NEEDLE_GRID);
	});

	test('is a shaft under a head, on one axis and overlapping', () => {
		expect(NEEDLE_SHAFT.top).toBeLessThan(NEEDLE_HEAD.cy + NEEDLE_HEAD.r);
		expect(NEEDLE_SHAFT.top).toBeGreaterThan(NEEDLE_HEAD.cy);
		expect(NEEDLE_SHAFT.width).toBeLessThan(NEEDLE_HEAD.r);
		const shaft = numbersIn(NEEDLE_SHAFT_PATH);
		const [left, right] = [Math.min(...shaft), Math.max(...shaft.slice(0, 4))];
		expect((left + right) / 2).toBeCloseTo(NEEDLE_HEAD.cx, 5);
	});
});
