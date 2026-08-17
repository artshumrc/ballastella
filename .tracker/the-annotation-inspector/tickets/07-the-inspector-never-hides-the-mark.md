# 07 — The Inspector never hides the mark it describes

## What to build

The Inspector docks over the map's top-right. So a mark in that quadrant ends up **behind the panel that
describes it**, and the dashed leader's end goes with it — the leader is `z-index: 5` and the Inspector
has to be above MapLibre's controls at 6. Nothing throws; the one thing the leader exists to show is
simply invisible in the case a scholar most needs it.

Give the Inspector its spatial guarantees:

- Selecting an Annotation reserves the Inspector's footprint in the **camera's padding**, so the selected
  mark is always inside the un-occluded region.
- The Inspector's height is capped so it can never grow over the Base Map's attribution, and a long
  description scrolls **inside** it.
- The leader is drawn under the panel rather than across it, and never over a control.

These are the claims that need a real viewport and a real MapLibre, which is why they are their own
ticket rather than part of the switch.

## Where to start

- `apps/editor/src/lib/base-map/BaseMapPane.svelte` — the MapLibre instance and its `relative h-full
  w-full` wrapper. `onCameraMove` is already exposed for the leader to watch; find how, because the
  padding change must not fight it.
- `apps/editor/src/lib/project/ProjectScreen.svelte` — `<LeaderLine mark={selectedMark} row={selectedRow}
  canvas={() => mapColumn} sidebar={() => layerSidebar} watch={...} />`, and `selectedMark`. This is
  where a selection becomes a camera instruction.
- `packages/ui/src/leader-line.ts` — `leaderPath` and its three points: the row's near edge, a 12 px stub
  straight out of the column, then the mark shortened by its own radius plus a clearance. Read it, and
  read `stacked()`: the function refuses entirely when the sidebar and canvas overlap horizontally.
  **You should not need to change this file.**
- `packages/ui/src/leader-line.test.ts` — the pure-function seam. Already owns the geometry and the
  stacked refusal.
- `packages/ui/src/layout.css` — `.leader-line` at `z-index: 5`, `.leader-line-path`'s dash and its
  `base-100` drop-shadow, and the rule forcing MapLibre's four control corners to `6`. The comment there
  records the measurement that made the rule necessary: `elementFromPoint` over the middle of the zoom
  button returned the leader, and "an Annotation in the top-right quadrant of a map pane had its dashed
  line drawn across the `+`, the `−` and the compass on all three screens." **That is the same quadrant
  this ticket is about.**
- MapLibre's `easeTo`/`flyTo` accept a `padding` object. The attribution sits at `bottom-right`; ticket 04
  moved zoom to `bottom-left`.
- `e2e/support/annotations.ts` — `StackMap` already exposes `project(lngLat)`, `getCenter`, `setCenter`,
  `setZoom`, `isMoving` and `once`. That is how a browser test asks where a place on the earth landed in
  the pane, and it is how you assert a mark is clear of the panel.

## Contract

- **Selecting an Annotation reserves the Inspector's footprint in the camera's padding**, so the mark is
  inside the un-occluded region. This is the replacement for the sidebar auto-scrolling that ticket 08
  deletes, and it must be driven by the same gesture that opens the panel.
- **It must not fight the user.** A mark already comfortably in view must not provoke a camera move — the
  same restraint `keepInView` observed, and for the same reason: moving the map under a pointer that
  asked for nothing of the sort. Move only when the mark is actually occluded or off-pane.
- **Nothing is focused by this.** Whatever holds the keyboard keeps it. The camera moves and nothing else,
  which is what lets this run for a selection made on the canvas without stealing the pointer's place.
- **The Inspector's `max-height` leaves the attribution clear**, and its body scrolls inside rather than
  the panel growing past it. The attribution is a licence requirement, not decoration, and it may never be
  covered.
- **The leader keeps running mark → row and is drawn under the Inspector.** Do not draw a second leader to
  the Inspector: one Annotation, one line — and `leaderPath` would refuse it anyway, because the Inspector
  sits inside the canvas box and the function requires the two boxes not to overlap.
