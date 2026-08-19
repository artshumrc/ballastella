# Place a Label and type its words

## Parent

[SPEC.md](../SPEC.md) — "The word", "`marker-symbol` stops being inherited by a newly drawn
Annotation", "The editor's surfaces".

## What to build

An author presses *New Annotation*, chooses **Label**, clicks the map, and types. The words appear on
the map as they are typed, and the Layer's GeoJSON gains a Point carrying
`marker-symbol: "label"` and the title.

The tool puts itself down when the Label is placed, exactly as the Pin's does — one press of *New
Annotation*, one Annotation.

And the carve-out that makes the tool mean anything: **drawing a Pin straight after a Label produces
a Pin.**

## Where to start

- `apps/editor/src/lib/annotations/drawing.svelte.ts` — `AnnotationTool`, `MINIMUM_VERTICES`,
  `TOOL_NAMES`, `place()`, `geometry()`, and `status`. A Label's gesture is the Pin's: one vertex,
  complete on placement.
- `apps/editor/src/lib/annotations/AnnotationTools.svelte` — the `SHAPES` array is the whole of the
  toolbar's contents; the button, its glyph, its pressed state and its keyboard reach all follow from
  adding to it.
- `apps/editor/src/lib/annotations/annotation-editing.svelte.ts` — `placePoint()` and `#addDrawn()`.
  `#addDrawn` mints the Annotation, applies `styleForNewAnnotation`, selects it, and sets `titlingId`
  so the Inspector opens with the keyboard in the title field. That last part is why "click and type"
  is already one gesture and needs nothing new.
- `packages/core/src/annotation/annotation.ts` — `styleForNewAnnotation`, and the `STYLE_NAMES` list
  it copies from.
- `docs/adr/0009-annotations-use-simplestyle-spec.md` — the note goes at the end, after the existing
  amendment.
- Ticket 02 added `LABEL_MARKER_SYMBOL`, `isLabel`, and the `text` entry in the shared glyph table.
  Adding `'text'` to `AnnotationTool` should now compile against that table without touching it.

## Contract

**The tool is `'text'` in the union and *Label* everywhere a person reads it.** The union's other
members are `'point'`, `'line'`, `'polygon'` — geometry words — and the shared glyph table is already
keyed by them. The button, the status line and every announcement say "Label".

**One vertex, and the gesture completes on placement**, like the Pin: `place()` returns the finished
geometry and the state machine goes to rest.

**`marker-symbol` is written by the creation path and never inherited.** Remove `'marker-symbol'`
from the set `styleForNewAnnotation` copies, and have the creation path write
`marker-symbol: LABEL_MARKER_SYMBOL` for the Label tool and nothing for the other three.

```
styleForNewAnnotation copies:  marker-size, marker-color, stroke, stroke-opacity,
                               stroke-width, fill, fill-opacity, stroke-dasharray
                    and not:   marker-symbol
```

Colour, size and opacity keep inheriting across kinds — a scholar who picks red keeps red whatever
they draw next, which is the rule ADR-0009's amendment already chose. What stops inheriting is only
the property that says *what kind of thing this is*.

A consequence to state in the code and accept: a `marker-symbol` from another tool (`"harbor"`,
`"7"`) is no longer copied onto the next Annotation drawn. It stays on the Annotation that has it and
is still written back untouched.

**One write per placement** (ADR-0017 rule 1). A Label is created with its style and no title, and
the title arrives through the existing coalesced text write — the same two-step a Pin drawn by hand
already takes. Do not add a write.

**ADR-0009 gains a short section** recording the convention: a Label is a Point whose `marker-symbol`
is `label`; its words are `title`, its text colour `marker-color`, its background `fill` and
`fill-opacity`, its size `marker-size`. State plainly that this is **not** an amendment — no property
is added and none changes meaning — and why `marker-symbol` was chosen over a namespaced property.

**`CONTEXT.md` gains the glossary entry** for **Label**, with the avoid-list from the spec: text,
caption, marker, title, annotation text.

## User Stories

1. As an author, I want a fourth tool beside Pin, Line and Shape called Label, so that writing on the
   map is something the tool offers rather than something I have to improvise.
