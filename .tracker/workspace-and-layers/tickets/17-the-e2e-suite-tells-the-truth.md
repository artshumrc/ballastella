# The e2e suite tells the truth

## What to build

A suite whose failures mean something. Today's does not, and every ticket in this epic has paid for it.

`playwright.config.ts` already says so in a comment: the suite "flaked in roughly one full run in three — a *different* test each time, never reproducible in isolation", and `retries: 1` on CI makes it green anyway. That comment then draws the wrong conclusion — that the flake is acceptable because it is contention. **A suite that flakes at one in three is a suite that can absorb a genuine race without anyone noticing**, which is the failure mode this epic has been fighting in every other form.

Four implementers in this epic independently lost time to it, and their reports disagree about the rate: one measured 11 failures in a run, another 17, another 8 — of which "7 were `Protocol error … session closed` (browser crashes)". Browser crashes are not test contention. Nobody has separated the causes.

One cause is already fixed and is not this ticket: fixed ports 4173/4174 with `reuseExistingServer` meant parallel checkouts silently tested each other's builds. Ports now derive from the checkout path. **Some unknown share of the historical flake was that, and the first job here is to find out how much.**

## Where to start

- `playwright.config.ts` — `workers: 4`, `retries`, and the comment that needs to end up true.
- `e2e/support/` — the shared fixtures and helpers. Several reports point at helpers that await visibility rather than a settled state; ticket 01 fixed one such race properly (`openMirrorDialog` now awaits a published step) and that is the model.
- Named as flaky by implementers, all of which "passed in isolation": `editor-transfer` ("says so when an export fails" — the Export button detaches mid-click), `editor-workspace` (the save indicator's `saved → saving → saved`), `viewer-reader:1286`, `editor-layers:1046`, `editor-workspace:336`, `editor-stored-image-pane:200`.

## Measured before you start, 2026-08-07 — do not re-derive these

One clean full run, `--reporter=json`, 4 workers, 20-core machine:

```
398 tests   1363 worker-sec   399s wall   mean 3.42s   median 2.48s
top 4 slowest =  5.7% of total      top 20 = 19.2%
top 10        = 11.4% of total      top 40 = 31.8%
```

Four things that follow, each of which contradicts a plausible plan:

- **There is no fat tail.** Deleting the ten slowest tests outright buys 11% of the suite. The four
  `test.slow()` tests are not even the slowest; the top of the list is `editor-layers`,
  `editor-annotations` and `editor-undo`. Do not go hunting for hotspots — the distribution is broad.
- **Parallelism is already near its ceiling.** 1363 worker-seconds into 399s wall is 85% efficiency,
  and 8 workers measured only 19% faster (360s against 444s) before being declined for the reason in
  `playwright.config.ts`. There is no idle to reclaim.
- **The tests are at the right altitude.** Three independent audits classified all 398: 379 stay, 19
  could move to a cheaper seam, worth about 16 seconds of wall clock. The clearest three do no
  browser work at all — `editor-base-map.e2e.ts:702,721` and `viewer.e2e.ts:15` take no `page`
  fixture and pay full harness cost for `node:fs` reads. Take those three; weigh the rest against
  what each would stop proving.
- **Software rendering is the floor.** Headless Chromium reports SwiftShader here even with
  `--use-gl=angle --use-angle=gl-egl --enable-gpu --ignore-gpu-blocklist` forced, on a machine with a
  working Intel GPU at `/dev/dri/renderD128`. GPU acceleration is not available to be turned on.

**So this ticket is about trust, not speed.** ~7 minutes for 398 real-browser tests is close to
inherent, and the iteration answer is to run the named specs for a ticket rather than the suite. What
is actually broken is that a run cannot be believed: the flake was measured at roughly one in three
across four implementers and a dozen runs, with a *different* set failing each time and every one
green when re-run alone. The run these numbers come from was clean — 398 passed, 0 flaky — which is
what one in three looks like and is not evidence of health.

Two leads that the numbers do support: `e2e/` holds **28 fixed-wait sites** (6 × 2s, one 5s, one
3.5s, three 3s `idle` fallbacks in shared helpers whose own comment says the event "does not fire
when the view did not actually change"), and `pnpm flake:check` now automates the re-run-then-compare
triage so a verdict costs one command.

## Contract

**Measure before changing anything.** Ten full runs on the current `main` with the port fix in place, recording every failure and its error. Split them into: browser crashes (`Protocol error`, `Target closed`), timeouts awaiting a transient state, and genuine assertion failures. The three have different fixes and lumping them together is what produced "it's just contention".

**A test that awaits a transient state is a broken test, not a flaky one.** The `saved → saving → saved` shape cannot be observed reliably by polling and must not be asserted that way. Assert the settled state and the fact that the transition happened — a published step, a count, a recorded sequence — rather than trying to catch the middle frame.

**`retries` must not hide a race.** Whatever the final number, a retried test has to be visible in the run's output, and the suite must fail if the retry *rate* exceeds a threshold. Green-after-retry is data, not success.

**`workers` follows the measurement.** If browser crashes dominate, fewer workers is the fix and the comment should say so with a number. If they do not, four may be leaving time on the table. Either way the comment states what was measured, when, and on what hardware — the current one states a rate with no date and no method.

**The suite should be quicker to run once.** Each invocation currently rebuilds both apps via `webServer.command`. Reusing a build that is already current is the obvious win; measure it before and after and put the number in the report.

## Out of scope

- Rewriting tests to assert less. If a test is hard to stabilise because the behaviour it asserts is genuinely racy, **that is a bug in the app** — report it, do not weaken the assertion.
- Any change to what the suite covers. No test is deleted in this ticket.

## Acceptance criteria

1. A recorded measurement of ten consecutive full runs on `main`, with every failure classified as crash, transient-state timeout, or assertion. Written into the ticket, with the date and the machine.
2. Each named flaky test above is either fixed at its cause or recorded as an app bug with a filed follow-up. For each one fixed, `--repeat-each=10` passes.
3. The flake rate after the work is measured over ten further full runs and stated as a number.
4. `playwright.config.ts`'s comment about workers and flakiness matches that measurement, with its date.
5. A retried test is visible in the output, and the suite fails when the retry rate crosses a stated threshold.
6. Single-run wall-clock time before and after, stated.
7. `pnpm -r build && pnpm -r test && pnpm lint && pnpm check` passes.

The mutation check applies to criterion 5: break the retry-rate threshold and confirm the suite fails.
