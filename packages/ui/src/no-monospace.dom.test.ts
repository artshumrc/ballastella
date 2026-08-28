// There is no monospaced face in either app, including inside a `<code>` (ADR-0036).
//
// A folder path, a Control Point's coordinate readout, a Workspace's folder name and an image
// pyramid's figures all reach for `<code>`, and `<code>`'s meaning — *this is a literal string* — is
// kept by a tinted ground and tabular figures rather than by a second family. The four-selector
// reset in `layout.css` is the whole of what holds that, and **its absence is silent**: delete it and
// the browser's own default monospace applies at all four call sites with nothing erroring.
//
// The `tabular-nums` assertion in `editor-alignment.e2e.ts` is not evidence about any of this.
// Tabular figures are not monospace, so the text face satisfies it either way.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// ⚠ THE UA DEFAULT IS SUPPLIED BY THIS TEST, AND WITHOUT THAT THE TEST WOULD BE WORTHLESS
//
// happy-dom ships no user-agent stylesheet, so `<code>` here starts with no family of its own and
// simply inherits the page's. Measured before this test was written: with the reset deleted, a
// `<code>` still computed to the text face — so a test that only rendered the component and read the
// family back would have passed whether the reset existed or not, which is precisely the failure
// mode the reset exists to prevent.
//
// So the cascade a browser would really build is assembled here, in the order a browser assembles
// it: the UA default first, then Tailwind's preflight family on `html`, then the app's own rules
// **read out of `layout.css` rather than restated**. Nothing asserts that the reset is present — a
// structural check would pass on a rule that had stopped matching — and if the extraction below ever
// stops finding it, the code element keeps the UA monospace and this test fails. It fails safe in
// both directions.
//
// ⚠ **`inherit` is resolved here because happy-dom does not resolve it.** `getComputedStyle` returns
// the literal keyword rather than the inherited value, so {@link resolvedFontFamily} walks to the
// parent for it. That is a gap in the DOM implementation and not a claim about CSS; a real engine is
// `e2e/`'s.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test } from 'vitest';

import ProjectCardList from './ProjectCardList.svelte';

/** ⚠ Not `new URL('./layout.css', import.meta.url)`: Vite rewrites that literal form into an asset
 * URL at transform time, so what reaches `readFileSync` is an `http:` URL rather than a path. */
const stylesheet = (): string =>
	readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'layout.css'), 'utf8');

/** The stylesheet with its comments taken out, so a rule quoted in prose is never read as a rule. */
const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '');

/** The value of one `@theme` custom property — the text face is `--font-sans`, as Tailwind's own
 * `--default-font-family` resolves to. */
function themeValue(property: string): string {
	const value = new RegExp(`${property}\\s*:\\s*([^;]+);`).exec(withoutComments(stylesheet()))?.[1];
	expect(value, `${property} is not declared in layout.css`).toBeTruthy();
	return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Every rule in `layout.css` whose selector list is drawn only from the four literal-string
 * elements — the reset, however it is currently spelled and however prettier has wrapped it.
 */
function literalStringRules(): string {
	const literalStringElements = ['code', 'kbd', 'samp', 'pre'];
	const rules: string[] = [];
	for (const rule of withoutComments(stylesheet()).matchAll(
		/([a-z][a-z0-9\s,]*?)\s*\{([^{}]*)\}/gi
	)) {
		const parts = (rule[1] ?? '')
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean);
		if (parts.length > 0 && parts.every((part) => literalStringElements.includes(part))) {
			rules.push(`${parts.join(',')} { ${(rule[2] ?? '').trim()} }`);
		}
	}
	return rules.join('\n');
}

/**
 * The cascade a browser would build, in the order a browser builds it.
 *
 * The UA default is what the app's reset exists to override, so it has to be here or the reset
 * overrides nothing. Tailwind's preflight puts `--font-sans` on `html`; that is where a `<code>`
 * with `font-family: inherit` gets its family from.
 */
function styleTheDocument(textFace: string): void {
	document.head.innerHTML = '';
	const sheet = document.createElement('style');
	sheet.textContent = [
		'code, kbd, samp, pre { font-family: monospace; }',
		`html { font-family: ${textFace}; }`,
		literalStringRules()
	].join('\n');
	document.head.append(sheet);
}

/** A computed `font-family`, with happy-dom's unresolved `inherit` followed to its source. */
function resolvedFontFamily(element: Element): string {
	const declared = getComputedStyle(element).fontFamily.trim();
	if (declared !== 'inherit') return declared;
	expect(element.parentElement, 'nothing inherits from the document root').toBeTruthy();
	return resolvedFontFamily(element.parentElement!);
}

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
	document.head.innerHTML = '';
});

test("a rendered <code> is set in the text face and not in the browser's monospace", () => {
	const textFace = themeValue('--font-sans');
	// The face itself is read rather than written, so this test does not pin the palette's type
	// choice — only that a literal string is set in whatever face the app's body is set in.
	expect(textFace).not.toMatch(/monospace/);
	styleTheDocument(textFace);

	mounted = mount(ProjectCardList, {
		target: document.body,
		props: {
			projects: [{ directory: 'a-project', name: 'A Project', href: './?p=a-project' }]
		}
	});
	flushSync();

	const literals = [...document.querySelectorAll('code')];
	expect(literals, 'the card renders no <code> for this test to measure').toHaveLength(1);
	const literal = literals[0];
	if (!literal) return;
	// Quotes are normalised on both sides: a family name written `'…'` in the stylesheet comes back
	// from `getComputedStyle` as `"…"`, which is a serialisation detail and not a difference.
	const sameQuoting = (family: string): string => family.replace(/'/g, '"');
	expect(sameQuoting(resolvedFontFamily(literal))).toBe(sameQuoting(textFace));
});
