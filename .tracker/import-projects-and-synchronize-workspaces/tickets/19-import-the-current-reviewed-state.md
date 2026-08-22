# 19 - Import the current reviewed state

## What to build

Let a reviewer deliberately import the Project as it exists now in a Review Workspace into the
specific ordinary Workspace from which review began. Record that destination as stable Review
metadata, use the shared detached-copy engine, switch to and identify the imported Project after a
durable commit, and discard the Review Workspace only after every preceding step succeeds.

If the recorded destination cannot be reopened, refuse without choosing or creating another
Workspace and preserve the reviewed state for retry.

## Where to start

- Ticket 03's read-only Review Workspace source, tickets 04 through 08's shared Import behavior, and
  ticket 13's ordinary-Workspace result handling.
- `packages/core/src/project/review-workspace.ts`: `ReviewMark`, tolerant parsing, serialization, and
  old-mark behavior. Extend this metadata without making it a local Remote or writable destination.
- `apps/editor/src/lib/workspace-storage.svelte.ts`: `openBundle`, `reviewFrom`,
  `#makeReviewDestination`, `ownWorkspaceName`, `ownFolderName`, `leaveReview`, `discardReview`, and
  `#adopt`. The existing last-used-own-Workspace slots are not a stable Review destination.
- The installation-local stable Workspace identity/backing metadata supplied by ticket 01. Reuse the
  same identity for browser and folder backings rather than inventing a Review-only name lookup.
- `packages/core/src/store/workspace-folder.ts`: remembered folder handles, permission renewal, and
  the distinction between a named folder and the capability to reopen that exact folder.
- `apps/editor/src/lib/components/ReviewBanner.svelte`: persistent Review context and its current two
  exits. Add the Import action here with explicit current-state and discard-after-success language.
- `apps/editor/src/routes/+page.svelte`: navigate to the imported Project through its allocated
  directory after switching to the recorded destination.
- Existing workflows in `e2e/editor-transfer.e2e.ts`, `e2e/editor-review-remote.e2e.ts`, and
  `e2e/editor-folder-workspace.e2e.ts`; add the core metadata/source matrix in
  `packages/core/src/transfer/project-import-review.test.ts`.

## Contract

When Review begins from an ordinary Workspace, write into the Review mark a stable origin locator
containing the ordinary Workspace's installation-local identity and backing. For a chosen folder,
retain the installation-local handle/capability reference needed to ask for that exact folder again;
the display name alone is not identity. Also retain directly observed source evidence required for
the current transfer's provenance.

The locator is immutable for the life of the Review Workspace. Switching among ordinary Workspaces
after Review began must not redirect it. Older Review marks with no origin remain reviewable,
editable, discardable, unpublishable, and unbindable, but Import is refused until an explicit ordinary
destination can be recorded; do not infer one from the current or last-used Workspace.

The Review banner action must say both consequences before confirmation:

- it imports the **current reviewed state**, including edits made inside the Review Workspace;
- the Review Workspace is discarded only after successful Import and return to the destination.

On confirmation:

1. Resolve and reopen the recorded ordinary Workspace by stable identity and backing.
2. If it was deleted, replaced under the same name, is unreachable, or folder permission cannot be
   regained, refuse and leave the Review Workspace open and byte-identical.
3. Read the current Review Project through the read-only source boundary, not the original Bundle or
   GitHub source.
4. Run the same fresh-identity, allocation, publication-reset, provenance, quota, and atomic-commit
   behavior as every other Import.
5. After commit succeeds, switch to the recorded destination and open or focus the imported Project.
6. Only after the destination and imported result are established, delete the Review Workspace and
   its local metadata.

If Import, switching, navigation, or Review deletion fails, do not falsely report complete success.
Before the commit, preserve both Workspaces. After a successful commit but failed Review cleanup,
preserve the committed Project and report that the Review copy still needs discarding; never roll back
durable owned work by deleting it.

