# 03 — Image pane: synthetic projection over a fixture pyramid

## What to build

A deep-zoomable view of a Historical Map inside a MapLibre map, where the coordinate system is **image pixels** rather than geography.

The user sees one pane containing a committed fixture level-0 pyramid, and can pan and zoom it smoothly to full resolution. Clicking reports the image pixel coordinate under the cursor.

**This is the highest-risk unknown in the project.** MapLibre is Web Mercator only, so image pixel space must be mapped into a synthetic geographic window and back. The failure mode is silent: Control Points that **drift as you zoom**, which looks like imprecision rather than a bug and would poison every alignment made with the tool.

**Fulfills** — no [SPEC.md](../SPEC.md) user story on its own; the pane here shows a committed fixture, not the user's map. This is the groundwork for story 31 (deep zoom to place a Control Point precisely), which lands in ticket 06, and the precision every story in *Aligning* rests on.

## Where to start

[ADR-0005](../../../docs/adr/0005-maplibre-and-terra-draw.md) — the MapLibre decision and the projection consequence. Then the Build-order section of [SPEC.md](../SPEC.md).

Allmaps Editor does exactly this and is the best reference for *how*. It is at `apps/editor` in the Allmaps repository and is **GPL-3.0: read it, do not copy from it** (ADR-0021).

Tile geometry comes from `@allmaps/iiif-parser`:

```
Image#tileZoomLevels                                → { scaleFactor, width, height,
                                                        originalWidth, originalHeight,
                                                        columns, rows }[]
Image#getTileImageRequest(zoomLevel, column, row)   → { region, size }
```

Use `getTileImageRequest` to build tile URLs. Do not hand-roll IIIF tile arithmetic — this function is also what the tiler in ticket 05 uses to decide what to *write*, so using it on both sides is what guarantees reader and writer cannot disagree.

The fixture pyramid is served from the app's static assets over ordinary HTTP, so **no tile-fetch injection is needed in this slice**. That is deliberate: it keeps the projection isolated from the storage layer.

## Contract

Two pure functions, and they are the deliverable that matters:

```ts
resourceToSynthetic(point: {x: number, y: number}): {lng: number, lat: number}
syntheticToResource(lngLat: {lng: number, lat: number}): {x: number, y: number}
```

They must round-trip to within a documented pixel tolerance **at every zoom level the pyramid offers**, and the tolerance must be tight enough that a Control Point placed at full resolution does not visibly move when the user zooms out and back in.

Choose the synthetic window so Mercator distortion is negligible — near the equator, over a small longitude and latitude span. **Record the chosen window and the reasoning in a comment**, because it is the kind of arbitrary-looking constant a later contributor will "clean up."

Commit a **real** fixture pyramid, not a synthetic gradient: enough zoom levels to exercise more than one `scaleFactor`, and non-square overall dimensions so that a transposed width/height cannot pass unnoticed. Ragged edge tiles must be present.

## Out of scope

- **The tiler.** The fixture is pre-tiled and committed. Ticket 05 generates pyramids.
- **Reading tiles from `ProjectStore`.** Ticket 06 adds injection; here tiles come from static assets by URL.
- **The base map pane** — ticket 04.
- **Control Points, drawing, `terra-draw`** — ticket 07. Reporting a pixel coordinate on click is enough.
- **`@allmaps/maplibre` and warped rendering.** This pane shows the image *unwarped*, in its own coordinate system. Nothing is warped in this slice.
- **triiiceratops.** Different component, different job (ticket 14).

## Acceptance criteria

- [x] The fixture pyramid renders in a MapLibre map and is pannable and zoomable to full resolution
- [x] Tiles at every `scaleFactor` in the fixture load, including ragged edge tiles at the right and bottom margins
- [x] `resourceToSynthetic` → `syntheticToResource` round-trips within the documented tolerance for a set of points including all four corners, the centre, and points on the ragged edges
- [x] The round-trip assertion runs at **every** zoom level the fixture offers, not just one — but read this criterion as it was delivered, not as written: the projection is zoom-independent by design, so the per-level loop varies the point set, not the behaviour. What genuinely holds *per zoom level* is the tile-origin identity. See *Review follow-ups*.
- [x] Clicking reports an image pixel coordinate that matches the visually indicated feature within the documented tolerance
- [x] A point placed at maximum zoom, after zooming fully out and back in, reports the same pixel coordinate within tolerance
- [x] Tile URLs are built via `getTileImageRequest`, not by string arithmetic in this slice's own code
- [x] The chosen synthetic window and its justification are recorded in a comment

