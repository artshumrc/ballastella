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

**No dependency of this repository is under the GPL or the LGPL**, and none ships a compiled
artefact under a licence other than its wrapper's. `wasm-vips` was the one that did — an MIT npm
wrapper around compiled libvips, LGPLv3, with twenty further bundled libraries of its own — and it
was removed entirely by [ADR-0027](docs/adr/0027-no-streaming-tiler-in-v1.md), which took its
notice and the open item it carried with it. Checked by reading the `license` field of all 291
installed manifests on 2026-08-07, not by assumption: the licences in play are MIT, Apache-2.0,
BSD-2/3-Clause, ISC, MPL-2.0, 0BSD, BlueOak-1.0.0, and Unlicense.

This file is maintained by hand. **A new dependency whose licence is not plainly permissive
— and any dependency that ships a compiled artefact under a different licence from its
wrapper — needs an entry here before it is added.**

## Everything else

Licences as recorded in ADR-0021 at the time of that decision. Entries are listed here
ahead of the tickets that add them, so that the set is reviewed as a whole rather than one
dependency at a time.

| Component                        | Licence       | What it does                                    |
| -------------------------------- | ------------- | ----------------------------------------------- |
| `@allmaps/*`                     | MIT           | Georeference annotation parsing, warped rendering, transformations, and the ids local images are stored under |
| `triiiceratops`                  | MIT           | IIIF Manifest navigation and unwarped viewing — **`apps/viewer` only** (see below) |
| `manifesto.js` (via triiiceratops) | Apache-2.0  | IIIF Presentation parsing inside triiiceratops   |
| `openseadragon` (via triiiceratops) | BSD-3-Clause | Deep-zoom image viewer, inside triiiceratops  |
| `maplibre-gl`                    | BSD-3-Clause  | Both map panes                                  |
| `@maplibre/maplibre-gl-style-spec` | ISC         | The `StyleSpecification` type, across the `core` boundary |
| `pmtiles`                        | BSD-3-Clause  | Single-file tile archive for the offline base map |
| `@protomaps/basemaps`            | BSD-3-Clause  | Base map style documents                        |
| `marked`                         | MIT           | Markdown → HTML, the first stage of the Annotation `description` pipeline (ADR-0009) |
| `dompurify`                      | Apache-2.0 or MPL-2.0 | HTML → sanitised HTML, the second stage, and the security boundary |
| `modern-tar`                     | MIT           | Backup, handoff and review archives, ADR-0001's only way in and out (ADR-0024) |
| `daisyui`                        | MIT           | The only UI **component** dependency (ADR-0016) |
| `@lucide/svelte`                 | ISC, with portions of Feather under MIT | Icons, one glyph at a time — **`apps/editor` only** (ADR-0016's icon amendment) |
| `tailwindcss`                    | MIT           | Styling                                         |
| `svelte`, `@sveltejs/*`          | MIT           | Framework and static adapter                    |

**`triiiceratops` is a dependency of `apps/viewer` alone since ticket 15**, and its three rows stay
because that changes *where* it is redistributed and not *whether*. `apps/editor` dropped it with
its unwarped view ([ADR-0018](docs/adr/0018-triiiceratops-embedded-as-a-svelte-component.md), see
the amendment note), and the editor's own bundle now carries no OpenSeadragon. The published viewer
still does, every published site ships that viewer, and the editor build embeds a copy of it under
`build/viewer-bundle/` so that publishing has something to write — so triiiceratops, `manifesto.js`
and `openseadragon` are all still redistributed by this project and all three notices are still
owed. Nothing was removed from this table by that ticket; only the description of what ships where
was corrected.

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

**Two rows shorter than it was, by deletion rather than by discharge.** It also listed the LGPLv3
text for compiled libvips, `glib`, `libexif` and `libheif`, and the nineteen further notices inside
`vips.wasm` — nineteen separate texts with nineteen copyright lines, none of which shipped in the
package. [ADR-0027](docs/adr/0027-no-streaming-tiler-in-v1.md) removed `wasm-vips` from the
repository, so nothing is redistributed and there is nothing left to accompany. That was the
largest and least tractable part of this item and it is closed.

`@protomaps/basemaps` — the source of the sprite sheets and the glyph build — ships no `LICENSE`
file, so there is nothing to copy from. `maplibre-gl` does ship a BSD-3-Clause text, but it carries
MapLibre's copyright line rather than Protomaps', and substituting one for the other would be
fabricating an attribution rather than reproducing one.

Resolving this means fetching each text from its source —
[OFL 1.1](https://openfontlicense.org/), the BSD-3-Clause notice as published by
[protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets) with its own copyright
line — and committing them beside the assets they cover. That is a network fetch and a
copyright-holder determination, so it is left for a person rather than guessed at.

Both remaining rows are live rather than prospective: the fonts and sprites are committed bytes in
this repository and ship in every editor build and every Published Site.
