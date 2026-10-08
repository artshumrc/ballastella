import { describe, expect, test } from 'vitest';

import {
	NEEDLE_GRID,
	NEEDLE_HEAD,
	NEEDLE_HEAD_PATH,
	NEEDLE_SHAFT_PATH,
	needleOrdinal,
	needleSvg
} from './needle.js';

describe('the DOM rendering', () => {
	test('draws the same paths the field is rasterised from, haloed under filled', () => {
		const svg = needleSvg(document);
		const paths = [...svg.querySelectorAll('path')];

		expect(paths.map((path) => path.getAttribute('d'))).toEqual([
			NEEDLE_HEAD_PATH,
			NEEDLE_SHAFT_PATH,
			NEEDLE_HEAD_PATH,
			NEEDLE_SHAFT_PATH
		]);
		expect(paths.map((path) => path.getAttribute('class'))).toEqual([
			'needle-halo',
			'needle-halo',
			'needle-body',
			'needle-body'
		]);
		expect(svg.getAttribute('viewBox')).toBe(`0 0 ${NEEDLE_GRID} ${NEEDLE_GRID}`);
	});

	test('carries an ordinal slot centred on the head, and nothing in it yet', () => {
		const svg = needleSvg(document);
		const ordinal = needleOrdinal(svg);
		expect(ordinal).not.toBeNull();
		expect(ordinal?.textContent).toBe('');
		expect(Number(ordinal?.getAttribute('x'))).toBe(NEEDLE_HEAD.cx);
		expect(Number(ordinal?.getAttribute('y'))).toBe(NEEDLE_HEAD.cy);
	});

	test('is decoration: the mark is named by the button around it', () => {
		expect(needleSvg(document).getAttribute('aria-hidden')).toBe('true');
	});
});
