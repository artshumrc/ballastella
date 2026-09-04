// What the Base Map *looks like*, as four independent choices, and the one reader of
// `project.json`'s field for them.
//
// **This is a composition, not a menu, because the tiles are one archive.** Every appearance below
// is a style document over the same vector source (ADR-0005): the built environment is a set of
// layers to keep or drop, the relief is a second dataset to draw or not, and the palette is a set of
// colours to draw them in. Nothing here costs a request the map was not already making, except
// `relief`, which reads the catalog's elevation dataset and says so.
//
// The catalog used to carry these as named variants — a "Streets" entry, a "Physical geography"
// entry, a "Topographic" entry, a "Muted" entry — which meant a scholar who wanted contour lines
// *and* roads could not have them, and a low-vision Reader who wanted a legible palette lost the
// relief to get it. Four entries covered four of the eight combinations, and the ones they left out
// were not the unlikely ones. Three orthogonal fields cover all eight and are shorter.
//
// **It is Project data, not a catalog entry and not a deployment's business**, for the reason
// `borders.ts` gives about boundaries: how the modern earth is drawn under a fourteenth-century
// itinerary is the author's argument, and it has to travel with the work to the Published Site. A
// Reader may override it for themselves — see `reader-preference.ts` — and that override is
// emphatically not written back.

import type { BaseMapFlavorName } from './entry.js';
import type { ThemeScheme } from '../theme.js';

/**
 * How the Base Map is drawn, as four switches that do not constrain each other.
 *
 * Every combination is meaningful, including the ones no named variant ever offered: contour lines
 * under a road network, a high-contrast palette with the relief still shaded, bare landcover with
 * neither.
 */
export type BaseMapAppearance = {
	/**
	 * Draw the built environment: roads, buildings, address labels, and points of interest.
	 *
	 * Off, the same tiles read as physical geography: the built layers are dropped — including the
	 * campus, industrial and plaza polygons that would otherwise punch grey holes through the green —
	 * and the woodland, scrub, sand, beach, glacier and park are repainted from `physical.ts`.
	 */
	readonly streets: boolean;
	/**
	 * Draw shaded relief and contour lines.
	 *
	 * **The one switch that reads a second dataset.** The vector archive is OpenStreetMap and
	 * OpenStreetMap carries no elevation, so this needs the catalog's
	 * {@link BaseMapCatalog.terrain}. Without one — a fork that has not provisioned a DEM, or a
	 * Project being read from its offline tile cache — the map draws without relief rather than
	 * failing, because no edit to a catalog may produce a blank pane.
	 */
	readonly relief: boolean;
	/**
	 * Draw the map in the two-value high-contrast palette instead of the ordinary one.
	 *
	 * A low-vision Reader must be able to make the Base Map legible without leaving the work;
	 * `e2e/viewer-reader.e2e.ts` asserts that choice in the published viewer. It is a repaint of the
	 * flavor — see `high-contrast.ts` — and costs no request.
	 */
	readonly highContrast: boolean;
	/**
	 * Draw satellite imagery instead of the vector ground.
	 *
	 * **The second switch that reads a dataset the archive does not carry**, and the first that
	 * replaces part of the map rather than filtering or repainting it: the imagery stands in for the
	 * background, the earth, the landcover, the landuse and the water fills, which are the layers
	 * that draw what a photograph already shows. Everything above them — roads, labels, boundaries,
	 * and the relief if it is on — is drawn over it unchanged, which is what makes this "map versus
	 * satellite" rather than a different map.
	 *
	 * Like `relief`, it needs the catalog to have provisioned it ({@link BaseMapCatalog.imagery}) and
	 * degrades to the vector ground without one, because no edit to a catalog may produce a blank
	 * pane. It is also dropped for a Project read from its offline tile cache, for ADR-0025's reason:
	 * imagery is a live request to a second host, and a map called available offline that needs the
	 * network is a false claim at the moment somebody relies on it.
	 */
	readonly imagery: boolean;
};

/**
 * What a Project that has said nothing draws: the road network in the ordinary palette, no relief.
 *
 * This is what the deployment default used to draw, so a Project written before this field existed
 * opens looking exactly as it did — and `serialiseProjectFile` omits the field at this value, so it
 * also keeps its exact bytes (ADR-0010).
 */
export const DEFAULT_BASE_MAP_APPEARANCE: BaseMapAppearance = Object.freeze({
	streets: true,
	relief: false,
	highContrast: false,
	imagery: false
});

/** The key `project.json` records the author's appearance under. */
export const PROJECT_BASE_MAP_APPEARANCE_KEY = 'baseMapAppearance';

