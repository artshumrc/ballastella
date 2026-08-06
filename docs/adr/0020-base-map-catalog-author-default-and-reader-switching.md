# Base maps: deployment catalog, author default, reader switching

> **Amended by [ADR-0025](./0025-no-base-map-ships-offline-is-per-project-and-opt-in.md):** no pmtiles archive ships, and the deployment must name its own or the build fails. "Publishing an offline site copies the pmtiles extract" below is replaced by a per-project, opt-in cache of the tiles that project's own content needs. `PublishedSite.baseMapBundled` changes meaning accordingly. The **zero-extra-bytes claim survives intact**, because the cache holds vector tiles and the several looks are still style documents over one dataset.
>
> **Amended by [ADR-0026](./0026-the-opening-view-is-computed-from-the-projects-content.md):** `BASE_MAP_CATALOG.initialView` is no longer what a project opens on — the view is computed from the project's own content, and `initialView` survives only as the fallback for a project with nothing placed on the earth. Note that ADR-0026 declines, for now, to store an author-chosen opening view, *even though this ADR's own argument for storing the author's base-map default — "the default still governs first contact, which is the moment that carries the argument" — applies to the viewport just as well.* ADR-0026 records that tension rather than resolving it.

- The **catalog** of available base maps is deployment configuration, and ships inside the viewer bundle at publish time.
- **`project.json` records the author's default** base map, by **stable id** — never by URL.
- The **viewer exposes a base map switcher**, so a reader can change base maps in a published, read-only site.
- **A reader's choice is never written to project data.** It persists in `localStorage`, keyed per site.

## Why intent, not address

Whether a base map is showing streets or physical geography is genuinely authorial — a scholar aligning a 1625 map may choose a muted physical base precisely because it makes their argument legible, and the same map over a modern street grid says something different. So the choice must survive publishing, zipping, and moving between deployments.

But a pmtiles URL or tile endpoint is deployment-specific. Recording one in `project.json` is the mistake ADR-0004 exists to prevent, and it is worse here: a base map that fails to resolve renders a plausible-looking but **wrong** map rather than an obvious error.

So `project.json` says `"baseMap": "physical"` and the deployment says what `"physical"` resolves to. A project moved between the Harvard instance, a student's fork, and a colleague's zip keeps its authorial choice and picks up whatever that environment can serve. A missing id falls back to the deployment default, quietly noted rather than failed.

The author sets the **default**; the reader may deviate. The default still governs first contact, which is the moment that carries the argument.

## An offline site still has a working switcher

Because Protomaps flavors are style documents over one dataset (ADR-0005), a published site with a single bundled pmtiles extract can still offer several base map *looks* — streets-emphasised, physical-emphasised, light, dark — for **zero extra bytes**. Only raster imagery options such as satellite or historical topo require network.

## Consequences

- **The switcher must distinguish available-offline from needs-network**, or a reader on a plane selects satellite imagery and gets a blank map with no explanation. Grey out or label.
- **The viewer is less lean than ADR-0019 might suggest.** It carries the full catalog and style-switching logic, not merely "render the configured style." Still far below the editor's weight, but the viewer's dependency fence is about `terra-draw`, the tiler, and `wasm-vips` — not about base map capability.
- **Publishing an offline site copies the pmtiles extract into the workspace.** That is the only way a published site works without network, and it draws on ADR-0008's shared ~1 GB GitHub Pages budget. The publish step must show the size it is about to add.
- **`localStorage` is keyed per site**, so a reader's preference on one scholar's site does not leak into another's.
- Authors set the default only; they do not curate the catalog in v1. Restricting the list — a teacher constraining students to two base maps — is a plausible later feature.
