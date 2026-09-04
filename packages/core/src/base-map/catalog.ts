import type { BaseMapCatalog } from './entry';

// ┌───────────────────────────────────────────────────────────────────────────────────────┐
// │ THE BASE MAP CATALOG. This module is deployment configuration (ADR-0020).             │
// │                                                                                       │
// │ Adding, removing, relabelling, or repointing an entry must require **no change**       │
// │ anywhere else in the repository. That property is what a forker pointing at their own  │
// │ tiles depends on, and it is asserted rather than intended:                             │
// │                                                                                       │
// │   - `scripts/check-base-map-catalog.mjs` fails `pnpm lint` if any other module names   │
// │     an entry id or an archive from this file.                                          │
// │   - `resolve.test.ts` and `style.test.ts` drive every base-map function from fixture   │
// │     catalogs with entirely different entries.                                          │
// │                                                                                       │
// │ So: change this file, and nothing else.                                               │
// └───────────────────────────────────────────────────────────────────────────────────────┘

/**
 * Protomaps' public **demo** planet. Keyless, so it costs no secret and breaks no fork — but it
 * is a network dependency, which is what `needsNetwork` exists to say out loud.
 *
 * **Provenance and terms.** This is Protomaps' daily planet build, mirrored on Source Cooperative
 * (AWS us-west-2). Its data is OpenStreetMap under ODbL 1.0, carried by the `attribution` below.
 * The *hosting* is somebody else's, and Source Cooperative says in as many words: "We don't
 * recommend cross-origin hotlinking directly to source.coop URLs." So this is the same **kind** of
 * dependency as the archive it replaced, and it is chosen with that understood rather than
 * overlooked — see the amendment in ADR-0025 dated 2026-08-10.
 *
 * **Why it replaced `demo-bucket.protomaps.com`.** That bucket now answers `404` for this file, so
 * the Base Map was not degraded but absent: Map Images drew on blank space with nothing on
 * screen saying why. The previous decision — recorded in ADR-0025 as settled — was that the demo
 * tiles stayed. A 404 overtook it.
 *
 * **Two facts measured on 2026-08-10 rather than assumed**, because both fail quietly if wrong:
 * `v4.pmtiles` answers `HTTP 206` to a range request with `access-control-allow-origin: *` and
 * `access-control-expose-headers: *`, so a browser can read it cross-origin; and the sibling
 * `v3.pmtiles` is a `404`, so v4 is not a preference here but the only file there. v4 is also what
 * `@protomaps/basemaps@5` styles are built against — a v3 tileset under a v5 style is the silent
 * failure ADR-0025 warns about, a plausible-looking pane of the wrong world.
 *
 * A deployment that wants worldwide coverage it controls should point this entry at its own archive
 * — a bucket of its own or a self-hosted extract — which is a change to this line and nothing else
 * (ADR-0020). `pnpm check:deployment` refuses this host for exactly that reason: production must
 * point this constant at an archive that deployment controls (ADR-0025).
 */
const REMOTE_ARCHIVE = 'https://data.source.coop/protomaps/openstreetmap/v4.pmtiles';

/**
 * The elevation dataset behind shaded relief and contour lines: Tilezen's Terrain Tiles on AWS Open
 * Data, in `terrarium` encoding.
 *
 * **Why a second dataset exists here at all.** The vector archive above is OpenStreetMap, and
 * OpenStreetMap does not carry elevation. Everything else a Base Map can be told to draw is a style
 * document over one set of tiles, which is the economy ADR-0005 rests on; relief is the one thing
 * that cannot be. Both the shading and the contour lines are drawn from *this* raster, so
 * it is one extra dataset and not two — `registerTerrainProtocols` traces the isolines out of the
 * DEM tiles the hillshade is already reading.
 *
 * **Provenance and terms.** Assembled by the Tilezen project from SRTM, ETOPO1, NED, and national
 * surveys, each under its own terms; the attribution below points at the list, which is the form
 * the licences ask for. Hosting is AWS Open Data — free to read, no key, no account, and, exactly
 * like the archive above, somebody else's bandwidth with no promise to this deployment.
 * `pnpm check:deployment` refuses this host for that reason: production points these constants at
 * tiles the deployment controls, and doing so is a change to this file and nothing else (ADR-0020).
 *
 * `maxZoom` is 15 because that is where this dataset's pyramid ends. It is not a display limit —
 * MapLibre overzooms past it and the relief stays on screen — but naming a zoom the tiles do not
 * reach makes the mountains vanish at exactly the zoom somebody leaned in to read them.
 */
