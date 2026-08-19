# A Published Site draws Labels

## Parent

[SPEC.md](../SPEC.md) — "The viewer's surfaces", and the Published Site stories.

## What to build

A Reader meets the author's Labels: drawn on the map at the same place, in the same colours, at the
same size the author gave them. Clicking one opens its Layer's card with that Annotation selected, and
the Annotation Inspector shows its words in the identity header and whatever description the file
carries — with no editing controls at all.

**No new component and no new prop.** The viewer draws through the same shared stack the editor does,
and its Inspector already withholds the Style face by not passing a snippet. This slice is where that
is proved against a real published build rather than assumed from shared code.

## Where to start

- `apps/viewer/src/routes/+page.svelte` — how a Layer's Annotations are read, how `selected` is held,
  and how the Inspector is rendered with a `text` snippet and no `style` snippet.
- `apps/viewer/src/lib/ReaderMapPane.svelte` — the click path: `annotationLayerIds(…)` filtered by
  `target.getLayer(id)`, then `queryRenderedFeatures`. Ticket 02 put the Label bucket in that list,
  which is what makes a Label clickable here.
- `packages/ui/src/AnnotationInspector.svelte` — the rule that the tab strip renders if and only if a
  `style` snippet was passed, and why there is no `readOnly` prop.
- `packages/ui/src/AnnotationDescription.svelte` — renders nothing when there is no description, which
  is why a Label with only words needs no case of its own.
- `e2e/viewer-reader.e2e.ts` and `e2e/support/published-site.ts`, `e2e/support/reader-project.ts` —
  the specs and the driving this extends.

## Contract

**The viewer gains no Label-specific code.** If this slice needs a branch in the viewer for a Label,
something is wrong upstream — the discriminator, the render bucket and the hit-test list are all in
`core`, shared. The expected diff in `apps/viewer/src` is empty or near it; the work is the spec.

**A Label's Inspector is the identity header plus whatever the description face renders.** For a Label
with only words that is a header and an empty face, reached by the same code path an undescribed Pin
already takes. That is the intended outcome, not a gap to fill.

**"The same size, colour and place" is asserted against the published build**, not against the editor's
dev server — the point is that publishing changes nothing, and only a real Published Site can fail that
way.

## User Stories

54. As a Reader, I want a Published Site to draw the author's Labels, so that I read the map they made
    rather than a version with the words removed.
55. As a Reader, I want to click a Label and have its Layer's card open with that Annotation selected,
    so that a Label is a way into the work rather than only decoration.
56. As a Reader, I want a Label's Inspector to show me its words in its header and whatever description
    it carries, and no editing controls at all, so that the viewer stays the editor with the editing
    subtracted.
57. As a Reader, I want Labels to draw at the same size, colour and place they had in the editor, so
    that publishing changes nothing about how the work looks.

## Out of scope

- **A site published without the Base Map's typefaces.** That is ticket 09, and it is the *other*
  branch of `styleFor`. Do not touch the glyph handling here.
- **Adding a `readOnly` or `mode` prop anywhere.** The absence rule does the work: the viewer passes no
  `style` snippet and therefore has no Style tab.
- **Giving a Reader a way to change a Label.** No controls, not even disabled ones.
- **A Reader-facing description control.** The description is rendered, never edited.
- **Changing the leader line in the viewer.** It already points at the Annotation's own drawing through
  the shared mark box that ticket 02 taught about Labels.

## Acceptance criteria

- [x] Against a real published build: a Project containing Labels draws them, and
      `queryRenderedFeatures` at a Label's point returns it from the Label bucket.
- [x] Against a real published build: a Label's rendered colour, size and coordinate match the ones the
      author's file states.
- [x] Clicking a Label on the published map opens its Layer's card with that Annotation selected.
- [x] The Inspector for a Label shows its words in the identity header, and shows a description when
      the file carries one.
- [x] The Inspector for a Label shows **no** tab strip, no Style face, no *Edit text*, no *Delete*, and
      no drawing tools anywhere on the page.
- [x] `git diff --stat apps/viewer/src` shows no change, or a change the reviewer agrees was
      unavoidable and is not a Label special case.

```bash
pnpm test:e2e viewer-reader
git diff --stat apps/viewer/src
pnpm precommit
```

Success: `viewer-reader` green with the Label cases named, and an empty (or argued) viewer diff.

## Blocked by

- Ticket 04 — a Label's colours and size must be authorable before "publishing changes nothing" is a
  claim with anything in it.
- Ticket 05 — the words a Reader reads are typed in the Text face.

## Answer

**The contract held: `git diff --stat apps/viewer/src` is empty.** Nothing in the viewer knows a Label
from a Pin, and the two new specs in `e2e/viewer-reader.e2e.ts` — "a Published Site draws the author's
Labels" — pass against a real served build with the viewer untouched.

What made that possible was already shared, and each half is now asserted on the published side rather
than inferred from the editor's:

- the **render bucket** is `core`'s, so the published stack builds it from the same
  `whatItContains`/`annotationDrawKey` the editor uses. The spec reads the bucket id back out of
  `queryRenderedFeatures` at each Label's own coordinate;
- the **hit-test list** is `core`'s too, which is the whole of why a click on a Label's words reaches
  the viewer's `annotationLayerIds(…)` filter and selects that Annotation's row;
- the **Inspector's subtraction is an unpassed snippet**, so a Label meets the same identity header and
  description face an undescribed Pin does. A Label with no `description` gets
  `AnnotationDescription`'s own "No description." — the intended outcome, and the reason no case had to
  be written for it.

Two things worth recording for whoever reads these specs next:

- **A published Label's colour cannot be asserted from the style.** `getPaintProperty` answers with the
  expression (`['get', 'marker-color']`), which says where the renderer was told to look and nothing
  about what was drawn. The colours are therefore read out of the map's framebuffer, as a band across
  the middle of the chip; the fixture sets `fill-opacity: 1` so the sampled pixel is the author's
  colour rather than a blend of it with the geography beneath.
- **A Label's hit box is wider than its chip.** The stretchable SDF keeps a transparent margin for the
  selection halo (ticket 01), so walking outwards until `queryRenderedFeatures` stops naming the
  feature over-measures the visible chip by a few pixels either side. That is harmless for the claim
  being made — the three sizes are compared with each other — but a future reader should not read the
  measured width as the drawn width.
