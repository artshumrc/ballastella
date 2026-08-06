# Historical Maps and Alignments move to the Workspace

## What to build

A Historical Map's pyramid and its Alignment stop living inside a Project and live at the Workspace root instead, shared by every Project. A Project directory keeps `project.json` and `annotations/` and nothing else.

Nothing about the user interface changes in this slice. When you are done, the app looks and behaves exactly as it does now — every existing test still passes, adapted — but the files are in different places and **the same Historical Map can be referenced by two Projects at once**, which is the behaviour to demonstrate.

```
workspace/
├── images/<image-id>/         ← moved out of <project>/
├── alignments/<image-id>.json ← moved out of <project>/
└── <project-directory>/
    ├── project.json
    └── annotations/<layer-id>.geojson
```

Read [ADR-0023](../../../docs/adr/0023-historical-maps-and-alignments-live-in-the-workspace.md) first. It is the authority for this slice and explains why the Alignment moves too, which is the part that looks optional and is not.

## Where to start

- `packages/core/src/project/image-files.ts` — `IMAGE_DIRECTORY`, `imageDirectory`, `imageInfoPath`. These are Project-relative today.
- `packages/core/src/alignment/alignment.ts` — `ALIGNMENT_DIRECTORY`, `alignmentPath`, `alignmentStorePath(projectDirectory, imageId)`.
- `packages/core/src/project/layer.ts` — `MapLayer`, `ImageMode`, `newMapLayer`, `imageIdFromAlignmentRef`, `mapLayerImageInfoPath`.
- `packages/core/src/injection/store-image-fetch.ts` — `createStoreImageFetch`. **This is the highest-risk file in the slice.** It is the ADR-0011 injection shim that resolves the ADR-0004 `unset.invalid` placeholder host, and it takes a `projectDirectory`.
- `packages/core/src/remote-iiif/referenced-image.ts` — `referencedImageStorePath`, `partitionByLocalCopy`, `localCopySource`, `imageModeOf`.
- `packages/core/src/project/workspace.ts` — `toDirectoryName`, `foldName`, and the collision check that must gain reserved names.
- `packages/core/src/transfer/import-project-zip.ts` — `assertReferencesPresent`.
- `packages/core/src/publish/publish.ts` — its reference validation, and `stampCanonicalUrl` in `apps/editor/src/lib/editor-session.svelte.ts`.
- `apps/editor/src/lib/editor-session.svelte.ts` — `images`, `referencedImages`, `remoteOrigins`, `#reconcileLocalCopies`, `unfinishedCopies`, `imageServiceFetch()`.
- `scripts/check-base-map-catalog.mjs` is the model for the new fence script — read it for house style.

## Contract

**`MapLayer` carries an image id.** `alignmentRef` and `imageMode` are gone.

```ts
interface MapLayer extends LayerCommon {
  kind: 'map';
  opacity: number;
  imageId: string;   // the Workspace Historical Map this Layer draws
}
```

`imageIdFromAlignmentRef` and `mapLayerImageInfoPath` are deleted — the Alignment path and the image directory are both derivable from `imageId`.

**`imageMode` is not stored anywhere, because it is observable.** A Historical Map in the Workspace either has an `info.json` of ours, meaning its tiles are here, or only a `remote.json`, meaning they are on a Library's server. Delete `ImageMode`, `imageModeOf`, and `localCopySource`. `partitionByLocalCopy` becomes a Workspace-wide question rather than a per-Project one.

**Delete the repair path for a half-committed copy.** `#reconcileLocalCopies`, `unfinishedCopies`, `finishInterruptedCopy`, and the "Finish the offline copy" button all exist because a Layer's `imageMode` claim could disagree with the bytes on disk. With one derived answer per map there is nothing left to disagree. Removing them is required, not optional — leaving them means dead code that lies.

**`createStoreImageFetch` is Workspace-rooted.** It no longer takes a `projectDirectory`. The placeholder host resolves to `images/<image-id>/…` at the Workspace root.

**`stampCanonicalUrl` writes `<url>/images/<image-id>`**, no longer `<url>/<project>/images/<image-id>`.

