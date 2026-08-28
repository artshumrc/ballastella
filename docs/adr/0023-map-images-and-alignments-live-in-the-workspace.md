# Map Images and their Alignments live in the Workspace

> **Amends [ADR-0006](./0006-the-project-directory-is-the-published-site.md) and [ADR-0008](./0008-projects-live-in-a-workspace.md).** A Project directory no longer holds a Map Image's bytes or its Alignment. Everything else in both ADRs holds: publishing is still additive, the Workspace is still the Published Site, and a Project is still addressed by `?p=`.
>
> **Amended by [ADR-0037](./0037-import-copies-a-project-into-the-current-workspace.md):** deterministic identity still governs adding a referenced Map Image normally, but Import deliberately assigns every incoming Map Image a fresh identity so its Alignment cannot alter existing Projects.

A Map Image's pyramid **and its Alignment** live in the Workspace, shared by every Project in it. A Project holds `project.json` and its Annotations, and its map Layers reference a Workspace Map Image by image id.

```
workspace/
├── index.html                     # hub + viewer entry (ADR-0008)
├── images/<image-id>/
│   ├── info.json                  # level 0; placeholder id (ADR-0004)
│   ├── manifest.json
│   ├── remote.json                # present when the map is referenced from a Library (ADR-0007)
│   └── <region>/<size>/0/default.jpg
├── alignments/<image-id>.json     # IIIF Georeference Annotation — one per Map Image
├── base-map/tiles/<archive>/{z}/{x}/{y}.mvt  # opt-in offline Base Map cache (ADR-0025)
├── amsterdam-1625/
│   ├── project.json
│   └── annotations/<layer-id>.geojson
└── boston-1775/
    └── ...
```

## The line this draws

**The Workspace owns where a Map Image sits on the earth. A Project owns how maps are presented and what is stacked over them** — the Layer's name, visibility, order, opacity, and the Annotations drawn above.

That is one answer per question, and it is the whole reason for the shape. The rejected alternative kept the pyramid in the Workspace and copied the Alignment into each Project, so that "where is this map on the earth" had *N* answers that immediately drifted: a referenced map's Alignment records the Library's service as `resource.id` (ADR-0007), so making one offline copy left every other Project's Alignment naming a Library whose tiles were already sitting in the Workspace — silently network-dependent, and greeted on next open by a repair prompt written for a half-crashed download. There is no version of that problem under one Alignment per map.

## The accepted risk, and the accepted cost

**Refining an Alignment moves every Project that uses that map, including published ones.** This is understood and accepted rather than overlooked. The mitigation is visibility, not prevention: the alignment view names the Projects that use this map, so a user is never editing an unknown number of arguments at once.

**A Map Image can be aligned only one way.** A scholar wanting to show that a thin-plate-spline reading and a first-order-polynomial reading of the same sheet support different arguments (ADR-0013 offers both) cannot, and because `generateId(uri)` is deterministic, re-adding the same remote resource lands on the same image rather than duplicating it. Local files would duplicate, since their ids are random, but that is an accident and not an affordance.

**To revisit in v2, deliberately deferred rather than settled:** more than one Alignment per Map Image.

## Consequences

- **`MapLayer` loses `alignmentRef` and `imageMode`, and gains an image id.** The Alignment is derivable from the id, so `imageIdFromAlignmentRef` and `mapLayerImageInfoPath` go with them.
- **`imageMode` is not stored anywhere, because it is observable.** A Map Image in the Workspace either has an `info.json` of ours — its tiles are here — or only a `remote.json` — its tiles are on a Library's server. So `imageModeOf`, `localCopySource`, `#reconcileLocalCopies`, and `unfinishedCopies` are deleted, along with the "Finish the offline copy" repair button: with one Alignment per map there is nothing left that can get out of step.
- **`ProjectFile.removedMapLayers` is deleted, and with it `#ensureMapLayer` and `#placingMapLayers`.** The tombstone existed only because an Alignment write created Layers lazily, so deleting a Layer and then nudging a Control Point silently recreated it. A Layer is now created only by an explicit "add this map to this Project" gesture, so an Alignment write never creates one and there is nothing to tombstone. The field is removed rather than repaired.
- **A starter Alignment is written when a Map Image is added to the Workspace.** `newAlignment(imageId, image)` yields zero Control Points and a full-image Resource Mask. Without it, an unaligned map has a dangling reference and `assertReferencesPresent` makes the Project un-exportable and un-publishable. This does not offend ADR-0010, which forbids writing when *merely opening* a Project; adding a map is an explicit act.
- **"Not aligned yet" is derived, never stored:** `controlPoints.length < MINIMUM_CONTROL_POINTS`, which is what `canSolve` already computes. A partially aligned map therefore warns correctly, where a boolean flag would not. The cost is that the Layer sidebar reads the Alignment of **every** map Layer, not only the visible ones.
- **`createStoreImageFetch` becomes Workspace-rooted rather than Project-rooted.** It is the ADR-0011 injection shim resolving the ADR-0004 placeholder host, and it takes a `projectDirectory` today. This is the one resolution change the move requires, and it touches the most fragile invariant in the project.
- **`stampCanonicalUrl` writes `<url>/images/<image-id>`**, no longer `<url>/<project>/images/<image-id>`.
- **`images`, `alignments`, and `base-map` are reserved Workspace directory names and must be refused when a Project is created.** `toDirectoryName('Images')` produces `images`. The existing reserved-name check, `claimedByPublishing`, runs only at *publish* time — far too late, because by then the Project exists and holds work.
- **Deleting a Project or a Layer never deletes a Map Image.** So the Workspace can hold maps no Project uses, still on disk, still served by a Published Site, still counted against ADR-0008's ~1 GB budget. The hub therefore lists the Workspace's Map Images with each one's size and which Projects use it; deleting one that is in use is **refused, naming those Projects**, never cascaded behind a confirmation. The same list is what the "choose a Map Image you already have" picker renders.
- **Local image ids are `generateRandomId()`, not content hashes, so the pool does not deduplicate by itself.** The same file added twice is two Map Images. Content-addressing local images is a separate decision and is not made here.
- **There is no migration and no `formatVersion` bump for any of this.** The application has never been deployed and no Workspace exists outside development, so there is no legacy layout to convert. A migration would in any case have to write on open, which ADR-0010 forbids.
