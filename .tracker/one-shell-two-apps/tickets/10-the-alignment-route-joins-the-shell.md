# The alignment route joins the shell

## Parent

[SPEC.md](../SPEC.md)

## What to build

Bring `/align` into the same shell as everything else: the shared bar carrying where you are and the
way back, two panes of exactly equal width, a solid docked Control Point column, and an ordinal on
each Control Point's **row** matching the one already drawn inside its marker on both panes.

The route stays editor-only. Nothing about it may reach the viewer's bundle.

## Where to start

- `apps/editor/src/routes/align/+page.svelte` — the route, and where it fills the page-chrome slot.
- `apps/editor/src/lib/alignment/AlignmentWorkspace.svelte` — the layout. The two panes are
  `lg:flex-1` inside `lg:flex-row`, and the Control Point column is `lg:w-96` with `lg:border-l`.
  Read how the panes size before changing anything: on this repo's own mockups, `grow` with an auto
  basis produced panes of 308 px and 378 px, and `flex-1` — `flex: 1 1 0%` — is what makes them
  equal.
- `apps/editor/src/routes/layout.css` — `.pane-overlay-point-control-point` already draws the ordinal
  inside the marker as text, at `font-variant-numeric: tabular-nums`. The row's ordinal must read as
  its sibling.
- `apps/editor/src/lib/alignment/pairing.svelte.ts` — the pairing state and the selected point.
- `e2e/editor-align-route.e2e.ts`, `editor-alignment.e2e.ts`,
  `editor-alignment-refinement.e2e.ts`, `editor-align-referenced.e2e.ts`.

## Contract

**The two panes are exactly equal in width** at every width above the stacking breakpoint. Neither
the sheet nor the earth is privileged by the layout, and a pane that is wider because its label is
longer is a bug, not a preference.

**The Control Point column is solid and docked.** Nothing translucent, nothing floating, and nothing
overlapping either pane. A scholar is clicking to sub-pixel accuracy, and this is the one screen in
the application where that rule is absolute.

**Each Control Point row carries the ordinal its marker already carries.** The number is the point's
position in the Alignment's list, and it is **display state**: no Alignment file gains a byte from
this. The existing round-trip fixtures must stay byte-identical.

**The bar is the shared one.** `/align` fills the page-chrome slot with what it is doing and the way
back to the Project, exactly as it does now — this ticket changes the container, not the words. The
save indicator and undo are on it because they are on every screen.

**Escape, arrow-key nudging, focus rings and the pending-half affordance are untouched.** ADR-0022's
contracts are not in scope and must not regress.

**`/align` must remain absent from the viewer's build.** Assert it rather than assume it.

### User Stories

44, 47, 48, 49, 50, 51

## Out of scope

- **Do not draw the leader line.** Ticket 12 covers it on both screens at once.
- **Do not change the pairing gesture, the transformation picker, the distortion controls, or the
  fold warning.**
- **Do not restyle the markers themselves** beyond what equal panes require.
- **Do not move `AlignmentWorkspace` into `packages/ui`.** It is editor-only and always will be;
  moving it would put an alignment tool into every Published Site's reachable graph.
- **Do not touch the image pane's projection or tile handling.** ADR-0011 and ADR-0004 territory,
  and the failure mode is a plausible pane of the wrong map.

## Acceptance criteria

- [ ] The two panes have equal width at 1120 px and at 1440 px, measured from the rendered boxes.
- [ ] The Control Point column is opaque, docked, and overlaps neither pane at any width.
- [ ] Each Control Point row shows the same ordinal as its marker on both panes.
- [ ] Selecting a point highlights both halves and its row, as ADR-0022 contract 4 requires.
- [ ] Aligning a map produces an `alignments/<image-id>.json` byte-identical to the one the same
      actions produced before this ticket.
- [ ] The route fills the shared bar's page-chrome slot with the same heading and way back as before.
- [ ] `/align` appears nowhere in the viewer's build.

```bash
pnpm lint
pnpm check
pnpm test
pnpm --filter @ballastella/core test

pnpm test:e2e editor-align-route
pnpm test:e2e editor-alignment
pnpm test:e2e editor-alignment-refinement
pnpm test:e2e editor-align-referenced

pnpm -r build
grep -rl "AlignmentWorkspace\|align" apps/viewer/build/_app/*.js | head || echo "clean"
```

Success: everything exits 0 and no alignment module is found in the viewer's build. The alignment
fixtures' round-trip tests in `packages/core` are what prove no file gained a byte.

**Mutation check:** make the panes unequal by restoring an auto flex basis and show the width
assertion goes red; write an ordinal into an Alignment's JSON and show the round-trip test goes red.

## Blocked by

- 03 — one bar shell, and the viewer gets a navigation bar
- 08 — Annotations are numbered, on the map and on the row
