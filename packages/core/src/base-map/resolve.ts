import { BASE_MAP_CATALOG } from './catalog';
import type { BaseMapCatalog, BaseMapEntry } from './entry';
import { isAbsoluteUrl } from './style';

type BaseMapResolution = {
	readonly entry: BaseMapEntry;
	readonly requestedId: string | null;
	readonly fellBack: boolean;
};

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

export function defaultEntry(catalog: BaseMapCatalog = BASE_MAP_CATALOG): BaseMapEntry {
	const first = catalog.entries[0];
	if (first === undefined) {
		throw new Error('The Base Map catalog is empty; this deployment can show no Base Map.');
	}
	return catalog.entries.find((entry) => entry.id === catalog.defaultId) ?? first;
}

export function baseMapFallbackNotice(resolution: BaseMapResolution): string | null {
	if (!resolution.fellBack) return null;
	return (
		`This Project asks for a Base Map called “${resolution.requestedId}”, which is not ` +
		`available here. Showing “${resolution.entry.label}” instead.`
	);
}

export function baseMapUnavailableNotice(entry: BaseMapEntry, host: string | null): string {
	const where = host === null ? 'this site' : host;
	return (
		`The Base Map “${entry.label}” could not be loaded from ${where}. ` +
		'Nothing in your Workspace is affected — your Map Images, their Alignments and your ' +
		'Annotations are all still here and still saving, and they will draw over the geography ' +
		'again as soon as a Base Map does. ' +
		(entry.needsNetwork
			? 'This Base Map is fetched from another server, so this is usually that server rather ' +
				'than your connection. Try another Base Map, or make this Project available offline ' +
				'while one is working so it keeps drawing when none is.'
			: 'This Base Map is served by this site, so the site is missing the file it needs. ' +
				'Whoever made it has to restore it.')
	);
}

export function baseMapArchiveHost(entry: BaseMapEntry): string | null {
	try {
		return new URL(entry.archive).host;
	} catch {
		return null;
	}
}

type BaseMapOption = {
	readonly id: string;
	readonly label: string;
	readonly needsNetwork: boolean;
};

export function baseMapOptions(
	catalog: BaseMapCatalog = BASE_MAP_CATALOG
): readonly BaseMapOption[] {
	return catalog.entries.map((entry) => ({
		id: entry.id,
		label: entry.label,
		needsNetwork: entry.needsNetwork
	}));
}

export function baseMapNotInSiteNotice(
	entry: BaseMapEntry,
	site: { readonly bundledAssets: boolean; readonly cachedTiles: boolean }
): string {
	if (site.bundledAssets) return '';
	if (!site.cachedTiles && !isAbsoluteUrl(entry.archive)) {
		return (
			'This site carries no copy of its own of the modern reference map, so only the ' +
			'Map Images and the Pins, Lines and Shapes are drawn. The author’s Labels are not: they ' +
			'are shaped from typefaces this site does not carry. The Base Maps marked “needs ' +
			'network” still work.'
		);
	}
	return (
		'This site does not carry the Base Map’s labels and symbols, so the modern reference ' +
		'map here carries no place names at all, and the author’s Labels are not drawn. The Map ' +
		'Images and the other Annotations — Pins, Lines and Shapes — are not affected.'
	);
}
