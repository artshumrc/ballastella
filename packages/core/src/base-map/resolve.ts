import { BASE_MAP_CATALOG } from './catalog';
import type { BaseMapCatalog, BaseMapEntry } from './entry';

export type BaseMapResolution = {
	readonly entry: BaseMapEntry;
	/** What was asked for. `null` when the Project records no default at all. */
	readonly requestedId: string | null;
	/** True when `requestedId` named something this deployment cannot serve. */
	readonly fellBack: boolean;
};

/**
 * Resolve the id a Project recorded against this deployment's catalog.
 *
 * `project.json` records intent — a stable id — never an address (ADR-0004, ADR-0020). The
 * consequence is that resolution can fail, and it must fail *visibly*: an unresolvable Base
 * Map otherwise renders a plausible-looking but **wrong** map rather than an obvious error.
 * So this never throws and never returns nothing; it falls back to the deployment default and
 * records that it did, and `baseMapFallbackNotice` turns that into something the author reads.
 *
 * A Project that records no default is not an error and produces no notice — it simply has not
 * chosen yet.
 */
export function resolveBaseMap(
	requestedId: string | null | undefined,
	catalog: BaseMapCatalog = BASE_MAP_CATALOG
): BaseMapResolution {
	const fallback = defaultEntry(catalog);
	const asked = requestedId ?? null;
	if (asked === null) return { entry: fallback, requestedId: null, fellBack: false };

	const found = catalog.entries.find((entry) => entry.id === asked);
	if (found) return { entry: found, requestedId: asked, fellBack: false };
	return { entry: fallback, requestedId: asked, fellBack: true };
}

/**
 * The deployment default, or the first entry when `defaultId` names nothing — a catalog whose
 * `defaultId` is stale is a deployment mistake, and silently rendering the first entry is a
 * better outcome for the author than a blank pane.
 *
 * A catalog with no entries at all cannot be rendered by any means, so that one throws.
 */
export function defaultEntry(catalog: BaseMapCatalog = BASE_MAP_CATALOG): BaseMapEntry {
	const first = catalog.entries[0];
	if (first === undefined) {
		throw new Error('The Base Map catalog is empty; this deployment can show no Base Map.');
	}
	return catalog.entries.find((entry) => entry.id === catalog.defaultId) ?? first;
}

/**
 * The quiet notice for a Base Map that did not resolve, or `null` when there is nothing to say.
 *
 * Quiet, and phrased for an author rather than a developer: the Project is fine, this
 * deployment simply does not carry what it asked for, and moving it somewhere that does will
 * bring the choice back (ADR-0020).
 */
export function baseMapFallbackNotice(resolution: BaseMapResolution): string | null {
	if (!resolution.fellBack) return null;
	return (
		`This Project asks for a Base Map called “${resolution.requestedId}”, which is not ` +
		`available here. Showing “${resolution.entry.label}” instead.`
	);
}

export type BaseMapOption = {
	readonly id: string;
	readonly label: string;
	readonly needsNetwork: boolean;
	/** The label as shown in the switcher, carrying the needs-network marking. */
	readonly text: string;
};

/**
 * The switcher's options, in catalog order.
 *
 * The needs-network marking is **visible text**, not a tooltip and not colour alone: ADR-0016
 * rules out tooltips as an information channel because daisyUI renders them via CSS `::before`
 * and screen readers never announce them, and ADR-0020 requires the distinction be legible or
 * a Reader offline picks satellite imagery and gets a blank map with no explanation.
 */
export function baseMapOptions(
	catalog: BaseMapCatalog = BASE_MAP_CATALOG
): readonly BaseMapOption[] {
	return catalog.entries.map((entry) => ({
		id: entry.id,
		label: entry.label,
		needsNetwork: entry.needsNetwork,
		text: entry.needsNetwork ? `${entry.label} — needs network` : entry.label
	}));
}
