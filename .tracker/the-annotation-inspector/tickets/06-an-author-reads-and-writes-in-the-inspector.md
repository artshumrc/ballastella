# 06 — An author reads and writes an Annotation in the Inspector

## What to build

The epic's central switch, in the editor only.

An Annotation's row stops revealing anything. It selects, and the Annotation itself is read in the
Annotation Inspector, docked over the top-right of the Base Map pane. `AnnotationEditor` is dissolved:
its resting text becomes the Inspector's **Text** face — `AnnotationReading` plus *Edit text* and
*Delete* — and its style groups become the **Style** face. Because the editor passes both faces, the
editor gets the tab strip; Text shows on every selection and the strip remembers nothing.

The viewer is untouched and stays green: `AnnotationRow` keeps its `contents` snippet, and the viewer
keeps passing it. This is the expand half of expand–contract. Ticket 08 does the contract.

## Where to start

- `apps/editor/src/lib/annotations/AnnotationEditor.svelte` — the component being dissolved. Its two
  halves separate at the `<fieldset>` whose legend is "Style". **Read the whole file first**: the
  `shown` guard, the `editingText`/`finishText` pair, the argument for text-until-asked, the note on why
  `{@html}` is correct there and only there, and the measured reasons behind the fixed slider widths and
  the grouped fieldsets. All of that reasoning survives; only its address changes.
- `apps/editor/src/lib/annotations/AnnotationLayerContents.svelte` — the `contents` snippet passed to
  `AnnotationList`. Ticket 03 has already deleted the `choosing` branch, so this file is smaller than
  the git history suggests.
- `apps/editor/src/lib/project/ProjectScreen.svelte` — the `relative flex min-h-0 grow` container that
  the sidebar, the map column and `LeaderLine` all live in; the `w-96` sidebar; the map column bound as
  `mapColumn`; and the `annotationContents` snippet handed to `LayerList`. The Inspector's dock goes
  inside the **map pane's** own positioned container, not this one.
- `apps/editor/src/lib/base-map/BaseMapPane.svelte` — `<div class="relative h-full w-full">` wrapping the
  map container, with the `PlaceSearch` overlay at `absolute top-2 left-2 z-10 w-72`. Ticket 04 has
  already cleared the top-right corner.
- `apps/editor/src/lib/annotations/annotation-editing.svelte.ts` — `selectAnnotation`, `selectedAnnotation`,
  `openLayer`, `styleSelected`, and the text/commit/delete methods. **The write path does not change**;
  it is re-wired to new call sites.
- `packages/ui/src/AnnotationRow.svelte` and `AnnotationList.svelte` — `contents` stays, and the editor
  stops passing it.
- `packages/ui/src/layout.css` — the leader at `z-index: 5` and MapLibre's control corners forced to `6`,
  with the comment explaining why those numbers are compared in one shared stacking context.
- `apps/editor/src/lib/annotations/annotation-editor.dom.test.ts` and
  `annotation-layer-contents.dom.test.ts` — the tests that move or retire.
- `e2e/editor-annotations.e2e.ts` — the describe blocks "title and description (SPEC stories 62 and 67)"
  and "drawing into the Layer that is open (ticket 05)".

## Contract

- **The editor passes both snippets.** `text` renders `AnnotationReading` plus *Edit text* and *Delete*;
  `style` renders the Pin, Fill and Line groups with `ColorPicker` and `LineStylePicker` **unchanged**.
- **`AnnotationEditor.svelte` is deleted**, not left importable. Its text-until-asked behaviour moves
  into the Text face intact, including the `shown` id-guard that stops a save mid-sentence from
  slamming the fields shut. That guard's reason applies to the Text face exactly as it applied here.
- **`AnnotationReading` becomes the editor's resting text too.** This is what fixes the untitled
  contradiction at source: the editor stops drawing a bare "Untitled" of its own.
- **An Annotation whose geometry this build cannot draw is passed no `style` snippet at all**, so it has
  no Style tab. Do not pass a snippet that renders the "cannot draw this shape" sentence — that is a tab
  that opens on an explanation of its own emptiness. The sentence belongs in the Text face if it belongs
  anywhere.
- **Delete lives in the Inspector's Text face.** Not on the row, and not in the Layer card's footer beside
  *Delete Layer*, which would put two deletes of different scope in one card. It stays undoable and keeps
  having **no confirmation dialog** (ADR-0014).
