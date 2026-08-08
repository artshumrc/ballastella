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

- [x] Opening the app for the first time shows no question about where work is stored.
- [x] The navigation bar names the current Workspace on every screen.
- [x] A second named Workspace can be created, switched to, and found empty; switching back finds the first one's Projects.
- [x] The two Workspaces' Projects are stored under distinct OPFS subdirectories, and neither appears in the other's Project list.
- [x] A named OPFS store passes `packages/core`'s shared adapter suite **with no modification to the suite**, in both Chromium and Firefox.
- [x] Switching Workspaces with a pending autosave flushes it to the Workspace being left, and nothing is written to the one being entered.
- [x] Workspace settings opens from the bar as a `<dialog>` via `showModal()`, closes on Escape, restores focus, and offers the folder choice, the reopen offer, and the install offer.
- [x] An unreachable folder Workspace still shows its recovery immediately on the hub, and never silently falls back to browser storage.
- [x] `navigator.storage.persist()` is requested, and a refusal is reported in settings rather than swallowed.
- [x] Deleting a Workspace confirms first; the open Workspace cannot be deleted.
- [x] Every control is keyboard-reachable.

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

## What was built

Browser-managed storage is a place that holds several named Workspaces. `OpfsProjectStore.open(name)`
descends one level, which is the whole of the store change — **the factory really was the seam**, and
`opfs-project-store.browser.test.ts` runs the shared adapter suite a second time through it, in
Chromium and Firefox, with `git diff` on the suite file empty.

`packages/core/src/store/opfs-workspaces.ts` is the new module: list, ensure, create, delete, open,
and `requestPersistentStorage()`. A Workspace's **name is its directory name**, in both backings —
which is what a folder Workspace already did, and what keeps there from being a second record that
can disagree with the disk. `toWorkspaceName` is deliberately gentle: `Marking 2026` stays
`Marking 2026`, because a bar that says `marking-2026` after the user typed `Marking 2026` has
renamed their work without asking. It is narrow only about characters a filesystem or a path would
choke on, and it is **idempotent**, because `createOpfsWorkspace` suffixes a taken name with ` (2)`
and then normalises again — a normaliser that rewrote its own output would answer "free" about one
string and create another.

On the bar, Workspace identity became a switcher through `MenuPopover` (ADR-0016's mandated Popover
API): the Workspaces, "New Workspace…", and "Workspace settings…". `StorageChoice.svelte` is deleted
and its contents are `WorkspaceSettings.svelte`, a `<dialog>` + `showModal()` carrying the backing,
the folder's name, the folder choice, the reopen offer, the install offer, what the browser said
about persistence, and Workspace deletion with a confirmation naming the Workspace and its size.

## Decisions worth recording

- **Where the recovery lives.** `WorkspaceRecovery` moved *onto* the hub rather than into settings,
  and `ProjectHub`'s own "Workspace not reachable" alert was deleted rather than kept beside it. That
  alert offered "Locate Workspace again", which is only the right recovery for browser storage — for
  a folder Workspace the way back is the picker — and two `role="alert"`s with one meaning is what a
  screen reader reads out twice.
- **`awaitingFolder` no longer renders while there is a `problem`.** The two states overlap exactly
  once and it is the common case: a declined reopen leaves the folder remembered *and* leaves an
  explanation of why it did not open. Both blocks rendered, and the user was handed "your folder is
  not open yet" and "your folder was not opened" together, which say the same thing twice and answer
  nothing between them. Found by `editor-folder-workspace.e2e.ts` going red on a strict-mode
  violation, which is a better reason than taste.
- **"Locate Workspace again" now rebuilds the store rather than re-listing.** `DirectoryHandleStore`
  caches its root handle once it resolves, and that handle is now a *named subdirectory* rather than
  the OPFS root, which cannot vanish. A Workspace deleted by a second tab therefore left a
  permanently dead handle, and the recovery button re-listed through it — a recovery that could not
  recover. `WorkspaceStorage.locateWorkspaceAgain` replaces the session instead.
- **The persistence answer is injectable.** A real browser cannot be made to produce all three
  outcomes — Chromium decides on its own heuristics and Firefox's `persist()` blocks on a permission
  prompt that never appears without a gesture — so a test against the real API can only assert that
  *something* came back, which is the shape of assertion that passes when the function is deleted.
  The three answers are asserted against an injected `StorageManager` in Node; the real call is made
  by the running app, and the browser suite asserts that exactly one of the three sentences appears
  in settings.
