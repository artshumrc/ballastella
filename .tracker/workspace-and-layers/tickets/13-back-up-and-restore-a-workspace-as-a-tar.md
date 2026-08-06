# Back up and restore a Workspace as a tar

## What to build

A scholar can write their whole Workspace to one tar file and read it back — on this computer or another one. This is the backup and the move-between-machines story, and for anyone on Firefox, Safari, or an iPad it is the only way their work leaves the browser.

Demonstrable end to end: back up a Workspace containing two Projects and a shared Historical Map; restore it in a fresh browser profile; find both Projects, one pyramid, and the Alignment intact.

Read [ADR-0024](../../../docs/adr/0024-backup-and-handoff-are-different-artefacts.md) first, especially why this is not a zip.

## Where to start

- `packages/core/src/transfer/export-project-zip.ts` and `import-project-zip.ts` — the shape to follow and the ceiling to escape. Read `MAX_ZIP_ENTRIES`' doc comment: `fflate` counts entries in sixteen bits, 70,000 entries produced an archive indexing 4,464, and `unzipSync` read it back as 4,464 files **with no error at all**. Note also `ALREADY_COMPRESSED`, which already skips deflating tiles — so compression was buying nothing.
- `ZIP_ENTRY_MTIME` and the reasoning for a constant timestamp — byte-reproducibility is what lets a test assert a round trip is lossless rather than merely plausible. Carry that property over.
- `packages/core/src/transfer/viewer-files.ts` — `isViewerFile`, `VIEWER_FILE_PATHS`, `PUBLISHED_SITE_RECORD_NAME`. The enumerable viewer file set is what a backup excludes.
- `packages/core/src/transfer/import-project-zip.ts` — `orderForWriting`, and why `project.json` is written **last**: an interrupted restore must leave orphaned files rather than a Project that lists on the hub with half its Layers missing. The first is litter; the second reads as the tool having eaten someone's work.
- `packages/core/src/project/project-file.ts` — `parseProjectFile` and `ProjectFormatTooNewError`, plus `reendFormatRefusal` in the zip importer, which re-ends the refusal message for the import path.
- The named-Workspace machinery from ticket 12 — restore creates one.
- `packages/core/src/project/workspace-size.ts` — for the pre-restore quota check.

## Contract

**`modern-tar` is the dependency.** Zero-dependency, Web Streams, USTAR with PAX extensions. **Verify its streaming and PAX behaviour before committing to it** — ADR-0024 justifies the whole format change on those two properties and they are taken from its documentation, not from measurement. If either does not hold, stop and escalate rather than working around it.

**Do not add a WASM tar implementation.** Tar is a 512-byte header layout, not a computation. Ticket 05 of v1 is still stalled because npm ships only a threaded `wasm-vips` build needing COOP/COEP headers a static host cannot send; a second WASM dependency on a path that must work on a static host would repeat that.

**Long paths are load-bearing and must be asserted, not assumed.** `<project-dir-up-to-64>/annotations/<uuid>.geojson` is about 121 characters, past tar's 100-character `name` field. A naive writer truncates or throws. Test with a **deliberately long Project name**, at the 64-character limit `toDirectoryName` allows.

**A backup is byte-reproducible.** Same Workspace, same bytes, twice — and after a round trip through restore. Use a constant entry timestamp for the same reasons the zip did: it makes losslessness assertable, and it refuses to imply that an archive carries useful times, since a Project's `updatedAt` lives inside `project.json` precisely because archiving destroys filesystem times.

**A backup excludes the published viewer files.** `index.html`, `_app/`, and `ballastella-site.json` are build output that `isViewerFile` already enumerates. Including them bloats every backup and restores a viewer bundle possibly older than the app, which ADR-0006 warns goes stale against its data. **The restore must say that a re-publish is needed** rather than letting the user hand out a stale site.

**Restore creates a new named Workspace and switches to it. It never overwrites and never merges.** Both real uses need this: a new computer has nothing to overwrite, and recovering from damage is the exact moment the damaged Workspace must survive, because the user cannot know what the backup predates until they have looked at both. Merging is the Alignment-collision problem in another hat.

**`project.json` files are written last**, per the existing importer's discipline, so an interrupted restore leaves litter rather than half-Projects.

**Quota is checked before restoring, not discovered at eighty per cent.** `navigator.storage.estimate()`; refuse legibly with the numbers.

**A newer `formatVersion` inside a backup is refused with the message naming where to get that version**, and nothing is restored — the same class and the same discipline the zip importer already applies.

**Restore streams.** The archive must not be held whole in the JS heap; that is half of what tar was chosen for, and it is what makes restoring a large backup on an iPad possible at all.

**The zip path for whole-Workspace transfer is removed.** Project-level zip export stays until ticket 14 replaces it with the bundle.

## Out of scope

- **Do not implement zip64.** The zip is going; do not fix it on the way out.
- **Do not build the Project bundle or Review Workspaces.** Ticket 14.
- **Do not offer merging, or an "overwrite my Workspace" option**, however much simpler it looks.
- **Do not include the viewer files** to make a restored Workspace immediately publishable.
- **Do not compress the tiles.** They are already-compressed JPEG; the existing exporter knows it.
- **Do not change the pyramid layout, `project.json`, or any document format.** This slice moves bytes.
- **Do not add cloud, drive, or sync integrations.**

## Acceptance criteria

- [ ] A Workspace with two Projects sharing one Historical Map backs up to a single tar.
- [ ] Restoring that tar into a fresh Workspace reproduces both Projects, one pyramid, one Alignment, and every Annotation.
- [ ] The tar contains no `index.html`, no `_app/`, and no `ballastella-site.json`.
- [ ] Restoring reports that publishing is needed before the Workspace is a site again.
- [ ] Restoring creates a **new** named Workspace and switches to it; the Workspace that was open is unchanged.
- [ ] A Workspace with more than 65,535 files backs up and restores intact — the case the zip refused.
- [ ] A Project directory at the 64-character limit round-trips, with its `annotations/<uuid>.geojson` files intact.
- [ ] Backing up the same Workspace twice produces byte-identical archives; so does backing up a restored Workspace.
- [ ] Restoring with insufficient quota is refused beforehand with the numbers, and writes nothing.
- [ ] A backup containing a newer `formatVersion` is refused, naming where to get that version, and nothing is restored.
- [ ] Restore does not hold the whole archive in memory — assert peak usage or streamed consumption, not merely that it completed.
- [ ] An interrupted restore leaves no Project listed on the hub.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
pnpm --filter @ballastella/core test
pnpm exec playwright test e2e/editor-transfer.e2e.ts e2e/editor-workspace.e2e.ts
pnpm test:e2e
```

All green. `packages/core/src/transfer/project-zip.test.ts` is the prior art for a byte-reproducible round trip; the new suite should read like it.

The >65,535-file criterion is the reason this ticket exists — generate the entries rather than committing a fixture, and assert the **restored file count** equals the original, which is exactly the assertion that caught fflate silently dropping 94% of a pyramid.

The long-path criterion will pass by accident if your Project name is short. Use the full 64 characters.

## Blocked by

- Ticket 01
- Ticket 12
