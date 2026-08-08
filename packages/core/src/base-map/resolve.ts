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

/**
 * What to say when the Base Map's archive answered nothing, while the browser is online.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT THE OFFLINE NOTICE, AND WHY IT IS NOT SILENCE
 *
 * On 2026-08-07 `demo-bucket.protomaps.com` began refusing the archive every entry in this
 * deployment's catalog reads (ADR-0025, which predicted exactly this: "no published rate limit, no
 * uptime promise, and no terms of use"). The application's whole response was a pane with nothing
 * in it. A scholar cannot tell that from a broken tool, and there is a third possibility they also
 * cannot rule out — that their own work failed to draw.
 *
 * So the message has to carry three things, in this order, because they are the order the questions
 * arrive in: **it is not you**, **your work is safe**, and **here is what would fix it**. The offline
 * notice cannot stand in for it: the connection is fine, and telling somebody with working wifi that
 * they have none is a worse answer than saying nothing.
 *
 * `needsNetwork` decides the remedy. An entry reading a deployment-relative archive that does not
 * answer is a broken deployment and the reader can do nothing about it; a remote one may be a host
 * having a bad day, and making the Project available offline is a real action a scholar can take
 * now. Visible text, never a tooltip (SPEC story 111, ADR-0016).
 *
 * @param host the archive's host, or `null` when the archive is served from this deployment
 */
export function baseMapUnavailableNotice(entry: BaseMapEntry, host: string | null): string {
	const where = host === null ? 'this site' : host;
	return (
		`The Base Map “${entry.label}” could not be loaded from ${where}. ` +
		'Nothing in your Workspace is affected — your Historical Maps, their Alignments and your ' +
		'Annotations are all still here and still saving, and they will draw over the geography ' +
		'again as soon as a Base Map does. ' +
		(entry.needsNetwork
			? 'This Base Map is fetched from another server, so this is usually that server rather ' +
				'than your connection. Try another Base Map, or make this Project available offline ' +
				'while one is working so it keeps drawing when none is.'
			: 'This Base Map is served by this site, so the site is missing the file it needs. ' +
				'Whoever published it has to restore it.')
	);
}

/**
 * The host an entry's archive is fetched from, or `null` when it is this deployment's own file.
 *
 * Split out so the notice above takes a host rather than a URL: naming a whole archive URL at a
 * scholar is naming a path they cannot act on, and the host is the part that identifies who is
 * having the bad afternoon.
 */
export function baseMapArchiveHost(entry: BaseMapEntry): string | null {
	try {
		return new URL(entry.archive).host;
	} catch {
		return null;
	}
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
