import type { Theme } from '../theme';

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
 *
 * These deliberately do not share names with any entry id. An emphasis is internal vocabulary an
 * entry selects; an id is a public identifier a Project records, and
 * `scripts/check-base-map-catalog.mjs` can only tell them apart if they read differently.
 */
export type BaseMapEmphasis = 'streets-and-labels' | 'water-and-terrain';

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
	readonly flavor: Readonly<Record<Theme, BaseMapFlavorName>>;
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
	 * Attribution for the tiles, shown by MapLibre's attribution control. OpenStreetMap data
	 * is ODbL and this is a licence obligation, not a courtesy — see THIRD-PARTY-NOTICES.md.
	 */
	readonly attribution: string;
};
