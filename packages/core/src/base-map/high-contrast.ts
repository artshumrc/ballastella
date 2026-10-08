import type { Flavor } from '@protomaps/basemaps';
import type { ThemeScheme } from '../theme';

type ContrastRamp = {
	readonly ground: string;
	readonly ink: string;
	readonly water: string;
	readonly buildings: string;
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
		// Drawn on water, unhaloed.
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
