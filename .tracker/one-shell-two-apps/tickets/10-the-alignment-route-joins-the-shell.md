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

- [x] The two panes have equal width at 1120 px and at 1440 px, measured from the rendered boxes.
      Measured 344/344 at 1120 px and 504/504 at 1440 px.
- [x] The Control Point column is opaque, docked, and overlaps neither pane at any width.
- [x] Each Control Point row shows the same ordinal as its marker on both panes.
- [x] Selecting a point highlights both halves and its row, as ADR-0022 contract 4 requires.
      Unchanged and still asserted by `editor-alignment.e2e.ts`'s "selecting either half…".
- [x] Aligning a map produces an `alignments/<image-id>.json` byte-identical to the one the same
      actions produced before this ticket. Nothing on the write path was touched.
- [x] The route fills the shared bar's page-chrome slot with the same heading and way back as before.
- [x] `/align` appears nowhere in the viewer's build.
      Asserted by `e2e/viewer.e2e.ts`'s "…no alignment route": six marker strings from the alignment
      and publishing code, each proved present in the editor's own chunks, and no `align*` page in
      the viewer's build root. Not a grep — see below for why one cannot work here.

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
pnpm test:e2e viewer.e2e.ts -g "no alignment route"
```

Success: everything exits 0 and no alignment module is found in the viewer's build. The alignment
fixtures' round-trip tests in `packages/core` are what prove no file gained a byte.

**Mutation check:** make the panes unequal by restoring an auto flex basis and show the width
assertion goes red; write an ordinal into an Alignment's JSON and show the round-trip test goes red.

## What the code already did

Three of this ticket's contracts were already met when it was picked up, and are now **asserted**
rather than assumed — which is the whole of what changed for them:

- **The bar.** Ticket 03 already had `align/+page.svelte` fill the page-chrome slot, and the save
  indicator and undo are in `NavigationBar`'s `end` snippet on every screen. No words changed.
- **`lg:flex-1` on both panes**, so the widths were already equal. The ticket's own warning is why
  that could not be left unasserted: `grow` and `flex-1` read the same and differ only in their flex
  basis. Restoring the auto basis makes the panes differ by 379 px, and the new measurement goes red.
- **The ordinal was on the row already, as the words "Point 3" inside the select button.** What it
  was not was a *mark*: no element of its own, no tabular figures, nothing a test could compare
  against what the two panes draw. It is now a `<span data-testid="control-point-row-ordinal">` at
  `tabular-nums`, the sibling of `AnnotationRow`'s. The button's text and accessible name are
  unchanged, so ADR-0022's list is exactly as it was.

`ControlPoint.ordinal` is read as it stands. It is derived from position in `core` already —
`collectControlPoints` for the pairs being made and `toControlPoint` for the pairs read from a file —
and carries ADR-0002's argument on its own doc comment. A `controlPointOrdinal(index)` mirroring
`annotationOrdinal` would have been a third spelling of `index + 1` guaranteeing nothing new: the
row and the two markers cannot disagree, because they are not three derivations but three renders of
**one array**. `AlignmentWorkspace`'s sheet half, earth half and row all read `point.ordinal` off the
same `controlPoints`, so divergence is structurally impossible and a shared helper would guarantee
nothing that is not already guaranteed. (Both `core` derivations do apply the same rule — output
index + 1, which is `annotationOrdinal`'s — over different inputs.)

**The acceptance block's viewer check was replaced.** It read
`grep -rl "AlignmentWorkspace\|align" apps/viewer/build/_app/*.js | head || echo "clean"`, and that
command could not work: the viewer's chunks are under `apps/viewer/build/_app/immutable/`, so the
glob matched no file at all, and `head` swallows `grep`'s exit code so the pipeline reported success
on nothing. Repairing the path does not save it either — `align` is a substring of MapLibre's
`text-rotation-alignment`, `icon-pitch-alignment`, `align-items` and `alignedProjMatrix`, so a
working grep matches four chunks in every build for ever. The SPEC's *Testing Decisions* rules out a
grep over built JavaScript as a check any ticket may be asked to pass; `e2e/viewer.e2e.ts` is where
the claim actually lives.

## Blocked by

- 03 — one bar shell, and the viewer gets a navigation bar
- 08 — Annotations are numbered, on the map and on the row
