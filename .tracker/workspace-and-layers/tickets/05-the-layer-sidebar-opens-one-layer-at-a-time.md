# The Layer sidebar opens one Layer at a time

## What to build

The sidebar becomes a list of Layers where one Layer at a time opens in place to reveal what is inside it. A Historical Map Layer opens to show whether it is aligned and a button to align it. An Annotation Layer opens to show its drawing tools and its Annotations.

One idea, applied twice — a Project is a stack of Layers, and a Layer opens to reveal its contents. That is what makes the structure teach itself.

Demonstrable end to end: open a Project with a Historical Map and an Annotation Layer; the sidebar shows two rows; click the map row and it opens showing an orange "not aligned yet" state and an Align button; click the annotation row and the map row closes while the drawing tools appear.

## Where to start

- `apps/editor/src/lib/layers/LayerList.svelte` — 371 lines. Rows today carry name, visibility, opacity, move up/down, delete. They gain an expanded state.
- `apps/editor/src/lib/annotations/AnnotationPanel.svelte` — currently a separate panel below the list, carrying the layer picker, tool picker, finish/cancel/undo-vertex, the Annotation list, title and description, style, line style, delete, and layer default style. **Its layer picker becomes redundant**: the open Layer *is* the chosen Layer.
- The Project screen component extracted in ticket 04 — it owns `chosenLayerId`, `activeLayer`, `activeCollection`, `selectedAnnotationId`, and the `AnnotationDrawing` instance. Read the comment on `chosenLayerId` explaining why it is component state and never written to `project.json`.
- `apps/editor/src/lib/layers/browser-test-handle.ts` — the Playwright handle for the live stack; read it for what e2e can already ask.
- The not-aligned state from ticket 02 — `controlPoints.length < MINIMUM_CONTROL_POINTS`, derived, available for every map Layer including hidden ones.

## Contract

**Which Layer is open is component state and is never written.** Same rule as `chosenLayerId` today: which Layer somebody happened to have open is not part of their work, and persisting it would mean a write on a click that changed nothing (ADR-0002, ADR-0010).

**Opening an Annotation Layer is what chooses it for drawing.** `chosenLayerId` and "which Layer is open" become one value, not two that can disagree. Delete `AnnotationPanel`'s separate layer picker. Opening a different Layer must do what `chooseLayer` does today: abandon a part-drawn shape, clear the selection, close any popup.

**Closed rows stay useful.** A collapsed row shows the Layer's name, its visibility toggle, its position controls, and — for a map Layer — its warning state. A user must be able to see that a map needs aligning **without opening anything**, because that is the state they need to notice.

**The not-aligned state is a warning colour and a sentence, and both.** Colour alone is not information: it must be in the accessibility tree as text, not conveyed by a class. The same applies to the needs-the-network state that ticket 07 adds to the same row.

**Selecting an Annotation on the map opens its Layer.** Clicking an Annotation on the Base Map already sets `chosenLayerId` and selects it; it must now also open that Layer's row, so the user sees where the thing they clicked lives.

**A `foreign` Layer opens too**, and says what it is: a Layer of a kind this version does not understand, kept, nameable, and reorderable but not drawn (ADR-0014). It has no contents to reveal, and that is the honest thing for it to say.

**Position controls stay as buttons, not drag-and-drop.** Move-up and move-down are keyboard-operable; a drag handle is not. This is a standing accessibility criterion, not a preference.

## Out of scope

- **Do not build the add-a-Historical-Map flow.** Ticket 06. The existing add affordances stay wherever ticket 04 left them.
- **Do not change annotation drawing, styling, or storage behaviour.** Only where the controls appear changes. The style controls, the simplestyle properties, `stroke-dasharray` as a tuple with solid being its absence — all untouched.
- **Do not add a second selection concept.** "Open" and "chosen for drawing" are one thing.
- **Do not persist which Layer is open**, not in `project.json` and not in `localStorage`.
- **Do not add drag-and-drop reordering.**
- **Do not build the "make available offline" action.** Ticket 11.

## Acceptance criteria

