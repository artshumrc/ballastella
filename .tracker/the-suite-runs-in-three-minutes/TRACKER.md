# Tracker for the-suite-runs-in-three-minutes

## Purpose

This document tracks the status of all tickets in the epic.

The goal of `the-suite-runs-in-three-minutes` is to take `pnpm test:e2e` from thirteen minutes to two or three by **moving** claims out of Playwright and into component-and-DOM tests in Node — and by fencing the result so it cannot grow back.

**Moving, not removing.** Playwright and Seam 2 stay: they are the only place the application is proved to work with real MapLibre, real OPFS, a real service worker and a real static server underneath it. What leaves is the large body of claims about the interface's own behaviour and about pure logic, which lived at Seam 2 only because `apps/editor` had no DOM and there was no seam between a class with no DOM and the whole application. The suite may well end up with *more* tests in total; what has to fall is time at Seam 2.

Scope, the seam boundaries, and the measured baseline are in [SPEC.md](./SPEC.md); the standing testing rules are in [ballastella-v1's SPEC](../ballastella-v1/SPEC.md#testing-decisions) and [CONTRIBUTING](../../CONTRIBUTING.md); vocabulary is in [CONTEXT.md](../../CONTEXT.md).

## Current Status

Overall status: `In Progress`

Current ticket: 01–12 complete; 13 and 14 remain, then 15 closes the epic.

### Measured end state — full run, uninterrupted, 2026-08-14

| | Epic start | Now |
| --- | --- | --- |
| Seam 2 tests | 675 | **628** |
| Wall clock | 13m 04s | **10m 17s** |
| Worker-seconds | 2998.6 | **2395.2** |
| Per test | 4.44 | **3.82** |
| Component seam (Node, no browser) | — | **84 tests, 0.66s** |

**−21% wall, −20% worker time**, and one test deleted in the whole epic. 626 passed, 1 skipped, 1
flaky, **0 failed**. The one retry was `viewer-reader:2472`, which a stashed-baseline comparison put
at 2 failures in 6 unmodified runs — it is not new. `editor-remote-binding`'s sign-in fault did not
fire this run, which is what a fault that fails *more* on an idle box does; it is still open (lead 8).

⚠ **The target was two to three minutes and this is ten.** What remains is not migration work:

- **The worker count.** 4 → 10 measured 1.5× on this box. One line, no coverage cost, and the only
  remaining lever that reaches the target. The default of 4 is a shared-machine policy, so it stays a
  decision rather than a ticket.
- **Seam 2's floor.** At 628 tests and 3.82s each, most of what is left is the fixed cost of booting
  the built application over software-rasterised WebGL. Cutting from here trades coverage for time at
  about four seconds a test, and the dearest tests are disproportionately the map-driven ones that
  only Seam 2 can prove.

### What the migration found that was not about speed

Each migration had to prove its claim could still fail. That requirement, not the tickets, produced
the epic's most durable results:

- **DOMPurify is inert under `happy-dom` and reports `isSupported === true`.** `renderDescription`
  returns `<img src=x onerror=alert(1)>` with the element and the handler intact. The Annotation
  description surface therefore never moved to Seam 1c, and the config carries a standing prohibition.
- **`happy-dom`'s `DragEvent` drops `dataTransfer` and `relatedTarget`.** Every drag claim stays at
  Seam 2; dispatching a `MouseEvent` named `dragleave` would have made them pass against a fake.
- **The viewer promised Readers something it could not do** — see the tile-recovery entry below.
- **A back-off guarantee could have been deleted with every test green**, until the test was made to
  straddle each step.

### The tile recovery fix — a product fault found by a slow test

`viewer-reader:2524` cost 99.6 worker-seconds and was recorded as a habitual flake to be absorbed by
the retry budget. It was a 20–40% hard failure. The renderer re-asks for a refused `info.json` on
every painted frame, and MapLibre paints none when nothing changes, so recovery depended on an
unrelated straggler repaint; in front of a settled map the notice stayed up for ever, while the
viewer told the Reader the map picks up what it can by itself. A bounded schedule of repaints now
supplies the frames — **advanced by delivered frames rather than wall clock**, because
`triggerRepaint()` is a no-op while a frame request is outstanding and `requestAnimationFrame` does
not fire in a background tab, which cost 5 of 7 re-asks in a measured backgrounding. Eleven re-asks
over 151,750ms of painted time, then it stops. The test now costs ~3s.

Ticket 03 added the cost profile. **[COST-PROFILE.md](./COST-PROFILE.md) is the measured per-spec table
every later ticket targets by**, regenerated with one command:

```bash
pnpm test:e2e --profile
```

It appends `scripts/cost-profile.mjs` to the reporter list rather than replacing it — never spell this
`--reporter=…`, which drops the retry budget — and ranks by **worker-seconds**, the time a worker spent
inside a test summed over its attempts, because that is what moving a claim to another seam removes.

⚠ **Three of the spec's four known figures were wrong, and the priority order changes.** Measured over
the full run — 668 tests counted, plus the one deliberate skip, which costs a worker nothing and is
kept out of the denominator: the whole-suite average is **4.49 worker-seconds per test, not ~1**;
`editor-annotations` is **9.63, not ~11.8**; `viewer-reader` is **4.14, not ~2.5** — it is the third most
expensive file in the suite rather than a cheap one, and it is also the one the spec protects.
`editor-layers` at **10.19** is the figure that came closest to holding. Specs the spec's table never
named cost as much per test as `editor-annotations` does or more: `editor-align-referenced` (10.34),
`editor-undo` (9.15) and `editor-alignment-refinement` (9.04), with `editor-offline-copy` (7.94) and
`editor-alignment` (6.34) behind them. The map-free remote family is confirmed cheap —
`editor-clone-remote` 1.06, `editor-review-remote` 2.07, `editor-remote-binding` 2.60 and
`editor-github-signin` 2.69 per test, 166.3 worker-seconds for 78 tests — which is ticket 13's answer.

Ticket 02 moved the component seam out of Vitest's browser mode and into Node against `happy-dom`. The
13 ported claims all held there — none went back to Seam 2 — and a fourteenth was added: the
disabled-focus divergence, re-asked inside the suite against the real component so the seam cannot
quietly stop deserving the two claims that turn on it. Measured over three runs each: **tests
1.04–1.08s → 0.09–0.11s, wall clock 2.88–3.04s → 2.34–2.40s**, and no browser process at any point.
`@testing-library/jest-dom` is a new dependency, matchers only.

Groundwork, verified and measured under ticket 01:

- `fullyParallel: true`, and the obsolete "eight workers bought 19%" note corrected in place with a re-measurement (4 workers 314s, 10 workers 206s on a heavy 156-test sample).
- `workers` overridable by environment; the default stays 4 for the shared-machine reason, which the benchmark never was.
- A Historical Map's pyramid recorded once per build and replayed into OPFS, replacing a per-test ingest through the interface.
- A component seam for `apps/editor` — the fourth seam — with 13 component tests running in 993ms. ⚠ **Built in Vitest's browser mode, which is not the target.** It takes a Chromium process per run for claims that touch no OPFS, no WebGL and no service worker. Converting it to Node against a DOM implementation is ticket work, and the spec records the fidelity caveats — focusability of disabled controls above all — that decide which claims can follow it there and which stay at Seam 2.
- `editor-layers` reduced 42 → 36 Seam 2 tests.

**Full suite: 13m 04s / 675 tests → 10m 55s / 669 tests. A 16% saving, and that is all configuration can buy.** The remaining 75% is the migration work this epic's tickets will carry.

Two faults predating this epic are **not** in scope here. Ticket 05 measured both and wrote them up as
leads 8 and 9 in [`workspace-and-layers`'s TRACKER](../workspace-and-layers/TRACKER.md#open-leads--unclosed-and-not-to-be-absorbed-into-the-flake-budget),
where the reproductions, the runs and the two refuted hypotheses live. Neither is fixed; neither test is
skipped. What every later ticket needs from them is the profile below.

### The expected failure profile of an unmodified run

**At most 1 failed, 0–2 flaky, 1 skipped — and every red or retried test is in `editor-remote-binding`
or `viewer-reader`.** Anything else is this epic's doing and must be explained rather than absorbed.

⚠ **The spec's "1 failed, 1 flaky" was a snapshot, not a prediction.** Measured across five runs on
2026-08-13, all against identical application code (`git diff 780097f..d8d17d2 -- apps/editor/src
apps/viewer packages` touches only a component-test harness):

| Run | Failed | Flaky |
| --- | --- | --- |
| ticket 01, full suite | 1 — `viewer-reader:2524`, failing its retry | 0 |
| ticket 03, full suite unprofiled | 1 — `editor-remote-binding` | 2, neither a notice test |
| ticket 03, full suite profiled | 1 — `editor-remote-binding` | 1 — `viewer-reader:2472` |
| ticket 03, regenerated | 1 — `editor-remote-binding` | 1 — the `viewer-reader` notice |
| ticket 05, `viewer-reader` alone | 0 | 1 — `viewer-reader:2524` |

So the count of failures **is not stable at 1**, and which of the two faults is red on a given run is
not stable either. A ticket comparing profiles compares the *files*, not the numbers: the question to
answer is "is anything red that is not one of these two tests", and after that, "did the suite's own
count of tests change".

The one skip is `editor-retry-budget-control.e2e.ts`'s deliberate control test, not a quarantine.

### Ticket 01's verification run — 2026-08-13, same 20-core box, not otherwise idle

| Command                                             | Result                                                 |
| --------------------------------------------------- | ------------------------------------------------------ |
| `pnpm precommit lint check test`                     | exit 0 — lint 15.9s, check 10.5s, test 14.4s, total 40.8s |
| `pnpm test:e2e`                                      | **12m 54s wall**, 669 tests, 4 workers: 667 passed, 1 failed, 1 skipped, 0 retried |
| `pnpm test:e2e editor-alignment-refinement.e2e.ts` after `rm snapshot-*.json` | 21 passed in 40.1s, recording remade with no intervention |
| the same again after a tiler edit and rebuild        | 21 passed in 34.7s, a **second** `snapshot-alignment-*.json` written under the new fingerprint |
| `BALLASTELLA_E2E_WORKERS=10 pnpm test:e2e editor-layers.e2e.ts` | "Running 36 tests using 10 workers", 36 passed in 1.3m |

The one skip is `editor-retry-budget-control.e2e.ts`'s deliberately skipped control test, not a quarantine.

⚠ **The observed failure profile was not the "1 failed, 1 flaky" the spec predicts, and the two halves
swapped.** `editor-remote-binding` › "a first visit › shows no sign-in affordance anywhere" **passed**,
in 378ms, having been described as deterministic; the failure was `viewer-reader` › "takes the notice
down by itself when the map's own record answers again", which failed its retry rather than passing on
it. Ticket 05 writes both faults up and now has a third observation to reconcile: neither fault is as
stable as the spec records. Nothing else was red.

⚠ **12m 54s against the 10m 55s recorded above.** Both are wall times on a shared box measured minutes
apart in configuration terms, so the difference is load rather than a regression — the retry budget
recorded zero retries, which is what a contention-bound run does not usually manage. Treat the
configuration saving as real but the absolute number as ±2 minutes until ticket 03 profiles per test.

### Ticket 03's verification run — 2026-08-13, same 20-core box, not otherwise idle

| Command | Result |
| ------- | ------ |
| `pnpm test:e2e --profile` | **13m 05s wall**, 669 tests: 666 passed, 1 failed, 1 flaky, 1 skipped; 2998.6 worker-seconds over the 668 that ran |
| `pnpm test:e2e` (no profiler, back to back) | **15m 50s wall**, same 669 tests and the same verdict: 665 passed, 1 failed, 2 flaky, 1 skipped |
| `BALLASTELLA_E2E_RETRY_CONTROL=1 BALLASTELLA_E2E_RETRY_BUDGET=0 pnpm test:e2e --profile e2e/editor-retry-budget-control.e2e.ts` | exit 1, "retry budget exceeded" — the fence still fires with the profiler attached |
| the same with `BALLASTELLA_E2E_RETRY_BUDGET=1` | exit 0 — so the failure above was the budget's and not the test's |

**The profiled run was the faster of the two**, which is the answer to "does profiling change what it
measures": the reporter's cost is a map write per test, and the ~2¾-minute spread between two runs
minutes apart is this shared box's load. ⚠ It is also the honest size of the noise in every wall time
in this epic — **worker-seconds are the number to compare across tickets, and that is why the profile
reports them.**

`editor-remote-binding` › "shows no sign-in affordance anywhere" failed in both runs — the fault the
spec calls deterministic and ticket 01's run saw pass. The flake did not hold still: the unprofiled run
had two and the profiled run one, and only the profiled run's was the `viewer-reader` notice test the
spec names. Ticket 05 has the reconciliation.

### Ticket 05's verification runs — 2026-08-13, same 20-core box, `d8d17d2`

Ticket 05 changes no code and no test. It runs to gather evidence, and these are the runs the two
leads are written from.

| Command | Result |
| ------- | ------ |
| `pnpm test:e2e editor-remote-binding.e2e.ts` | 1 failed of 20 in 52.9s — the sign-in-affordance test, failing **both** attempts |
| `pnpm test:e2e editor-remote-binding.e2e.ts --repeat-each=5 -g "shows no sign-in affordance anywhere"` | **2 failed, 3 passed** (27.0s) |
| the same with a `navigation-bar` wait added before the assertions, then reverted | **2 failed, 3 passed** (25.8s) — the probe changed nothing |
| `BALLASTELLA_E2E_WORKERS=1` and the same `--repeat-each=5` | **5 failed of 5**, every attempt |
| `pnpm test:e2e viewer-reader.e2e.ts` | 62 passed, **1 flaky** in 1.9m — `:2524`, failed 49.2s then passed on retry in 3.4s; retry budget 1.59% of 3% |

Passing attempts of the sign-in-affordance test finish in 378–616 ms; failing ones spend the full 10 s
`toHaveCount` timeout. **The unloaded run is the one that fails**, which is the opposite of the usual
shape and is why "deterministic" was never quite the right word for it.

### After tickets 06, 09, 10 and 12 — 2026-08-13, quiet box

| Spec | Tests before | Tests after |
| --- | ---: | ---: |
| `editor-annotations` | 51 | 40 |
| `editor-base-map` | 47 | 36 |
| `editor-transfer` | 37 | 30 |
| `editor-publish` | 30 | 27 |

Seam 2 total 669 → **637**; the fence is lowered to match. Failures were the two faults ticket 05
recorded and nothing else: `editor-remote-binding`'s sign-in affordance and `viewer-reader`'s notice
test, 0 retries against a 3% budget.

**Open, and needing a human:**

1. The epic's priority table was built from figures ticket 03 disproved. Following the measurement
   means new tickets for `editor-undo` and `editor-alignment-refinement`, which is scope this epic
   did not authorise.
2. `viewer-reader` is 330 worker-seconds of coverage story 31 and ADR-0006 protect. The 2–3 minute
   target is unlikely to be reachable without a decision about it.
3. Ticket 06 left the Annotation sidebar row's name surface unasserted at Seam 2; its proper home is
   Seam 1c, which ticket 07 covers.

### The slow-test pass — 2026-08-13, authorised outside the ticket ledger

The user authorised attacking the slow specs directly, and cutting tests where necessary. Four specs
were worked in isolated worktrees, which is also how the e2e port collisions of the parallel round
were fixed — a worktree derives its own ports.

| Spec | Worker-seconds | Tests | How |
| --- | --- | --- | --- |
| `editor-layers` | 485 → 267 | 36 → 36 | fixtures seeded from a recorded Workspace |
| `editor-annotations` | 397 → 314 | 40 → 39 | seeded; one claim retired to Seam 1 |
| `editor-alignment-refinement` | 177 → 123 | 21 → 19 | a shared 3s sleep replaced by a poll; the picker rehoused to Seam 1c |
| `editor-undo` | 172 → 155 | 14 → 14 | seeded |

**The cost was per-test setup, not the assertions, and not the `waitForTimeout` calls.** 23 of
`editor-layers`' 36 tests drove the whole journey through the interface — Project, ingest through the
real file picker, navigation, three Control Point pairs across two live map panes, a warped solve —
before the first assertion ran. The recorded-Workspace mechanism ticket 01 landed already existed to
stop exactly that; three specs were not using it. The 32 `waitForTimeout` calls across the suite were
a red herring: all four in `editor-layers` came to 9.5s out of 400s.

⚠ **A spec's floor is its longest test.** `editor-annotations` lost 11 tests in ticket 06 and ~60% of
its CPU time, and its wall clock did not move: one Pin-under-a-Historical-Map test cost 24s and the
file could not finish before it did. That test is now ~11s — it had been driving a full alignment as
scenery — but the principle holds and is why count was always the wrong axis.

**Three things that did not work, recorded because each was nearly reported as a saving:**

1. A settled-view wait substituted for two sleeps in `editor-layers` reopened the race the sleeps
   guard — the opening-view fit is a *second* read of the Layer documents, ordered against the
   sidebar's own by nothing. Its failure mode is a silent vacuous pass, not a red run. Reverted, and
   the sleeps carry the reasoning now.
2. `editor-annotations`' first "after" run measured *worse* than its baseline (548s against 529s)
   because the recordings were cold and each of four workers paid to capture one. Warm, the same code
   was 404s.
3. `editor-undo`'s first before/after pair said −29%; the same pair in reverse order said +7%. Under
   sibling load the drift within a round exceeded the effect. Only an ABBA design over 28 runs gave a
   number worth quoting.

⚠ **`viewer-reader`'s 99.6s test is a product fault and was left alone.** See lead 8. Six instrumented
runs: it recovers in under a second when an unrelated repaint happens to follow, and never at all when
none does — MapLibre paints no frames when nothing changes, and nothing calls `triggerRepaint()` when
a tile-source failure resolves. The viewer tells a Reader "the map picks up what it can by itself",
which for a settled map is false. It cannot be made fast, cannot move down a seam, and should not be
deleted — it is the only thing asserting the promise. **It needs a product decision.**

### Where the suite stands after the slow-test pass — full run, quiet box, 2026-08-13

| | Epic start | Now |
| --- | --- | --- |
| Tests | 675 | **634** |
| Wall clock | 13m 04s | **10m 48s** |
| Worker-seconds | 2998.6 | **2551.3** |
| Per test | 4.44 | **4.03** |

**−17% wall, −15% worker time.** One failure, the `editor-remote-binding` product fault of lead 8; zero
retries against a 3% budget. The `viewer-reader` notice test passed on this run, which is what a
20–40% intermittent fault does.

The target is two to three minutes and this is ten and a half. What is left, measured:

1. **The `viewer-reader` product fault** — up to 100 worker-seconds, and blocked on a product decision
   rather than on test work.
2. **The worker count.** 4 → 10 measured 1.5× on this box. It is one line and it is the only remaining
   lever that reaches the target; the default of 4 is a shared-machine policy this epic declined to
   overturn, so it stays a decision rather than a ticket.
3. **Tickets 07, 08 and 11** — the Seam 1c cluster that the `editor-layers` and `editor-annotations`
   work both identified independently: roughly 30 tests in `editor-layers` and the annotation panel's
   fields, picker and keyboard reachability. Worth perhaps another 100–150 worker-seconds, and worth
   more than that as coverage.

⚠ **Seam 2's floor is now visible.** At 634 tests and ~4s each, the fixed cost of booting the built
application over software-rasterised WebGL is most of what remains. Cutting tests from here trades
coverage for time at roughly four seconds a test, which is the trade the epic exists to avoid making
blindly.

Last updated: 2026-08-13

## Ledger

Tickets 01–05 are groundwork and instrumentation; 06–14 are the migration, orderable by whoever picks them up; 15 closes the epic.

**06, 09, 10 and 12 depend only on 01** and can run in parallel with the component-seam work — they rehouse to Seam 1, which already exists.

| Number | Filename                                                       | Status      | Depends On                         |
| ------ | -------------------------------------------------------------- | ----------- | ---------------------------------- |
| 01     | 01-land-the-scheduling-and-recorded-workspace-groundwork.md      | Completed   | —                                  |
| 02     | 02-move-the-component-seam-into-node.md                          | Completed   | 01                                 |
| 03     | 03-profile-seam-2-by-cost-per-test.md                            | Completed   | 01                                 |
| 04     | 04-fence-the-size-of-seam-2.md                                   | Completed   | 01                                 |
| 05     | 05-record-the-two-pre-existing-faults.md                         | Completed   | 01                                 |
| 06     | 06-rehouse-the-annotation-document-claims.md                     | Completed   | 01                                 |
| 07     | 07-rehouse-the-annotation-interface-claims.md                    | Not Started | 02, 06                             |
| 08     | 08-finish-the-layer-stack-migration.md                           | Not Started | 02                                 |
| 09     | 09-rehouse-the-base-map-arithmetic-and-catalog-claims.md         | Completed   | 01                                 |
| 10     | 10-rehouse-the-project-bundle-refusals.md                        | Completed   | 01                                 |
| 11     | 11-rehouse-the-workspace-and-project-screen-claims.md            | Not Started | 02, 03                             |
| 12     | 12-rehouse-the-publish-output-claims.md                          | Completed   | 01                                 |
| 13     | 13-decide-the-remote-family-by-measurement.md                    | Not Started | 03, 05                             |
| 14     | 14-consolidate-the-duplicated-platform-and-keyboard-claims.md    | Not Started | 02, 08                             |
| 15     | 15-close-the-epic-lower-the-fence-and-record-the-cost.md         | Not Started | 04, 06, 07, 08, 09, 10, 11, 12, 13, 14 |

## User story coverage

All 45 stories in [SPEC.md](./SPEC.md) are claimed by at least one ticket. The mapping is in each ticket's **User Stories** section; stories 5 and 9 — rehousing rather than deleting, and naming a retired test's new home — are carried by every migration ticket rather than by one.
