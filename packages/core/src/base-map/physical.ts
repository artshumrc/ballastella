// The palette a map with `streets` off draws its land classes in.
//
// **Named values rather than a transform of the flavor**, for the reason `high-contrast.ts` gives
// about its own ramp. The obvious derivation — take the flavor's own park and woodland greens and
// push them a step further from the earth — works in `light` and has nothing to work with in
// `dark`, where upstream paints woodland `#202121` against a `#1f1f1f` earth: it is a deliberately
// near-monochrome flavor, and a saturation applied to a neutral grey returns the same neutral grey.
//
// The earlier derivation borrowed the flavor's `landcover` struct instead. That struct is the
// palette the `landcover` layer draws at z5–7, and its own `fill-opacity` reaches zero by z7 —
// precisely where `landuse_park`, which draws every park, wood and scrub polygon a reader sees at
// working zoom, is still fading in. Borrowing it painted the physical map in colours tuned for a
// scale at which they are not on screen, so turning the streets off *lost* the green it meant to
// bring forward.
//
// `landcover` itself is left alone: at the zooms where it is visible it is already the subject.

import type { Flavor } from '@protomaps/basemaps';

import type { ThemeScheme } from '../theme';

/**
 * One scheme's land classes.
 *
 * Ordered as a ramp from the vegetated to the bare, and each one at least 1.12:1 against its
 * scheme's earth — `physical.test.ts` asserts that floor, which is what stops a future edit from
 * reintroducing an invisible class. That is far below a text ratio and deliberately so: these are
 * broad areas whose neighbours are each other, and a physical map pushed to 3:1 per class is seven
 * flat blocks rather than a landscape.
 */
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

/**
 * `flavor` with its land classes repainted for a map whose subject is the natural world.
 *
 * `water` is deliberately untouched: it is already the flavor's most saturated colour, and dropping
 * the built environment is about bringing the *land* up to it rather than inventing a palette.
 */
export function physicalFlavor(flavor: Flavor, scheme: ThemeScheme): Flavor {
	const land = PHYSICAL_LAND[scheme];
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