- [x] Opening a Layer row closes whichever row was open; at most one is open at any time.
- [x] A collapsed map Layer row shows its not-aligned state, and that state is present as text in the accessibility tree.
- [x] An open map Layer row shows an Align button that navigates to `/align/?p=&layer=`.
- [x] An open Annotation Layer row shows the drawing tools and that Layer's Annotations, and drawing into it works.
- [x] Opening a different Layer while a shape is part-drawn abandons the shape and clears the selection.
- [x] Clicking an Annotation on the Base Map opens its Layer's row and selects it.
- [x] A `foreign` Layer can be renamed, hidden, and reordered, and says it is not drawn.
- [x] Which Layer is open is absent from `project.json` and from `localStorage`, and opening a Layer causes no write.
- [x] Reordering by move-up and move-down works from the keyboard alone.
- [x] Every annotation control that existed before this slice is still reachable, and still by keyboard.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
pnpm exec playwright test e2e/editor-layers.e2e.ts e2e/editor-annotations.e2e.ts
pnpm test:e2e
```

All green. `e2e/support/annotations.ts` will need to open a Layer before reaching the tools; that helper change should be the only edit needed to the annotation specs' own assertions — if you find yourself changing what they assert, the move has altered behaviour.

For the no-write criterion, count writes with a spy the way the existing suite does for ADR-0017 rule 1. For the accessibility-tree criteria, assert on accessible text, not on a CSS class — a class assertion passes while a screen reader is told nothing.

## Outcome

**One value, not two.** `ProjectScreen`'s `chosenLayerId` became `openLayerId`, and `activeLayer`
lost its fallback to `annotationLayers[0]`. That fallback was the disagreement the ticket names: a
Layer could be "chosen for drawing" while its row said nothing and the user was looking elsewhere.
Opening a Layer is now the whole of choosing it, so `AnnotationPanel`'s "Drawing into" `<select>` had
nothing left to pick and is gone.

**What moved, and what deliberately did not.** `AnnotationPanel.svelte` became
`AnnotationLayerContents.svelte` and is rendered inside its Layer's open row through a snippet;
`mapActions` became `mapContents` and moved inside the open row too, taking the Align link, the
library's host, "View unwarped" and the offline-copy offer with it. A `foreign` Layer's row opens
onto a sentence, which `LayerList` answers itself because there is nothing to supply. **Nothing about
drawing, styling or storage changed** — `AnnotationTools` lost only its now-unreachable `disabled`
state, and the abandon-on-switch rule is the same `drawing.cancel()` `chooseLayer` already carried.

**What a closed row still shows**: the drag handle, the position in the stack, the disclosure, the
visibility toggle, the name, move-up/move-down, delete, the kind, the local-copy/remote badge, the
opacity slider, and `layer-problem` — which is where "Not aligned yet, so there is nothing to draw."
is said. The open row says it again from the same `outcomes` entry, one sentence computed once,
beside the Align button that answers it.

**The disclosure is a plain `<button aria-expanded>`,** first in each row's tab order. It could not
be the row's name, which is an editable `<input>`: a click that both put the caret in a field and
opened a panel would make renaming a Layer impossible without opening it.

### The mutation check

Seven, each run against the criterion it belongs to, each confirmed red, each restored.

1. `{#if openLayerId === layer.id}` → `!== null`, so every row renders its contents once anything is
   open. `layer-contents` count 2 where 1 was expected.
2. The closed row's warning becomes a `title` tooltip on an empty `<span>` — colour and a tooltip,
   never text. `layer-problem` reads `""`.
3. `mapContents` rendered unconditionally on every map row, which is the pre-05 shape. The Align link
   is on screen with the row closed: count 1 where 0 was expected.
4. The `foreign` sentence emptied, so the row opens onto a blank panel. `layer-foreign-note` reads
   `""`.
5. `openLayer` reduced to `openLayerId = id`, dropping `drawing.cancel()` and the cleared selection.
   The part-drawn polygon survives into the Layer that was opened: `data-drawing` stays `true`.
6. The map-click handler stops setting `openLayerId`, so clicking an Annotation selects it without
   showing where it lives. Its row's `aria-expanded` stays `false`.
7. `openLayer` writes the open id to `localStorage` and calls `session.showLayer`. The write spy
   reports four writes where none were expected.

Criterion 4 is not separately mutated because it *is* the suite: every one of
`editor-annotations.e2e.ts`'s 31 tests reaches its tools through the open row, and none of their
assertions changed.

Three more after review, on the three things review found unasserted:

8. `activeLayer` falls back to `annotationLayers[0]` again. A click on the map with every row closed
   writes **six** Annotations into the topmost Layer; expected none.
9. The open row renders `reported.reason` for any `refused` outcome under `layer-not-aligned`, which
   is the first cut. An unreadable Alignment is announced as a map that merely needs aligning:
   `toHaveCount(0)` gets 1.
10. The no-Annotation-Layer guidance is removed again. The sentence that tells a scholar what to do
    with an empty Project is not on the screen.

Ten mutations, ten reds, all restored.

## Review remediation

**Fixed.**

- **The `activeLayer` fallback removal was unasserted, and it is the defect the Contract names.**
  Restoring `?? annotationLayers[0]` left the whole suite green, because `annotationContents` renders
  only inside the open row — so nothing could see it. It is now covered by the path that *is* live
  with every row closed: `BaseMapPane`'s `onclickpoint`. Closing a Layer abandons a part-drawn shape
  but leaves the **tool** in hand (`cancel()` clears vertices and nothing else), so picking the pin
  tool, closing the row, and clicking the map reaches `placePoint` with no tools on screen. With the
  fallback that click wrote an Annotation into whichever Layer happened to be topmost — the
  mutation produced **six writes** into a file the user was not looking at, from a gesture the
  interface gave them no way to attribute. Asserted on the write count and both Layers' bytes, with a
  control that repeats the click into an open Layer and gets one feature.
- **`layer-alignment-state` was unrequested UI, and it mislabelled.** The positive "Aligned, so it can
  be placed on the Base Map." line is gone — the ticket asks for the warning state and the Align
  button, and a line claiming success is not this slice's to add. The warning is now
  `layer-not-aligned`, printing the one `NOT_ALIGNED` constant. **Narrowing to `notAligned` was not
  enough**, which is the part worth keeping: a Layer whose Alignment cannot be read has no document,
  and "no document" counts as not aligned — so the honest test is the *reported* outcome, where the
  precedence between the three already lives (`outcomes` puts an unreadable file above both other
  refusals). A genuine refusal still appears, on the closed row, under `layer-problem`, whose name
  claims nothing in particular. Covered by a new test that corrupts an Alignment and asserts the row
  says the true thing under the generic id and nothing under the specific one.
- **`AnnotationTools.disabled` is gone because the state is unreachable, and the guidance that went
  with it is not.** The `disabled` sentence read "Add an Annotation Layer to start drawing." and the
  state is now genuinely unreachable: the only render path is `AnnotationLayerContents`, which
  `LayerList` invokes only for a Layer that is both `kind === 'annotation'` and open. That is written
  where the next reader will find it — in `AnnotationTools.svelte`, with the instruction to bring both
  back if a second render path is ever added. **But `AnnotationPanel`'s "No Annotation Layers yet"
  branch went with the picker, and that state is as reachable as it ever was**, so the guidance moved
  to the affordance it is about, beside the "Add an Annotation Layer" button, and is asserted as
  visible text that appears and then goes when it stops being true (SPEC stories 111, 112).
- **`ProjectScreen.svelte`'s size** is answered in its own section above, with what 06 should carve
  first and why the prose was not trimmed to make the number smaller.

**Found while remediating, and worth a line each.**

- **`editor-layers.e2e.ts`'s `writeProjectFile` did not accept `''` for the Workspace root** while the
  `readProjectFile` beside it did — so a fixture that asked for `alignments/<id>.json` got
  `NotAllowedError: Name is not allowed` from `getDirectoryHandle('')`. Two helpers in one file
  disagreeing about what `''` means; the writer now matches the reader.
- **A latent flake in `editor-alignment.e2e.ts`, in a path this ticket does not touch.** "restores
  every pair, its ordinal, and the warped render across a reload" failed once in two full runs on
  `warpedTiles(page)` reading 0, and passed on retry (1 of 440, 0.23%, inside the 0.5% budget).
  `warpedTiles` fits the bounds, `setTimeout`s for a fixed 3000 ms, and then samples the tile cache
  **once** — a sleep standing in for a wait, on an asynchronous decode, which is the shape ticket 17
  spent itself on. The align route mounts no `LayerList` and knows nothing of `openLayerId`, and the
  three pairs were made and stored before the reload the failure follows, so ticket 05 is not
  implicated. Recorded rather than fixed, because it is neither this ticket's file nor its subject.
- **Ticket 18's alignment-writer fence does not see this write.** `writeProjectFile(page, '',
  alignmentRef, …)` launders the path through a local, which is one of the three escapes 18 says it
  closed. The opt-out pragma is on the line regardless, because it is true and because the fence
  should honour it once it can see it — but the escape is live and belongs on 18's ledger rather than
  being quietly relied on here.

### Two things found on the way

**`pnpm lint` was already red on `main`, and had been since `168c141`.** Ticket 16's rename left five
files it touched unformatted — `OfflineCopyDialog.svelte` and four `packages/core/src/remote-iiif/`
files — because the longer identifiers pushed lines past `printWidth`. Formatted here, since `pnpm
lint` is one of this ticket's acceptance commands and nothing else in it is mine. It is the same
lesson the tracker already records about 16: a rename is the change most likely to be 95% done.

**`e2e/support/layers.ts` is new, and it is the reason the churn is safe.** Sixty-odd assertions
across eleven specs reached things that are now behind a disclosure, and several of them were
*absence* assertions — `expect(referenced-image-host).toHaveCount(0)` — which would have gone green
for the wrong reason in every spec that forgot the click. `openLayerRow` is idempotent and asserts on
`aria-expanded`, and the absence assertions are now scoped to an opened row, or replaced by one about
the Layer stack itself. One assertion could not survive as written: `editor-remote-iiif`'s "the
readable one is still listed" counted `referenced-image-label` over the whole page, which one-open-
at-a-time makes meaningless; it now opens each of the two rows in turn and asserts what each says.

**Two call sites the test-id grep could not see**, both found by running the whole suite rather than
the two specs the ticket names. `editor-annotations.e2e.ts`'s reload tests reach the Annotation list
through `reopenLayers`, and `editor-pwa.e2e.ts`'s offline test calls `chooseTool` imported from
`support/annotations.ts` — neither file mentions `annotation-tool-` or `annotation-list` anywhere, so
a grep for the moved test ids missed both. `pnpm test:e2e` is what caught them.

Two e2e helpers changed rather than the one the ticket predicted: `startAnnotating` and
`reopenLayers`, which are the same helper family. `reopenLayers` needs it for the reason the contract
gives — which Layer is open is not persisted, so a reload correctly leaves every row closed. No spec
assertion changed anywhere.

### What this left `ProjectScreen.svelte` at, and what 06 should carve first

**It is bigger, not smaller: 1678 lines before, 1776 after.** 267 lines of markup left for
`AnnotationLayerContents.svelte`, and rather more came back — the `annotationContents` snippet is 21
lines of prop forwarding that cannot live anywhere else, and the rest is prose the state layer now
owes: why `openLayerId` is one value and not two, why `activeLayer` has no fallback, why the
not-aligned element may only say the thing its id names. Duplicated reasoning was consolidated
where it had genuinely landed in the wrong file — the "the open Layer is the chosen Layer" identity
now has one home on `openLayerId` and pointers from `LayerList` and `AnnotationLayerContents` — but
that is worth two lines, not eighty. **Trimming prose to hit a line count would be the wrong trade
in this repository, so it was not made.**

The honest position is that the remainder is 06's to carve, and the reading that saves 06 the
re-derivation is this:

- **Carve the annotation state block first: 369 lines**, from the `// Annotations` banner to the
  `// Making this Project available offline` banner. `annotationLayers`, `openLayerId`,
  `activeLayer`, `activeCollection`, `selectedAnnotationId`, `undoRefusal`, `popupAt`,
  `commitAnnotations`/`commitAnnotationsIn`, `placePoint`, `finishShape`, `addDrawn`,
  `selectAnnotation`, `selectedAnnotation`, `annotationPoints`, `annotationName`, `reshape`,
  `deleteSelected`, `restoreDeleted`, `typeText`, `commitAnnotationEdit`, `styleSelected`,
  `lineStyleSelected`, `openLayer`. It is one subject, it has exactly three edges to the rest of the
  screen — `session`, the `documents` record, and `layers` — and it is the same extraction named
  under "Not done" below as the one that would make a unit seam worth having. A `.svelte.ts` class
  beside `AnnotationDrawing` takes it, and the `annotationContents` snippet collapses to forwarding
  one object.
