# 10 - Track local changes without rehashing

## What to build

Add a durable local-change index at the managed `ProjectStore` write/delete seam. Every successful Ballastella-authored source write or deletion after the Synchronization Baseline must mark that source path, and Baseline advancement must clear only paths whose bytes are shared again. Passive Remote Status checks can then determine local drift without listing, reading, or hashing a multi-gigabyte Workspace.

## Where to start

- Use ticket 01's installation-local metadata store and stable Workspace identity/backing key; do not create another persistence mechanism.
- `packages/core/src/store/project-store.ts` is the single byte-store interface. Prefer a compositional managed-store wrapper installed before an `EditorSession` receives a store rather than edits scattered through every authoring method.
- `packages/core/src/store/opfs-project-store.ts`, `packages/core/src/store/file-system-access-project-store.ts`, and `packages/core/src/store/memory-project-store.ts` are the adapters that must retain their existing contract.
- `packages/core/src/store/project-store-suite.ts` is the shared adapter suite. Extend the managed wrapper's own tests rather than weakening or coupling this backend suite.
- `apps/editor/src/lib/editor-session.svelte.ts` and `apps/editor/src/lib/workspace-storage.svelte.ts` are where stores are constructed/adopted and stable Workspace metadata is available.
- Alignment writes route through `packages/core/src/alignment/alignment-file.ts`; autosave and direct tile/offline writes still ultimately cross `ProjectStore.write`/`delete` and must not bypass tracking.

## Contract

- Track only successful managed writes and deletions. A rejected write/delete, abandoned temporary write, read, list, size query, or status inventory must not mark a path.
- Track source paths according to ticket 02's classifier. Publish-owned generated output and outside-repository paths do not become local scholarly drift.
- The index records enough durable evidence to say which source paths may differ since the current Baseline; it is not itself a Baseline and does not claim current file hashes.
- Install tracking once around each ordinary Workspace's managed store, including browser storage and chosen-folder backings. Avoid double wrapping when sessions switch or reopen.
- A successful Baseline write clears only paths proven shared by that operation. Local-only paths retained by Update remain marked. If Baseline persistence fails, do not clear marks under stale evidence.
- Binding with no Baseline leaves existing managed changes representable but passive status remains Cannot tell.
- Automatic status may combine this index with Remote/Baseline SHAs but must not call local `list`, `read`, `size`, or hashing functions. Provide a spyable core seam that proves zero local-byte reads.
- Deliberate Update and Publish planning still performs the complete local list/read/hash pass required by ticket 09; the index must not suppress it.
- Out-of-band chosen-folder changes are intentionally invisible to the index until deliberate planning. Do not add polling, file watchers, mtime heuristics, or browser-specific observers.

## User Stories

- 159. As an author, I want Remote Status to derive local drift from a durable index of successful writes and deletions since the Baseline, so that automatic checks do not hash every Workspace file.

## Out of scope

- Do not schedule Remote checks or render status; ticket 12 owns those behaviors.
- Do not implement the full planner matrix; ticket 09 supplies the decisions this index feeds.
- Do not execute Update or Publish or clear the whole index after either; operation-specific selective advancement belongs to tickets 14-16.
- Do not modify each authoring feature independently, add File System Access watchers, or infer out-of-band edits from timestamps.

## Acceptance criteria

- [ ] Managed-store tests prove successful writes and deletions persist source-path marks across a fresh session for the same Workspace identity/backing.
- [ ] The same tests prove rejected writes/deletes, reads, listings, size checks, temporary-file cleanup, Publish-owned output, and outside paths create no source marks.
- [ ] Repeated changes to one path remain one indexed path, and successful selective Baseline advancement clears only the supplied shared paths.
- [ ] Browser-storage and chosen-folder store construction both install the same tracker without duplicate notifications.
- [ ] An automatic-status core test spies on the local store and proves zero `list`, `read`, `size`, and hash calls while still reporting indexed writes and deletions.
- [ ] A deliberate planning test proves a direct chosen-folder edit absent from the index is nevertheless detected by ticket 09's complete hash pass.

Run these commands from the repository root:

```bash
pnpm --filter @ballastella/core test -- src/remote/local-change-index.test.ts src/store/managed-project-store.test.ts src/remote/synchronization-planner.test.ts
pnpm precommit lint check test
```

Success is both commands exiting zero; the index survives reconstruction, failed/non-source operations leave it unchanged, selective clearing preserves local-only marks, and the automatic-check test records no local byte access.

## Blocked by

- 01-establish-installation-local-sync-evidence.md
- 02-separate-sync-source-from-published-output.md
- 09-plan-workspace-synchronization.md
