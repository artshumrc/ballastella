# 05 - Recover interrupted Project Imports

## What to build

Put Project Import recovery into the Workspace startup gate. Before any Workspace can list Projects or
Map Images, report size, back up, publish, or open a Project, resolve an outstanding Import marker:
remove every provisional path from an uncommitted transaction, or finish a transaction whose commit
was made durable.

Recovery must work for browser-backed and chosen-folder Workspaces and leave the Workspace unavailable
when cleanup cannot complete.

## Where to start

- Ticket 04's transaction marker, state transitions, and idempotent cleanup operations.
- `apps/editor/src/lib/workspace-storage.svelte.ts`: `#recovered`, `#beginRecovery`, `start`, `#adopt`,
  and `#replayAndReport`. This is the existing before-read gate for interrupted deletions and journal
  replay.
- `apps/editor/src/routes/+page.svelte`: every Project open already waits on `storage.recovered`.
- `packages/core/src/project/workspace.ts`: `finishInterruptedDeletions` documents the required
  startup-before-enumeration ordering.
- `packages/core/src/project/map-images.ts`, `packages/core/src/project/workspace-size.ts`,
  `packages/core/src/transfer/export-workspace-tar.ts`, and publish planning: prove they are not
  reachable while recovery is unresolved rather than adding transaction filters to each.
- Store adapter suites under `packages/core/src/store/` and the existing browser workflows in
  `e2e/editor-transfer.e2e.ts` and `e2e/editor-folder-workspace.e2e.ts`.
- Add the engine fault/restart matrix in
  `packages/core/src/transfer/project-import-recovery.test.ts`.

## Contract

Recovery is a prerequisite for Workspace adoption, not a background task. Extend the existing
recovery promise so Import recovery runs before interrupted deletions, journal replay, route-driven
Project reads, Workspace enumeration, and Remote operations.

For an uncommitted marker, delete every listed provisional final path, with imported `project.json`
removed before any other cleanup could expose it, reclaim abandoned single-file writes, and delete the
marker last. For a committed marker, verify the complete listed closure and finish the marker removal;
if the protocol allows a committed marker before one final bookkeeping step, complete that step
idempotently.

Never infer provisional paths by scanning names. The marker inventory is authoritative. Never delete a
path not named by the marker. If the marker is malformed, the backing is unreachable, or any listed
path cannot be cleaned or verified, keep the Workspace unavailable and present a domain-language
recovery failure; do not guess that the Workspace is safe.

The observable result after restart is exactly the pre-Import snapshot for an uncommitted transaction
or exactly the complete post-Import snapshot for a committed transaction. Project lists, Map Image
lists, Workspace size, Backup, and Publish must never include provisional files.

## User Stories

- **19.** As an author, I want a failed or interrupted Import recovered before my Workspace opens, so that no provisional Project, Map Image, Alignment, or Annotation appears in the Workspace or its Map Image list.

## Out of scope

- Do not add a manual recovery chooser or expose staging internals to the user.
- Do not recover Update transactions; their before-image protocol belongs to synchronization work.
- Do not silently discard malformed markers or make the Workspace available after partial cleanup.
- Do not add per-reader filters for provisional paths.
- Do not redesign autosave journal or interrupted deletion recovery beyond ordering this new gate with
  them.

## Acceptance criteria

- [ ] Restart fault injection at every durable boundary yields exactly the complete before or complete
      after store snapshot.
- [ ] No Project list, Map Image list, size, Backup, Publish plan, or direct route read runs before
      Import recovery resolves.
- [ ] An uncommitted marker removes only its listed paths and then the marker; a committed marker
      completes idempotently and preserves the imported closure.
- [ ] A failed cleanup keeps the Workspace unavailable and leaves enough durable evidence to retry on
      the next startup.
- [ ] Browser storage and chosen-folder adapter tests produce the same cleanup and recovery result.
- [ ] Any new Seam 2 assertion is consolidated into an existing transfer workflow; if the 646 ceiling
      rises, `scripts/check-seam-2-size.mjs` gains a dated row explaining why the behavior cannot be
      proved at the core adapter seam.

```bash
pnpm --filter @ballastella/core test -- project-import-recovery
pnpm test:e2e editor-transfer
pnpm test:e2e editor-folder-workspace
pnpm precommit
```

Success: all four commands pass; interrupted imports are invisible before recovery, adapter snapshots
settle to only the exact before or after state, and the Seam 2 fence remains at or explicitly accounts
for its ceiling.

## Blocked by

- 04
