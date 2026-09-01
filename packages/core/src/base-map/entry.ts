import type { ThemeScheme } from '../theme';

/**
 * A named Protomaps flavor. A `Flavor` is a struct of colours per layer class — `water`,
 * `wood_a`, `scrub_a`, `glacier`, `sand`, `beach`, `buildings`, `highway`, `railway`, and
 * many more — which is why two content-distinct Base Maps are two style documents over one
 * pmtiles archive and cost no extra data (ADR-0005).
 *
 * `@protomaps/basemaps` exports exactly these five.
 */
export type BaseMapFlavorName = 'light' | 'dark' | 'grayscale' | 'white' | 'black';

/**
 * Which layer classes a variant emphasises.
 *
 * - `streets-and-labels` — the whole layer set: roads, buildings, and labels over muted terrain.
 * - `water-and-terrain` — roads, buildings, and address labels are dropped, and woodland, scrub,
 *   sand, beach, and glacier take the flavor's saturated landcover colours.
 * - `relief-and-contours` — the same land as `water-and-terrain`, with shaded relief and contour
 *   lines drawn over it. **The only emphasis that reads a second dataset**: the vector archive
 *   carries no elevation, so this one needs the catalog's {@link BaseMapCatalog.terrain}. Without
 *   it the variant falls back to plain terrain rather than failing, because a catalog is a fork's
 *   to edit and half a topographic map beats a blank pane.
 *
 * These deliberately do not share names with any entry id. An emphasis is internal vocabulary an
 * entry selects; an id is a public identifier a Project records, and
 * `scripts/check-base-map-catalog.mjs` can only tell them apart if they read differently.
 */
export type BaseMapEmphasis = 'streets-and-labels' | 'water-and-terrain' | 'relief-and-contours';

/**
 * The elevation dataset a `relief-and-contours` variant reads, and the second address in this
 * file — so, like an archive, deployment configuration and never Project data (ADR-0020).
 *
 * Relief and contours are computed from the *same* DEM tiles: MapLibre shades the raster directly,
 * and `maplibre-contour` traces isolines out of it in a worker. One dataset, two renderings, which
 * is the same economy `emphasis` buys over the vector archive.
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
 * One Base Map offered by this deployment.
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
	readonly emphasis: BaseMapEmphasis;
	/** The flavor per theme, so one theme signal drives the map as well as the UI (ADR-0016). */
	readonly flavor: Readonly<Record<ThemeScheme, BaseMapFlavorName>>;
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
	 * `relief-and-contours` entry degrades to terrain colours rather than disappearing.
	 */
	readonly terrain?: BaseMapTerrain;
	/**
	 * Attribution for the tiles, shown by MapLibre's attribution control. OpenStreetMap data
	 * is ODbL and this is a licence obligation, not a courtesy — see THIRD-PARTY-NOTICES.md.
	 */
	readonly attribution: string;
};
