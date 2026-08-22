# 14 - Update non-destructive Remote changes

## What to build

Add an explicit Update from GitHub action for non-destructive inbound plans. It must fetch and SHA-verify Remote-only additions and replacements, preserve local-only changes on other paths, validate the prospective Workspace, commit the valid non-deletion result without publishing anything, selectively advance shared Baseline evidence, and immediately recompute Remote Status.

## Where to start

- Consume ticket 09's Update plan; do not reimplement three-way decisions in the transfer engine or component.
- `packages/core/src/remote/clone-from-remote.ts` already performs anonymous raw-host reads, per-file SHA verification, progress, and Alignment routing for inbound files.
- `packages/core/src/remote/remote-tree.ts` and `packages/core/src/remote/fake-github.ts` are the inventory/transport test seams.
- `packages/core/src/alignment/alignment-file.ts` remains the only Alignment writer; Update paths arriving as data must still pass through it with the operation's explicit replacement intent.
- `apps/editor/src/lib/workspace-storage.svelte.ts` and `apps/editor/src/lib/editor-session.svelte.ts` should expose one Update orchestration path bound to the active stable Workspace identity.
- `apps/editor/src/lib/components/NavigationBar.svelte` and the Remote Status surface from ticket 12 are the persistent place to offer the explicit action and report its outcome.
- Extend `e2e/editor-remote-conflict.e2e.ts` for one complete inbound workflow; keep the exhaustive path matrix in a new core Update spec.

## Contract

- Update is initiated by an explicit `Update from GitHub` control. Status checks never call it and Remote changes never apply automatically.
- Public inbound synchronization uses anonymous reads and does not require push permission. A held credential is not a prerequisite and lack of write permission is not a refusal.
- Before transfer, flush managed local writes and run deliberate complete local list/read/hash planning, including chosen-folder paths that may have changed out of band. Replan against a commit-consistent current Remote inventory.
- This ticket executes plans containing Remote-only additions and replacements but no deletions. If a current plan includes deletion, stop before writing and hand it to ticket 15's confirmation path once available.
- Download only paths selected by the agreed plan, with bounded concurrency, per-file progress, and SHA verification against the commit-consistent inventory. A moved branch, missing blob, bad SHA, or invalid bytes fails without claiming success.
- Preserve every local-only changed path and combine safe Remote changes on other paths. Update never sends a blob, creates a commit, moves a ref, invokes local Publish generation, or changes outside-repository files.
- Validate the complete prospective Workspace graph before making the result visible. Different same-path changes or a graph-invalid combination are Conflict and leave Workspace, Remote, and Baseline unchanged.
- Commit all additions/replacements as one observational operation using the recoverable transaction seam ticket 15 will extend for deletions. Until deletion support lands, no destructive path may enter that transaction.
- After a successful Update, persist Baseline SHAs only for paths whose local and Remote bytes are now shared. Keep local-only indexed paths and their previous Baseline relationship intact so status remains Changes to publish where appropriate.
- If Baseline persistence fails after Workspace commit, report Update success plus `Cannot tell`; clear stale evidence rather than rolling back valid inbound content or claiming evidence was retained.
- Recompute and render Remote Status immediately after success against the resulting Workspace/evidence.
- Guard every asynchronous phase by stable Workspace identity/generation; switching Workspaces cannot apply or report an Update to the wrong destination.

## User Stories

- 105. As an author without write permission, I want an opened public Workspace to receive Updates, so that inbound synchronization is not confused with publishing authority.
- 121. As an author, I want Update from GitHub to remain an explicit inbound action, so that Remote work never changes my Workspace silently.
- 122. As an author, I want Update from GitHub never to Publish local work, so that receiving changes cannot make my edits public.
- 123. As an author, I want Update to bring Remote-only additions into my Workspace, so that newly published Projects and assets become available locally.
- 124. As an author, I want Update to replace locally unchanged files with Remote changes, so that another machine's published work can become current locally.
- 128. As an author, I want Update to preserve local-only changes on other paths, so that receiving Remote work does not discard unpublished work.
- 129. As an author, I want Update to combine non-conflicting Remote changes with local changes on different paths, so that two machines can work on separate files without a content merger.
- 130. As an author, I want successful Update to advance the Baseline only for state made shared, so that remaining local work still appears as Changes to publish.
- 131. As an author, I want Remote Status recomputed after Update, so that the next required action is immediately clear.

## Out of scope

- Do not apply or preview Remote deletions; ticket 15 owns destructive confirmation and full rollback.
- Do not add merging, per-file conflict choices, or a Remote-wins override.
- Do not upload local files, regenerate viewer output, or alter Publish behavior; ticket 16 owns outbound integration.
- Do not download Publish-owned generated output or repository files outside the source namespace.
- Do not add private-repository Update behavior beyond existing public-read scope.

## Acceptance criteria

- [ ] Core tests prove Remote-only source additions and replacements arrive byte-for-byte, including Projects, Map Images, Alignments, Annotations, Offline Copies, and Base Map tiles, while generated output is never downloaded.
- [ ] Tests prove a local-only change on another path survives unchanged, the combined graph is valid, and only newly shared paths advance/clear in Baseline and local-change evidence.
- [ ] Conflict, malformed/unsupported content, moved branch, missing/corrupt blob, graph-invalid combination, and failed write leave complete before snapshots of Workspace and Baseline unchanged.
- [ ] A public repository whose authenticated account cannot push still updates anonymously; request logs show no GitHub write and no credential requirement.
- [ ] A deletion-bearing plan performs no write and reaches the future destructive-confirmation state rather than silently ignoring or applying deletion.
- [ ] Browser tests prove Update is explicit, reports per-file progress and outcome, does not change the Remote head/files, preserves local edits, opens a Remote-added Project, and immediately displays the recomputed next status.
- [ ] Switching Workspaces during planning/download cannot write to or report against the newly active Workspace.

Run these commands from the repository root:

```bash
pnpm --filter @ballastella/core test -- src/remote/update-from-github.test.ts src/remote/synchronization-planner.test.ts src/remote/fake-github.test.ts
pnpm -r build
pnpm test:e2e editor-remote-conflict
pnpm precommit lint check test
```

Success is all commands exiting zero; core snapshots show only planned non-destructive inbound paths changed, fake GitHub shows no outbound operation, and the browser workflow preserves local work while moving status to the mechanically expected next state.

## Blocked by

- 09-plan-workspace-synchronization.md
- 10-track-local-changes-without-rehashing.md
- 11-open-a-workspace-from-github.md
- 12-show-remote-status.md
