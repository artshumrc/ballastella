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

- [ ] On Chromium desktop, choosing a folder makes it the Workspace, and Projects created there appear as real files with the layout ADR-0008 specifies
- [ ] The adapter passes ticket 02's shared adapter test suite **with no changes to the suite**
- [ ] On a browser lacking the API, the option is absent and OPFS continues to work with no error
- [ ] One grant covers every Project in the workspace — no second prompt when switching Projects
- [ ] The handle is persisted in IndexedDB and the Workspace resumes on return, via a user gesture rather than an automatic call
- [ ] Declining permission produces an explanation and a way to retry — not a silent fallback
- [ ] A workspace whose folder has been moved or deleted shows "Workspace not reachable" with a locate-again action
- [ ] An interrupted `project.json` write leaves the previous contents intact and parseable
- [ ] Switching to a folder workspace and back leaves the OPFS workspace's Projects intact
- [ ] A Project created in a folder workspace can be read by the OPFS adapter after being copied in by hand — proving the layout is backend-independent

```bash
pnpm --filter @ballastella/core test    # shared adapter suite runs against all three adapters
pnpm test:e2e                    # Chromium file-picker flow, resume, decline, unreachable
pnpm -r build && pnpm lint && pnpm check
```

Success: all exit 0. Playwright must grant and revoke the file-system permission to cover the decline and unreachable paths — these cannot be tested outside a real browser, which is why SPEC's Seam 2 exists.

## Blocked by

- Ticket 02
