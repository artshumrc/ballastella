# Base map assets

Everything in this directory is third-party content served as static files. There is no tile
server, no API key, and no per-fork registration anywhere in the base map path — see
[ADR-0005](../../../../docs/adr/0005-maplibre-and-terra-draw.md) and SPEC story 101. That is
also why the attribution below is an obligation rather than a courtesy.

## `amsterdam-centre.pmtiles`

A regional extract of the Protomaps v4 basemap — central Amsterdam, zoom 0–14, 43 tiles, 4.1 MB
— taken from `https://demo-bucket.protomaps.com/v4.pmtiles` with the `pmtiles extract` CLI.

**All four catalog entries that do not need network read this one archive.** The streets,
physical-geography, and muted variants are three style documents over these same bytes, which is
the zero-extra-data claim in ADR-0005 and ADR-0020, demonstrated rather than asserted.

The initial view in `BASE_MAP_CATALOG` lies inside this extract's bounds. A deployment whose
default view falls outside its bundled archive renders a plausible-looking empty map.

| Content | Licence |
| --- | --- |
| OpenStreetMap data | ODbL 1.0 — © OpenStreetMap contributors |
| Natural Earth data | public domain |
| Protomaps basemap build | BSD-3-Clause |

## `fonts/`

SDF glyph ranges from [protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets),
derived from Noto Sans (SIL Open Font License 1.1). Latin ranges only (`0-255`, `256-511`), which
is what the labels in this extract need. `@protomaps/basemaps` gates every label layer behind its
`lang` option, so a base map with labels needs these bundled or it needs the network — and needing
the network for *labels* would quietly defeat SPEC story 88.

## `sprites/`

Icon sheets from the same repository, one per Protomaps flavor (`light`, `dark`, `grayscale`,
`white`, `black`), covering the road shields, one-way arrows, and POI markers the label layers
reference. All five ship even though the catalog currently uses four, because which flavors a
fork chooses is a change to the catalog module alone.
