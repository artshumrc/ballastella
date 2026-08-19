# Prove the background chip

## Parent

[SPEC.md](../SPEC.md) — "The background chip", and the contingency block inside it.

## What to build

**A decision, recorded as this ticket's `## Answer`.** Nothing in `src/` is left changed.

A Label's words sit on a coloured chip. The chip is an image behind the text, sized to the text by
`icon-text-fit`. The spec's primary design is a **stretchable SDF rounded rectangle coloured per
feature by `icon-color`** — one image for every Label in the application, mirroring the Pin exactly,
with the Pin's own `icon-halo-*` selection emphasis available for free.

That design has one unproven assumption: that MapLibre renders a *stretched SDF* image correctly and
still honours `icon-color` on it. Stretch zones confine the stretching to the flat edges, where a
distance field is linear along the stretch axis, so the corners should keep their aspect — but this
combination is not well trodden and the spec will not be built on top of an assumption.

Prove it in a real browser, at all three text sizes, with short text and long text, in two colours.
Then record which design the epic takes.

## Where to start

- `packages/core/src/render/pin-icon.ts` — the existing precedent for generating an image on a canvas
  and handing MapLibre an `ImageData`. `pinImage()`, `PIN_IMAGE_ID`, `PIN_PIXEL_RATIO`, and the SDF
  argument in `map.addImage(…, { sdf: true, pixelRatio })`.
- `packages/core/src/render/stack-layers.ts` — `ensurePinImage()`, and why it re-runs on every stack
  build (a theme change calls `setStyle`, which discards every registered image).
- `e2e/support/annotations.ts` — `seedAnnotationProject`, `waitForStack`, `baseMap`, and the
  `StackMap` handle, which is the live MapLibre map. `writeProjectFile` seeds a Layer's GeoJSON
  directly, which is how to get a Label onto the map before any Label code exists.
- `e2e/editor-annotations.e2e.ts` — the shape of a spec that drives the map and asks MapLibre what it
  drew.

The proof does not need any of this epic's production code. Seed a Layer, then add the image and one
`symbol` layer from inside the test with `page.evaluate`, reading `window.ballastellaLayerStack`.

## Contract

The two candidate designs, so the answer names one of them:

**Primary — one SDF chip, coloured per feature.**

```
map.addImage(id, image, { sdf: true, pixelRatio: 2, content, stretchX, stretchY })

'icon-image': <the one id>
'icon-text-fit': 'both'
'icon-color': ['get', 'fill']
'icon-opacity': ['to-number', ['get', 'fill-opacity']]
'icon-halo-color': ['get', 'stroke']      // selection, as the Pin already does
'icon-halo-width': ['case', ['boolean', ['feature-state', 'selected'], false], 3, 0]
```

**Contingency — one plain RGBA chip per background colour.**

```
map.addImage(`ballastella-label-bg-${hex}`, image, { pixelRatio: 2, content, stretchX, stretchY })

'icon-image':   ['concat', 'ballastella-label-bg-', ['get', 'fill']]
'icon-opacity': ['to-number', ['get', 'fill-opacity']]
// icon-color and icon-halo-* are SDF-only and unavailable. Selection is instead:
'text-halo-color': ['get', 'stroke']
'text-halo-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2, 0]
```

The contingency's images must be registered **from the collection's own colours**, at stack build
*and* inside `setAnnotations`, so that a colour chosen after the layer was added has its image before
the data reaches the source.

The primary design is taken unless this ticket's evidence says it cannot be.

## Out of scope

- Any production code. `packages/core/src`, `packages/ui/src` and `apps/*/src` are unchanged when this
  ticket closes.
- The Label tool, the discriminator, the Style face, the glyph question — every one of those is a
  later ticket and none of them is needed to answer this one.
- Choosing the chip's corner radius, padding or exact text sizes as *decisions*. Pick values that make
  the proof legible and say what you used; ticket 02 owns the final numbers.
- Keeping the spike test. It is deleted before this ticket closes.

## Acceptance criteria

- [x] A screenshot exists showing a chip behind real text at `small`, `medium` and `large`, with a
      short word and a long phrase, in at least two different `fill` colours.
- [x] The screenshot answers, visibly: are the chip's corners the same radius at both text lengths, or
      does the long one have stretched corners?
- [x] Under the primary design, two Labels with different `fill` values draw two differently coloured
      chips from one registered image.
- [x] `## Answer` is appended to this ticket naming **primary** or **contingency**, with the evidence
      and the values used for corner radius, padding, and the three text sizes.
- [x] The spike spec file is deleted, and `git status` shows no change under `packages/*/src` or
      `apps/*/src`.

```bash
# Write the spike, run it headed to see it, and keep the screenshot it takes.
pnpm test:e2e label-chip-spike --headed

# Before closing: the proof is gone and nothing in src moved.
rm e2e/label-chip-spike.e2e.ts
git status --short packages apps        # expect: no output
pnpm precommit lint check               # expect: both stages pass
```

Success is a written `## Answer`, not a green suite: this ticket's product is the decision.

