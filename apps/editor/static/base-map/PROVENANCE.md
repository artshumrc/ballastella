# Base Map assets

This directory ships only the glyphs and sprites used to draw Base Map labels and symbols. No
Base Map tile archive ships with either Ballastella application (ADR-0025).

## `fonts/`

SDF glyph ranges from [protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets),
derived from Noto Sans under the SIL Open Font License 1.1. Latin ranges (`0-255`, `256-511`)
ship because `@protomaps/basemaps` gates label layers behind its `lang` option; without these
files MapLibre silently falls back to system fonts.

## `sprites/`

Icon sheets from the same repository under BSD-3-Clause, one per Protomaps flavor (`light`,
`dark`, `grayscale`, `white`, `black`). They cover road shields, one-way arrows, and POI markers.
All five ship so changing flavors remains a catalog-only deployment change (ADR-0020).

## Network tile archive

For educational development and evaluation, `BASE_MAP_CATALOG` temporarily reads Protomaps'
public demo archive at `https://demo-bucket.protomaps.com/v4.pmtiles`. Its OpenStreetMap data is
ODbL 1.0 and its Natural Earth data is public domain; the UI carries OpenStreetMap and Protomaps
attribution. The hosting has no published rate limit, uptime promise, or terms of use.

This temporary exception is not production configuration. `pnpm check:deployment` refuses to
pass until `REMOTE_ARCHIVE` points at a PMTiles archive controlled by that deployment.

## E2E fixture

The former central-Amsterdam extract is retained at
`e2e/fixtures/base-map/amsterdam-centre.pmtiles` only to provide genuine PMTiles bytes to browser
tests without reaching the network. It was extracted from the Protomaps v4 Base Map with the
`pmtiles extract` CLI: zooms 0-14, 43 tiles, about 4.1 MB.

| Fixture content | Licence |
| --- | --- |
| OpenStreetMap data | ODbL 1.0, © OpenStreetMap contributors |
| Natural Earth data | Public domain |
| Protomaps Base Map build | BSD-3-Clause |
