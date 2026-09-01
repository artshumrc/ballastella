// The needle as the align view draws it: real paths in a real `<svg>`.
//
// A browser test rather than a node one because it is about what `needleSvg` builds, and the whole
// reason that function exists is that a Control Point is a DOM marker — `document` is the subject,
// not an inconvenience. The geometry the two renderers share is checked in `needle.test.ts`.

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
		// The point of the module: what the align view puts in a `<button>` is not a shape matched to
		// the Pin by hand, it is the Pin's own paths.
		const svg = needleSvg(document);
		const paths = [...svg.querySelectorAll('path')];

		expect(paths.map((path) => path.getAttribute('d'))).toEqual([
			NEEDLE_HEAD_PATH,
			NEEDLE_SHAFT_PATH,
			NEEDLE_HEAD_PATH,
			NEEDLE_SHAFT_PATH
		]);
		// Halo first, so the fills cover the inner half of every stroke — including the stroke that
		// would otherwise draw a white line across the join where the shaft enters the head.
		expect(paths.map((path) => path.getAttribute('class'))).toEqual([
			'needle-halo',
			'needle-halo',
			'needle-body',
			'needle-body'
		]);
		expect(svg.getAttribute('viewBox')).toBe(`0 0 ${NEEDLE_GRID} ${NEEDLE_GRID}`);
	});

	test('carries an ordinal slot centred on the head, and nothing in it yet', () => {
		// A Control Point's number cannot be the element's `textContent` — that would delete the
		// drawing — so `overlay-points.ts` writes it here.
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