Review Workspaces remain isolated, editable, unpublishable, unbindable, and unable to Update. The
Import engine remains the sole structural crossing into owned work.

## User Stories

- **81.** As a reviewer, I want a Review Workspace to remain isolated from my ordinary Workspace, so that examining work cannot change mine.
- **82.** As a reviewer, I want the persistent Review banner to remain visible, so that I cannot forget I am in throwaway storage.
- **83.** As a reviewer, I want Import into my Workspace available from the Review banner, so that I can keep the state I have examined.
- **84.** As a reviewer, I want that action to state that it imports the current reviewed state, so that edits made during review are not mistaken for the original source.
- **85.** As a reviewer, I want that action to state that the Review Workspace will be discarded after success, so that its lifecycle is clear.
- **86.** As a reviewer, I want a successful review Import to return to the specific ordinary Workspace recorded when review began, so that a later Workspace switch cannot redirect the copy.
- **87.** As a reviewer, I want a successful review Import to open or identify the imported Project, so that I can find the copy immediately.
- **88.** As a reviewer, I want the Review Workspace discarded only after Import commits, so that a failed copy cannot destroy the reviewed state.
- **89.** As a reviewer, I want a failed or canceled review Import to leave the Review Workspace available, so that I can retry or leave normally.
- **90.** As a reviewer, I want review Import to use fresh Map Image identities and append provenance, so that it follows the same detached-copy rules as every Import.
- **91.** As a reviewer, I want Review Workspaces to remain unpublishable and unbindable, so that Import is the only deliberate route into owned work.
- **162.** As a reviewer, I want Review metadata to record the stable identity and backing of the ordinary Workspace review began from, so that Import has one explicit destination.
- **163.** As a reviewer, I want Review Import refused without discarding the review when its recorded destination was deleted or cannot be reopened, so that Ballastella neither loses reviewed work nor guesses another Workspace.

## Out of scope

- Do not import the original source state after the reviewer has edited the copy.
- Do not use the installation's current Workspace, last-used Workspace, or a matching display name as
  fallback destination.
- Do not create a replacement ordinary Workspace when the recorded destination is unavailable.
- Do not make Review Workspaces publishable, bindable, synchronizable, or part of ordinary backup.
- Do not add a route that lets source readers write directly to the ordinary destination.
- Do not discard the Review Workspace before commit and destination adoption succeed.

## Acceptance criteria

- [ ] Bundle and GitHub Review creation record the exact ordinary origin's stable identity and backing,
      and later Workspace switches do not alter it.
- [ ] The persistent banner offers Import and states current reviewed state plus discard-after-success
      before confirmation.
- [ ] Edits made in Review are present in the imported Project; fresh Map Image identities and appended
      Review provenance follow the shared engine rules.
- [ ] Success returns to the recorded browser or folder Workspace, opens or focuses the imported
      Project, and only then removes the Review Workspace.
- [ ] Cancel, source failure, quota refusal, transaction failure, missing destination, replacement under
      the same name, and denied folder permission preserve the Review Workspace and reviewed bytes.
- [ ] Older Review metadata remains reviewable but cannot Import by guessing a destination.
- [ ] Publish, bind, Update, and credential access remain structurally refused in every Review
      Workspace.
- [ ] Browser assertions are consolidated into the three existing Review/folder workflows; any Seam 2
      ceiling increase includes the required dated lower-seam argument.

```bash
pnpm --filter @ballastella/core test -- project-import-review
pnpm --filter @ballastella/core test -- review-workspace
node scripts/check-seam-2-size.mjs
pnpm test:e2e editor-transfer
pnpm test:e2e editor-review-remote
pnpm test:e2e editor-folder-workspace
pnpm precommit
```

Success: all seven commands pass; tests edit the Review copy before Import, switch ordinary
Workspaces, prove the recorded origin receives the detached result, and prove every failure leaves the
Review Workspace available with identical bytes.

## Blocked by

- 01
- 03
- 04
- 05
- 06
- 07
- 08
- 13