const TERRAIN_DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/**
 * The satellite imagery behind the `imagery` switch: EOX's Sentinel-2 cloudless mosaic, served as
 * WMTS from `tiles.maps.eox.at`.
 *
 * **Why this mosaic and not a sharper one.** Sentinel-2 cloudless is CC BY 4.0 — an open licence,
 * not a free tier — which is the property that matters here, because a Published Site is a scholar
 * redistributing what this deployment pointed them at. The sharper keyless imagery in the wild
 * (Esri's World Imagery, chiefly) is offered under terms of use rather than a licence, and putting
 * it under somebody's edition would hand them a question they did not ask for.
 *
 * What that buys is a whole cloud-free planet at 10 m/px, assembled from a year of Sentinel-2
 * passes. It reads landscape — coastline, forest, field systems, the shape of a valley — and it
 * does not read rooftops. For a map under a fourteenth-century itinerary that is the right subject
 * anyway, but it is a real limit and `maxZoom` states it rather than letting a scholar zoom into
 * blur wondering whether something is loading.
 *
 * **The year is part of the URL**, and deliberately visible here rather than computed: each annual
 * mosaic is a distinct published dataset, and a map whose imagery silently became a different year
 * between two readings of the same edition is the quiet failure ADR-0025 warns about. Moving to a
 * later year is a change to this line and nothing else.
 *
 * **Terms and hosting.** The imagery is CC BY 4.0, carried by the attribution below, which EOX asks
 * be shown as given. The *hosting* is EOX's own service, free and keyless and with no promise to
 * this deployment — the same kind of dependency as the archive and the DEM above, and
 * `pnpm check:deployment` refuses this host for the same reason.
 *
 * Measured on 2026-09-03 rather than assumed: `s2cloudless-2025_3857` answers `200 image/jpeg` and
 * reflects an `Origin` header back as `access-control-allow-origin`, so a browser can read it
 * cross-origin. The path is WMTS REST, whose segments after `default/g` are **z, y, x** in that
 * order — not the `{z}/{x}/{y}` of an XYZ service, and a transposed template returns real tiles of
 * the wrong place rather than an error.
 */
const IMAGERY_TILES =
	'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg';

export const BASE_MAP_CATALOG: BaseMapCatalog = {
	// One archive, one entry. What the map *looks like* — streets, relief, high contrast — is three
	// switches the author sets per Project (`appearance.ts`), not a row here: they are style
	// documents over these same tiles, and enumerating their combinations would be eight entries
	// saying one thing. A deployment that really does have a second set of tiles — a regional
	// extract bundled for offline work beside a worldwide archive — adds it here and the switcher
	// appears on its own.
	entries: [
		{
			id: 'planet',
			label: 'Worldwide',
			needsNetwork: true,
			archive: REMOTE_ARCHIVE
		}
	],
	defaultId: 'planet',
	// The deliberate fallback for a Project with nothing placed on the earth (ADR-0026). A whole
	// world rather than one city: nothing has been placed yet, so no city is the right guess, and
	// zoomed out is the view an author can pan and zoom out of towards anywhere.
	initialView: { center: [0, 20], zoom: 1 },
	glyphs: 'base-map/fonts/{fontstack}/{range}.pbf',
	terrain: {
		tiles: TERRAIN_DEM,
		encoding: 'terrarium',
		maxZoom: 15,
		attribution:
			'<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noreferrer">' +
			'Terrain Tiles</a>'
	},
	imagery: {
		tiles: IMAGERY_TILES,
		// 10 m/px is where Sentinel-2's own resolution ends, which is about z14. Past it MapLibre
		// overzooms the deepest real tile rather than fetching four upsampled copies of it.
		maxZoom: 14,
		tileSize: 256,
		attribution:
			'<a href="https://s2maps.eu" target="_blank" rel="noreferrer">Sentinel-2 cloudless</a> by ' +
			'<a href="https://eox.at" target="_blank" rel="noreferrer">EOX IT Services GmbH</a> ' +
			'(<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>)'
	},
	sprite: 'base-map/sprites/{flavor}',
	attribution:
		'<a href="https://openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a> · ' +
		'<a href="https://protomaps.com" target="_blank" rel="noreferrer">Protomaps</a>'
};
