// A Layer's kind is still readable before it is read, in every theme either app declares
// (ADR-0036).
//
// A Layer card's kind line — the glyph and the words "Map Image" / "Annotation Layer" — is set in the
// kind's own ink, which `layout.css` derives by mixing the kind's hue half-and-half with the theme's
// text colour. A 0.65rem uppercase label wants 4.5:1 under WCAG 2.1 AA. The palette was chosen to
// satisfy that mixing rule rather than the reverse, so this is the test that says so: a palette that
// cannot manage it is the wrong palette, not a reason to change `layer-kind-style.ts`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// NOTHING BELOW IS A HEX LITERAL, AND THAT IS THE POINT
//
// Hard-coding the ink, or the accent it comes from, would pin this test to one palette and make the
// next one a test rewrite — and it would stop being a check on the theme at all, because the
// assertion would agree with the number written beside it. So all three inputs are *read*:
//
//   1. **which custom property carries a kind's ink** — off the rendered card, out of the
//      `text-[var(--layer-kind-ink-…)]` class `layer-kind-style.ts` puts there. So a kind renamed,
//      re-pointed or dropped from the card is a failure here rather than a silent gap.
//   2. **the recipe** — the `color-mix()` in this package's own `layout.css`, including its
//      percentage and both of its inputs, so a change to the mixing rule is measured rather than
//      assumed.
//   3. **the palette** — every `@plugin 'daisyui/theme'` block in every app's `routes/layout.css`.
//      Both apps and both themes, because the two blocks are duplicates that must not diverge and a
//      test that read only one of them would pass while half the product was wrong.
//
// ⚠ **THE RATIO IS COMPUTED HERE RATHER THAN READ OFF THE DOM, BECAUSE happy-dom CANNOT RESOLVE
// `color-mix()`.** Probed before this test was written: `getComputedStyle(el).color` on an element
// whose `color` is `var(--layer-kind-ink-map)` returns the empty string, and reading the custom
// property back off `:root` returns the mix *unevaluated*, with only the `var()`s substituted. There
// is no paint and no colour engine at this seam at all. So the alternative was a test that silently
// asserted nothing whenever the DOM handed back an empty string, which is worse than no test — and
// the thing worth pinning is that *the rule the theme uses* produces a legible ink, which is exactly
// what the arithmetic below evaluates. What this seam therefore cannot prove is that a browser agrees
// with our oklab conversion; `e2e/` is where a real engine lives.
//
// ⚠ **The app stylesheets are read as data files of the repository, not imported.** ADR-0034 forbids
// this package *importing* from `apps/`, and nothing here does: no module resolves, no app code
// runs, and `check-ui-package-imports.mjs` sees no specifier. The palette lives in each app's own
// `routes/layout.css` because that is where daisyUI's theme plugin has to be invoked, so reading
// those two files is the only way to assert on the shipped values instead of on a copy of them.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import { THEMES, type Layer } from '@ballastella/core';

import { KIND_STYLE } from './layer-kind-style';
import LayerList from './LayerList.svelte';

/** WCAG 2.1 AA for text below 18.66px bold / 24px regular, which the 0.65rem kind line is. */
const AA_NORMAL_TEXT = 4.5;

// ── Reading the three inputs ──────────────────────────────────────────────────────────────────

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

/**
 * A kind's ink, as a `color-mix()` of two other theme tokens.
 *
 * `weight` is the share of `hue`; the remainder is `against`. CSS gives an unstated second
 * percentage the balance, which is what the recipe in `layout.css` relies on.
 */
type Recipe = { hue: string; weight: number; against: string };

/** Every `--layer-kind-ink-*` recipe this package declares, by the property that carries it. */
function inkRecipes(): Map<string, Recipe> {
	const pattern =
		/(--layer-kind-ink-[a-z]+)\s*:\s*color-mix\(\s*in oklab\s*,\s*var\(\s*(--[a-z0-9-]+)\s*\)\s*([\d.]+)%\s*,\s*var\(\s*(--[a-z0-9-]+)\s*\)\s*\)/g;
	const found = new Map<string, Recipe>();
	for (const match of source('./layout.css').replace(/\s+/g, ' ').matchAll(pattern)) {
		const [, property, hue, weight, against] = match;
		if (property && hue && weight && against) {
			found.set(property, { hue, weight: Number(weight) / 100, against });
		}
	}
	return found;
}

