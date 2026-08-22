# 15 - Update deletions atomically

## What to build

Extend Update from GitHub to confirmed Remote deletions and make the whole inbound change set observationally atomic on browser-storage and chosen-folder Workspaces. Before destructive work, preview the named Projects and Map Images that will disappear. On confirmation, use a recoverable transaction with before-images and durable phase evidence so startup exposes either the complete old Workspace/Baseline or the complete new Workspace/Baseline, never a mixture.

## Where to start

- Build on ticket 14's non-destructive Update engine and transaction seam; deletions must join the same operation rather than run as a second pass.
- `packages/core/src/store/project-store.ts` guarantees atomicity for one write only. Multi-path Update requires an operation-level transaction above that interface.
- `packages/core/src/store/temp-file-write-store.ts`, `packages/core/src/store/directory-handle-store.ts`, and the adapter-specific stores show temporary path and move constraints.
- `packages/core/src/autosave/deleted-projects.ts`, `packages/core/src/autosave/replay.ts`, and `packages/core/src/project/workspace.ts` show durable marker/startup recovery and reporting patterns, but their deletion semantics are not a general Update transaction.
- `packages/core/src/transfer/restore-workspace-tar.ts` shows whole-destination rollback where a new Workspace permits it; Update cannot discard the destination and therefore needs before-images.
- `packages/core/src/store/project-store-suite.ts`, `packages/core/src/store/opfs-project-store.browser.test.ts`, and `packages/core/src/store/file-system-access-project-store.browser.test.ts` are the backing/fault-injection seams.
- `apps/editor/src/lib/components/ModalDialog.svelte` supplies the mandated `<dialog>` behavior and focus restoration for deletion preview/confirmation.

## Contract

- Treat absent Remote source paths as confirmed deletions only when the valid Baseline says the path was shared and local bytes remain unchanged. Local changes at a deleted Remote path are Conflict, not deletion.
- Before any write, display a destructive preview naming affected Project display names/directories and Map Image identities plus a count/list for remaining paths. The confirmation must say that Update will remove them.
- Canceling or closing the preview performs no Workspace write/delete, Remote write, Baseline write, or local-index clearing and returns focus predictably to Update.
- Preflight storage includes inbound bytes, bounded transaction metadata, and recoverable before-images for every replaced/deleted path. Refuse before mutation when available storage is insufficient.
- The durable marker records stable Workspace identity, the complete operation path set, before-images/checks, intended after-state evidence, and an unambiguous phase. It is installation/local transaction machinery, not synchronized source or Publish output.
- While a transaction is incomplete, the Workspace must not be enumerated/opened/backed up/published as a mixed state. Startup recovery runs before Project/Map Image listing and either rolls back to the old complete state or completes the new one according to the durable phase.
- Deletions, replacements, and additions are one transaction. Baseline advancement and selective change-index clearing become visible only with the complete new Workspace. Failure before commit retains the old Baseline; failure after the durable commit point finishes forward.
- Recovery is idempotent across repeated interruption. Cleanup removes before-images/markers only after the chosen state and matching metadata are durable.
- Route Alignment replacement/deletion through its owning model where required; do not bypass existing Alignment writer invariants with dynamic paths.
- Keep the Remote untouched throughout Update. Do not treat generated output as deletion candidates.
- Expose operation fault injection at each durable boundary and compare full Workspace/Baseline snapshots rather than private staging layout or call order.

## User Stories

- 125. As an author, I want Update to apply Remote deletions when the corresponding local content is unchanged, so that synchronized deletions do not reappear.
- 126. As an author, I want destructive inbound changes previewed and confirmed, so that I know which Projects and Map Images will be removed.
- 127. As an author, I want canceling a deletion preview to leave Workspace, Remote, and Baseline unchanged, so that inspection is harmless.
- 141. As an author, I want Update committed atomically, so that either the complete valid inbound change set is visible or the old Workspace remains.

## Out of scope

- Do not add a generic transaction API to `ProjectStore` unless the Update operation demonstrably needs it; keep operation policy above adapters.
- Do not implement Import's one-copy transaction, semantic content merging, per-file choices, trash/history, or Remote-wins replacement.
- Do not delete repository files outside Ballastella source ownership or Publish-owned generated output.
- Do not change outbound Publish conflict behavior.

## Acceptance criteria

- [ ] Core tests prove unchanged locally shared paths deleted on the Remote are removed, while locally changed paths at the same Remote deletion become Conflict and remain byte-identical.
- [ ] The preview names affected Projects and Map Images, and cancel leaves byte-for-byte Workspace, Remote head/tree, Baseline, and local-change index snapshots unchanged.
- [ ] Confirmed Update applies additions, replacements, and deletions as one valid result and advances only matching shared Baseline evidence.
- [ ] Fault injection at every marker, before-image, addition, replacement, deletion, metadata-commit, and cleanup boundary yields after restart exactly the complete before snapshot or complete after snapshot, never a mixed graph.
- [ ] Insufficient temporary storage is refused before mutation with required/available quantities, and successful/recovered completion removes transaction artifacts.
- [ ] Browser-storage and chosen-folder adapter conformance produce the same visible committed files, rollback/forward recovery choice, Project/Map Image lists, and Baseline.
- [ ] The Workspace is unavailable to listing, Backup, Publish, and normal open while unresolved transaction evidence exists.

Run these commands from the repository root:

```bash
pnpm --filter @ballastella/core test -- src/remote/update-transaction.test.ts src/remote/update-from-github.test.ts src/store/opfs-project-store.browser.test.ts src/store/file-system-access-project-store.browser.test.ts
pnpm -r build
pnpm test:e2e editor-remote-conflict editor-folder-workspace
pnpm precommit lint check test
```

Success is all commands exiting zero; fault-injection snapshots are exclusively complete-before or complete-after, cancel is a no-op on all three states, and both backing workflows recover without exposing a partial Project or Map Image list.

## Blocked by

- 14-update-non-destructive-remote-changes.md
