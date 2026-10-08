import { describe, expect, it } from 'vitest';
import { namedFlavor } from '@protomaps/basemaps';

import { contrastRatio as contrast } from './borders';
import { PHYSICAL_LAND, physicalFlavor } from './physical';
import type { ThemeScheme } from '../theme';

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
