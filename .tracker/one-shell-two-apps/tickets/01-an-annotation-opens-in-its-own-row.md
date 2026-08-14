# An Annotation opens in its own row

## Parent

[SPEC.md](../SPEC.md)

## What to build

In the editor, selecting an Annotation stops opening a panel *below* the list and instead **expands
that Annotation's own row**, in place, with a short animation. The row that is open is the Annotation
that is selected; closing it deselects. One row is open at a time.

Everything the panel showed — the title, the description, the style controls, delete — appears inside
the row it belongs to. Nothing about what those controls do changes.

This is editor-only and touches no package boundary. It is the interaction the rest of the epic is
built around, so it goes first and can start immediately.

## Where to start

- `apps/editor/src/lib/annotations/AnnotationLayerContents.svelte` — the `<ol class="menu">` of
  `annotation-row` buttons, and the `{#if selected !== null}<AnnotationEditor …>` block that follows
  the list. That block is what moves inside the row.
- `apps/editor/src/lib/annotations/AnnotationEditor.svelte` — unchanged in behaviour; it is being
  re-parented, not rewritten.
- `apps/editor/src/lib/layers/LayerList.svelte` — read `moveAnimation` and the `disclosureButton`
  handling. The Layer card is the prior art for a disclosure and for respecting reduced motion, and
  this row must match it rather than invent a second convention.
- `apps/editor/src/lib/annotations/annotation-layer-contents.dom.test.ts` and
  `AnnotationLayerContentsHarness.svelte` — the Seam 3 home for these claims.
- `e2e/editor-annotations.e2e.ts` — several tests assert on `annotation-editor` and on the row's
  `aria-pressed`. They must be updated, not deleted.

## Contract

**Selection and expansion are one state.** The row's `aria-pressed` is replaced by `aria-expanded`
plus `aria-controls` pointing at the revealed region. There must be no element that expresses
selection separately from expansion — two properties for one fact are two things that can disagree.

**The disclosure is the row's existing button.** Do not add a second control beside the name.

**Animation.** A height transition of 220 ms with `cubicOut` easing, and **zero duration when
`prefersReducedMotion.current` is true**. Read it from `svelte/motion`, the same import
`LayerList.svelte` already uses; do not add a media-query listener of your own.

**Focus is never taken.** Opening and closing leave the keyboard on the row's own button. This
differs from the Layer card's delete and reorder, which move focus only because the element holding
it stopped existing — nothing stops existing here.

**After expanding, bring the row's header back into view** if it has left the scrolling sidebar. Do
this after `await tick()`, and only when the header is actually outside the scroll container.

**"New Annotation" still closes whatever is open.** That behaviour exists today via `onselect(null)`
in the `onnew` handler and must survive.

**The test id `annotation-editor` stays on the editor's root element.** Its position in the DOM
changes; its identity does not, so existing selectors keep working and the diff stays legible.

### User Stories

24, 25, 26, 27, 28, 29, 30, 31, 35, 36, 67

## Out of scope

- **Do not touch the viewer.** It has no Annotation list yet; that is ticket 06.
- **Do not move anything into a shared package.** That is tickets 02 and 06.
- **Do not add ordinals or numbering.** That is ticket 08.
- **Do not draw a leader line.** That is ticket 12.
- **Do not remove the map popup.** That is ticket 07, and removing it here would take the untrusted-
  description claim with it before its new home exists.
- **Do not change `AnnotationEditor`'s own behaviour** — not its fields, not its style controls, not
  its write coalescing. It is being re-parented.
- **Do not change what is written to disk.** No `annotations/*.geojson` may differ by one byte for
  the same actions.

## Acceptance criteria

- [ ] Selecting an Annotation expands its own row; the editor's controls are inside that row's
      revealed region and are not siblings of the list.
- [ ] The row's button carries `aria-expanded` reflecting the state, and `aria-controls` naming the
      revealed region. No `aria-pressed` remains on it.
- [ ] Clicking the open row collapses it and clears the selection.
- [ ] Opening a second Annotation collapses the first.
- [ ] Keyboard focus is on the row's button before and after opening, and before and after closing.
- [ ] With reduced motion requested, the transition duration is 0.
- [ ] "New Annotation" collapses whatever row was open.
- [ ] An unchanged Annotation Layer is byte-identical across a session that only opened and closed
      rows.
- [ ] The full gate is green.

```bash
# Seam 3 — the disclosure's own behaviour
pnpm --filter @ballastella/editor test

# Seam 2 — the claims that assert through the running application
pnpm test:e2e editor-annotations

# The whole gate, cheapest first
pnpm precommit
```

Success: `pnpm precommit` exits 0 with every stage passing. The Seam 3 run reports new tests covering
`aria-expanded`, the one-open-at-a-time rule, focus staying put, and the reduced-motion duration. The
byte-identity claim is the existing `an unchanged Annotation Layer stays byte-identical across a
session that only looked` test in `editor-annotations`, extended to open and close a row.

**Mutation check, mandatory.** For each new assertion, break the behaviour it claims to cover and
show the test goes red — remove the `aria-expanded` binding, remove the collapse-on-second-open rule,
and remove the reduced-motion branch, one at a time.

## Blocked by

None — can start immediately.
