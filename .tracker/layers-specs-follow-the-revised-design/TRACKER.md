# Tracker for layers-specs-follow-the-revised-design

## Purpose

`b65663d "revise layers design"` (44 files, +3885/−819) moved several Layer controls inside the
Layer card's disclosure and migrated part of the browser suite to a new `openLayerRow` helper. It
left **29 tests** asserting on those controls from the collapsed row, where they are not in the DOM
at all. The suite has been red on `main` ever since.

This epic makes the specs describe the shipped design. **No product code changes.**

## Current status

**In progress**, 2026-08-11. 14 of 29 fixed and verified; 11 edited and under test; 4 not started.

## Established by measurement, not inference — do not re-derive

- **All 29 fail at `b65663d`** with no other work in the tree: 29 failed, 0 passed. They are not
  caused by the `fork-and-publish` epic, which is `05081f4` and touches none of these files.
- **The app is correct; the assertions are stale.** Proven on
  `editor-align-referenced.e2e.ts:370` — replacing `layerRows(page).first()` with
  `await openLayerRow(page)` turned the failure into a pass in 2.1 s.
- **All 13 testids the failing tests reach for exist in the source.** Nothing is unbuilt.
- **The controls now inside the open card** (`layer-contents`, gated on `{#if open}`):
  `layer-opacity` (810), `layer-opacity-value` (822), `layer-image-mode` (844),
  `layer-foreign-note` (866), `layer-move-up` (887), `layer-move-down` (897), `layer-delete` (921),
  and the rename pair — `layer-rename` needs `open`, and the `layer-name` *input* needs
  `renaming === layer.id && open`.
- **Still on the collapsed row:** `layer-name-text`, `layer-visible`, `layer-kind`,
  `layer-drag-handle`, `layer-disclosure`, `layer-problem`, `layer-hidden`.
- **The disclosure is an accordion.** `{@const open = openLayerId === layer.id}` — one id, so
  opening one row closes any other. This is a trap for any test asserting an *absence*; see below.

## The canonical fixes

```ts
// A control now inside the card
await (await openLayerRow(page)).getByTestId('layer-delete').click();

// Renaming — the field is behind the pencil, in an open card
const renaming = await openLayerRow(page, rows(page).nth(0));
await renaming.getByTestId('layer-rename').click();
await renaming.getByTestId('layer-name').fill('Trade routes');
```

`openLayerRow` is idempotent (it reads `aria-expanded` and only clicks when needed) and returns the
row locator. It is already imported in most of the affected files — a sign of the half-done
migration.

Two fixes were **not** mechanical, and neither should be "simplified" back:

- **`editor-image-ingest`** wanted no expand step at all. It asserts the name a reader of the list
  sees, so it belongs on `layer-name-text` with `toHaveText`, not on the rename field's value.
- **`is offered on a map Layer and on no other kind`** asserts an absence. Because of the accordion,
  opening the map row and then asserting `toHaveCount(0)` on the annotation row passes *because that
  row was collapsed* — true of every control on it, and no statement about kinds. Each row is now
  asserted while its own card is open.

## A human decision, recorded — 2026-08-11

Reordering is asymmetric after the revision: **pointer** users drag from the collapsed row
(`layer-drag-handle`, a `<span draggable aria-hidden>` with no key handling), while **keyboard**
users must expand a card to reach `layer-move-up` / `layer-move-down`.

**Decided: this is the intended design.** Keyboard users expand; mouse users drag the collapsed row.
So SPEC story 96's "every control of every Layer is reachable with the keyboard" means *reachable,
per open card* — the disclosure is a plain `<button>`, so the path exists. The tests must say that
explicitly rather than encode it by accident.

⚠ **This supersedes ticket 05's recorded intent, which is still written in the suite.** The comment
block above `one Layer opens at a time (ticket 05)` in `editor-layers.e2e.ts` says a closed row keeps
"the name, the visibility toggle, **the position controls**, and whatever the Layer is warning
about". The position controls are no longer there. That paragraph must be updated with the decision
above, or the code, the tests, and the prose disagree and the next reader will believe the prose.

## What is left

1. **`editor-layers.e2e.ts` — 4 tests using `tabTo`**, which fail *inside* the helper because a
   collapsed card's buttons are not in the DOM to be tabbed to: `reorders by keyboard alone`,
   `leaves the keyboard on the Layer that moved`, `keeps focus on the same button when the move does
   not reach the end`, and `every control of every Layer is reachable with the keyboard`.

   The last one is a genuine restructure, not an inserted line: it walks a **flat list across both
   rows** (`[0, 'layer-disclosure'] … [1, 'layer-opacity']`), which the accordion makes impossible —
   both rows' in-card controls cannot be in the tab order at once. Rewrite as "for each row: open it,
   then walk its controls", and swap `layer-name` for `layer-rename` since the field is behind the
   pencil. This is where the decision above gets encoded, so state it in the test.

2. **`is an ordered list whose structure and order are announced`** — asserts
   `getByLabel('Name of Layer 1 of 2')`, an `aria-label` on the rename *input*, so it needs the card
   open and the pencil pressed. Consider whether the announcement claim should rest on the input's
   label at all, or on the list structure the closed rows expose.

3. **The ticket-05 prose**, per the ⚠ above.

4. **Verification:** `pnpm exec playwright test editor-layers.e2e.ts`, then the full suite. Expect
   511 + 29 = 540 passing, 1 skipped. Baseline before this epic: 511 passed / 29 failed / 1 flaky
   (`viewer-reader.e2e.ts:2293`, within the 3% retry budget — noise, do not chase).

## Traps met while doing this, worth not repeating

- **Never pipe Playwright through `tail`.** A pipeline reports the *last* command's status, so
  `playwright test | tail` yields exit 0 over a red suite. This wasted two full 40-minute runs and
  produced a confidently wrong "511 passed, green" report. Redirect to a file and echo `$?`.
- **Reconcile the counts.** The retry reporter prints `suite.allTests().length`; if
  passed + failed + flaky + skipped does not equal it, output is being hidden.
- **Do not select tests by `file:line` after editing them.** Inserted lines shift the numbers and
  Playwright silently runs nothing for a stale location — one test was skipped that way and the run
  still exited 0. Use `-g` with the title, or the whole file.
- **A killed run leaves its preview server holding the port**, and the next run fails with "port is
  already used" before `free-e2e-port.mjs` gets a chance. Clear it with
  `node scripts/free-e2e-port.mjs 36790` (and `36791`).

## Ledger

| Number | Filename | Status | Depends On |
| --- | --- | --- | --- |
| 01 | [01-the-specs-open-the-card.md](./tickets/01-the-specs-open-the-card.md) | In progress | — |
