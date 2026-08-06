# Ballastella — v1 Specification

Vocabulary in this document is defined in [CONTEXT.md](../../CONTEXT.md). Decisions are recorded in [docs/adr](../../docs/adr) and referenced by number rather than restated.

## Problem Statement

A historian has a photograph or scan of a historical map and wants to show where its places actually are on the earth, then write about them — labelling sites, tracing routes, outlining regions — and publish the result so colleagues and students can explore it.

Today that requires either specialist GIS software with a steep learning curve and no publishing story, or a hosted platform that takes custody of the work. The hosted route has costs a scholar feels directly:

- The material may be unpublished, rights-restricted, or simply not ready to be public, and uploading it to a crowdsourced database is not acceptable.
- The scholarship becomes a row in someone else's database. If the service changes, charges, or closes, the work is stranded — and links rot on a timescale shorter than a scholarly career.
- The output is a page on someone else's domain, not an artefact that can be cited, archived, deposited, or handed to a librarian.
- Nothing is portable. Alignments and annotations cannot be moved to another platform without loss.

Meanwhile, an instructor teaching this material needs students to produce publishable work without each of them administering a server, and needs to give feedback on specific parts of a specific student's alignment.

## Solution

A browser application at a stable address that reads and writes **a folder the user owns**.

A user picks a **Workspace** directory once. Inside it, each **Project** is a directory holding its **Historical Maps** as level-0 IIIF tiles, its **Alignments** as IIIF Georeference Annotations, and its **Annotations** as GeoJSON. Everything is a plain file in an open format, written as the user works.

Publishing writes a read-only viewer into the workspace. That workspace, pushed to any static host, *is* the website: a hub page listing the projects, each explorable with layer toggles, annotation popups, and a base map switcher. No server, no build pipeline, no account.

The result is scholarship that is simultaneously: a working document, an archivable bundle of standard-format files, a citable website, and — optionally — a real IIIF endpoint other tools can consume.

## User Stories

