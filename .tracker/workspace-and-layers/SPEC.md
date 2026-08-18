# Workspace and Layers

## Problem Statement

Ballastella can align a Map Image onto the world, annotate it, and publish it. But a scholar sitting down in front of it has to learn the tool's architecture before they can use it, and four specific things stand in their way.

**They cannot stay in one place.** Aligning happens on the Project page; the stack of Layers over the Base Map is a *different* page. Noticing that a Control Point is wrong means seeing the Map Image sitting crooked on the stack page, then navigating to the Project page to fix it, then back to check. The two views are about the same work and are never on screen together.

**The tool asks them architecture questions before it asks them anything else.** First contact is a section headed "Where your work is stored," weighing browser-managed private storage against a directory handle. And every Project opens on central Amsterdam at zoom 13 — the bounds of a 4 MB Base Map extract that ships with the app — regardless of whether the scholar's work is in Boston, Batavia, or the Baltic.

**A Map Image belongs to one Project, forever.** A scholar teaching two courses from the same 1625 survey must bring it in twice, wait for it to be tiled twice, align it twice, and store two copies of a pyramid that may be gigabytes. Under the shared ~1 GB static-hosting budget, that is the difference between a semester's work publishing and failing.

**A Map Image on a library's server cannot be aligned at all.** The tool will show it, and will copy it locally, but the only way to *place* it on the earth is to copy the whole pyramid off someone else's server first — which is slow, which may be thousands of requests, and which is exactly the copy ADR-0007 says not to make by default.

Beneath all four: the application has accumulated more surface than its audience can carry. It is meant to be usable by a fourth-grader without instructions, and today it has two ways to look at a Map Image (one of which works for half of them, for reasons no user could infer), three places a Base Map can be chosen, a repair button for a half-finished copy, and a theme toggle on two pages and not others.

## Solution

**One screen.** Entering a Project puts the scholar on a Base Map with a sidebar of Layers, and that is where they stay. Adding a Map Image, adding Annotations, reordering, renaming, hiding, fading, and publishing all happen without leaving it. Aligning opens one dedicated split-screen view — the sheet beside the world — reached from the Layer that needs it and returning to exactly where they were.

**The map opens on the work.** A Project's opening view is computed from what the Project has actually placed on the earth: its Annotations and its aligned Map Images, fitted with padding and a sensible zoom ceiling. A Project with nothing placed yet falls back to the deployment's default.

**Map Images belong to the Workspace, not to a Project.** A map is brought in once, aligned once, and used by any number of Projects. The Workspace answers *where a map sits on the earth*; a Project answers *how maps are presented and what is stacked over them* — its name for the Layer, its visibility, its order, its opacity, and the Annotations drawn above. Adding a Layer offers three sources: a file on this computer, a remote IIIF resource, or a Map Image already in the Workspace.

**A referenced Map Image is alignable in place.** The same pane aligns a map whose tiles are in the Workspace and a map whose tiles are on a Library's server. Making an offline copy afterwards keeps the Alignment and moves the map off the network — and because there is one Alignment per map, that is one file to correct rather than one per Project.

**No Base Map ships, and offline coverage is asked for.** The 4 MB Amsterdam extract is gone. A scholar who wants a Project to work with no network says so, is shown how many tiles and how many megabytes that will take, and agrees to it. The tiles cached are the ones that Project's own content needs.

**Backup and handoff become different things.** A tar of the whole Workspace is how a scholar on Firefox, Safari, or an iPad backs up, restores, and moves between computers. A single-Project bundle is how a student hands work to a teacher — and it opens in a throwaway Review Workspace, never merged into the recipient's own.

**And the surface comes down.** The editor's unwarped viewer goes, and triiiceratops with it. The standalone Base Map page goes. The Referenced and Offline-copies sections go, their information becoming badges on Layer cards. The half-finished-copy repair path goes, because the state it repaired cannot occur. Distortion visualisation moves behind one "check this alignment" affordance. The storage question moves out of first contact. One theme toggle, in one place, governing the interface and the Base Map together.

## User Stories

### Working inside a Project

1. As a scholar, I want entering a Project to put me straight onto a map with my Layers beside it, so that I begin working rather than navigating.
2. As a scholar, I want the map to fill the useful part of the screen, so that the thing I am studying is the thing I am mostly looking at.
3. As a scholar, I want to add a Map Image, reorder Layers, rename them, hide them, and fade them without leaving this screen, so that my attention stays on the work.
4. As a scholar, I want a Project's opening view to frame everything I have placed on the earth, so that I see my own work rather than a city I have never visited.
5. As a scholar, I want a Project with nothing placed yet to open somewhere deliberate, so that an empty Project does not look broken.
6. As a scholar, I want zooming out never to go blank inside the area I have made available offline, so that the map does not appear to break when I pull back.
7. As a scholar, I want a Project with a single Annotation to open at a sensible neighbourhood zoom, so that my first sight is not four roof tiles.
8. As a scholar, I want the opening view never to move on its own after I have started working, so that toggling a Layer does not pull the map out from under me.
9. As a scholar, I want an explicit way to re-frame the map on my Project, so that I can get back to the overview after wandering.
10. As a scholar, I want to rename my Project from a menu on this screen, so that I do not need a separate page for one field.
11. As a scholar, I want to see which folder my Project is in and when it was last saved, so that I can find my files and trust that they are current.
12. As a scholar, I want the save indicator and the undo control visible wherever I am working, so that I always know my work is kept and can be taken back.