- **The dock.** Absolutely positioned inside the Base Map pane's own `relative` container:
  top-right-inset, a fixed comfortable width with `max-width` so it cannot exceed a narrow pane, and
  `z-index: 7`. **The number is load-bearing**: the leader is 5 and MapLibre's control corners are forced
  to 6 precisely so the leader cannot be drawn across them, and all three are compared in one stacking
  context because `.maplibregl-map` opens none. 7 is one clear of the controls.
- **`aria-expanded` stays on the row and gains `aria-controls` naming the Inspector's id.**
  `aria-controls` does not require containment, so the disclosure semantics survive the region moving
  across the screen. Still no `aria-pressed`.
- **The row's revealed region is gone in the editor** — the editor passes no `contents`. Do not yet
  delete `contents` from the shared components; the viewer still uses it.
- **The write path is unchanged.** Typing still coalesces into one write per file, and `oncommit` is
  still a no-op unless something is pending, so tabbing through an untouched field must not restamp
  `updatedAt` (ADR-0010, ADR-0017).
- **Every Style control stays a native element** — radios for the colours, the line style and the pin
  size, `<input type="range">` for the opacities — and keeps resolving against simplestyle's own defaults
  and nothing else.
- **No stored file changes.** No migration, no rewrite because a Project was opened.
- Focus: pressing a row leaves the keyboard on the row. Dismissing the Inspector, or deleting the
  Annotation it describes, returns focus to a row in the list rather than to `document.body` —
  `LayerList`'s `deleteByButton` is the existing precedent for why that matters.

## User Stories

- **1.** As an author, I want the Annotation I selected to be named in the panel that describes it, so
  that which one I am looking at is never something I have to infer.
- **2.** As an author, I want the panel's ordinal, glyph and shape word to be the same ones its row and
  its mark carry, so that "look at 3" identifies one Annotation across a desk.
- **3.** As an author, I want an untitled Annotation to read as the same "Untitled shape 3" in the panel
  as in its row, so that the two surfaces never contradict each other.
- **4.** As an author, I want the Annotation's title to appear once rather than twice a few pixels apart,
  so that I am not left wondering whether the second one is a different field.
- **10.** As an author, I want an Annotation's row to select it without opening anything, so that the
  list stays the same length however much any one Annotation has to say.
- **15.** As an author, I want the panel docked over the map rather than beside it, so that the map does
  not lose a column of width permanently for a panel that is often empty.
- **16.** As an author, I want the panel to be as tall as its content and no taller, so that a short
  Annotation does not reserve a screen's height to say two sentences.
- **20.** As an author, I want to dismiss the panel, so that I can have the whole map back without
  deselecting my place in the list.
- **23.** As an author, I want no swatch and no slider on screen until I ask for one, so that selecting an
  Annotation to read it does not put an authoring form in front of me.
- **24.** As an author, I want the Style face beside the map, so that the control and the change it makes
  are in the same glance.
- **25.** As an author, I want the Style face to open on a deliberate press, so that styling is something
  I reach for rather than something I dismiss.
- **26.** As an author, I want the Text face shown every time I select an Annotation, so that the panel
  never opens on the previous Annotation's swatches.
- **27.** As an author, I want a newly drawn Annotation to take the last one's style, so that picking a
  colour once styles the run I am about to draw.
- **28.** As an author, I want an Annotation whose shape this build cannot draw to have no Style face at
  all, so that I am not offered a tab that opens on nothing.
- **29.** As an author, I want the Style face to show what the file says rather than what it inherits, so
  that a control never reports a value from somewhere I cannot see.
- **30.** As an author, I want to edit the title and description where I am reading them, so that
  correcting a sentence does not mean finding another surface.
- **31.** As an author, I want to delete an Annotation from the panel that describes it, so that the
  delete is next to the thing it destroys.
- **32.** As an author, I want a delete I regret to be undoable, so that there is a way back without a
  confirmation dialog in the way of every deliberate one.
- **33.** As an author, I want typing to coalesce into one write per file, so that a sentence is one save
  rather than forty.
- **34.** As an author, I want tabbing through a field I did not type in to write nothing, so that
  reading my own Project does not restamp it.
- **35.** As an author, I want the fields to stay open while I type a whole sentence, so that a save
  landing mid-word does not shut them.
- **53.** As a keyboard user, I want the row to say that it controls the panel and whether the panel is
  showing, so that the region I opened is announced rather than merely drawn.
- **55.** As a keyboard user, I want to reach the panel from the row and get back to the list, so that the
  panel is not a place the keyboard falls into.
