# 09 — Both apps stack on a phone

## What to build

A panel docked to a corner has no corner to dock to on a phone, so it becomes a sheet over the map. Both
apps, with the same subtraction: the editor's sheet has the tab strip and its actions, the Reader's has
neither.

**The two apps are not equidistant from this.** The viewer already collapses to a single column below
`lg`, and `LeaderLine` already measures for it. The editor's Project screen has **no breakpoint at all** —
its sidebar is `w-96 shrink-0` — so at 390 px the sidebar takes the window and the map gets nothing. The
editor's half is new work; the viewer's is a change to a layout that is already responsive.

## Where to start

- `apps/viewer/src/routes/+page.svelte` — find the note recording that below `lg` the grid is one column
  and the map sits under the stack, and that `LeaderLine` measures that. **That breakpoint is the one the
  editor adopts**, so read it before choosing anything.
- `apps/editor/src/lib/project/ProjectScreen.svelte` — the `relative flex min-h-0 grow` container, the
  `w-96 shrink-0 overflow-y-auto border-r bg-base-300 p-4` sidebar, and the `min-h-0 grow overflow-hidden`
  map column bound as `mapColumn`. Read the long comment above the sidebar: it records why the column is a
  fixed width rather than proportional, and why it is `base-300` with `base-100` cards — measured
  luminance steps in both themes. **Stacking must not undo that reasoning**, only its axis.
- `packages/ui/src/leader-line.ts` — `stacked()`: `sidebar.left < canvas.right && canvas.left <
  sidebar.right`. When the columns overlap horizontally, `leaderPath` returns `null` and no leader is
  drawn. Its comment states why: "a line drawn across a stacked layout is a lie whichever stylesheet
  stacked it." **This is already correct and needs no change** — the editor stacking is what finally
  exercises the branch there.
- `packages/ui/src/leader-line.test.ts` — the pure-function seam already owns the stacked refusal.
- `packages/ui/src/AnnotationRow.svelte` — its comment notes that a published site's Layer list is an
  ordinary block in a page that scrolls as a whole, "which is also what the editor's sidebar becomes on a
  phone". That sentence has been aspirational; this ticket makes it true.
- `apps/editor/src/lib/base-map/BaseMapPane.svelte` and `apps/viewer/src/lib/ReaderMapPane.svelte` — the
  panes the sheet covers.
- `playwright.config.ts` — how a viewport is set for a spec, and whether a phone-sized project already
  exists. If none does, set the viewport in the spec rather than adding a Playwright project; a new
  project multiplies the whole suite.

## Two things ticket 07 left for this ticket

Recorded from ticket 07's review rather than fixed there: both are about what the height cap does on a
short pane, which is this ticket's subject and not that one's. Neither is a regression — the docked
panel on a desktop is unaffected — and neither is asserted anywhere yet.

- **The scroll claim is measured on the Text face only.** `editor-annotations.e2e.ts` fills a long
  description and asserts the face scrolls and the header stays put; the **Style face is never measured at
  the cap**, and it is the taller of the two — some twenty-five controls. Whatever geometry the sheet gets,
  assert the cap against the Style face as well as the Text one.
- **Below about 150 px of pane height the Style tab is unreachable.** The identity header and the tab strip
  are `shrink-0`, so once the cap falls below their combined height the face is clipped to zero: the strip
  is on the screen, the Style tab can be pressed, and it opens onto nothing. A phone in landscape with a
  short map pane is exactly that pane. A sheet anchored to the bottom is measured against the window
  rather than against a squeezed column, so this may fall out of the sheet's own geometry — but it is a
  claim to assert, not to assume.

## Contract

- **Both apps stack at the same breakpoint** — the one the viewer already uses. One width to learn, and
  `leaderPath`'s refusal then begins in both apps at the same place.
- **Below it**: the map sits above, the Layer stack below as an ordinary block in a page that scrolls as a
  whole, and the Inspector becomes a **sheet anchored to the bottom** over the map.
- **The sheet is the same `AnnotationInspector`**, positioned differently by its consumer. Do not build a
  second component, and do not add a `variant` or `asSheet` prop — where it sits is the consumer's, which
  is why the component does not position itself.
- **The subtraction is unchanged on a phone.** The Reader's sheet has no tab strip, no *Edit text*, no
  *Delete*, because the viewer still passes no `style` and no callbacks. If a phone branch has to restate
  any of that, the design has been abandoned.