### Layers as the one organising idea

13. As a scholar, I want every Layer to be one row I can read at a glance, so that the stack tells me what my Project contains.
14. As a scholar, I want a Layer to open in place to reveal what is inside it, so that I learn the structure by using it rather than by being told.
15. As a scholar, I want only one Layer open at a time, so that the sidebar does not become a wall of controls.
16. As a scholar, I want an Annotation Layer to open into its drawing tools and its list of Annotations, so that drawing is where the Annotations are.
17. As a scholar, I want a Map Image Layer to open into its alignment state and a way to fix it, so that the thing that needs doing is where the thing that needs it lives.
18. As a scholar, I want one Map Image per Layer, so that a Layer's controls always mean one predictable thing.
19. As a scholar, I want to add as many Map Image Layers as I like, so that a Project can hold a whole series of sheets.
20. As a scholar, I want a Layer of a kind this version does not understand to be kept, nameable, and reorderable rather than discarded, so that a Project written by a newer version survives a round trip through this one.

### Bringing a Map Image in

21. As a scholar, I want one obvious action to add a Map Image, so that I do not have to know in advance which kind of map I have.
22. As a scholar, I want to choose between a file on this computer, a remote IIIF resource, and a Map Image I already have, so that all three ways in are equally visible.
23. As a scholar, I want to see which Map Images I already have, with their sizes, so that reusing one is easier than fetching it again.
24. As a scholar, I want the list of maps I already have to exclude the ones already in this Project, so that I am not offered something that would do nothing.
25. As a scholar, I want a large scan's progress reported as it is prepared, so that I know the tool is working and roughly how long is left.
26. As a scholar, I want to cancel preparing a scan I picked by mistake, so that a wrong click does not cost me minutes.
27. As a scholar, I want a cancelled or failed preparation to leave my Project exactly as it was, so that a mistake cannot damage my work.
28. As a scholar, I want to be told plainly when an image is too large for this browser to prepare, so that I understand the limit rather than seeing a hang.
29. As a scholar, I want to paste a IIIF Manifest, Collection, or bare image service URL, so that I do not have to know which kind of address a library gave me.
30. As a scholar, I want to pick which image in a multi-image Manifest is the map, so that I align the sheet rather than the binding.
31. As a scholar, I want a remote resource that cannot be aligned to be refused when I add it, with the reason and the host named, so that I am not promised a screen that then fails.
32. As a scholar, I want a remote resource whose tiles cannot be read cross-origin to be refused when I add it, so that I do not get a blank map with no explanation.
33. As a scholar, I want to be told when someone has already aligned this map, so that I can start from their work instead of from nothing.
34. As a scholar, I want a Map Image to appear in my Layer list as soon as I add it, so that adding it produces something visible.
35. As a scholar, I want a newly added Map Image to be marked clearly as not yet aligned, so that I know what is left to do.
36. As a scholar, I want adding the same remote resource twice to give me one Layer, so that a class all adding the same map produces one map each.

### Aligning

