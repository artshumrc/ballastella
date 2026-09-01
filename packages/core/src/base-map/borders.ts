// Which administrative boundaries the Base Map draws, and the one reader of `project.json`'s field
// for it.
//
// **No extra data, and that is the whole reason this is a filter rather than a source.** The
// Protomaps schema already carries a `boundaries` source-layer in the same archive every entry
// reads, split by `kind_detail` into the national line and everything inside it. So showing or
// hiding borders costs no request, no dependency, and no GeoJSON of anyone's — it is a choice about
// which of the layers `@protomaps/basemaps` already built get into the style document.
//
// **It is Project data, not a catalog entry and not a Reader preference.** Whether a modern national
// border belongs over a fourteenth-century itinerary is the author's argument, not a matter of
// taste, and it has to travel with the work to the Published Site. That is the opposite of
// `reader-preference.ts`, which is emphatic that a Reader's Base Map choice is never Project data:
// the two fields sit next to each other in `project.json` and mean deliberately different things.

/**
 * How much of the boundary layer set a Project draws.
 *
 * - `all` — national borders and the divisions inside them: states, provinces, regions.
 * - `national` — the national line alone.
 * - `none` — no administrative boundaries at all. Coastlines and rivers are geography, not
 *   boundaries, and are untouched by every value here.
 */
export type BaseMapBorders = 'none' | 'national' | 'all';

/** In catalog order for a switcher: least to most. */
export const BASE_MAP_BORDERS: readonly BaseMapBorders[] = ['none', 'national', 'all'];

/**
 * What a Project that says nothing draws.
 *
 * `all` because that is what every Project drew before this field existed, and a build that started
 * hiding borders on upgrade would silently change what published maps assert. It is also why
 * `serialiseProjectFile` omits the field at this value: an unchanged Project's bytes stay what they
 * were (ADR-0010).
 */
export const DEFAULT_BASE_MAP_BORDERS: BaseMapBorders = 'all';

/** The key `project.json` records the author's boundary choice under. */
export const PROJECT_BORDERS_KEY = 'borders';

/**
 * The layer `@protomaps/basemaps` builds for the national line, filtered to `kind_detail <= 2`.
 *
 * Named rather than derived, and **asserted by `style.test.ts` against the layers the installed
 * package actually emits** — a Protomaps upgrade that renamed it would otherwise leave every value
 * here drawing the same map, which is the quiet failure a border control cannot afford.
 */
export const NATIONAL_BOUNDARY_LAYER = 'boundaries_country';

/** The layer for divisions inside a nation, filtered to `kind_detail > 2`. */
export const SUBNATIONAL_BOUNDARY_LAYER = 'boundaries';

/** Whether a built style layer survives this boundary choice. Non-boundary layers always do. */
export function bordersInclude(borders: BaseMapBorders, layerId: string): boolean {
	if (layerId === NATIONAL_BOUNDARY_LAYER) return borders !== 'none';
	if (layerId === SUBNATIONAL_BOUNDARY_LAYER) return borders === 'all';
	return true;
}

/** True for a value this build can draw. */
export function isBaseMapBorders(value: unknown): value is BaseMapBorders {
	return BASE_MAP_BORDERS.includes(value as BaseMapBorders);
}

/**
 * The author's boundary choice from a parsed `project.json`.
 *
 * Tolerant for the reason `readBaseMapId` is: the document comes off somebody's disk and an older
 * fork, a hand edit, or a newer build may have left the field in any shape. Every unusable shape
 * means "no choice recorded", which is {@link DEFAULT_BASE_MAP_BORDERS}. Nothing here throws.
 */
export function readBaseMapBorders(document: unknown): BaseMapBorders {
	if (typeof document !== 'object' || document === null) return DEFAULT_BASE_MAP_BORDERS;
	const value = (document as Record<string, unknown>)[PROJECT_BORDERS_KEY];
	if (typeof value !== 'string') return DEFAULT_BASE_MAP_BORDERS;
	const trimmed = value.trim();
	return isBaseMapBorders(trimmed) ? trimmed : DEFAULT_BASE_MAP_BORDERS;
}
