# 02 — Workspace and Project lifecycle on OPFS, with autosave

## What to build

A user opens the editor, sees a hub page listing the Projects in their Workspace, and can create, rename, duplicate, and delete a Project. Everything is stored in OPFS. Changes are written automatically, and a save indicator shows saved / saving / unsaved.

This slice establishes **the `ProjectStore` abstraction that every later slice depends on**, and the autosave rules that every later mutation obeys.

**Fulfills** — [SPEC.md](../SPEC.md) user stories 4 (OPFS is the universal backend, so the tool works fully where folder access is impossible), 7, 10, 11, 12, 73, 74, 75, 76, 77, and 97. `size` is the prerequisite for story 15's hosting-limit warnings in tickets 15 and 16.

## Where to start

[ADR-0001](../../../docs/adr/0001-opfs-first-project-store.md) (the store), [ADR-0008](../../../docs/adr/0008-projects-live-in-a-workspace.md) (workspace model and layout), [ADR-0017](../../../docs/adr/0017-autosave-semantics.md) (autosave), [ADR-0010](../../../docs/adr/0010-integer-format-version-with-forward-only-migrations.md) (version refusal), [ADR-0016](../../../docs/adr/0016-daisyui-only-with-mandated-component-methods.md) (component methods).

## Contract

```
ProjectStore
  read(path)          → Promise<Uint8Array>
  write(path, bytes)  → Promise<void>
  list(prefix)        → Promise<string[]>
  delete(path)        → Promise<void>
  size(path)          → Promise<number>
```

**`size` exists so a workspace's total byte count can be computed without reading it.** Tickets 15 and 16 both have to warn about the ~1 GB static-hosting cliff, and a multi-gigabyte pyramid is thousands of tile files — summing sizes by `read`ing each one would be the slowest possible way to answer a question both backends answer for free (`getFile().size`). **Do not implement `size` as a read.** It is in the interface here, before ticket 12, so the File System Access adapter inherits it via the shared suite rather than having it bolted on.

Two adapters ship here: **in-memory** (for tests — see SPEC Testing Decisions, this is the primary seam) and **OPFS**. The File System Access adapter is ticket 12; do not anticipate it beyond keeping the interface honest.

**Build OPFS first and do not shape the interface around a folder-like backend** (ADR-0001). Paths are opaque strings; the store does not expose handles, directories, or anything backend-specific.

Layout — projects are directories inside the workspace root (ADR-0008):

```
<project>/project.json
```

```jsonc
{
  "formatVersion": 1,
  "name": "Amsterdam 1625",       // display name; may collide with others
  "layers": [],                    // ticket 09
  "baseMap": null                  // ticket 04
}
```

**Project identity is its directory name, never its display name** (ADR-0008). Display names may collide; directory names must not.

A project is addressed in the URL by query parameter: `?p=<directory-name>` (ADR-0008). One prerendered page; the project is selected client-side.

### Autosave — all five rules (ADR-0017)

1. Continuous gestures commit on gesture **end**, not on a timer. (No gestures exist yet; the mechanism must support it so later slices do not invent their own.)
2. Debounce **per file**, not globally.
3. Flush on `visibilitychange` → hidden and on `pagehide`. **Not `beforeunload`** — unreliable and ignored on mobile.
4. **Write atomically: temp file, then rename.** Non-negotiable for `project.json`, which holds the layer list — a torn write there loses the map of everything, and it is the most frequently written file.
5. Show save state: saved / saving / unsaved. There is no Save button, so this indicator is the user's only signal.

### Format version

Write `formatVersion: 1`. On open, **refuse anything higher than the app understands**, with a message naming the remedy: "This project was made with a newer version — open it at *URL*, or update your copy." Without the refusal, an old fork drops unrecognised fields, writes the file back, and destroys work silently (ADR-0010).

Do **not** build migration machinery. There are no migrations to run, and writing untestable infrastructure now is speculative; the first real format change brings its own ticket.

### Unreachable workspace

"Workspace not reachable" is a normal state with a "locate again" affordance, not an unhandled rejection at startup (ADR-0008). Reachable in this slice by simulating a store that throws on `list`.

## Out of scope

- **File System Access / the directory picker** — ticket 12.
- **Zip import/export** — ticket 13. Do not add a zip dependency.
- **Migrations** — see above.
- **Layers, images, alignments, annotations.** `layers` stays an empty array.
- **Publishing.** Do not write `index.html` into the workspace.
- **Any map library.** No `maplibre-gl` here.

## Acceptance criteria