/** True when the author has changed nothing, and the field is therefore not written at all. */
export function isDefaultAppearance(appearance: BaseMapAppearance): boolean {
	return (
		appearance.streets === DEFAULT_BASE_MAP_APPEARANCE.streets &&
		appearance.relief === DEFAULT_BASE_MAP_APPEARANCE.relief &&
		appearance.highContrast === DEFAULT_BASE_MAP_APPEARANCE.highContrast &&
		appearance.imagery === DEFAULT_BASE_MAP_APPEARANCE.imagery
	);
}

/**
 * An appearance out of an arbitrary value, or `null` when it carries nothing usable at all.
 *
 * Tolerant per-property in the way `readBaseMapBorderStyle` is: a record whose `relief` is a string
 * still yields the `streets` beside it. Nothing here throws — this comes off somebody's disk, where
 * an older fork, a hand edit, or a half-finished migration may have left it in any shape.
 *
 * The `null` is what separates "this Reader has chosen nothing" from "this Reader has switched
 * everything off", which are different states and are stored in the same string bag —
 * see `reader-preference.ts`. A record with one recognisable boolean in it is a choice; a record
 * with none, a string, or `undefined` is not.
 *
 * `muted` is read as `highContrast` because it is the same switch under the name it shipped under,
 * and the records carrying it are a Reader's `localStorage` and a saved `project.json` — neither of
 * which this code gets to migrate before it is asked to draw. `highContrast` wins where a document
 * somehow carries both.
 */
export function appearanceFrom(value: unknown): BaseMapAppearance | null {
	if (typeof value !== 'object' || value === null) return null;
	const fields = value as Record<string, unknown>;
	const contrast = typeof fields.highContrast === 'boolean' ? fields.highContrast : fields.muted;
	const chosen = [fields.streets, fields.relief, contrast, fields.imagery].filter(
		(field) => typeof field === 'boolean'
	);
	if (chosen.length === 0) return null;
	return {
		streets:
			typeof fields.streets === 'boolean' ? fields.streets : DEFAULT_BASE_MAP_APPEARANCE.streets,
		relief: typeof fields.relief === 'boolean' ? fields.relief : DEFAULT_BASE_MAP_APPEARANCE.relief,
		highContrast:
			typeof contrast === 'boolean' ? contrast : DEFAULT_BASE_MAP_APPEARANCE.highContrast,
		imagery:
			typeof fields.imagery === 'boolean' ? fields.imagery : DEFAULT_BASE_MAP_APPEARANCE.imagery
	};
}

/**
 * One appearance as it is actually drawn: the author's switches with the one exclusion between them
 * applied.
 *
 * **`highContrast` does nothing over `imagery`, so it is recorded as off rather than left saying
 * something the map does not show.** The high-contrast palette is a repaint of the flavor's land,
 * water and buildings (`high-contrast.ts`), and a satellite map draws none of them — the ground is a
 * photograph and no palette reaches it. Left live, the switch would be a control a low-vision Reader
 * turns on and watches do nothing, which is worse than one that is plainly unavailable.
 *
 * The exclusion lives here rather than in the control, so that a `project.json` carrying both — hand
 * edited, or written by a build before this rule — draws the same map the control would produce, and
 * so that both apps and the editor's border pickers agree about which flavor is on screen.
 *
 * It is deliberately **not** applied to `relief`: shaded relief and contour lines over imagery draw
 * something real, and whether it is wanted is the author's judgement rather than this module's.
 */
export function drawnAppearance(appearance: BaseMapAppearance): BaseMapAppearance {
	return appearance.imagery && appearance.highContrast
		? { ...appearance, highContrast: false }
		: appearance;
}

/**
 * The Protomaps flavor one appearance asks for in one theme.
 *
 * Both arguments, and neither optional, for the reason `baseMapStyle` takes a theme: a dark UI
 * framing a bright white map is the failure ADR-0016 is written to prevent.
 *
 * High contrast names `white` and `black` — the two flavors whose earth is already the extreme its
 * palette wants — but the *name* is not the palette: `highContrastFlavor` repaints whichever of them
 * this returns. The name still matters on its own, because the sprite sheet is chosen by it and
 * there are only these five.
 */
export function baseMapFlavorName(
	appearance: BaseMapAppearance,
	scheme: ThemeScheme
): BaseMapFlavorName {
	if (appearance.highContrast) return scheme === 'dark' ? 'black' : 'white';
	return scheme === 'dark' ? 'dark' : 'light';
}