/** One `@plugin 'daisyui/theme'` block: the name it declares and the tokens it sets. */
type ThemeBlock = { app: string; name: string; tokens: Map<string, string> };

/**
 * Every theme block both apps declare.
 *
 * A token a block does not state is deliberately *not* filled in from daisyUI's built-in theme of
 * the same name, even though the plugin would merge one: this test's subject is the palette the
 * repository chose, and inheriting a value would let a deleted token pass on a stock one.
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

test('both apps emit every selectable theme', () => {
	const expected = THEMES.map(({ name }) => name).sort();
	for (const app of ['editor', 'viewer']) {
		const text = source(`../../../apps/${app}/src/routes/layout.css`);
		const builtInBody = /@plugin\s+'daisyui'\s*\{([^}]*)\}/.exec(text)?.[1] ?? '';
		const builtIns = (/themes:\s*([^;]+);/.exec(builtInBody)?.[1] ?? '')
			.split(',')
			.map((name) => name.trim())
			.filter(Boolean);
		const custom = themeBlocks()
			.filter((block) => block.app === app)
			.map(({ name }) => name);
		expect([...custom, ...builtIns].sort(), `apps/${app}`).toEqual(expected);
	}
});

// ── Colour arithmetic ─────────────────────────────────────────────────────────────────────────
// Ottosson's oklab, and WCAG 2.1's relative luminance. Linear-light sRGB is the common currency:
// oklab converts to and from it, and WCAG's coefficients are stated against it, so no value makes a
// needless round trip through gamma-encoded sRGB.

/** A colour as linear-light sRGB, each channel in 0–1. */
type Linear = { r: number; g: number; b: number };

/** A colour as oklab: perceptual lightness, and the two opponent axes. */
type Oklab = { lightness: number; a: number; b: number };

const gammaToLinear = (channel: number): number =>
	channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

function hexToLinear(hex: string): Linear {
	const digits = hex.replace('#', '');
	expect(digits, `${hex} is not a six-digit hex colour`).toMatch(/^[0-9a-fA-F]{6}$/);
	const channel = (at: number): number =>
		gammaToLinear(parseInt(digits.slice(at, at + 2), 16) / 255);
	return { r: channel(0), g: channel(2), b: channel(4) };
}

function linearToOklab({ r, g, b }: Linear): Oklab {
	const long = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const medium = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const short = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return {
		lightness: 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
		a: 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
		b: 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short
	};
}

function oklabToLinear({ lightness, a, b }: Oklab): Linear {
	const long = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const medium = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const short = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
	// A mix of two in-gamut colours can land outside sRGB. This clamp is not what a browser does —
	// CSS Color 4 maps an out-of-gamut result back by reducing chroma, not by clipping channels — it
	// only keeps a luminance from being computed off an impossible channel. None of the mixes this
	// file measures leaves sRGB, so it never fires; if a future palette makes it fire, the honest
	// fix is to implement the gamut mapping rather than to trust the clamped value.
	const clamp = (channel: number): number => Math.min(1, Math.max(0, channel));
	return {
		r: clamp(4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short),
		g: clamp(-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short),
		b: clamp(-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short)
	};
}

/** `color-mix(in oklab, first weight, second)` — both opaque, so alpha never enters it. */
function mixInOklab(first: string, weight: number, second: string): Linear {
	const one = linearToOklab(hexToLinear(first));
	const other = linearToOklab(hexToLinear(second));
	const blend = (from: number, to: number): number => from * weight + to * (1 - weight);
	return oklabToLinear({
		lightness: blend(one.lightness, other.lightness),
		a: blend(one.a, other.a),
		b: blend(one.b, other.b)
	});
}

const luminance = ({ r, g, b }: Linear): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function contrast(one: Linear, other: Linear): number {
	const [first, second] = [luminance(one), luminance(other)];
	const lighter = Math.max(first, second);
	const darker = Math.min(first, second);
	return (lighter + 0.05) / (darker + 0.05);
}

