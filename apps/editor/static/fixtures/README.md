# Fixtures served as static assets

These are committed test fixtures, served over ordinary HTTP by the editor. They are not user
data and not part of a Workspace. They exist so that the image pane and its projection can be
exercised — and asserted in a real browser — before the storage layer or the tiler exist.

`@ballastella/core`'s tests read `images/floride-1657/info.json` from this directory rather
than restating it, so the bytes the unit tests reason about are the bytes the browser fetches.

## `images/floride-1657` — a level-0 IIIF pyramid

**Source.** Nicolas Sanson, _La Floride_, Paris, [1657]. United States Library of Congress,
Geography & Map Division, digital id `g3860.ct000706`,
<https://www.loc.gov/item/2003623129/>, via Wikimedia Commons,
<https://commons.wikimedia.org/wiki/File:La_Floride_LOC_2003623129.jpg>.

**Rights.** Public domain. The work is from 1657 and the Library of Congress states no known
restrictions on publication. No attribution is required; it is recorded here because knowing
where a fixture came from is worth more than the bytes it saves.

**How it was made.** The Commons 1280-pixel rendering was resized to 1200 × 851 and cut into a
IIIF Image API 3 level-0 pyramid: 256-pixel square tiles, scale factors 1, 2, 4 and 8, 29 tiles
in total. Region and size for each tile were computed by the same arithmetic as
`@allmaps/iiif-parser`'s `getTileImageRequest`, which is what the pane uses to read them.
The client-side tiler's own output is compared against this pyramid.

**Why this image and this shape.** A real archival scan rather than a generated gradient,
because a gradient hides tile ordering mistakes that engraved detail makes obvious. And
deliberately awkward, in three ways that each catch a specific class of bug:

- **Non-square** (1200 × 851), so a transposed width and height cannot pass unnoticed.
- **Neither dimension a multiple of the tile size**, so ragged edge tiles exist at both the
  right and the bottom margin, at every scale factor.
- **Four scale factors**, so more than one level of the pyramid is exercised and the mapping
  from map zoom to scale factor is not a single hardcoded case.

`info.json` carries the `https://unset.invalid/floride-1657` placeholder id required by
ADR-0004. The base the tiles are really served from is resolved at load time.
