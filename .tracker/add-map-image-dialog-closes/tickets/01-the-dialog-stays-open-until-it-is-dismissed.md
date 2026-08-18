# 01 — The Add-Map-Image dialog stays open until it is dismissed

## The problem

A scholar opens Add Map Image, the dialog appears, and it closes under them before they can click anything in it. The end-to-end suite sees this as a click that waits 172 seconds on a button that is present and laid out but not visible.

The dialog is closing after the code that opened it has already confirmed it open.

## What is already measured

Read [TRACKER.md](../TRACKER.md)'s "What is already known" first and do not re-derive any of it. In particular: **it is not load** (the number is there), **it is not `nothing-fails-silently`**, and the signature is documented in `e2e/support/map-images.ts` as the bug `HTMLDialogElement.open` was supposed to fix.

## What to do

Find what closes the dialog in the window between `openAddMapImage` verifying `HTMLDialogElement.open === true` with all three sources visible, and the click on `remote-read` landing.

**Instrument first.** The failure is intermittent at roughly 1 run in 3 of the full suite and does not reproduce in isolation — 16 of 16 green across two prior attempts. Do not try to reason it out from the source. Candidates worth capturing rather than guessing between:

- a re-render that recreates the `<dialog>` element, so `.open` is true of a node that is then replaced;
- a focus or click-outside handler firing on the gesture that opened it;
- an `Escape`/form-submit path closing it natively;
- a state update from an in-flight request landing after open and resetting the pane.

The instrumentation must survive the suite: capture *why* the dialog closed, at the moment it closes, so one failing run explains itself. A run that fails and tells you nothing costs another hour of matrix.

## Acceptance criteria

- [ ] The cause is named, with captured evidence from a failing run rather than a plausible story. If it cannot be reproduced under instrumentation, that is recorded as such, with what was ruled out — "still open, and here is what it is not" is a complete answer here.
- [ ] `e2e/editor-align-referenced.e2e.ts:735` does not retry across a full-suite run. State the `n`; one green run is not the number.
- [ ] The fix has a mutation check: break it, watch the guard go red, restore, record what was broken.
- [ ] If `openAddMapImage`'s `.open` check is kept, it is either shown to be load-bearing or replaced by one that is. It currently passes and then the thing it checked stops being true.
- [ ] `e2e/support/map-images.ts`'s comment is corrected — it presents this as fixed.

## Out of scope

- **Whether alignment should have several entry points at all.** A real question, deliberately unscoped, and larger than this bug.
- **The retry budget.** It is doing its job: it surfaced this. Do not raise it, and do not pass a `--reporter` override to quiet it.