- [x] `ProjectStore` has in-memory and OPFS adapters, both passing the same shared test suite
- [x] Creating, renaming, duplicating, and deleting a Project is reflected in the store's files
- [x] `project.json` contains `formatVersion: 1`
- [x] A `project.json` with `formatVersion: 2` is refused with a message, and the file is **not modified**
- [x] An interrupted `project.json` write leaves the previous contents intact and parseable
- [x] Two writes to the same path within the debounce window produce one store write; writes to different paths are not batched together
- [x] `pagehide` triggers a flush of pending writes
- [x] The save indicator observably transitions saved → saving → saved
- [x] The hub page lists Projects with names and last-modified, and `?p=<dir>` opens one
- [x] A store whose `list` throws renders "Workspace not reachable" with a locate-again action, not an error boundary
- [x] Renaming a Project to an existing display name succeeds; two Projects may share a display name but not a directory name
- [x] `size(path)` returns a byte length **without** calling `read` — asserted with a spy on the adapter, in both the in-memory and OPFS adapters
- [x] Opening a Project and closing it without editing anything writes **nothing**: every file in the Project directory is byte-identical before and after, verified by hashing
- [x] All dialogs use `<dialog>` + `showModal()`; Escape closes them and focus returns to the trigger
- [x] Every hub-page control is reachable and operable by keyboard

```bash
pnpm --filter @ballastella/core test
pnpm -r test
pnpm test:e2e
pnpm lint && pnpm check
```

Success: all exit 0. The e2e suite must include the save-indicator transition, the `formatVersion: 2` refusal, the unreachable-workspace state, and the Escape-closes-dialog-and-restores-focus assertion — these are browser behaviours and do not belong in the core suite.

## Blocked by

- Ticket 01

## Comments

### Implementation, 2026-08-05

All fifteen acceptance criteria verified. `pnpm --filter @ballastella/core test` (116 tests),
`pnpm -r test`, `pnpm -r build`, `pnpm lint`, and `pnpm check` all exit 0, and the Playwright
suite passes 17/17 — see the note on ports at the end.

**Decisions the ticket left open, each with its reasoning in the code:**

- **`write` is atomic; there is no `rename` on the interface.** ADR-0017 rule 4 requires temp
  file then rename, and the Contract fixes the interface at five methods. Widening it to six
  would have made every caller responsible for atomicity and given ticket 12 a way to skip it.
  Instead `TempFileWriteStore` — a small abstract base both adapters extend — implements
  `write` as `writeBytes(temp)` then `renameTempFile(temp, destination)`, with cleanup of the
  orphan on failure. The temp suffix `.ballastella-tmp` is reserved: `list` never reports it and
  `write` refuses it, so an interruption cannot leave litter that later looks like Project data.
  Ticket 12's adapter inherits atomicity by extending the same base.
- **The interruption test spies on a protected member.** No public API can make the *second*
  step of a write fail, and fault-injection hooks in shipping code would be worse. The suite
  therefore mocks `renameTempFile`, which is declared on the shared base, so both adapters fail
  in the same place. This is the one place the suite knows something structural; the ticket
  already sanctions the same technique for `size`.
- **`updatedAt` lives in `project.json`, not in a new `stat`/`lastModified` store method.** The
  hub needs last-modified and the interface has no clock. Both real backends expose a file
  mtime for free, exactly as they do `size` — but a workspace is expected to live in git or
  Dropbox (ADR-0008), and a fresh clone stamps every file with the moment of checkout, while a
  zip import (ticket 13) loses mtimes altogether. A Project's own record of when its author
  last touched it survives all of that. It is also why the ticket's own `size` essay argues for
  `size` and says nothing about mtime: `size` is a fact about bytes, this is display state.
- **The refusal message names `https://artshumrc.github.io/ballastella/`.** ADR-0010 requires
  "open it at *URL*" and nothing in the repo records one. This is the GitHub Pages address of
  the repository's own remote, exported as `BALLASTELLA_CANONICAL_URL` from core so a forker
  changes it in one place. **A human should confirm this is the intended canonical instance** —
  it is a guess from the git remote, not a recorded decision, and it is the one string a user
  meets at the moment their work is at risk.
- **Vitest browser mode was added so the OPFS adapter can run the shared suite.** There is no
  OPFS in Node, and a Node stub of one would only prove the stub agrees with the memory
  adapter — which is the thing the suite exists to check. `packages/core/vitest.config.ts` now
  has two projects: `node` (SPEC's Seam 1) and `browser` (`*.browser.test.ts`, real Chromium,
  real OPFS). `@vitest/browser-playwright` and `playwright` went into the catalog. This is also
  what ticket 12 needs — its criterion says the shared suite runs "against all three adapters"
  under `pnpm --filter @ballastella/core test`, and File System Access is no more available in
  Node than OPFS is.
