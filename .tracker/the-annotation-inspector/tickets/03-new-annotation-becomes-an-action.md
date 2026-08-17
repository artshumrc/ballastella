# 03 — New Annotation becomes an action

## What to build

Pressing *New Annotation* today enters a mode. The list of Annotations is hidden, three shapes appear,
choosing one arms a tool — and **finishing the shape leaves the tool armed**, so the surface is still
in drawing mode with nothing being drawn, and the list of what is already in the Layer is still out of
the way. A scholar has to press *Done* to get back to where they started.

Make it an action. One press of *New Annotation*, one Annotation:

- Pressing it offers the three shapes and a way out. **The list stays visible.**
- Drawing the shape and finishing it returns everything to rest: the resting single button, the tool
  disarmed, the drawn Annotation selected with its title ready to type.

This is also a prefactor. Deleting the `choosing` branch shrinks `AnnotationLayerContents.svelte`
before ticket 06 has to rewrite it — make the change easy, then make the easy change.

## Where to start

- `apps/editor/src/lib/annotations/drawing.svelte.ts` — `tool = $state<AnnotationTool>('select')`,
  `choose()`, and `finish()`, which returns the finished geometry and currently leaves `tool` alone.
  The header explains why `'select'` is a tool rather than the absence of one; that stays true.
- `apps/editor/src/lib/annotations/AnnotationLayerContents.svelte` — `picking`, the `choosing` derived
  (`picking || tool !== 'select'`), the `drawn` derived, and the `{#if choosing}` branch that hides the
  list and renders a lone captionless `<ol>` for the freshly drawn row. **Read the two long comments
  in that branch before deleting it**: they record why the list steps aside and why the drawn row was
  the exception. Both reasons stop applying, and the commit message should say so.
- `apps/editor/src/lib/annotations/AnnotationTools.svelte` — the resting/choosing split, the `role="toolbar"`
  group, the `aria-live` announcement, and the `drawing` block holding Finish / Undo last point /
  Cancel. Note the comment on why the announcement region is `sr-only` rather than removed when empty.
- `apps/editor/src/lib/annotations/annotation-tools.dom.test.ts` — the component seam for the toolbar.
- `apps/editor/src/lib/annotations/annotation-editing.svelte.ts` — `selectAnnotation`, `selectInLayer`,
  and `addDrawn`, through which every drawn Annotation passes so that style inheritance, the selection
  and the write happen in one place. `styleForNewAnnotation` is called there.
- `e2e/editor-annotations.e2e.ts`, describe block "drawing (SPEC stories 57, 58, 59)", and
  `e2e/support/annotations.ts` for how a gesture is driven.

## Contract

- **`Drawing.finish()` returns the tool to `'select'`.** The rule belongs to the state machine, not to
  a page handler, so there is exactly one place that says a finished gesture is over. `cancel()` must
  behave the same way — an abandoned gesture is also over.
- **`choosing` and the whole `{#if choosing}` branch are deleted.** The list is always rendered. The
  lone `<ol>` with `aria-label="The new Annotation"` and `data-testid="annotation-drawn"` goes with it;
  the drawn Annotation appears in the ordinary list, selected, because that is now where it is.
- `picking` stays as the toolbar's own "the shapes are showing" state: set by *New Annotation*, cleared
  by finishing, by cancelling, and by the way-out button.
- **Pressing *New Annotation* still deselects.** A new Annotation is not an edit to the old one, and
  the open row must not survive into the moment the next shape is drawn.
- **Finishing selects the drawn Annotation and puts the keyboard in its title.** At this ticket's point
  in the epic that means its row opens and the title field focuses. Ticket 06 changes *where* the title
  field is; it must not change that it is focused.
- **`styleForNewAnnotation` is untouched.** A newly drawn Annotation still takes the last one's style
  (ADR-0009, as amended). This ticket changes when a tool disarms, not what a shape is drawn with.
- The announcement region keeps announcing the tool by name and the gesture, and keeps being
  `aria-live` rather than `role="status"` — the save indicator owns that role on this page.
- After finishing, the announcement says what happened (an Annotation was added) rather than falling
  silent, because the tool changing under someone is a change they are owed.

## User Stories

- **11.** As an author, I want the list of Annotations to stay visible while I draw, so that "what is
  already in this Layer" is not hidden exactly when I am adding to it.
- **36.** As an author, I want New Annotation to offer the three shapes without hiding the list, so that
  starting a new one does not take away the ones I have.
- **37.** As an author, I want finishing a shape to return everything to rest, so that I am never in
  drawing mode with nothing being drawn.
- **38.** As an author, I want the tool disarmed once the shape is finished, so that my next click on
  the map selects rather than draws.
- **39.** As an author, I want one press of New Annotation to make one Annotation, so that the surface's
  state is something I set rather than something I discover.
- **40.** As an author, I want the Annotation I just drew selected with its title ready to type, so that
  titling a shape straight after drawing it is one gesture.
- **41.** As an author, I want to cancel a gesture in progress from the keyboard and from a button, so
  that abandoning a half-drawn shape is not a thing only Escape can do.
- **42.** As an author, I want the tool and the gesture announced as words, so that which tool I am
  holding does not depend on seeing a highlight.

## Out of scope

- **The Annotation Inspector.** It does not exist yet. The drawn Annotation's title field is wherever it
  is today — inside the open row.
- **Anything about where an Annotation's content is read.** Tickets 05–08.
- **Adding a *Draw another* control.** The spec names it as the repair *if* drawing runs prove painful.
  It is not built here and not built speculatively.
- **Reinstating tool stickiness** in any form, including a preference. The decision is taken.
- Changing `addDrawn`, `styleForNewAnnotation`, or anything about what is written to the file.
- The place search beside the tools, and what a Place drops.

## Acceptance criteria

- [ ] `Drawing.finish()` and `Drawing.cancel()` leave `tool === 'select'`, asserted at the editor's node
      seam against the state machine directly.
- [ ] `grep -rn "choosing" apps/editor/src` returns nothing.
- [ ] `grep -rn "annotation-drawn" apps/editor/src e2e` returns nothing.
- [ ] With the shapes showing, the Annotation list and its caption are still in the DOM — asserted at
      the component seam.
- [ ] After finishing a shape in a real browser: the resting *New Annotation* button is showing, the
      shape buttons are not, `data-tool` reads `select`, `data-drawing` reads `false`, the new
      Annotation is selected, and the focused element is its title field.
- [ ] Drawing a second shape requires pressing *New Annotation* again — a click on the map after
      finishing selects and does not draw.
- [ ] A cancelled gesture leaves the tool at `select` too.
- [ ] The announcement region reports the shape was added rather than going empty.
- [ ] Each retired browser assertion is named alongside its replacement in the commit message.
- [ ] `pnpm precommit lint check test` passes, and `pnpm test:e2e editor-annotations.e2e.ts` passes.

```bash
cd /home/dflood/repos/ballastella
pnpm --filter @ballastella/editor exec vitest run --project editor
pnpm --filter @ballastella/editor exec vitest run --project editor-dom
grep -rn "choosing" apps/editor/src || echo "clean"
grep -rn "annotation-drawn" apps/editor/src e2e || echo "clean"
pnpm precommit lint check test
pnpm test:e2e editor-annotations.e2e.ts
```

Success: both greps print `clean`, both editor projects are green, `precommit lint check test` exits 0,
and `editor-annotations.e2e.ts` exits 0.

## Blocked by

None — can start immediately.
