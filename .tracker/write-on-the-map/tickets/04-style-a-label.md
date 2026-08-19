# Style a Label

## Parent

[SPEC.md](../SPEC.md) — "The editor's surfaces", the Style face paragraph.

## What to build

The Annotation Inspector's Style face, when the selected Annotation is a Label, offers exactly what a
Label has: the colour of its text, the colour of its background, how solid that background is, and
one of three sizes. Choosing any of them changes the Label on the map and writes the simplestyle
property by its exact name.

No line-style control, no stroke width, no stroke opacity — a Label has no line.

## Where to start

- `apps/editor/src/lib/annotations/AnnotationStyleFace.svelte` — read the header comment first: every
  control is a native element, the groups are `<fieldset>`s with an `sr-only` `<legend>` and a drawn
  heading, and the `DIVIDER` belongs to the boundary rather than to the group. `isPoint`, `hasArea`
  and `hasLine` are the derived flags that decide which groups render.
- `apps/editor/src/lib/annotations/ColorPicker.svelte` — the nine-swatch radio group, and why a colour
  well is refused. It is used as-is; do not modify it.
- `apps/editor/src/lib/annotations/annotation-style-face.dom.test.ts` and
  `AnnotationStyleFaceHarness.svelte` — the seam and the harness this ticket extends.
- `packages/core/src/annotation/annotation.ts` — `MARKER_SIZES`, `resolveStyle`, `isLabel`.
- `apps/editor/src/lib/annotations/annotation-editing.svelte.ts` — the `onstyle` / `oncommit` path the
  face already reports through. Unchanged.

## Contract

**One group, named for the thing it styles.** For a Label the face renders a single `<fieldset>` —
heading *Label* — holding, in this order:

| Control | Writes | Existing component |
| --- | --- | --- |
| Colour | `marker-color` | `ColorPicker` |
| Background | `fill` | `ColorPicker` |
| Background opacity | `fill-opacity` | the existing range + readout |
| Size | `marker-size` | the existing three-radio join |

The two colour pickers need distinguishable accessible names — a Label has two colours and "Colour"
twice is ambiguous. The group `<legend>` disambiguates a repeated visible caption (WCAG H71), which is
the pattern the Fill and Line groups already rely on; use it rather than inventing prefixes.

**The size control is the Pin's, reused.** `MARKER_SIZES` is already exactly `small | medium |
large`, an absent `marker-size` already shows as medium because that is what the renderer coalesces
to, and the radio group is already built. Do not write a second one.

**A colour is committed immediately; an opacity is debounced and committed on release.** That split
already exists in this file and the reasons are recorded beside each control — a swatch is one
deliberate `change`, a slider fires continuously.

**Selecting on `isLabel`, not on geometry.** A Label is a Point, so `isPoint` alone would show it the
pin's controls. The three existing flags gain a fourth and each excludes a Label where it must:

```
isLabel  = isLabel(annotation)
isPoint  = geometry is Point  && !isLabel   // the Pin group
hasArea  = geometry is Polygon              // unchanged
hasLine  = geometry is LineString or Polygon // unchanged
```

**Style inheritance is already correct** — a new Label carries the last Annotation's colours and size
because `styleForNewAnnotation` copies them, and ticket 03 kept that. Story 25 is asserted here rather
than built.

## User Stories

19. As an author, I want to choose the colour of a Label's text from the same nine colours every other
    Annotation offers, so that a Project has one vocabulary of colour.
20. As an author, I want to choose the colour of the background the text sits on, so that a Label is
    legible over a dark Map Image and over a pale one.
21. As an author, I want to make the background transparent, so that a Label can sit directly on the
    map when that reads better.
22. As an author, I want three text sizes — small, medium and large — so that a regional name and a
    street name can be told apart at a glance.
23. As an author, I want the size control to be the same three-way control the Pin already has, so
    that I learn it once.
24. As an author, I want a Label's Style face to offer only what a Label has, so that I am not shown a
    line-style control for something that has no line.
25. As an author, I want the next Label I draw to carry the last one's colours and size, so that
    styling a run of Labels is a choice made once at the head of it.
27. As an author, I want a Label's style controls reachable and operable by keyboard, so that styling
    is not a pointer-only act.

## Out of scope

- **The Text face.** Ticket 05.
- **A new colour.** The palette is nine and stays nine; `ANNOTATION_COLORS` is not touched.
- **A text-opacity control.** A Label's words take `marker-color` at full strength, as a Pin's icon
  does, and for the recorded reason: `fill-opacity` is the *area's* opacity and belongs to the chip.
- **Changing the Pin, Fill or Line groups.** They keep their controls, their order and their
  headings; only the flag that decides whether the Pin group shows is narrowed.
- **Restyling a whole Layer.** Named in the spec as out of scope for every kind at once.
- **A stroke control for the chip's border.** The chip has no border. `stroke` is read by the
  selection emphasis and is not offered as a control.

## Acceptance criteria

- [ ] With a Label selected, the Style face renders the text colour, the background colour, the
      background opacity and the three sizes — and renders **no** line-style control, **no** stroke
      width and **no** stroke opacity. The negative half is what catches a face that shows everything.
- [ ] With a Pin selected, the face is unchanged from today: the Pin group and nothing else.
- [ ] With a Shape selected, the face is unchanged: Fill then Line.
- [ ] Each control reports its exact simplestyle name — `marker-color`, `fill`, `fill-opacity`,
      `marker-size` — with a `#rrggbb` colour and a number where a number belongs. A control writing
      `markerSize`, or a hex without its `#`, fails here.
- [ ] The two colour groups have distinguishable accessible names.
- [ ] Every control is reachable and operable by keyboard, asserted rather than assumed.
- [ ] In a browser: choosing a background colour and dragging its opacity changes the Label on the map
      and writes once on release.
- [ ] In a browser: with a Label as the last Annotation drawn, the next Label placed carries its
      colours and size.

```bash
pnpm --filter @ballastella/editor exec vitest run -t "style face"
pnpm test:e2e editor-annotations
pnpm precommit
```

Success: all green, with the negative assertions ("no line style control for a Label") named in the
`style face` output.

## Blocked by

- Ticket 03 — a Label has to be creatable before its style controls can be driven.

## Note from ticket 02's review

**A Point-geometry Label is currently offered no way to recolour its chip.**
`AnnotationStyleFace.svelte` gates the `fill` and `fill-opacity` controls on
`hasArea = geometryKind === 'Polygon'`, so a Label — a Point — sees `marker-color` alone. Since the
render bucket maps the chip's colour to `fill`, the background colour this ticket must offer (stories
20 and 21) is behind that gate.

This is expected work for this ticket rather than a surprise, and it is recorded here because ticket
02's review found it while the face was still out of scope: the gate is `hasArea`, and a Label needs
`fill` without being an area. Ticket 03 carries the related note about the first Label defaulting to
`#555555` words on a `#555555` chip.
