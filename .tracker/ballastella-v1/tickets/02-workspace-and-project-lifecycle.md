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

- [ ] `ProjectStore` has in-memory and OPFS adapters, both passing the same shared test suite
- [ ] Creating, renaming, duplicating, and deleting a Project is reflected in the store's files
- [ ] `project.json` contains `formatVersion: 1`
- [ ] A `project.json` with `formatVersion: 2` is refused with a message, and the file is **not modified**
- [ ] An interrupted `project.json` write leaves the previous contents intact and parseable
- [ ] Two writes to the same path within the debounce window produce one store write; writes to different paths are not batched together
- [ ] `pagehide` triggers a flush of pending writes
- [ ] The save indicator observably transitions saved → saving → saved
- [ ] The hub page lists Projects with names and last-modified, and `?p=<dir>` opens one
- [ ] A store whose `list` throws renders "Workspace not reachable" with a locate-again action, not an error boundary
- [ ] Renaming a Project to an existing display name succeeds; two Projects may share a display name but not a directory name
- [ ] `size(path)` returns a byte length **without** calling `read` — asserted with a spy on the adapter, in both the in-memory and OPFS adapters
- [ ] Opening a Project and closing it without editing anything writes **nothing**: every file in the Project directory is byte-identical before and after, verified by hashing
- [ ] All dialogs use `<dialog>` + `showModal()`; Escape closes them and focus returns to the trigger
- [ ] Every hub-page control is reachable and operable by keyboard

```bash
pnpm --filter @ballastella/core test
pnpm -r test
pnpm test:e2e
pnpm lint && pnpm check
```

Success: all exit 0. The e2e suite must include the save-indicator transition, the `formatVersion: 2` refusal, the unreachable-workspace state, and the Escape-closes-dialog-and-restores-focus assertion — these are browser behaviours and do not belong in the core suite.

## Blocked by

- Ticket 01
