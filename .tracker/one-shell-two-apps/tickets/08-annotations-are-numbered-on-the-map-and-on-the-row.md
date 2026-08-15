# Annotations are numbered, on the map and on the row

## Parent

[SPEC.md](../SPEC.md)

## What to build

Give every Annotation an ordinal, drawn both on its mark on the map and on its row in the sidebar, so
that "look at 3" identifies one thing across a desk — and so that the connection between the canvas
and the sidebar reaches somebody who cannot see a line.

The same numbering in both apps, from the same rule, so a scholar's written reference to "3" matches
what a Reader sees.

## Where to start

- `apps/editor/src/lib/overlay/overlay-points.ts` — how a point becomes a DOM element for MapLibre,
  and how a Control Point already gets its ordinal drawn *inside* it.
- `apps/editor/src/routes/layout.css` — `.pane-overlay-point-control-point` is the prior art: a
  numbered, focusable marker with the ordinal as text, because ADR-0022 wanted "look at point 7" to
  work over a student's shoulder. An Annotation's marker should read as a sibling of it, not a
  reinvention.
- `packages/core/src/render/` — where an Annotation Layer's features become map layers. Find where a
  Pin's marker is produced before deciding whether the ordinal is a symbol layer or a DOM overlay.
- The shared Annotation list in `packages/ui`, as ticket 06 left it.

## Contract

**An ordinal is the index of an Annotation within its collection, plus one.** It is derived at render
time from the order the collection already has.

⚠ **Display state, never written** ([ADR-0002](../../docs/adr/0002-display-state-separate-from-portable-documents.md)).
No GeoJSON feature gains an `id`, a `properties` entry, or any other byte from this. Deleting an
Annotation renumbers the ones after it by re-rendering, not by writing. A test must prove that
drawing, selecting, and deleting Annotations leaves the Layer's `.geojson` byte-identical to what the
same actions produce today.

**The same ordinal on both surfaces.** One rule, computed once and passed to both the list and the
map, so the two cannot disagree.

**Legibility is not optional.** The ordinal is small text on a coloured mark; it must meet contrast
against the mark's own fill in both themes, using theme tokens rather than literals — the same
constraint `layer-kind-style.ts` and the `--layer-problem-ink` mix were written for. Measure it;
do not assume the token pair works.

**The ordinal is not the only channel and not the only label.** The row keeps its name and its shape
word; the marker keeps whatever accessible name it has. A number is added, nothing is replaced.

**A line and a polygon get an ordinal too**, not only a Pin. Where a shape's ordinal is anchored is a
decision to make and record — a label point that is stable as the map moves, not the first vertex.

### User Stories

37, 38, 42, 43

## Out of scope

- **Do not draw a leader line.** Ticket 12. This ticket makes the leader possible by giving both ends
  a shared identity; it does not draw one.
- **Do not number Control Points on their rows.** Ticket 10 — they are already numbered on the panes.
- **Do not change the Annotation ordering rule** or offer any way to reorder Annotations.
- **Do not write anything to a file.**
- **Do not change the marker's colour, size or style controls.**

## Decisions taken

### The ordinal is a DOM marker, not a symbol layer

`packages/core/src/render/annotation-ordinals.ts` creates one MapLibre `Marker` per drawn Annotation,
built inside `drawLayerStack` so both apps get it from the one call they both already make. A
`text-field` on a symbol layer beside the pin was the obvious answer and is wrong for three reasons,
the first of which is decisive:

- **MapLibre text needs a glyph source and a Published Site is allowed not to have one.**
  `ReaderMapPane.styleFor` deletes `glyphs` and filters *every* symbol layer out of the style for a
  site published without its Base Map files, recording that nothing the Layer stack draws needs them.
  A `text-field` ordinal would be silently absent for exactly those Readers — no error, no missing
  image, just no numbers. `viewer-reader.e2e.ts`'s "says so when the site carries no copy of the Base
  Map's labels and symbols" now asserts the number is still there, which is that decision's guard.
- **A MapLibre paint value is not CSS**, so it cannot be `var(--color-info)` and cannot be the
  `oklch()` behind it either. A DOM element reads the theme's own custom properties directly.
- **The prior art for a numbered mark here is a DOM element** — `.pane-overlay-point-control-point`.

Its cost, accepted: one DOM node per drawn Annotation, repositioned by MapLibre on every map move —
the arrangement the alignment route already runs with its Control Points.

