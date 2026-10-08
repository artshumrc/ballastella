import type { Flavor } from '@protomaps/basemaps';

import type { ThemeScheme } from '../theme';

type LandPalette = {
	readonly park: string;
	readonly wood: string;
	readonly scrub: string;
	readonly sand: string;
	readonly beach: string;
	readonly glacier: string;
};

export const PHYSICAL_LAND: Readonly<Record<ThemeScheme, LandPalette>> = {
	light: {
		park: '#9ccfa2',
		wood: '#7fb98a',
		scrub: '#bccd8f',
		sand: '#d9cb93',
		beach: '#e2d290',
		glacier: '#f7fbff'
	},
	dark: {
		park: '#35513a',
		wood: '#2a4230',
		scrub: '#46492f',
		sand: '#4a442f',
		beach: '#55503a',
		glacier: '#3f4750'
	}
};

export const physicalFlavor = (flavor: Flavor, scheme: ThemeScheme): Flavor =>
	withLand(flavor, PHYSICAL_LAND[scheme]);

export function withLand(flavor: Flavor, land: LandPalette): Flavor {
	return {
		...flavor,
		wood_a: land.wood,
		wood_b: land.wood,
		scrub_a: land.scrub,
		scrub_b: land.scrub,
		park_a: land.park,
		park_b: land.park,
		sand: land.sand,
		beach: land.beach,
		glacier: land.glacier
	};
}