```bash
pnpm --filter @ballastella/core test          # round-trip assertions
pnpm test:e2e                          # render, pan/zoom, click-to-coordinate, zoom-stability
pnpm -r build && pnpm lint && pnpm check
```

Success: all exit 0. **The round-trip assertions must be numeric.** A screenshot or a visual check does not satisfy this ticket — silent drift is exactly what visual inspection misses, and SPEC's Testing Decisions rules out pixel comparison as a verification strategy.

## Blocked by

- Ticket 01

## Comments

### Implementation, 2026-08-05

**The projection holds.** Measured round-trip error, pixel → lng/lat → pixel, over a dense
grid and at every zoom level the fixture offers:

| Pyramid | worst Δx | worst Δy |
|---|---|---|
| fixture, 1200 × 851, 256px tiles, coarsest scale factor 8 | 0 | 4.5e-10 px |
| archival scan, 60000 × 24000, 256px tiles, coarsest scale factor 256 | 0 | 0 |
| very large scan, 65536 × 40000, 512px tiles, coarsest scale factor 128 | 1.4e-8 px | 0 |

Documented tolerance is `ROUND_TRIP_TOLERANCE_PX = 1e-6` image pixels — some seventyfold
headroom over the worst measurement, five orders of magnitude tighter than a pixel. The error
grows with the window because the information sits in the low bits of a Mercator coordinate
near 0.5; it does not grow with zoom, because the two functions are zoom-independent.

**The window.** One tile of the Web Mercator grid at zoom 12 — the tile whose north-west corner
is the equator meeting the prime meridian, so image pixel (0, 0) is *exactly* 0°, 0°. Full
reasoning is in the header comment of `packages/core/src/image-pane/synthetic-projection.ts`,
including why it must stay a whole tile zoom. The mapping is linear in Mercator, not in
degrees, which is what makes the pyramid's tile grid coincide with MapLibre's XYZ grid; the
consequence is 1.2 ppm of north-south stretch across the window, 0.0014 image pixels over this
fixture, and it never enters the round-trip.

**Two things the ticket did not anticipate, both handled:**

- **MapLibre stretches a raster tile to fill its cell.** A ragged edge tile is 176 × 256 rather
  than 256 × 256, and drawn as-is it is stretched 45%, putting content near the image's edges
  tens of pixels from where a Control Point placed there would think it was. Ragged tiles are
  therefore drawn into a transparent full-size tile at the size they actually cover. That size
  is *not* `request.size`: IIIF rounds a served tile up to whole pixels — the coarsest level is
  served 107 pixels high while covering 106.375 — so `ImagePaneTile.placement` carries the
  unrounded size, and using the served one would leave a 0.6% systematic stretch. This is why
  `maplibregl.addProtocol` is used rather than a plain URL template: it is the only point where
  the bytes can be placed. It is deliberately *not* ADR-0011's injection layer — the `fetch`
  inside it goes to the app's static assets, and ticket 06 replaces just that call.
- **`@allmaps/types` had to be installed explicitly.** `@allmaps/iiif-parser` re-exports
  `TileZoomLevel` and `ImageRequest` from it while declaring it only as a devDependency, so
  under `skipLibCheck` those types silently degrade to `any` — the opposite of what pinning
  these packages is for. Added to the catalog as an exact pin alongside the parser.

**Deviations, each deliberate:**

- **No `maxBounds` on the map.** MapLibre's `maxBounds` clamps how far out the view can go, and
  on a pyramid this small that makes the coarsest levels unreachable at any usable zoom — which
  would make "tiles at every `scaleFactor` load" untestable and untrue. The floor is `minZoom`
  at the coarsest level's own zoom instead. The cost is that the image can be panned out of
  view; "Fit whole map" is the remedy. Worth revisiting when the pane carries a real scan.
