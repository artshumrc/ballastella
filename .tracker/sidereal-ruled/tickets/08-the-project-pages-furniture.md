# 08 — The Project page's furniture: reachable add-Layer, one z-index

## What to build

Two small repairs to the Project page, both found by reading it and neither caused by this epic. They
are here because they are cheap here and would otherwise wait for somebody to hit them in anger.

1. **The add-Layer buttons stop scrolling out of reach.** They sit below the stack inside the Layers
   rail's own scroller, so a Project with a dozen Layers puts *＋ Map Image* and *＋ Annotations* off
   the bottom.
2. **The two apps stop disagreeing about one z-index.** The map pane's control block is `z-[6]` in
   the editor and `z-10` in the viewer, against an Annotation Inspector docked at `z-[7]` in both.

**No layout redesign.** The rail keeps its cards, its tinted kind headers, its toggles, its opacity
slider and its actions row. This ticket moves one element's position in a flex column and changes one
number.

## Where to start

- `apps/editor/src/lib/project/ProjectScreen.svelte:1289` — the rail:
  `shrink-0 border-t border-base-content/10 bg-base-300 p-4 lg:order-first lg:w-96 lg:overflow-y-auto lg:border-t-0 lg:border-r`.
  Note `lg:overflow-y-auto`: **above `lg` this element is the scroller**, which is why anything after
  the list scrolls away.
- `apps/editor/src/lib/project/ProjectScreen.svelte:1327-1350` — the two add-Layer buttons,
  `add-map-image` and `add-annotation-layer`, in a `mt-4 flex gap-2` after `LayerList`.
- The same file, **1364–1508** — and this is the part that makes the fix less trivial than it sounds:
  a long tail of guidance notes, `text-warning` lines, `sr-only` live regions
  (`annotation-moved`, `ingest-announcement`), an ingest-error alert, a no-map-images note, two
  status lines and a referenced-image alert all render *after* the buttons. Decide where each belongs
  relative to a pinned footer, and say why in the ticket's Answer. A live region must not be moved
  somewhere it is unmounted, or it stops announcing.
- `apps/editor/src/lib/base-map/BaseMapPane.svelte:1195-1204` — the editor's control block,
  `absolute top-2 left-2 z-[6] …`.
- `apps/viewer/src/lib/ReaderMapPane.svelte:784-789` — the viewer's, identical but `z-10`.
- `packages/ui/src/layout.css` — the rules forcing all four `.maplibregl-ctrl-*` corners to
  `z-index: 6`, with the comment explaining that `.maplibregl-map` opens no stacking context so 5, 6
  and 7 are compared in one context. `.leader-line` is `z-index: 5`.
- `apps/editor/src/lib/project/ProjectScreen.svelte:2078-2090` and
  `apps/viewer/src/routes/+page.svelte:1606-1613` — the Inspector dock at `z-[7]`.
- `e2e/editor-layers.e2e.ts` — `:1330` the opacity slider's box, `:1579-1590` the drag grip and
  drop-target boxes, `:1753` the rename field's box, `:768` a thumbnail rect.
- `e2e/editor-base-map.e2e.ts:205-232` — the pane controls in one row, and the search above the
  bottom-left zoom block.
- `e2e/editor-annotations.e2e.ts:1568-1990` and `e2e/viewer-reader.e2e.ts:3957-4205` — the
  `elementFromPoint` hit-tests proving the Inspector sheet does not cover the zoom-in button.

## Contract

**The rail becomes a flex column with the add-Layer pair as a non-shrinking last child**, so the pair
is always visible and only the stack scrolls. `lg:overflow-y-auto` moves from the rail to the
scrolling middle; the rail itself becomes the flex container. Below `lg` the rail is not the scroller —
the route layout's `overflow-y-auto` is — so the pinned footer must not introduce a second scroller
there or change the stacked order.

