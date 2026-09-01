// What the Base Map *looks like*, as three independent choices, and the one reader of
// `project.json`'s field for them.
//
// **This is a composition, not a menu, because the tiles are one archive.** Every appearance below
// is a style document over the same vector source (ADR-0005): the built environment is a set of
// layers to keep or drop, the relief is a second dataset to draw or not, and the palette is a
// Protomaps flavor to name. Nothing here costs a request the map was not already making, except
// `relief`, which reads the catalog's elevation dataset and says so.
//
// The catalog used to carry these as named variants — a "Streets" entry, a "Physical geography"
// entry, a "Topographic" entry, a "Muted" entry — which meant a scholar who wanted contour lines
// *and* roads could not have them, and a low-vision Reader who wanted muted colours lost the relief
// to get them. Four entries covered four of the eight combinations, and the ones they left out were
// not the unlikely ones. Three orthogonal fields cover all eight and are shorter.
//
// **It is Project data, not a catalog entry and not a deployment's business**, for the reason
// `borders.ts` gives about boundaries: how the modern earth is drawn under a fourteenth-century
// itinerary is the author's argument, and it has to travel with the work to the Published Site. A
// Reader may override it for themselves — see `reader-preference.ts` — and that override is
// emphatically not written back.

import type { BaseMapFlavorName } from './entry.js';
import type { ThemeScheme } from '../theme.js';

/**
 * How the Base Map is drawn, as three switches that do not constrain each other.
 *
 * Every combination is meaningful, including the ones no named variant ever offered: contour lines
 * under a road network, a muted palette with the relief still shaded, bare landcover with neither.
 */
export type BaseMapAppearance = {
	/**
	 * Draw the built environment: roads, buildings, address labels, and points of interest.
	 *
	 * Off, the same tiles read as physical geography — the built layers are dropped and the
	 * flavor's saturated `landcover` colours take over the woodland, scrub, sand, beach, glacier and
	 * park, which is what Protomaps paints at the zooms where the natural world is the subject.
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
	 * Use the unsaturated, high-contrast palette instead of the ordinary one.
	 *
	 * A low-vision Reader must be able to mute the Base Map so that Annotations stay legible over
	 * it; `e2e/viewer-reader.e2e.ts` asserts that choice in the published viewer. It is one flavor
	 * name instead of another and costs nothing.
	 */
	readonly muted: boolean;
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
	muted: false
});

/** The key `project.json` records the author's appearance under. */
export const PROJECT_BASE_MAP_APPEARANCE_KEY = 'baseMapAppearance';

/** True when the author has changed nothing, and the field is therefore not written at all. */
export function isDefaultAppearance(appearance: BaseMapAppearance): boolean {
	return (
		appearance.streets === DEFAULT_BASE_MAP_APPEARANCE.streets &&
		appearance.relief === DEFAULT_BASE_MAP_APPEARANCE.relief &&
		appearance.muted === DEFAULT_BASE_MAP_APPEARANCE.muted
	);
}

/**
 * The author's appearance from a parsed `project.json`.
 *
 * Tolerant per-property in the way `readBaseMapBorderStyle` is: a document whose `relief` is a
 * string still yields the `streets` beside it, and every unusable value means the default rather
 * than an error. Nothing here throws — this comes off somebody's disk, where an older fork, a hand
 * edit, or a half-finished migration may have left it in any shape.
 */
export function readBaseMapAppearance(document: unknown): BaseMapAppearance {
	if (typeof document !== 'object' || document === null) return DEFAULT_BASE_MAP_APPEARANCE;
	const raw = (document as Record<string, unknown>)[PROJECT_BASE_MAP_APPEARANCE_KEY];
	return appearanceFrom(raw) ?? DEFAULT_BASE_MAP_APPEARANCE;
}

/**
 * An appearance out of an arbitrary value, or `null` when it carries nothing usable at all.
 *
 * The `null` is what separates "this Reader has chosen nothing" from "this Reader has switched
 * everything off", which are different states and are stored in the same string bag —
 * see `reader-preference.ts`. A record with one recognisable boolean in it is a choice; a record
 * with none, a string, or `undefined` is not.
 */
export function appearanceFrom(value: unknown): BaseMapAppearance | null {
	if (typeof value !== 'object' || value === null) return null;
	const fields = value as Record<string, unknown>;
	const chosen = (['streets', 'relief', 'muted'] as const).filter(
		(key) => typeof fields[key] === 'boolean'
	);
	if (chosen.length === 0) return null;
	return {
		streets:
			typeof fields.streets === 'boolean' ? fields.streets : DEFAULT_BASE_MAP_APPEARANCE.streets,
		relief: typeof fields.relief === 'boolean' ? fields.relief : DEFAULT_BASE_MAP_APPEARANCE.relief,
		muted: typeof fields.muted === 'boolean' ? fields.muted : DEFAULT_BASE_MAP_APPEARANCE.muted
	};
}

/**
 * The Protomaps flavor one appearance asks for in one theme.
 *
 * Both arguments, and neither optional, for the reason `baseMapStyle` takes a theme: a dark UI
 * framing a bright white map is the failure ADR-0016 is written to prevent. `grayscale` and `black`
 * are the two flavors that carry no `landcover` struct, which is why a muted map with `streets` off
 * is distinguished by its layer selection alone — a muted palette asked for muted.
 */
export function baseMapFlavorName(
	appearance: BaseMapAppearance,
	scheme: ThemeScheme
): BaseMapFlavorName {
	if (appearance.muted) return scheme === 'dark' ? 'black' : 'grayscale';
	return scheme === 'dark' ? 'dark' : 'light';
}
