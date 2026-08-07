# No Base Map ships, and offline Base Map coverage is per-Project and opt-in

> **Amends [ADR-0020](./0020-base-map-catalog-author-default-and-reader-switching.md) and narrows [ADR-0012](./0012-pwa-with-explicit-update-prompt.md).**

No pmtiles archive is shipped. The deployment names its own, and a user makes a **Project** work offline by caching the Base Map tiles that Project's own content needs — not the world, and not a city somebody else chose.

## Why nothing ships

`apps/editor/static/base-map/amsterdam-centre.pmtiles` was 4.0 MB of central Amsterdam, and three of the four catalog entries read it. To a scholar working on Boston it is 4 MB of nothing, and the Amsterdam default view existed to keep the map from looking plausibly empty — the bundled extract and the arbitrary opening view were one decision, not two.

**Glyphs and sprites still ship** — 636 KB and 184 KB. `@protomaps/basemaps` gates every label layer behind its `lang` option, and without the glyph ranges the map draws while MapLibre silently falls back to system fonts. That failure is invisible to every assertion about the map, so those bytes are not optional.

## The deployment must name its archive

Dropping the extract would otherwise promote `https://demo-bucket.protomaps.com/v4.pmtiles` into being the only Base Map anyone gets — and this repository already records why that is unacceptable: it is the bucket Protomaps publishes for trying the format out, with no published rate limit, no uptime promise, and no terms of use, reached by every fork's users because it is in the catalog. "Nothing about it is suitable to rely on."

So `scripts/check-base-map-catalog.mjs` — which already enforces that no module outside the catalog names an archive — **fails the deployment check while the catalog still points at the demo bucket**. Every production deployment must state where its tiles come from. Per ADR-0020 that is a change to one line of one file.

**Temporary educational-development exception (2026-08-07).** This repository has no Base Map
hosting budget while it is being developed and evaluated, so its ordinary development catalog
temporarily retains `https://demo-bucket.protomaps.com/v4.pmtiles` by explicit human decision. This
does not make the URL production-suitable. Ordinary `pnpm lint` remains green for contributors,
while `pnpm check:deployment` fails, names the affected entries, and requires `REMOTE_ARCHIVE` to
point at an archive controlled by the deployment. A production deployment is blocked until that
check passes; the safeguard is narrowed to deployment rather than removed or bypassed.

The Amsterdam extract stays in the repository as an **e2e fixture**: `e2e/support/editor-deployment.ts` finds "the `.pmtiles` archive in the directory" and serves it byte-range, and several suites need real pmtiles bytes to assert anything at all. It stops being shipped; it is not deleted.

## Cached tiles are files, not an archive

The cache is `workspace/base-map/tiles/{z}/{x}/{y}.mvt`, read through a MapLibre `addProtocol` handler — [ADR-0011](./0011-local-tiles-reach-renderers-by-per-consumer-injection.md)'s pattern verbatim, the one `tile-protocol.ts` already implements for Historical Map tiles.

**Writing a PMTiles v3 archive client-side was rejected.** `pmtiles@4.4.1` has no writer — its exports are all read-side, and there is no varint writer or header serialiser — so it would mean implementing the 127-byte header, root and leaf directories, run-length-encoded clustered entries, and Hilbert tile ordering ourselves. That is archive-format code whose failure mode is silent, which is exactly the bug [ADR-0024](./0024-backup-and-handoff-are-different-artefacts.md) is escaping rather than one worth writing again. (`zxyToTileId` and `tileIdToZxy` *are* exported, so enumerating a bounding box's tiles and pulling each from a source archive is easy under any storage choice. Only writing was hard.)

**Caching HTTP byte ranges in the service worker was rejected** because the cached unit would be ranges, which depend on the reader's access pattern rather than on a tile list. A near-miss range is a miss, and the result is a map with holes — which reads as corruption, the failure ADR-0012's fence 2 exists to avoid.

Storing tiles as files also means:

- **A directory of tile files is what a static host serves natively.** No range requests and no `Content-Length` fragility — the service worker already carries a workaround for `pmtiles`' `FetchSource` rejecting a cached response with no content-length header, and that class of problem disappears.
- **ADR-0020's zero-extra-bytes claim survives.** The offline looks are style documents over one *vector* dataset, so caching `.mvt` keeps three Base Map appearances over one set of tiles. Caching raster would have destroyed that.
- **The cache is Workspace-level and deduplicates across Projects for free**, consistent with ADR-0023. Two Projects in the same city share tiles, and "is this Project available offline?" is therefore *computed* — are the tiles for its extent present? — rather than a stored flag that can lie.

## Consequences

- **ADR-0012's offline claim narrows, and SPEC story 8 must be reworded rather than quietly broken.** The honest claim: a user's Historical Maps, Alignments, and Annotations always work with no network; the Base Map works offline once that Project has been made available offline.
- **The tile budget is shown before it is spent, and there is a refusal threshold.** A city centre at z0–14 is tens of tiles; a country at z14 is thousands; a continent is hundreds of thousands. The user sees tile count and megabytes before agreeing — this fetches from someone else's server, and ADR-0007 already demands that courtesy before mirroring a level-0 pyramid.
- **Every zoom level from 0 to the source's maximum is cached over the Project's extent.** Low zooms are one or two tiles each and nearly free, and omitting them makes zooming out go blank, which reads as breakage.
- **Compression is explicit.** PMTiles stores tiles gzipped and its Protocol decompresses on the way out; storing them compressed and serving them as though they were not is a silent blank map.
- **Attribution survives caching.** The data is OSM under ODbL, and the obligation does not lapse because no network request happens.
- **`PublishedSite.baseMapBundled` changes meaning**, from "the deployment's extract was copied" to "this Workspace carries cached tiles". `ReaderMapPane` already has a check for whether the site carries the Base Map's own files.
- **The cache is reclaimable from the hub**, listed with its size, like the Workspace's Historical Maps (ADR-0023).
- **The opening view is computed from the Project's content, not from the catalog.** `BASE_MAP_CATALOG.initialView` survives only as the fallback for a Project with nothing placed on the earth yet — see ADR-0026.
