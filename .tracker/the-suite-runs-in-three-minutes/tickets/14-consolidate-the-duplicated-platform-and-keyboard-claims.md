# 14 — Consolidate the duplicated platform and keyboard claims

## What to build

Nearly every spec in the suite carries some version of "is fully operable from the keyboard", "is a native `<dialog>` opened with `showModal()`, closable by Escape", and "Escape closes the dialog and focus returns to the button that opened it". Asserted once per surface, these are a contract. Asserted in a dozen specs, most of them are re-testing the platform.

Keep them where the widget is genuinely **custom** and this repository owns the behaviour. Retire them where the control is a native element and the browser owns it.

## Where to start

Grep the suite for the recurring shapes — `showModal`, `Escape`, `toBeFocused`, "keyboard alone", "reachable with the keyboard" — and build a table of where each claim appears before changing anything.

- ADR-0016 is the governing decision: daisyUI only, with **mandated component methods** — modals are `<dialog>`, dropdowns use the Popover API, `<input type="range">` and `<input type="checkbox">` are the mandated controls. A test that a native `<dialog>` closes on Escape is a test of Chromium; a test that *this* dialog is a `<dialog>` rather than a div is a test of ADR-0016 and is worth exactly one assertion per dialog.
- `e2e/support/dialog-probe.ts` — already instruments dialog open/close for failure diagnosis; read it before adding anything.
- The genuinely custom surfaces, which keep their keyboard coverage: Layer reorder (hand-built because no library provides drag-to-reorder, and ADR-0016 makes the keyboard path the contract and the drag the convenience); Control Point pairing (ADR-0022, click-then-click); the Resource Mask handles; the annotation drawing tools; the Base Map switcher's keyboard reach.
- CONTRIBUTING's accessibility section — focus management is a criterion of every change that adds UI, so this ticket must not read as permission to stop testing it.

## Contract

- **The distinguishing question is: who implements the behaviour?** If the browser does, one assertion that we used the native element is enough and the rest is duplication. If this repository does, the keyboard path is the contract and stays at Seam 2.
- **"Focus returns to the button that opened it" stays wherever a dialog is opened from a control the app manages**, because focus restoration is the app's job even when the dialog is native. Do not retire these as platform tests.
- **Some of these can move to the component seam rather than being deleted** — a dialog's focus restoration is a component behaviour if a component owns the dialog. Prefer moving over retiring, per the epic's rule; check ticket 02's recorded divergences first, since focus is where a DOM implementation is most likely to differ.
- Produce the table of where each claim appeared and what happened to it. This is the ticket most likely to be read later as "when did we stop testing that", and the answer must be written down.

### User Stories

5, 9, 30.

## Out of scope

- Reducing accessibility coverage of custom widgets. If anything, this ticket should make it clearer where that coverage lives.
- Touching `viewer-reader.e2e.ts`'s keyboard block — the Reader's controls are protected by this epic and the Reader has no other seam.
- Changing any component to be more or less accessible.
- Adding a lint rule to enforce the distinction. A judgement about who implements a behaviour is not mechanisable.

## Acceptance criteria

- [ ] A table records every place each duplicated claim appeared, and its disposition: kept, moved, or retired with a reason.
- [ ] Every custom widget named above retains keyboard coverage at Seam 2.
- [ ] Every dialog retains exactly one assertion that it is a native `<dialog>` opened with `showModal()`.
- [ ] Focus-restoration claims are kept or moved, never retired as platform tests.
- [ ] `viewer-reader.e2e.ts` is unchanged.
- [ ] The full suite passes; count and wall time recorded before and after.
- [ ] `pnpm precommit lint check test` passes.

```bash
git diff --stat -- e2e/viewer-reader.e2e.ts    # must be empty
pnpm test:e2e
pnpm precommit lint check test
```

Success: platform behaviour is tested once, this repository's behaviour is tested everywhere it lives, and the table says which is which.

## Blocked by

- 02
- 08
