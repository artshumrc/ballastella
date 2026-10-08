import type { LineStyle } from '@ballastella/core';
import { afterEach, describe, expect, test } from 'vitest';

import { show, takeDown } from '$lib/test-support/dom';

import LineStyleIcon from './LineStyleIcon.svelte';

interface Ink {
	readonly from: number;
	readonly to: number;
}

afterEach(takeDown);

function inkOf(style: LineStyle): Ink[] {
	show(LineStyleIcon, { style });
	const svg = document.querySelector('svg')!;
	const width = svg.getAttribute('stroke-width');
	expect(width, `${style} states no stroke-width`).not.toBeNull();
	const cap = svg.getAttribute('stroke-linecap') === 'round' ? Number(width) / 2 : 0;
	const paths = [...svg.querySelectorAll('path')].map((path) => path.getAttribute('d') ?? '');
	takeDown();
	expect(paths.length, `${style} has no paths`).toBeGreaterThan(0);

	const painted = paths.map((d) => {
		const drawn = /^M(-?[\d.]+) 12h(-?[\d.]+)$/.exec(d);
		if (!drawn) throw new Error(`${style}: this test only understands "M<x> 12h<len>", not "${d}"`);
		const from = Number(drawn[1]);
		return { from: from - cap, to: from + Number(drawn[2]) + cap };
	});

	painted.sort((a, b) => a.from - b.from);
	const merged: Ink[] = [];
	for (const stretch of painted) {
		const last = merged.at(-1);
		if (last && stretch.from <= last.to)
			merged[merged.length - 1] = { from: last.from, to: Math.max(last.to, stretch.to) };
		else merged.push(stretch);
	}
	return merged;
}

const gapsOf = (ink: Ink[]): number[] =>
	ink.slice(1).map((stretch, at) => stretch.from - (ink[at] as Ink).to);

const inkedLength = (ink: Ink[]): number =>
	ink.reduce((total, stretch) => total + (stretch.to - stretch.from), 0);

const NARROWEST_GAP = 2.5;
const STYLES = ['solid', 'dashed', 'dotted'] as const;

describe('the three line-style glyphs are told apart by their ink', () => {
	test('the dashed glyph has real gaps — the regression that shipped', () => {
		const gaps = gapsOf(inkOf('dashed'));
		expect(gaps.length, 'the dashed glyph paints one unbroken stretch').toBeGreaterThan(0);
		for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(NARROWEST_GAP);
	});

	test('the dotted glyph has real gaps too, and dots narrower than them', () => {
		const ink = inkOf('dotted');
		const gaps = gapsOf(ink);
		expect(gaps.length).toBeGreaterThan(0);
		for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(NARROWEST_GAP);
		for (const dot of ink) expect(dot.to - dot.from).toBeLessThan(Math.min(...gaps));
	});

	test('the solid glyph is one unbroken stretch', () => {
		expect(inkOf('solid')).toHaveLength(1);
	});

	test('no two of the three paint the same picture', () => {
		const lengths = STYLES.map((style) => inkedLength(inkOf(style)));
		expect(new Set(lengths).size, 'two glyphs paint the same amount of ink').toBe(3);
		expect(lengths[0]).toBeGreaterThan(lengths[1] as number);
		expect(lengths[1]).toBeGreaterThan(lengths[2] as number);
	});

	test('all three paint the same extent, so they weigh the same in a row', () => {
		for (const style of STYLES) {
			const ink = inkOf(style);
			expect(ink[0]?.from, `${style} does not start where the others do`).toBeCloseTo(4, 1);
			expect(ink.at(-1)?.to, `${style} does not end where the others do`).toBeCloseTo(20, 1);
		}
	});
});
