# 08 — A Reader reads in the same Inspector, and the disclosure is deleted

## What to build

Two things that have to happen together.

**The viewer switches over.** A Published Site's Annotation rows stop revealing anything and start
selecting; the Annotation is read in the same `AnnotationInspector`, docked over the reader map pane's
top-right. The viewer passes `text` and **no `style`**, so there is no tab strip at all — not a disabled
Style tab, not a lone Text tab. No *Edit text*, no *Delete*.

**The contract half of expand–contract.** Once neither app passes `contents`, the row's disclosure
machinery is deleted rather than left unreachable: `contents` from `AnnotationRow` and `AnnotationList`,
the revealed region and its `slide`, `data-reveal-ms`, `keepInView`, `scrollSettled`,
`scrollingAncestor`, and the `bind:this` that existed only to feed them.

This is the ticket where the epic's thesis becomes checkable: the Reader's panel is the author's panel
with props withheld, and every difference is an absence.

## Where to start

- `apps/viewer/src/routes/+page.svelte` — the whole Annotation surface. Find: the `LayerList` render and
  the props it deliberately withholds (read the header comment "THE STACK IS THE EDITOR'S `LayerList`,
  AND SUBTRACTION IS WHAT MAKES IT A READER'S"); the `annotationContents` snippet rendering
  `AnnotationList`; the snippet rendering `<AnnotationReading {annotation} {index} />` and the ⚠ comment
  above it explaining why it is the package's rather than markup composed there; `openAnnotationId`; the
  `LeaderLine`; and the note about the grid collapsing to one column below `lg`.
- `apps/viewer/src/lib/ReaderMapPane.svelte` — the reader's MapLibre pane. Ticket 04 moved its zoom
  control to `bottom-left`. Find its positioned wrapper; the Inspector docks inside it, exactly as the
  editor's does.
- `packages/ui/src/AnnotationRow.svelte` — everything being deleted. **Read the comments before deleting
  them**, because several record measured Chromium behaviour that will otherwise be re-derived by
  somebody: `scrollSettled`'s note on why a single `scrollend` is not enough (`scrollend` at 47 ms, then
  a smooth scroll from 81 ms to 347 ms), and `keepInView`'s note that `await tick()` is not the same as
  waiting for the column to stop moving (the header sat 225 px inside the column at the microtask and
  38 px above its top edge when the scroll finished).
- `packages/ui/src/AnnotationList.svelte` — the `contents` prop it forwards.
- `packages/ui/src/annotation-list.dom.test.ts` — the tests that go with the disclosure, and the ones
  that stay.
- `apps/editor/src/lib/annotations/AnnotationLayerContents.svelte` — confirm ticket 06 left it passing no
  `contents`. If it still does, this ticket cannot delete the prop.
- `e2e/viewer-reader.e2e.ts` — the Reader's browser spec, and **the home of the sanitiser claim**. It
  asserts the prose *arrived* before asserting the payload is inert, because a blank description passes
  every inertness assertion there is.
- `e2e/viewer.e2e.ts` — the other viewer spec.
- `scripts/check-viewer-deps.mjs` runs in `pnpm lint` and checks `@ballastella/ui`'s manifest too.

## Contract

- **The viewer passes `text` and omits `style`, `ontext`, `oncommit` and `ondelete`.** No tab strip, no
  *Edit text*, no *Delete*. **Do not add a `readOnly` prop, a `mode` prop, or a viewer-specific branch
  anywhere.** If you find yourself writing `if (isViewer)`, the design has been abandoned.
- **The viewer's `text` snippet is `AnnotationReading` and nothing else.** Not markup composed in the
  route — the ⚠ comment in that file explains why, and it is a security argument: a published site's own
  source carries no `{@html}` at all, which is what makes the inertness claim a claim about the thing
  that ships.
- **The Layer card's existing subtraction is unchanged.** No drag handle, no rename pencil, no move
  up/down, no *Delete Layer* — all already absent because their callbacks are. **The Reader keeps the
  visibility toggle and the Layer opacity slider**: toggling writes nothing, and membership in a group
  that can be shown and hidden is what the left column is for.
- **No *New Annotation* and no place lookup.** The `tools` snippet is not passed, and it must not become
  passable — a Published Site quietly issuing a lookup to a third-party service for a Reader who asked
  for nothing is what ADR-0029 is written against.
- **`contents` is removed from `AnnotationRow` and `AnnotationList`** along with the revealed region,
  the `slide`, `data-reveal-ms`, `keepInView`, `scrollSettled`, `scrollingAncestor` and the button
  reference. Removed, not commented out and not left behind an unused optional prop.
- **`AnnotationRow`'s file header is rewritten.** It currently argues at length that *the row is the
  disclosure*. That argument is now false of the code it heads. Replace it with what is true, and cite
  ADR-0035 for the reasoning — the header is the first thing a maintainer reads and it must not be a
  monument to a decision that has been reversed.
- `aria-expanded` plus `aria-controls` naming the Inspector, in both apps, from the shared component.
  Still no `aria-pressed`.
