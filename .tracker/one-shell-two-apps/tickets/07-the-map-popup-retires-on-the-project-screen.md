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

- [ ] Clicking an Annotation on the Base Map opens its Layer's card and its own row, in both apps.
- [ ] The opened row is scrolled into view when it is outside the sidebar's scroll container.
- [ ] No popup element is created over the Base Map on the Project screen in either app.
- [ ] With a drawing tool armed, a click on the map still places a vertex and does not open a row.
- [ ] Escape abandons a part-drawn shape first, and collapses the open row when there is no gesture
      to abandon.
- [ ] Escape still does nothing while a dialog or the Project menu is open.
- [ ] The untrusted-description inertness assertion on the row passes before and after this ticket.
- [ ] `renderDescription` and the sanitiser path are still exercised by the payload matrix.

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

## Blocked by

- 06 — a Reader reads an Annotation in its row
