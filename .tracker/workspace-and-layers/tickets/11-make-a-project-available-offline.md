# Make a Project available offline

## What to build

A scholar can say that a Project should work with no network. They are shown how many Base Map tiles and how many megabytes that will take, they agree, and the tiles are fetched into the Workspace and served from there. The same screen carries the per-map "make an offline copy" action for Historical Maps that live on a Library's server.

Demonstrable end to end: a Project with work in one city, made available offline; the network cut; the Project reopened and the Base Map still draws across the area the work covers, at every zoom.

Read [ADR-0025](../../../docs/adr/0025-no-base-map-ships-offline-is-per-project-and-opt-in.md) first.

## Where to start

- `apps/editor/src/lib/image-pane/tile-protocol.ts` — **the pattern to copy.** `addProtocol` under a private scheme, a registry, bytes through an injected `fetch`, and a transparent tile for a request outside the pyramid. The Base Map cache is the same shape for vector tiles.
- `packages/core/src/render/pmtiles-protocol.ts` — where `pmtiles://` is registered, and where a second protocol joins it.
- `packages/core/src/base-map/style.ts` — how the style document names its source. The cached case points the source at the new protocol.
- `pmtiles@4.4.1`'s exports — `zxyToTileId`, `tileIdToZxy`, `PMTiles`, `FetchSource`. These are how tiles are enumerated and pulled from a source archive. **There is no writer in that package**, which is why the cache is files.
- The bounds function from ticket 09 — it already computes a Project's extent. The tile enumeration takes that extent.
- `packages/core/src/remote-iiif/mirror.ts` and `apps/editor/src/lib/remote-iiif/MirrorMap.svelte` — the existing offline-copy flow, including its plan, its request count, and its rights display. Reused, relocated.
- `packages/core/src/publish/publish.ts` — `PublishedSite.baseMapBundled`, and `apps/viewer/src/lib/ReaderMapPane.svelte`'s check for whether the site carries the Base Map's files.
- The hub list from ticket 08 — the cache's size and its clear action sit beside it.

## Contract

**Tiles are individual files at `base-map/tiles/{z}/{x}/{y}.mvt`, Workspace-level**, read through a MapLibre `addProtocol` handler. Workspace-level so two Projects in the same city share tiles automatically, which also makes **"is this Project available offline?" a computed question** — are the tiles its extent needs present? — and never a stored flag that can lie.

**Enumeration is a pure function**: given a bounding box and a zoom range, which `{z}/{x}/{y}` are needed, how many there are, and roughly how many bytes. It is what the budget dialog displays and what the fetch loop consumes, so the number shown and the work done cannot diverge.

**The count and the byte estimate are shown before anything is fetched, and there is a refusal threshold.** A city centre at z0–14 is tens of tiles; a country at z14 is thousands; a continent is hundreds of thousands. This fetches from someone else's server, and ADR-0007 already demands that courtesy before mirroring a level-0 pyramid. An over-threshold request is refused with the numbers and an explanation, not started.

**Every zoom level from 0 to the source's maximum is cached over the extent.** Low zooms are one or two tiles each and nearly free. Omitting them makes zooming out go blank, which reads as breakage.

**Compression is explicit.** PMTiles stores tiles gzipped and its `Protocol` decompresses on the way out. Decide whether the cache holds compressed or decompressed bytes, write it down, and make the handler agree. Getting this wrong is a **silent blank map** — the bytes arrive, MapLibre cannot parse them, and nothing errors.

**Attribution survives caching.** The data is OpenStreetMap under ODbL; the obligation does not lapse because no network request happens. The cached case carries the same attribution string.

**A request for a tile outside the cache is answered honestly.** Follow `tile-protocol.ts`: a transparent or empty tile rather than a throw, so a stray request does not fill the console — but the *Project-level* claim ("this Project is available offline") must be false if any tile its extent needs is missing. Do not let a partial cache claim completeness.

**`PublishedSite.baseMapBundled` changes meaning** to "this Workspace carries cached tiles", and publishing an offline-capable site copies nothing extra — the tiles are already in the Workspace, which is the published root.

**The per-map offline copy action moves to the Layer card.** Its existing behaviour is kept exactly: the plan the user was shown is the plan that runs; the rights statement and `requiredStatement` are displayed at the moment of choosing; a level-0 source that would take thousands of requests is warned about; copying is one map at a time and never bulk. Making an offline copy of an already-aligned map keeps every Control Point — that already works and must not regress.

**The cache is reclaimable from the hub**, listed with its size beside the Historical Maps.

## Out of scope

- **Do not write a PMTiles archive.** `pmtiles@4.4.1` has no writer; hand-rolling the v3 header, leaf directories, run-length-encoded entries, and Hilbert ordering is archive-format code whose failure mode is silent, which is the class of bug this epic is escaping.
- **Do not cache HTTP byte ranges in the service worker.** The cached unit would depend on access pattern, and a near-miss range renders holes, which reads as corruption (ADR-0012 fence 2).
- **Do not cache raster tiles.** Vector is what keeps several Base Map looks over one dataset.
- **Do not cache remote Historical Map tiles for offline alignment.** Same fence: a partially cached remote pyramid renders with holes. Making an offline copy is the supported answer.
- **Do not add a COOP/COEP service worker.**
- **Do not refetch tiles already in the cache**, and do not re-fetch on every open.
- **Do not make this automatic.** It is opt-in, per Project, always with the numbers first.

## Acceptance criteria

- [ ] "Make this Project available offline" shows a tile count and a byte estimate before fetching anything.
- [ ] Agreeing writes `base-map/tiles/{z}/{x}/{y}.mvt` files covering the Project's extent at every zoom from 0 to the source maximum.
- [ ] With the network cut, the Project's Base Map draws across its extent, at the lowest zoom and at the highest.
- [ ] An extent whose tile count exceeds the threshold is refused with the numbers and an explanation, and writes nothing.
- [ ] A second Project in the same area reports itself available offline without fetching anything, and the tile count on disk does not grow.
- [ ] A Project whose extent has grown beyond its cached tiles reports itself **not** fully available offline.
- [ ] Re-running the action fetches only tiles not already present.
- [ ] The attribution string is present with the cache serving and the network cut.
- [ ] The hub shows the cache's size and clears it, and clearing makes the Projects report themselves not available offline.
- [ ] Making an offline copy of a Historical Map is reachable from its Layer card, shows the rights statement before copying, warns on a level-0 source, and preserves every Control Point of an already-aligned map.
- [ ] A published site with cached tiles draws its Base Map with the network cut.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
pnpm exec playwright test e2e/editor-base-map.e2e.ts e2e/editor-mirroring.e2e.ts e2e/editor-publish.e2e.ts e2e/viewer-reader.e2e.ts
pnpm test:e2e
```

All green, and no spec may reach the internet — route the tile source as the remote-IIIF specs already route theirs.

Enumeration is a **pure function tested numerically in Node**: a known bounding box at a known zoom range yields a known tile list and count. That is what makes the budget honest.

The offline-drawing criteria must be asserted through the protocol handler actually serving bytes MapLibre accepted — the `window.ballastellaServedTiles` pattern. **An assertion that the map has a source, or that no error appeared, is not sufficient**: the compression mistake produces exactly that — bytes served, nothing drawn, nothing thrown.

## Blocked by

- Ticket 08
- Ticket 10
