# 21 - Verify synchronization workflows across backings

## What to build

Complete final conformance verification for synchronization across browser-storage and chosen-folder Workspaces, accessibility, long-transfer progress, and the repository's two test seams. Consolidate the browser acceptance coverage into existing Open, Remote conflict, Publish, and folder workflows; keep exhaustive synchronization matrices and rollback faults at the core/fake-GitHub seam. Fix only defects exposed by these acceptance checks.

## Where to start

- `e2e/editor-clone-remote.e2e.ts`, `e2e/editor-remote-conflict.e2e.ts`, `e2e/editor-publish.e2e.ts`, and `e2e/editor-folder-workspace.e2e.ts` are the existing workflows to extend/consolidate.
- `e2e/support/network-fence.ts`, `e2e/support/github-hosts.ts`, and `packages/core/src/remote/fake-github.ts` are the required no-network transport seams.
- `packages/core/src/store/project-store-suite.ts` and the OPFS/File System Access browser specs provide backing conformance below Playwright.
- `apps/editor/src/lib/components/NavigationBar.svelte`, `apps/editor/src/lib/components/ModalDialog.svelte`, the Remote Status control from ticket 12, and the Update/Publish dialogs are the accessibility surfaces.
- `scripts/check-seam-2-size.mjs` sets the current 646-test ceiling and contains the dated justification table. Run the fence before adding browser tests.
- `CONTRIBUTING.md` requires built app artifacts before browser verification, status/live semantics, keyboard/focus checks, no external network, and observable behavior assertions.

## Contract

- Verify the same domain outcomes on browser storage and a chosen folder: selected Remote/Baseline remain installation-local, Open/Update/Publish decisions agree, committed files agree, transaction recovery agrees, and backing choice is not exposed as a synchronization semantic difference.
- Browser acceptance must include one coherent lifecycle, not a duplicate planner matrix: Open/initial Baseline, Up to date, local Changes to publish, Remote Update available, Changes on both sides, confirmed Update including destructive preview, Conflict refusal, and Publish anyway.
- Keep exhaustive path-state, graph-invalid, migration, storage-failure, and fault-injection matrices at core over `MemoryProjectStore`, adapter conformance, and fake GitHub.
- Assert progress by observable per-file text/counts and bounded request behavior for large Open, Update, and Publish. Tests use the fake transport/network fence and never external hosts.
- Assert keyboard operation for Open, explicit status check, Update, Publish, Publish anyway, destructive confirmation/cancel, and dialog dismissal. Busy controls must not strand focus on `body`; success after Workspace switches moves focus to or identifies the result.
- Assert Remote Status, progress, success, and failure through visible text. Use polite live semantics for ongoing/status outcomes and alert semantics for newly inserted failures; do not rely on color or icons.
- Poll CSS/animation/live-announcement outcomes until settled rather than sampling during transitions.
- Before adding any Playwright test, run the Seam 2 count and first consolidate into an existing scenario or move the claim lower. If the 646 ceiling must rise, add one dated row to `scripts/check-seam-2-size.mjs` naming the exact behavior that cannot fail correctly at core or component seams and profile the resulting suite.
- Mutation-check each new refusal and rollback assertion by locally breaking the protected behavior and confirming the named test fails, then restore the behavior. Do not commit mutations.
- Do not alter specifications, tracker files, ADRs, or broaden feature scope as part of conformance work.

## User Stories

- 147. As a screen-reader user, I want Remote Status, progress, success, and failure conveyed as text and with appropriate live semantics, so that synchronization is not communicated by color or icons alone.
- 148. As a keyboard user, I want Open, Update, Publish, and confirmation controls operable with predictable focus, so that synchronization does not require a pointer.
- 149. As an author transferring a large Workspace, I want per-file progress and bounded network activity, so that a long operation remains understandable and does not appear frozen.
- 150. As an author using browser storage or a chosen folder, I want the same Import and synchronization behavior, so that the Workspace backing does not change the domain contract.
- 167. As a maintainer, I want any Seam 2 test-count increase recorded with a dated ceiling row and an argument for why the behavior cannot live lower, so that this epic does not bypass the suite-size fence.

## Out of scope

- Do not add new synchronization states, operations, path rules, migration policies, Import behavior, or product UI beyond defects required to satisfy these assigned conformance checks.
- Do not duplicate the core planner matrix in Playwright or add component-only mocks for behavior observable at core or browser seams.
- Do not reach GitHub or any external host, bypass `pnpm test:e2e`, replace the configured Playwright reporter, or use fixed/random ports.
- Do not raise the Seam 2 ceiling without the required dated, behavior-specific justification and profile.

## Acceptance criteria

- [ ] The pre-change Seam 2 size check is recorded in the implementation notes; any increase has exactly one new dated ceiling-table row explaining why each added browser behavior cannot live lower, and `pnpm test:e2e --profile` completes for the resulting suite.
- [ ] Existing Open/Remote conflict/Publish workflows cover one complete six-state lifecycle, Update confirmation/cancel, Conflict refusal, and Publish anyway without duplicating the planner matrix.
- [ ] Browser-storage and chosen-folder workflows produce byte-equivalent committed source files and the same visible status/rollback outcomes for equivalent operations.
- [ ] Core adapter/fault suites prove transaction recovery and evidence behavior for both backings, while browser tests prove only wiring and observable UI behavior.
- [ ] Keyboard-only tests reach and operate every listed control, assert focus after dialogs/Workspace switches, and never leave focus on `body` during long work.
- [ ] Accessibility assertions find visible state/progress/outcome text, polite live semantics for non-urgent updates, alert semantics for inserted failures, and no state whose only distinction is color/icon.
- [ ] Fake transport counters prove bounded concurrent/network activity and per-file progress settles at the actual transferred count for large Open, Update, and Publish fixtures.
- [ ] Mutation checks make every new refusal/rollback test fail when its protected guard or recovery step is removed.
- [ ] The complete repository gate passes after rebuilding artifacts.

Run these commands from the repository root:

```bash
pnpm lint
pnpm --filter @ballastella/core test -- src/remote/open-workspace-from-github.test.ts src/remote/remote-status.test.ts src/remote/update-from-github.test.ts src/remote/update-transaction.test.ts src/remote/synchronization-publish.test.ts src/store/opfs-project-store.browser.test.ts src/store/file-system-access-project-store.browser.test.ts
pnpm -r build
pnpm test:e2e editor-clone-remote editor-remote-conflict editor-publish editor-folder-workspace
pnpm test:e2e --profile
pnpm precommit
```

Success is every command exiting zero; `pnpm lint` reports the suite at or below its justified ceiling, the named core specs pass both backing/fault contracts, targeted Playwright workflows pass from rebuilt artifacts with no external request, the profile is produced, and the full precommit gate remains green.

## Blocked by

- 11-open-a-workspace-from-github.md
- 12-show-remote-status.md
- 14-update-non-destructive-remote-changes.md
- 15-update-deletions-atomically.md
- 16-make-publish-baseline-aware.md
- 20
