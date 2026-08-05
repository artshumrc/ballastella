# Third-party notices

Ballastella is MIT licensed — see [`LICENSE`](LICENSE) and
[ADR-0021](docs/adr/0021-mit-licence-and-gpl-hygiene.md). It distributes or will distribute
the third-party components below, which remain under their own licences. Copies of those
licences ship inside each package in `node_modules` and in the built bundles that include
them.

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
| `pmtiles`                        | BSD-3-Clause  | Single-file tile archive for the offline base map |
| `@protomaps/basemaps`            | BSD-3-Clause  | Base map style documents                        |
| `daisyui`                        | MIT           | The only UI dependency (ADR-0016)               |
| `tailwindcss`                    | MIT           | Styling                                         |
| `svelte`, `@sveltejs/*`          | MIT           | Framework and static adapter                    |

Base map _tiles_ are not dependencies but are still third-party content with attribution
requirements of their own — OpenStreetMap data is ODbL, and the rendered base maps must
carry their attribution in the UI and in every published site. That is a product
requirement, tracked with the base map work, not a notice satisfied by this file.
