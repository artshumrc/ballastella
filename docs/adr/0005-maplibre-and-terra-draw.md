# MapLibre GL, not Leaflet + Geoman — and no drawing library at all

> **⚠ Amended, and now settled: `terra-draw` is not used anywhere and is not going to be.** Control Points, the Resource Mask, **and Annotations** all reach the panes through the app's own `overlayPoints` seam. The MapLibre GL decision — the substance of this ADR — is untouched. See the [Amendment](#amendment-2026-08-06--control-points-and-resource-masks-do-not-go-through-terra-draw) at the foot of this document for the reasoning, and [Resolution](#resolution) for what closed it.
>
> **Also amended by [ADR-0025](./0025-no-base-map-ships-offline-is-per-project-and-opt-in.md):** no bundled pmtiles extract ships. The offline Base Map is a per-Project, opt-in tile cache.

Both the base-map pane and the image pane are MapLibre GL maps. Drawing and editing goes through the app's own `overlayPoints` seam — **not** through `terra-draw`, which the amendment below explains and which was originally specified here. Rendering of aligned historical maps uses `@allmaps/maplibre`.

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

## Amendment, 2026-08-06 — control points and resource masks do not go through terra-draw

**Status: proposed. This amendment changes a decision record and needs a person to ratify it.** It is written down because the code has already diverged from the sentence above, in tickets 07 and 08, and a decision record that disagrees with the code misleads the next reader — which it did: SPEC.md and ticket 10 both repeated the original wording, and ticket 10's opening line still says terra-draw "arrived in ticket 07". It did not arrive at all. `terra-draw` and `terra-draw-maplibre-gl-adapter` appear in no manifest, in no lockfile entry, and in no source file.

**Control Points and the Resource Mask are drawn and edited through the panes' own `overlayPoints` seam** (`apps/editor/src/lib/overlay/overlay-points.ts`), as MapLibre `Marker`s carrying real `<button>` elements. Annotations are left open, and ticket 10 is expected to adopt `terra-draw` for them; nothing here forecloses that.

Four reasons, in the order of how much weight each carries.

**Keyboard reach, which is decisive on its own.** `terra-draw` edits inside MapLibre GL layers, which are WebGL. A canvas is a single focusable element: it cannot be focused *per feature*, so there is no element for a control point to be, no accessible name for it to have, and no keypress that can be scoped to one of them. Ticket 07's criterion is that **every pairing action is achievable by keyboard**, and ticket 08's mask is edited by arrow keys and Delete. Through `terra-draw` the Resource Mask would have been the first mouse-only editable object in the application. CONTRIBUTING makes keyboard reach an acceptance criterion inside every change that adds UI, and a Harvard-hosted teaching tool is held to WCAG 2.1 AA. The DOM path was needed anyway; having built it, a second editing mechanism beside it would be two ways to move the same point.

**The pairing is ours regardless (ADR-0022 contract 4).** No drawing library has a concept of linked markers across two maps, so `terra-draw` would have carried none of ADR-0022's six behaviours — not the pending half, not the ordinals, not the cross-pane highlight, not "deletion removes the pair, never a half". ADR-0022 already says this in as many words. What was left for a drawing library was the marker rendering, which is the cheapest part.

**ADR-0017 rule 1.** The `overlayPoints` seam commits exactly once, on gesture end, and that is asserted by a *write count* rather than by "a write happened". `terra-draw`'s change events fire per coordinate update, so matching the rule would mean debouncing them — and getting the debounce wrong is a write per frame into OPFS, which is the constrained backend rule 1 exists to protect.

**This ADR's own projection rule.** On the image pane, `terra-draw`'s store would hold the *synthetic* lng/lat this ADR's consequences say must not escape the pane, and every vertex would take an extra projection round trip per edit — inside the loop where this ADR names drift as the largest new risk.

A fifth consideration is smaller but real: ADR-0019 counts two new runtime dependencies, two catalog pins, THIRD-PARTY-NOTICES entries and a standing fence obligation for `apps/viewer`, which for one four-vertex ring and a set of numbered points is overhead rather than leverage.

### What this does not change

- The MapLibre GL decision, the `pmtiles://` protocol, and `@allmaps/maplibre` for warped rendering — the substance of this ADR — are untouched.
- ~~`terra-draw` remains the choice for **annotations** (ticket 10)~~ — see [Resolution](#resolution). It did not.
- ADR-0019's fence still names `terra-draw` as a dependency `apps/viewer` must never have, and `scripts/check-viewer-deps.mjs` still enforces it. That check now passes for a better reason than it used to: nothing anywhere depends on it, and nothing will.

### Resolution

**Ratified, and wider than it was proposed.** The open question was whether to narrow "all drawing and editing goes through `terra-draw`" to annotations alone. Ticket 10 then built annotations on the same `overlayPoints` seam as Control Points and the Resource Mask — `drawing.svelte.ts` holds the gesture state and every vertex is a real `<button>` with an accessible name, arrow-key movement, and Delete — so the last case that might have used a drawing library did not.

So the narrowing is not to annotations; it is to nothing. **`terra-draw` and `terra-draw-maplibre-gl-adapter` appear in no manifest, no lockfile entry, and no source file, and are not planned.** Every reference to them in SPEC and in tickets is stale and must be read as historical.

The keyboard argument turned out to be the whole argument, and it applied to all three cases identically: a WebGL canvas cannot be focused per feature, so anything drawn inside a MapLibre GL layer is mouse-only. This is a Harvard-hosted teaching tool held to WCAG 2.1 AA, and CONTRIBUTING makes keyboard reach an acceptance criterion in every change that adds UI. Having built the DOM path once because accessibility required it, a second editing mechanism beside it would have been two ways to move the same point.
