// The solid / dashed / dotted glyphs, measured as **ink** rather than read as markup.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS TEST EXISTS
//
// The dashed glyph shipped identical to the solid one. Not similar — the same picture. It was three
// 4-unit dashes separated by 2-unit gaps, and `stroke-linecap="round"` at `stroke-width="2"` paints a
// semicircle of radius 1 past each endpoint, so every gap lost 1 unit at each side and closed exactly.
// The markup said "dashed" in three places, the file was named `LineDashed`, its comment explained the
// dash pattern, and the rendered result was a solid rule.
//
// **Every check that could have caught it was passing.** `svelte-check` sees valid markup; the e2e
// suite clicks `annotation-line-style-dashed` and asserts the *file* gets `[8, 4]`, which is true of a
// button with any picture on it at all; and a human reviewer reads `h4` and a 2-unit gap and does not
// multiply the stroke width by a half. It took someone looking at the screen and saying so.
//
// So the assertion here is on the geometry a renderer would paint: each path's own extent, grown by
// the cap overhang, merged where those overlap. That is the one description in which "the gap closed"
// is a statement about a number.
//
// **Not a browser test, and not a screenshot.** This app's vitest project is Node-only on purpose (see
// `vitest.config.ts`) and rasterising three 16px glyphs to compare pixels would need a browser to say
// something arithmetic. The cap rule is two lines of SVG spec — `stroke-linecap: round` extends the
// path by half the stroke width at each end — and applying it here is what makes the defect visible
// without one.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/** One stretch of ink along the rule, in viewBox units. */
interface Ink {
	readonly from: number;
	readonly to: number;
}

/**
 * Where a glyph puts ink, left to right, with the round caps accounted for.
 *
 * Reads the component's own source rather than a copy of the numbers, so the test is measuring the
 * shipped glyph. Deliberately narrow: it understands the one path shape these three files use —
 * `M<x> 12h<length>` — and throws on anything else rather than silently measuring nothing. A glyph
 * drawn some other way is a glyph this test is not checking, and that should be loud.
 */
function inkOf(icon: string): Ink[] {
	const source = readFileSync(join(here, `${icon}.svelte`), 'utf8');

	const width = /stroke-width="([\d.]+)"/.exec(source)?.[1];
	expect(width, `${icon} states no stroke-width`).toBeDefined();
	// A round cap paints half the stroke width past each end; a butt cap would paint none. Read from
	// the file rather than assumed, because the whole defect was an assumption about this number.
	const cap = /stroke-linecap="round"/.test(source) ? Number(width) / 2 : 0;

	const paths = [...source.matchAll(/<path d="([^"]+)"/g)].map(([, d]) => d as string);
	expect(paths.length, `${icon} has no paths`).toBeGreaterThan(0);

	const painted = paths.map((d) => {
		const drawn = /^M(-?[\d.]+) 12h(-?[\d.]+)$/.exec(d);
		if (!drawn) throw new Error(`${icon}: this test only understands "M<x> 12h<len>", not "${d}"`);
		const from = Number(drawn[1]);
		return { from: from - cap, to: from + Number(drawn[2]) + cap };
	});

	// Merged, because two paths whose caps overlap are one stretch of ink — which is precisely what the
	// broken dashed glyph was, and a test that reported three separate dashes would have agreed with the
	// markup instead of with the screen.
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

/**
 * The narrowest gap worth drawing, in viewBox units.
 *
 * These render at 16px (`size-4`) from a 24-unit viewBox, so one unit is two thirds of a pixel and the
 * stroke itself is 1.33px. 2.5 units is about 1.7px: wider than the stroke, which is what makes a gap
 * read as a gap rather than as an artefact.
 */
const NARROWEST_GAP = 2.5;

describe('the three line-style glyphs are told apart by their ink', () => {
	test('the dashed glyph has real gaps — the regression that shipped', () => {
		// The one assertion this file exists for. With three 4-unit dashes and 2-unit gaps it was
		// `[{ from: 3, to: 21 }]`: one stretch, no gaps, identical to solid.
		const gaps = gapsOf(inkOf('LineDashed'));

		expect(gaps.length, 'the dashed glyph paints one unbroken stretch').toBeGreaterThan(0);
		for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(NARROWEST_GAP);
	});

	test('the dotted glyph has real gaps too, and dots narrower than them', () => {
		const ink = inkOf('LineDotted');
		const gaps = gapsOf(ink);

		expect(gaps.length).toBeGreaterThan(0);
		for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(NARROWEST_GAP);
		// What makes it read as dotted rather than as a thin dashed line: every dot is narrower than the
		// space beside it. Without this, "dotted" and "dashed" differ only in degree.
		for (const dot of ink) expect(dot.to - dot.from).toBeLessThan(Math.min(...gaps));
	});

	test('the solid glyph is one unbroken stretch', () => {
		expect(inkOf('LineSolid')).toHaveLength(1);
	});

	test('no two of the three paint the same picture', () => {
		// The defect, stated as the property that was violated. Ink length is what a reader's eye
		// integrates: solid 16 units, dashed 12, dotted 8.
		const lengths = (['LineSolid', 'LineDashed', 'LineDotted'] as const).map((icon) =>
			inkedLength(inkOf(icon))
		);

		expect(new Set(lengths).size, 'two glyphs paint the same amount of ink').toBe(3);
		expect(lengths[0]).toBeGreaterThan(lengths[1] as number);
		expect(lengths[1]).toBeGreaterThan(lengths[2] as number);
	});

	test('all three paint the same extent, so they weigh the same in a row', () => {
		// A trio where one glyph is longer than the others reads as three sizes rather than three
		// patterns — and the solid one *was* 2 units wider at each end before this.
		//
		// To a hundredth of a unit rather than exactly, and the slack is the dotted glyph's `h.01`: a
		// "zero-length" dot is Lucide's own idiom for a round dot and it is not quite zero, so that glyph
		// ends at 20.01. One hundredth of a viewBox unit is seven thousandths of a pixel at the size these
		// render — below the threshold of anything, including the rasteriser's. Asserting exact equality
		// here would be asserting the idiom away.
		for (const icon of ['LineSolid', 'LineDashed', 'LineDotted'] as const) {
			const ink = inkOf(icon);
			expect(ink[0]?.from, `${icon} does not start where the others do`).toBeCloseTo(4, 1);
			expect(ink.at(-1)?.to, `${icon} does not end where the others do`).toBeCloseTo(20, 1);
		}
	});
});
