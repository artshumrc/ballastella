# A Workspace is bound to a Remote

## What to build

A Workspace can be bound to one GitHub repository — its **Remote** — from the Workspace menu, and a
credential can be supplied by pasting a fine-grained personal access token. Binding checks, there and
then, whether the credential can actually push to that repository, and offers to turn Pages on.

Nothing publishes yet. What this slice delivers is: *the app knows which repository this Workspace belongs
to, knows whether it may write there, and holds a credential for the length of the tab.*

A Review Workspace can never be bound, and no credential is readable while one is open. A restored Backup
and an opened Project Bundle both arrive **unbound**.

## Where to start

- `apps/editor/src/lib/components/NavigationBar.svelte`, the `MenuPopover` block around
  `data-testid="workspace-switcher"`. The "Folder on this computer" section is the shape to follow: a
  `menu-title` heading and buttons beneath it. Read the comment above it explaining why real clicks matter
  for `showDirectoryPicker()` — the same transient-activation rule applies to nothing here, but the
  `fromMenu(…)` wrapper and focus-return pattern do.
- `apps/editor/src/lib/workspace-storage.svelte.ts` — `WorkspaceBacking` is `'browser' | 'folder'` and
  **must stay a two-member union**. Read `#adopt`, `restoreFrom`, `openBundle`, and the `review` /
  `reviewWorkspaces` state. The binding is orthogonal to backing; it is not a third member.
- `packages/core/src/project/review-workspace.ts` — `REVIEW_MARK_PATH` is `review.json` at the Workspace
  root, with a `formatVersion` and a tolerant reader. `remote.json` is the same shape and the same
  precedent; copy it.
- `apps/editor/src/lib/components/WorkspaceSettings.svelte` — for how a Workspace-scoped destructive
  action is presented, if you decide unbind lives there.
- `docs/adr/0033-a-publish-mirrors-an-owned-namespace.md`, the consequences list — the credential rules
  are stated there.

`e2e/editor-named-workspaces.e2e.ts` and `e2e/editor-workspace.e2e.ts` are the closest prior art for
driving the Workspace menu. `e2e/editor-transfer.e2e.ts` covers restore and bundle-opening.

## Contract

**`remote.json` at the Workspace root**, the binding and nothing else:

```jsonc
{ "formatVersion": 1, "owner": "…", "repository": "…", "branch": "main" }
```

It is deliberately *inside* the published tree — the binding never changes, so it causes no churn, and a
Clone (ticket 07) learns its own Remote for free. Its reader is tolerant in the same way `readReviewMark`
is: unreadable or absent means unbound, never a thrown error at startup.

**The credential lives behind its own interface, outside `ProjectStore`, and is never reachable through
it.** `sessionStorage` is the first implementation, not the contract — a durable "remember me" may replace
it later, so nothing may assume session scope beyond the interface. What must hold for *any*
implementation: the token cannot reach the write-ahead journal, `ballastella-site.json`, a Backup tar, or a
Project Bundle. `export-workspace-tar.ts` walks the store, so a token stored in the Workspace would be
backed up and mailed to a colleague.

**Two hard refusals, each with a test:**

1. A Review Workspace cannot be bound. Not "the menu item is hidden" — a refusal in the domain package, so
   no other route can reach it. ADR-0024: publishing somebody else's Project to your own address is
   promotion by another route, and a worse one.
2. While a Review Workspace is open, the credential store reads and writes nothing.

**Binding drops on the way in, not on the way out.** `restoreFrom` and `openBundle` produce an unbound
Workspace. A restored Backup carrying `remote.json` must not leave the user with a Publish button aimed at
a live, cited address.

**Rights are checked at bind.** `GET /repos/{owner}/{repo}` reports `permissions.push`. If it is false,
say so plainly and still allow the binding — the binding is provenance, not permission, and a reader who
cloned somebody's Workspace has a legitimate unbound-but-provenanced state. What must **not** happen is
discovering the refusal after an upload.

**Pages enablement is attempted, and its failure is a sentence, not an error.** `POST
/repos/{owner}/{repo}/pages` with `source: { branch: "main", path: "/" }` needs only `Pages: write`. A
`409` means already enabled — success. Anything else means show the instruction: which setting, where,
and what to choose. `docs/hosting.md` Part 2 step 3 has the wording today.

**Repository creation is not in this ticket and is not being argued against** — the user may return to it.
Offer a link to `https://github.com/new` with the name prefilled and say what to do.

### User Stories

4, 5, 6, 7, 8, 30, 31, 34, 35, 36, 37, 38, 39, 40, 41, 42.

## Out of scope

- **No Publish button and no upload.** Ticket 04. This ticket ends at "bound, with a credential."
- **No OAuth, no GitHub App, no broker.** Ticket 10. The credential interface must be shaped so ticket 10
  is an addition behind it, but do not build the second implementation.
- **No `localStorage` or IndexedDB for the token.** SPEC "Out of scope" item 9.
- **Do not add a third member to `WorkspaceBacking`.** A third member means a new case in `#adopt`, the
  journal keys, the switcher, `reopenable`, `canChooseFolder`, and `discard` — six sites where a mistake in
  the journal key is silent. ADR-0032 says this explicitly.
- **No conflict or subset check at bind.** Ticket 05 adds it. Binding here checks *rights*, not contents.
- **No editor gating.** Anyone may load the editor; there is nothing to gate. SPEC "Out of scope" item 10.
- **No repository creation** via the API.

## Acceptance criteria

- [ ] A Workspace can be bound from the Workspace menu, and the binding survives a reload.
- [ ] The bound Remote is visible in the navigation bar alongside the signed-in identity.
- [ ] A pasted token is validated on entry; a malformed or rejected one is refused with a message and not
      stored.
- [ ] Binding a repository the credential cannot push to says so, and the binding still succeeds.
- [ ] Pages is enabled on bind when permitted; a `409` is treated as success; any other failure shows the
      manual instruction naming the setting.
- [ ] A `browser` Workspace and a `folder` Workspace can each be bound, with no branch on backing in the
      binding code.
- [ ] `WorkspaceBacking` still has exactly two members.
- [ ] Binding a Review Workspace is refused by the domain package, asserted by a unit test that calls the
      refusal directly rather than through the UI.
- [ ] With a Review Workspace open, the credential store neither reads nor writes.
- [ ] Restoring a Backup whose tar contains `remote.json` yields an **unbound** Workspace.
- [ ] Opening a Project Bundle yields an **unbound** Review Workspace.
- [ ] Signing out clears the credential; a reload after sign-out has none.
- [ ] A first visit shows no sign-in affordance anywhere.

```
pnpm --filter @ballastella/core test
pnpm test:e2e editor-remote-binding
pnpm test:e2e editor-transfer
pnpm check
pnpm lint
```

Run e2e specs by name, never by file:line. Success: the new spec passes and `editor-transfer` still does.

## Blocked by

- Ticket 02
