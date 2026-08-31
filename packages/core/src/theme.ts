// The application theme.
//
// ADR-0016 requires that ONE theme signal drives both the UI and the Base Map flavor, because
// a dark interface framing a bright white map is the most obvious way a themed app looks
// unfinished. Each selectable daisyUI theme therefore declares the light/dark scheme used by the
// Base Map, and both apps and `baseMapStyle` read this one catalog.

export type ThemeScheme = 'light' | 'dark';

export const THEMES = [
	{ name: 'carto-light', label: 'Carto Light', scheme: 'light' },
	{ name: 'carto-dark', label: 'Carto Dark', scheme: 'dark' },
	{ name: 'light', label: 'Light', scheme: 'light' },
	{ name: 'dark', label: 'Dark', scheme: 'dark' },
	{ name: 'cupcake', label: 'Cupcake', scheme: 'light' },
	{ name: 'bumblebee', label: 'Bumblebee', scheme: 'light' },
	{ name: 'emerald', label: 'Emerald', scheme: 'light' },
	{ name: 'corporate', label: 'Corporate', scheme: 'light' },
	{ name: 'synthwave', label: 'Synthwave', scheme: 'dark' },
	{ name: 'retro', label: 'Retro', scheme: 'light' },
	{ name: 'cyberpunk', label: 'Cyberpunk', scheme: 'light' },
	{ name: 'valentine', label: 'Valentine', scheme: 'light' },
	{ name: 'halloween', label: 'Halloween', scheme: 'dark' },
	{ name: 'garden', label: 'Garden', scheme: 'light' },
	{ name: 'forest', label: 'Forest', scheme: 'dark' },
	{ name: 'aqua', label: 'Aqua', scheme: 'dark' },
	{ name: 'lofi', label: 'Lofi', scheme: 'light' },
	{ name: 'pastel', label: 'Pastel', scheme: 'light' },
	{ name: 'fantasy', label: 'Fantasy', scheme: 'light' },
	{ name: 'wireframe', label: 'Wireframe', scheme: 'light' },
	{ name: 'black', label: 'Black', scheme: 'dark' },
	{ name: 'luxury', label: 'Luxury', scheme: 'dark' },
	{ name: 'dracula', label: 'Dracula', scheme: 'dark' },
	{ name: 'cmyk', label: 'CMYK', scheme: 'light' },
	{ name: 'autumn', label: 'Autumn', scheme: 'light' },
	{ name: 'business', label: 'Business', scheme: 'dark' },
	{ name: 'acid', label: 'Acid', scheme: 'light' },
	{ name: 'lemonade', label: 'Lemonade', scheme: 'light' },
	{ name: 'night', label: 'Night', scheme: 'dark' },
	{ name: 'coffee', label: 'Coffee', scheme: 'dark' },
	{ name: 'winter', label: 'Winter', scheme: 'light' },
	{ name: 'dim', label: 'Dim', scheme: 'dark' },
	{ name: 'nord', label: 'Nord', scheme: 'light' },
	{ name: 'sunset', label: 'Sunset', scheme: 'dark' },
	{ name: 'caramellatte', label: 'Caramellatte', scheme: 'light' },
	{ name: 'abyss', label: 'Abyss', scheme: 'dark' },
	{ name: 'silk', label: 'Silk', scheme: 'light' }
] as const;

export type Theme = (typeof THEMES)[number]['name'];

export const DEFAULT_THEME: Theme = 'carto-light';
export const DEFAULT_DARK_THEME: Theme = 'carto-dark';

export const isTheme = (candidate: string): candidate is Theme =>
	THEMES.some(({ name }) => name === candidate);

export const themeScheme = (theme: Theme): ThemeScheme =>
	THEMES.find(({ name }) => name === theme)?.scheme ?? 'light';