- **`e2e/support/test.ts` installs one `workspaceRoot()` in the page.** Some seventy `page.evaluate`
  bodies treated `navigator.storage.getDirectory()` as the Workspace; each would otherwise have grown
  its own `getDirectoryHandle`, which is seventy copies of one fact. The root is still reachable and
  still spelled `navigator.storage.getDirectory()`, which is what the "empty everything" helpers and
  the tests *about* several Workspaces mean — the distinction is now real and the suite says which it
  means.

## The deferral ticket 11 left, discharged

The Base Map tile cache is `base-map/tiles/<key>/{z}/{x}/{y}.mvt`, keyed by the catalog entry's own
`archive` string.

- **The key is derived from `BaseMapEntry.archive` as the catalog writes it, not from the URL a
  deployment resolves it to.** A bundled archive is a deployment-relative path, so the resolved URL
  carries whichever origin the editor happened to be running on — and the same Workspace, published
  and served from somebody else's host, would compute a different key for its own files and find no
  cache at all.
- **The provenance record moved inside the keyed directory**, so deleting the directory deletes the
  claim with it. `cachedTilesMatchArchive` is gone: keying removes the state it existed for, and what
  is left is one function refusing a record that names an archive other than the one asked about,
  rather than a comparison every call site had to remember.
- **The published format changed.** `PublishedSite.baseMapMaxZoom` became `baseMapCaches`, one entry
  per archive with its own depth. A Reader's HTTP store cannot list a directory (ADR-0006), and
  ADR-0020 lets a Reader switch entries, so the viewer has to be *told* which archives the site
  carries tiles for; drawing one archive's tiles under another entry is the wrong-map failure the key
  exists to end. A cache whose provenance record is missing is still served but is not claimed.
- The Project screen now caps its MapLibre source at **this entry's** cached depth
  (`baseMapCacheSizeFor`) rather than the Workspace's deepest cache, since another archive's depth
  there is a map that goes blank above the zoom this one actually covers.

## The mutation checks, and the one that mattered

Four were run. The third is the reason the ticket's own advice about the save indicator was not
enough on its own.

1. **`baseMapArchiveKey` returning a constant** — `tile-cache.test.ts`'s "gives two archives two
   directories" and `publish.test.ts`'s "names which archives it carries tiles for" both go red.
2. **`OpfsProjectStore.open(name)` ignoring `name`** — 32 browser tests go red, including the whole
   second run of the shared adapter suite and both containment tests.
3. **`leaving.flush()` deleted from `WorkspaceStorage.#adopt`** — **green, twice, before it was
   red.** The first cut typed a Project name and switched Workspaces as fast as Playwright can, on
   the theory that 400 ms is a long time; the debounce had already fired on its own, so the test
   asserted that the bytes were in the right place — which they were — and nothing at all about the
   flush that was supposed to put them there. Swallowing the 400 ms timer was still not enough: the
   Project name field commits on `blur`, and closing the settings dialog blurs it. It is now a
   dragged opacity slider, where `oninput` queues and only `onchange` commits, so an `input` event
   alone leaves a write that nothing but the flush can land. With the flush deleted the test fails on
   the byte assertion; with it restored it passes.
4. **The delete guard removed from `WorkspaceSettings`** — all four deletion tests go red.

**One guard is deliberately not covered end to end**, and saying so is better than implying it is:
`WorkspaceStorage.deleteWorkspace` throws when asked for the Workspace that is open, and the settings
list never offers it, so the throw is unreachable from the UI. It is defence in depth against a later
caller, in the shape ticket 18 recommends, and it has no test of its own.

## Two things found while building it

- **The hub carried a second "Workspace not reachable" alert** with a recovery that only works for
  browser storage. See above; `ProjectHub`'s branch is now a plain sentence about the *list*, which
  is that component's own subject.
- **A named OPFS Workspace can vanish under a running app, and the root could not.** That is a new
  state rather than a regression, and it is the same state ADR-0008 already describes for a folder —
  but the store caches its root handle, so the existing recovery was inert against it. Fixed above,
  and the e2e "empty everything" helpers now *empty* the open Workspace rather than removing it, so
  the harness stops creating a state the product cannot be in.
