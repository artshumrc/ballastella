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

- [ ] The fixture pyramid renders in a MapLibre map and is pannable and zoomable to full resolution
- [ ] Tiles at every `scaleFactor` in the fixture load, including ragged edge tiles at the right and bottom margins
- [ ] `resourceToSynthetic` → `syntheticToResource` round-trips within the documented tolerance for a set of points including all four corners, the centre, and points on the ragged edges
- [ ] The round-trip assertion runs at **every** zoom level the fixture offers, not just one
- [ ] Clicking reports an image pixel coordinate that matches the visually indicated feature within the documented tolerance
- [ ] A point placed at maximum zoom, after zooming fully out and back in, reports the same pixel coordinate within tolerance
- [ ] Tile URLs are built via `getTileImageRequest`, not by string arithmetic in this slice's own code
- [ ] The chosen synthetic window and its justification are recorded in a comment

```bash
pnpm --filter @ballastella/core test          # round-trip assertions
pnpm test:e2e                          # render, pan/zoom, click-to-coordinate, zoom-stability
pnpm -r build && pnpm lint && pnpm check
```

Success: all exit 0. **The round-trip assertions must be numeric.** A screenshot or a visual check does not satisfy this ticket — silent drift is exactly what visual inspection misses, and SPEC's Testing Decisions rules out pixel comparison as a verification strategy.

## Blocked by

- Ticket 01
