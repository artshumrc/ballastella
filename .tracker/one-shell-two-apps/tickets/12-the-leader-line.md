# The leader line

## Parent

[SPEC.md](../SPEC.md)

## What to build

Draw one dashed leader from the selected mark on the canvas to its row in the sidebar, across the
boundary between them — for an Annotation on the Project screen in both apps, and for a Control Point
on the alignment route.

⚠ **This is the most expensive single feature in the epic and it is deliberately last.** The ordinal
and the open row already carry the meaning; the leader makes it immediate. If it proves unstable,
saying so and stopping is an acceptable outcome — nothing else in the epic depends on it.

## Where to start

- The shared Layer card and Annotation list in `packages/ui`, as tickets 04–08 left them, and the
  ordinals ticket 08 established. Both ends of the line already share an identity.
- `apps/editor/src/lib/project/ProjectScreen.svelte` and `apps/viewer/src/routes/+page.svelte` — the
  element that contains both the sidebar and the canvas. The leader layer is a child of that
  container, not of either column.
- `apps/editor/src/lib/base-map/BaseMapPane.svelte` — how the map instance is exposed. The leader
  needs the projected screen point of a coordinate, which is MapLibre's `project()`.
- `apps/editor/src/lib/alignment/AlignmentWorkspace.svelte` — the same problem with two panes.
- `apps/editor/src/routes/layout.css` — the overlay-point rules, for how this repository already
  positions things over a map.

## Contract

**One absolutely-positioned SVG spanning the sidebar and the canvas together**, above both,
`aria-hidden="true"`, `pointer-events: none`. It draws a single polyline from the selected mark to
the vertical centre of its row's right edge.

**Recomputed on:** map `move` and `zoom`, sidebar scroll, the row's expand/collapse transition,
window resize, and any change to which Layers are shown. Use the map's own events rather than a
timer.

**Not drawn at all when:**

- nothing is selected;
- either end is outside its own container's box;
- the layout has stacked the sidebar under the canvas — below that breakpoint the row simply being
  open and highlighted is the signal, and a line drawn across a stacked layout is a lie.

**It carries no information of its own.** The ordinal and `aria-expanded` are what tell a
screen-reader user which Annotation is active, and they were built in tickets 08 and 01 precisely so
that this layer can be decorative. Nothing may become unclear if the leader is never drawn.

⚠ **The leader must not make the map thrash.** `editor-annotations.e2e.ts` already asserts that
typing does not rebuild the Layer stack and that recolouring does not either. Recomputing a line on
every map frame must not re-render the stack, re-read a document, or write anything. Add an assertion
that selecting an Annotation costs zero store reads and zero writes.

**Reduced motion.** The line is not motion and is not suppressed by it. If you animate its
appearance, that animation respects `prefersReducedMotion` like everything else here.

**Verify it against the projection, not against itself.** This repository has a recorded incident
where a marker's handle was drawn 334 px from the coordinate it named and a whole browser suite
missed it, because every test took the element's own bounding box and dragged that. Assert the
leader's canvas end against `map.project()` of the coordinate on disk, the way
`editor-annotations.e2e.ts` learned to.

### User Stories

39, 40, 41, 42, 45, 46

## Out of scope

- **Do not change the ordinals, the row disclosure, or any sentence.**
- **Do not draw more than one leader.** Exactly one thing is selected at a time.
- **Do not draw leaders between the two panes on `/align`** for unselected pairs; the pairing
  highlight (ADR-0022 contract 4) already does that job and adding lines for eleven pairs is noise.
- **Do not make the leader focusable, hoverable or clickable.**
- **Do not introduce a rendering library.**

## Acceptance criteria

- [ ] Selecting an Annotation draws exactly one leader from its mark to its row, in both apps.
- [ ] The leader's canvas end sits within a small tolerance of `map.project()` of the Annotation's
      coordinate as stored on disk, asserted against the file rather than against the element.
- [ ] Panning and zooming move the leader with the map; it never lags a frame behind at rest.
- [ ] Scrolling the sidebar so the row leaves its container removes the leader.
- [ ] Below the stacking breakpoint no leader is drawn, and the open row is highlighted instead.
- [ ] Selecting a Control Point draws one leader to its row on the alignment route.
- [ ] Selecting an Annotation costs zero store reads and zero store writes.
- [ ] Typing in an Annotation's description still does not rebuild the Layer stack.
- [ ] The leader layer is `aria-hidden` and not in the tab order.

```bash
pnpm lint
pnpm check
pnpm test
pnpm --filter @ballastella/ui test

pnpm test:e2e editor-annotations
pnpm test:e2e editor-alignment-refinement
pnpm test:e2e viewer-reader
pnpm test:e2e editor-project-screen

node scripts/check-seam-2-size.mjs
```

Success: everything exits 0, including the Seam 2 ceiling — if this ticket's new browser tests push
the count over, retire something or argue for a new ceiling in `check-seam-2-size.mjs`'s own ledger.
Do not raise it silently.

**Mutation check:** offset the projection by a constant and show the position assertion goes red. An
assertion that reads the element's own box and compares it to itself is the exact shape of the defect
this repository has already been bitten by.

## Blocked by

- 08 — Annotations are numbered, on the map and on the row
- 10 — the alignment route joins the shell
