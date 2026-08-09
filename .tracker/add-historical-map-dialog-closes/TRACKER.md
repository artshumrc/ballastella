# Tracker for add-historical-map-dialog-closes

## Purpose

The Add-Historical-Map dialog closes by itself, after the code that opened it has already confirmed it open. It was found as an intermittent end-to-end failure, and it was measured rather than argued about: it is **not load** and **not** the epic that surfaced it.

One ticket. This is a bug report with a measurement attached, not a feature.

## Current status

**Not Started.** Sliced 2026-08-09, out of the `nothing-fails-silently` epic, where it was measured and explicitly ruled out of scope.

## What is already known — do not re-derive it

The measurement was made on an exclusive box with nothing else running, four full-suite runs, no reporter override.

**It is not load, and this is the number.** The passing retry ran under *identical* concurrency to the failure — same run, same 4 workers, dispatched as test #169 of 523 with roughly 350 tests still in flight — and finished in **11.5–23.8 s against the failed attempt's 180 s**. Load was not lower when it passed. Contention makes work slow; it does not make a laid-out button vanish for 172 consecutive seconds and never return.

**It is not `nothing-fails-silently` ticket 04.** It reproduces on `7868a4b`, one commit *before* that ticket existed, with an identical stack and an identical call log.

**The mechanism is a stuck state, not an exhausted timing margin.** `locator.click` on `getByTestId('remote-read')` (`e2e/editor-align-referenced.e2e.ts:113`, inside `addReferenced`, reached from `:735`) logs:

```
- locator resolved to <button … data-testid="remote-read">Look up</button>
- attempting click action
  2 × waiting for element to be visible, enabled and stable
    - element is not stable
  345 × waiting for element to be visible, enabled and stable
    - element is not visible
```

345 polls at 500 ms is about 172 s of an already-resolved, already-laid-out button being *not visible*, until the 180 s `test.slow()` budget expired.

**It has been seen before, and the previous fix is incomplete.** `e2e/support/historical-maps.ts` documents this exact signature — "element is not stable, twice, then element is not visible, 111 times" — as the bug that `HTMLDialogElement.open` was introduced to fix. `openAddHistoricalMap` verifies `open === true` and all three sources visible, and the dialog closes anyway *after* that check passes. So something closes it in the window between the helper's check and the click.

**Exit codes never surfaced this.** All four runs exited 0: the retry budget allows 2 flaky of ~523 and no run had 2. It is visible only in the reporter's per-retry line — which is why the standing rule against passing a `--reporter` override on the command line exists.

**Not measured, and therefore not claimed:** any workers=1 or workers=2 cell, on any commit. So "load *widens* an existing window" is unproven. Only the "pre-existing" half is established.

## Where to start

The defect is in the app or in the helper, not in the harness. `openAddHistoricalMap`'s check passing and the dialog then closing is the whole of it. Instrument that window rather than reasoning about it — the epic this came from spent four rounds learning that a plausible story is not evidence.

## Ledger

| Number | Filename | Status | Depends On |
| --- | --- | --- | --- |
| 01 | [01-the-dialog-stays-open-until-it-is-dismissed.md](./tickets/01-the-dialog-stays-open-until-it-is-dismissed.md) | Not Started | — |