- **`leaderPath` is not modified.** If you find yourself editing it, stop: the geometry is right and the
  problem is a z-index or a padding.
- The leader still takes no pointer events, stays `aria-hidden`, and carries no information of its own.

## User Stories

- **5.** As an author, I want the dashed leader to keep running from the mark on the canvas to its row, so
  that the thing I already found legible is not taken away.
- **9.** As an author, I want room enough to read a paragraph of prose, so that a description is not a
  four-line window inside a four-deep stack of boxes.
- **17.** As an author, I want the map visible below and beside the panel, so that it is still the map
  there rather than a backdrop.
- **19.** As an author, I want the selected mark to stay out from under the panel, so that the leader ends
  somewhere I can see.
- **21.** As an author, I want a long description to scroll inside the panel, so that the panel cannot grow
  over the attribution the Base Map's licence requires.
- **22.** As an author, I want the leader drawn under the panel rather than across it, so that a
  decoration never crosses a control.
- **73.** As a contributor, I want layout and camera claims kept in a real browser, so that "the map is
  visible below it" is never asserted where there is no viewport.

Story 73 is delivered by *where* this ticket's tests live: every claim above is asserted at Seam 2 against
a real MapLibre in a real viewport, and none of them is attempted at the component seam, which has no
layout at all.

## Out of scope

- **Modifying `leaderPath` or `leader-line.test.ts`.** The function is correct.
- **The phone layout**, where `leaderPath` refuses the leader entirely. Ticket 09.
- **The viewer.** Ticket 08 wires the Inspector there; whether the reader pane needs the same padding is
  that ticket's to answer, and it should follow this ticket's mechanism rather than inventing a second one.
- **Making the panel draggable, resizable, or collision-aware in any general sense.** It docks in one
  corner; the camera moves to suit it. Do not build a placement engine.
- **Flipping the Inspector to the other corner** when a mark is behind it. That is a second layout with its
  own bugs, and padding is the cheaper, more predictable answer.
- **Animating the camera differently per gesture**, or adding a preference for it. Respect
  `prefers-reduced-motion` as the app already does and move on.
- Changing what the leader looks like: the dash pattern, the stub length, the clearance, the drop-shadow.

## Acceptance criteria

- [ ] In a real browser, with an Annotation whose mark would fall behind the Inspector: after selecting it,
      the mark's projected position is outside the Inspector's bounding box, and the leader's end is
      visible.
- [ ] Selecting an Annotation whose mark is already comfortably in view and unoccluded causes **no camera
      move** — assert via `getCenter` before and after, or `isMoving`.
- [ ] Selecting an Annotation does not move focus: `document.activeElement` is unchanged by the camera.
- [ ] An Annotation with a long description gives the Inspector a scrolling body, and the Inspector's
      bottom edge stays above the attribution element.
- [ ] The map is visible below the Inspector: a mark placed in the Inspector's column but below its bottom
      edge is hit-testable on the canvas.
- [ ] `elementFromPoint` over the middle of the Inspector returns the Inspector, not the leader — the same
      probe `layout.css` records for the zoom button.
- [ ] `elementFromPoint` over the zoom control still returns the control, not the leader. The existing
      guarantee must not have regressed.
- [ ] `git diff --stat` shows no change to `packages/ui/src/leader-line.ts`.
- [ ] `pnpm precommit` passes in full.

```bash
cd /home/dflood/repos/ballastella
git diff --stat -- packages/ui/src/leader-line.ts
pnpm --filter @ballastella/ui exec vitest run leader-line
pnpm test:e2e editor-annotations.e2e.ts
pnpm precommit
```

Success: `git diff --stat` reports nothing for `leader-line.ts`, its pure-function tests are still green
untouched, `editor-annotations.e2e.ts` exits 0 with the new spatial assertions, and `pnpm precommit`
exits 0.

## Blocked by

- 06
