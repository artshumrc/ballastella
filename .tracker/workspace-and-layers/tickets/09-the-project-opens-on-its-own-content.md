# The Project opens on its own content

## What to build

Opening a Project frames the map on what that Project has actually placed on the earth — its Annotations and its aligned Historical Maps — instead of on central Amsterdam at zoom 13.

Demonstrable end to end: a Project whose only work is in Boston opens on Boston. A Project with one pin opens at a sensible neighbourhood zoom, not on four roof tiles. A brand-new Project opens on the deployment's default. A published site opens the same way the editor does.

Read [ADR-0026](../../../docs/adr/0026-the-opening-view-is-computed-from-the-projects-content.md) first, including its note on why nothing is stored.

## Where to start

- `packages/core/src/base-map/catalog.ts` — `BASE_MAP_CATALOG.initialView`, currently `{ center: [4.9041, 52.3676], zoom: 13 }`. It survives as the fallback only. Note the comment tying it to the bundled extract's bounds; ticket 10 removes that archive.
- `packages/core/src/alignment/distortion.ts` — already imports and uses `GcpTransformer` from `@allmaps/transform`, which is a direct dependency of core. This is the machinery for transforming a Resource Mask ring into geography; read how `distortion.ts` builds its transformer.
- `packages/core/src/alignment/alignment.ts` — the `Alignment` shape: Control Points, Resource Mask, transformation type.
- `apps/editor/src/lib/base-map/BaseMapPane.svelte` around lines 237–238 — where `center` and `zoom` are read from the catalog at map construction.
- `apps/viewer/src/lib/ReaderMapPane.svelte` — the viewer's equivalent. **This is the half most likely to be forgotten**, and ticket 17 of v1 is merged, so nothing will remind you.
- `packages/core/src/image-pane/synthetic-projection.test.ts` — prior art for asserting geometry numerically rather than visually.

## Contract

**One pure function in `@ballastella/core`,** used by the editor and by the published viewer. No renderer involved, no async race, testable in Node. It takes the Project's Layers plus their Alignments and Annotation collections, and returns bounds or nothing.

An aligned Historical Map's extent comes from **transforming its Resource Mask ring** through `GcpTransformer` — not from its Control Points' extent, which understates the sheet, and not from the renderer, which would mean fitting after an async render.

**The fallback chain, in order:** visible Layers with an extent → all Layers with an extent → `BASE_MAP_CATALOG.initialView`. So a brand-new Project opens somewhere deliberate rather than at 0°, 0°, and a Project whose work is all hidden still opens on it.

**An unaligned Historical Map contributes nothing.** It has no place on the earth. A Project of only unaligned maps falls through to the deployment default.

**Fit once, on open. Never again.** Refitting when a Layer is toggled, an Annotation is added, or an Alignment changes would pull the map out from under someone mid-edit. This is the single most likely thing to get wrong, because a reactive derived value recomputing bounds will feel natural and will produce exactly that bug.

**An explicit "Fit to this Project" control** covers everything the automatic fit deliberately does not.

**Zoom is capped and the box is padded.** A Project with a single pin has zero-area bounds, and fitting to that goes to maximum zoom. Cap around z16.

**Nothing is written.** Not to `project.json`, not to `localStorage`. Opening a Project must not modify a byte (ADR-0010).

**The alignment view adopts the same function**, fitting to the Alignment's Control Points when it has any and to the Project's content otherwise — so reopening a half-finished Alignment lands where the work was left.

**Bounds that cross the antimeridian must not produce a box the long way round the world.** Two maps, one in Japan and one in California, must not open on the whole Pacific. Decide the behaviour, write it down, and test it.

## Out of scope