37. As a scholar, I want one button on the Layer that needs aligning to take me to the alignment view, so that there is exactly one answer to "how do I align this?".
38. As a scholar, I want the alignment view to show the sheet beside the world, so that I can see both things I am relating.
39. As a scholar, I want to align a map whose tiles are on a Library's server without copying it first, so that I can work with material I am not entitled to duplicate.
40. As a scholar, I want aligning a remote map to look and behave exactly like aligning my own file, so that I do not have to learn two procedures.
41. As a scholar, I want to click a feature on the sheet and then the same place on the earth to make a Control Point pair, so that the gesture matches what I am actually doing.
42. As a scholar, I want the pending half of a pair visible, and cancellable with Escape from anywhere on the page, so that a mis-aimed first click is not a trap.
43. As a scholar, I want to drag either half of a pair to correct it, so that I can refine without deleting.
44. As a scholar, I want selecting one half to highlight its counterpart, so that I can see which points correspond.
45. As a scholar, I want deleting a Control Point to remove both halves, so that I never have a half a pair.
46. As a scholar, I want every part of pairing reachable by keyboard, so that I can work without a pointer.
47. As a scholar, I want to choose how the map is stretched, described by when to use it rather than by its mathematical name, so that I can choose without a cartography course.
48. As a scholar, I want to be told when an option needs more Control Points than I have placed, so that an unavailable choice is explained rather than mysterious.
49. As a scholar, I want changing the stretching method to keep all my Control Points, so that experimenting costs nothing.
50. As a scholar, I want to be warned when my alignment folds over itself, without asking for the warning, so that a contradictory Control Point is caught before it ships.
51. As a scholar, I want to ask to see where my alignment stretches most, and a grid bent by it, so that I can judge and teach faithfulness — but not to have those on screen while I work.
52. As a scholar, I want to outline the part of the sheet that is the map, excluding margins and decoration, so that only the map is drawn over the world.
53. As a scholar, I want that outline to start as the whole sheet, so that my first alignment shows something rather than nothing.
54. As a scholar, I want the outline's handles only when I ask for them, so that eight draggable corners are not in the way of placing points.
55. As a scholar, I want to reopen a half-finished alignment and land where I was working, so that I do not navigate back to my own points every time.
56. As a scholar, I want to be told which Projects use this Map Image while I am aligning it, so that I know what my changes affect.
57. As a scholar, I want one obvious way back to my Project, so that the alignment view feels like a room and not a detour.
58. As a scholar, I want my alignment to be there when I come back, without saving it, so that I never lose work to a forgotten button.
59. As a scholar, I want to take back a mis-aimed drag or a wrongly deleted Control Point, so that I trust the tool enough to experiment.
60. As a scholar, I want an alignment I make to be usable by other IIIF tools, so that my work is not trapped in this application.

### Map Images as Workspace property

61. As a scholar, I want a Map Image I have brought in to be usable by any of my Projects, so that I prepare and align it once.
62. As a scholar, I want a map's alignment to be the same wherever it is used, so that "where this map is on the earth" has one answer.
63. As a scholar, I want to see every Map Image in my Workspace with its size and which Projects use it, so that I can understand what my Workspace holds.
64. As a scholar, I want deleting a Map Image that is in use to be refused, naming the Projects that use it, so that one click cannot destroy several arguments.
65. As a scholar, I want to delete a Map Image no Project uses, so that I can reclaim space I am no longer spending.
66. As a scholar, I want deleting a Project to leave my Map Images alone, so that tidying up one piece of work does not cost me the material.
67. As a scholar, I want removing a Layer to leave the Map Image available, so that I can put it back if I change my mind.
68. As a scholar, I want to put a Map Image back into a Project after removing its Layer, so that a deletion is not permanent by accident.

### Offline, and copies

69. As a scholar, I want my own Map Images, Alignments, and Annotations to work with no network at all, so that a reading room's hostile wifi does not stop me.
70. As a scholar, I want to say that a Project should work offline, so that I decide what is worth the bytes rather than the tool deciding for me.
71. As a scholar, I want to be shown how many tiles and how many megabytes making a Project offline will take, before it happens, so that I agree to a known cost.
72. As a scholar, I want an unreasonably large offline request refused with an explanation, so that I do not start something that will not finish.
73. As a scholar, I want to see which of my Projects are available offline, so that I know what I can rely on before I travel.
74. As a scholar, I want the Base Map to be absent with an explanation rather than blank, when there is no connection and no cache, so that I can tell absence from breakage.
75. As a scholar, I want to make an offline copy of a Map Image that stays on a Library's server, so that my work survives that library reorganising.
76. As a scholar, I want an offline copy to keep the address it came from, so that I can still cite it.
77. As a scholar, I want to make an offline copy of a map I have already aligned, keeping every Control Point, so that placing and preserving are not a single-chance decision.
78. As a scholar, I want to be warned before copying when the source would take thousands of requests, so that I do not hammer somebody else's server unaware.
79. As a scholar, I want to see the source's rights statement at the moment I choose to copy it, so that I make a rights decision knowingly.
80. As a scholar, I want a Layer whose map needs the network to say so, so that I know which parts of my Project depend on somebody else.
81. As a scholar, I want to be told, when there is no connection, which hosts cannot be reached and that the rest of my Project still works, so that I keep working on what I can.

### Backing up, restoring, and handing over

