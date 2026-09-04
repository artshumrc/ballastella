/**
 * A named Protomaps flavor. A `Flavor` is a struct of colours per layer class — `water`,
 * `wood_a`, `scrub_a`, `glacier`, `sand`, `beach`, `buildings`, `highway`, `railway`, and
 * many more — which is why two content-distinct Base Maps are two style documents over one
 * pmtiles archive and cost no extra data (ADR-0005).
 *
 * `@protomaps/basemaps` exports exactly these five. Which of them a map is drawn in is the
 * author's `BaseMapAppearance` — see `appearance.ts` — and never a property of an entry: the
 * palette is a choice about the work, and an entry is an address.
 */
export type BaseMapFlavorName = 'light' | 'dark' | 'grayscale' | 'white' | 'black';

/**
 * The elevation dataset a Base Map drawn with relief reads, and the second address in this
 * file — so, like an archive, deployment configuration and never Project data (ADR-0020).
 *
 * Relief and contours are computed from the *same* DEM tiles: MapLibre shades the raster directly,
 * and `maplibre-contour` traces isolines out of it in a worker. One dataset, two renderings, which
 * is the same economy `BaseMapAppearance` buys over the vector archive.
 */
export type BaseMapTerrain = {
	/** Raster DEM tile template carrying `{z}`, `{x}`, and `{y}`. Absolute, or deployment-relative. */
	readonly tiles: string;
	/** How pixel RGB encodes metres. `terrarium` and `mapbox` are the two schemes in the wild. */
	readonly encoding: 'terrarium' | 'mapbox';
	/**
	 * The deepest zoom the DEM publishes. Load-bearing twice over: MapLibre overzooms rather than
	 * asking past the pyramid, and the contour worker reads neighbouring tiles at this zoom to
	 * close isolines across tile edges. Too high and the map goes blank where relief should be.
	 */
	readonly maxZoom: number;
	/** Attribution for the elevation data. A separate obligation from the vector tiles'. */
	readonly attribution: string;
};

/**
 * The satellite imagery a Base Map drawn with `imagery` reads, and the third address in this file
 * — so, like an archive and a DEM, deployment configuration and never Project data (ADR-0020).
 *
 * **Photographs, so a raster source rather than a second archive.** Everything the vector archive
 * carries is a claim somebody drew; imagery is the ground itself, and the reason it is a switch
 * (`appearance.ts`) rather than a catalog entry is that a scholar turning it on wants the roads,
 * the names and the borders to stay *on top of* it. An entry is a set of tiles a whole map is built
 * from; this is a layer underneath one.
 */
export type BaseMapImagery = {
	/** Raster tile template carrying `{z}`, `{x}`, and `{y}`. Absolute, or deployment-relative. */
	readonly tiles: string;
	/**
	 * The deepest zoom the imagery holds real detail at. Load-bearing for the reason
	 * {@link BaseMapTerrain.maxZoom} is, and for one more: past it MapLibre overzooms the deepest
	 * real tile instead of fetching four upsampled copies of it, so a number that is honest about
	 * the source's resolution is also four times less traffic at every zoom beyond it.
	 */
	readonly maxZoom: number;
	/**
	 * Tile edge in pixels. **Stated rather than defaulted**: MapLibre assumes 512 for a raster
	 * source and a great deal of imagery in the wild is 256, and the failure is not an error but a
	 * picture at the wrong scale — coastlines a zoom level out from the vector layers over them.
	 */
	readonly tileSize: number;
	/** Attribution for the imagery. A separate obligation from the vector tiles' and the DEM's. */
	readonly attribution: string;
};

/**
 * One set of tiles this deployment can draw a Base Map from.
 *
 * **An address and a name, and nothing about how the map looks.** How it looks is four switches
 * the author sets (`appearance.ts`), applied to whichever of these is being read — so a deployment
 * with one archive has one entry here, and a deployment with a regional extract beside a worldwide
 * one has two, which is the only thing there is ever more than one of.
 *
 * The catalog of these is **deployment configuration, not Project data** (ADR-0020).
 * `project.json` records `baseMap: "<id>"` and nothing else — never an `archive`, never a
 * URL. See `./project.ts`.
 */
export type BaseMapEntry = {
	/** Stable, and the only part of this record a Project may reference (ADR-0020). */
	readonly id: string;
	/** Shown in the switcher. Free to change without touching any Project. */
	readonly label: string;
	/**
	 * pmtiles bundled in the Workspace → `false`; remote → `true`. This is **used**, not
	 * merely stored: `baseMapOptions` marks the entry so a Reader on a plane is not offered a
	 * blank map with no explanation (ADR-0020).
	 */
	readonly needsNetwork: boolean;
	/**
	 * The pmtiles archive: a deployment-relative path for a bundled archive, or an absolute
	 * URL for a remote one. Several entries naming the *same* archive is the normal case and
	 * the point — that is the zero-extra-data claim.
	 */
	readonly archive: string;
};

/**
 * Everything this deployment knows about Base Maps.
 *
 * This whole value is what a forker replaces to point at their own tiles, and replacing it must
 * require no change anywhere else — which is why the initial view, the glyph and sprite
 * locations, and the attribution live here too rather than in the app. See
 * `scripts/check-base-map-catalog.mjs`, which fails the build if any module outside the
 * catalog names an entry.
 */
export type BaseMapCatalog = {
	readonly entries: readonly BaseMapEntry[];
	/** The deployment default. An id absent from `entries` falls back to this (ADR-0020). */
	readonly defaultId: string;
	/** Where the panes open. Must lie inside a bundled archive's bounds, or the map is blank. */
	readonly initialView: {
		readonly center: readonly [lng: number, lat: number];
		readonly zoom: number;
	};
	/** Deployment-relative glyph URL template, carrying `{fontstack}` and `{range}`. */
	readonly glyphs: string;
	/** Deployment-relative sprite URL template, carrying `{flavor}`. No file extension. */
	readonly sprite: string;
	/**
	 * The elevation dataset, if this deployment has one. Optional because it is a second host to
	 * provision: a fork with no DEM to point at still gets every other entry, and a
	 * Project asking for relief degrades to terrain colours rather than disappearing.
	 */
	readonly terrain?: BaseMapTerrain;
	/**
	 * The satellite imagery, if this deployment has any. Optional for the reason `terrain` is: a
	 * fork with nothing to point at still gets every other entry, and a Project asking for imagery
	 * draws the vector ground rather than a blank pane.
	 */
	readonly imagery?: BaseMapImagery;
	/**
	 * Attribution for the tiles, shown by MapLibre's attribution control. OpenStreetMap data
	 * is ODbL and this is a licence obligation, not a courtesy — see THIRD-PARTY-NOTICES.md.
	 */
	readonly attribution: string;
};