### A line's and a shape's ordinal is anchored at the middle of the geometry's extent

`annotationAnchor`'s answer, reused rather than reinvented: it is already where the Annotation's
popup points, so the number, the popup and (ticket 12) the leader name one point instead of three. It
is a pure function of the coordinates, so it is the same place at every zoom and every centre.

The alternatives, and why not: the **first vertex** puts a label at the end of a coastline or in a
corner of a parish and reads as belonging to the vertex; **letting MapLibre place the symbol** is
computed per *tile* for a polygon, so the label moves as the map is zoomed and the shape is clipped
differently. Its known limit is `annotationAnchor`'s own and is accepted here as it is there: for a
crescent the middle of the extent is outside the shape.

A Pin's ordinal sits directly above its pin, cleared by the pin's own height plus the mark's radius,
because a pin is anchored at its tip.

### Contrast, measured

`--color-info-content` on `--color-info`, in the shipped daisyUI palette
`oklch(29% .066 243.157)` on `oklch(74% .16 232.661)` — which the two themes happen to share:

| Theme | Ink on its own mark | Needed |
| --- | --- | --- |
| light | **6.31:1** | 4.5:1 |
| dark | **6.31:1** | 4.5:1 |

For comparison the Control Point's own `primary-content` on `primary` is 6.76:1 light and 4.14:1
dark, so this pair is the better of the two in the flavour where it matters. The row's ordinal uses
`--layer-kind-ink-annotation`, whose measured sweep (6.01:1 light, 8.76:1 dark on the row's own wash)
is already in `packages/ui/src/layout.css`.

`editor-annotations.e2e.ts` re-measures the mark from the running application's own computed styles
in both themes, rasterising each colour into a 1 × 1 canvas — because
`getComputedStyle(element).color` in Chrome preserves `oklch()` rather than serialising to `rgb()`.

## Acceptance criteria

- [x] Every Annotation shows the same ordinal on its map mark and on its sidebar row, in both apps.
- [x] Ordinals start at 1 and follow the collection's order.
- [x] Deleting an Annotation renumbers the rest with no file write beyond the deletion itself.
- [x] Drawing, selecting and deleting Annotations produces a `.geojson` byte-identical to the one the
      same actions produced before this ticket.
- [x] The ordinal meets contrast against its mark in both the light and dark themes, measured and
      recorded.
- [x] Lines and polygons carry an ordinal at a stable anchor as the map pans and zooms.
- [x] The Reader sees the same numbers as the scholar for the same Project.

```bash
pnpm lint
pnpm check
pnpm test
pnpm --filter @ballastella/ui test

pnpm test:e2e editor-annotations
pnpm test:e2e viewer-reader
```

Success: everything exits 0. `editor-annotations` already contains `a pin, a line, and a shape are
drawn and land in the Annotation Layer's own file` and `an unchanged Annotation Layer stays
byte-identical across a session that only looked` — both must pass unmodified, which is what proves
the ordinal reached the screen and not the file.

**Mutation check:** write the ordinal into a feature's `properties` and show the byte-identity test
goes red. That is the failure this ticket's central constraint exists to prevent.

Run twice, and the pair is worth keeping because they catch different things:

1. **`serialiseAnnotations` stamps `ordinal: index + 1` into every feature's `properties`.**
   `packages/core/src/annotation/ordinal.test.ts` → "the bytes an Annotation Layer is written as carry
   no number at all" goes **red**, and three `editor-annotations` browser specs go red with it.
2. **`removeAnnotation` renumbers the survivors by rewriting their `properties`** — the Contract's own
   named failure, renumbering as a write. `ordinal.test.ts` → "deleting the first Annotation renumbers
   the rest without changing their bytes" goes **red**, and **nothing at Seam 2 sees it at all**: all
   37 `editor-annotations` specs stay green, because the delete spec asserts ids rather than bytes.

⚠ **Neither mutation reddens "an unchanged Annotation Layer stays byte-identical across a session
that only looked", and that is a property of what that spec measures rather than a gap here.** It
compares hashes *before and after a session in which nothing is written*, so a stamp that is present
on both sides of the comparison is invisible to it. It catches a display path that **writes**; the
Seam 1 byte assertions catch a display value that reaches **the bytes**. The ticket's criterion —
byte-identical to what the same actions produced *before* this ticket — needs the second, which is
why `ordinal.test.ts` pins the written document down to its exact keys.

## Blocked by

- 06 — a Reader reads an Annotation in its row
