# Tracker for add-map-image-dialog-closes

## Purpose

The Add-Map-Image dialog closes by itself, after the code that opened it has already confirmed it open. It was found as an intermittent end-to-end failure, and it was measured rather than argued about: it is **not load** and **not** the epic that surfaced it.

One ticket. This is a bug report with a measurement attached, not a feature.

## Current status

**Completed and merged**, 2026-08-09.

The cause was named with captured evidence and the fix is test-support only — no product code changed. `EditorSession.#addMapLayer` publishes the new Layer (rendering `layer-row`) and *then* awaits the trailing `project.json` write, which is when the dialog closes. `addReferenced` returned inside that window, and the next `ensureAddMapImageOpen` asked `HTMLDialogElement.open`, got `true`, and handed back a dialog it never re-opened.

**`.open` was never the wrong fact. It was the wrong question** — it answers "open at this instant" where the callers meant "open and mine to use."

Measured: `layer-row` at 597.2 ms against the close at 632.2 ms, a **35 ms window**; and under a 20x CPU throttle a caller returning at the row was answered `open: true`.

`n = 6` full-suite runs post-fix with no retry of `editor-align-referenced.e2e.ts:735`, against a measured ~1-in-3 rate before — roughly a 1.4% chance of six clean misses. The mutation check (removing the settle wait) goes red twice.

**The honest limit:** the original 172-second failure was never captured in the wild. The weight sits on the two direct measurements of the mechanism and on the mutation check, not on the green runs.

**A residual, stated:** `addReferenced` still returns while the add's `project.json` write is in flight. Only the *dialog* question is now safe; anything a spec does immediately afterwards that assumes the write has landed is still racy, and `support/saved.ts` is what exists for that.

## An observation from the same measurement, not attributed

`editor-undo.e2e.ts:331` — *reverses the pairing now on screen, keeping a pair made after the round trip* — retried once. Counts, not a rate: **0 of 3 pre-fix full runs, 1 of 6 post-fix full runs.**

One observation is not enough to attribute and it is deliberately not attributed here. Two things a future measurement should weigh rather than assume: this ticket added a `page`-fixture console collector that runs in **every** spec, which is a global timing change; and this repository has been wrong four times by calling a retry load and finding a defect underneath. If it recurs, produce the number before producing a story.

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

**It has been seen before, and the previous fix is incomplete.** `e2e/support/map-images.ts` documents this exact signature — "element is not stable, twice, then element is not visible, 111 times" — as the bug that `HTMLDialogElement.open` was introduced to fix. `openAddMapImage` verifies `open === true` and all three sources visible, and the dialog closes anyway *after* that check passes. So something closes it in the window between the helper's check and the click.

**Exit codes never surfaced this.** All four runs exited 0: the retry budget allows 2 flaky of ~523 and no run had 2. It is visible only in the reporter's per-retry line — which is why the standing rule against passing a `--reporter` override on the command line exists.

**Not measured, and therefore not claimed:** any workers=1 or workers=2 cell, on any commit. So "load *widens* an existing window" is unproven. Only the "pre-existing" half is established.

## Where to start

The defect is in the app or in the helper, not in the harness. `openAddMapImage`'s check passing and the dialog then closing is the whole of it. Instrument that window rather than reasoning about it — the epic this came from spent four rounds learning that a plausible story is not evidence.

## Ledger

| Number | Filename | Status | Depends On |
| --- | --- | --- | --- |
| 01 | [01-the-dialog-stays-open-until-it-is-dismissed.md](./tickets/01-the-dialog-stays-open-until-it-is-dismissed.md) | Completed | — |
