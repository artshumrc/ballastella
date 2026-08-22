# 16 - Make Publish Baseline-aware

## What to build

Integrate the existing Publish and Publish anyway flow with the shared synchronization planner and installation-local Baseline. Ordinary Publish remains the sole explicit outbound operation, refuses until Remote changes are incorporated, preserves outside repository files, and records successful shared source state. Publish anyway remains an explicit local-wins escape hatch. Every failure leaves prior evidence unchanged, while a successful Remote commit followed by failed Baseline storage is reported as successful publication with `Cannot tell`.

## Where to start

- `packages/core/src/remote/publish-to-remote.ts` contains the exact-tree upload, outside-file preservation, current v1 conflict detector, permission/request-budget behavior, and successful manifest return.
- `packages/core/src/remote/publish-manifest.ts` and `apps/editor/src/lib/editor-session.svelte.ts` currently read/write the v1 post-Publish manifest; replace that integration with ticket 01's Baseline API.
- `packages/core/src/publish/publish.ts` generates local Published Site output and staleness. Ticket 02's classifier must keep generated output separate from source planning while Publish still regenerates it.
- `apps/editor/src/lib/publish/PublishDialog.svelte` already has ordinary Publish, two-step Publish anyway, progress, refusal, and post-success manifest-storage wording. Adapt this surface rather than adding another Publish UI.
- Ticket 09 supplies ordinary/anyway plans and complete chosen-folder hashing; ticket 12 supplies persistent status; tickets 14/15 supply the Update remedy ordinary Publish points to.
- Existing tests are `packages/core/src/remote/publish-to-remote.test.ts`, `packages/core/src/publish/publish.test.ts`, `e2e/editor-publish.e2e.ts`, and `e2e/editor-remote-conflict.e2e.ts`.

## Contract

- Publish is the only outbound action. Saving, checking status, opening, and updating never invoke it.
- Before local viewer generation or a large upload, flush managed writes, verify the authenticated account's repository permission, and run deliberate complete local hashing plus commit-consistent Remote inventory/planning. A read-only account is refused before upload begins.
- Ordinary Publish may proceed only when no Remote-only source change, safe changes on both sides, or Conflict remains. Refusals change neither Workspace source, Remote, nor Baseline and direct the author to Update from GitHub where applicable.
- A no-Baseline, non-empty differing Remote retains the current safe refusal and offers Publish anyway. Equal source namespaces or an empty side may establish a Baseline through the deliberate plan without inventing history.
- Publish anyway is the existing explicit two-step local-wins action. Consent remains tied to the conflict/path set shown; replan before transfer and refuse if new unconsented conflict paths appear. Do not add Remote-wins or merge controls.
- Publish regenerates Publish-owned output and exact-mirrors Ballastella's owned namespace while preserving README, LICENSE, CNAME, workflows, submodules, and every other outside path.
- The source Baseline excludes generated viewer/Base Map output but includes authored source and Offline Copies. Generated differences become Published Site staleness and are refreshed by Publish.
- On successful ordinary Publish or Publish anyway, persist repository/branch, resulting commit, and complete shared source `path -> blob SHA` evidence. Clear the local-change index only for source paths represented by the successful Baseline.
- Failed permission, planning, validation, authentication, upload, branch move, ref move, or local Publish leaves the prior Baseline unchanged. Never pre-advance evidence from a forecast or tree listing.
- If the Remote commit succeeds but durable Baseline storage fails, do not report Publish failure or roll back the Remote. Clear stale evidence, report successful publication plus `Cannot tell`, and leave indexed local evidence conservative.
- Recompute persistent Remote Status immediately after every success/refusal where evidence or observed Remote state changed.
- Preserve current per-file progress, request budgets, exact branch visibility, outside-file protection, and inaccessible-review guards.

## User Stories

- 106. As an author without write permission, I want Publish refused before upload begins, so that I do not wait for a transfer that cannot complete.
- 132. As an author, I want Publish to remain the only explicit outbound action, so that saved work never becomes public automatically.
- 133. As an author, I want ordinary Publish to require Remote changes to be incorporated first, so that the Remote becomes the complete current Workspace rather than a state absent locally.
- 134. As an author, I want successful Publish and Publish anyway to store their result as the Baseline when local evidence can be retained, and report Cannot tell when it cannot, so that a successful publication never implies evidence the browser failed to keep.
- 137. As an author, I want Conflict to stop Update or ordinary Publish without changing Workspace, Remote, or Baseline, so that refusal is safe.
- 139. As an author, I want the existing Publish anyway action retained as an explicit local-wins escape hatch, so that intentional replacement remains possible.
- 142. As an author, I want failed Open, Update, Publish, and Publish anyway operations to leave the Baseline unchanged, so that unsuccessful work never becomes synchronization evidence.
- 144. As a repository owner, I want Publish to continue preserving README, LICENSE, CNAME, workflows, and other files outside Ballastella's namespace, so that synchronization does not take ownership of my repository.
- 152. As an author, I want Publish without a Baseline to retain today's safe refusal for a non-empty Remote and offer Publish anyway, so that unknown Remote work is never overwritten silently.

## Out of scope

- Do not redesign local site generation, OAuth acquisition, GitHub App infrastructure, repository ownership, or request-budget limits.
- Do not add automatic Publish, content merging, Remote-wins replacement, per-file conflict resolution, or Git history UI.
- Do not make generated viewer output synchronization source or download it during Update.
- Do not alter Project Import, Review Import, or Project-level publication behavior.

## Acceptance criteria

- [ ] Core tests prove ordinary Publish proceeds for Up to date/Changes to publish, refuses Remote-only/Changes on both sides/Conflict before mutation, and points to Update without changing source Workspace, Remote tree/head, or Baseline.
- [ ] A no-Baseline non-empty differing Remote is refused with Publish anyway available; equal or empty-side deliberate plans establish evidence safely.
- [ ] Publish anyway replaces only Ballastella-owned paths represented by the consented/replanned local-wins plan and preserves outside files/submodules.
- [ ] Successful ordinary Publish and Publish anyway persist complete source Baselines at the actual resulting commit and selectively clear local-change evidence; generated output is absent from the Baseline.
- [ ] Fault cases for permission, authentication, validation, branch movement, upload phases, ref movement, and local generation leave the previous Baseline unchanged.
- [ ] A forced post-commit Baseline-write failure leaves the Remote commit successful, clears stale evidence, renders success plus `Cannot tell`, and does not claim the operation failed.
- [ ] Browser tests prove the existing two-step Publish anyway focus/control semantics, Update-first refusal, read-only preflight, progress, immediate status recomputation, and outside-file preservation.

Run these commands from the repository root:

```bash
pnpm --filter @ballastella/core test -- src/remote/publish-to-remote.test.ts src/remote/synchronization-publish.test.ts src/remote/synchronization-planner.test.ts src/publish/publish.test.ts
pnpm -r build
pnpm test:e2e editor-publish editor-remote-conflict
pnpm precommit lint check test
```

Success is all commands exiting zero; the fake Remote and persisted evidence match the actual commit after both publish modes, every refusal/failure retains the prior Baseline, and post-commit evidence failure is visibly successful publication with `Cannot tell`.

## Blocked by

- 09-plan-workspace-synchronization.md
- 10-track-local-changes-without-rehashing.md
- 12-show-remote-status.md
- 14-update-non-destructive-remote-changes.md
