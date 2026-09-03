// The palette the `highContrast` appearance switch paints.
//
// **A repaint of a flavor rather than a flavor name**, which is the one thing this switch used to
// be. Every Protomaps flavor is a cartographic style first: `grayscale` puts every class between
// #a3a3a3 and #ebebeb, and `white` and `black` sit their roads a step or two off a near-uniform
// ground. All three are quiet on purpose and none of them is legible to a low-vision Reader, so
// naming one of them was a switch that changed the map without doing what it said.
//
// What replaces it is a two-value palette: the earth is one extreme of the ramp and every line and
// letter on it is the other, and the only classes allowed off the extremes are the three that have
// to be told apart from *both* — water, building footprints, and the landcover a map with `streets`
// off is made of. Casings and halos are painted in the ground, so a road crossing water or a name
// crossing a road still reads as two things.
//
// The values below are the palette. Nothing derives them from the base flavor, deliberately: a
// contrast ratio computed off somebody else's mid-tone is a ratio nobody checked.

import type { Flavor } from '@protomaps/basemaps';
import type { ThemeScheme } from '../theme';

type ContrastRamp = {
	/** The earth, every road casing, and every label halo. */
	readonly ground: string;
	/** Every line and every letter: roads, rail, piers, runways, boundaries, labels. */
	readonly ink: string;
	/** Off the extremes, because it must differ from the ground *and* from a road crossing it. */
	readonly water: string;
	/** Off the extremes for the same reason, and lighter than water: footprints are areas. */
	readonly buildings: string;
	/**
	 * What a map with `streets` off is made of, and the reason this switch is not just two colours.
	 * Spaced as widely as seven steps up one ramp can be: adjacent classes cannot all be high
	 * contrast against each other *and* against the ground, and against the ground wins. `glacier`
	 * is white in both schemes rather than a step on either ramp, because ice is the one class whose
	 * colour is not up for negotiation; in light that merges it into the earth, and what defines it
	 * there is the dark rock around it.
	 */
	readonly landcover: NonNullable<Flavor['landcover']>;
};

const RAMPS: Readonly<Record<ThemeScheme, ContrastRamp>> = {
	light: {
		ground: '#ffffff',
		ink: '#000000',
		water: '#3d3d3d',
		buildings: '#808080',
		landcover: {
			forest: '#595959',
			scrub: '#8c8c8c',
			urban_area: '#a6a6a6',
			grassland: '#bfbfbf',
			farmland: '#d9d9d9',
			barren: '#e8e8e8',
			glacier: '#ffffff'
		}
	},
	dark: {
		ground: '#000000',
		ink: '#ffffff',
		water: '#c2c2c2',
		buildings: '#737373',
		landcover: {
			forest: '#a6a6a6',
			scrub: '#737373',
			urban_area: '#595959',
			grassland: '#4d4d4d',
			farmland: '#3d3d3d',
			barren: '#2b2b2b',
			glacier: '#ffffff'
		}
	}
};

/**
 * One theme's high-contrast repaint of `flavor`.
 *
 * Takes the base flavor rather than building a `Flavor` from nothing so that a field
 * `@protomaps/basemaps` adds in a later release arrives drawn in *something* rather than as a
 * missing colour, and so the fonts a flavor names travel through untouched.
 */
export function highContrastFlavor(flavor: Flavor, scheme: ThemeScheme): Flavor {
	const { ground, ink, water, buildings, landcover } = RAMPS[scheme];
	return {
		...flavor,

		background: ground,
		earth: ground,
		park_a: ground,
		park_b: ground,
		hospital: ground,
		industrial: ground,
		school: ground,
		wood_a: ground,
		wood_b: ground,
		pedestrian: ground,
		scrub_a: ground,
		scrub_b: ground,
		glacier: ground,
		sand: ground,
		beach: ground,
		aerodrome: ground,
		zoo: ground,
		military: ground,
		runway: ink,
		water,

		// Tunnels are drawn in the ink like the surface network. The flavors distinguish them by a
		// mid-tone, and a mid-tone is the one thing this palette does not have to spend on a
		// distinction a reader can already get from the tunnel's casing.
		tunnel_other_casing: ground,
		tunnel_minor_casing: ground,
		tunnel_link_casing: ground,
		tunnel_major_casing: ground,
		tunnel_highway_casing: ground,
		tunnel_other: ink,
		tunnel_minor: ink,
		tunnel_link: ink,
		tunnel_major: ink,
		tunnel_highway: ink,

		pier: ink,
		buildings,

		minor_service_casing: ground,
		minor_casing: ground,
		link_casing: ground,
		major_casing_late: ground,
		highway_casing_late: ground,
		major_casing_early: ground,
		highway_casing_early: ground,
		other: ink,
		minor_service: ink,
		minor_a: ink,
		minor_b: ink,
		link: ink,
		major: ink,
		highway: ink,

		railway: ink,
		boundaries: ink,

		bridges_other_casing: ground,
		bridges_minor_casing: ground,
		bridges_link_casing: ground,
		bridges_major_casing: ground,
		bridges_highway_casing: ground,
		bridges_other: ink,
		bridges_minor: ink,
		bridges_link: ink,
		bridges_major: ink,
		bridges_highway: ink,

		roads_label_minor: ink,
		roads_label_minor_halo: ground,
		roads_label_major: ink,
		roads_label_major_halo: ground,
		// The one label that is not on the earth: it sits on `water`, so it is haloed by nothing and
		// has to be the colour the ground is not.
		ocean_label: ground,
		subplace_label: ink,
		subplace_label_halo: ground,
		city_label: ink,
		city_label_halo: ground,
		state_label: ink,
		state_label_halo: ground,
		country_label: ink,
		address_label: ink,
		address_label_halo: ground,

		landcover
	};
}