- **Do not store an author-chosen opening view.** ADR-0026 records the argument for it — including that ADR-0020's reasoning for storing the Base Map default applies here too — and declines it for now. Adding a field is not a small extra.
- **Do not delete `BASE_MAP_CATALOG.initialView`.** It is the fallback.
- **Do not remove the bundled Base Map archive.** Ticket 10, deliberately after this one: removing it first means every Project opens on Amsterdam with no tiles, which is a blank map.
- **Do not fit the image pane.** It has its own fit controls and its own projection.
- **Do not animate the fit.** Land there.
- **Do not recompute on any reactive dependency.** If bounds appear in a `$derived`, the once-only contract is already broken.

## Acceptance criteria

- [x] A Project whose Annotations are all in one city opens framed on that city.
- [x] A Project whose only content is one aligned Historical Map opens framed on that map's Resource Mask extent, not on its Control Points' extent.
- [x] A Project with one point Annotation opens at or below the zoom cap, never at maximum zoom.
- [x] A Project with no Layers, and a Project whose only map is unaligned, both open on `BASE_MAP_CATALOG.initialView`.
- [x] A Project whose content is all hidden opens framed on that content rather than on the deployment default.
- [x] Toggling a Layer, adding an Annotation, moving a Control Point, and renaming a Layer all leave the viewport where the user put it.
- [x] "Fit to this Project" re-frames on demand.
- [x] Opening a Project writes nothing — assert with a spy on `ProjectStore#write`.
- [x] A published site opens on the Project's content, framed the same way the editor frames it.
- [x] Reopening an alignment with Control Points lands on them.
- [x] Content spanning the antimeridian opens on the short way round.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
pnpm exec playwright test e2e/editor-base-map.e2e.ts e2e/viewer-reader.e2e.ts
pnpm test:e2e
```

All green.

The bounds function is a **pure function tested numerically in Node** — fixtures for each fallback case, the zero-area case, the antimeridian case, and the Resource-Mask-versus-Control-Points distinction. Assert coordinates, not screenshots: this is the same discipline the synthetic projection round-trip uses, and for the same reason — the failure mode is a plausible wrong answer.

The "fit once" criteria are the ones that will pass vacuously if asserted by reading a variable. Assert the **map's actual centre and zoom** before and after each mutation, through the existing `window.ballastellaBaseMap` handle.

## Blocked by

- Ticket 01

## Notes from the implementation

- **`canSolve` and the `try`/`catch` in `alignedSheetRing` are two guards over one criterion, and each
  alone passes the tests.** Removing either singly leaves "an unaligned Historical Map contributes
  nothing" green — upstream throws on too few Control Points, and `canSolve` refuses them before it
  gets the chance. Removing both together reddens it. Both are kept: the guard states this project's
  own gate rather than depending on an upstream error, and the `catch` is now driven directly by a
  `thinPlateSpline` Alignment whose Control Points share a pixel (`LU matrix is singular`).
- **A degenerate solve does not always throw.** Three collinear Control Points mapped to one place
  return latitudes of −207° and 442° for the sheet's corners. Dropping only the impossible corners
  would leave a box built from whichever survived, so the whole sheet is declined instead.
- **`/base-map/?p=…` is deliberately not fitted.** That route draws no Layer stack, so framing it on
  content it does not show would be misleading; the Project screen `/layers?p=…` is what a scholar
  opens from the hub. Ticket 04 folds the two together and is where the question is properly settled.
- **`playwright.config.ts` pinned ports 4173/4174 with `reuseExistingServer`.** With sibling worktrees
  running on one machine a suite silently tested another worktree's build, or failed with
  `ERR_CONNECTION_REFUSED` when that run ended. The e2e numbers first recorded for this ticket were
  taken with the ports temporarily moved to 4373/4374. **Fixed on `main` since**: the ports are derived
  from the checkout path, so every worktree gets its own pair.

## Notes from the review remediation

- **The longitude rule read vertices and never edges, and that is a wrong box rather than a rough
  one.** A Polygon Annotation with corners at ±179 is the whole world — GeoJSON has content that
  crosses the antimeridian *cut* at it (RFC 7946 §3.1.9), so an uncut edge runs the long way, and that
  is where MapLibre draws it. The old rule saw four vertices, found a 183.9° "empty" gap that the
  polygon's own bottom edge runs straight through, and returned `west: 4.888, east: 181` for
  `e2e/editor-layers.e2e.ts`'s Project — the whole western hemisphere left out. The rule now sweeps
  **arcs**: a segment contributes the arc between its endpoints as written, a Point contributes a
  degenerate one, and two separate Annotations are never joined. Same box, to the digit, for every
  point-only case that was already right.
- **`pnpm test:e2e` was red for a second, independent reason, and fixing the box alone did not clear
  it.** `renderedAtCentre` queried `queryRenderedFeatures` immediately after `warpedTiles` had jumped
  the camera onto the sheet; while a map is still repainting that call answers `[]` for *every* layer,
  base map included. Before ADR-0026 the jump was two zoom levels from the deployment default and
  usually landed on tiles already in hand; now it is a jump back from wherever the Project's content
  put the map, so the race started losing. The helper waits for `map.loaded()` first. Verified both
  ways: with the settle-wait in place and the vertex-only rule restored, the two tests pass — so the
  e2e is *not* the proof of the box fix, and `packages/core/src/project/opening-view.test.ts` is.
- **The degenerate-solve guard bounded latitude only, and the two collinear axes fail differently.**
  Measured on a 1000 × 800 sheet: horizontally collinear Control Points give latitudes 48 → 198.5,
  which the latitude bound caught; vertically collinear ones give
  `[[-64, 56], [-564, 56], [-563.2, 56.4], [-63.2, 56.4]]` — latitudes 56 to 56.4, perfectly ordinary,
  and longitudes spanning 500.8°. `projectOpeningBounds` returned `{west: 156, east: 296.8, south: 56,
  north: 56.4}` and a Boston Project opened on the Bering Strait. Longitude is now bounded too, at a
  revolution either side of the prime meridian and a revolution of span. The sheet alone is declined
  and the Project keeps everything else, which is what makes the guard worth having: a sheet that is
  *kept* drags the union and no Annotation can pull the box back.
- **The "passed as a polygon so the mask's edges bend" comment described a protection that was not
  configured.** `transformToGeo`'s `maxDepth` defaults to `0`, so the call returned exactly the four
  corners transformed one at a time. Configured at `{ maxDepth: 2, minOffsetRatio: 0 }`. Measured on a
  five-point `thinPlateSpline`: the four-corner box is `east: -70.9696766, north: 42.4153825` and the
  refined one is `east: -70.9672005, north: 42.4186507` — 0.0025° and 0.0033°, a couple of hundred
  metres of the sheet's own edge that the unrefined box cut off. A third level moves it a further
  0.0006° (46 m), below the resolution of anything this decides. `minOffsetRatio: 0` means a segment
  splits only where the warp actually bends it, so an affine Alignment's four-corner mask stays
  four-cornered and pays nothing.
- **ADR-0026's tie sentence was factually inverted.** "Exactly antipodal content resolves eastward"
  reads as the opposite of what the code does: the wrap gap winning leaves the box on the arc that
  does **not** cross ±180. Verified against the shipped rule and now asserted:
  `[0°, 180°] → {west: -180, east: 0}`, `[-90°, 90°] → {west: -90, east: 90}`,
  `[45°, -135°] → {west: -135, east: 45}`.
- **The editor and the Published Site disagreed about what counts as placeable content.** The viewer
  contributed a Layer only at `status: 'ready'`, which is a claim about *drawing*; the editor reads the
  Alignment and nothing else. So a Layer with a good Alignment and a bad image record placed the sheet
  in the editor and nowhere at all on the Published Site. The viewer now reads the Alignment
  independently of the image probe and carries it on the `unreadable` case too.
- **Four copies of the framing across two apps are now one.** `OpeningViewOutcome`,
  `projectOpeningFit`, `alignmentOpeningFit`, `applyOpeningFit`, and `openingViewSentence` are core's;
  both map panes' fit effects are three lines over the same function, and both live regions say the
  same sentence because there is one.