Which ticket delivers which story is recorded in the `Fulfills` column of [TRACKER.md](./TRACKER.md) and in a `Fulfills` line inside each ticket. Stories that are only partly covered, or covered emergently, are listed under [User story coverage](#user-story-coverage) at the end of this document. **Renumbering these stories breaks both.**

### Getting started and storage

1. As a scholar, I want to choose a folder on my computer as my Workspace, so that my work lives somewhere I can see, back up, and find without the tool's help.
2. As a scholar, I want to point my Workspace at a Dropbox or iCloud folder, so that my research is backed up by tooling I already trust.
3. As a scholar returning to the tool, I want my Workspace already open, so that I resume work without repeating setup.
4. As a Firefox or Safari user, I want the tool to work fully even though my browser cannot grant folder access, so that my choice of browser does not exclude me.
5. As a Firefox or Safari user, I want to export my Project as a zip and import it elsewhere, so that browser-managed storage is not a trap.
6. As a scholar, I want to install the tool as an application, so that it stops asking permission for my folder on every visit.
7. As a scholar, I want to be told plainly when my Workspace folder can no longer be reached, with a way to locate it again, so that a moved folder is an inconvenience rather than a loss.
8. As a scholar, I want to work with no network connection, so that I can align maps in an archive or reading room with hostile wifi.
9. As a scholar, I want to know when a new version of the tool is available and choose when to reload, so that an update never interrupts me mid-alignment.

### Workspaces and projects

10. As a scholar, I want several Projects in one Workspace, so that separate chapters or articles do not contaminate each other.
11. As a scholar, I want to see all my Projects on one page with their names and when I last touched them, so that I can find the one I want.
12. As a scholar, I want to create, rename, duplicate, and delete a Project, so that I can organise work as it evolves.
13. As an instructor, I want to hand a student a Project zip and have them import it into their own Workspace, so that I can distribute a starting point for an assignment.
14. As a scholar, I want to be warned before an import overwrites an existing Project, so that I never silently lose work by accepting a colleague's file.
15. As a scholar, I want to be warned as my Workspace approaches the size limit of free static hosting, so that publishing fails on my terms rather than cryptically.

### Bringing in historical maps

16. As a scholar, I want to add a Historical Map by pasting a IIIF Manifest URL, so that I can work with material a library has already published.
17. As a scholar, I want to paste a IIIF Collection URL and browse what is inside it, so that one URL from a library is enough and I do not have to hunt for individual manifests.
18. As a scholar, I want to paste a bare IIIF image service URL, so that institutions exposing images without manifests are still usable.
19. As a scholar, I want to browse a multi-canvas Manifest and pick the canvas that is the map, so that an atlas or a bound volume is workable.
20. As a scholar, I want to read a Manifest's metadata, rights, and attribution while choosing, so that I know what I am permitted to do with it.
21. As a scholar, I want to add a Historical Map from a file on my computer, so that unpublished material and my own photographs are first-class.
22. As a scholar, I want a very large scan to be usable, so that the most interesting maps in an archive are not the ones the tool rejects.
23. As a scholar, I want progress shown while a large image is prepared, so that I know the tool is working rather than broken.
24. As a scholar, I want to be told immediately and specifically when a remote image cannot be used because its host forbids cross-origin access, naming the host, so that I am not left with a blank map and no explanation.
25. As a scholar, I want to be told when the community has already aligned this map and offered the chance to import that Alignment, so that I do not repeat work others have done.
26. As a privacy-conscious scholar, I want to see that the tool checks a third-party service for existing alignments, and to switch that off, so that working on sensitive material does not disclose what I am examining.
27. As a scholar, I want to make an offline copy of a remote Historical Map, so that my Project survives the host reorganising or disappearing.
28. As a scholar, I want to see the source's rights statement at the moment I choose to copy it, so that I make that decision informed.
29. As a scholar, I want to know which of my Historical Maps are copies and which are references, so that I understand what my Published Site needs from the network.

### Aligning

30. As a scholar, I want to see my Historical Map beside a Base Map, so that I can find the same place on both.
31. As a scholar, I want to zoom deeply into my Historical Map, so that I can place a Control Point on a precise feature.
32. As a scholar, I want to click a point on the Historical Map and then its counterpart on the Base Map to create a Control Point, so that the act matches the single thought "this is there."
33. As a scholar, I want to see clearly that the tool is waiting for the second half of a Control Point, and to cancel with Escape, so that a mis-started pair costs nothing.
34. As a scholar, I want my Control Points visibly numbered, so that an instructor can tell me "look at point 7."
35. As a scholar, I want to drag either half of a Control Point to correct it, so that a near-miss is fixable without starting over.
36. As a scholar, I want selecting one half of a Control Point to highlight its counterpart, so that twenty points remain comprehensible.
37. As a scholar, I want to delete a Control Point as a unit, so that I never create an inconsistent state.
38. As a scholar, I want to undo my last destructive action, so that a mis-aimed drag or an accidental delete does not cost me work.
39. As a scholar, I want to choose how the map is stretched, described by *when to use it* rather than by mathematical name, so that I can make the choice without a cartography course.
40. As a scholar, I want to align a map I photographed at an angle on a table or wall, so that material I cannot scan is still usable.
41. As a scholar, I want to be told an option needs more Control Points than I have placed, so that unavailable choices are explained rather than mysterious.
42. As a scholar, I want changing the stretching method to keep all my Control Points, so that experimenting is free.
43. As a scholar, I want to see where my alignment stretches the map most, so that I can judge how faithful the original is.
44. As a scholar, I want to be warned when my alignment folds over itself, so that a contradictory Control Point is caught rather than shipped.
45. As a scholar, I want to see a grid bent by my alignment, so that I can understand and teach what the transformation is doing.
46. As a scholar, I want to outline the part of the sheet that is the map — excluding margins, titles, and decoration — so that only the map is drawn over the world.
47. As a scholar, I want that outline to start as the whole image, so that my first alignment shows something rather than nothing.
48. As a scholar, I want to view a Historical Map on its own, unwarped, so that I can read its cartouche and inscriptions as a document rather than as geography.

### Layers

49. As a scholar, I want my aligned Historical Maps and my Annotations in one ordered list, so that I control what draws over what.
50. As a scholar, I want to show and hide any Layer, so that I can compare states and build an argument.
51. As a scholar, I want to set the opacity of an aligned Historical Map, so that I can see the modern world through it.
52. As a scholar, I want to reorder Layers, so that labels sit above the map they describe.
53. As a keyboard user, I want to reorder Layers without dragging, so that the central organising feature is available to me.
54. As a scholar, I want to rename a Layer, so that the list describes my argument rather than my filenames.
55. As a scholar, I want several separate Annotation Layers, so that "trade routes" and "parish boundaries" can be shown independently.
56. As an instructor, I want each student to work in their own Annotation Layer of a shared Project, so that contributions stay distinguishable.

### Annotating

57. As a scholar, I want to place a pin on the Base Map, so that I can mark a place.
58. As a scholar, I want to draw a line, so that I can trace a route, boundary, or journey.
59. As a scholar, I want to draw a shape, so that I can outline a region or extent.
60. As a scholar, I want to edit an Annotation's vertices after drawing, so that a rough first pass can be refined.
61. As a scholar, I want to give an Annotation a title, so that it is identifiable in the map and in a list.
62. As a scholar, I want to write a longer description with emphasis and links, so that an Annotation can carry real scholarly prose.
63. As a scholar, I want to choose an Annotation's colour, so that I can group related features visually.
64. As a scholar, I want solid, dashed, and dotted lines, so that I can distinguish certain from conjectural routes.
65. As a scholar, I want to set a default style for a whole Annotation Layer and override it on individual features, so that consistency is cheap and exceptions are possible.
66. As a scholar, I want to delete an Annotation, so that I can revise.
67. As a scholar, I want my Annotations to open correctly in other mapping tools, so that my work is not trapped in this one.

### Base maps

68. As a scholar, I want to choose between Base Maps emphasising streets or physical geography, so that the reference map serves my argument.
69. As a scholar, I want to set which Base Map a Reader sees first, so that the framing of my work is mine.
70. As a Reader, I want to switch Base Maps myself while exploring, so that I can see the historical map against different modern contexts.
71. As a Reader, I want my Base Map preference remembered on this site, so that I do not reset it every visit.
72. As a Reader, I want Base Maps that need a network connection to be marked as such, so that I understand why one is unavailable offline.

### Saving

73. As a scholar, I want my work saved as I go, so that I never lose an afternoon to a forgotten save.
74. As a scholar, I want to see whether my work is saved, saving, or unsaved, so that I can trust the tool with material I care about.
75. As a scholar, I want a crash or closed laptop to cost me at most the gesture I was in the middle of, so that the tool is safe to use on real work.
76. As a scholar, I want opening an old Project not to modify its files, so that merely looking at last year's work does not produce a mysterious change in my git repository or sync a rewrite to my other machines.
77. As a scholar, I want to be told plainly when a Project was made by a newer version of the tool, so that an old copy never silently damages it.

### Publishing

78. As a scholar, I want to publish my Workspace as a website, so that colleagues and students can explore my work.
79. As a scholar, I want publishing to add files rather than copy my images, so that it is fast and does not double my disk usage.
80. As a scholar, I want the published site to work when uploaded to a domain root *or* to a subdirectory, so that free hosting and a custom domain both work without reconfiguration.
81. As a student, I want to publish from one repository for a whole semester, so that I set up hosting once rather than per assignment.
82. As a Reader, I want a hub page listing the projects, so that I can find my way in.
83. As a Reader, I want to explore a Project with working layer toggles, opacity, and annotation popups, so that the published site is genuinely usable rather than a screenshot.
84. As a Reader on a phone, I want the published site to be readable, so that I can look at work someone sent me.
85. As a Reader, I want to view a Historical Map on its own, unwarped, so that I can read it as a document.
86. As a scholar, I want the published site to carry the design of the tool, so that what I show colleagues looks finished.
87. As a scholar, I want to export my Project as a zip containing only data, so that I can archive or deposit it without a bundled application.
88. As a scholar, I want to publish a fully self-contained site including its Base Map, so that it works with no network at all.
89. As a scholar, I want to be shown how much a self-contained Base Map will add before it is added, so that I do not blow a hosting limit by accident.
90. As a scholar, I want to be warned when my published site depends on remote images, so that I know a Reader without a network will see nothing.

### Interoperability and durability

91. As a scholar, I want my Alignment to be a standard IIIF Georeference Annotation, so that Allmaps and other platforms can use my work.
92. As a scholar, I want to make my Historical Map a real, citable IIIF endpoint at a published address, so that other tools and scholars can consume it directly.
93. As a scholar, I want the same files to keep working after I move them between machines, hosts, and domains, so that my work is not bound to where it was made.
94. As a librarian, I want a deposited Project to consist of standard formats with no proprietary index, so that it is preservable.

### Accessibility

95. As a keyboard user, I want to reach and operate every control, so that the tool is usable without a mouse.
96. As a screen reader user, I want guidance and status announced, so that the tool's advice is available to me.
97. As a screen reader user, I want dialogs and menus to manage focus correctly, so that I do not get lost.
98. As a low-vision Reader, I want to choose a high-contrast or muted Base Map, so that annotations are legible to me.

### Forking and hosting

99. As a technically-inclined instructor, I want to fork the tool and host my own instance on free static hosting, so that my institution does not depend on someone else's uptime.
100. As a forker, I want to configure the Base Maps my instance offers, so that I can point at my own tiles.
101. As a forker, I want no API keys or secrets required, so that hosting is genuinely free and forkable.
102. As a contributor, I want the boundary against GPL-licensed sources stated where I will see it, so that I do not accidentally relicense the project.

## Implementation Decisions

### Storage — the central abstraction

All persistence goes through one narrow interface with three adapters (ADR-0001, ADR-0011):

```
ProjectStore
  read(path)   → bytes
  write(path, bytes)
  list(prefix) → paths
  delete(path)
```

- **OPFS** — default, works in every modern browser. Built first, deliberately, so the interface is not shaped around one backend.
- **File System Access** — a capability upgrade giving a real folder. Chromium desktop only. Handle persisted in IndexedDB; `requestPermission()` on return.
- **HTTP `fetch`** over relative paths — read-only, used by the Published Site.

An in-memory fourth adapter exists for tests (see Testing Decisions).

Write behaviour differs by backend: OPFS's reliable fast path (`FileSystemSyncAccessHandle`) is Worker-only, while File System Access's `createWritable()` is async and page-context. The abstraction absorbs this rather than pretending it away.

### On-disk layout

Per ADR-0006 and ADR-0008, the Workspace is the published site root:

```
workspace/
├── index.html + viewer bundle    written by publish; enumerable; removable
├── <project>/
│   ├── project.json              formatVersion, layer list, base map default, canonical URL
│   ├── images/<image-id>/
│   │   ├── info.json             level 0; placeholder id
│   │   ├── manifest.json         IIIF Presentation manifest
│   │   └── <region>/<size>/0/default.jpg
│   ├── alignments/<image-id>.json    IIIF Georeference Annotation
│   └── annotations/<layer-id>.geojson
```

Projects are addressed in the URL by query parameter (`?p=<project>`), so the static adapter prerenders one page and no per-project artefacts need maintaining on rename or delete.

### Layer list

A discriminated union, narrowed on `kind` — explicitly not one type with optional fields (ADR-0002):

```
Layer = { id, name, kind, visible, order } & (
    { kind: 'map',        opacity, alignmentRef, imageMode: 'referenced' | 'mirrored' }
  | { kind: 'annotation', geojsonRef, defaultStyle }
)
```

The list must tolerate a third `kind` later, because image-space annotation is the expected next feature (ADR-0014).

Display state lives here and **never** in the Georeference Annotation or the GeoJSON, both of which are portability documents.

### Image ingest and tiling

Every image is tiled; there is no size exemption, because an untiled level-0 image cannot be parsed at all (ADR-0003). Two implementations of one contract, `ImageSource → level-0 pyramid in the ProjectStore`:

- **Decode-and-crop**, default, zero bundle cost. `createImageBitmap(blob, sx, sy, sw, sh)` into a single tile-sized `OffscreenCanvas`. Canvas *area* limits never bind because no canvas exceeds one tile; the ceiling is full-image decode memory.
- **Streaming**, `wasm-vips` lazily loaded above that ceiling, single-threaded build (the threaded build needs COOP/COEP headers that GitHub Pages cannot set).

Tiles are **square**, and `getTileImageRequest(zoomLevel, column, row)` is used on both sides — it tells the tiler what to write and the image pane what to read, so the two cannot disagree.

Ingest is a job with progress, not a function call.

### Image identity and addressing

- Remote IIIF → `generateId(uri)`, which yields *the same identifier Allmaps uses*, making the community alignment lookup possible.
- Local file → `generateRandomId()`.

Each `info.json` is written with `id: "https://unset.invalid/<image-id>"`, and the real base is assigned to `Image#uri` at load time (ADR-0004). `.invalid` is reserved by RFC 2606, so a forgotten override fails loudly instead of fetching from a wrong host. Publishing optionally rewrites `id` to a user-supplied canonical URL, making the tiles a citable IIIF endpoint.

**Invariant: every code path constructing an `Image` sets `uri` before requesting a tile.** This is the most important invariant in the IIIF layer.

### Getting local bytes to renderers

Local tiles have no URL. Each consumer uses its own documented extension point, all backed by `ProjectStore` (ADR-0011), and all keyed on the `https://unset.invalid/` prefix:

- Allmaps warped rendering — `new WarpedMapLayer({ fetchFn })`, where `FetchFn = (input: Request | string | URL, init?: RequestInit) => Promise<Response>`.
- MapLibre sources, including a bundled pmtiles Base Map and the image pane's raster tiles — `maplibregl.addProtocol()`.
- OpenSeadragon inside triiiceratops — a custom `TileSource`, authored as an upstreamable plugin.

### Map stack

MapLibre GL for both panes; `terra-draw` with its MapLibre adapter for all drawing — Control Points, Resource Masks, and Annotations (ADR-0005). The image pane maps image pixel space into a synthetic geographic window, since MapLibre is Web Mercator only.

Control Point **pairing is ours**; no drawing library has a concept of linked markers across two maps.

```
ControlPoint = { id, ordinal, resource: Point, geo: Point }
```

A pending half exists in UI state only and is never serialised — a GCP is `{ resource, geo }` with both halves required (ADR-0022). Autosave *skips* incomplete pairs rather than erroring on them.

### Alignment

Six transformation types in two tiers, with the *guidance text* as the primary label and the canonical Allmaps string as the stored value (ADR-0013):

| Tier | Label | Stored | Min |
|---|---|---|---|
| Primary | Simple | `helmert` | 2 |
| Primary | **Standard** *(default)* | `polynomial1` | 3 |
| Primary | Perspective | `projective` | 4 |
| Primary | Flexible | `thinPlateSpline` | 3 |
| Advanced | Higher-order (2nd) | `polynomial2` | 6 |
| Advanced | Higher-order (3rd) | `polynomial3` | 10 |

`straight` must never be offered — it is in the type union but throws on deserialisation. `polynomial` is an alias for `polynomial1`; `linear` has no user-facing meaning.

Point count gates the type visibly; changing type never discards Control Points; the Resource Mask defaults to the full image rectangle.

Distortion visualisation ships in v1. `distortionMeasure` selects what is **displayed**; `distortionMeasures` selects what is **computed** — nothing displays if it was never computed. Two measures are exposed: `log2sigma` (default, "how faithful is this map") and `signDetJ` ("did I make a mistake"). The **fold check runs continuously and warns independently of the overlay**; the overlay itself is off by default and not persisted.

### Annotations

One GeoJSON `FeatureCollection` per Annotation Layer. `properties` follows **simplestyle-spec 1.1.0** — `title`, `description`, `marker-size`, `marker-symbol`, `marker-color`, `stroke` (a *colour*), `stroke-opacity`, `stroke-width`, `fill`, `fill-opacity` — so a Layer opens correctly in geojson.io, GitHub, and desktop GIS with no work on our part (ADR-0009).

One extension, because simplestyle has no dash concept: `stroke-dasharray: [dash, gap]`, absent meaning solid. Stored as a tuple, not a keyword, since a tuple is intelligible to anything SVG-aware and feeds `terra-draw`'s `lineStringDash` directly.

`description` holds **Markdown** — chosen for how it degrades, since a consumer that does not render it shows readable prose where HTML shows tag soup. **Rendered Markdown is sanitised**: imported Projects are untrusted content and the viewer is a published site on the user's own domain.

The pipeline is **`marked` → `dompurify` → insert**, never the reverse, and both are declared dependencies of both apps via the catalog. `marked` is chosen on size, since the renderer ships in `apps/viewer` too; the parser is not the security boundary, `dompurify` is (ADR-0009). **Footnotes are out of scope for v1** — see Out of Scope.

Precedence: feature `properties` → Layer default style → simplestyle defaults.

### Base maps

Catalog is deployment configuration and ships in the viewer bundle at publish time. `project.json` records the author's default **by stable id, never by URL** — the same discipline as ADR-0004, and more important here because an unresolvable Base Map renders a plausible-looking *wrong* map rather than an error. Readers switch freely; their choice persists in `localStorage` keyed per site and never touches Project data (ADR-0020).

Because Protomaps flavors are style documents over one dataset, an offline site with a single bundled pmtiles extract still offers several Base Map looks for zero extra bytes. Options needing network are marked.

### Format versioning

`project.json` carries an integer `formatVersion`. Forward-only migrations run **in memory on open**; files are written back only on the user's first actual change, so merely viewing an old Project never dirties a git working tree or syncs a rewrite to another machine (ADR-0010).

An app meeting a higher `formatVersion` **stops and names the remedy**. Without this, an old fork drops unrecognised fields and writes the file back, destroying work with no error. Forking is explicitly encouraged, so backward skew is structural rather than hypothetical.

All `@allmaps/*` packages are pinned exactly and are pre-1.0; an Allmaps upgrade is a migration event.

### Publishing

Additive: `index.html` and a lean read-only viewer are written into the Workspace; no data is copied. `paths.relative: true` is mandatory, because the publish target — domain root or project subdirectory — is unknown at build time. The viewer file set is enumerable so a data-only Project zip can exclude it. The viewer stamps its version so a stale bundle is detectable.

### Application shape

A minimal pnpm monorepo: one `core` package plus two apps, editor and viewer (ADR-0019). The viewer is a separate build so its leanness is enforced by the dependency graph rather than by tree-shaking — it must never depend on `terra-draw`, the tiler, or `wasm-vips`. Shared dependency versions use pnpm catalogs, which is also how the exact `@allmaps/*` pins are expressed once for both apps.

A PWA with a narrowly scoped service worker: app shell only. It must **never** cache Project data (a second source of truth that would diverge on the first offline edit), remote IIIF tiles, or Base Map tiles. No `skipWaiting`; an explicit update prompt, so version skew is visible rather than silent (ADR-0012).

### UI

daisyUI is the only UI dependency, with **methods mandated** because daisyUI documents multiple options per component and states no preference for dropdowns (ADR-0016):

| Surface | Mandated |
|---|---|
| Modal | `<dialog>` + `showModal()` / `close()` |
| Dropdown / menu | Popover API (`popover` + `popovertarget`) |
| Tabs | radio inputs with `role="tablist"` |
| Select | native `<select>` |
| Opacity | native `<input type="range">` |
| Status | `aria-live="polite"` |

Banned: checkbox-hack modal, anchor/hash modal, `<details>` dropdown, CSS-focus dropdown. The Popover mandate also prevents z-index and overflow conflicts with the MapLibre canvas.

Tooltips are **not an information channel** — daisyUI renders them via CSS `::before`, unannounced and undismissable. The transformation guidance in particular must be visible text.

The reorderable layer list is custom and **requires move-up/move-down controls**, not drag-only.

One theme signal drives both the UI and the Base Map flavor, so a dark UI never frames a white map.

### triiiceratops

Imported as a Svelte component from its `./svelte` export, not as a web component — a custom OpenSeadragon `TileSource` must be passed in, which is natural as a prop and awkward as an attribute, and web-component style isolation would fight the theme (ADR-0018).

It owns Manifest and Collection navigation, canvas selection, and unwarped viewing, in both the editor and the Published Site.

**Two IIIF parsers coexist** — `manifesto.js` inside triiiceratops, `@allmaps/iiif-parser` in the alignment path. The contract is that **only an image service URI crosses the boundary**, never a parsed object, so the two can never disagree in a way that matters.

## Testing Decisions

### What makes a good test here

A good test asserts on what the user can observe and would notice if it broke, and does not know how the code is arranged. In this project that has an unusually literal reading: **the user's folder is the product.** So "after this sequence of actions, the store contains these files with this content" is not a proxy for behaviour — it is the behaviour. Tests are written against file contents and rendered UI, never against internal call sequences, private state, or module structure.

Corollary: a test that would still pass after `core` is reorganised, and would fail if a user's Project stopped loading, is a good test. A test asserting that a particular function was called is not.

### Seam 1 — `ProjectStore` with an in-memory adapter

The primary seam. An in-memory `ProjectStore` drives application logic; assertions are on resulting files. Fast, deterministic, no browser required.

Behaviour covered:

- **Ingest** — a fixture image produces a valid level-0 `info.json` and a complete pyramid; the `id` is the `unset.invalid` placeholder; tiles are square; `getTileImageRequest` agrees with what was written for every zoom level, column, and row.
- **Decode ceiling routing** — an oversized source selects the streaming tiler; the output contract is identical either way.
- **Alignment round-trip** — Control Points and Resource Mask survive serialise → deserialise through `@allmaps/annotation` unchanged. Run against **committed fixtures**, since every `@allmaps/*` package is pre-1.0 and this test is what stands between a beta bump and every Alignment in the field being subtly misplaced.
- **Transformation types** — `straight` is never emitted; `polynomial` normalises to `polynomial1`; changing type preserves Control Points; a type is rejected below its minimum point count.
- **Half-pairs** — a pending Control Point half is never written, and autosave skips rather than throws.
- **Annotations** — emitted `properties` conform to simplestyle; `stroke-dasharray` is a tuple; solid is the property's absence; style precedence resolves feature over layer over spec default.
- **Layer list** — reorder, rename, toggle, and opacity changes touch `project.json` and nothing else; the union rejects `opacity` on an annotation Layer at the type level.
- **Referenced vs mirrored** — the mode is recorded; mirroring a level-2 source takes the single `full/max` path.
- **Publish** — the viewer file set appears, is enumerable, and a data-only zip excludes exactly that set; no image bytes are duplicated.
- **Zip round-trip** — export then import reproduces an equivalent Project; a name collision is reported rather than silently overwriting.
- **Migration** — an old `formatVersion` migrates in memory and **writes nothing until the first mutation**; a newer `formatVersion` is refused with a message.
- **Atomic writes** — an interrupted `project.json` write leaves the previous version intact.
- **Base map resolution** — a stable id resolving against a catalog, and an unknown id falling back to the deployment default.

### Seam 2 — the running app in a real browser

Playwright against headless Chromium, with real MapLibre, real OpenSeadragon, and real OPFS. Deliberately no map-abstraction layer: inventing one purely to enable testing is the premature boundary ADR-0019 argues against, and it would test a fake instead of the thing that ships.

Behaviour covered:

- **Pairing** — click-then-click creates a pair; the pending half is visible and Escape cancels it; dragging either half edits the pair; selecting one highlights its counterpart; deleting removes both; ordinals are visible.
- **Mandated methods** — modals are `<dialog>` with working Escape and focus restoration; dropdowns use the Popover API and render above the map canvas without z-index workarounds.
- **Keyboard paths** — every control is reachable; Layer reorder works via move-up/move-down; tab navigation moves by arrow key.
- **Save state** — the indicator transitions saved → saving → saved; a drag produces exactly one write on pointer-up.
- **Guidance is visible text**, not a tooltip, and is present in the accessibility tree.
- **Published site** — served from a subdirectory *and* from a root, layer toggles and opacity work, annotation popups render sanitised Markdown, the Base Map switcher changes maps and persists per site, network-only options are marked, and unwarped viewing opens.
- **Permission flow** — the File System Access grant path, including the unreachable-Workspace state, which can only be exercised in a real browser.
- **Update prompt** — a new service worker does not activate silently.

### Not a seam — pure functions

Tested directly, no boundary needed:

- **Projection round-trip** — pixel → lng/lat → pixel is stable across zoom levels, asserted numerically. This is the highest-risk unknown in the project and its failure mode is silent drift, so it must be a numeric assertion and never visual inspection.
- Distortion computation, id generation, style precedence resolution, and tile-geometry maths.

### Prior art

There is none in this repo — it is greenfield. The nearest reference is the Allmaps monorepo's own package test layout, which may be read for structure. Its `apps/` are GPL-3.0 and must not be copied (ADR-0021).

### Explicitly not tested

Rendering correctness by pixel comparison. Whether a warped Historical Map lands in the right place on screen is verified by the projection round-trip assertion and the `signDetJ` fold check, not by screenshots — cross-platform WebGL screenshot testing is a maintenance sink and the plan should not rest on it.

## Out of Scope

Per ADR-0014:

- **Collaboration and multi-user editing.** Requires a backend; contradicts the local-first premise.
- **Accounts and authentication.** There is no server to authenticate against.
- **In-app git.** Publishing produces files; committing them is documented in prose.
- **Server-side tiling.** A `sharp`-based CLI is described in the docs for images that defeat even the streaming tiler; it is not code we ship.
- **IIIF time-based media.**
- **Aligning a IIIF `Choice`.** Choice can be viewed; alignment operates on one selected image.
- **Cross-project search.**
- **Authoring on mobile.** File System Access exists on no mobile browser and a two-pane Control Point interface on a phone is bad at any effort. **Viewing is fully responsive** — that is where Readers are.
- **Multi-step undo history.** v1 ships single-level undo of the last destructive action. A full command-object history shapes the entire state layer and is a different order of work.
- **Annotating the unwarped image.** The expected next feature, and the reason the Layer union must tolerate a third `kind`: image-space targets are W3C Web Annotations, not GeoJSON, with their own storage and editing surface.
- **Authors curating the Base Map catalog.** They set the default; restricting the list is a later feature.
- **Publishing a single Project standalone.** The Workspace is the site; single-project output is a second mode, deferred.
- **`twoOmega`, `airyKavr`, and `thetaa`** distortion measures. `thetaa` is excluded on principle, not priority: it is an angle, and angles are cyclic, so a linear colour ramp misrepresents it.
- **IIIF Content State and arbitrary non-IIIF image URLs** as ingest paths.
- **Markdown footnotes in an Annotation `description`.** v1 ships emphasis and links. Footnote syntax emits anchor ids and back-references, so several popups on one page collide in the DOM unless ids are namespaced per feature — and the sanitiser must then permit those ids and fragment links, widening the allowlist on the one surface where a mistake is a vulnerability rather than a defect. Footnote syntax typed by a user degrades to literal text (ADR-0009).
- **Rich-text or WYSIWYG authoring of `description`.** A plain textarea with a live preview is the v1 deliverable. A block editor was considered and deferred: the stored value must remain a portable Markdown string for stories 67 and 94, which constrains any editor more than it first appears.

## Further Notes

### Build order is dictated by risk, not by feature order

1. **The synthetic projection for the image pane.** The largest unknown, and its failure is silent — Control Points that drift as you zoom. Everything in the alignment experience sits on top of it, so it is built and numerically asserted first.
2. **`createImageBitmap` crop-tiling against a real archival scan.** The measured decode ceiling is what sets the `wasm-vips` threshold, and that number cannot be guessed.
3. **A generated `info.json` validated against Allmaps end to end**, before anything is built on top of the pyramid format.
4. **The `@allmaps/*` fixture round-trips**, established early since they guard every later upgrade.

### Two decisions that will look wrong later and are not

- **OPFS was built before File System Access**, even though the visible folder is the headline feature. Building the picker first would have shaped the abstraction around one backend and left the cross-browser path to rot, because daily development happens in Chromium.
- **The project directory is the site.** This looks like conflating working state with output, and it is deliberate: the alternative copies gigabytes of tiles on every publish, slowest in exactly the backend that is most constrained.

### The single most fragile invariant

Every `Image` must have `uri` assigned before a tile is requested. Forget it and the failure is a DNS error against `unset.invalid` — chosen precisely so that this failure is loud, immediate, and unmistakable rather than a silent fetch from the wrong host.

### On the audience

The users are historians and students, not GIS professionals. Two consequences run through the whole specification: **guidance text is primary and labels are secondary**, wherever a choice has technical consequences; and **errors must name what is wrong and what to do**, because "checking Allmaps for existing georeferences" and "this host does not allow other websites to load its images" are actionable where a stack trace or a blank map is not.

## User story coverage

Every story above is claimed by at least one ticket. The mapping lives in two places, both of which must be updated together: the `Fulfills` column of [TRACKER.md](./TRACKER.md)'s ledger, and a `Fulfills` line under each ticket's *What to build*.

Stories **95 and 96** (keyboard reach, announced guidance and status) are the exception. They are not assigned to a ticket because accessibility is an acceptance criterion inside every ticket that adds UI; a single accessibility slice at the end reliably becomes a graveyard. Story 97 is assigned to ticket 02, where the `<dialog>` + `showModal()` rule is established and asserted, and reused thereafter.

### Stories only partly delivered

**Story 22 — "a scan far too large for the browser to decode is still tiled".** Delivered only up to
the `createImageBitmap` decode ceiling. Above it, ingest is *refused* rather than routed to the
streaming tiler, because `wasm-vips` cannot run on a static host: npm publishes only the threaded
build, which needs `SharedArrayBuffer` and therefore COOP/COEP headers that GitHub Pages cannot send —
the very reason [ADR-0003](../../docs/adr/0003-every-image-is-tiled-client-side.md) mandates the
single-threaded build, of which no published artefact exists. See open question 3 in
[TRACKER.md](./TRACKER.md). The refusal is deliberate and legible rather than a silent partial pyramid,
and everything at or below the ceiling works; but the story as written is not met, and the measured
ceiling (528,006,700 px, threshold 2^28) is roughly half the range the story implies.

Every other story is covered by the acceptance criteria of the tickets listed against it.

Story 62 was the last entry here, and it was closed by **amending the story rather than adding a criterion**: footnotes are deferred past v1 (see Out of Scope), leaving emphasis and links, which ticket 10 asserts. That gap also surfaced a missing decision — nothing named the Markdown renderer, only the sanitiser — now recorded in ADR-0009 and ticket 10. This section is kept deliberately: the next scope change will want it.

### Stories deliberately read narrowly

- **15** — warned as the Workspace approaches the hosting size limit. Read as *warned at the two moments that matter* rather than as a continuously displayed figure: ticket 15 warns before a mirror, which is the only action that grows a workspace by hundreds of megabytes in one gesture, and ticket 16 warns at publish, where the cliff actually bites. A persistent workspace-size indicator was considered and rejected — it would need recomputing across thousands of tile files to tell a scholar something actionable only at those two moments.

### Stories whose delivery is emergent

Satisfied by the combination of other tickets rather than by any ticket's own criteria. Recorded here so they are not mistaken for gaps.

- **56** — each student works in their own Annotation Layer of a shared Project. Falls out of story 55 (multiple Annotation Layers, tickets 09 and 10) plus ticket 13's zip distribution. There is no collaboration feature and no criterion; the workflow is the instructor's.
- **93** — the same files keep working after moving between machines, hosts, and domains. Delivered by the accumulation of ADR-0004's load-time base-URL resolution, ADR-0020's id-not-URL rule, and ticket 16's relative paths, each asserted in its own ticket. Ticket 16's "stamped Project still opens in the editor" is the closest thing to an end-to-end assertion.
- **94** — a deposited Project is standard formats with no proprietary index. Georeference Annotations (ticket 07), GeoJSON with simplestyle (ticket 10), and the data-only zip (ticket 13). `project.json` is ours, but it holds only display state; nothing in it is needed to read the scholarship.