// ── The rendered card ─────────────────────────────────────────────────────────────────────────

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

const layer = (kind: 'map' | 'annotation', order: number): Layer =>
	kind === 'map'
		? { kind, id: `l${order}`, name: 'A map', visible: true, order, opacity: 1, imageId: 'i1' }
		: { kind, id: `l${order}`, name: 'Some notes', visible: true, order, geojsonRef: 'a.geojson' };

/**
 * Which custom property each kind's line is inked with, keyed by the words the reader sees.
 *
 * The card is where the mapping is made — `kindInk` picks `KIND_STYLE[kind].ink` — so reading it off
 * the rendered element rather than importing `KIND_STYLE` is what makes this a claim about what a
 * reader sees rather than a restatement of the table.
 */
function inkPropertyByKind(): Map<string, string> {
	mounted = mount(LayerList, {
		target: document.body,
		props: {
			layers: [layer('map', 0), layer('annotation', 1)],
			outcomes: {},
			referencedImageIds: new Set<string>(),
			openLayerId: null,
			onopen: vi.fn(),
			ontypename: vi.fn(),
			oncommit: vi.fn(),
			onshow: vi.fn(),
			ondragopacity: vi.fn(),
			onmove: vi.fn(),
			ondelete: vi.fn()
		}
	});
	flushSync();

	const byKind = new Map<string, string>();
	for (const line of document.querySelectorAll<HTMLElement>('[data-testid="layer-kind"]')) {
		const words = (line.textContent ?? '').trim();
		const property = /text-\[var\((--layer-kind-ink-[a-z]+)\)\]/.exec(line.className)?.[1];
		expect(property, `the kind line "${words}" is not inked from a custom property`).toBeTruthy();
		if (property) byKind.set(words, property);
	}
	return byKind;
}

// ── The claim ─────────────────────────────────────────────────────────────────────────────────

test("every Layer kind's ink clears AA on a base-100 card, in every theme both apps declare", () => {
	const inked = inkPropertyByKind();
	const recipes = inkRecipes();
	const blocks = themeBlocks();

	// Each input has to be what it should be, or the loop below asserts nothing at all — which is
	// this test's only real failure mode: two kinds, and two themes in each of two apps.
	expect([...inked.keys()].sort()).toEqual(['Annotation Layer', 'Map Image']);
	expect(blocks.map(({ app, name }) => `${app}:${name}`).sort()).toEqual([
		'editor:carto-dark',
		'editor:carto-light',
		'viewer:carto-dark',
		'viewer:carto-light'
	]);

	let measurements = 0;

	for (const [kind, property] of inked) {
		const recipe = recipes.get(property);
		expect(recipe, `${property} has no color-mix recipe in layout.css`).toBeTruthy();
		if (!recipe) continue;

		for (const { app, name, tokens } of blocks) {
			const where = `${kind} in ${app}'s ${name} theme`;
			const hue = tokens.get(recipe.hue);
			const against = tokens.get(recipe.against);
			const card = tokens.get('--color-base-100');
			expect(hue, `${where}: ${recipe.hue} is not stated`).toBeTruthy();
			expect(against, `${where}: ${recipe.against} is not stated`).toBeTruthy();
			expect(card, `${where}: --color-base-100 is not stated`).toBeTruthy();
			if (!hue || !against || !card) continue;

			const ratio = contrast(mixInOklab(hue, recipe.weight, against), hexToLinear(card));
			measurements += 1;
			expect(ratio, `${where} reads at ${ratio.toFixed(2)}:1 on its card`).toBeGreaterThanOrEqual(
				AA_NORMAL_TEXT
			);
		}
	}

	expect(measurements).toBe(8);
});

