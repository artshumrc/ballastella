# 08 — Finish the Layer stack migration

## What to build

`editor-layers.e2e.ts` is the file the migration pattern was proved on: six tests already retired, thirteen component tests written to replace them. Finish it — 36 Seam 2 tests remain at roughly 11.8 worker-seconds each, and a good half of them are about the sidebar rather than the map.

Remaining candidates:

- **To the component seam**: the drag-to-reorder behaviour (dragging a picture of the card rather than the handle; a card highlighting once without flickering); a Layer's name selectable by dragging across it; the closed-row Align-now variants (offered when unaligned, absent when aligned, absent when the Alignment cannot be read); the Layer's own Align living inside the open row; an unreadable Alignment not being announced as a map needing alignment.
- **To Seam 1**: renaming a Layer changing only `project.json`; a rename and an opacity change re-reading no Layer document; tabbing through a Layer's fields writing nothing; a Layer kind this build has never heard of being listed, reordered and written back intact.

## Where to start

- `e2e/editor-layers.e2e.ts` — the describe blocks "display state never reaches a portability document (ADR-0002)", "a Layer kind this build has never heard of (ADR-0014)", "one Layer opens at a time (ticket 05)", and the drag half of "ordering, including across kinds (ADR-0002)".
- `apps/editor/src/lib/layers/layer-list.dom.test.ts` and `LayerListHarness.svelte` — the thirteen already written and the parent-harness pattern. **Read the harness header**: `moveByButton` restores focus one microtask after `onmove`, so a parent that updates late tests the wrong thing.
- `packages/core/src/project/layer.ts` and `layer.test.ts` — where the write-counting and foreign-Layer claims belong.
- ⚠ The closed-row Align-now variants are rendered by a **snippet the Project screen supplies** (`problemAction`), not by `LayerList` itself. Passing a snippet from a test is possible; decide whether the claim is `LayerList`'s or `ProjectScreen`'s before moving it, and say which in the commit.

## Contract

- **What stays at Seam 2, without exception**: that a reordered Layer draws above another in MapLibre's own layer order; that an opaque annotation above a map Layer still draws above it; that the Historical Map draws warped and comes off the map when hidden; that any of it survives a reload. Those are the renderer and OPFS, and this file is the only place they are asserted.
- **Byte-identity across reorder, rename, toggle and opacity is a claim about what the application writes during a session.** If moving it to Seam 1 turns it into the serialiser agreeing with itself, leave it at Seam 2 and record that judgement.
- Address elements by position, never by a held locator — a disclosure's accessible name changes from "Open — …" to "Close — …" when clicked.
- Every retired Seam 2 test names its replacement.

### User Stories

3, 5, 9, 19, 22, 23, 35, 43.

## Out of scope

- Changing `LayerList.svelte`, including adding `data-testid`s.
- The keyboard-reachability sweep — ticket 14.
- Touching the six tests already retired or the thirteen already written, beyond what ticket 02's Node conversion required.

## Acceptance criteria

- [ ] `editor-layers.e2e.ts` retains only claims needing a real renderer or real storage, and its remaining count is recorded.
- [ ] Every moved claim is watched to fail once against a deliberate break.
- [ ] Each claim considered and rejected for moving is listed with its reason.
- [ ] The `problemAction` snippet question is answered in writing — whose claim it is, and why.
- [ ] `pnpm test:e2e editor-layers.e2e.ts` passes; count and wall time recorded before and after.
- [ ] `pnpm precommit lint check test` passes.

```bash
pnpm test:e2e editor-layers.e2e.ts
pnpm --filter @ballastella/editor exec vitest run
pnpm --filter @ballastella/core test
pnpm precommit lint check test
```

Success: the file's remaining tests all name a renderer, OPFS or a route; everything else asserts in milliseconds.

## Blocked by

- 02