- **The pane lives at its own route, `/image-pane`, not on the editor's home page.** It shows a
  fixture, not the user's Historical Map, so it is a development surface; and tickets 02 and 04
  were editing the home page in parallel.
- **`playwright.config.ts`'s `testMatch` widened to `editor*.e2e.ts` / `viewer*.e2e.ts`**, so a
  slice with a lot of browser behaviour owns its own file rather than everything accumulating in
  `editor.e2e.ts`. Two-line change.
- **`packages/core`'s test reads `info.json` out of `apps/editor/static/`.** A cross-package
  file read in a test, done on purpose: it makes the bytes the unit tests reason about literally
  the bytes the browser fetches, where a second copy would drift.

**Findings that need someone's judgement, not mine:**

- **`maplibre-gl` 6.1.0 requests a worker file that Vite does not emit.** Every page load of the
  pane produces one 404 for `_app/immutable/nodes/maplibre-gl-worker.mjs`. MapLibre resolves it
  from `import.meta.url` at runtime, expecting the worker to sit beside the bundle, which is not
  how a bundled app is laid out. It is **harmless for this slice** — the image pane is a raster
  source, loaded on the main thread; every test passes and the pane renders correctly — but a
  vector source has no such luxury, so **ticket 04's base map will have to solve it**, probably
  via `setWorkerUrl` plus a Vite worker entry, or a `vite.config.ts` alias. Left alone here
  because it is not this ticket's problem to fix and `vite.config.ts` is a file ticket 04 owns.
- **The canvas padding step's *rendered output* is confirmed by eye, not numerically.** The
  contract it implements — `placement` equalling `region ÷ scaleFactor` — is asserted in
  `iiif-image-pane.test.ts`, and every coordinate claim in the browser tests is numeric. But a
  bug in the ten lines of `drawImage` in `tile-protocol.ts` would misplace the *raster* while
  leaving the reported coordinates correct, and no test here would notice. Screenshots were
  taken and the ragged edges align exactly with markers placed by the projection at the image
  corners, at both the coarsest level and full resolution. SPEC rules out pixel comparison as a
  verification strategy, so this is disclosed rather than papered over; if it should be covered,
  the seam would be a browser-mode unit test of the padding function.
- **`pnpm test:e2e` was verified on ports 4373/4374, not 4173/4174.** A parallel agent's preview
  server held 4173 in another worktree, and `reuseExistingServer` silently pointed the suite at
  *their* build. Only the two port constants differed; they are restored. Worth knowing that
  this failure mode looks exactly like a missing route.

### Review follow-ups, 2026-08-05

An independent review of this slice. Its central conclusion first, because it governs how the
rest should be read: **the projection math is correct.** The review re-derived it from scratch,
swept round-trip error across seven window sizes at 400 000 randomised points each, verified the
tile-grid anchor as an exact algebraic identity, and decoded the committed fixture JPEGs to check
the ragged-edge `drawImage` numerically. Everything below is a defect in a guard, a comment, or
a name — not in the arithmetic.

Fixed on this branch:

- **Two pyramid shapes rendered wrong and got through every guard.** Scale factors starting at
  2 satisfied the contiguity check and left the pane blank at its own full-resolution zoom with
  nothing logged. Two tilesets of different tile sizes — legal IIIF, flattened by
  `@allmaps/iiif-parser` into contiguous scale factors — put two levels at half scale, correct
  at the tile origin and progressively wrong away from it. Both now throw. Neither is reachable
  from this repo's own tiler; **both become reachable at ticket 14**, where the `info.json` is a
  stranger's.
- **The zoom-headroom paragraph named the wrong constraint**, and the guard it implied did not
  exist. MapLibre v5 does not validate the map's `maxZoom` at all; what it enforces is
  `MAX_TILE_ZOOM = 25`, past which the source requests no tiles and the console reports a tile
  coordinate out of bounds. Now stated correctly and refused with a diagnosis.