// ── The same ink, on the ground it is actually drawn on ────────────────────────────────────────
//
// The test above measures the kind line against a `base-100` card, which is what the card *body* is.
// The kind line is not on the body: it is in the header, and the header wears the kind's tint — so
// the ratio that decides whether a scholar can read "MAP IMAGE" is the ink against the *tinted*
// header, which is always the lower of the two. Nothing measured that until a tint change took the
// dark theme's kind line to 4.30:1 with every test green.
//
// This is the assertion that lets the wash be tuned freely. How strong the tint is is a design
// decision and no test should pin its value; that it stays legible is not a design decision, and this
// is where it is enforced.
//
// ⚠ **The tint's alpha is read out of `KIND_STYLE`, not written here.** `bg-accent/30` is a Tailwind
// utility whose opacity suffix is the alpha, and importing the table is the point: a tint retuned to
// any value is measured at that value rather than at the one this file was written beside.
//
// ⚠ **Alpha is composited in gamma-encoded sRGB, unlike the `color-mix()` above.** Those are two
// different operations and they do not share a space: `color-mix(in oklab, …)` is interpolation and
// happens where it says, while painting a semi-transparent background over another colour is
// compositing, which browsers do on the gamma-encoded channels. Doing it in linear light here would
// flatter the result by a few hundredths and report a ratio no browser produces.

/** `bg-accent/30` → the token it names and its alpha. */
function tintOf(utility: string): { token: string; alpha: number } | null {
	const match = /^bg-([a-z-]+)\/(\d+)$/.exec(utility);
	if (!match) return null;
	const [, name, percent] = match;
	if (!name || !percent) return null;
	return { token: `--color-${name}`, alpha: Number(percent) / 100 };
}

const linearToGamma = (channel: number): number => {
	const clamped = Math.min(1, Math.max(0, channel));
	return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
};

/** `foreground` at `alpha` painted over `background`, the way a browser paints it. */
function compositeOver(foreground: Linear, background: Linear, alpha: number): Linear {
	const blend = (from: number, to: number): number => {
		const mixed = alpha * linearToGamma(from) + (1 - alpha) * linearToGamma(to);
		return gammaToLinear(mixed);
	};
	return {
		r: blend(foreground.r, background.r),
		g: blend(foreground.g, background.g),
		b: blend(foreground.b, background.b)
	};
}

test("every Layer kind's ink clears AA on its own tinted header, in every theme both apps declare", () => {
	const recipes = inkRecipes();
	const blocks = themeBlocks();

	// The two drawn kinds. `foreign` is excluded deliberately: it wears the drained wash and states
	// its ink as a plain `base-content` opacity rather than through a `color-mix` recipe, so it is not
	// a hue on a tint and has nothing to measure here.
	const kinds = [
		{ kind: 'map', style: KIND_STYLE.map },
		{ kind: 'annotation', style: KIND_STYLE.annotation }
	] as const;

	let measurements = 0;

	for (const { kind, style } of kinds) {
		const tint = tintOf(style.tint);
		expect(tint, `${kind}'s tint "${style.tint}" is not a bg-<token>/<alpha> utility`).toBeTruthy();
		const property = /text-\[var\((--layer-kind-ink-[a-z]+)\)\]/.exec(style.ink)?.[1];
		expect(property, `${kind}'s ink "${style.ink}" names no custom property`).toBeTruthy();
		if (!tint || !property) continue;

		const recipe = recipes.get(property);
		expect(recipe, `${property} has no color-mix recipe in layout.css`).toBeTruthy();
		if (!recipe) continue;

		for (const { app, name, tokens } of blocks) {
			const where = `${kind} in ${app}'s ${name} theme`;
			const hue = tokens.get(recipe.hue);
			const against = tokens.get(recipe.against);
			const card = tokens.get('--color-base-100');
			const tintHue = tokens.get(tint.token);
			expect(tintHue, `${where}: ${tint.token} is not stated`).toBeTruthy();
			if (!hue || !against || !card || !tintHue) continue;

			const header = compositeOver(hexToLinear(tintHue), hexToLinear(card), tint.alpha);
			const ink = mixInOklab(hue, recipe.weight, against);
			const ratio = contrast(ink, header);
			measurements += 1;
			expect(
				ratio,
				`${where} reads at ${ratio.toFixed(2)}:1 on its ${style.tint} header`
			).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
		}
	}

	expect(measurements).toBe(8);
});