## Blocked by

None - can start immediately.

## Answer

**Primary.** A stretched SDF rounded rectangle renders correctly and MapLibre honours `icon-color` on
it. Nothing in the spec's "The background chip" needs to change, and the contingency is not taken.

### The evidence

Headless Chromium, real MapLibre 5.24.0, the editor's own Base Map and glyphs. The spike registered
the chip and one `symbol` layer from inside the test with `page.evaluate`; no production code was
touched. Two screenshots, both kept:

- **[`evidence/label-chip-sdf.png`](../evidence/label-chip-sdf.png)** — the primary design. Six
  Labels: `small`, `medium` and `large`, each with a short word (`Ee`) and a long phrase
  (`Zuiderzee en de Waddenzee`), the short ones `fill: #e55e5e` and the long ones `fill: #3bb2d0`,
  plus a seventh carrying `feature-state.selected`. The Base Map's own `symbol` layers were hidden
  for the shot, so every word in it is a Label.
  - **One registered image draws all seven**: `map.listImages()` returns exactly
    `['ballastella-label-bg']`, and the red and the blue chips are that one image tinted by
    `icon-color: ['get', 'fill']`. This is the assumption the ticket existed to test, and it holds.
  - **The corners are the same radius at both text lengths.** Measured off the screenshot, the
    top-left corner's inset row by row is `[4,3,2,1,1,0]` for the short `medium` chip and `[5,3,1,1,0]`
    for the long one — the same arc within a pixel of antialiasing, at all three sizes and at chip
    widths from 44 px to 188 px. Nothing is stretched but the flat edges.
  - **The Pin's selection emphasis comes for free**: the selected chip carries a visible
    `icon-halo-color`/`icon-halo-width` aura in its `stroke` colour, drawn on the SDF, with the chip
    itself not recoloured.
- **[`evidence/label-chip-corners.png`](../evidence/label-chip-corners.png)** — three encodings of the
  same rounded rectangle, top row to bottom, at `medium` with both text lengths. This is the row that
  tells ticket 02 which numbers are load-bearing.

### Two findings ticket 02 needs

**1. The distance field's edge must sit at alpha 192/256, not at the halfway value.** MapLibre's SDF
fragment shader thresholds an icon's fill at `(256 - 64) / 256`, so a field built around 0.5 draws a
shape *inset* from the one authored — the corner arc is eaten and the chip reads as a near-square box.
Rows one and two of `label-chip-corners.png` are that difference: the same 8 CSS-pixel authored radius
measures a `[4,2,1,0]` corner with the halfway convention and a `[6,4,2,2,1,1,0]` corner with 192/256.

`packages/core/src/render/pin-icon.ts`'s `signedDistanceAlpha` uses the halfway convention
(`(signed / spread) * 0.5 + 0.5`). On the pin — a large solid teardrop — the inset is invisible, which
is why it has never shown up. On a chip whose whole visual identity is a small corner radius it is not
invisible. **Ticket 02 should not reuse `signedDistanceAlpha` as it stands**: either give the chip its
own encoding at 192/256, or add the edge value as a parameter and leave the pin's own call unchanged.

**2. `content`, `stretchX` and `stretchY` are in the image's own pixels, not the icon's CSS pixels.**
Row three of `label-chip-corners.png` states them in CSS pixels (that is, divided by `pixelRatio`) and
is visibly wrong: a notch bitten out of the top-left corner and a corner arc that never closes
(inset profile `[20,4,2,2,1,1,1,1,…]`, never reaching 0). MapLibre's own `addImage` example is in image
pixels and that is what it means.

### The values the proof used

Chosen only to make the proof legible — ticket 02 owns the final numbers.

| | Value |
| --- | --- |
| image | 48 × 48 image pixels, `pixelRatio: 2` (a 24 CSS-pixel icon) |
| corner radius | 16 image pixels = **8 CSS pixels** |
| field ramp | 8 image pixels either side of the edge, edge at alpha 192/256 |
| `content` | `[16, 16, 32, 32]` |
| `stretchX` / `stretchY` | `[[16, 32]]` each |
| padding | `icon-text-fit-padding: [4, 8, 4, 8]` — 4 CSS pixels top and bottom, 8 left and right |
| `text-size` | `small` 12, `medium` 16, `large` 22 |

At those values the chips came out 44 × 37, 48 × 42 and 54 × 49 CSS pixels for the short word at the
three sizes, and up to 188 × 75 for the long phrase wrapped over two lines at `large` — MapLibre's
default `text-max-width` wraps the long phrase, and `icon-text-fit: 'both'` fits the chip to the
wrapped block on both axes without touching the corners.

### Housekeeping

The spike spec (`e2e/editor-label-chip-spike.e2e.ts`, named `editor-*` because `playwright.config.ts`
matches its projects on that prefix) is deleted, and this ticket left nothing under `packages/*/src`
or `apps/*/src` changed. `--headed` does not render a Base Map in this container — MapLibre draws
nothing at all — so the run that produced these screenshots is the ordinary headless one, which is the
suite's own seam.
