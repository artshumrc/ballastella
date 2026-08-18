# Hand off a Project, and review one

## What to build

A student can send one Project to a teacher as a single self-contained file. The teacher opens it into a throwaway Review Workspace, explores it as though it were their own, and discards it — without it ever touching their real research.

Demonstrable end to end: export a Project as a bundle; on the hub, open that bundle; land in a Review Workspace holding exactly that one Project, with a banner saying so; pan the map, toggle Layers, read Annotations; go back to your own Workspace and find it untouched; discard the review copy.

Read [ADR-0024](../../../docs/adr/0024-backup-and-handoff-are-different-artefacts.md)'s "Why handoff cannot merge" before starting. That section is the whole design.

## Where to start

- The tar machinery from ticket 13 — reused for both directions.
- `packages/core/src/transfer/export-project-zip.ts` — the Project-scoped export it replaces, including how it walks one Project's files.
- `packages/core/src/transfer/import-project-zip.ts` — `assertReferencesPresent`, which validates that every Layer's references are present in the archive. A bundle must satisfy it.
- The named-Workspace machinery from ticket 12 — a Review Workspace is one, marked.
- `apps/editor/src/lib/components/ProjectHub.svelte` — where the "open a Project someone sent you" action goes, beside import as it exists today.
- `apps/editor/src/routes/+layout.svelte` and the navigation bar from ticket 04 — where the banner lives.
- `packages/core/src/project/workspace.ts` — `uniqueDirectoryName` and `foldName`, for naming a Review Workspace after what was opened without colliding.

## Contract

**A bundle is one self-contained Project**: `project.json`, `annotations/`, and the `images/<id>/` and `alignments/<id>.json` its Layers reference. Its internal paths are Project-relative, exactly as the zip's already were, so `assertReferencesPresent` works unchanged.

**A bundle opens only into a Review Workspace. There is no path that merges it into the recipient's own.** Under ADR-0023 there is one Alignment per Map Image in a Workspace, so importing a colleague's bundle into your own would either overwrite an Alignment two of your own Projects depend on, or be refused. The propagation risk ADR-0023 accepts is one a user takes on for *their own* edits — not one that arrives inside someone else's file.

**A reviewed Project cannot be promoted out.** No "keep this", no "copy to my Workspace", no "save a copy". If a scholar wants a colleague's map in their own research they add the map themselves. This is the fence that makes the rest coherent; do not add a convenience that breaks it.

**Review is an action, not a mode you toggle.** A button on the hub takes a bundle, builds the Review Workspace, and switches to it. A **setting** would be something a user could forget they were inside, and the failure that creates is an afternoon's real work done in a Workspace built to be thrown away.

**A persistent banner is shown for as long as a Review Workspace is open**, naming what was opened and carrying exactly two exits: back to your own Workspace, and discard this one. It must be present on every screen — the Project screen and the alignment route included — because those are where a user forgets where they are.

**Several Review Workspaces may exist at once**, named after what was opened, so a teacher marking thirty submissions can move between them. Two students' conflicting Alignments of the same sheet never meet, because each lives in its own Workspace.

**Discarding deletes the Review Workspace and everything in it**, and confirms first through `<dialog>` + `showModal()`.

**A Review Workspace is editable**, and that is deliberate — a teacher demonstrating a fix is a real use. Nothing is ever written back to the bundle file.

**Quota is checked before opening a bundle**, as ticket 13 checks it before restoring.

**A bundle with a newer `formatVersion` is refused** with the message naming where to get that version, and nothing is created.

**A Review Workspace is never published**, never backed up as part of your own Workspace, and never counted in your own Workspace's size. Ticket 12's named Workspaces are what make this true structurally rather than by filtering.

**The zip transfer path is now fully removed** — both flavours. `fflate` comes out of the manifests unless something else needs it.

## Out of scope

- **Do not add promotion, adoption, copying, or merging** of a reviewed Project, under any name.
- **Do not make Review Workspaces read-only.**
- **Do not build a submission or grading workflow** — no marks, no comments-back, no return path. One file in, look, discard.
- **Do not let a bundle be opened into the user's own Workspace**, even behind a confirmation.
- **Do not implement zip64**, and do not keep the zip path alive "just in case".
- **Do not add a bulk import** of many bundles at once.

## Acceptance criteria

- [ ] Exporting a Project produces a tar containing `project.json`, `annotations/`, and only the `images/<id>/` and `alignments/<id>.json` its Layers reference — not the Workspace's other maps.
- [ ] Opening that bundle creates a Review Workspace holding exactly that one Project.
- [ ] The user's own Workspace is byte-identical before and after opening and discarding a bundle.
- [ ] A bundle whose Map Image has the same image id as one in the user's own Workspace does not touch the user's copy or its Alignment.
- [ ] The banner is visible on the hub, the Project screen, and the alignment route while a Review Workspace is open, and names what was opened.
- [ ] The banner's two exits both work, and are keyboard-reachable.
- [ ] Two bundles can be open as two Review Workspaces, each with its own Alignment for the same image id, and switching between them shows each Project's own alignment.
- [ ] Discarding confirms via `showModal()`, then removes the Review Workspace and all its files.
- [ ] No affordance anywhere copies, promotes, or merges a reviewed Project into the user's own Workspace.
- [ ] A Review Workspace does not appear in the user's own Project list, is absent from a backup of the user's Workspace, and is not counted in its size.
- [ ] Publishing while a Review Workspace exists publishes only the user's own Workspace.
- [ ] A bundle with a newer `formatVersion` is refused, naming where to get that version, and creates nothing.
- [ ] Opening a bundle with insufficient quota is refused beforehand, and creates nothing.
- [ ] `fflate` and the zip transfer path appear nowhere in `packages/` or `apps/`.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
pnpm --filter @ballastella/core test
pnpm exec playwright test e2e/editor-transfer.e2e.ts e2e/editor-workspace.e2e.ts e2e/editor-publish.e2e.ts
pnpm test:e2e
grep -rn "fflate\|exportProjectZip\|importProjectZip" packages/*/src apps/*/src packages/*/package.json apps/*/package.json
```

The final grep must find nothing.

The "byte-identical before and after" criterion is the most important in this ticket and the easiest to fake: list every path and hash every byte in the user's Workspace before opening the bundle and again after discarding, and compare both. Asserting that the Project list is unchanged would pass while an Alignment had been overwritten.

For the two-bundles criterion, use the same image id in both bundles with **different Control Points**, and assert each Review Workspace shows its own — that is the collision this whole design exists to prevent, so it must be the thing that is tested.

## Blocked by

- Ticket 13
