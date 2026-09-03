import { namedFlavor } from '@protomaps/basemaps';
import { describe, expect, it } from 'vitest';

import { highContrastFlavor } from './high-contrast';
import type { ThemeScheme } from '../theme';

/**
 * WCAG contrast, computed here rather than imported.
 *
 * `borders.ts` has the same arithmetic and keeps it private, and that is the right shape for both:
 * a palette checked with the helper the palette was built against is a palette checked against
 * itself. This is the second opinion.
 */
const contrast = (a: string, b: string): number => {
	const luminance = (colour: string): number => {
		const value = Number.parseInt(colour.slice(1), 16);
		const linear = (channel: number): number => {
			const unit = channel / 255;
			return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
		};
		return (
			0.2126 * linear((value >> 16) & 0xff) +
			0.7152 * linear((value >> 8) & 0xff) +
			0.0722 * linear(value & 0xff)
		);
	};
	const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y) as [number, number];
	return (high + 0.05) / (low + 0.05);
};

const SCHEMES: readonly ThemeScheme[] = ['light', 'dark'];

/** Every flavor `@protomaps/basemaps` ships, which is the bar this palette exists to clear. */
const NAMED = ['light', 'dark', 'grayscale', 'white', 'black'] as const;

const highContrast = (scheme: ThemeScheme) =>
	highContrastFlavor(namedFlavor(scheme === 'dark' ? 'black' : 'white'), scheme);

describe('the high-contrast palette', () => {
	it.each(SCHEMES)('draws %s at the two ends of the ramp', (scheme) => {
		const flavor = highContrast(scheme);

		expect(contrast(flavor.major, flavor.earth)).toBe(21);
		expect(contrast(flavor.city_label, flavor.city_label_halo)).toBe(21);
		expect(contrast(flavor.boundaries, flavor.earth)).toBe(21);
	});

	it.each(SCHEMES)('beats every named flavor in %s, which is the whole point', (scheme) => {
		// ⚠ **The switch used to be a flavor name, and named `grayscale`** — a palette whose classes
		// all sit between #a3a3a3 and #ebebeb. It was labelled High contrast and was the *lowest*
		// contrast option in the app. Nothing but a comparison catches that again.
		const road = highContrast(scheme);

		for (const name of NAMED) {
			const named = namedFlavor(name);
			expect(contrast(road.major, road.earth)).toBeGreaterThan(contrast(named.major, named.earth));
		}
	});

	it.each(SCHEMES)('keeps water and buildings off both ends in %s', (scheme) => {
		// The two classes that may not be either extreme: they are areas, and an area at the ink's own
		// value is an area that swallows every line drawn over it.
		const flavor = highContrast(scheme);

		expect(contrast(flavor.water, flavor.earth)).toBeGreaterThanOrEqual(4.5);
		// A road only crosses water on a bridge, and a bridge is drawn inside a casing — so what has
		// to be legible against the water is the casing, which is why water gets to be the darker of
		// the two mid-tones.
		expect(contrast(flavor.bridges_major_casing, flavor.water)).toBeGreaterThanOrEqual(3);

		expect(contrast(flavor.buildings, flavor.earth)).toBeGreaterThanOrEqual(3);
		expect(contrast(flavor.buildings, flavor.major)).toBeGreaterThanOrEqual(3);
	});

	it.each(SCHEMES)('carries the landcover a physical map is made of in %s', (scheme) => {
		// `white` and `black` carry no `landcover` struct, so without this a high-contrast map with
		// `streets` off would be an earth-coloured rectangle — see `appearanceFlavor` in `style.ts`.
		const landcover = highContrast(scheme).landcover;

		expect(landcover).toBeDefined();
		expect(contrast(landcover!.forest, highContrast(scheme).earth)).toBeGreaterThanOrEqual(3);
	});
});
