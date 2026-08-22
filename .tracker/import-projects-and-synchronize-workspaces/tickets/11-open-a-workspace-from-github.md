# 11 - Open a Workspace from GitHub

## What to build

Replace the user-facing Clone flow with Open a Workspace from GitHub while retaining the shipped `clone` invitation parameter. Opening a public repository must either return to this installation's already-synchronized Workspace or create, validate, and adopt one new browser-backed Workspace, then persist the selected Remote and complete initial Synchronization Baseline only after all source content is valid and durable.

## Where to start

- `packages/core/src/remote/clone-from-remote.ts` is the current anonymous, resumable download engine. Its owned-namespace filtering, blob-SHA verification, quota preflight, progress, and write-manifest-last ordering are valuable, but its binding and duplicate-Workspace behavior must change.
- `packages/core/src/remote/clone-from-remote.test.ts` covers resume, truncation, invalid bytes, and observable downloaded files at the engine seam.
- `apps/editor/src/lib/workspace-storage.svelte.ts` owns `cloneFrom`, destination creation, Workspace switching, and session adoption.
- `apps/editor/src/lib/components/RemoteSettings.svelte` and `apps/editor/src/lib/components/ReturnLinkOffer.svelte` contain the visible Clone vocabulary, forms, progress, and invitation acceptance.
- `packages/core/src/remote/return-link.ts` must continue parsing/building `?clone=owner/repository` even though the operation is now called Open.
- `e2e/editor-clone-remote.e2e.ts` is the existing complete browser workflow; update its descriptions/expectations rather than duplicating it under a new spec.
- Ticket 01 supplies durable Remote/Baseline/reverse-lookup metadata; tickets 02, 09, and 10 supply source inventory, validation/planning, and managed-write evidence.

## Contract

- Use “Open a Workspace from GitHub” in user-facing headings, buttons, progress, outcomes, errors, and guidance. Do not expose “Clone” as product vocabulary.
- Preserve `?clone=owner/repository` in the shared return-link builder, parser, and cleanup path so existing and newly published links use one compatible URL shape.
- Normalize the selected repository/branch before lookup. Within one installation, an atomic repository-to-Workspace lookup returns at most one synchronized ordinary Workspace. Reopening selects that Workspace; it does not download into or create a duplicate.
- Repository uniqueness is installation-local. Another browser/device has independent metadata and may open its own Workspace and Baseline.
- Public Open sends no credential and remains available while signed out. A credential already held in the tab must not be attached to anonymous tree/raw requests.
- The repository selected by the author or invitation determines the local Remote. Ignore stale binding/return metadata downloaded from the repository.
- Create a new browser-backed Workspace only after tree/truncation/quota preflight. Preserve resumable partial download support, but do not publish/adopt the Workspace, install its Remote lookup, or establish a Baseline until every selected source file is fetched, SHA-verified, and the complete prospective Workspace graph validates.
- An invalid, incomplete, unsupported, or graph-broken Remote is refused before adoption. Existing Workspaces and installation metadata remain unchanged. A partial resumable destination remains unavailable as synchronized work until a later successful resume.
- On success, persist the installation-local Remote, complete source-path Baseline, and reverse lookup atomically with adoption. The Baseline describes verified source paths/SHAs at the selected commit, not merely everything a tree listing claimed.
- Opening an equal existing synchronized Workspace is idempotent and selects it without replacing local-only work or advancing its Baseline from a fresh listing.
- Continue per-file progress and bounded request behavior. Keep repository files outside Ballastella's namespace out of the Workspace.
- Review Workspaces remain unbindable/unpublishable; invoking Open while reviewing may create/select an ordinary Workspace but must not turn the review into one.

## User Stories

- 96. As an author, I want the Workspace-level action called Open a Workspace from GitHub rather than Clone, so that Ballastella does not promise Git behavior.
- 97. As a signed-out author, I want to open a public Workspace from GitHub without authenticating, so that public work remains readable.
- 98. As an author, I want Open a Workspace from GitHub to create a named local Workspace when none is bound to that repository, so that unrelated local work is untouched.
- 99. As an author, I want Open to establish a Synchronization Baseline only after the complete Workspace is valid, so that later drift has trustworthy evidence.
- 100. As an author, I want opening the same repository again to return to its existing local Workspace, so that one installation does not create competing synchronized copies.
- 101. As an author, I want one Ballastella installation to keep at most one synchronized Workspace for a repository, so that local duplicates cannot unknowingly publish over each other.
- 102. As an author using another machine, I want that installation to hold its own synchronized Workspace and Baseline, so that the same Remote can support deliberate cross-machine work.
- 103. As an author, I want an invalid or incomplete Remote refused before a local Workspace is adopted, so that Open cannot present a partial copy as usable.
- 104. As an author, I want an interrupted Open to preserve existing Workspaces and resume safely where supported, so that a large transfer does not damage local work.

## Out of scope

- Do not add Project Import or change the `review` invitation's Project offer.
- Do not implement persistent Remote Status UI or automatic polling; ticket 12 owns it.
- Do not add Update or alter existing synchronized Workspace bytes when reopening; tickets 14 and 15 own inbound changes.
- Do not support private repositories or send credentials on Open.
- Do not rename the shipped query parameter or add a second Open-specific parser/builder.

## Acceptance criteria

- [ ] Core tests prove anonymous Open creates one complete Workspace, validates all source content, records the selected Remote and verified complete Baseline only after success, and excludes published output/outside files according to ticket 02.
- [ ] Reopening the normalized same repository selects the same stable Workspace identity with unchanged local files/Baseline and creates no second directory; concurrent/repeated lookup attempts cannot create two active bindings.
- [ ] Invalid graph, unsupported format, truncated tree, corrupt blob, quota refusal, and interrupted transfer leave existing Workspaces and synchronization metadata unchanged; a supported retry skips already verified bytes and completes safely.
- [ ] Browser tests contain no visible Clone vocabulary, offer Open from settings and the legacy invitation URL, require no sign-in, switch only after success, and show the same Workspace name/identity on a second Open.
- [ ] Tests prove a stale repository `remote.json` or published return-link repository cannot redirect the active Remote away from the repository selected for Open.
- [ ] Per-file progress is visible and politely announced, controls remain keyboard operable while busy, and refusal focus remains within or returns to the initiating surface.

Run these commands from the repository root:

```bash
pnpm --filter @ballastella/core test -- src/remote/open-workspace-from-github.test.ts src/remote/clone-from-remote.test.ts src/remote/return-link.test.ts
pnpm -r build
pnpm test:e2e editor-clone-remote viewer-reader
pnpm precommit lint check test
```

Success is all commands exiting zero; the browser workflow says Open rather than Clone while accepting `?clone=...`, a second Open returns to the same Workspace, public reads carry no credential, and every failed/incomplete case leaves no adopted binding or Baseline.

## Blocked by

- 01-establish-installation-local-sync-evidence.md
- 02-separate-sync-source-from-published-output.md
- 09-plan-workspace-synchronization.md
- 10-track-local-changes-without-rehashing.md
