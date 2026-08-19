# A Label in a Layer is drawn on the map

## Parent

[SPEC.md](../SPEC.md) — "A Label is a Point whose `marker-symbol` is `label`", "What is drawn",
"The background chip", "Where a Label is, for everything that points at it", "What the structure key
knows".

## What to build

A Layer whose GeoJSON already contains a Label draws that Label's words on the map, on a coloured
chip, at the place the Point names — in the editor and in the viewer, because the code that draws it
is shared.

Nothing in this slice creates a Label. The Label arrives in the file, seeded by the test, and this
slice is everything between the file and the pixels: the discriminator, the render bucket, the chip,
hit-testing, selection, the leader line's aim, the row's glyph and word, and the vertex handle that
moves it.

A Pin must keep drawing as a Pin and must **not** also draw as a Label, and a Label must not also
draw a pin.

## Where to start

- `packages/core/src/annotation/annotation.ts` — `MARKER_SIZES`, `resolveStyle`,
  `annotationAnchor`, `simpleStyleViolations`. The discriminator constant and `isLabel` go here.
- `packages/core/src/annotation/render.ts` — `toRenderCollection`. It resolves style onto a render
  copy; `marker-symbol` already survives `resolveStyle`, so check rather than assume.
- `packages/core/src/render/stack-layers.ts` — `annotationLayers()` (the `fill`, `line-*` and `point`
  buckets and their filters), `whatItContains()`, `annotationDrawKey()`, `annotationLayerIds()`,
  `ensurePinImage()`, and `drawLayerStack`'s per-Layer loop. Read the header comment on
  `annotationLayers` about why only the buckets a Layer needs are added.
- `packages/core/src/render/pin-icon.ts` — the model for the new chip module: generate an `ImageData`
  on a canvas, export the id and the pixel ratio, return `null` where there is no canvas.
- `packages/core/src/render/annotation-mark.ts` — `annotationMarkBox()`, which currently gives every
  Point the pin's extent anchored at its tip.
- `packages/ui/src/annotation-name.ts` (`shapeWord`) and `packages/ui/src/shape-icons.ts`
  (`TOOL_ICONS`, `iconForGeometry`).
- `e2e/support/annotations.ts` — `seedAnnotationProject`, `writeProjectFile`, `annotationLayerId`,
  `waitForStack`, `baseMap`, `clickAt`, `selectAnnotation`, and the `StackMap` handle.
- Ticket 01's `## Answer` decides the chip's design. Read it before writing the chip.

## Contract

**The discriminator, in `core`, read nowhere else by literal.**

```ts
/** What a Point's `marker-symbol` says when the marker shows its own words. */
export const LABEL_MARKER_SYMBOL = 'label';

/** Whether this Annotation is a Label: a Point that draws its `title` on the map. */
export const isLabel = (annotation: Annotation): boolean => …;
```

`isLabel` takes an `Annotation`. Three places outside `core` may read it and no others: the shape
word, the glyph lookup, and (in a later ticket) the editor's faces. The renderer reads the property
directly inside its filter expressions, because a MapLibre filter is not a function call.

**The Label bucket**, added beside `fill`, `line-*` and `point`, at `stackLayerId(layerId, 'label')`:

```
type: 'symbol'
filter: ['all', ['==', ['geometry-type'], 'Point'],
                ['==', ['get', 'marker-symbol'], 'label']]
layout:
  'text-field': ['get', 'title']
  'text-font':  ['Noto Sans Regular']
  'text-size':  ['match', ['coalesce', ['get','marker-size'], 'medium'],
                 'small', …, 'large', …, /* medium */ …]
  'icon-text-fit': 'both'
  'text-allow-overlap': true, 'icon-allow-overlap': true,
  'text-ignore-placement': true, 'icon-ignore-placement': true
paint:
  'text-color': ['get', 'marker-color']
  … plus the chip's own image, colour and selection paint, per ticket 01's Answer
```

**The `point` bucket's filter gains the negation**, or every Label also draws a pin:

```
filter: ['all', ['==', ['geometry-type'], 'Point'],
                ['!=', ['get', 'marker-symbol'], 'label']]
```

`['get','marker-symbol']` is `null` on a feature that has none, and `['!=', null, 'label']` is true,
so an ordinary Pin is unaffected. Assert that rather than trusting it.

**`whatItContains`** gains `hasLabel`, and `hasPoint` narrows to "a Point that is not a Label", so a
Layer of Labels alone adds no pin layer and a Layer of Pins alone adds no symbol layer.
**`annotationDrawKey`** gains the bucket. **`annotationLayerIds`** gains it too — a bucket absent from
that list is a mark nobody can click, in either app.

**Text sizes** are ours, as the Pin's are: three values in the new chip module beside the image, named
so the ratios are visible. `marker-size` absent resolves to medium, which is what the Pin already does.

**The mark box.** A Label is centred on its coordinate and has no pin, so `annotationMarkBox` returns
its anchor point — a zero-size box, as a Line and a Shape already get — rather than the pin's extent.
This is the leader line's aim and it is the second place `isLabel` is read.

**The word and the glyph.** `shapeWord` answers `'label'`. The glyph lookup stops taking a geometry
type and takes the whole `Annotation`, so it can read `isLabel`; `TOOL_ICONS` gains a `text` entry
(the union that types that table is what makes a later ticket's tool addition fail to compile if the
glyph is missing). Lucide's `Type` is the glyph.

