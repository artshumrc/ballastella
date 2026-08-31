// A semantic notice is legible in every theme either app declares (ADR-0036).
//
// `alert-info`, `badge-success`, `btn-error` and every other semantic surface daisyUI draws sets its
// ground from `--color-{info,success,warning,error}` and its ink from that token's `-content` pair.
// ADR-0036's table originally stated the four grounds and not the four inks, and an omitted token is
// **inherited rather than undefined**: `daisyui/theme` merges a custom block with the built-in theme
// of the same name, and `light` and `dark` are both built-in names. Stock's inks are drawn for
// stock's *light* semantic colours while Sidereal's are dark, so the inherited pairs rendered at
// 1.53:1 to 2.16:1 in the light theme — illegible, across roughly seventy call sites, with nothing
// erroring and no test failing.
//
// So this is the test that says the eight pairs are legible. It exists because the failure mode it
// covers is invisible: a `-content` token deleted from a theme block does not break a build, it
// quietly reinstates a stock value chosen for a different palette.
//
// ⚠ **NO HEX LITERAL APPEARS BELOW, AND THAT IS THE POINT.** Both halves of every pair are read out
// of the shipped stylesheets, so a palette change is measured rather than assumed and this file never
// agrees with a number written beside it. Unlike `layer-kind-contrast.dom.test.ts` there is no
// `color-mix()` in the way — a semantic ground and its ink are both stated outright — which is why
// this file carries gamma decoding and WCAG's coefficients but none of that file's oklab machinery.
//
// ⚠ **The app stylesheets are read as data files, not imported.** ADR-0034 forbids this package
// importing from `apps/`, and nothing here does: no module resolves and no app code runs. The palette
// lives in each app's `routes/layout.css` because that is where daisyUI's theme plugin must be
// invoked, so reading those two files is the only way to assert on the shipped values rather than on
// a copy of them.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

/** WCAG 2.1 AA for body-sized text, which an alert's words and a badge's label both are. */
const AA_NORMAL_TEXT = 4.5;

/** The four semantic roles daisyUI pairs a ground with an ink for. */
const ROLES = ['info', 'success', 'warning', 'error'] as const;

/**
 * This file's own directory, for the stylesheets read below.
 *
 * ⚠ Not `new URL(…, import.meta.url)`: Vite rewrites that form into an asset URL at transform time
 * whenever its first argument is a literal, so what reaches `readFileSync` is an `http:` URL.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

/** A stylesheet with its comments taken out, so a value named in prose is never read as a value. */
const source = (relative: string): string =>
	readFileSync(path.join(here, relative), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `--foo: bar;` in `text`, whitespace inside a value collapsed so a wrapped one still reads. */
function declarations(text: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const match of text.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/g)) {
		const [, name, value] = match;
		if (name && value) found.set(name, value.replace(/\s+/g, ' ').trim());
	}
	return found;
}

/** One `@plugin 'daisyui/theme'` block: the name it declares and the tokens it sets. */
type ThemeBlock = { app: string; name: string; tokens: Map<string, string> };

/**
 * Every theme block both apps declare — both apps, because the two blocks are duplicates that must
 * not diverge and a test reading only one would pass while half the product was wrong.
 *
 * A token a block does not state is deliberately **not** filled in from daisyUI's built-in theme of
 * the same name, even though the plugin would merge one. Inheriting here would defeat the test: the
 * whole subject is that an inherited semantic ink is the illegible case.
 */
function themeBlocks(): ThemeBlock[] {
	const blocks: ThemeBlock[] = [];
	for (const app of ['editor', 'viewer']) {
		const text = source(`../../../apps/${app}/src/routes/layout.css`);
		for (const match of text.matchAll(/@plugin\s+'daisyui\/theme'\s*\{([^}]*)\}/g)) {
			const body = match[1] ?? '';
			const name = /name:\s*'([^']+)'/.exec(body)?.[1];
			expect(name, `a theme block in apps/${app} declares no name`).toBeTruthy();
			blocks.push({ app, name: name ?? '', tokens: declarations(body) });
		}
	}
	return blocks;
}

// ── Colour arithmetic ─────────────────────────────────────────────────────────────────────────
// WCAG 2.1's relative luminance, whose coefficients are stated against linear-light sRGB — so each
// hex channel is gamma-decoded on the way in and nothing round-trips through another space.

/** A colour as linear-light sRGB, each channel in 0–1. */
type Linear = { r: number; g: number; b: number };

const gammaToLinear = (channel: number): number =>
	channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

function hexToLinear(hex: string): Linear {
	const digits = hex.replace('#', '');
	expect(digits, `${hex} is not a six-digit hex colour`).toMatch(/^[0-9a-fA-F]{6}$/);
	const channel = (at: number): number =>
		gammaToLinear(parseInt(digits.slice(at, at + 2), 16) / 255);
	return { r: channel(0), g: channel(2), b: channel(4) };
}

const luminance = ({ r, g, b }: Linear): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function contrast(one: Linear, other: Linear): number {
	const [first, second] = [luminance(one), luminance(other)];
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

// ── The claim ─────────────────────────────────────────────────────────────────────────────────

test("every semantic ground's ink clears AA, in every theme both apps declare", () => {
	const blocks = themeBlocks();

	// Four blocks, or the loop below asserts less than it looks like it does.
	expect(blocks.map(({ app, name }) => `${app}:${name}`).sort()).toEqual([
		'editor:carto-dark',
		'editor:carto-light',
		'viewer:carto-dark',
		'viewer:carto-light'
	]);

	let measurements = 0;

	for (const { app, name, tokens } of blocks) {
		for (const role of ROLES) {
			const where = `${role} in ${app}'s ${name} theme`;
			const ground = tokens.get(`--color-${role}`);
			const ink = tokens.get(`--color-${role}-content`);

			// Stated, not inherited. This is the assertion that fails if a `-content` token is
			// dropped from a block and daisyUI silently merges a stock one back in.
			expect(ground, `${where}: --color-${role} is not stated`).toBeTruthy();
			expect(ink, `${where}: --color-${role}-content is not stated`).toBeTruthy();
			if (!ground || !ink) continue;

			const ratio = contrast(hexToLinear(ink), hexToLinear(ground));
			measurements += 1;
			expect(ratio, `${where} reads at ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
				AA_NORMAL_TEXT
			);
		}
	}

	expect(measurements).toBe(16);
});
