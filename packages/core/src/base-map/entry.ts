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
 * One set of tiles this deployment can draw a Base Map from.
 *
 * **An address and a name, and nothing about how the map looks.** How it looks is three switches
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
	 * Attribution for the tiles, shown by MapLibre's attribution control. OpenStreetMap data
	 * is ODbL and this is a licence obligation, not a courtesy — see THIRD-PARTY-NOTICES.md.
	 */
	readonly attribution: string;
};
