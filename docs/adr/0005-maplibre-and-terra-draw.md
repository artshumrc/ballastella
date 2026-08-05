# MapLibre GL + terra-draw, not Leaflet + Geoman

Both the base-map pane and the image pane are MapLibre GL maps. All drawing and editing — control points, resource masks, and annotations — goes through `terra-draw` with `terra-draw-maplibre-gl-adapter`. Rendering of aligned historical maps uses `@allmaps/maplibre`.

The original plan was Leaflet + `leaflet-geoman-free`, and that was reasonable on the information available. Three findings changed it.

**`@allmaps/basemap` is MapLibre-only.** It is described as "Allmaps Basemap style for MapLibre" and depends on `@protomaps/basemaps` and `maplibre-gl`. Choosing Leaflet forfeits it, and the Leaflet substitute — `protomaps-leaflet` — was last published June 2025, renders to canvas, and carries a bespoke styling API disjoint from the entire Protomaps/MapLibre style ecosystem. Any theming work invested there would not transfer.

**MapLibre registers the `pmtiles://` protocol natively**, which makes "everything is static files" true for the base map and not only for project data. A base map becomes a single archive served by HTTP Range requests from any static host — no API key, no tile-provider terms of service, no per-fork registration, and it works offline. That is the project's core principle reaching the one component that would otherwise remain a live service dependency.

**Allmaps Editor runs this exact stack** — `maplibre-gl`, `pmtiles`, `terra-draw`, `terra-draw-maplibre-gl-adapter`, `@allmaps/maplibre`, SvelteKit — so there is a working reference implementation for the hardest part, and matching it makes upstreaming to Allmaps realistic rather than aspirational. It is GPL-3.0: read it for architecture, do not copy it.

Two things that turned out **not** to differentiate the choice, having been checked in source rather than assumed:

- **Dashed and dotted lines.** `terra-draw`'s `lineStringDash` is honoured by both adapters (the MapLibre one converts pixels to line-width units for `line-dasharray`; the Leaflet one maps to `dashArray`). Every style field accepts `(feature) => value`, so patterns are data-driven from GeoJSON `properties`.
- **Multiple base maps.** Protomaps flavors are colour structs over one dataset — a "streets" and a "physical geography" variant are two style documents over the same pmtiles, costing no extra data. Relief needs a `raster-dem` source and MapLibre's `hillshade` layer; keyless open DEM tiles exist. MapLibre also consumes ordinary raster tiles, so remote providers remain available. Base maps therefore become *more* flexible, not less.

`terra-draw` was chosen over `maplibre-geoman-free` on maturity (1.32.2 vs 0.8.4) and because Allmaps ships it. Its lack of a built-in toolbar is acceptable and arguably desirable: a teaching tool wants a small curated set of tools, not a generic GIS toolbar.

## Consequences

- **MapLibre is Web Mercator only, so the image pane needs a synthetic projection** mapping image pixel space into a small lat/lng window. This is the single largest new risk and is spike #1. The failure mode is silent: control points that *drift as you zoom*. It requires an explicit round-trip test (pixel → lng/lat → pixel) at several zoom levels, not visual inspection.
- The drawing toolbar is ours to build.
- `maplibre-gl` is substantially heavier than Leaflet, and the whole render path is now WebGL end-to-end rather than mixing DOM tiles with a WebGL overlay.
- Base maps are a configured list, not a hardcoded layer: default to a remote source, with a bundled regional pmtiles extract as the offline and published-site option. A planet-scale archive cannot live on GitHub Pages (100 MB per-file limit); a regional extract can.
- triiiceratops is unaffected — it is OpenSeadragon-based and owns unwarped IIIF viewing, which never touches the map stack.
