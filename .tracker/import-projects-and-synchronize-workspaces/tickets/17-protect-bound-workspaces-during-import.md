# 17 - Protect bound Workspaces during Import

## What to build

Integrate Project Import with a Workspace's synchronization evidence without creating a Project-level
Remote. Before allocation in a bound Workspace, inventory current Remote Project directories and
combine them with local and Baseline directories. Refuse an Import of the same Project from the
Workspace's own Remote, and ensure a successful Import appears as ordinary local work for the next
Workspace Publish.

## Where to start

- Ticket 07's pure allocator over explicit local, Remote, and Baseline directory inventories.
- Ticket 13's direct Import orchestration and ticket 14's synchronization planner/status integration.
- The installation-local Remote relationship, Synchronization Baseline, and local-change index added
  by tickets 01, 02, 09, and 10.
- `packages/core/src/remote/remote-binding.ts`: repository parsing and normalization. Do not compare
  pasted strings or URLs directly.
- `packages/core/src/remote/remote-tree.ts` and
  `packages/core/src/remote/publish-to-remote.ts`: `readRemoteTree` and
  `remoteProjectDirectories` provide current Remote evidence.
- `packages/core/src/remote/publish-manifest.ts`: the v1 predecessor shows how repository/branch
  evidence self-validates; consume the new Baseline abstraction rather than extending this legacy
  store.
- `packages/core/src/remote/publish-to-remote.ts`: publish owns the whole Workspace namespace, which is
  why an imported Project needs no special outbound route.
- `apps/editor/src/lib/workspace-storage.svelte.ts`: current Workspace Remote state and the place to
  acquire inventory before calling Import.
- Add focused core specs such as
  `packages/core/src/transfer/project-import-own-remote.test.ts`; consolidate the browser lifecycle
  into `e2e/editor-transfer.e2e.ts` and `e2e/editor-remote-conflict.e2e.ts`.

## Contract

For every Import into a bound Workspace, fetch the current Remote tree before allocation and recognize
Project directories from the union of local Workspace, current Remote, and valid Baseline paths. If
the Remote cannot be inventoried authoritatively because it is unreachable, truncated, malformed, or
otherwise unavailable, refuse before the Import marker or any destination write. Do not allocate from
stale Baseline evidence alone when a Project may exist only on GitHub.

Normalize repository identity using the same owner/repository/branch rules as synchronization. A
GitHub Import is the Workspace's own Remote Project when both normalized repository identity and
source Project directory match. A Project Bundle is treated as own-Remote only when directly observed
evidence establishes that same pair; a filename or inherited provenance alone is not enough.

On own-Remote refusal:

- write nothing and do not advance or alter the Baseline;
- if the local Project directory is present, direct the author to that Project;
- if Remote evidence is newer or only Remote has the Project, direct the author to **Update from
  GitHub**;
- do not offer a detached duplicate as a workaround.

A successful Import writes through the managed ProjectStore write/index seam so Remote Status becomes
**Changes to publish** or remains the appropriate broader local-drift state. It does not advance the
Baseline. The next deliberate Workspace Publish includes the imported Project and its fresh Map
Images, Alignments, and Annotations as ordinary Workspace source content.

No imported Project receives a binding, Remote, Baseline, status, or Publish action of its own.
Synchronization remains exactly one ordinary Workspace to at most one Remote.

## User Stories

- **49.** As an author in a bound Workspace, I want Import to register as local work to publish, so that Remote Status reflects the new Project.
- **50.** As an author, I want a later Workspace Publish to include the imported Project, so that I can publish it deliberately as part of my Workspace.
- **51.** As an author, I want an imported Project to have no Remote relationship of its own, so that synchronization remains a Workspace concern.
- **69.** As an author, I want Import from my current Workspace's own Remote refused, so that I do not duplicate synchronized work.
- **70.** As an author, I want an own-Remote Import attempt to direct me to the existing Project or Update from GitHub, so that I use the appropriate synchronized copy.
- **71.** As an author, I want an own-Remote refusal to leave my Workspace unchanged, so that an accidental choice has no side effects.
- **161.** As an author, I want a bound Workspace's current Remote Project directories reserved during Import allocation, so that an imported local Project cannot collide with a Project already present only on GitHub.

## Out of scope

- Do not implement Remote Status, Baseline storage, Update, or Publish planning in this ticket; use the
  dependency tickets' contracts.
- Do not add a Project-level binding, status, Update, or Publish control.
- Do not treat inherited provenance, a filename, or an account name as proof of own-Remote identity.
- Do not proceed with allocation when current Remote inventory is unavailable.
- Do not automatically Update or Publish after Import.
- Do not change synchronization conflict resolution or add content merging.

## Acceptance criteria

- [ ] Local-only, Remote-only, and Baseline-only Project directories all participate in allocation;
      a current Remote inventory failure refuses before any destination write.
- [ ] Normalized same-repository plus same-Project GitHub Import is refused and names the local Project
      or Update from GitHub as appropriate.
- [ ] A Bundle is refused as own-Remote only when its directly observed evidence proves the match.
- [ ] Complete Workspace, Baseline, and Remote snapshots are unchanged after every own-Remote or
      inventory refusal.
- [ ] A successful Import marks local drift without advancing the Baseline and Remote Status reports
      the dependency ticket's local-work state.
- [ ] A later ordinary Workspace Publish contains the imported closure and still has exactly one
      Workspace-level Remote relationship.
- [ ] Browser coverage is folded into existing transfer/conflict/publish workflows; any Seam 2 ceiling
      increase carries the required dated justification.

```bash
pnpm --filter @ballastella/core test -- project-import-own-remote
pnpm --filter @ballastella/core test -- project-import-allocation
node scripts/check-seam-2-size.mjs
pnpm test:e2e editor-transfer
pnpm test:e2e editor-remote-conflict
pnpm test:e2e editor-publish
pnpm precommit
```

Success: all seven commands pass; tests prove current Remote inventory reserves unseen directories,
own-Remote attempts are side-effect-free, and a successful Import changes only local synchronization
evidence until an explicit Workspace Publish.

## Blocked by

- 01
- 02
- 07
- 09
- 10
- 13
- 14