- **The Historical Maps section is 95 lines** and is 06's own subject, so it is not counted above.
- What is left after both is the document-loading chain (`documentKey`, `documents`, `drawn`,
  `outcomes`, `notAligned`), the opening view, and the offline-availability block. Those are three
  separate subjects and none of them is this ticket's.

**Ticket 05's own share of the growth is the prose, and it is deliberate.** The three comments that
cost the most — `openLayerId`'s "one value, not two", `activeLayer`'s "no fallback", and the
not-aligned element's "an element may only ever say the thing its id names" — each record a defect
that was actually made and found here. They move with the code when 06 carves it.

### Not done, and said rather than forced

**No unit test seam was added.** `apps/editor/` still has no vitest project and no `*.test.ts`, so a
unit test here would have meant adding one — test infrastructure, which this ticket was told not to
grow into. Nothing this carving produced is a pure function that could live in `packages/core`, where
vitest already runs: what moved is markup and one piece of component state. The extraction that
*would* make a seam worth having is the annotation editing layer in `ProjectScreen` —
`placePoint`/`finishShape`/`addDrawn`/`reshape`/`commitAnnotations` and the `annotationPoints`
derived, about 250 lines — as a `.svelte.ts` class beside `AnnotationDrawing`. That is a change to
drawing and storage code, which this ticket's Out of scope forbids, and it still needs the vitest
project before it buys anything.

**A pre-existing hazard, unchanged and now slightly more reachable.** Opening a *hidden* Annotation
Layer gives `activeCollection === null`, because `withDocuments` reads an Annotation Layer's file only
when it is visible — so drawing into a hidden Layer would write a one-Annotation collection over
whatever the file holds. The old layer picker listed hidden Layers too, so this was equally reachable
before; only the gesture is different. `restoreDeleted` already handles its own version of it by
reading the file first. Left alone because the fix is in storage behaviour.

## Blocked by

- Ticket 02
- Ticket 04