- **The round-trip tolerance is a scaling law, not a constant.** `windowSize * 2 ** -42`, exact.
  Headroom runs from 2 100× at this fixture to 1.05× at the largest window MapLibre can address,
  so the old "seventy-fold" figure was true only of the one window it was measured on.
  `createSyntheticProjection` now refuses any pyramid that would break the documented tolerance —
  1024-pixel tiles at scale factor 8192 would, and are legal IIIF.
- **The evidence was misattributed.** The two tests the ticket credits compute f⁻¹(f(x)) == x,
  which is self-consistent by construction; so, nearly, is the browser test billed as "the test
  the whole ticket is for". What actually anchors the projection is the tile-origin identity in
  `iiif-image-pane.test.ts`, the 512-pixel-world test, and the pointer-distance browser test.
  Comments moved onto those; the round-trip tests renamed to say what they establish.
- **Two comments asserted things that were false**: a 0.0014-pixel on-screen stretch that does
  not exist (rendered scale is exactly uniform — now asserted on equality), and four
  bit-identical MapLibre formulae of which only three are. Keeping the rearranged
  `latFromMercatorY` is correct and now says why.
- **Vocabulary.** `PaneMarker`, the `markers` prop, and the visible "Registration point…" text
  broke CONTEXT.md on two entries at once. Now `PaneOverlayPoint` / `overlayPoints` /
  `kind: 'reference' | 'reported'`. Renamed here rather than at **ticket 07**, which adds Control
  Points to this pane through exactly this interface.

**A forward contract for ticket 05, and the most important item here.**
`ImagePaneTile.placement` is `region / scaleFactor` — 106.375, not the served 107 — and the
review proved this is right by decoding all 29 committed tiles: every ragged tile sits at the
JPEG noise floor (~25 MSE) against IIIF's exact-resize semantics and 20–45× above it against
resize-and-pad. **The risk is entirely forward.** If ticket 05's tiler resizes by exactly
1 / scaleFactor and pads to whole pixels, or resizes to the rounded `size`, every ragged tile in
every real Historical Map is stretched by up to 0.6% at the right and bottom margins: sub-pixel,
systematic, in the margins, and invisible to every test in this slice, because the coordinates
would all still be right. The docstring now states that `placement` binds the writer as much as
the reader. **Ticket 05 must assert it, not inherit it.**

Recorded, not fixed:

- **`iiif-image-pane.test.ts` reads across the package boundary** into `apps/editor/static/`, so
  `pnpm --filter @ballastella/core test` is not runnable against a published `core` in isolation.
  Deliberate — it makes the bytes the unit tests reason about the bytes the browser fetches — and
  it stops being deliberate the day `core` is published or the fixture moves.
- **`apps/editor/static/fixtures/README.md` is the one set of bundled non-dependency bytes not
  linked from `THIRD-PARTY-NOTICES.md`.** That file's "Bundled base map content" pattern arrived
  with ticket 04, after this branch, and both files are outside this slice's paths. The fixture's
  provenance and rights *are* fully recorded beside the bytes; what is missing is the link from
  the notices file. **One line for whoever owns `THIRD-PARTY-NOTICES.md` next.**
- **`apps/editor/src/lib/base-map/pmtiles-protocol.ts` carries the same false claim** that
  `addProtocol` throws on a second registration. In maplibre-gl 5.24 it is a plain assignment
  into `config.REGISTERED_PROTOCOLS`. The idempotence guard there is harmless; its stated reason
  is wrong. Ticket 04's file, so left alone.
- **The `iiif-image-pane.test.ts` per-level round-trip logs a worst error of 0**, because every
  point in it is an integer or half-integer on a 2048-pixel window and `WINDOW_ORIGIN + t` comes
  out exact. Honest numbers are in `synthetic-projection.test.ts`'s window-size sweep, which
  samples off-grid deliberately. Noted in the test rather than changed, since its point set is
  chosen to cover tile geometry rather than float64.
- **The ragged-tile canvas padding is still not asserted numerically.** The edge-clamp added
  here removes a one-screen-pixel dark fringe caused by linear filtering against transparent
  black, and it cannot move any coordinate — `placement` is untouched — but neither it nor the
  original `drawImage` has a test. The seam would be a browser-mode unit test of the padding
  function; the previous entry above still stands.