**An empty `title` draws nothing**, by `text-field` resolving to nothing. Do not write a filter for it.

## User Stories

14. As an author, I want my Label's text to be the name it carries in its row and in the Inspector's
    header, so that the map, the list and the panel cannot disagree about which Annotation is which.
18. As an author, I want my Label's text drawn as text and never parsed as markup, so that an
    apostrophe or an angle bracket in a place name is a character rather than a hazard.
28. As either app's user, I want a Label's words drawn at the place they belong to, so that the map
    reads as a map rather than as a legend.
29. As either app's user, I want a Label drawn over the Layers below it and under the Layers above it,
    so that the stack's order means the same thing for a Label as for everything else.
30. As either app's user, I want two Labels close together both drawn, so that the application never
    quietly discards one of them for tidiness.
31. As either app's user, I want to click a Label on the map to select it, so that a Label is reached
    the same way a Pin is.
32. As an author, I want the selected Label emphasised on the map, so that the row I opened and the
    thing on the map are visibly the same Annotation.
33. As an author, I want the leader line to run from my selected Label to its row, so that the
    connection I already rely on is not lost for the new kind.
34. As an author, I want to drag a Label to a new place, so that a name put down in the wrong spot is
    moved rather than remade.
35. As an author, I want to nudge a Label's position with the arrow keys, so that fine placement does
    not need a steady hand.
36. As an author, I want moving a Label to cost exactly one write when the gesture ends, so that
    dragging does not thrash the Workspace.
37. As either app's user, I want a Label's background to grow with its words, so that a long name is
    not clipped by a box sized for a short one.
38. As either app's user, I want a Label to keep its size as I zoom, so that it stays readable at every
    scale rather than growing into the map.
39. As either app's user, I want a Label to carry a glyph of its own in its row and in the Inspector's
    header, so that a list of mixed Annotations says what each one is.
40. As either app's user, I want a Label called a "label" in the words beside that glyph, so that the
    glyph is never alone with the meaning.
41. As an author, I want an untitled Label to read as "Untitled label 3", numbered by the same ordinal
    its row and the Inspector draw, so that one Annotation has one number.
61. As either app's user, I want a Label whose text is empty to draw nothing rather than an empty
    coloured box, so that the map carries no marks nobody made.
64. As either app's user, I want a Label's row to announce its kind, so that "which of these is a
    Label" does not depend on seeing a glyph.

## Out of scope

- **The Label tool.** Nothing in `apps/editor/src/lib/annotations/drawing.svelte.ts`,
  `AnnotationTools.svelte` or `annotation-editing.svelte.ts` changes here. Adding `'text'` to
  `AnnotationTool` is ticket 03's, and the `TOOL_ICONS` entry added here is what will make that
  addition compile.
- **The Style face and the Text face.** A Label seeded by a test already carries colours; no control
  for them is added here.
- **`styleForNewAnnotation`.** The inheritance carve-out belongs to ticket 03, which is where a Label
  first gets created by the app.
- **The glyph question.** A Published Site that carries no typefaces is ticket 09. Do not add the
  `map.getStyle().glyphs` guard here; the editor and a modern site both have glyphs.
- **`ADR-0009`.** Ticket 03 writes the note, beside the creation path that establishes the convention.
- Do not rename `iconForGeometry`'s callers beyond what taking an `Annotation` forces. `AnnotationRow`
  and `AnnotationInspector` both call it; both already hold the whole Annotation.

## Acceptance criteria

- [ ] `isLabel` answers true for a Point with the symbol and false for: a Point without one, a Point
      with a different symbol, a LineString, a Polygon, a foreign geometry, and a `null` geometry.
- [ ] `simpleStyleViolations` reports **nothing** for a Label's properties — the whole of the "no new
      extension" claim, in one assertion.
- [ ] `whatItContains`/`annotationDrawKey`: a Layer of Labels asks for the Label bucket and not the
      point bucket; a Layer of Pins asks for the point bucket and not the Label bucket; a Layer with
      both asks for both; and the key **does not change** when a Label's text, colour or size changes.
- [ ] `annotationLayerIds` includes the Label bucket.
- [ ] `annotationMarkBox` for a Label is its anchor point, not a pin-sized box.
- [ ] `shapeWord` answers "label", and an untitled Label reads "Untitled label 3" — asserted in
      `packages/ui`, so neither app can differ.
- [ ] In a browser: a seeded Label draws, `queryRenderedFeatures` at its point returns it from the
      Label bucket, and a seeded Pin in the same Layer returns from the point bucket and **not** from
      the Label bucket.
- [ ] In a browser: a seeded Label whose `title` is `""` returns nothing rendered at its point.
- [ ] In a browser: a seeded Label with a long title draws a chip wider than one with a short title.
- [ ] In a browser: clicking a Label selects it, its row shows selected, and the leader line is drawn.
- [ ] In a browser: dragging the selected Label's vertex handle moves it and records exactly one
      Annotation write.
- [ ] A seeded title containing `<img src=x onerror=…>` appears on the map as those characters and
      produces no element in the DOM.

```bash
# Seam 1
pnpm --filter @ballastella/core exec vitest run --project node -t "label"
pnpm --filter @ballastella/ui test

# Seam 2
pnpm test:e2e editor-annotations

# Everything
pnpm precommit
```

Success: all four green, and `pnpm test:e2e editor-annotations` includes the new Label cases by name.

## Blocked by

- Ticket 01 — its `## Answer` decides how the chip is built.