**The two buttons keep their testids and their kind colours.** `add-map-image` and
`add-annotation-layer`, styled from `KIND_STYLE.map.btn` and `KIND_STYLE.annotation.btn`. Those
strings must stay whole for Tailwind's scanner.

**Every element currently after the buttons keeps rendering, and every live region keeps announcing.**
`annotation-moved` and `ingest-announcement` are `sr-only` live regions; if either ends up inside a
conditional it was not inside before, it stops being announced and nothing errors. State in the
Answer where each of the eleven trailing elements went.

**One z-index for the pane control block in both apps.** Choose `6` — it matches what
`layout.css` already forces MapLibre's own control corners to, keeps the block below the Inspector's
`7`, and leaves `.leader-line`'s `5` beneath both. Changing the viewer *down* to 6 is the change;
raising the editor to 10 would put the controls above the Inspector, which is the arrangement the
sheet hit-tests exist to prevent.

**Nothing about the Inspector's dock changes** — not `z-[7]`, not `bottom-[6.25rem]`, not
`max-h-[60%]`, not `lg:w-80`. Those numbers clear MapLibre's 97px bottom-left block and the ODbL
attribution, and specs measure them.

## User Stories

- **74.** As an author with a dozen Layers, I want *＋ Map Image* and *＋ Annotations* still reachable
  without scrolling past the whole stack.
- **75.** As a maintainer, I want the two apps to stack their map-pane controls at the same z-index, so
  that "identical except for editing" is true of the one number where it currently is not.

## Out of scope

- **Redesigning the Layer rail.** Both redesigns are rejected in ADR-0036. No ruled ledger, no fixed
  header, and the Base Map chooser and *Fit project* stay on the pane —
  `editor-base-map.e2e.ts:205-232` asserts they are one row there.
- **Moving `LayerList`'s card anatomy.** No change to headers, tints, toggles, opacity, badges or the
  actions row.
- **The Inspector's dock, or MapLibre's control corners.** Both are tuned against measured pixel
  blocks.
- **The known short-window limit** documented around `ProjectScreen.svelte:2040-2060`, where a window
  under ~340px tall clips the Style face. Documented, not asserted, and not this ticket.
- **Adding a scroller below `lg`.** The route layout owns scrolling there.

## Acceptance criteria

- [ ] With more Layers than fit the rail's height above `lg`, both `add-map-image` and
      `add-annotation-layer` are visible without scrolling, and the stack above them scrolls.
- [ ] Below `lg` the screen still stacks in the same order with no second scroller in the rail.
- [ ] Both buttons keep their testids and their `KIND_STYLE` classes.
- [ ] Every element that rendered after the buttons still renders, and `annotation-moved` and
      `ingest-announcement` are still mounted whenever they were before.
- [ ] `BaseMapPane.svelte` and `ReaderMapPane.svelte` use the same z-index for the control block, and
      it is below the Inspector's `7`.
- [ ] The Inspector sheet hit-tests still pass: `elementFromPoint` at the zoom-in button's centre does
      not hit the sheet, in both apps.
- [ ] The Project screen's geometry assertions pass untouched — map wider than the rail, rail to its
      left and second in the DOM, stacking at exactly 1024.
- [ ] `pnpm precommit` passes; if `SEAM_2_CEILING` is raised for a reachability test, the table records
      the count and the reason.

```bash
pnpm test:e2e editor-layers
pnpm test:e2e editor-project-screen
pnpm test:e2e editor-annotations
pnpm test:e2e editor-base-map
pnpm test:e2e viewer-reader

# One number, both apps.
grep -n "z-\[6\]\|z-10" apps/editor/src/lib/base-map/BaseMapPane.svelte apps/viewer/src/lib/ReaderMapPane.svelte
# expect: the same value in both files

pnpm precommit
```

Success is a Project with a dozen Layers where *＋ Map Image* never needs to be hunted for, and one
z-index across both apps with every hit-test and geometry assertion green.

## Blocked by

None - can start immediately.