82. As a scholar on Firefox, Safari, or an iPad, I want to back up my whole Workspace to one file, so that my work is not trapped in a browser I cannot see into.
83. As a scholar, I want a backup to succeed however large my Workspace is, so that the safety net does not fail exactly when I need it.
84. As a scholar, I want to restore a backup on another computer, so that I can move between machines.
85. As a scholar, I want restoring to create a new Workspace rather than overwrite the one I have, so that recovering from damage cannot destroy what I am recovering from.
86. As a scholar, I want to be told that a restored Workspace needs publishing again before it is a website, so that I do not hand out a stale site.
87. As a scholar, I want to know before restoring if there is not enough room, so that it does not fail part way through.
88. As a scholar, I want to see which Workspace I am in at all times, so that I never work in the wrong one.
89. As a student, I want to send one Project to my teacher as a single file, so that handing in work is one action.
90. As a teacher, I want to open a student's Project without it touching my own research, so that marking cannot damage my work.
91. As a teacher, I want to interact with a student's Project as though it were mine — panning, toggling Layers, reading Annotations — so that I can actually assess it.
92. As a teacher, I want several students' Projects open as separate throwaway Workspaces, so that I can move between submissions.
93. As a teacher, I want to be told clearly and constantly that I am in a throwaway Workspace, so that I cannot mistake it for my own.
94. As a teacher, I want to discard a student's Project when I am done, so that my Workspace does not accumulate other people's work.
95. As a librarian, I want a Project's files to be complete, standard, and readable without this application, so that they can be deposited in a repository.

### Publishing and reading

96. As a scholar, I want to publish from one place and have every Project in my Workspace become a site, so that setting up hosting is a once-per-semester job.
97. As a scholar, I want to be told how large my published site will be and how close it is to the hosting limit, so that a push does not fail cryptically.
98. As a scholar, I want to be told how much of that size is Map Images no Project uses, so that I know what I can reclaim.
99. As a scholar, I want to be told when my published site will need a network connection, so that I do not promise a reader something that fails on a plane.
100. As a reader, I want a published Project to open framed on the work, so that my first sight carries the argument.
101. As a reader, I want to read a Map Image as a document — the cartouche, the title, the decoration — separately from its place on the earth, so that I can look at the sheet as an object.
102. As a reader, I want to switch Base Maps, including to a muted high-contrast one, so that Annotations stay legible for me.
103. As a reader, I want my Base Map choice remembered for this site and not to leak into another scholar's, so that my preference is mine and local.
104. As a reader on a phone, I want the published site to read well, so that I can follow the argument where I actually am.

### Learning the tool without being taught

105. As a first-time user, I want to be able to start without answering a question about storage, so that the first thing I meet is my work and not the tool's architecture.
106. As a first-time user, I want every empty state to tell me the one useful next action, so that I never have to look for instructions.
107. As a scholar, I want the option to put my Workspace in a folder I can see, offered where I would look for it rather than in my way, so that the capability is available without being a gate.
108. As a scholar, I want to install this as an application, so that my folder permission stops being asked for every visit.
109. As a scholar, I want one theme control, in one place, that changes both the interface and the Base Map together, so that I can read a light page on a dark desktop.
110. As a scholar, I want my theme choice remembered, and my system's preference respected until I make one, so that the tool matches my machine without ignoring me.
111. As a scholar, I want explanations as visible text rather than tooltips, so that I can read them with a keyboard or a screen reader.
112. As a scholar using a screen reader, I want every change the map makes to be announced, so that I am not told less than a sighted user.
113. As a scholar, I want an update to this application never to arrive silently while I am working, so that my session is not replaced mid-alignment.
114. As a scholar, I want a Project written by a newer version of this application to be refused with an explanation naming where to get that version, rather than partially loaded, so that my files are never silently damaged.

## Implementation Decisions

Every decision below has an ADR. Where one exists, it is authoritative and this section is a summary.

### Storage layout — ADR-0023

Map Images and Alignments move to the Workspace root. A Project directory holds `project.json` and `annotations/` only.

```
workspace/
├── index.html                     ← publish output (ADR-0008)
├── images/<image-id>/             ← shared: info.json, manifest.json, remote.json, tiles
├── alignments/<image-id>.json     ← shared: one per Map Image
├── base-map/tiles/<archive>/{z}/{x}/{y}.mvt  ← opt-in offline cache, keyed by archive (ADR-0025)
└── <project-directory>/
    ├── project.json
    └── annotations/<layer-id>.geojson
```

**The line:** the Workspace owns where a Map Image sits on the earth; a Project owns how maps are presented and what is stacked over them.

**Accepted risk, recorded rather than mitigated away:** refining an Alignment moves every Project using that map, published ones included. The mitigation is visibility — the alignment view names those Projects — not prevention. **Accepted cost:** a Map Image can be aligned only one way; more than one Alignment per map is a deliberate v2 candidate.

### The Layer model

`MapLayer` loses `alignmentRef` and `imageMode` and gains an image id. `imageIdFromAlignmentRef` and `mapLayerImageInfoPath` go with them. One Map Image per Layer — no grouping, no nesting.

```
MapLayer        { kind: 'map',        id, name, visible, order, opacity, imageId }
AnnotationLayer { kind: 'annotation', id, name, visible, order, geojsonRef, defaultStyle }
ForeignLayer    { kind: 'foreign',    id, name, visible, order, declaredKind, … }
```

