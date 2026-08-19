# A Label is an ordinary Annotation

## Parent

[SPEC.md](../SPEC.md) — the "list, the Inspector, and the rest of the application" stories, and the
accessibility journey.

## What to build

Everything a Layer does to its Annotations, it does to a Label: it is counted, it is hidden with its
Layer, it is deleted from the Inspector, it comes back with undo into the Layer and the position it
came from, and a Layer's opacity leaves it alone exactly as it leaves a Pin alone.

**Almost none of this is new code.** A Label is an ordinary Annotation in an ordinary collection, so
these behaviours arrive by construction. This slice is where that claim stops being an assumption:
each one is driven and asserted, and anything that turns out not to be free is fixed here.

It also walks the whole feature once with the keyboard alone — reach the tool, place a Label, type its
words, style it, delete it — because the journey is only real when every surface it crosses exists.

## Where to start

- `apps/editor/src/lib/annotations/annotation-editing.svelte.ts` — `deleteSelected`, the undo record
  it writes, and `commitAnnotationsIn`, which exists precisely so an undo restores into the Layer the
  Annotation came from rather than whichever is open.
- `packages/core/src/annotation/annotation.ts` — `removeAnnotation` and `insertAnnotationAt`, and the
  note on why a restore is an insert at an index rather than an append.
- `apps/editor/src/lib/project/ProjectScreen.svelte` — `deleteSelectedAnnotation`, and the recorded
  rule about where the keyboard goes when the last Annotation in a Layer is deleted.
- `packages/ui/src/AnnotationList.svelte` — the count above the list, and the empty-Layer wording.
- `e2e/editor-undo.e2e.ts` — the existing undo spec and its prior art for an Annotation.
- `e2e/editor-layers.e2e.ts` — hiding a Layer and setting its opacity.
- `packages/core/src/render/stack-layers.ts` — `setOpacity` is a no-op for an Annotation Layer, which
  is the recorded behaviour story 46 is about.

## Contract

No new interface. If any of the criteria below needs production code to pass, that is a defect this
slice found and fixes — and the fix stays inside the Annotation path rather than becoming a Label
special case. A Label needing its own delete, its own undo record, or its own count would mean the
discriminator had leaked somewhere it should not be; prefer removing the leak.

Two behaviours are worth naming because a Label is the first Annotation that can be *invisible*:

- **Deleting a Label with no words** must still work from the Inspector and still be undoable. There
  is nothing on the map to click, so the row and the Inspector are the whole path.
- **An untitled Label still counts** towards its Layer's Annotation count. The count is of what is in
  the file, not of what is painted.

## User Stories

42. As an author, I want to delete a Label from the Inspector as I would any other Annotation, so that
    deletion is one act with one place.
43. As an author, I want a deleted Label restored by undo, into the Layer and the position it came
    from, so that undo means the same thing for every kind.
44. As an author, I want a Label to count towards its Layer's Annotation count, so that the number over
    the list is the number of things in it.
45. As an author, I want to hide a Layer and have its Labels go with it, so that visibility is a
    property of the Layer for every kind of Annotation.
46. As an author, I want a Layer's opacity to leave its Labels alone exactly as it leaves its Pins
    alone, so that the control behaves as it already documents.
62. As an author using a keyboard alone, I want to reach the Label tool, place a Label, type its text,
    style it and delete it, so that the whole feature is operable without a pointer.

## Out of scope

- **Adding behaviour.** This slice asserts what exists. If a criterion needs a feature rather than a
  fix — a confirmation dialog, a multi-select, a "delete all Labels" — it is out of scope and the
  criterion is wrong.
- **Refactoring the undo record.** It carries the Layer and the index already; leave its shape alone.
- **Making a Label a special case anywhere.** If a test needs `isLabel` in a delete path or a count,
  stop and ask: the answer is almost certainly that the leak is elsewhere.
- **The published site.** Ticket 08.
- **A keyboard journey through the *viewer*.** This is the author's journey.

## Acceptance criteria

- [x] In a browser: a Layer holding a Pin, a Line, a Shape and a Label reports a count of four, and
      reports four again after the Label is given words.
- [x] In a browser: hiding the Layer removes the Label from the map along with everything else; showing
      it brings the Label back.
- [x] In a browser: a Layer's opacity slider changes nothing about how a Label draws — the same
      no-op it already is for a Pin.
- [x] In a browser: deleting a Label from the Inspector removes it from the map, from the list and from
      the file; undo restores it to the same position in the collection, in the same Layer, with its
      words and its colours intact.
- [x] In a browser: a Label with **no** words is deletable and restorable by the same path.
- [x] In a browser: after deleting the only Annotation in a Layer, the keyboard lands on *New
      Annotation* in the same card — the existing rule, holding for a Label.
- [x] In a browser, keyboard only, no pointer at any step: press *New Annotation*, choose Label, place
      it, type its words, change its colour and its size, then delete it.
- [x] Ordinals renumber after a Label is deleted, so the numbers stay the positions they claim.

```bash
pnpm test:e2e editor-annotations
pnpm test:e2e editor-undo
pnpm test:e2e editor-layers
pnpm precommit
```

Success: all green, with the keyboard-only journey a single named case that fails if any surface on it
becomes pointer-only.

## Blocked by

- Ticket 03 — a Label has to exist.
- Ticket 04 — the keyboard journey crosses the Style face.
- Ticket 05 — and the Text face.

## Answer

Acceptance criterion 3 and story 46 name an Annotation Layer opacity slider that does not exist. The
control is rendered only for `kind === 'map'`, an `AnnotationLayer` has no `opacity` field, and
`setOpacity` reaches only a warped Map Image. The union makes that failure unrepresentable rather than
merely unhandled, which is stronger than the story asked for.

`packages/core/src/project/layer.test.ts` already asserts this at Seam 1 in “cannot put opacity on an
annotation Layer”. The browser test instead proves that an Annotation Layer's card offers no such
control, and that a neighbouring Map Image's slider leaves the Label's paint untouched.

No production change was needed for stories 42–46 or 62: the claim that a Label arrives at these
behaviours by construction held.
