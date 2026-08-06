# The OPFS root holds several named Workspaces

## What to build

Browser-managed storage stops being one Workspace and becomes a place that holds several, each named. The navigation bar says which one you are in and lets you move between them. Where your work is stored stops being the first question the application asks, and becomes a setting.

Demonstrable end to end: open the app and land on the hub with no storage question in sight; the bar names your Workspace; create a second Workspace and switch to it, finding it empty; switch back and find your Projects.

Read [ADR-0024](../../../docs/adr/0024-backup-and-handoff-are-different-artefacts.md)'s consequences and the amendment note now at the head of [ADR-0001](../../../docs/adr/0001-opfs-first-project-store.md).

## Where to start

- `packages/core/src/store/opfs-project-store.ts` — 30 lines. `OpfsProjectStore.open()` passes `() => navigator.storage.getDirectory()` to `DirectoryHandleStore`. **The factory is already the seam**: a named Workspace is a factory returning `getDirectoryHandle(name, { create: true })`. The class barely changes.
- `packages/core/src/store/directory-handle-store.ts` — shared by OPFS and the picked-folder backend, which is why one interface serves both.
- `packages/core/src/store/file-system-access-project-store.browser.test.ts` — the shared adapter suite. **It ran unchanged when the File System Access adapter landed**, and that is the outcome to reproduce here: a named-subdirectory OPFS store passes the same suite with no edits to the suite.
- `apps/editor/src/lib/workspace-storage.svelte.ts` — `WorkspaceStorage`. Read the class comment: switching backends **replaces** the session rather than repointing it, because an `EditorSession` holds one `Autosave` bound to one store and queued bytes must not be addressed to a Workspace the user has left. Switching named Workspaces is the same operation.
- `apps/editor/src/lib/components/StorageChoice.svelte` — 91 lines, currently a permanently visible hub section headed "Where your work is stored". It moves.
- `apps/editor/src/lib/components/WorkspaceRecovery.svelte` — the unreachable-folder recovery. It stays reachable.
- `apps/editor/src/lib/pwa/InstallOffer.svelte` — currently nested inside `StorageChoice`; it moves with it.
- `packages/core/src/project/workspace.ts` — `listProjects` matches only top-level `<dir>/project.json`, which is why a nested Workspace is invisible in a Project list.

## Contract

**Browser-managed storage holds named Workspaces.** The OPFS root is no longer itself a Workspace. Without this, ticket 14's Review Workspaces would be subdirectories *of* the user's own Workspace — invisible to `listProjects`, but counted in its size and swept into its backup.

**A named OPFS Workspace passes the existing shared adapter suite with no change to the suite.** If the suite needs editing, the abstraction has been broken rather than extended.

**Switching Workspaces replaces the session** — flush, teardown, new session, in that order. Never repoint a live store.

**Workspace identity lives in the navigation bar** (ticket 04 put a label there; this makes it a switcher). It must always be visible, because from ticket 14 onward a user can be inside a throwaway Workspace and must never be in doubt.

**Where work is stored moves out of first contact into Workspace settings**, reached from the bar. Browser storage is the silent default. This is what ADR-0001 always implied — "a folder Workspace is a capability upgrade and never a gate" — and the hub asked the question anyway. The settings dialog carries: which backing is in use, the folder's name when there is one, the offer to choose a folder, the offer to reopen a remembered one, and the install offer.

**An unreachable Workspace is still surfaced immediately, not hidden in settings.** A moved, renamed, or deleted folder is a normal state with a recovery (ADR-0008), and it must never fall back to browser storage without saying so — a Workspace that quietly became browser storage looks exactly like the tool having lost the user's folder.

**Reopening a folder still requires a user gesture.** `requestPermission()` needs transient activation; called automatically on load it fails silently and the app looks as though it has lost the folder.

**`navigator.storage.persist()` is requested.** It is called nowhere in the tree today, so OPFS data is best-effort and evictable under disk pressure. That was tolerable when browser storage was a starter store; it is not, now that it is the primary home for a shared pool of gigabyte pyramids. Request it, and record what the browser answered — a refusal is worth telling the user about in settings, not swallowing.

**Deleting a Workspace is possible from settings and confirms**, through `<dialog>` + `showModal()` (ADR-0016), naming the Workspace and its size. The Workspace currently open cannot be deleted from under itself.

## Out of scope

- **Do not build backup, restore, tar, bundles, or Review Workspaces.** Tickets 13 and 14. This slice is only that several named Workspaces can exist and be moved between.
- **Do not change the folder-backed path's behaviour.** A picked folder is still one Workspace; naming applies to browser storage. A folder Workspace's name is the folder's name, as now.
- **Do not migrate an existing OPFS Workspace** from the root into a named subdirectory. Nothing is deployed; delete your development data.
- **Do not remove `WorkspaceRecovery`** or move the unreachable state into settings.
- **Do not change `DirectoryHandleStore`'s byte path.** If you are editing how bytes are written, you have gone too far.
- **Do not add a Workspace-level rename** unless it falls out for free; it is not asked for.

## Acceptance criteria

- [ ] Opening the app for the first time shows no question about where work is stored.
- [ ] The navigation bar names the current Workspace on every screen.
- [ ] A second named Workspace can be created, switched to, and found empty; switching back finds the first one's Projects.
- [ ] The two Workspaces' Projects are stored under distinct OPFS subdirectories, and neither appears in the other's Project list.
- [ ] A named OPFS store passes `packages/core`'s shared adapter suite **with no modification to the suite**, in both Chromium and Firefox.
- [ ] Switching Workspaces with a pending autosave flushes it to the Workspace being left, and nothing is written to the one being entered.
- [ ] Workspace settings opens from the bar as a `<dialog>` via `showModal()`, closes on Escape, restores focus, and offers the folder choice, the reopen offer, and the install offer.
- [ ] An unreachable folder Workspace still shows its recovery immediately on the hub, and never silently falls back to browser storage.
- [ ] `navigator.storage.persist()` is requested, and a refusal is reported in settings rather than swallowed.
- [ ] Deleting a Workspace confirms first; the open Workspace cannot be deleted.
- [ ] Every control is keyboard-reachable.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
pnpm --filter @ballastella/core test
pnpm exec playwright test e2e/editor-workspace.e2e.ts e2e/editor-folder-workspace.e2e.ts e2e/editor-pwa.e2e.ts
pnpm test:e2e
```

All green. The adapter-suite criterion is the load-bearing one: `git diff` on the suite file must be empty.

For the flush criterion, assert on bytes in each Workspace, not on the save indicator's text — the indicator can say "Saved" while the bytes went somewhere else, which is precisely the ticket-12 bug `WorkspaceStorage`'s comment records.

## Blocked by

- Ticket 04
