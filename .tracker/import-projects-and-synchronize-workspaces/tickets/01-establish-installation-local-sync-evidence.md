# 01 - Establish installation-local synchronization evidence

## What to build

Establish durable, installation-local synchronization metadata for an ordinary Workspace: its single Remote relationship, its versioned Synchronization Baseline, and the storage hooks later tickets use for local-change evidence and repository-to-Workspace lookup. Move active binding and baseline evidence out of Workspace content and out of origin-wide `localStorage`, then perform a guarded one-time migration of trustworthy v1 evidence without allowing copied, forked, reviewed, or restored content to bind itself.

This slice must leave callers with an explicit distinction between a bound Workspace with a valid Baseline and a bound Workspace whose status is `Cannot tell`. A failure to read or retain evidence must degrade to the latter, never to an empty or trusted Baseline.

## Where to start

- `packages/core/src/remote/publish-manifest.ts` is the v1 `localStorage` manifest, including its repository/branch validation and post-Publish storage-failure behavior.
- `packages/core/src/remote/remote-binding.ts` is the current Workspace-root `remote.json` binding. Preserve its repository parser and normalization rules, but stop treating Workspace bytes as the active relationship after migration.
- `packages/core/src/store/workspace-folder.ts` contains the existing IndexedDB setup and persisted folder handle. Evolve or factor the installation database rather than introducing another origin-wide string store; the metadata must support tens of thousands of path records.
- `apps/editor/src/lib/workspace-storage.svelte.ts` owns Workspace identity/backing, initial adoption, switching, binding, unbinding, Backup Restore, and the current `#readRemote` path.
- `apps/editor/src/lib/editor-session.svelte.ts` constructs `PublishManifests` and currently passes v1 evidence into Publish planning.
- `packages/core/src/transfer/restore-workspace-tar.ts` already strips `remote.json` while restoring a Backup; retain that observable safety rule.
- Existing coverage starts in `packages/core/src/remote/publish-manifest.test.ts`, `packages/core/src/remote/remote-binding.test.ts`, `packages/core/src/transfer/workspace-tar.test.ts`, `e2e/editor-remote-binding.e2e.ts`, and `e2e/editor-backup.e2e.ts`.

## Contract

- Installation-local records are keyed by a stable Workspace identity plus backing. Renaming display text or switching the open Workspace must not redirect another Workspace's evidence. Browser-backed and chosen-folder Workspaces use the same metadata API but retain distinct identities.
- A Workspace has zero or one active Remote. Binding replaces or clears that one relationship atomically; no API represents multiple Remotes.
- Normalize repository identity once using the existing owner/repository/branch rules. The repository selected by an Open or explicit bind is authoritative; published bytes are not.
- The versioned Baseline stores repository identity, branch, commit evidence, and a complete source-path `path -> blob SHA` map. Invalid JSON/shape/version, missing evidence, repository or branch mismatch, and storage failure all read as no valid Baseline.
- Keep Baselines and the later local-change index in IndexedDB-sized durable storage, not `localStorage`, Workspace files, Backup files, Project Bundles, Review Workspaces, or synchronized repository paths.
- Baseline writes that fail after an operation has succeeded clear stale evidence and return a result that callers can report as `Cannot tell`; they must not turn the already-successful operation into a failure.
- Run v1 migration before exposing synchronization actions for the Workspace. A valid v1 manifest is migrated only when its Workspace key, legacy binding, repository, and branch all agree. Persist the new local relationship and Baseline before considering migration complete.
- A legacy `remote.json` without corroborating local v1 evidence is never lifted silently. Offer explicit confirmation naming the repository. Confirmation creates the installation-local relationship without a Baseline; refusal creates neither. A mismatched or corrupt v1 manifest cannot corroborate it.
- Once migration has been decided, active code reads installation-local metadata only. A `remote.json` encountered in copied/forked repository content, a Project Bundle, Review Workspace, or restored Backup cannot become an active Remote.
- Existing Review Workspaces remain unbindable. Existing Backup Restore remains unbound even when the archive carries compatibility metadata.
- Provide test seams for metadata storage failure, corrupt records, legacy evidence, and different Workspace identities without reaching the browser's real network.

## User Stories

- 107. As an author, I want a Workspace to have at most one Remote, so that synchronization always has one unambiguous counterpart.
- 108. As an author, I want the Remote relationship stored as local-only state, so that it never arrives through a Published Site, Backup, or Project Bundle.
- 109. As an author opening a copied or forked repository, I want the repository I selected to determine the Remote, so that stale published metadata cannot redirect me.
- 110. As an author, I want the Synchronization Baseline stored as local-only per-path evidence, so that another installation cannot inherit my synchronization history.
- 151. As an author, I want Cannot tell reported when no valid Synchronization Baseline exists for the bound Remote, so that absence, corruption, repository mismatch, or failed Baseline storage is visible.
- 155. As an existing user, I want a valid v1 publish manifest migrated into the Synchronization Baseline for the same Workspace and Remote, so that prior successful Publish evidence is not discarded.
- 156. As an existing user, I want a bound Workspace with no valid v1 manifest to remain bound but report Cannot tell, so that migration does not fabricate a Baseline.
- 157. As an existing user, I want a legacy Workspace binding lifted into installation-local metadata only when corroborated or explicitly confirmed, so that copied folder content cannot bind itself silently.
- 158. As an author restoring a Backup, I want the restored Workspace to remain unbound, so that local-only Remote relationships do not travel through Backup and Restore.

## Out of scope

- Do not implement three-way status planning, automatic status checks, Update, or Baseline-aware Publish behavior; tickets 09, 12, 14, 15, and 16 own those consumers.
- Do not add the managed-store local-change index; ticket 10 owns write/delete tracking against this storage API.
- Do not rename Clone/Open controls or alter invitation parameters; ticket 11 owns that flow.
- Do not redesign credentials, the OAuth broker, Project metadata, Import Provenance, or Review metadata.
- Do not retain a compatibility fallback that silently reads `remote.json` as the active relationship after migration.

## Acceptance criteria

- [ ] Core tests prove round-trip persistence for Remote and Baseline records keyed by Workspace identity/backing, one-Remote replacement/clear semantics, complete large path maps, and fail-closed reads for corrupt, unsupported, mismatched, or failed storage.
- [ ] Migration tests prove matching v1 binding plus manifest migrates exactly, binding without a valid manifest requires confirmation and retains no invented Baseline, mismatched evidence does not migrate, and a failed migration write leaves legacy evidence unconsumed and no partial new record.
- [ ] Browser tests prove a confirmed legacy binding remains bound with visible `Cannot tell`, declining does not bind, copied/forked content cannot redirect the selected repository, and restoring a bound Backup produces an unbound Workspace.
- [ ] Tests prove Review Workspaces, Project Bundles, Workspace bytes, exported Backups, and repository output contain no active installation-local Remote, Baseline, or change-index record.
- [ ] `remote.json` and v1 `localStorage` are no longer active runtime stores after migration, while malformed or over-capacity legacy records fail safely.

Run these commands from the repository root:

```bash
pnpm --filter @ballastella/core test -- src/remote/synchronization-metadata.test.ts src/remote/publish-manifest.test.ts src/remote/remote-binding.test.ts src/transfer/workspace-tar.test.ts
pnpm -r build
pnpm test:e2e editor-remote-binding editor-backup
pnpm precommit lint check test
```

Success is all commands exiting zero; the named core specs show the migration/storage cases passing, and the named browser specs visibly distinguish a trustworthy migrated Baseline, a confirmed binding with `Cannot tell`, a declined/untrusted binding, and an unbound restore.

## Blocked by

None - can start immediately
