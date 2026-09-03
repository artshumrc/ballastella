import { describe, expect, it } from 'vitest';
import { namedFlavor } from '@protomaps/basemaps';

import { PHYSICAL_LAND, physicalFlavor } from './physical';
import type { ThemeScheme } from '../theme';

const channels = (colour: string): number[] => {
	const value = Number.parseInt(colour.slice(1), 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
};

const luminance = (colour: string): number => {
	const linear = (channel: number): number => {
		const unit = channel / 255;
		return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	};
	const [r = 0, g = 0, b = 0] = channels(colour);
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};

const contrast = (a: string, b: string): number => {
	const [x, y] = [luminance(a), luminance(b)];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/**
 * The floor the palette's docstring claims. Low on purpose — these are neighbouring areas, not text
 * — but a class that falls under it is a class the reader cannot find, which is the bug this palette
 * exists to fix.
 */
const LAND_AGAINST_EARTH = 1.12;

describe('the physical land palette', () => {
	for (const scheme of ['light', 'dark'] as const satisfies readonly ThemeScheme[]) {
		it(`separates every ${scheme} land class from the earth it is drawn on`, () => {
			const earth = namedFlavor(scheme).earth;

			for (const [name, colour] of Object.entries(PHYSICAL_LAND[scheme])) {
				expect(`${name} ${contrast(colour, earth) >= LAND_AGAINST_EARTH}`).toBe(`${name} true`);
			}
		});
	}

	it('repaints the land and leaves the water and the earth alone', () => {
		const flavor = namedFlavor('light');
		const physical = physicalFlavor(flavor, 'light');

		expect(physical.park_b).toBe(PHYSICAL_LAND.light.park);
		expect(physical.wood_b).toBe(PHYSICAL_LAND.light.wood);
		expect(physical.scrub_b).toBe(PHYSICAL_LAND.light.scrub);
		expect(physical.water).toBe(flavor.water);
		expect(physical.earth).toBe(flavor.earth);
	});

	it('draws the park greener than the earth rather than paler, which is the bug it replaces', () => {
		// The landcover struct is the palette the previous derivation borrowed, and it is still what
		// the `landcover` layer draws at the zooms it is visible at — so the comparison is live, not
		// historical.
		const flavor = namedFlavor('light');
		const borrowed = flavor.landcover?.grassland ?? '';

		expect(contrast(PHYSICAL_LAND.light.park, flavor.earth)).toBeGreaterThan(
			contrast(
				borrowed.replace(
					/rgba?\((\d+), (\d+), (\d+).*/,
					(_, r, g, b) =>
						`#${[r, g, b].map((c: string) => Number(c).toString(16).padStart(2, '0')).join('')}`
				),
				flavor.earth
			)
		);
	});
});