- **The Project view has a name field.** Autosave needed a mutation surface to be observable at
  all, and the display name is the only editable value that exists this early. It earns its
  place: it is where "typing coalesces into one write" (`debounce: true`) and "the edit is
  committed when it ends" (`onblur`/`onchange`) are established, so tickets 05–15 inherit rule 1
  and rule 2 rather than improvising them.
- **The save indicator holds "Saving…" for 400 ms minimum.** An OPFS write is often over in
  single-digit milliseconds; shown for less than that the indicator is a strobe rather than
  reassurance. The dwell is in the component, not in `Autosave`, because it is a display concern.
- **A `Bytes` alias (`Uint8Array<ArrayBuffer>`) crosses the store boundary.** The default
  `Uint8Array<ArrayBufferLike>` is not accepted by `createWritable().write` or `crypto.subtle`,
  and saying so in the type is better than an assertion at every call site.
- **`list(prefix)` is a string-prefix match, not a directory listing.** Pass a trailing `/` for
  a directory. The OPFS adapter still descends to the prefix's directory before walking, so
  listing one Project does not enumerate a sibling's pyramid.
- **The OPFS adapter prunes directories a delete emptied.** Invisible through the interface, but
  ticket 12's backend is a folder the user looks at.

**Carried forward, not done here:**

- **The OPFS write path is `createWritable()` in the page context, not
  `FileSystemSyncAccessHandle` in a Worker.** ADR-0017 notes the Worker path is OPFS's *preferred*
  write architecture; it is an optimisation, and the abstraction already absorbs the difference
  (atomicity is the adapter's promise, not the caller's). A Worker plus a message protocol is
  real complexity with no user-visible change at this size of data, and the tiler in ticket 05 is
  the slice that will actually make it pay. `renameTempFile` prefers `FileSystemFileHandle.move`
  and falls back to a copy when a browser lacks it; `createWritable` is atomic by specification
  either way.
- **`resolve()` from `$app/paths` is used for internal links** because `svelte/no-navigation-without-resolve`
  requires it. Worth knowing before ticket 16 audits paths for `paths.relative`.

**One shared-toolchain finding, deliberately not fixed here:**

`playwright.config.ts` sets `reuseExistingServer: !process.env.CI`, and both apps' ports are
hard-coded (4173, 4174). Two checkouts of this repository on one machine therefore share a
preview server: `pnpm test:e2e` in one worktree silently tests **the other worktree's build**,
and every assertion fails for reasons that have nothing to do with the code under test. That
happened during this ticket and cost a full debugging cycle. The fix is to read the ports from
the environment, or to set `reuseExistingServer: false`; it belongs to whoever owns
`playwright.config.ts` next, since it is ticket 01's file and outside this slice.

## Review follow-ups

### Fixed in review, 2026-08-05

Findings from an independent review of this slice, with the tests that now fail when each
behaviour is broken. Each was verified red by breaking the behaviour deliberately.

- **Autosave lost the bytes of a failed write, and the indicator lied about it.** `#drainLoop`
  cleared `file.pending` *before* attempting the write and merely returned on failure, so there
  was nothing for `flush` to retry and `#drain`'s `.finally` then deleted the entry. And
  `#lastError` was a single field cleared by the next write that happened to succeed: rename a
  Project with quota exhausted, create any other Project, and the indicator read "Saved" for an
  edit that was never written — what ADR-0017 rule 5 exists to prevent. The error is now per file
  and the state derives from the file's own pending bytes. `commit` rejects, so
  `Workspace.writeProject` and `EditorSession` cannot report a mutation they did not get.
  `Autosave.hasPendingWrite` is no longer dead code.
- **Tabbing through the Project name field rewrote `project.json`.** `onblur` committed with no
  dirty check and `writeProject` stamps a fresh `updatedAt`, so criterion 12 was false through the
  UI even though the store-level test passed. `commitProjectName` now no-ops unless a write is
  pending. The existing byte-identity e2e could not see it, because it navigates with `page.goto`
  and never focuses anything; the new test drives focus with both keyboard and pointer.
