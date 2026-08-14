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

## Acceptance criteria

- [ ] Every Annotation shows the same ordinal on its map mark and on its sidebar row, in both apps.
- [ ] Ordinals start at 1 and follow the collection's order.
- [ ] Deleting an Annotation renumbers the rest with no file write beyond the deletion itself.
- [ ] Drawing, selecting and deleting Annotations produces a `.geojson` byte-identical to the one the
      same actions produced before this ticket.
- [ ] The ordinal meets contrast against its mark in both the light and dark themes, measured and
      recorded.
- [ ] Lines and polygons carry an ordinal at a stable anchor as the map pans and zooms.
- [ ] The Reader sees the same numbers as the scholar for the same Project.

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

## Blocked by

- 06 — a Reader reads an Annotation in its row
