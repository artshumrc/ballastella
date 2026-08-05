import type { LayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { layers, namedFlavor, type Flavor } from '@protomaps/basemaps';

import { BASE_MAP_CATALOG } from './catalog';
import type { BaseMapCatalog, BaseMapEmphasis, BaseMapEntry } from './entry';
import type { Theme } from '../theme';

/** The single vector source every variant reads. One archive; many style documents. */
export const BASE_MAP_SOURCE_ID = 'protomaps';

/**
 * Label language. Protomaps gates every label layer behind this option — without it `layers()`
 * returns terrain and roads and no text at all — so it is what makes a "streets and labels"
 * variant possible.
 */
const LABEL_LANGUAGE = 'en';

/**
 * Layer id prefixes a water-and-terrain variant drops. Built environment only: the point is that
 * the same tiles can say something different, not that some tiles are missing.
 */
const BUILT_ENVIRONMENT_PREFIXES = ['roads_', 'buildings', 'address_label', 'pois'] as const;

export type BaseMapStyleOptions = {
	readonly theme: Theme;
	readonly catalog?: BaseMapCatalog;
	/**
	 * Turns a deployment-relative asset path into a URL, and is the seam ADR-0006 needs: the
	 * publish target — a domain root or a project subdirectory — is unknown at build time, so
	 * nothing here may be an absolute path. Identity by default, which is what the tests want.
	 *
	 * It receives the glyph and sprite templates with their `{fontstack}`, `{range}`, and
	 * `{flavor}` placeholders intact, so an implementation must not percent-encode them.
	 */
	readonly resolveAsset?: (path: string) => string;
};

const identity = (path: string): string => path;

/** True for `https://…`, `file://…`, and anything else already addressed absolutely. */
export const isAbsoluteUrl = (candidate: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(candidate);

/**
 * Build the MapLibre style document for one catalog entry at one theme.
 *
 * Both arguments matter and neither is optional: the *entry* decides what the map is about, and
 * the *theme* decides how it looks. They arrive together because a dark UI framing a bright
 * white map is the failure ADR-0016 is written to prevent, and the way that failure happens is
 * a style built once at startup and a theme toggled afterwards.
 */
export function baseMapStyle(
	entry: BaseMapEntry,
	options: BaseMapStyleOptions
): StyleSpecification {
	const catalog = options.catalog ?? BASE_MAP_CATALOG;
	const resolveAsset = options.resolveAsset ?? identity;
	const flavorName = entry.flavor[options.theme];
	const flavor = emphasisedFlavor(namedFlavor(flavorName), entry.emphasis);

	return {
		version: 8,
		glyphs: resolveAsset(catalog.glyphs),
		sprite: resolveAsset(catalog.sprite).replace('{flavor}', flavorName),
		sources: {
			[BASE_MAP_SOURCE_ID]: {
				type: 'vector',
				// The pmtiles protocol reads a single archive over HTTP Range requests, so this URL
				// is a static file and there is no tile server anywhere in the picture (ADR-0005).
				url: `pmtiles://${archiveUrl(entry, resolveAsset)}`,
				attribution: catalog.attribution
			}
		},
		layers: emphasisedLayers(
			layers(BASE_MAP_SOURCE_ID, flavor, { lang: LABEL_LANGUAGE }),
			entry.emphasis
		)
	};
}

/** The entry's archive as a URL. Remote archives are already addressed; bundled ones are not. */
export function archiveUrl(
	entry: BaseMapEntry,
	resolveAsset: (path: string) => string = identity
): string {
	return isAbsoluteUrl(entry.archive) ? entry.archive : resolveAsset(entry.archive);
}

function emphasisedLayers(
	all: LayerSpecification[],
	emphasis: BaseMapEmphasis
): LayerSpecification[] {
	if (emphasis === 'streets-and-labels') return all;
	return all.filter(
		(layer) => !BUILT_ENVIRONMENT_PREFIXES.some((prefix) => layer.id.startsWith(prefix))
	);
}

/**
 * A water-and-terrain variant repaints woodland, scrub, sand, beach, glacier, and park in the
 * flavor's own `landcover` colours, which are the saturated ones Protomaps uses at low zoom where
 * the natural world is the subject. Deriving them from the flavor rather than picking a palette
 * here is what keeps light and dark coherent, and keeps this from becoming a third theme.
 *
 * `grayscale`, `white`, and `black` carry no `landcover` struct — they are deliberately
 * unsaturated — so such a variant over one of those is distinguished by its layer selection
 * alone. That is a reasonable outcome rather than a gap: a muted flavor asked for muted.
 */
function emphasisedFlavor(flavor: Flavor, emphasis: BaseMapEmphasis): Flavor {
	const landcover = flavor.landcover;
	if (emphasis === 'streets-and-labels' || landcover === undefined) return flavor;

	// `water` is deliberately not touched: it is already the flavor's most saturated colour, and
	// the physical variant's job is to bring the *land* up to it rather than to invent a palette.
	return {
		...flavor,
		wood_a: landcover.forest,
		wood_b: landcover.forest,
		scrub_a: landcover.scrub,
		scrub_b: landcover.scrub,
		glacier: landcover.glacier,
		sand: landcover.barren,
		beach: landcover.barren,
		park_a: landcover.grassland,
		park_b: landcover.grassland
	};
}
