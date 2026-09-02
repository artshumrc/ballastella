import type { LayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { layers, namedFlavor, type Flavor } from '@protomaps/basemaps';

import {
	borderColorIsLegible,
	bordersInclude,
	DEFAULT_BASE_MAP_BORDER_STYLE,
	DEFAULT_BASE_MAP_BORDERS,
	NATIONAL_BOUNDARY_LAYER,
	strengthenedBorder,
	type BaseMapBorders,
	type BaseMapBorderStyle
} from './borders';
import {
	baseMapFlavorName,
	DEFAULT_BASE_MAP_APPEARANCE,
	type BaseMapAppearance
} from './appearance';
import { BASE_MAP_CATALOG } from './catalog';
import type { BaseMapCatalog, BaseMapEntry, BaseMapTerrain } from './entry';
import {
	contourLayers,
	hillshadeLayer,
	terrainSources,
	type TerrainTileTemplates
} from './terrain';
import { themeScheme, type Theme } from '../theme';

/** The single vector source every variant reads. One archive; many style documents. */
export const BASE_MAP_SOURCE_ID = 'protomaps';

/**
 * Label language. Protomaps gates every label layer behind this option — without it `layers()`
 * returns terrain and roads and no text at all — so it is what makes a "streets and labels"
 * variant possible.
 */
const LABEL_LANGUAGE = 'en';

/**
 * Layer id prefixes a map without `streets` drops. Built environment only: the point is that the
 * same tiles can say something different, not that some tiles are missing.
 */
const BUILT_ENVIRONMENT_PREFIXES = ['roads_', 'buildings', 'address_label', 'pois'] as const;

export type BaseMapStyleOptions = {
	readonly theme: Theme;
	/**
	 * How the map is drawn — the author's three switches out of `project.json` (`appearance.ts`),
	 * or a Reader's own override of them.
	 *
	 * **An argument rather than a property of the entry**, for the reason `borders` below is one:
	 * every entry reads the same archive the same way, so the palette and the layer selection are
	 * orthogonal to which tiles are being read and would multiply the catalog if they lived in it.
	 * Omitted, this draws {@link DEFAULT_BASE_MAP_APPEARANCE} — the road network in the ordinary
	 * palette, which is what every Project drew before the field existed.
	 */
	readonly appearance?: BaseMapAppearance;
	readonly catalog?: BaseMapCatalog;
	/**
	 * Turns a deployment-relative asset path into a URL, and is the seam ADR-0006 needs: the
	 * site's address — a domain root or a project subdirectory — is unknown at build time, so
	 * nothing here may be an absolute path. Identity by default, which is what the tests want.
	 *
	 * It receives the glyph and sprite templates with their `{fontstack}`, `{range}`, and
	 * `{flavor}` placeholders intact, so an implementation must not percent-encode them.
	 */
	readonly resolveAsset?: (path: string) => string;
	/**
	 * Read the Base Map from the Workspace's own tile cache instead of from the entry's archive
	 * (ADR-0025).
	 *
	 * `maxZoom` is the highest zoom the cache was filled to, which is the source archive's own
	 * maximum. It is not decoration: without it MapLibre asks for tiles above the pyramid and every
	 * one of them is an empty tile, so the map goes blank at exactly the zoom a user was told works
	 * offline. With it, MapLibre overzooms the deepest cached tile, which is what a scholar sees as
	 * "the map keeps working when I zoom in".
	 *
	 * `tileTemplate` is passed in rather than imported, because this module is evaluated in Node
	 * during both apps' prerender and the protocol module imports `maplibre-gl` — see the note at the
	 * bottom of `src/index.ts`. The caller hands over `cachedBaseMapTileTemplate()`.
	 */
	readonly cachedTiles?: { readonly maxZoom: number; readonly tileTemplate: string };
	/**
	 * Which administrative boundaries to draw. The author's, out of `project.json`, and **not** a
	 * property of the catalog entry — every entry reads the same `boundaries` source-layer, so this
	 * is orthogonal to which Base Map was chosen and would be three times the catalog if it were an
	 * entry. Defaults to `all`, which is what every Project drew before the field existed.
	 */
	readonly borders?: BaseMapBorders;
	/**
	 * How those boundaries are drawn — the author's colour, dash pattern and width, out of
	 * `project.json` beside the level. Every property of it may be unchosen, and an unchosen one is
	 * derived from the flavor, so omitting this argument draws the same map as passing the default.
	 */
	readonly borderStyle?: BaseMapBorderStyle;
	/**
	 * The registered `maplibre-contour` protocol URLs an appearance with `relief` draws from.
	 *
	 * Passed in for the reason `cachedTiles.tileTemplate` is: the library that mints these
	 * registers MapLibre protocols and spawns a worker, and this module is evaluated in Node during
	 * both apps' prerender. The caller hands over `registerTerrainProtocols(catalog.terrain)`.
	 *
	 * Omitted — no terrain in the catalog, or a Base Map being read from the offline cache — a
	 * Project asking for relief draws its terrain colours without it.
	 */
	readonly terrainTiles?: TerrainTileTemplates;
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
	const appearance = options.appearance ?? DEFAULT_BASE_MAP_APPEARANCE;
	const flavorName = baseMapFlavorName(appearance, themeScheme(options.theme));
	const flavor = appearanceFlavor(namedFlavor(flavorName), appearance);
	const terrain = reliefFor(appearance, catalog, options);

	return {
		version: 8,
		glyphs: resolveAsset(catalog.glyphs),
		sprite: resolveAsset(catalog.sprite).replace('{flavor}', flavorName),
		sources: {
			// **One vector source, two ways of reaching the same bytes**, so `type` and `attribution` are
			// stated once. ODbL does not lapse because no request left the machine — the obligation is
			// the data's, not the transport's — and writing the attribution on each branch would be two
			// copies of one contract, editable on one path only.
			[BASE_MAP_SOURCE_ID]: {
				type: 'vector',
				attribution: catalog.attribution,
				...(options.cachedTiles
					? {
							// One tile file per request through the `addProtocol` handler, out of the
							// Workspace. No archive and no range requests — ADR-0025 for why the cache is
							// files. `maxzoom` is the source's own depth: without it MapLibre asks past the
							// pyramid and the map goes blank instead of overzooming.
							tiles: [options.cachedTiles.tileTemplate],
							minzoom: 0,
							maxzoom: options.cachedTiles.maxZoom
						}
					: {
							// The pmtiles protocol reads a single archive over HTTP Range requests, so this
							// URL is a static file and there is no tile server in the picture (ADR-0005).
							url: `pmtiles://${archiveUrl(entry, resolveAsset)}`
						})
			},
			...(terrain === null ? {} : terrainSources(terrain.data, terrain.tiles))
		},
		layers: withRelief(
			appearanceLayers(layers(BASE_MAP_SOURCE_ID, flavor, { lang: LABEL_LANGUAGE }), appearance)
				.filter((layer) => bordersInclude(options.borders ?? DEFAULT_BASE_MAP_BORDERS, layer.id))
				.map((layer) =>
					strengthenedBorder(layer, flavor, options.borderStyle ?? DEFAULT_BASE_MAP_BORDER_STYLE)
				),
			terrain === null ? null : flavor
		)
	};
}

/**
 * What a Project's borders are drawn with when the author has chosen nothing.
 *
 * The editor's Borders section needs this to seed its custom controls: a scholar switching from
 * automatic to chosen must find the pickers holding what is currently on the map, or the switch
 * itself changes the drawing. It resolves the flavor exactly as {@link baseMapStyle} does — same
 * appearance, same theme — rather than re-deriving it, which is what keeps the seeded
 * values honest when an appearance repaints its landcover.
 */
export function automaticBorderStyle(
	appearance: BaseMapAppearance,
	theme: Theme
): BaseMapBorderStyle {
	const flavor = appearanceFlavor(
		namedFlavor(baseMapFlavorName(appearance, themeScheme(theme))),
		appearance
	);
	const drawn = strengthenedBorder(
		{
			id: NATIONAL_BOUNDARY_LAYER,
			type: 'line',
			source: BASE_MAP_SOURCE_ID,
			'source-layer': 'boundaries'
		},
		flavor
	);
	const paint = ('paint' in drawn ? drawn.paint : {}) as Record<string, unknown>;
	return {
		color: typeof paint['line-color'] === 'string' ? paint['line-color'] : null,
		// Upstream's own pattern is solid at low zoom and dashed from z4, which is not one of the
		// three positions the control has. Dashed is what it is for most of the range a scholar looks
		// at, and it is what `lineStyleOf` classifies any unfamiliar tuple as.
		lineStyle: 'dashed',
		width: typeof paint['line-width'] === 'number' ? paint['line-width'] : null
	};
}

/**
 * The themes a chosen border colour would be illegible in, for the editor's warning.
 *
 * Both grounds are checked rather than the one on screen, because the Project travels: a Reader on
 * the Published Site chooses their own theme (`reader-preference.ts`), so a colour legible only in
 * the theme the author happened to be using is a border half of them cannot see.
 */
export function bordersIllegibleThemes(
	appearance: BaseMapAppearance,
	colour: string
): readonly ('light' | 'dark')[] {
	return (['light', 'dark'] as const).filter(
		(scheme) =>
			!borderColorIsLegible(colour, namedFlavor(baseMapFlavorName(appearance, scheme)).earth)
	);
}

/**
 * The elevation dataset this style will actually draw, or `null` for every other style.
 *
 * Three things have to hold, and two of them fail silently, which is why this is a named function
 * rather than a condition inside the style: the deployment must have provisioned a DEM at all, and
 * the caller must have registered the protocols that serve it. With either missing the map still
 * draws — as terrain colours without relief — because editing the catalog is a fork's privilege and
 * must not be able to produce a blank pane.
 *
 * A Base Map read from the offline cache draws no relief either, and that is the point rather than
 * a limitation. The cache holds tiles from the vector archive; the DEM is a second host and a live
 * request. Shading a map that was called available offline with tiles that need the network makes
 * the claim false at exactly the moment somebody relies on it (ADR-0025).
 */
function reliefFor(
	appearance: BaseMapAppearance,
	catalog: BaseMapCatalog,
	options: BaseMapStyleOptions
): { readonly data: BaseMapTerrain; readonly tiles: TerrainTileTemplates } | null {
	if (!appearance.relief) return null;
	if (options.cachedTiles !== undefined) return null;
	if (catalog.terrain === undefined || options.terrainTiles === undefined) return null;
	return { data: catalog.terrain, tiles: options.terrainTiles };
}

/**
 * Slide the relief into an ordered layer stack: shading beneath the water so lakes and coastline
 * stay flat, contours beneath the labels so a place name is never crossed by a line.
 *
 * The two anchors are found by what a layer *is* — the first water fill, the first symbol — rather
 * than by upstream's layer ids, because those ids are `@protomaps/basemaps`' to rename and the
 * failure would be relief quietly painted over the sea. A stack with neither anchor takes the
 * relief at the end; the appearance and `borders` between them can remove a great deal.
 */
function withRelief(all: LayerSpecification[], flavor: Flavor | null): LayerSpecification[] {
	if (flavor === null) return all;
	const anchor = (found: number) => (found === -1 ? all.length : found);
	const beneathWater = anchor(all.findIndex(isWaterFill));
	const beneathLabels = anchor(all.findIndex((layer) => layer.type === 'symbol'));

	const stacked: LayerSpecification[] = [];
	for (let index = 0; index <= all.length; index += 1) {
		if (index === beneathWater) stacked.push(hillshadeLayer());
		if (index === beneathLabels) stacked.push(...contourLayers(flavor));
		const layer = all[index];
		if (layer !== undefined) stacked.push(layer);
	}
	return stacked;
}

const isWaterFill = (layer: LayerSpecification): boolean =>
	layer.type === 'fill' && 'source-layer' in layer && layer['source-layer'] === 'water';

/** The entry's archive as a URL. Remote archives are already addressed; bundled ones are not. */
export function archiveUrl(
	entry: BaseMapEntry,
	resolveAsset: (path: string) => string = identity
): string {
	return isAbsoluteUrl(entry.archive) ? entry.archive : resolveAsset(entry.archive);
}

function appearanceLayers(
	all: LayerSpecification[],
	appearance: BaseMapAppearance
): LayerSpecification[] {
	if (appearance.streets) return all;
	return all.filter(
		(layer) => !BUILT_ENVIRONMENT_PREFIXES.some((prefix) => layer.id.startsWith(prefix))
	);
}

/**
 * With `streets` off, woodland, scrub, sand, beach, glacier, and park are repainted in the flavor's
 * own `landcover` colours — the saturated ones Protomaps uses at low zoom where the natural world
 * is the subject. Deriving them from the flavor rather than picking a palette here is what keeps
 * light and dark coherent, and keeps this from becoming a third theme.
 *
 * `grayscale`, `white`, and `black` carry no `landcover` struct — they are deliberately
 * unsaturated — so a muted map with `streets` off is distinguished by its layer selection alone.
 * That is a reasonable outcome rather than a gap: a muted palette asked for muted.
 */
function appearanceFlavor(flavor: Flavor, appearance: BaseMapAppearance): Flavor {
	const landcover = flavor.landcover;
	if (appearance.streets || landcover === undefined) return flavor;

	// `water` is deliberately not touched: it is already the flavor's most saturated colour, and
	// dropping the built environment is about bringing the *land* up to it rather than inventing a
	// palette.
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
