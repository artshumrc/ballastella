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

- [ ] Opening a Layer row closes whichever row was open; at most one is open at any time.
- [ ] A collapsed map Layer row shows its not-aligned state, and that state is present as text in the accessibility tree.
- [ ] An open map Layer row shows an Align button that navigates to `/align/?p=&layer=`.
- [ ] An open Annotation Layer row shows the drawing tools and that Layer's Annotations, and drawing into it works.
- [ ] Opening a different Layer while a shape is part-drawn abandons the shape and clears the selection.
- [ ] Clicking an Annotation on the Base Map opens its Layer's row and selects it.
- [ ] A `foreign` Layer can be renamed, hidden, and reordered, and says it is not drawn.
- [ ] Which Layer is open is absent from `project.json` and from `localStorage`, and opening a Layer causes no write.
- [ ] Reordering by move-up and move-down works from the keyboard alone.
- [ ] Every annotation control that existed before this slice is still reachable, and still by keyboard.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
pnpm exec playwright test e2e/editor-layers.e2e.ts e2e/editor-annotations.e2e.ts
pnpm test:e2e
```

All green. `e2e/support/annotations.ts` will need to open a Layer before reaching the tools; that helper change should be the only edit needed to the annotation specs' own assertions — if you find yourself changing what they assert, the move has altered behaviour.

For the no-write criterion, count writes with a spy the way the existing suite does for ADR-0017 rule 1. For the accessibility-tree criteria, assert on accessible text, not on a CSS class — a class assertion passes while a screen reader is told nothing.

## Blocked by

- Ticket 02
- Ticket 04
