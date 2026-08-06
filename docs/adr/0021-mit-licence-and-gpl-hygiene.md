# MIT licence, and a fence against GPL contamination

This project is MIT licensed.

The decisive argument is architectural rather than philosophical. ADR-0011 and ADR-0018 commit us to **upstreaming code into triiiceratops** — the OpenSeadragon `TileSource` that resolves through a `ProjectStore`, plus whatever props the integration needs. triiiceratops is MIT. Under GPL-3.0, code could flow *from* triiiceratops *into* this app but never back out, which would destroy the strongest reason for choosing triiiceratops at all: that we maintain it and can upstream changes. MIT-to-MIT makes that flow frictionless in both directions.

Apache-2.0 is defensible for an institutional project — explicit patent grant, NOTICE discipline — but it introduces a milder version of the same one-way-street problem with triiiceratops, and adds ceremony to a tool whose ethos is "fork this."

Dependency licences as of this decision: `@allmaps/*` packages MIT, triiiceratops MIT, `terra-draw` and its adapters MIT, daisyUI MIT, `maplibre-gl` BSD-3-Clause, `pmtiles` and `@protomaps/basemaps` BSD-3-Clause.

## Do not copy from `apps/` in the Allmaps repository

**`apps/editor` and `apps/viewer` are GPL-3.0. `packages/*` are MIT.** We have deliberately read Allmaps Editor to understand its architecture — particularly the MapLibre image-pane projection — and reading is fine. **Lifting a function from it silently relicenses this project.**

This is precisely what a well-meaning contributor does while "just fixing the projection bug," and it is near-impossible to unwind afterwards. It belongs in `CONTRIBUTING.md`, where someone will actually encounter it, not only in this ADR.

## `wasm-vips` requires a third-party licence notice

The wrapper is MIT, but the artefact it ships is compiled **libvips, which `wasm-vips` states as LGPLv3** — reached via the "any later version" clause of LGPLv2.1, so LGPLv3's terms are the ones that bind, not LGPL-2.1's. This decision originally said LGPL-2.1-or-later, and that was checked against the installed package and corrected when ticket 05 made the dependency real.

It ships **twenty other libraries** with it, and they are not incidental: `aom` is BSD-2-Clause *plus* the Alliance for Open Media Patent License 1.0, `glib`, `libexif` and `libheif` are also LGPLv3, and the rest are permissive but each carries its own attribution. The authoritative list is the package's own `THIRD-PARTY-NOTICES.md`, and it is reproduced in [ours](../../THIRD-PARTY-NOTICES.md) rather than summarised, because a bump can change it.

LGPL permits use in permissively licensed software, and lazy-loading it as a separate module (ADR-0003) is closer to dynamic linking than static, which LGPL explicitly contemplates. So this is a notice-and-attribution obligation rather than a problem — but it needs a real third-party licences page. It is the one dependency where "MIT on npm" does not tell the whole story.
