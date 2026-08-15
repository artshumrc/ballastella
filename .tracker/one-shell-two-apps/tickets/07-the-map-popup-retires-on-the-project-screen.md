# The map popup retires on the Project screen

## Parent

[SPEC.md](../SPEC.md)

## What to build

Clicking an Annotation on the map stops opening a popup over it. Instead it opens that Annotation's
row in the sidebar — which is now where an Annotation is read, in both apps — and scrolls the row
into view.

On a phone, where the sidebar sits under the map, tapping a pin opens the row and scrolls to it, so
the answer to "what is this pin?" is always in one place rather than two.

## Where to start

- `packages/core/src/render/annotation-popup.ts` — `showAnnotationPopup` and `renderAnnotationPopup`.
  The latter holds this repository's one `setHTML` (ADR-0009). Read the whole module before deciding
  what may be deleted.
- `apps/editor/src/lib/base-map/BaseMapPane.svelte` and `apps/viewer/src/lib/ReaderMapPane.svelte` —
  both take `popupAnnotation` / `popupAt` and emit `onclickannotation` and `onpopupclose`.
- `apps/editor/src/lib/annotations/annotation-editing.svelte.ts` — `popupAt`, `openFromMap`,
  `selectAnnotation(id, at)`. `openFromMap` already opens the Annotation's Layer and selects it,
  which is most of the behaviour this ticket wants.
- `apps/editor/src/lib/project/ProjectScreen.svelte` — the window `keydown` handler clears
  `annotations.popupAt` on Escape, after the drawing gesture has had its chance.
- `e2e/editor-annotations.e2e.ts` — `a description is shown in a popup over the map, rendered`, `the
  payload is inert in the popup on the map`. `e2e/viewer-reader.e2e.ts` — its popup equivalents.

## Contract

**Clicking an Annotation on the map opens its Layer's card, opens its row, and scrolls the row into
view.** In the editor this is `openFromMap`'s existing behaviour plus the scroll; the guard that
ignores the click while a drawing tool is armed stays exactly as it is.

**Escape.** With no popup, Escape's job on the Project screen is: abandon a part-drawn shape first
(unchanged), then collapse the open Annotation row. The ordering and the dialog/menu guards in the
window handler must survive; read the comment above them before editing.

⚠ **Do not delete `renderAnnotationPopup` or the sanitiser path.** The unwarped document view and any
future popup surface still need it, and it is the module the payload matrix in
`markdown.browser.test.ts` exercises. What retires is the *popup on the Project screen*, not the
renderer. If `showAnnotationPopup` genuinely has no caller left, say so in the completion note and
leave the decision to delete it to a reviewer — a deleted sanitiser is not a tidy-up.

**The inertness claim must already live on the row** (ticket 06) before the popup's version is
removed. Confirm it is passing before you touch the popup tests; do not remove a security assertion
and add its replacement in the same commit.

**Nothing about `data-drawn`, the stack status region, or the opening-view announcement changes.**

### User Stories

32, 34

## Out of scope

- **Do not remove the popup from the unwarped document view** if it has one.
- **Do not change what an Annotation's row renders.** Ticket 06 settled that.
- **Do not add the leader line.** Ticket 12 — this ticket makes the leader's job well defined by
  establishing that the row is the destination, and stops there.
- **Do not change the map panes' data paths, tile fetching, or layer stacking.**
- **Do not touch `overlay-points.ts` or the Annotation vertex handles.**

## Acceptance criteria

- [x] Clicking an Annotation on the Base Map opens its Layer's card and its own row, in both apps.
- [x] The opened row is scrolled into view when it is outside the sidebar's scroll container.
- [x] No popup element is created over the Base Map on the Project screen in either app.
- [x] With a drawing tool armed, a click on the map still places a vertex and does not open a row.
- [x] Escape abandons a part-drawn shape first, and collapses the open row when there is no gesture
      to abandon.
- [x] Escape still does nothing while a dialog or the Project menu is open.
- [x] The untrusted-description inertness assertion on the row passes before and after this ticket.
- [x] `renderDescription` and the sanitiser path are still exercised by the payload matrix.

