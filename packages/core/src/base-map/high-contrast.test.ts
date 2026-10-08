import { namedFlavor } from '@protomaps/basemaps';
import { describe, expect, it } from 'vitest';

import { contrastRatio as contrast } from './borders';
import { highContrastFlavor } from './high-contrast';
import type { ThemeScheme } from '../theme';

const SCHEMES: readonly ThemeScheme[] = ['light', 'dark'];
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
		const road = highContrast(scheme);

		for (const name of NAMED) {
			const named = namedFlavor(name);
			expect(contrast(road.major, road.earth)).toBeGreaterThan(contrast(named.major, named.earth));
		}
	});

	it.each(SCHEMES)('keeps water and buildings off both ends in %s', (scheme) => {
		const flavor = highContrast(scheme);
		expect(contrast(flavor.water, flavor.earth)).toBeGreaterThanOrEqual(4.5);
		expect(contrast(flavor.bridges_major_casing, flavor.water)).toBeGreaterThanOrEqual(3);
		expect(contrast(flavor.buildings, flavor.earth)).toBeGreaterThanOrEqual(3);
		expect(contrast(flavor.buildings, flavor.major)).toBeGreaterThanOrEqual(3);
	});

	it.each(SCHEMES)('carries the landcover a physical map is made of in %s', (scheme) => {
		const landcover = highContrast(scheme).landcover;
		expect(landcover).toBeDefined();
		expect(contrast(landcover!.forest, highContrast(scheme).earth)).toBeGreaterThanOrEqual(3);
	});
});