**`imageMode` is not stored, because it is observable.** A Map Image in the Workspace either has an `info.json` of ours — tiles are here — or only a `remote.json` — tiles are on a Library's server. So `imageModeOf`, `localCopySource`, `#reconcileLocalCopies`, `unfinishedCopies`, and the "Finish the offline copy" repair path are all deleted: with one Alignment per map, nothing remains that can disagree with the bytes on disk.

**Layers are created eagerly, by an explicit gesture only.** Consequently `ProjectFile.removedMapLayers`, `#ensureMapLayer`, and `#placingMapLayers` are deleted — the tombstone existed solely because Alignment writes created Layers lazily. A **starter Alignment** is written when a map is added to the Workspace, so no Layer ever holds a dangling reference and reference-integrity validation is untouched.

**"Not aligned" is derived, never stored:** `controlPoints.length < MINIMUM_CONTROL_POINTS`, which `canSolve` already computes — so a partially aligned map warns correctly. The cost is that the sidebar reads the Alignment of every map Layer, not only visible ones.

### Routes and information architecture

| Route | Purpose |
| --- | --- |
| `/` | Hub: Projects, Workspace Map Images, publish, transfer |
| `/?p=<dir>` | **The Project**: Base Map with a Layer sidebar |
| `/align/?p=<dir>&layer=<layer-id>` | Split-screen alignment, keyed by **Layer** id |
| `/image-pane/` | Retained, unlinked: the only storage-independent projection coverage |

`/base-map/` is deleted. `ProjectView` as a page is deleted. Its parts redistribute: the name and folder into a Project settings dialog; ingest and remote-add into the Layer sidebar's add flow; the Referenced and Offline-copies sections into badges and actions on Layer cards.

An app-level navigation bar in the root layout carries the four things true on every screen — Workspace identity and switcher, theme toggle, save indicator, undo — plus the Review Workspace banner. Project-specific controls (name, Base Map switcher, settings) stay out of it. **Alignment is reachable only from a Layer card**, never from the hub: one door, and a Base Map chosen by the Project the argument belongs to.

The sidebar uses **progressive disclosure**: one Layer open at a time, opening in place. A map Layer reveals alignment state and an Align button; an Annotation Layer reveals its tools and Annotations. One idea applied twice.

### Remote IIIF alignment — ADR-0007 as amended

`createImagePane(info, tiles)` already accepts an absolute base URI as well as `{ storedImageId }`, and the tile protocol is generic over its injected `fetch`, which passes non-placeholder hosts to the network. So the image pane takes an `ImagePaneTileBase` rather than always deriving the placeholder, and the same pane aligns either source. No second image viewer.

**Refusal is decided at add time, in the same probe as CORS.** A remote level-0 service publishing no `tiles` property and supporting no arbitrary regions cannot be aligned — `getTileZoomLevels` throws `"Image does not support tiles or custom regions and sizes."` The probe builds the pane; if it throws, the resource is refused then, naming the host and the reason.

**Offline contracts.** With no network the pane cannot be built at all, because `info.json` is on the Library's server; the alignment view refuses to open and names the host. `remote.json` carries width and height but not the tileset, so synthesising a pane from it is guesswork and is not done. Losing the network *during* alignment does **not** block the pane: its coordinate space is valid whether tiles arrive or not, and blocking would discard work in progress.

### Base Map — ADR-0025

No pmtiles archive ships. **Glyphs and sprites still do** (636 KB, 184 KB): every label layer is gated behind glyphs, and without them the map draws while MapLibre silently falls back to system fonts.

The catalog deployment fence **fails `pnpm check:deployment` while the catalog points at `demo-bucket.protomaps.com`** — the bucket this repo already documents as unsuitable to rely on. By explicit human decision on 2026-08-07, ordinary development and educational evaluation temporarily retain that URL because there is no hosting budget; it remains blocked for production. Every production deployment names its own archive, which ADR-0020 makes a one-line change. The Amsterdam extract stays as an **e2e fixture**, not as shipped output.

The offline cache is individual vector tiles at `base-map/tiles/<archive-key>/{z}/{x}/{y}.mvt` behind a MapLibre `addProtocol` handler — **keyed by archive since ticket 12**, because ADR-0020 makes two catalog entries on two archives a supported deployment and one shared directory would serve both, drawing a plausible pane of the wrong world with no error anywhere — ADR-0011's pattern, as already implemented for Map Image tiles. Writing a PMTiles v3 archive was rejected: `pmtiles@4.4.1` has no writer, and hand-rolling one is archive-format code whose failure mode is silent. Caching byte ranges was rejected: the cached unit would depend on access pattern, and a near-miss range renders holes, which reads as corruption.