- **No leader is drawn when stacked**, in either app. This is `leaderPath` refusing, not a media query
  hiding an element: the function must be what declines, so the SVG carries no path rather than carrying
  one nobody can see.
- **The sidebar's colours and surfaces survive.** `base-300` column, `base-100` cards, and the measured
  luminance steps in both themes. Stacking changes the axis, not the palette.
- **The sheet must not cover the attribution**, and its body scrolls inside it — the same rule ticket 07
  established for the docked panel, applied to the sheet's own geometry.
- If the reader pane or the base map pane needs the camera moved for the sheet, use ticket 07's
  mechanism: `keepAnnotationClear`, and a per-move `easeTo` **`offset`** rather than `padding` — see the
  note there, `padding` is viewport state that outlives the move that set it. A sheet at the bottom is a
  reservation on the y axis instead of the x, not a new idea.
- **No change to `leader-line.ts`.**

## User Stories

- **60.** As an author on a phone, I want the Project screen to be usable at all, so that a 24 rem sidebar
  does not take the whole window and leave the map nothing.
- **61.** As either app's user on a phone, I want the Inspector as a sheet over the map, so that a panel
  docked to a corner has somewhere to go when there is no corner.
- **62.** As either app's user on a phone, I want no leader drawn, so that a line across a stacked layout
  is not asserting a relationship the layout cannot show.
- **63.** As a Reader on a phone, I want the same subtraction as on a desktop, so that the sheet is not a
  third interface with rules of its own.

## Out of scope

- **A phone layout for the alignment route.** It has a docked Control Point column and a different problem;
  it is not in this epic.
- **A Playwright project per viewport.** Set the viewport inside the spec. A new project multiplies every
  spec in the suite, which is the cost the suite epic exists to stop paying.
- **Modifying `leaderPath` or `stacked()`.** Both are correct; the editor stacking is what exercises them.
- **A drag-to-expand or snap-point gesture on the sheet.** It is a sheet with a dismiss control. Snap
  points, velocity tracking and a drag handle that actually drags are a separate feature.
- **A tablet layout, or a third breakpoint.** One breakpoint, shared.
- **Restyling anything for the phone** beyond what stacking requires. Same tokens, same cards, same tint.
- **Touching the app bar, the Workspace switcher, the publish controls or the dialogs.** They have their own
  responsive behaviour and it is not this ticket's.

## Acceptance criteria

- [ ] At a phone viewport in the built editor: the map and the Layer stack are both usable, the map has a
      non-zero height and width, and the sidebar is not `w-96`.
- [ ] At a phone viewport in **both** built apps: selecting an Annotation renders the Inspector as a sheet
      anchored to the bottom of the map, and its body scrolls without covering the attribution.
- [ ] At a phone viewport in both apps: **no leader path is rendered**, and it is `leaderPath` returning
      `null` that causes it — the SVG carries no path element, rather than a path hidden by CSS.
- [ ] At a phone viewport in the built viewer: the sheet has no tab strip, no *Edit text* and no *Delete*,
      and the stack has no drag handle, no rename, no move up/down and no *Delete Layer*.
- [ ] At a desktop viewport, both apps are unchanged from tickets 06–08 — the Inspector docks to the
      top-right and the leader is drawn.
- [ ] Both apps stack at the same width; the same viewport width that stacks one stacks the other.
- [ ] `git diff --stat` shows no change to `packages/ui/src/leader-line.ts`.
- [ ] `grep -rn "asSheet\|variant" packages/ui/src/AnnotationInspector.svelte` returns nothing.
- [ ] `pnpm precommit` passes in full.

```bash
cd /home/dflood/repos/ballastella
git diff --stat -- packages/ui/src/leader-line.ts
grep -rn "asSheet\|variant" packages/ui/src/AnnotationInspector.svelte || echo "clean"
pnpm --filter @ballastella/ui exec vitest run leader-line
pnpm test:e2e editor-annotations.e2e.ts
pnpm test:e2e viewer-reader.e2e.ts
pnpm precommit
```

Success: `git diff --stat` reports nothing for `leader-line.ts`, the grep prints `clean`, both e2e specs
exit 0 with the new phone-viewport assertions alongside the unchanged desktop ones, and `pnpm precommit`
exits 0.

## Blocked by

- 06
- 08