```bash
pnpm lint
pnpm check
pnpm test
pnpm --filter @ballastella/core test
pnpm --filter @ballastella/ui test

pnpm test:e2e editor-annotations
pnpm test:e2e viewer-reader
pnpm test:e2e editor-project-screen
```

Success: everything exits 0. The `editor-annotations` run must still contain a passing assertion that
a payload is inert where a description is rendered — moved to the row, not missing.

**Mutation check:** break the click-to-open-row wiring and show a test goes red in both apps. Then
confirm the payload assertion goes red when the sanitiser is bypassed, so that retiring the popup did
not quietly retire the only thing asserting it.

## What was built

**The popup is gone from both map panes.** `BaseMapPane` and `ReaderMapPane` no longer take
`popupAnnotation`, `popupAt` or `onpopupclose`, and neither imports `showAnnotationPopup`. Their
`onclickannotation` no longer reports *where* on the earth the click landed either: a row has no
anchor, and the coordinate existed only to place a bubble.

**A click on an Annotation opens its row, in both apps.** In the editor that is `openFromMap`'s
existing behaviour with the anchor dropped; `selectAnnotation` takes an id and nothing else, and
`popupAt` is gone from `AnnotationEditing`. In the viewer the click now opens the Layer's card as
well as naming the Annotation — a row inside a closed card is not on the screen, so opening one
without the other would have answered a tap with nothing.

**The row brings itself into view however it was opened.** `AnnotationRow`'s scroll-settle moved out
of the click handler into an effect on `open`, and it now measures against the viewport where there
is no scrolling ancestor. That second half is what makes the phone story real: a published site's
Layer list is an ordinary block in a page that scrolls as a whole, so a tap on a pin below the fold
used to open a row a screen away with nothing to bring the Reader to it.

**Escape's ordering survives.** The window handler on the Project screen still returns early for a
dialog and for the Project menu, still abandons a part-drawn shape first, and now collapses the open
row where it used to close the popup.

### The sanitiser did not retire with the popup

`renderAnnotationPopup` and `showAnnotationPopup` are untouched, and
`packages/core/src/annotation/markdown.browser.test.ts` still exercises the whole payload matrix
through both. ⚠ **`showAnnotationPopup` now has no caller anywhere in either app.** That is recorded
rather than acted on: deleting it would delete this repository's one `setHTML` and the one worked
example of how a popup surface is built safely. The decision to remove it belongs to a reviewer, and
the module's header now says so in as many words.

### The inertness claim, and the order it moved in

The row's claim was **passing in both apps before the popup's was touched**, and in two commits so a
reviewer can see it:

1. `980cf4d` added the editor's row assertions — `annotation-description-text` and
   `annotation-title-text` probed separately, because the panel around them is full of this app's own
   Lucide `<svg>` — beside the popup's, and was verified green with the popup still in place. The
   viewer's half has been passing since ticket 06 (`e2e/viewer-reader.e2e.ts`, the eight payload
   tests).
2. The retirement commit then deleted the popup half out of both suites.

### Seams and budget

`check-seam-2-size` reads **630 against a ceiling of 630 before and after**. No Seam 2 test was added
and none was removed: the popup halves were folded into tests that keep their row halves, and the
phone's `an Annotation popup is readable inside the viewport` became `tapping an Annotation opens its
row and brings the row onto the screen`.

### Mutation checks

**The click-to-open-row wiring**, broken in both apps at once (the two `onclickannotation` handlers
made no-ops): `editor-annotations` went red on 2 tests, `viewer-reader` on 9.

**The sanitiser bypassed** (`sanitise` in `packages/core/src/annotation/markdown.ts` made to return
its input): `the payload is inert in the row where the Annotation is read` went red in the editor and
all eight payload tests went red in the viewer — so retiring the popup did not quietly retire the only
thing asserting it.

## Blocked by

- 06 — a Reader reads an Annotation in its row