**`images`, `alignments`, and `base-map` are reserved Workspace directory names and are refused when a Project is created.** `toDirectoryName('Images')` produces `images`. The refusal must happen at creation and must go through the same case-folding and NFC normalisation as the existing collision check — `foldName` exists for exactly this reason, and a reserved-name check that compares raw strings is wrong on APFS and NTFS for the same reason the collision check was.

**The zip format does not change.** `exportProjectZip` already writes Project-relative paths, so export gathers a Layer's images and Alignment out of the Workspace and writes them at the same `images/<id>/` and `alignments/<id>.json` paths in the archive. Import hoists them back out into the Workspace, **deduplicating by image id: an image id already present in the Workspace is not overwritten.** `assertReferencesPresent` keeps working against the archive's own prefixes.

**`project.json` gets no `formatVersion` bump and no migration.** See Out of scope.

**A new lint fence, `scripts/check-workspace-rooted-paths.mjs`, added to `pnpm lint`.** It fails if any module outside `packages/core/src/store/`, `packages/core/src/injection/`, `packages/core/src/project/image-files.ts`, and `packages/core/src/alignment/alignment.ts` builds an image or Alignment path from a Project directory. It exists because the failure mode of getting this wrong is a pane showing *somebody else's map* rather than an error.

## Out of scope

- **Do not write migration code, a `formatVersion` bump, or a dual-location fallback that looks in the old place.** This application has never been deployed; no Workspace exists outside development. A migration would have to write on open, which ADR-0010 forbids. If your development Workspace has data in the old layout, delete it.
- **Do not change when a Layer is created.** `#ensureMapLayer` still creates a map Layer lazily on the first Alignment write, and `ProjectFile.removedMapLayers` still tombstones a deleted one. Both are deleted in ticket 02. Rekey them onto `imageId` and leave them alone.
- **Do not content-address local images** so the pool deduplicates. ADR-0023 names and declines it; it would change every image id in existence.
- **Do not touch the user interface** beyond what is required to keep it compiling and its tests passing. No new lists, no badges, no new buttons.
- **Do not convert transfer to tar.** That is ticket 13.
- **Do not delete `/base-map/` or `ProjectView`.** Tickets 03 and 04.

## Acceptance criteria

- [ ] Adding a Historical Map writes `images/<image-id>/info.json` at the Workspace root, and no bytes inside any Project directory.
- [ ] A first Control Point writes `alignments/<image-id>.json` at the Workspace root.
- [ ] Two Projects can each hold a map Layer for the same `imageId`, and both render, with one pyramid on disk.
- [ ] Deleting a Project leaves `images/<image-id>/` and `alignments/<image-id>.json` in place.
- [ ] Creating a Project named `Images`, `Alignments`, `Base Map`, or `images` is refused with a message naming the reservation, and the refusal survives case and Unicode-composition variants.
- [ ] `createStoreImageFetch` takes no `projectDirectory`, and `grep` finds no caller passing one.
- [ ] Exporting a Project produces a zip containing `project.json`, `annotations/`, `images/<id>/`, and `alignments/<id>.json`; importing it into a fresh Workspace reproduces an equivalent Project; importing it into a Workspace that already has that image id leaves the existing image untouched.
- [ ] `ImageMode`, `imageModeOf`, `localCopySource`, `imageIdFromAlignmentRef`, `mapLayerImageInfoPath`, `#reconcileLocalCopies`, `unfinishedCopies`, and `finishInterruptedCopy` do not appear anywhere in `packages/` or `apps/`.
- [ ] The new fence fails when a test fixture module builds a Project-relative image path, and passes on the tree as shipped.
- [ ] For every assertion you rewire: break the behaviour it covers, confirm the test goes red, restore it.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check && pnpm test:e2e
```

All five green. Then, for the deletions:

```sh
grep -rn "ImageMode\|imageModeOf\|localCopySource\|imageIdFromAlignmentRef\|mapLayerImageInfoPath\|unfinishedCopies\|finishInterruptedCopy\|removedMapLayers" packages/*/src apps/*/src
```

Expect **only** `removedMapLayers` (ticket 02 removes it) and no other match.

```sh
node scripts/check-workspace-rooted-paths.mjs
```

Exits 0 with a success message. To prove it is not vacuous, add a module that builds `` `${projectDirectory}/images/x/info.json` ``, re-run, confirm it exits non-zero and names that file, then delete the module.

## Blocked by

None — can start immediately.
