// There is no monospaced face in either app, including inside a `<code>` (ADR-0036).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test } from 'vitest';

import ProjectCardList from './ProjectCardList.svelte';

/** ⚠ Not `new URL('./layout.css', import.meta.url)`: Vite rewrites that literal form into an asset URL at transform time, so what reaches `readFileSync` is an `http:` URL rather than a path. */
const stylesheet = (): string =>
	readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'layout.css'), 'utf8');

const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '');

function themeValue(property: string): string {
	const value = new RegExp(`${property}\\s*:\\s*([^;]+);`).exec(withoutComments(stylesheet()))?.[1];
	expect(value, `${property} is not declared in layout.css`).toBeTruthy();
	return (value ?? '').replace(/\s+/g, ' ').trim();
}

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

/** The cascade a browser would build, in the order a browser builds it. */
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
	const sameQuoting = (family: string): string => family.replace(/'/g, '"');
	expect(sameQuoting(resolvedFontFamily(literal))).toBe(sameQuoting(textFace));
});
