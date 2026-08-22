# 12 - Show Remote Status

## What to build

Add a persistent Remote Status control to the editor navigation bar, separate from Saved locally. For each bound ordinary Workspace, project ticket 09's six synchronization states into visible text, perform bounded automatic checks when authenticated, provide an explicit anonymous check for public Remotes, and preserve the last successful determination when a later observation fails.

## Where to start

- `apps/editor/src/lib/components/NavigationBar.svelte` owns persistent Workspace identity, Publish, and the existing SaveIndicator. Add Remote Status as a separate control/region rather than overloading the one `role="status"` used for local durability.
- `apps/editor/src/lib/components/SaveIndicator.svelte` is the local-only contract that must remain unchanged.
- `apps/editor/src/lib/workspace-storage.svelte.ts` owns the active Remote, credential state, Workspace switches, startup, and window-level lifecycle integration.
- `apps/editor/src/lib/editor-session.svelte.ts` is the application-facing seam for planner/check orchestration.
- Tickets 01, 09, and 10 provide durable evidence, pure status calculation, and indexed local drift without local hashing.
- `packages/core/src/remote/remote-tree.ts` supplies anonymous public inventories; authenticated checks may reuse credentialed GitHub transport without transferring file contents.
- Extend `e2e/editor-remote-conflict.e2e.ts` for the status lifecycle rather than creating a second planner matrix in Playwright. `e2e/editor-publish.e2e.ts` already fences Saved locally and Publish semantics.

## Contract

- Render persistent text for exactly: `Up to date`, `Changes to publish`, `Update available`, `Changes on both sides`, `Conflict`, and `Cannot tell` whenever an ordinary Workspace has a Remote. Do not encode the result only by color, icon, tooltip, or disabled action.
- Keep Remote Status visibly and semantically separate from `Saved locally`; local durability must continue to be announced independently.
- A status check is observational. It may list Remote metadata/tree SHAs but downloads no file bytes, writes no Workspace path, writes no Remote path, and never advances or fabricates a Baseline.
- Passive checks use ticket 10's durable change index plus Remote/Baseline inventories and perform no local Workspace list/read/hash pass.
- When authenticated, check on successful Workspace open and window focus with a bounded throttle/coalescing policy. Multiple focus events or concurrent callers inside the bound must share/skip work rather than fan out GitHub requests.
- When signed out, do not poll anonymously. Offer an explicit keyboard-operable `Check Remote Status` action that reads a public Remote without asking for or sending credentials.
- Persist or retain the last successful state and timestamp for the active Workspace. If a later network/auth/rate-limit check fails, keep that state visible as the last successful result and add visible/announced text that the current check failed. A failed check is never `Up to date` or `Cannot tell`.
- `Cannot tell` is a successful determination that the bound Remote has no valid matching Baseline, not a request failure.
- Surface Published Site staleness separately from source Remote Status using ticket 02's output classification.
- Workspace switches cancel or ignore stale completions by stable Workspace identity/generation so one Workspace's result cannot render on another.
- Use visible text and polite live semantics for status/progress; newly inserted failures use alert semantics. Preserve predictable focus after popovers/dialogs and explicit checks.

## User Stories

- 111. As an author, I want Remote Status shown separately from Saved locally, so that local durability is not mistaken for GitHub agreement.
- 112. As an author, I want Remote Status persistently available in the navigation bar, so that drift remains visible while I edit a Project.
- 114. As an authenticated author, I want Remote Status checked automatically with bounded frequency without rereading and hashing every local file, so that I learn about out-of-band GitHub changes without repeatedly scanning a multi-gigabyte Workspace.
- 115. As a signed-out author, I want to check a public Remote explicitly, so that status remains available without automatic unauthenticated polling.
- 116. As an author, I want a status check to transfer no files, so that observation cannot change either side.
- 117. As an author, I want a status check never to advance the Synchronization Baseline, so that checking cannot hide drift.
- 118. As an author, I want a failed check distinguished from Up to date while preserving the last successful status, so that network failure is not reported as agreement.

## Out of scope

- Do not apply Remote files or add an Update side effect to status checking; tickets 14 and 15 own Update.
- Do not alter Publish gating or Baseline advancement; ticket 16 owns Publish integration.
- Do not add a second planner or hash the local Workspace during passive checks.
- Do not introduce background timers that poll while signed out, while reviewing, or when no Remote is bound.
- Do not collapse Published Site staleness into one of the six source states.

## Acceptance criteria

- [ ] A bound Workspace shows one of the six exact text labels persistently on the hub and Project routes while `Saved locally` remains independently visible.
- [ ] Engine tests prove a successful check lists only Remote metadata and performs zero local `list`, `read`, `size`, hash, write, delete, Baseline-write, and Remote-write operations.
- [ ] Authenticated open/focus checks are throttled and coalesced under a deterministic clock; signed-out sessions make no automatic request and can explicitly check a public Remote without authentication.
- [ ] A failed check preserves the prior successful state/timestamp, adds a distinct visible announced failure, and never relabels the result Up to date or Cannot tell.
- [ ] Switching Workspaces during a pending check cannot leak the old result, request failure, or timestamp onto the new Workspace.
- [ ] Published-output-only differences show Published Site staleness while source Remote Status remains Up to date.
- [ ] Keyboard and screen-reader assertions prove the control is reachable, visible text carries all meaning, progress/status use polite semantics, and a newly inserted failure is an alert with predictable focus.

Run these commands from the repository root:

```bash
pnpm --filter @ballastella/core test -- src/remote/remote-status.test.ts src/remote/local-change-index.test.ts src/remote/synchronization-planner.test.ts
pnpm -r build
pnpm test:e2e editor-remote-conflict editor-publish
pnpm precommit lint check test
```

Success is all commands exiting zero; core spies show observation without local bytes or Baseline movement, and browser specs show persistent independent status text, bounded authenticated checks, explicit anonymous checking, and last-known status retained through a failed check.

## Blocked by

- 09-plan-workspace-synchronization.md
- 10-track-local-changes-without-rehashing.md
- 11-open-a-workspace-from-github.md
