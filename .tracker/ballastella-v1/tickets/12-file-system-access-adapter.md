# 12 — File System Access adapter

## What to build

On a Chromium desktop browser, a user clicks "Choose Workspace folder," picks a real directory, and their Projects live there — visible in Finder or Explorer, backed up by Dropbox, committable to git. On returning, the Workspace is already open.

Everywhere else, nothing changes: OPFS remains the backend and the option is simply absent.

**Fulfills** — [SPEC.md](../SPEC.md) user stories 1, 2, 3, and 7 (the folder-moved case; ticket 02 covers the unreachable-store case). With ticket 02: 4 — where the API is absent the option is absent, and OPFS keeps working. Story 6 is the remedy for this ticket's permission friction and lands in ticket 18.

## Where to start

[ADR-0001](../../../docs/adr/0001-opfs-first-project-store.md) (this is the capability upgrade it describes), [ADR-0008](../../../docs/adr/0008-projects-live-in-a-workspace.md) (one grant covers every Project; unreachable workspace is a normal state), [ADR-0017](../../../docs/adr/0017-autosave-semantics.md) (this backend's write path differs from OPFS).

The `ProjectStore` interface and its shared adapter test suite come from ticket 02.

## Contract

A third `ProjectStore` adapter over `showDirectoryPicker()`. **It must pass ticket 02's existing shared adapter suite unchanged** — if it needs the interface widened, that is a signal the interface was shaped around OPFS and the fix belongs in the interface, not in a special case.

Browser support is Chromium desktop only: **Firefox has declared the API "harmful" and will not ship it, Safari desktop and iOS do not support it, and Chrome on Android does not.** Roughly 28% of global browser usage. Detect and degrade — never gate the app behind it. This is the entire reason ADR-0001 built OPFS first.

**The workspace is granted once and every Project inside it is reachable** (ADR-0008). Do not request per-Project handles; that reintroduces the prompt-per-Project friction the workspace model exists to remove.

Persistence across visits: store the `FileSystemDirectoryHandle` in **IndexedDB**, and call `requestPermission()` on return. True no-prompt persistence requires **Chrome 122+** and works best for an **installed PWA** — which is why ticket 18 exists and why "install this app" is the honest answer to "why does it keep asking about my folder?" (ADR-0012).

`requestPermission()` generally needs transient user activation, so the resume path must be **a user gesture, not an automatic call on load**. An automatic call fails silently and the app appears to have lost the folder.

Error states, all of which are **normal states with recoveries**, not exceptions (ADR-0008):

| State | Behaviour |
|---|---|
| Permission declined | Explain and offer to pick again; do not silently fall back to OPFS and appear to lose their work |
| Folder moved, renamed, or deleted | "Workspace not reachable" with a locate-again affordance |
| User picks a folder containing an unrelated project | Accept it; a workspace is any directory |

**Writes differ from OPFS.** OPFS's reliable fast path, `FileSystemSyncAccessHandle`, is Worker-only; here writes go through `createWritable()`, async and page-context (ADR-0017). ADR-0017's atomic write rule still applies: **temp file, then rename** — `project.json` must never be left torn.

Switching between an OPFS workspace and a folder workspace must not lose the OPFS one. A user who tries the folder option and changes their mind still has their earlier Projects.

## Out of scope

- **Zip import/export** — ticket 13. That is the cross-browser path in and out; this is a different mechanism.
- **Any change to how Projects are laid out on disk.** Identical layout to OPFS; that is the point of the abstraction.
- **A service worker reading through this backend.** ADR-0011 rejects it specifically because handle permissions inside a service worker are murky — and this is the backend where that risk lands.
- **Migrating existing OPFS Projects into the chosen folder.** Copy-in is a plausible later feature; do not build it.
- **Prompting users to switch.** Offer the capability; do not nag.

## Acceptance criteria

- [x] On Chromium desktop, choosing a folder makes it the Workspace, and Projects created there appear as real files with the layout ADR-0008 specifies
- [x] The adapter passes ticket 02's shared adapter test suite **with no changes to the suite**
- [x] On a browser lacking the API, the option is absent and OPFS continues to work with no error
- [x] One grant covers every Project in the workspace — no second prompt when switching Projects
- [x] The handle is persisted in IndexedDB and the Workspace resumes on return, via a user gesture rather than an automatic call
- [x] Declining permission produces an explanation and a way to retry — not a silent fallback
- [x] A workspace whose folder has been moved or deleted shows "Workspace not reachable" with a locate-again action
- [x] An interrupted `project.json` write leaves the previous contents intact and parseable
- [x] Switching to a folder workspace and back leaves the OPFS workspace's Projects intact
- [x] A Project created in a folder workspace can be read by the OPFS adapter after being copied in by hand — proving the layout is backend-independent

```bash
pnpm --filter @ballastella/core test    # shared adapter suite runs against all three adapters
pnpm test:e2e                    # Chromium file-picker flow, resume, decline, unreachable
pnpm -r build && pnpm lint && pnpm check
```

Success: all exit 0. Playwright must grant and revoke the file-system permission to cover the decline and unreachable paths — these cannot be tested outside a real browser, which is why SPEC's Seam 2 exists.

## Blocked by

- Ticket 02

## Implementation notes

Recorded on completion. Status in `TRACKER.md` is the orchestrator's to set; this ticket needs
no human decision, but the last note below is worth one human minute before release.

### The shared adapter suite needed no widening

Nothing about the *interface* changed for this backend, because there was nothing to widen: a
picked `FileSystemDirectoryHandle` and the OPFS root are the *same interface*. So the byte path
was extracted into `store/directory-handle-store.ts` and both backends now inherit it —
`OpfsProjectStore` keeps only `open()` and `isSupported()`, and `FileSystemAccessProjectStore`
adds only the folder's name and handle. ADR-0001's bet paid off exactly as written.

The suite did gain one *case* on review, which is a different thing from widening the interface:
`.crswap`. Chromium's `createWritable()` writes a visible swap file beside its destination, so a
crash during the first step of an atomic write leaves `<name>.ballastella-tmp.crswap` — which did
not end in `TEMP_PATH_SUFFIX`, so `isTempPath` missed it, `list` reported it **as project data**,
and `reclaimAbandonedWrites` — written for exactly this — could not remove it. It then rode into a
zip on export and on into a colleague's Workspace, and tickets 15 and 16 would have counted it in
their size totals. The predicate now matches the reserved suffix with or without one further
extension, and import refuses an entry claiming either. Planted rather than provoked in the suite,
because only one backend writes one and every backend owes the same answer about it; the
*exception* path is asserted for real in `e2e/editor-folder-workspace.e2e.ts`, and the crash path
is what nothing in CI can stage.

Two of ticket 02's files did move, neither in what it asserts:

- `opfs-project-store.ts` lost its body to `directory-handle-store.ts`.
- `opfs-project-store.browser.test.ts` now imports its fixture from
  `store/directory-handle-fixture.ts` instead of declaring it inline. Same fault injection, same
  assertions; the FSA suite needs the identical injection, and the alternative was duplicating
  sixty lines of it.

### The grant is deliberately not in the store

`store/workspace-folder.ts` owns the picker, the permission query, and the IndexedDB persistence.
A store that checked permission per operation would put a possible dialog inside autosave and
reintroduce the prompt-per-Project friction ADR-0008's workspace model exists to remove. The
handle goes in IndexedDB because it is the only browser storage that will hold one — it is
serialisable but not stringifiable, so `localStorage` cannot.

The recalled handle is **held in memory once read**, and that is about the activation budget rather
than about speed. A gesture's transient activation is spent by time as well as by use, and
`reopenWorkspaceFolder` used to open IndexedDB and wait for a transaction *between* the user's click
and the one call that needs to be next to it. `rememberedFolderName()` already fetches the same
handle on load — safe there, because reading IndexedDB prompts for nothing — so keeping it makes the
gesture path synchronous up to `requestPermission()` for nothing.

### One Workspace, and the routes that have to agree about it

The Workspace is created in `routes/+layout.svelte` and read from Svelte context by every route
(`WorkspaceHost`). This is not tidiness: `/base-map/+page.svelte` used to call
`EditorSession.opfs()` directly while `/` went through `WorkspaceStorage`, so a folder-Workspace
author's Base Map choice was written into the *OPFS* Project of the same name — a state the folder
e2e deliberately creates — with a fresh `updatedAt`, an indicator reading "Saved", and their folder
file untouched. The layout mounts once for the whole app, so a client-side navigation now carries the
live session including a resumed folder, and `unsupportedReason` is answered in one place instead of
two. Ticket 07 puts that pane on the Project page, which makes this the default path.

`StorageChoice` stays hub-only, because *choosing* where a Workspace lives is a Workspace-level act.
Recovering one you are already using is not a choice, so the two recoveries — "not reachable", and
"remembered but not open yet" — live in `WorkspaceRecovery` and appear beside the Project on any
route. Criterion 7's Project-page half was previously unmet in a way worse than reported: a deleted
folder makes `getDirectoryHandle('amsterdam-1625')` raise the same `NotFoundError` as a Project that
really has gone, so the page said "There is no Project called amsterdam-1625 in this Workspace" —
telling a scholar their work does not exist while it sat in a folder on their desk. `open()` now asks
the Workspace before blaming the Project, on that failure path only.

### What the tests genuinely assert, and what they simulate

Stated plainly, because an adapter tested only against a fake handle has not been tested.

**Real.** Every file operation, in both Chromium and Firefox, against a genuine
`FileSystemDirectoryHandle` — real `createWritable`, real `move`, real `removeEntry`, real
`NotFoundError` when the directory is genuinely deleted. The handle's round trip through
`structuredClone` into IndexedDB and back across a page reload. The user gesture: the e2e asserts
`navigator.userActivation.isActive` *inside* the picker and permission calls, from a real click
and from a real keypress, so "resumption must never be an automatic call on load" is asserted and
not assumed. The `move`-less fallback, entered by hiding `move` the way Safari does.

**Simulated, because no automation can do otherwise.** `showDirectoryPicker()` opens an
operating-system dialog and waits for a person; Playwright has no file-system equivalent of
`grantPermissions`, and neither does Vitest browser mode. So the picker is stubbed and hands back
a real handle obtained from OPFS, and `queryPermission`/`requestPermission` are scripted per test
so that *declined* and *lapsed* can be exercised at all. What is therefore unasserted is the
dialog itself and the fact that the directory is one the user could open in Finder — not the
storage, and not the app's sequencing around it.

**One consequence worth a human minute before release.** Chromium's `createWritable()` on a file
in a *real* folder creates a visible `<name>.crswap` sibling, which `abort()`/`close()` remove.
Nothing in CI can confirm that in a folder the OS owns rather than in OPFS. Open a real folder
once, interrupt a save, and look for leftover `.crswap` or `.ballastella-tmp` files — in a git
working tree those are litter the user commits. Both spellings are now inside the reserved-suffix
machinery and swept when a Workspace is adopted, so the check is that nothing survives rather than
that the app copes.

### Story 2's one characteristic failure has no coverage, and cannot have

Story 2 — pointing a Workspace at a Dropbox or iCloud folder — is claimed by this ticket, and the
happy path is covered like any other folder. Its distinctive failure is not, and the gap is
**inherent**: a local `createWritable()` takes an exclusive lock and raises
`NoModificationAllowedError` when a sync daemon, an editor, or antivirus is holding the file, and
**OPFS cannot produce that state at all**. Every handle an automated browser can obtain comes from
`navigator.storage.getDirectory()`, so there is nothing to provoke it with short of a real synced
folder and a real second process.

What was cheap and is done: `DirectoryHandleStore.writeBytes` now maps that one error to a message
naming the likely cause and the remedy. Undescribed, the raw browser text reached `saveError`
verbatim, where "The requested file could not be written to" is indistinguishable from a full disk;
retrying is the whole remedy and usually works within seconds, which is exactly what a user cannot
guess. **Untested, and knowingly so** — a test asserting the mapping would only assert that the
`if` matches the string it was written against.

The other half of a real check belongs with the human minute above: put a Workspace in a real
Dropbox folder, edit while it syncs, and confirm the message is what appears rather than a stack
trace.

### The public barrel is wider than anything needs

`DirectoryHandleStore` and `DirectoryResolver` are exported from `packages/core/src/index.ts`
although nothing outside `packages/core` imports either — they exist so `OpfsProjectStore` and
`FileSystemAccessProjectStore` can share one implementation, which is an internal arrangement.
`TempFileWriteStore` is in the same position. Recorded rather than narrowed, because removing an
export is the sort of change that wants to happen once, deliberately, across the whole barrel; but
ADR-0001's narrowness is a property of the *interface*, and a barrel that publishes the base classes
invites an app to reach past `ProjectStore` for a handle.
