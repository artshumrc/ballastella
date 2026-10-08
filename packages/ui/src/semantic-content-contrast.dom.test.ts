import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const AA_NORMAL_TEXT = 4.5;
const ROLES = ['info', 'success', 'warning', 'error'] as const;

/** ⚠ Not `new URL(…, import.meta.url)`: Vite rewrites that form into an asset URL at transform time whenever its first argument is a literal, so what reaches `readFileSync` is an `http:` URL. */
const here = path.dirname(fileURLToPath(import.meta.url));

const source = (relative: string): string =>
	readFileSync(path.join(here, relative), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function declarations(text: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const match of text.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/g)) {
		const [, name, value] = match;
		if (name && value) found.set(name, value.replace(/\s+/g, ' ').trim());
	}
	return found;
}

type ThemeBlock = { name: string; tokens: Map<string, string> };

function themeBlocks(): ThemeBlock[] {
	return [...source('./layout.css').matchAll(/@plugin\s+'daisyui\/theme'\s*\{([^}]*)\}/g)].map(
		([, body = '']) => {
			const name = /name:\s*'([^']+)'/.exec(body)?.[1];
			expect(name, 'a theme block declares no name').toBeTruthy();
			return { name: name ?? '', tokens: declarations(body) };
		}
	);
}

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

test("every semantic ground's ink clears AA, in every theme", () => {
	const blocks = themeBlocks();
	expect(blocks.map(({ name }) => name).sort()).toEqual(['carto-dark', 'carto-light']);
	let measurements = 0;

	for (const { name, tokens } of blocks) {
		for (const role of ROLES) {
			const where = `${role} in the ${name} theme`;
			const ground = tokens.get(`--color-${role}`);
			const ink = tokens.get(`--color-${role}-content`);
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

	expect(measurements).toBe(8);
});