- **56.** As a keyboard user, I want focus to land somewhere useful when the panel closes or its
  Annotation is deleted, so that I am not returned to the top of the document past the map's own
  controls.
- **59.** As a keyboard user, I want every control in the Style face to be a native element, so that
  nothing here has to be made operable afterwards.
- **75.** As a maintainer, I want the stored file untouched by this change, so that a Project written
  before it opens after it with no migration and no rewrite.

Stories 27, 29, 32, 33, 34, 35 and 59 are **already true**. They are on this ticket because it moves the
code that makes them true, and what it owes them is that the existing assertions still pass — repointed
where the control moved, never deleted.

## Out of scope

- **The viewer.** It keeps opening rows and keeps passing `contents`. Ticket 08.
- **Deleting `contents`, `keepInView`, `scrollSettled`, `scrollingAncestor`, the slide, or
  `data-reveal-ms` from the shared components.** Ticket 08, once neither app passes `contents`. Deleting
  them here breaks the viewer.
- **`easeTo` camera padding, `max-height` with internal scroll, and the leader's z-order under the
  panel.** Ticket 07. Those are the claims that need a real viewport, and bundling them here makes this
  ticket unlandable.
- **The phone layout.** Ticket 09. The editor still has no breakpoint and does not get one here.
- **Bulk restyle.** *Apply to all in this Layer* is not built. Build the Style face so adding it later
  needs no rearrangement, and add nothing.
- **New metadata fields.** The Inspector makes room; it defines nothing.
- **Making the Inspector draggable or resizable.** It is docked.
- **Changing `ColorPicker` or `LineStylePicker`**, the nine colours, the three pin sizes, or the three
  line styles.
- **Moving the Annotation list out of the Layer card** (story 12, ticket 02). Membership stays in the
  stack; that is the whole design.
- Touching `annotation-editing.svelte.ts`'s write methods, `styleForNewAnnotation`, or `addDrawn`.

## Acceptance criteria

- [ ] `apps/editor/src/lib/annotations/AnnotationEditor.svelte` no longer exists, and nothing imports it.
- [ ] In a real browser, selecting an Annotation in the editor: its row wears the wash and no region
      opens inside it; the Inspector appears over the Base Map pane's top-right; its header shows the
      same ordinal, glyph and shape word as the row; and an untitled Annotation's name is identical in
      both places.
- [ ] A titled Annotation's title appears **once** on the screen in the Inspector, not twice.
- [ ] The tab strip shows Text and Style. Text is showing on selection; after switching to Style and
      selecting a different Annotation, Text is showing again.
- [ ] With Text showing, no colour swatch and no range input exists anywhere in the Inspector.
- [ ] Selecting an Annotation with an undrawable geometry renders no Style tab.
- [ ] The row carries `aria-expanded` and an `aria-controls` whose value is the Inspector's id;
      `grep -rn "aria-pressed" packages/ui/src apps/editor/src` returns nothing for the row.
- [ ] Dismissing the Inspector leaves the selection alone in the list and puts focus on a row, not
      `document.body`. Deleting the Annotation does the same.
- [ ] *Edit text* opens the fields, a whole sentence can be typed without them closing, and the existing
      one-write-per-gesture browser assertions still pass unchanged in intent.
- [ ] Tabbing through an untouched field writes nothing — the existing assertion still passes.
- [ ] Deleting an Annotation from the Inspector is undoable.
- [ ] The Inspector renders above MapLibre's controls and the leader; the leader is not drawn across it.
- [ ] Every retired browser or component assertion is named alongside its replacement in the commit
      message.
- [ ] `pnpm precommit` passes in full.

```bash
cd /home/dflood/repos/ballastella
ls apps/editor/src/lib/annotations/AnnotationEditor.svelte 2>&1 | grep -q "No such file" && echo "deleted"
grep -rn "AnnotationEditor" apps/editor/src e2e || echo "clean"
pnpm --filter @ballastella/editor exec vitest run --project editor-dom
pnpm --filter @ballastella/ui test
pnpm test:e2e editor-annotations.e2e.ts
pnpm test:e2e viewer-reader.e2e.ts
pnpm precommit
```

Success: the component is gone, the grep prints `clean`, both e2e specs exit 0 — **including
`viewer-reader.e2e.ts`, which proves the viewer is still whole** — and `pnpm precommit` exits 0.

## Blocked by

- 01
- 02
- 03
- 04
- 05