Contracts: the tile count and byte estimate are shown before they are spent, with a refusal threshold; **every** zoom level from 0 to the source's maximum is cached over the extent, because omitting low zooms makes zooming out go blank; compression is explicit, since PMTiles stores tiles gzipped and serving them as though it did not is a silent blank map; attribution survives caching, because ODbL does not lapse when no request happens. The cache is Workspace-level and therefore deduplicates across Projects, so "is this Project offline?" is computed, not a flag that can lie. `PublishedSite.baseMapBundled` changes meaning to "this Workspace carries cached tiles", and `PublishedSite.baseMapCaches` — which replaced `baseMapMaxZoom` in ticket 12, at `formatVersion` 2 — names **which archives** those tiles are for and how deep each goes, because a Reader's HTTP store cannot list a directory and a key cannot be read backwards. A record written before that is read as one cache belonging to no archive, so an already-published offline site keeps drawing.

### Opening view — ADR-0026

A pure function in core. `@allmaps/transform`'s `GcpTransformer` is already a direct dependency, so an aligned map's extent comes from transforming its Resource Mask ring — no renderer, no async race. Annotation bounds come off the GeoJSON.

Fallback chain: visible Layers → all Layers → `BASE_MAP_CATALOG.initialView`. Unaligned maps contribute nothing. Fit **once, on open**, never again; an explicit re-frame control covers the rest. Zoom capped, box padded. **The published viewer uses the same function.** The alignment view fits to the Alignment's Control Points when it has any.

Nothing about the view is written to `project.json`. An author-set opening view is a recorded v2 candidate, and ADR-0026 preserves the argument for it.

### Transfer — ADR-0024

Two artefacts, both tar:

- **Workspace backup** — the whole Workspace, excluding published viewer files (`isViewerFile` already enumerates them). Restore **creates a new named Workspace and switches to it**; it never overwrites and never merges.
- **Project bundle** — self-contained: `project.json`, `annotations/`, and the `images/<id>/` and `alignments/<id>.json` its Layers reference. Opens **only** into a Review Workspace. A reviewed Project cannot be promoted out.

Tar, not zip, because `fflate` counts entries in sixteen bits and emits no zip64 — measured, 70,000 entries indexed as 4,464 and read back with no error — and as a whole-Workspace backup, exceeding that is the normal case. Tar also streams both ways, which is what makes restoring on an iPad possible at all. `modern-tar` is the intended dependency; a WASM one is rejected on this repo's own `wasm-vips` history — which ticket 19 then ended by removing the dependency outright ([ADR-0027](../../docs/adr/0027-no-streaming-tiler-in-v1.md)), making the precedent stronger rather than weaker. **USTAR `prefix`/PAX handling is load-bearing**: `<project-dir-up-to-64>/annotations/<uuid>.geojson` is about 121 characters, past tar's 100-character name field.

**Review is an action, not a mode.** A hub button opens a bundle; a persistent banner says which Review Workspace is open and carries its two exits — back to your own, or discard. Several may exist, named after what was opened.

**The OPFS root holds several named Workspaces** rather than being one (amending ADR-0001). `OpfsProjectStore` already takes a directory-handle factory, so this changes what is passed in. Without it, Review Workspaces would sit inside the user's own Workspace — invisible to `listProjects`, but counted in its size and swept into its backup. **`navigator.storage.persist()` must be requested**; it is called nowhere today, so OPFS data is evictable.

### Reserved names, and the rooting change

`images`, `alignments`, and `base-map` become reserved Workspace directory names, **refused when a Project is created** — `toDirectoryName('Images')` produces `images`, and the existing check runs only at publish time, by which point the Project holds work.

`createStoreImageFetch` becomes Workspace-rooted. This is the highest-risk change in the epic: it is the ADR-0011 injection shim resolving the ADR-0004 placeholder host, which v1's SPEC calls the most fragile invariant in the project, and its failure mode is a pane of the wrong map rather than an error. `stampCanonicalUrl` writes `<url>/images/<image-id>`.

### Surface reductions

Deleted: the editor's unwarped view and **triiiceratops as an editor dependency** (it works for referenced maps only, because triiiceratops cannot accept a custom OpenSeadragon `TileSource`, so a locally ingested pyramid has no URL to give it — a distinction no user could infer); `/base-map/`; the Referenced and Offline-copies sections; the interrupted-copy repair path; `imageMode` and its helpers; the Layer tombstone. The **viewer keeps** its unwarped view — that is a reader feature, and story 101 is rescoped to it.

Moved behind one "check this alignment" affordance: the distortion overlay, its measure choice, and the bent grid. The **fold warning stays always-on**, being a correctness warning. The plain-language transformation picker **stays visible** — that guidance is the accessibility feature, not the thing to hide.

Moved out of first contact: the storage choice, into Workspace settings, with browser storage as the silent default — which is what ADR-0001's own "capability upgrade and never a gate" always implied.

One theme control, in the navigation bar. `ThemeSignal` is already ADR-0016's single source of truth for the interface and the Base Map flavour and already reads `prefers-color-scheme`; what is added is `localStorage` persistence and a move of `startTheme()` into the root layout. Three internal states — explicit light, explicit dark, and unset, which **follows the OS live** rather than reading it once — behind a two-state toggle.