2. As an author, I want the Label tool to be reached the same way as the other three — press *New
   Annotation*, then choose — so that there is one way to start an Annotation and not two.
3. As an author, I want placing a Label to take one click, so that it costs what placing a Pin costs.
4. As an author, I want the keyboard to land in the Label's text field the moment it is placed, so
   that clicking and typing is one gesture.
5. As an author, I want the Label tool to put itself down when the Label is placed, so that one press
   of *New Annotation* makes one Annotation, as it already does for the other three shapes.
6. As an author, I want to abandon a Label mid-gesture with Escape or Cancel, so that a misclick is
   not something I have to delete afterwards.
7. As an author, I want the status region to name the Label tool and say what to do with it, so that
   which tool I am holding is not information available only by looking at a highlight.
8. As an author, I want a placed Label announced as added, so that a screen reader tells me the
   gesture completed.
9. As an author, I want to place a Label with the keyboard alone, so that the map pane is operable
   without a pointer, as it already is for every other vertex in this application.
10. As an author, I want to type the words that are drawn on the map, so that a Label says what I mean
    rather than what a lookup guessed.
16. As an author, I want editing a Label's text to redraw it on the map as I type, so that I can see
    the words land where I meant them.
26. As an author, I want drawing a Pin after a Label to give me a Pin rather than another Label, so
    that the tool I chose is what I get.
47. As an author, I want a Label written as an ordinary GeoJSON Point with simplestyle properties, so
    that my Workspace stays a set of files other tools can read.
63. As an author using a screen reader, I want the Label tool's button, its status line, and its text
    field all named, so that the feature is not a silent region of the toolbar.

## Out of scope

- **The Text face's own shape.** The field a placed Label opens into is still the existing title
  field, captioned as it is today. Renaming it, removing the description control, and the
  empty-Label sentence are all ticket 05.
- **The Style face.** A new Label inherits whatever the last Annotation had. Offering a Label's own
  controls is ticket 04.
- **A default title.** A placed Label has no `title` property until the author types one. Do not seed
  placeholder words nobody typed.
- **Changing how the other three tools behave.** The status wording, the disarm rule, and the
  `titlingId` handoff are all reused, not rewritten.
- **The delete/undo path.** It already works for any Annotation; ticket 06 asserts it.
- Do not touch `styleForNewAnnotation`'s "last one drawn" rule. Only `marker-symbol` leaves the
  copied set.

## Acceptance criteria

- [ ] The toolbar offers four shapes; the fourth is named *Label* and carries the glyph from the
      shared table.
- [ ] The drawing state machine finishes the Label tool on one vertex, returns a `Point` geometry, and
      goes to rest with the tool disarmed.
- [ ] `styleForNewAnnotation` does not copy `marker-symbol` — asserted from a Label (the next
      Annotation is not a Label) and from a foreign `"harbor"` — while `marker-color`, `fill`,
      `fill-opacity`, `marker-size`, `stroke*` still are.
- [ ] In a browser: choose Label, click the map, type "Zuiderzee"; the words draw at that point and
      `annotations/<layer>.geojson` carries a Point with `marker-symbol: "label"` and
      `title: "Zuiderzee"`.
- [ ] In a browser: with a Label as the last Annotation drawn, choosing Pin and clicking produces a
      Point with **no** `marker-symbol`, drawn as a pin.
- [ ] In a browser: placing a Label costs exactly one Annotation write, and typing its text coalesces
      into one more.
- [ ] In a browser: the whole gesture — reach the tool, place, type — is completed with the keyboard
      alone.
- [ ] The status region names the Label tool and says what to do with it, and says a Label was added
      after placing.
- [ ] `docs/adr/0009-…` carries the convention note and `CONTEXT.md` carries the **Label** glossary
      entry.

```bash
pnpm --filter @ballastella/core exec vitest run --project node -t "styleForNewAnnotation"
pnpm --filter @ballastella/editor test
pnpm test:e2e editor-annotations
pnpm precommit
```

Success: all green, and the new e2e cases are named in the `editor-annotations` output.

## Blocked by

- Ticket 02 — the renderer, the discriminator, and the glyph table entry.
