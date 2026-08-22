# 04 - Commit Project Imports atomically

## What to build

Build the destination half of the shared Project Import engine: preflight one validated closure,
reserve every fresh destination path, write each incoming byte once at its final path under one
recoverable transaction marker, and report success only after the complete closure is durable.

The Workspace must expose either its old complete state or its new complete imported Project, never a
partial mixture. This ticket supplies the transaction protocol; startup recovery is completed in
ticket 05.

## Where to start

- The validated source capability added by ticket 03.
- `packages/core/src/store/project-store.ts`: atomic single-file `write`, `list`, `size`, `delete`,
  reserved temporary paths, and the fact that the interface has no multi-file transaction.
- `packages/core/src/store/memory-project-store.ts`: the primary exhaustive engine seam and the place
  to inject failures at every durable boundary.
- `packages/core/src/store/opfs-project-store.ts` and
  `packages/core/src/store/file-system-access-project-store.ts`: both supported backings must obey the
  same observable transaction contract.
- `packages/core/src/transfer/open-project-bundle.ts`: its `project.json`-last discipline and quota
  messaging, but not its disposable-destination rollback strategy.
- `packages/core/src/project/workspace-size.ts`: size without reading pyramid bytes.
- Add the transaction matrix in
  `packages/core/src/transfer/project-import-transaction.test.ts`.

## Contract

Use one-copy recoverable staging. Every destination path is fresh before the operation begins, so
provisional bytes are written once to their final destination paths. Do not duplicate a pyramid into a
second staging tree.

Before the first closure byte is written:

- compute and validate the complete final path set;
- prove no final path exists or aliases an existing path under filesystem name folding;
- check browser storage for the incoming closure's bytes plus bounded transaction metadata, not two
  copies of the closure;
- durably write one reserved transaction marker that names the transaction, state, and every
  provisional final path.

While that marker is unresolved, the Workspace is unavailable to normal Project and Map Image
enumeration, backup, publish, size reporting, and editing. Do not attempt to hide provisional paths at
each reader independently; gate opening the Workspace.

Write all closure files except the imported `project.json`, route Alignment writes through the
Alignment writer, then write `project.json` as the final domain file. Durably mark the transaction
committed only after all final paths are durable. Remove the marker only when that durable state is
established. If an in-process failure occurs before commit, keep the Workspace unavailable until all
marker-listed provisional paths are removed; do not announce failure while exposing residue.

The transaction protocol must be idempotent at every boundary so ticket 05 can safely continue it
after reload. A successful read sees the complete Project closure.

## User Stories

- **17.** As an author using browser storage, I want available storage checked for one incoming Project closure plus transaction metadata before a large Import begins, so that quota exhaustion is reported without requiring space for a second pyramid copy.
- **18.** As an author, I want Import to commit atomically, so that either the complete Project is added or none of it is.
- **48.** As an author, I want Import reported successful only after the complete closure is durable, so that success never describes a partial Project.

## Out of scope

- Do not implement startup discovery or recovery UI; ticket 05 owns startup recovery.
- Do not allocate names or remap source identities; consume the already planned fresh path set.
- Do not use a second full closure copy, a temporary Workspace, or in-memory buffering of a whole
  pyramid.
- Do not generalize this protocol into Update rollback; Update replaces existing paths and has a
  different before-image cost.
- Do not make provisional files visible and then compensate by filtering individual screens.

## Acceptance criteria

- [ ] Quota refusal occurs before the marker or any closure path is written and accounts for one
      closure plus a bounded, asserted metadata allowance.
- [ ] A successful Import writes every non-manifest path once, writes `project.json` last, durably
      commits, clears the marker, and only then resolves success.
- [ ] Fault injection before and after every marker transition and destination write yields only an
      unavailable Workspace, the exact before snapshot, or the exact complete after snapshot.
- [ ] No existing path is overwritten, including under case and Unicode folding on folder-like
      backings.
- [ ] The protocol can be rerun after interruption without duplicating writes or losing the marker's
      path inventory.

```bash
pnpm --filter @ballastella/core test -- project-import-transaction
pnpm --filter @ballastella/core test -- memory-project-store
pnpm precommit lint check test
```

Success: all three commands pass; the fault-injection spec compares complete store snapshots at every
durable boundary, proves one-copy quota accounting, and never observes a partial Project as available.

## Blocked by

- 03