### No migrations

**This application has never been deployed.** No Workspace exists outside development. There is no legacy layout to convert, no `formatVersion` bump for compatibility, and no dual-location fallback. Migration code must not be written defensively; a migration would in any case have to write on open, which ADR-0010 forbids.

## Testing Decisions

### What makes a good test here

Unchanged from v1, and it has an unusually literal reading in this project: **the user's folder is the product.** "After this sequence of actions the store contains these files with this content" is not a proxy for behaviour, it *is* the behaviour. Tests assert on file contents and rendered UI, never on internal call sequences, private state, or module structure. A test that survives a reorganisation of `core` and fails when a Project stops loading is a good test.

**And the mutation check is mandatory, not advisory.** v1's tracker records that every reviewed ticket yielded substantive defects anyway, including three of one ticket's criteria passing *vacuously* — delete the code under test and the tests stayed green. Every assertion rewired in this epic must be shown to go red when the behaviour it claims to cover is broken.

### No new seams

All three of v1's categories are reused, plus the existing `pnpm lint` fence pattern.

**Seam 1 — `ProjectStore` with an in-memory adapter (Node).** The bulk of this epic, because the epic is mostly a change to which files exist and where.

- Adding a Map Image writes `images/<id>/` and `alignments/<id>.json` at the Workspace root; the Project gains a Layer referencing the image id.
- A starter Alignment exists at add time, so no Layer ever holds a dangling reference.
- Deleting a Project or a Layer leaves the map; deleting an in-use map is refused and names the Projects.
- `images`, `alignments`, `base-map` refused as Project directory names, at creation.
- `createStoreImageFetch` resolves the placeholder host Workspace-rooted, and resolves nothing Project-rooted.
- Tar round-trip: Workspace → tar → Workspace is equivalent and byte-reproducible, and survives a 64-character Project name (the PAX path case).
- A Project bundle is self-contained; opening one yields a Review Workspace holding exactly that Project and nothing else.
- Tile-cache writes; publish size accounting, including maps no Project uses.
- An offline copy of an already-aligned map preserves every Control Point and rewrites the Alignment's `resource.id` to the placeholder.

**Seam 1b — the shared adapter suite in real browsers.** Already runs in Chromium *and* Firefox. Named Workspaces extend it: `OpfsProjectStore` rooted at a named subdirectory passes the same suite unchanged, which is the outcome that proved ADR-0001's abstraction honest when the File System Access adapter landed.

**Not a seam — pure functions, asserted numerically.** Three of the riskiest additions are pure, which is the best structural news in the plan:

- **The opening view** — the union of Annotation bounds and transformed Resource Mask rings; the visible → all → default fallback chain; the zoom cap; the zero-area single-pin case.
- **Tile enumeration** — which `{z}/{x}/{y}` a bounding box needs across a zoom range, and the count and byte estimate the budget shows.
- **`createImagePane` over a remote `info.json`** — level 2 builds, level-0-with-`tiles` builds, level-0-without-`tiles` throws. This is what makes the add-time refusal decidable without a browser.

**Seam 2 — the running app in a real browser (Playwright, Chromium).** Only what cannot be asked elsewhere. Deliberately no map abstraction: inventing one to enable testing would test a fake instead of the thing that ships.

- A remote map's tiles reaching the alignment pane, via the existing `window.ballastellaServedTiles` handle — bytes fetched and decoded, never an absence of console errors, because the failure this path had was an error `@allmaps/render` logged and swallowed.
- Cached Base Map tiles reaching MapLibre through the protocol handler.
- The Project screen: Layer cards, the unaligned badge, Align, progressive disclosure, keyboard reach, `<dialog>` and Popover mandated methods.
- Workspace switching, the Review banner and its two exits, `navigator.storage.persist()`.
- A published site opening on the Project's content rather than a deployment default.
- The offline first-run state: installed, no network, new Project — a named explanation, not a blank rectangle.

**Build fences (`pnpm lint`)**, following `check-base-map-catalog.mjs`, `check-viewer-deps.mjs`, `check-allmaps-patch.mjs`:

- The catalog fence extended to fail while the catalog points at Protomaps' demo bucket.
- **One new fence**: no module outside the store layer may resolve an image or Alignment path relative to a Project directory. Motivated by the rooting change touching the project's most fragile invariant, where the failure is a plausible wrong map rather than an error.

### Changes to test support

Two, neither a new seam:

1. **Lift the fake remote IIIF service into shared e2e support.** It exists twice already, with its own host tables and `json()` helpers in the remote-IIIF and mirroring suites; this epic adds a third consumer.
2. **Add a level-0-without-`tiles` host to that table.** Neither existing table has it, and it is the exact shape that must be refused at add time.

