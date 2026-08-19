# A site without typefaces says so

## Parent

[SPEC.md](../SPEC.md) — "Glyphs, and the sites that have none".

## What to build

Labels are the first Annotation that needs the Base Map's typefaces. A Published Site written by an
older build carries no glyphs, and the viewer already strips `glyphs` and drops every `symbol` layer
on such a site rather than firing 404s at files that are not there — so a Label there would vanish
without a word.

Make that honest:

- the Layer stack **omits the Label bucket** where the style carries no glyphs, so nothing asks for a
  font that is not there;
- everything else on such a site — the geography, the Map Images, the Pins, the Lines, the Shapes —
  draws exactly as before;
- the notice already on the page **says the Labels are not drawn**, in place of its current promise
  that the Annotations are unaffected;
- and the two comments that assert nothing the Layer stack draws needs glyphs are corrected, because
  they are what would send the next reader wrong.

The editor is unaffected and must be proved unaffected: it always builds the full style from the
assets in its own `static/`, so an author can always draw a Label.

## Where to start

- `apps/viewer/src/lib/ReaderMapPane.svelte`, `styleFor` — **three** branches matter. The
  cached-tiles branch and the remote-archive branch both delete `glyphs` and `sprite` and filter out
  `symbol` layers when `bundledBaseMapAvailable` is false; the third builds a bare background-only
  style with no `glyphs` at all. Two of them carry the comment that needs correcting, including the
  one that says "Annotations are circles, lines, and fills".
- `packages/core/src/base-map/resolve.ts` — `baseMapNotPublishedNotice`, and its four-row table.
  Read its header: it takes the site's state precisely because a sentence about what is *drawn*,
  chosen without the state that decides it, has already been false twice here.
- `packages/core/src/base-map/resolve.test.ts` — the four rows are driven in milliseconds; this is
  where the new wording is asserted.
- `packages/core/src/render/stack-layers.ts` — `drawLayerStack`'s per-Layer loop, and `ensurePinImage`,
  whose "no image, no pin layer" guard is the exact precedent for "no glyphs, no Label layer".
- `apps/viewer/src/routes/+page.svelte` — where `baseMapNotPublished` reaches the page.
- `e2e/support/published-site.ts` and `e2e/support/base-map-notice.ts` — how a site published without
  display assets is built and how its notice is read.

## Contract

**The stack asks the map, rather than being told.** `map.getStyle().glyphs` is the fact; a boolean
threaded from two apps through the stack would be a second description of it that can disagree.
Follow `ensurePinImage`'s shape:

```
// No glyphs, no Label layer — which shows as a mark absent from the map rather than as
// MapLibre asking for a font this site does not carry, once per frame.
if (contents.hasLabel && !styleHasGlyphs(map)) contents.hasLabel = false;
```

The Layer is still `drawn`. Its other Annotations are unaffected, and a Layer holding nothing but
Labels draws nothing while still being a Layer that is showing — the same state a Layer of pins is in
when the pin image cannot be made.

**The notice gains the Labels and loses the false half.** Its current sentence ends "The Map Images
and the Annotations are not affected", which stops being true the day this ships. Reword that row to
say what is lost — the reference map's place names, and the author's Labels — and what is not.
Everything the header says about *which* row applies still holds; do not restructure the table.

**The bare-style branch's comment is corrected too.** It reads "Annotations are circles, lines, and
fills", which is now wrong in two ways: a Pin has been a symbol with an image for some time, and a
Label needs glyphs. Say what is true — nothing this stack draws needs the *sprite*, and a Label needs
glyphs and is therefore omitted here.

**The editor is not to grow a branch.** It always has glyphs. Assert that rather than defending
against it.

## User Stories

58. As a Reader of a site published without the Base Map's typefaces, I want to be told that the
    author's Labels are not drawn here, so that a missing part of the work is never silent.
59. As a Reader of such a site, I want everything else — the geography, the Map Images, the Pins, the
    Lines and the Shapes — to draw as usual, so that one absent asset does not cost me the Project.
60. As an author, I want the editor always to be able to draw a Label, so that what I author is never
    dependent on an asset the authoring app might not have.

## Out of scope

- **Rescuing legacy sites.** They do not gain glyphs. Do not write the fonts into an old site, do not
  fetch them from anywhere, and do not fall back to a system font — MapLibre substituting one silently
  is precisely the failure mode ADR-0025 exists to prevent.
- **Republishing.** New publishes have carried the display assets since ADR-0025; nothing about the
  publish path changes here.
- **Restructuring `baseMapNotPublishedNotice`.** Four rows, chosen by the site's state. One row's
  wording changes.
- **A per-Layer warning in the sidebar.** The page's existing notice is the channel.
- **Making the editor defensive.** No glyph guard, no fallback, no branch.
- **Touching the sprite handling.** Sprites and glyphs are separate; a Label needs one and not the
  other.

## Acceptance criteria

- [ ] A stack built on a style with no `glyphs` adds no Label layer, and still adds the fill, line and
      point buckets its Layer needs.
- [ ] A stack built on a style **with** `glyphs` adds the Label layer, as ticket 02 established.
- [ ] `baseMapNotPublishedNotice` returns, for the "assets absent, geography drawable" row, a sentence
      that names the author's Labels as not drawn — asserted in `resolve.test.ts`, along with the other
      three rows unchanged.
- [ ] The two comments in `ReaderMapPane`'s `styleFor` that claim the Layer stack needs no glyphs are
      corrected.
- [ ] Against a published site built **without** display assets: a Project containing a Label, a Pin, a
      Line and a Shape draws the Pin, the Line and the Shape, draws no Label, and shows the notice with
      its new sentence.
- [ ] Against a published site built **with** display assets: the Label draws and the notice is absent.
- [ ] In the editor: a Label draws on every Base Map entry the switcher offers, with no glyph guard in
      `apps/editor/src`.

```bash
pnpm --filter @ballastella/core exec vitest run --project node -t "baseMapNotPublishedNotice"
pnpm --filter @ballastella/core exec vitest run --project node -t "glyph"
pnpm test:e2e viewer-reader
pnpm test:e2e editor-base-map
pnpm precommit
```

Success: all green, and the without-assets case asserts both halves — the Label absent *and* the other
three Annotations present. A test that only checks the Label is missing would pass on a site that drew
nothing at all.

## Blocked by

- Ticket 02 — the Label bucket has to exist before it can be omitted.
