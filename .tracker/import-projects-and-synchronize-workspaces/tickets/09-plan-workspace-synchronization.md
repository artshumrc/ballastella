# 09 - Plan Workspace synchronization

## What to build

Implement a pure three-way synchronization planner over a valid Synchronization Baseline, complete local source inventory, and current Remote source inventory. The planner must classify the Workspace into the six specified Remote Status states, produce safe Update and Publish choices without transferring bytes, validate the prospective Workspace graph, and refuse honestly when history or Remote content cannot support a safe plan.

## Where to start

- Consume the installation-local Remote/Baseline contract from ticket 01 and the shared source/output classifier from ticket 02 rather than reading storage or classifying paths here.
- `packages/core/src/remote/publish-to-remote.ts` contains the existing per-path manifest conflict logic in `detectConflict`; extract the useful comparison semantics rather than retaining a second Publish-only implementation.
- `packages/core/src/remote/remote-tree.ts` and `packages/core/src/remote/blob-sha.ts` provide Remote inventory shapes and git-compatible SHAs.
- `packages/core/src/project/workspace.ts`, `packages/core/src/project/project-file.ts`, `packages/core/src/project/map-images.ts`, and Alignment/Annotation readers contain the graph invariants a prospective combined Workspace must satisfy.
- `packages/core/src/remote/fake-github.ts` is the exhaustive engine seam. Extend it only where a planner case needs observable Remote bytes or commits.
- `packages/core/src/remote/publish-to-remote.test.ts` and `e2e/editor-remote-conflict.e2e.ts` show the current narrower conflict matrix and user-visible refusal behavior.

## Contract

- Keep planning pure: given normalized path inventories and graph-validation input, return a value. Do not read a `ProjectStore`, fetch GitHub, mutate metadata, write files, or advance a Baseline inside the planner.
- Compare the union of source paths recognized from local, Remote, and Baseline evidence. For each path use absent-or-SHA values for Baseline `B`, local `L`, and Remote `R`.
- Return exactly these Workspace-level source states: `up-to-date`, `changes-to-publish`, `update-available`, `changes-on-both-sides`, `conflict`, or `cannot-tell`. UI labels are ticket 12's projection of these stable values.
- With a valid Baseline: `L = B, R = B` is shared; local-only change is outbound; Remote-only change is inbound; equal local and Remote changes are shared bytes eligible for Baseline advancement; different changes to one path are Conflict; safe changes on different paths are Changes on both sides.
- Additions and deletions use the same absent-or-SHA table, not separate ad hoc rules.
- A prospective result that violates a Workspace invariant is Conflict even when every individual path changed on only one side. Malformed, unsupported, truncated, or unreadable Remote input is an operation failure, not Up to date or Conflict.
- No valid Baseline always reports Cannot tell for passive status. A deliberate operation may establish history only when both source namespaces are byte-for-byte equal or one side is empty. Differing non-empty sides cannot be attributed: Update and ordinary Publish plans refuse, while a later caller may offer the existing local-wins Publish-anyway path.
- Update plans choose Remote-only additions/replacements/deletions, retain local-only choices on other paths, identify destructive paths for confirmation, and identify exactly which resulting paths may advance in the Baseline.
- Ordinary Publish plans refuse Remote-only source changes, safe changes on both sides, and Conflict. Publish-anyway plans choose local source for Ballastella-owned paths but preserve repository files outside the namespace.
- Deliberate Update and Publish planning receives a complete locally hashed inventory. This requirement is independent of displayed status and catches chosen-folder edits that bypass managed writes.
- Published-output differences are returned separately as Published Site staleness and never influence source Conflict.
- Do not add content merging or per-file resolution choices. A plan selects whole path bytes already present on one side.

## User Stories

- 113. As an author, I want Remote Status expressed as Up to date, Changes to publish, Update available, Changes on both sides, Conflict, or Cannot tell, so that missing synchronization evidence is never presented as safety.
- 135. As an author, I want a path changed differently both locally and remotely reported as Conflict, so that neither version wins silently.
- 136. As an author, I want a combination of individually separate changes reported as Conflict when it would violate a Workspace invariant, so that file-level safety cannot create a broken graph.
- 138. As an author, I want no content merger or per-file conflict-resolution editor, so that Ballastella does not invent reconciled scholarship.
- 140. As an author, I want malformed, unsupported, or unreadable Remote content reported as an operation failure rather than Up to date or Conflict, so that invalid content is described honestly.
- 153. As an author, I want Update without a Baseline to refuse when differing non-empty local and Remote work cannot be attributed, so that unknown history is not treated as a safe inbound change.
- 154. As an author, I want an empty side or a byte-for-byte equal deliberate Update or Publish plan to establish a Baseline safely, so that Cannot tell can be resolved without inventing history.
- 160. As an author using a chosen folder, I want deliberate Update and Publish planning to hash the complete local Workspace, so that out-of-band file edits invisible to Ballastella's write index are detected before transfer.

## Out of scope

- Do not persist or render Remote Status; ticket 12 owns check scheduling and UI.
- Do not add the managed-write local-change index; ticket 10 owns passive local drift evidence.
- Do not fetch or commit Update bytes; tickets 14 and 15 execute plans.
- Do not upload or alter the Publish dialog; ticket 16 integrates Publish and Baseline advancement.
- Do not invent semantic merges, Git history UI, Remote-wins replacement, or per-file conflict controls.

## Acceptance criteria

- [ ] A table-driven core spec covers additions, replacements, deletions, equal dual changes, different same-path changes, changes on different paths, and paths present on only one or two of the three inventories.
- [ ] The aggregate result is each of the six states under a mechanically identified fixture, with no valid Baseline yielding only Cannot tell for passive status.
- [ ] Deliberate no-Baseline plans establish a Baseline only for equal namespaces or one empty side and refuse differing non-empty sides without mutation.
- [ ] Prospective graph validation catches missing Projects, Map Images, Alignments, and Annotations plus unsupported formats after applying planned choices; invalid Remote input is an operation failure distinct from Conflict.
- [ ] Published-output-only drift produces Published Site staleness while source status remains Up to date.
- [ ] A chosen-folder planning test mutates a file outside the managed write seam and proves complete hashing changes the plan.
- [ ] The planner tests use `MemoryProjectStore`/fake GitHub only to build observable inventories; the planner itself has no I/O and tests assert plans/results rather than private call order.

Run these commands from the repository root:

```bash
pnpm --filter @ballastella/core test -- src/remote/synchronization-planner.test.ts src/remote/publish-to-remote.test.ts src/remote/fake-github.test.ts
pnpm precommit lint check test
```

Success is both commands exiting zero and the planner spec reporting all six states, the full per-path matrix, the missing-Baseline safe-establishment cases, generated-only staleness, and prospective graph-invalid combinations.

## Blocked by

- 01-establish-installation-local-sync-evidence.md
- 02-separate-sync-source-from-published-output.md