- The Reader's leader is unchanged: mark → row, from the shared `LeaderLine`.
- Whether the reader pane needs the camera padding ticket 07 built for the editor: **use ticket 07's
  mechanism if so, do not invent a second one.**

## User Stories

- **43.** As a Reader, I want a Published Site to look like the tool it was made in, so that I recognise a
  scholar's Project as the thing they built.
- **44.** As a Reader, I want to select an Annotation and read its title and description, so that the
  scholarship is what the site delivers.
- **45.** As a Reader, I want no tab strip at all rather than a lone Text tab, so that I am not shown a
  control that switches between one thing.
- **46.** As a Reader, I want no Style tab, so that I am not offered — or refused — a control that was
  never mine.
- **47.** As a Reader, I want no Edit and no Delete, so that nothing on the page suggests I can change
  somebody's work.
- **48.** As a Reader, I want no drag handle, no reorder, no rename and no Layer delete, so that the stack
  is something I read rather than something I appear able to rearrange.
- **49.** As a Reader, I want no New Annotation and no place lookup, so that a site I opened does not issue
  a request to a third-party service I never asked it to.
- **50.** As a Reader, I want to show and hide a Layer, so that I can look at one thing at a time.
- **51.** As a Reader, I want the same dashed leader from a mark to its row, so that the numbered marks are
  as legible to me as to the author.
- **52.** As a Reader, I want a stranger's description rendered inert, so that opening a Project cannot run
  somebody's script on the site's own origin.
- **64.** As a contributor, I want the Inspector to be one component both apps render, so that the
  Reader's panel is the author's panel with props withheld rather than a second implementation of it.
- **69.** As a maintainer, I want the disclosure machinery removed rather than left unreachable, so that
  the next reader is not maintaining code nothing renders.

Story 52 is **preserved, not new**, and it is the one claim in this epic that a component-seam test cannot
carry: DOMPurify answers "supported" against happy-dom and then returns its input essentially untouched.
Its assertions stay in `e2e/viewer-reader.e2e.ts`, in a real browser against a real published build, and
they must still assert the prose *arrived* before asserting what did not.

## Out of scope

- **The phone layout.** Ticket 09, for both apps.
- **Giving the Reader anything the editor has.** No Style tab behind a flag, no read-only style display,
  no "view styles" affordance.
- **Removing the Reader's visibility toggle or opacity slider.** They stay; see the Contract.
- **Changing `AnnotationReading`.** It is already correct and already shared.
- **Weakening the sanitiser assertions** to make a moved test easier. If a payload test becomes awkward,
  that is a finding to report, not a test to soften.
- **Touching `check-viewer-deps.mjs`** or adding any dependency to `packages/ui`.
- Restructuring the viewer's route beyond what the switch needs. It is a large file; leave the parts this
  ticket does not touch alone.

## Acceptance criteria

- [ ] `grep -rn "contents" packages/ui/src/AnnotationRow.svelte packages/ui/src/AnnotationList.svelte`
      returns nothing.
- [ ] `grep -rn "keepInView\|scrollSettled\|scrollingAncestor\|data-reveal-ms" packages/ui/src apps/`
      returns nothing.
- [ ] `grep -rn "readOnly\|isViewer\|isEditor" packages/ui/src apps/viewer/src` returns nothing.
- [ ] `AnnotationRow.svelte`'s header no longer claims the row is the disclosure, and cites ADR-0035.
- [ ] In the built viewer, selecting an Annotation: no region opens in the row; the Inspector appears over
      the reader pane's top-right; **no tab strip element exists in the DOM**; no *Edit text* and no
      *Delete* exist anywhere in it.
- [ ] In the built viewer, the Layer card renders no drag handle, no rename, no move up/down and no
      *Delete Layer*, and **does** render the visibility toggle and the opacity slider.
- [ ] In the built viewer, no *New Annotation* button and no place search exist. The network fence
      confirms no third-party origin was contacted.
- [ ] The Reader's leader is drawn from a selected mark to its row.
- [ ] `viewer-reader.e2e.ts`'s payload assertions pass unchanged in intent, still asserting the prose
      arrived before asserting the markup did not.
- [ ] Every retired component-seam test names its replacement in the commit message.
- [ ] `pnpm precommit` passes in full, including `check-viewer-deps` inside `pnpm lint`.

```bash
cd /home/dflood/repos/ballastella
grep -rn "contents" packages/ui/src/AnnotationRow.svelte packages/ui/src/AnnotationList.svelte || echo "clean"
grep -rn "keepInView\|scrollSettled\|scrollingAncestor\|data-reveal-ms" packages/ui/src apps/ || echo "clean"
grep -rn "readOnly\|isViewer\|isEditor" packages/ui/src apps/viewer/src || echo "clean"
pnpm --filter @ballastella/ui test
pnpm test:e2e viewer-reader.e2e.ts
pnpm test:e2e viewer.e2e.ts
pnpm test:e2e editor-annotations.e2e.ts
pnpm precommit
```

Success: all three greps print `clean`, the three e2e specs exit 0 — `editor-annotations.e2e.ts` included,
proving the editor survived the deletion — and `pnpm precommit` exits 0.

## Blocked by

- 06
