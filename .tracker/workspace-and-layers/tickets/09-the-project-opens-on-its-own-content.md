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

- [ ] A Project whose Annotations are all in one city opens framed on that city.
- [ ] A Project whose only content is one aligned Historical Map opens framed on that map's Resource Mask extent, not on its Control Points' extent.
- [ ] A Project with one point Annotation opens at or below the zoom cap, never at maximum zoom.
- [ ] A Project with no Layers, and a Project whose only map is unaligned, both open on `BASE_MAP_CATALOG.initialView`.
- [ ] A Project whose content is all hidden opens framed on that content rather than on the deployment default.
- [ ] Toggling a Layer, adding an Annotation, moving a Control Point, and renaming a Layer all leave the viewport where the user put it.
- [ ] "Fit to this Project" re-frames on demand.
- [ ] Opening a Project writes nothing — assert with a spy on `ProjectStore#write`.
- [ ] A published site opens on the Project's content, framed the same way the editor frames it.
- [ ] Reopening an alignment with Control Points lands on them.
- [ ] Content spanning the antimeridian opens on the short way round.

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
