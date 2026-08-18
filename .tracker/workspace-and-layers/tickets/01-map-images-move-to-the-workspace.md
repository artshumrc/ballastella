# Map Images and Alignments move to the Workspace

## What to build

A Map Image's pyramid and its Alignment stop living inside a Project and live at the Workspace root instead, shared by every Project. A Project directory keeps `project.json` and `annotations/` and nothing else.

Nothing about the user interface changes in this slice. When you are done, the app looks and behaves exactly as it does now — every existing test still passes, adapted — but the files are in different places and **the same Map Image can be referenced by two Projects at once**, which is the behaviour to demonstrate.

```
workspace/
├── images/<image-id>/         ← moved out of <project>/
├── alignments/<image-id>.json ← moved out of <project>/
└── <project-directory>/
    ├── project.json
    └── annotations/<layer-id>.geojson
```

Read [ADR-0023](../../../docs/adr/0023-map-images-and-alignments-live-in-the-workspace.md) first. It is the authority for this slice and explains why the Alignment moves too, which is the part that looks optional and is not.

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
  imageId: string;   // the Workspace Map Image this Layer draws
}
```

`imageIdFromAlignmentRef` and `mapLayerImageInfoPath` are deleted — the Alignment path and the image directory are both derivable from `imageId`.

**`imageMode` is not stored anywhere, because it is observable.** A Map Image in the Workspace either has an `info.json` of ours, meaning its tiles are here, or only a `remote.json`, meaning they are on a Library's server. Delete `ImageMode`, `imageModeOf`, and `localCopySource`. `partitionByLocalCopy` becomes a Workspace-wide question rather than a per-Project one.

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

- [ ] Adding a Map Image writes `images/<image-id>/info.json` at the Workspace root, and no bytes inside any Project directory.
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

## Implementation notes

Three things worth knowing before the next ticket, none of them a deviation from the contract.

**`MapImageSource`, `tileBaseFor`, `sourceOf`, and `isReferenced` were kept.** The contract names
`ImageMode`, `imageModeOf`, and `localCopySource` for deletion and those are gone, but the union itself
describes an *in-memory observation* of where tiles are, which ADR-0023 keeps rather than removes — and
`tileBaseFor` is what ticket 07 needs to point the alignment pane at a Library's server. The cost of
keeping it is that its local half has no constructor any more (`localCopySource` was it), so a caller
writes `{ imageMode: 'mirrored', imageId }` by hand. Ticket 07 should give it one back or drop the union;
either is a smaller decision than making it here. The union's discriminator is still spelled `imageMode`,
which the criterion's `grep` does not match — it is case-sensitive and looks for `ImageMode`.

**The published viewer now costs one 404 per referenced Map Image.** A static host has no directory
listing, so the viewer asks whether a map has an `info.json` of its own and reads the answer off the
status. `info.json` is asked first because a local copy is the common case and that request is one
`@allmaps/maplibre` makes anyway; only a referenced map pays. `editor-publish.e2e.ts` asserts that exact
404 by name rather than filtering it out, so a *second* unexpected failed request is still fatal. If this
becomes a problem, `ballastella-site.json` is the place to record the answer — a new field, and a
decision of its own.

**`assertReferencesPresent` no longer asks a foreign Layer about `alignmentRef`.** It still asks about
`geojsonRef`. A Layer carrying `alignmentRef` means nothing this build writes any more, so requiring the
archive to carry it would refuse an archive for a reason nobody could act on. A foreign Layer's `imageId`
is likewise not interpreted: this build cannot know that an unknown kind's `imageId` names a Map
Image, and guessing would refuse archives over a guess.

**The fence's exemptions are narrower than the contract above says, and it has a per-line opt-out.**
The contract names four *directories and files*; `check-workspace-rooted-paths.mjs` exempts five
**files**, because `packages/core/src/store/` and `packages/core/src/injection/` as prefixes exempted
those modules' tests too — including `injection/store-image-fetch.test.ts`, which is the test guarding
the one function the fence exists for. The fence also caught nothing written as a plain string literal
until review, which is precisely how a test fixture spells it; widening it to that spelling turned up
three stale Project-rooted fixtures and four deliberate decoys. The decoys keep their paths and carry
`// project-rooted-path-is-the-fixture: <reason>`, honoured for one line and listed in the check's own
output. A positive control runs before the scan, so a pattern that stops matching fails the check
rather than printing the same success line as a clean tree.

## Deferred from review

Three things the review of this ticket found and this ticket is deliberately not fixing. The first two
are pre-existing and belong with the ticket that changes the code around them; the third is a decision
a person has to make.

**A Map Image added with no community Alignment references an Alignment that does not exist.**
`addReferencedMap` writes `alignments/<image-id>.json` only when the user chose a community Alignment
(`apps/editor/src/lib/editor-session.svelte.ts`, in the `if (fields.alignment)` branch), while
`layerReferences` in `packages/core/src/transfer/import-project-zip.ts` requires
`alignmentPath(imageId)` for *every* map Layer. A Project holding such a map therefore exports a zip
that this same build refuses to import. Pre-existing — the shapes changed in this ticket, the gap did
not — and it closes in **ticket 02**, whose contract already writes a starter Alignment when a map is
added, for exactly this reason. Noted there.

**"Is this Map Image referenced rather than copied?" now has five implementations.**
`referencedImageIds` in `packages/core/src/publish/publish.ts`, `partitionByLocalCopy` in
`packages/core/src/remote-iiif/referenced-image.ts`, `readMapLayer`'s 404 probe in
`apps/viewer/src/lib/project-documents.ts`, and the derived sets in
`apps/editor/src/routes/layers/+page.svelte` and `apps/viewer/src/routes/+page.svelte`. All five ask
the same question of the same directory and can disagree. One `referencedMapImages(store)` in
core would serve all of them. Left alone here because this ticket was already rewriting four of the
five and a sixth rewrite is not what makes it correct; **ticket 08** is where it belongs, since it
adds a core function that reads exactly this and must not become the sixth. Noted there.

**ADR-0010 needs amending, or `exportProjectZip` needs restructuring — a human decision.**
`packages/core/src/transfer/export-project-zip.ts` used to document that `project.json` "is required to
exist here but is deliberately never parsed (ADR-0010)". It is now parsed, through `parseLayers`, which
is how the shared material a Layer references is found. The rewritten comment argues the case — `parseLayers`
never throws and has no `formatVersion` opinion, so a Project from the future still exports, which is the
property the original rule was protecting — but **the ADR itself was not amended, and this ticket did not
amend it.** Either ADR-0010 records that export may parse the Layer stack and why that does not weaken the
forward-only rule, or the export is restructured so no parse is needed (gathering the shared material from
the Workspace by some other route). Not a code fix; it needs whoever owns the ADR.