### Prior art

Within this repo now, unlike v1: the shared `ProjectStore` adapter suite; `project-zip.test.ts` for a byte-reproducible round trip; `pad-tile-to-cell.browser.test.ts` for a pixel claim that can only be made in a browser; the `browser-test-handle.ts` pattern for handing Playwright the live objects; `editor-mirroring.e2e.ts` and `editor-remote-iiif.e2e.ts` for fully routed fake services that reach no network.

### Explicitly not tested

Rendering correctness by pixel comparison, unchanged from v1. Whether a warped Map Image lands in the right place is established by the projection round-trip assertion and the fold check, not by screenshots.

## Out of Scope

Carried from ADR-0014 and still out: collaboration and multi-user editing; accounts; in-app git; server-side tiling; IIIF time-based media; aligning a IIIF `Choice`; cross-project search; authoring on mobile; multi-step undo history; authors curating the Base Map catalog; publishing a single Project standalone; the `twoOmega`, `airyKavr`, and `thetaa` distortion measures; IIIF Content State and arbitrary non-IIIF image URLs; Markdown footnotes and WYSIWYG authoring of an Annotation description.

New to this epic:

- **More than one Alignment per Map Image.** The accepted cost of ADR-0023, and its named v2 candidate.
- **An author-set opening view.** ADR-0026 records the argument for it and declines it for now.
- **Pulling an Alignment made elsewhere into a Project.** Meaningless now that there is one Alignment per map, but recorded because it was the v2 item under the rejected design.
- **Promoting a reviewed Project into your own Workspace.** No "keep this" — it is exactly what reintroduces the Alignment collision, and there is no honest resolution.
- **Merging one Workspace into another.** Same reason.
- **Content-addressing local images** so the Workspace pool deduplicates. Named and declined in ADR-0023: it is a separate decision and it changes every image id in existence.
- **The COOP/COEP service worker.** Measured and confirmed to work; deliberately not built. It is a site-wide restriction on how the page may load other origins' files — a real risk to referenced IIIF tiles and the Base Map archive — bought for a rare case that already fails legibly. **This is fenced explicitly because the epic touches the service worker for the tile cache, and the temptation will be adjacent.** *(Ticket 19 and [ADR-0027](../../docs/adr/0027-no-streaming-tiler-in-v1.md) removed the thing it would have unblocked: `wasm-vips` is gone and ingest is capped at the measured decode ceiling of 528 MP, not ~268 MP. The fence stands — a COOP/COEP worker is still a human's open decision — but nothing now depends on it.)*
- **zip64.** The zip is gone; do not implement it.
- **Writing a PMTiles archive.** Rejected in ADR-0025.
- **Pretty per-Project URLs.** ADR-0008 defers them as additive.
- **Grouped or multi-sheet Map Image Layers.** One map per Layer. A `kind: "group"` Layer remains possible later without invalidating anything here.

## Further Notes

**What this epic closes from v1's open questions.** Four, three of them by deletion rather than by answer: the Layer tombstone's dead end (the field is gone); `fflate`'s entry ceiling and the import heap (the zip is gone); ADR-0005's mandate of `terra-draw` (nothing uses it, and ticket 10 settled the last open case); and ADR-0013's unwritable `polynomial1` literal (corrected to the `{ type, options.order }` wire form).

**What it does not close.** The canonical instance URL; whether Playwright should run on Firefox and WebKit; upstreaming the `@allmaps/render` patch; the two licence texts that do not ship. *(Two items left this list with ticket 19: `wasm-vips` on a static host is closed by removing `wasm-vips` — v1 ticket 05's option 3, decided 2026-08-07 — and the LGPLv3 text is no longer owed, because nothing under it is redistributed. See [ADR-0027](../../docs/adr/0027-no-streaming-tiler-in-v1.md).)* ADR-0025's build-fence pattern is a useful precedent for the canonical-URL question, which is the same shape: deployment configuration with a guard.

**Two claims here rest on documentation rather than measurement**, and a ticket must not commit to them unverified: `modern-tar`'s streaming and PAX behaviour, and the tile counts and byte totals for a realistic Project extent. The tar claim carries more weight, because ADR-0024 justifies the whole format change on it.

**The riskiest single change is the rooting of `createStoreImageFetch`**, and it should land early, alone, and behind the new lint fence. Everything else in ADR-0023 is mechanical beside it.

**On the test suite.** 295 e2e specs are keyed to routes and test ids that move in this epic. They are to be **rewired, not deleted**, and the mutation check applies to every rewired assertion. A route that no longer exists is not a licence to drop the behaviour it covered.

**On the epic's name.** `workspace-and-layers` names the two structural moves — the Workspace gains the Map Images, and the Layer sidebar becomes the Project. Deliberately not a version number: this is still the initial version of the application, being reshaped before anyone has used it.
