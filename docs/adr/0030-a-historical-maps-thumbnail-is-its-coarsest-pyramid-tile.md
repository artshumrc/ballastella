# A Historical Map's thumbnail is its coarsest pyramid tile

The Workspace hub and the "already in this Workspace" picker show each Historical Map as a picture.
That picture is the **single tile at the coarsest level of the map's pyramid** — the derivative that
already exists — and **no thumbnail file is written anywhere**. The same rule covers a referenced map,
which is why `remote.json` now records the service's tile size.

## Why there is nothing to generate

`pyramidScaleFactors` doubles the scale factor until the whole image fits inside one tile, so every
level-0 pyramid this app writes ends in a single tile holding the entire sheet at no more than
256 × 256. `planPyramid` writes it like any other tile, and `wholeImageDerivative` already computes its
URL — it is what a Presentation manifest's painting body points at, because `/full/max/` is not
something a level-0 service serves. `pyramid.test.ts`'s *"paints a body URL that the pyramid actually
contains"* pins that the two agree.

So the thumbnail predates the feature. Every Historical Map in every Workspace already has one, which
is why there is no backfill, no ingest change, and no second copy of bytes charged against ADR-0008's
~1 GB budget.

The same holds for a **referenced** map, and not by analogy. `createImagePane` *requires* the coarsest
level to reduce the image to one tile — the synthetic projection window is that tile — so a service
that declares no such level gets one synthesised by `extendedTileset`, and `chooseProbeTiles` then
fetches that exact tile at add time to prove the service really serves it. Every accepted referenced
map therefore has a servable whole-image tile, already verified. What it lacked was the tile size
needed to work out *which* scale factor is coarsest, and that is now written into `remote.json`
alongside the dimensions.

## Considered and rejected

**A dedicated `images/<id>/thumbnail.jpg`.** Exact dimensions, at the price of an ingest change, a
second copy of bytes, a before-and-after population of maps, and a second whole-image derivative
sitting beside the one the manifest already names — two records of one fact.

**`{service}/full/!256,256/0/default.jpg` for referenced maps.** Sharper, and it 404s on a level-0
service, which this app accepts whenever the declared pyramid is already deep enough. That population
is not exotic: it is what this app itself writes, and what `libvips dzsave --layout=iiif` writes.

**Reading the URL out of `manifest.json`'s painting body.** Free — that file is already read for the
label — but it makes local maps *read* their thumbnail URL while referenced maps *compute* theirs, and
a referenced map has no `manifest.json` of ours, so it can never be made uniform. One rule was worth
one extra small read per local map.

## Consequences

- **The size varies between roughly 129 and 256 pixels** on the dominant axis, because the coarsest
  level is the first power-of-two reduction that fits in a tile: a 1200 × 851 sheet yields 150 × 107. The
  card's image box is therefore 96 px and `object-contain` — never upscaled, and never cropped, because
  a sheet's proportions are information and a panoramic map reduces to a legitimate sliver.
- **A local thumbnail reaches the `<img>` as an object URL, resolved through `createStoreImageFetch`**
  (ADR-0011). Stored tiles have no URL and `<img src>` cannot reach them, so the card is one more
  consumer handed its bytes through its own extension point. It is created on mount and revoked on
  unmount. **A service worker serving the store at a virtual path is still refused**, for the reason
  ADR-0011 gives.
- **The URL's base is always `imageServiceId(imageId)`, never `info.json`'s `id`.** After an opt-in
  canonical stamp that field holds the *published* address, which the shim would not route — so the
  editor would fetch thumbnails over the internet, working or broken according to whether the site is
  live. The stamp touches `info.json` only, so a manifest body id stays on the placeholder forever.
- **Missing geometry means the placeholder, never a guess.** A `tileSize` of 0 or absent dimensions
  yield no URL. Defaulting to `PYRAMID_TILE_SIZE` would be right often enough to be dangerous: a
  service on 512 px tiles would get a URL at the wrong scale factor and show a broken picture instead
  of an honest blank.
- **A map with both `info.json` and `remote.json` uses the local tile.** The thumbnail follows
  `tileLocation`, so making an offline copy switches the picture from the library to the Workspace with
  no code that knows it happened.
- **Opening the hub now touches the network** for referenced maps, where before it did not. Mitigated
  by `loading="lazy"`, which is free for a plain remote URL and worthless for an object URL — the bytes
  are already read by the time one exists. A scholar working offline sees placeholders for their
  referenced maps. This is not warned about: ADR-0007's concern is copying a library's bytes into the
  Workspace, not displaying what the library publishes to be displayed.
- **The hub is now the one surface that could cheaply detect a damaged local pyramid, and deliberately
  does not.** Unlike the grid cells ADR-0028 declines to report — which a healthy pyramid 404s on every
  load, because the parser invents them — the coarsest tile is one the tiler is known to have written,
  so its absence is real evidence. Reporting it would grow outage reporting on a surface that has none;
  the residual is recorded here for whoever closes ADR-0028's gap, and it is not closed by this.
- **A thumbnail's failures are silent by design, so the tests have to assert a decoded picture rather
  than a present element.** A 404'd `<img>` carrying width and height attributes is visible and laid
  out, so `toBeVisible` passes over an empty box; a wrong scale factor and a mis-rooted path both
  render as something plausible rather than as an error. `naturalWidth` is the assertion that can go
  red, and there was no precedent for it in the suite.