- **Abandoned atomic writes were unreclaimable, so a "deleted" Project survived on disk.**
  `writeBytes` sat outside `write`'s guard, and OPFS reports quota exhaustion from `close()`, which
  sat outside its own — so a full disk left a temporary file that nothing could reach: `list` hides
  the reserved suffix, `delete` refuses it, and `deleteProject` walks `list`. Both are inside their
  guards now, `ProjectStore` gained `reclaimAbandonedWrites(prefix)` (one implementation in
  `TempFileWriteStore`, every backend inherits it), and `deleteProject` calls it. It is a removal
  only — it neither lists the litter nor writes, so no caller gains a way to put bytes where `list`
  hides them.
- **Three vacuous tests.** `installFlushOnHide`'s two flush tests called `await autosave.flush()`
  themselves, so gutting both listener bodies left them green. The e2e `pagehide` test was vacuous
  differently: the debounce is 400 ms and `expect.poll` waits five seconds, so the timer fired
  inside the poll — verified to pass with `installFlushOnHide` deleted entirely. It now freezes the
  page's clock, so the app's timer cannot fire and the listener is the only thing that can write.
  The shared suite's two "no litter" tests asserted through `store.list('')`, which filters
  temporary paths *by construction* — verified to pass with the cleanup removed. They now go
  through the backend's own view of what it holds.
- **`hashProject` in the e2e did not recurse**, so the nested `images/info.json` the byte-identity
  test deliberately seeds was skipped and only `project.json` was ever hashed. It recurses, and the
  test asserts which files the hash covers so the recursion cannot quietly go away again.
- **The interruption test's protected-member spy is gone.** It cast the store and spied on
  `renameTempFile`, so ticket 12 could only pass the suite "unchanged" by extending
  `TempFileWriteStore` — contradicting the suite's own headline claim and CONTRIBUTING's "never
  assert on module structure". The fault now comes from a fixture each backend supplies
  (`StoreUnderTest`): the in-memory double has a documented `failNextWrite` switch beside
  `unreachable()`, and the OPFS adapter is interrupted by patching the browser API it calls. Both
  failure points are covered for both adapters, plus recovery on the next write.
- **`EditorSession` no longer reports every failure as an unreachable Workspace.** A
  `PathNotFoundError` from a concurrently-deleted Project rendered "Workspace not reachable" over a
  reachable Workspace; write failures now land in `saveError` beside the save indicator instead.
- **`OpfsProjectStore.isSupported` is consulted**, so a non-secure context gets a diagnosis rather
  than "navigator.storage.getDirectory is not a function".
- **The name field no longer triggers a read storm.** Every keystroke ran `listProjects()` →
  `list('')`, a recursive walk of the whole OPFS tree with a re-parse of every `project.json`; with
  three 2 GB pyramids a twenty-character name meant twenty 30,000-entry walks. The list is loaded
  when the hub is shown, which is the only place it is rendered.
- **The OPFS adapter suite runs in Firefox as well as Chromium** (74 tests), because story 4 is
  that OPFS is the universal backend and Firefox has its own implementation of it. The `move`-less
  rename fallback also has a test that enters it deliberately — see the note under ticket 04, since
  `move` turns out not to be Chromium-only any more.

### Still open — needs a human

- **`BALLASTELLA_CANONICAL_URL` is a guess** (`packages/core/src/project/project-file.ts`). It was
  derived from the git remote and reads `https://artshumrc.github.io/ballastella/`, which 404s
  unless Pages is enabled with no custom domain. Worse, ADR-0006 is explicit that we cannot know at
  build time whether a deployment sits at a subpath or a domain root — so a compile-time constant is
  wrong on every fork, in the one message a user reads at the moment their work is at risk
  ("open it at *URL*", ADR-0010). The value has been left alone deliberately. Deciding it means
  either recording the canonical instance as a project decision, or making it deployment
  configuration a forker sets — which is the same shape as the Base Map catalog (ADR-0020) and
  probably the right answer, but it is a product call, not a refactor.
- **Orphaned writes are still not counted in a workspace's total size.** `list` hides the reserved
  suffix by design, so the `list` + `size` sum tickets 15 and 16 use for ADR-0008's ~1 GB warning
  excludes any half-finished write. After the fixes above that is bounded by "one interrupted write
  per crashed tab", and `reclaimAbandonedWrites` clears them when a Project is deleted — but a
  Project the user never deletes can accumulate them. Ticket 15 or 16 should decide whether to
  sweep before totalling, and whether a directory holding *only* an abandoned write (a first write
  interrupted by a crash, so there is no `project.json` and the hub cannot list it) needs surfacing
  at all.
