# 11 — Rehouse the Workspace and Project screen claims

## What to build

`editor-workspace.e2e.ts` (41 tests) and `editor-project-screen.e2e.ts` (20) between them assert a great deal about **what a dialog says and what a list shows** — the Map Images a Workspace holds with their labels and sizes, which Projects use each map, what the delete confirmation says when a map is in use, what an empty Workspace says and which action it names.

Split them: the document-and-arithmetic claims to Seam 1, the rendering-and-focus claims to the component seam, the storage and navigation claims stay.

## Where to start

- `e2e/editor-workspace.e2e.ts` — the Map Images listing block ("lists every Map Image with its label, its size, and how many files that is", "names the Projects that use each map, and says plainly when none do", "refuses to delete a map two Projects use, naming both, and keeps the pyramid", "will not call a map unused, or delete it, because a Project is from a newer version", "a Workspace with no Map Images says so, and names the next action").
- `e2e/editor-project-screen.e2e.ts` — profile it first; it was never measured during the investigation.
- `packages/core/src/project/workspace.ts` / `workspace.test.ts`, `workspace-size.ts` / `workspace-size.test.ts`, `map-images.ts` / `map-images.test.ts`, and `used-by` in the editor — the "which Projects use this map" question already has a home.
- `apps/editor/src/lib/alignment/used-by.test.ts` — an existing Node test of exactly this shape.

## Contract

- **"Which Projects use this map" is a pure question over documents** and belongs at Seam 1, including the ADR-0010 case: a Project from a newer version must never let a map be called unused, because the build cannot read it to find out. That case is the interesting one and must survive the move intact.
- **What stays at Seam 2**: that the Project is really in OPFS laid out as ADR-0008 specifies; that creating, renaming, duplicating and deleting reach the real store; that `?p=` opens the Project it names; that the confirmation is a real `<dialog>` opened with `showModal()` and closable by Escape.
- **The `<dialog>`-is-native claims stay at Seam 2 exactly once**, not once per spec — ticket 14 owns the deduplication, so do not move or delete them here.
- Sizes and file counts are arithmetic over a store and move to Seam 1; the *rendering* of them moves to the component seam only if a component owns it.
- Every retired Seam 2 test names its replacement.

### User Stories

3, 5, 9, 35.

## Out of scope

- Named Workspaces and folder Workspaces (`editor-named-workspaces.e2e.ts`, `editor-folder-workspace.e2e.ts`). The File System Access grant path can only be exercised in a real browser and ADR-0008's handle caching is the subject; leave both files alone.
- Backup and restore (`editor-backup.e2e.ts`).
- The keyboard sweep — ticket 14.

## Acceptance criteria

- [ ] `editor-project-screen.e2e.ts` is profiled and its cost recorded before anything is moved.
- [ ] "Which Projects use this map", including the newer-version case, is asserted at Seam 1.
- [ ] Workspace size and file-count arithmetic is asserted at Seam 1.
- [ ] The OPFS-layout and `?p=` claims are untouched at Seam 2.
- [ ] Each moved claim is watched to fail once against a deliberate break.
- [ ] Every retired Seam 2 test is named alongside its replacement.
- [ ] Both specs pass; counts and wall times recorded before and after.
- [ ] `pnpm precommit lint check test` passes.

```bash
pnpm test:e2e editor-workspace.e2e.ts editor-project-screen.e2e.ts
pnpm --filter @ballastella/core test
pnpm --filter @ballastella/editor exec vitest run
pnpm precommit lint check test
```

Success: the arithmetic and the "who uses this" question assert in milliseconds; OPFS and the modal still assert in a browser.

## Blocked by

- 02
- 03
