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
which `wasm-vips` 0.0.18 states as LGPLv3**, together with twenty of libvips' own bundled
dependencies — three of which are also LGPLv3, and one of which carries a patent licence. They are
listed in full under [What else is inside `vips.wasm`](#what-else-is-inside-vipswasm).

This entry was written down before anything imported `wasm-vips`, deliberately, and **checked
against the package on 2026-08-05 when ticket 05 made the dependency real.** Two things it said
were wrong, and are corrected below. It is the one dependency in this project where "MIT on npm"
does not tell the whole story. `wasm-vips` is the streaming tiler for images above the
`createImageBitmap` decode ceiling ([ADR-0003](docs/adr/0003-every-image-is-tiled-client-side.md)).

**The version is LGPLv3, not LGPL-2.1-or-later.** The package's own
[`THIRD-PARTY-NOTICES.md`](https://github.com/kleisauke/wasm-vips/blob/master/THIRD-PARTY-NOTICES.md)
lists libvips, glib, libexif and libheif as LGPLv3, reached "via the 'any later version' clause of
the LGPLv2 or LGPLv2.1". LGPLv3 adds obligations LGPL-2.1 does not have — notably its anti-tivoisation
and installation-information terms — so the distinction is not cosmetic even though the
notice-and-relink shape of the obligation is the same.

**The licence text does not ship in the package.** `wasm-vips` publishes `LICENSE` (the MIT text
for the wrapper) and `THIRD-PARTY-NOTICES.md`, and no LGPL text of any version. The previous claim
that "the LGPL-2.1 licence text ships in the `wasm-vips` package" was simply not true, and it was
the line the whole obligation was resting on. It joins the open item at the end of this file.

LGPL permits use in permissively licensed software. Loading libvips as a separately fetched
WebAssembly module — which is what ADR-0003 specifies, for bundle-size reasons rather than
licensing ones, and what `apps/editor/src/lib/ingest/libvips-loader.ts` does — is closer to
dynamic linking than to static linking, and dynamic linking is a case the LGPL explicitly
contemplates. So this is a notice-and-attribution obligation rather than a problem. Meeting it
requires:

- this notice, reproduced in the published viewer as well as the authoring app;
- **the LGPLv3 text, which must be fetched from upstream and committed here** — see the open item;
- keeping libvips replaceable — it is loaded as a separate module and is not statically
  linked into the application bundle.

| Component           | Licence | Text ships?                       |
| ------------------- | ------- | --------------------------------- |
| `wasm-vips` wrapper | MIT     | yes, `LICENSE` in the package     |
| compiled libvips    | LGPLv3  | **no** — see the open item        |

### What else is inside `vips.wasm`

`vips.wasm` is a single compiled artefact with libvips' dependencies linked into it, and this
repository redistributes it in the editor's build. CONTRIBUTING requires an entry for "any
dependency that ships a compiled artefact under a different licence from its wrapper", and that is
each of these, not only libvips. Every one is an attribution obligation on the artefact we ship.

Transcribed from `wasm-vips` 0.0.18's own
[`THIRD-PARTY-NOTICES.md`](https://github.com/kleisauke/wasm-vips/blob/master/THIRD-PARTY-NOTICES.md),
as installed in `node_modules`, on 2026-08-06 — **not** from upstream project pages, since the
licence that applies is the one the build was made under. Where that file links to a specific
licence file, the link is kept.

| Library         | Used under the terms of                                        |
| --------------- | -------------------------------------------------------------- |
| `libvips`       | LGPLv3                                                         |
| `glib`          | LGPLv3                                                         |
| `libexif`       | LGPLv3                                                         |
| `libheif`       | LGPLv3                                                         |
| `aom`           | BSD-2-Clause **plus the [Alliance for Open Media Patent License 1.0](https://aomedia.org/license/patent-license/)** |
| `highway`       | BSD-3-Clause                                                   |
| `libjxl`        | BSD-3-Clause                                                   |
| `libwebp`       | New BSD License                                                |
| `libimagequant` | [BSD-2-Clause](https://github.com/lovell/libimagequant/blob/main/COPYRIGHT) |
| `libpng`        | [libpng License](https://github.com/pnggroup/libpng/blob/master/LICENSE) |
| `libtiff`       | [libtiff License](https://gitlab.com/libtiff/libtiff/blob/master/LICENSE.md) (BSD-like) |
| `mozjpeg`       | [zlib License, IJG License, BSD-3-Clause](https://github.com/mozilla/mozjpeg/blob/master/LICENSE.md) |
| `zlib-ng`       | [zlib License](https://github.com/zlib-ng/zlib-ng/blob/develop/LICENSE.md) |
| `brotli`        | MIT                                                            |
| `cgif`          | MIT                                                            |
| `expat`         | MIT                                                            |
| `lcms`          | MIT                                                            |
| `libffi`        | MIT                                                            |
| `libnsgif`      | MIT                                                            |
| `libultrahdr`   | MIT                                                            |
| `resvg`         | MIT                                                            |
| `emscripten`    | [MIT](https://github.com/emscripten-core/emscripten/blob/main/LICENSE) |

Two things a reader should not have to infer:

- **`aom` carries a patent grant, not only a copyright notice.** It is the only entry here whose
  obligation is not satisfied by reproducing a notice, and it travels with the artefact whether or
  not anything in this app decodes AVIF. `loadLibvips` passes `dynamicLibraries: []`, which omits
  the separately-fetched JPEG XL and HEIF modules but not what is linked into `vips.wasm` itself.
- **`glib`, `libexif` and `libheif` are LGPLv3 too**, on the same "any later version" reading as
  libvips, so the LGPLv3 text in the open item below covers four components rather than one.

None of these texts is in this repository, for the same reason libvips' is not: the package ships
only the MIT text for its own wrapper. They are part of the open item at the end of this file.
**Nothing here was reconstructed from memory or fetched from the network** — the table is a
transcription of a file on disk, and where a text cannot be sourced offline it is recorded as
missing rather than invented.

## Everything else

Licences as recorded in ADR-0021 at the time of that decision. Entries are listed here
ahead of the tickets that add them, so that the set is reviewed as a whole rather than one
dependency at a time.

| Component                        | Licence       | What it does                                    |
| -------------------------------- | ------------- | ----------------------------------------------- |
| `@allmaps/*`                     | MIT           | Georeference annotation parsing, warped rendering, transformations, and the ids local images are stored under |
| `triiiceratops`                  | MIT           | IIIF Manifest and Collection navigation, unwarped viewing |
| `manifesto.js` (via triiiceratops) | Apache-2.0  | IIIF Presentation parsing inside triiiceratops   |
| `openseadragon` (via triiiceratops) | BSD-3-Clause | Deep-zoom image viewer                        |
| `maplibre-gl`                    | BSD-3-Clause  | Both map panes                                  |
| `@maplibre/maplibre-gl-style-spec` | ISC         | The `StyleSpecification` type, across the `core` boundary |
| `pmtiles`                        | BSD-3-Clause  | Single-file tile archive for the offline base map |
| `@protomaps/basemaps`            | BSD-3-Clause  | Base map style documents                        |
| `marked`                         | MIT           | Markdown → HTML, the first stage of the Annotation `description` pipeline (ADR-0009) |
| `dompurify`                      | Apache-2.0 or MPL-2.0 | HTML → sanitised HTML, the second stage, and the security boundary |
| `fflate`                         | MIT           | Zip export and import, ADR-0001's only way in and out |
| `daisyui`                        | MIT           | The only UI dependency (ADR-0016)               |
| `tailwindcss`                    | MIT           | Styling                                         |
| `svelte`, `@sveltejs/*`          | MIT           | Framework and static adapter                    |

`marked` and `dompurify` are direct dependencies of `@ballastella/core` **and of both apps**.
ADR-0018 explains why `dompurify` arriving in triiiceratops' tree costs nothing extra to
install; it is not permission to import it undeclared, which pnpm's isolated `node_modules`
prevents anyway. `dompurify` is dual-licensed and either licence is acceptable here; its text
ships in the package.

**`terra-draw` has been removed from this table, because it is not a dependency.** It was
listed ahead of the ticket expected to add it, as the note above this table describes, and
then three tickets in a row declined it: ticket 07 for Control Point pairing (ADR-0022 —
pairing is linked markers across two panes, which no drawing library models), ticket 08 for
the Resource Mask, and ticket 10 for Annotation drawing. All three now share one seam,
`apps/editor/src/lib/overlay/overlay-points.ts`, whose handles are real focusable buttons.
ADR-0005 still says all drawing goes through `terra-draw`, so **the ADR and the code
disagree** — recorded as an open question for a human in the epic tracker. This file records
what ships.

Base map _tiles_ are not dependencies but are still third-party content with attribution
requirements of their own — OpenStreetMap data is ODbL, and the rendered base maps must
carry their attribution in the UI and in every published site. That is a product
requirement, tracked with the base map work, not a notice satisfied by this file.

## Bundled Base Map display assets

Base Map glyphs and sprites ship as bytes in this repository rather than as dependencies, so their
licences are not recorded in any `node_modules` manifest. Provenance and per-file detail are in
[`apps/editor/static/base-map/PROVENANCE.md`](apps/editor/static/base-map/PROVENANCE.md), beside
the files themselves.

| Content                      | Licence      | What it is                              |
| ---------------------------- | ------------ | --------------------------------------- |
| `base-map/fonts/Noto Sans *` | OFL 1.1      | SDF glyph ranges derived from Noto Sans |
| `base-map/sprites/*`         | BSD-3-Clause | Protomaps Base Map icon sheets          |

The ODbL attribution obligation is met by the `attribution` on the base map source, which
MapLibre's attribution control renders uncompacted. It is a licence condition, so it is not
behind an "i" and must not become one.

Every catalog entry currently reads a remote archive from Protomaps' public demo bucket rather
than shipping tile data. Its data carries the same ODbL obligation, met the same way; its hosting
carries no published terms and is accepted only for educational development and evaluation. See
[`apps/editor/static/base-map/PROVENANCE.md`](apps/editor/static/base-map/PROVENANCE.md).

The central-Amsterdam ODbL/public-domain/BSD-3-Clause extract is retained only as the browser-test
fixture `e2e/fixtures/base-map/amsterdam-centre.pmtiles`; it is not application output.

## Bundled test fixtures

The image pane's fixture pyramid also ships as bytes rather than as a dependency, so the same
"not in any `node_modules` manifest" caveat applies. Provenance and rights are recorded beside the
files in [`apps/editor/static/fixtures/README.md`](apps/editor/static/fixtures/README.md).

| Content                                  | Licence       | What it is                                     |
| ---------------------------------------- | ------------- | ---------------------------------------------- |
| `fixtures/images/floride-1657/**`        | public domain | Nicolas Sanson, _La Floride_, Paris [1657], from the US Library of Congress via Wikimedia Commons |

No attribution is required for a 1657 work the Library of Congress records no known restrictions
on, so there is no runtime obligation here — unlike the base map's ODbL condition above.

## Open: the licence texts do not ship

**Needs a human.** Every licence below requires its text to accompany redistribution, and none of
them is anywhere in this repository or in `node_modules`:

| Content                                          | Licence                            | Where its text is |
| ------------------------------------------------ | ---------------------------------- | ----------------- |
| `base-map/fonts/Noto Sans *`                     | OFL 1.1                            | missing           |
| `base-map/sprites/*`                             | BSD-3-Clause                       | missing           |
| compiled libvips, `glib`, `libexif`, `libheif`   | LGPLv3                             | missing           |
| the other nineteen libraries inside `vips.wasm`  | BSD-2/3, MIT, zlib, libpng, libtiff, IJG, and aom's patent licence | missing |

The `vips.wasm` row is the largest of these and the least tractable, because it is nineteen
separate texts with nineteen copyright lines, none of which is in the package: `wasm-vips` ships a
*table* of licence names, which is what the section above reproduces, and the MIT text for its own
wrapper. Reproducing the table is not the same as reproducing the notices, and substituting a
generic copy of, say, the BSD-3-Clause text with somebody else's copyright line would be
fabricating an attribution rather than meeting one.

`@protomaps/basemaps` — the source of the sprite sheets and the glyph build — ships no `LICENSE`
file, so there is nothing to copy from. `maplibre-gl` does ship a BSD-3-Clause text, but it carries
MapLibre's copyright line rather than Protomaps', and substituting one for the other would be
fabricating an attribution rather than reproducing one. `wasm-vips` ships the MIT text for its own
wrapper and nothing for libvips.

Resolving this means fetching each text from its source —
[OFL 1.1](https://openfontlicense.org/), the BSD-3-Clause notice as published by
[protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets) with its own copyright
line, the [LGPLv3](https://www.gnu.org/licenses/lgpl-3.0.txt) text, and the notice files each
`vips.wasm` component links to above — and committing them beside the assets they cover. That is a
network fetch and a copyright-holder determination, so it is left for a person rather than guessed
at.

The `wasm-vips` rows are the least urgent in practice, because
[ticket 05](.tracker/ballastella-v1/tickets/05-local-image-to-level-0-pyramid.md) established that
the streaming tiler cannot run on a static host at all with the published build, so nothing
currently reaches it — but `vips.wasm` is nonetheless **in the editor's build today** (ADR-0019's
fence keeps it out of the viewer, not out of the editor), so it is being redistributed whether or
not it runs, and the obligation is live rather than prospective. It is also the most urgent to
resolve *before* the tiler can run, since LGPLv3 carries more than OFL's or BSD's notice
obligation, and aom's patent grant is not a notice obligation at all.
