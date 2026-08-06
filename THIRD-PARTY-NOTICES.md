# Third-party notices

Ballastella is MIT licensed — see [`LICENSE`](LICENSE) and
[ADR-0021](docs/adr/0021-mit-licence-and-gpl-hygiene.md). It distributes or will distribute
the third-party components below, which remain under their own licences.

**Where each licence text actually is has to be checked per component, not assumed.** Many npm
packages ship one — `maplibre-gl` carries `LICENSE.txt`, for instance — but several do not:
`pmtiles` and `@protomaps/basemaps` ship no licence file at all, and the base map bytes committed
under `apps/editor/static/base-map/` are not npm packages, so no manifest covers them. Every one of
those licences requires its text to accompany redistribution, which means the obligation is met by
what this repository ships, not by what happens to be in someone's `node_modules`. See the open
item at the end of this file.

This file is maintained by hand. **A new dependency whose licence is not plainly permissive
— and any dependency that ships a compiled artefact under a different licence from its
wrapper — needs an entry here before it is added.**

## `wasm-vips` — the one that is not what it looks like

**The npm wrapper is MIT. The artefact it ships is compiled [libvips](https://www.libvips.org/),
which is LGPL-2.1-or-later**, together with libvips' own bundled dependencies.

This entry is written down before anything imports `wasm-vips`, deliberately. It is the one
dependency in this project where "MIT on npm" does not tell the whole story, and it is
exactly the kind of thing that gets forgotten at the moment the dependency is actually
added. `wasm-vips` is the streaming tiler for images above the `createImageBitmap` decode
ceiling ([ADR-0003](docs/adr/0003-every-image-is-tiled-client-side.md)).

LGPL permits use in permissively licensed software. Lazy-loading libvips as a separate
module — which is what ADR-0003 specifies, for bundle-size reasons rather than licensing
ones — is closer to dynamic linking than to static linking, and dynamic linking is a case
LGPL-2.1 explicitly contemplates. So this is a notice-and-attribution obligation rather than
a problem. Meeting it requires:

- this notice, reproduced in the published viewer as well as the authoring app;
- the LGPL-2.1 licence text, which ships in the `wasm-vips` package;
- keeping libvips replaceable — it is loaded as a separate module and is not statically
  linked into the application bundle.

| Component            | Licence            |
| -------------------- | ------------------ |
| `wasm-vips` wrapper  | MIT                |
| compiled libvips     | LGPL-2.1-or-later  |

## Everything else

Licences as recorded in ADR-0021 at the time of that decision. Entries are listed here
ahead of the tickets that add them, so that the set is reviewed as a whole rather than one
dependency at a time.

| Component                        | Licence       | What it does                                    |
| -------------------------------- | ------------- | ----------------------------------------------- |
| `@allmaps/*`                     | MIT           | Georeference annotation parsing, warped rendering, transformations |
| `triiiceratops`                  | MIT           | IIIF Manifest and Collection navigation, unwarped viewing |
| `manifesto.js` (via triiiceratops) | Apache-2.0  | IIIF Presentation parsing inside triiiceratops   |
| `openseadragon` (via triiiceratops) | BSD-3-Clause | Deep-zoom image viewer                        |
| `terra-draw` and its MapLibre adapter | MIT      | All drawing — control points, resource masks, annotations |
| `maplibre-gl`                    | BSD-3-Clause  | Both map panes                                  |
| `@maplibre/maplibre-gl-style-spec` | ISC         | The `StyleSpecification` type, across the `core` boundary |
| `pmtiles`                        | BSD-3-Clause  | Single-file tile archive for the offline base map |
| `@protomaps/basemaps`            | BSD-3-Clause  | Base map style documents                        |
| `daisyui`                        | MIT           | The only UI dependency (ADR-0016)               |
| `tailwindcss`                    | MIT           | Styling                                         |
| `svelte`, `@sveltejs/*`          | MIT           | Framework and static adapter                    |

Base map _tiles_ are not dependencies but are still third-party content with attribution
requirements of their own — OpenStreetMap data is ODbL, and the rendered base maps must
carry their attribution in the UI and in every published site. That is a product
requirement, tracked with the base map work, not a notice satisfied by this file.

## Bundled base map content

The base map ships as bytes in this repository rather than as a dependency, so its licences are
not recorded in any `node_modules` manifest. Provenance and per-file detail are in
[`apps/editor/static/base-map/PROVENANCE.md`](apps/editor/static/base-map/PROVENANCE.md), beside
the files themselves.

| Content                                    | Licence         | What it is                            |
| ------------------------------------------ | --------------- | ------------------------------------- |
| `base-map/amsterdam-centre.pmtiles`        | ODbL 1.0        | OpenStreetMap data, extracted from the Protomaps v4 basemap |
| — the same archive's Natural Earth layers  | public domain   | coastlines and landcover at low zoom  |
| `base-map/fonts/Noto Sans *`               | OFL 1.1         | SDF glyph ranges derived from Noto Sans |
| `base-map/sprites/*`                       | BSD-3-Clause    | Protomaps basemap icon sheets          |

The ODbL attribution obligation is met by the `attribution` on the base map source, which
MapLibre's attribution control renders uncompacted. It is a licence condition, so it is not
behind an "i" and must not become one.

`base-map/streets-worldwide` in the catalog reads a **remote** archive from Protomaps' public demo
bucket rather than shipping it. Its data carries the same ODbL obligation, met the same way; its
hosting carries no published terms. See
[`apps/editor/static/base-map/PROVENANCE.md`](apps/editor/static/base-map/PROVENANCE.md).

## Bundled test fixtures

The image pane's fixture pyramid also ships as bytes rather than as a dependency, so the same
"not in any `node_modules` manifest" caveat applies. Provenance and rights are recorded beside the
files in [`apps/editor/static/fixtures/README.md`](apps/editor/static/fixtures/README.md).

| Content                                  | Licence       | What it is                                     |
| ---------------------------------------- | ------------- | ---------------------------------------------- |
| `fixtures/images/floride-1657/**`        | public domain | Nicolas Sanson, _La Floride_, Paris [1657], from the US Library of Congress via Wikimedia Commons |

No attribution is required for a 1657 work the Library of Congress records no known restrictions
on, so there is no runtime obligation here — unlike the base map's ODbL condition above.

## Open: two licence texts do not ship

**Needs a human.** OFL 1.1 and BSD-3-Clause both require the licence text to accompany
redistribution, and neither text is anywhere in this repository or in `node_modules`:

| Content                      | Licence      | Where its text is |
| ---------------------------- | ------------ | ----------------- |
| `base-map/fonts/Noto Sans *` | OFL 1.1      | missing           |
| `base-map/sprites/*`         | BSD-3-Clause | missing           |

`@protomaps/basemaps` — the source of the sprite sheets and the glyph build — ships no `LICENSE`
file, so there is nothing to copy from. `maplibre-gl` does ship a BSD-3-Clause text, but it carries
MapLibre's copyright line rather than Protomaps', and substituting one for the other would be
fabricating an attribution rather than reproducing one.

Resolving this means fetching both texts from their sources —
[OFL 1.1](https://openfontlicense.org/), and the BSD-3-Clause notice as published by
[protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets) with its own copyright
line — and committing them beside the assets they cover. That is a network fetch and a
copyright-holder determination, so it is left for a person rather than guessed at.
