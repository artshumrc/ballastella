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

## Measured before the work — ten consecutive full runs on `main`, 2026-08-07

Commit `0deffe2`. Linux 6.17.0-1030-oem, 20 cores, 62 GB. **Not an idle machine** — the box's ordinary
services and other agents' processes were running throughout, which is the condition the suite is
actually used in. `workers: 4`, `retries: 0`, `--reporter=json`, 398 tests per run, 3980 test
executions.

```
runs with ≥1 failure          6 / 10
failures                      8 / 3980 executions = 0.20%
single-run wall clock         mean 444.2s   min 382.5s   max 485.2s
```

### Every failure, classified

| Run | Test | Class | Error |
| --- | --- | --- | --- |
| 2 | `editor-transfer` says so when an export fails | transient-state timeout | 30 s waiting for the Export button |
| 5 | `editor-pwa` fully usable with the network off | transient-state timeout | 30 s waiting for `align-historical-map` |
| 5 | `editor-stored-image-pane` two Historical Maps in one Project | test-budget exhaustion | `toHaveCount(2) … Received: 1` at the 30 s test timeout |
| 6 | `editor-pwa` fully usable with the network off | assertion | `TypeError … reading 'id'` in `annotationLayerId` |
| 7 | `editor-pwa` fully usable with the network off | transient-state timeout | 30 s waiting for `align-historical-map` |
| 7 | `editor-workspace` transitions saved → saving → saved | assertion | `Expected "saving", Received "saved"` |
| 8 | `editor-transfer` says so when an export fails | transient-state timeout | resolved the button, then `element was detached from the DOM` |
| 10 | `editor-workspace` transitions saved → saving → saved | assertion | `Expected "saving", Received "saved"` |

```
browser crashes                  0
transient-state timeouts         5
assertion failures               2
test-budget exhaustion           1
```

### The three things the classification settles

**Browser crashes do not happen here at all.** Not one `Protocol error`, `Target closed` or
`Page crashed` in 3980 executions. The earlier reports of 8, 11 and 17 failures per run — one of them
"7 of 8 were `Protocol error … session closed`" — all predate the port derivation in
`playwright.config.ts`. A run whose `vite preview` belongs to another checkout loses its server the
moment that run finishes, and every page in flight reports exactly those errors at once. **So the
crash half of the historical flake was the ports, and it was already fixed before this ticket
started.** That is also why `workers` stays at 4: fewer workers is the remedy for crashes, and there
are none.

**The remaining rate is not "contention". It is four bugs.** All 8 failures come from 4 tests, and
each has a cause that can be named, fixed and watched fail:

1. **`store.list` threw when a directory was deleted underneath it.** `collectFiles` in
   `directory-handle-store.ts` descended into a directory handle that had gone between the parent's
   `entries()` yielding it and the recursive call. `EditorSession.refreshHistoricalMaps` reads that
   as the Workspace being unreachable and replaces the hub — so the Export button was *detached*
   mid-click and never came back, which is what run 8 recorded. **A genuine app bug, not a test
   one**, and a serious one under ADR-0023: a colleague's sync client or a second tab deleting one
   file told a scholar their Workspace could not be reached. Fixed, with the split that matters —
   a vanished *descendant* is skipped, a vanished *root* still fails, because ADR-0008 needs a folder
   Workspace that has been unplugged to say so rather than to report an empty Workspace.
2. **`startProjectWithMap` returned when the Layer was on screen, not when it was on disk.** Every
   caller reloads immediately afterwards. Now waits for two published steps: the file input being
   re-enabled (the ingest is over) and the Layer being in `project.json`.
3. **`annotationLayerId` read `project.json` once, without waiting for it to have been written.**
   Now polls for the Layer to exist.
4. **The `saved → saving → saved` test polled for a state that is over in milliseconds.** Replaced
   with a `MutationObserver` that records every change, so the claim is a record rather than a race —
   and the test now asserts the sequence the app really publishes, which has four steps.

The fifth, the two-pyramid test, is not a race at all: it does two full ingests inside a 30 s budget
and sometimes does not finish. It has an explicit 120 s timeout with the reason attached.

**Contention did not cause any of them.** It widened the windows so they showed. That is why every
one of them "passed in isolation" and why four implementers reading them as contention were reading
the correlation and not the cause.

### The named tests that never failed

`viewer-reader:1286`, `editor-layers:1046`, `editor-workspace:336` and `editor-stored-image-pane:200`
did not fail once in 3980 executions. They are recorded here as not reproducing rather than as fixed;
nothing was changed for them.

## Measured after the work — ten consecutive full runs

Same machine, same day, same method. `retries: 1` now, so a first-attempt failure that passes on the
second shows as `flaky`; it is counted below exactly as a failure was counted above, because
green-after-retry is data and not success.

**Ten runs were measured twice, and the first ten are reported as well as the second.** The first set
was clean enough to be tempting and it was not the end: it turned up three more failures with three
more causes, none of which had appeared in the baseline ten. Reporting only the run that flattered
the work is the thing this ticket exists to stop.

| | before | after fixes 1–5 | after fixes 6–8 |
| --- | --- | --- | --- |
| runs with ≥1 failure | **6 / 10** | 2 / 10 | **1 / 10** |
| failures | **8** | 3 | **1** |
| test executions | 3980 | 3990 | 3990 |
| failure rate | **0.20%** | 0.075% | **0.025%** |
| failures surviving the retry | n/a (`retries: 0`) | 0 | **0** |
| browser crashes | 0 | 0 | 0 |

**The rate after the work is 0.025% — one first-attempt failure in 3990 test executions, in 1 of 10
runs, and nothing that survived a retry.** Down from 0.20% and from 6 runs in 10.

### What the first ten turned up, and what was done about it

- `editor-image-ingest:354` reloaded the page on the strength of a visible Layer row — the same
  defect as fix 2, in a test whose whole claim is that the Project *has* the map. Now waits for the
  file.
- `editor-layers` "reorders by keyboard alone" and "keeps focus on the same button" ran out of the
  default 30 s. `tabTo` walks the Tab order with two protocol round trips per press, and the two
  tests build a whole aligned Project first. Both now state a 90 s budget, and `tabTo` says what it
  costs.
- Reading those three together with the baseline's two-pyramid failure made the pattern plain, so
  **the two default budgets were raised as well**: assertions from 5 s to 10 s, tests from 30 s to
  60 s. Three of the eleven failures across the first twenty runs were real work that did not finish
  in time, and every one of them reported as an absence — indistinguishable from a broken assertion,
  which is how they came to be filed as contention.

### The one failure in the second ten, and the fix that came after it

`editor-alignment.e2e.ts` "the choice survives a reload" failed once with
`NotReadableError: The requested file could not be read`. Its `storedBaseMap` helper reads
`project.json` out of OPFS **without the retry that the identical read in
`e2e/support/alignment-workspace.ts` has carried since it was written**, and whose comment explains
exactly this: the app writes atomically (ADR-0017 rule 4), and a read landing inside the replace does
not return stale bytes, it raises. A second copy of a read, missing the thing the first copy exists to
document.

⚠ **That fix landed after the ten runs above, so the shipped tree is one change newer than the
0.025%.** It is stated rather than folded in. It can only remove a failure mode — it retries a read
and changes no assertion — and it is verified by `--repeat-each=10` on that describe block, but the
number in the table was not measured with it in place.

### Single-run wall clock (criterion 6)

The ten-run means are not comparable: the baseline ten ran at a 1-minute load average of ~20 and the
final ten at ~26–30, and the suite is CPU-bound. So it was measured as a **controlled A/B instead** —
one run on the stashed pre-change tree and one on this tree, sixteen minutes apart, same load:

```
before   471.3s   (1 failed)
after    474.2s   (398 passed, 0 flaky)
```

**Unchanged, +0.6%, inside run-to-run noise.** That is the honest answer and it contradicts the
ticket's expectation. The reason is in the numbers: a cold build of both apps is 8.1 s and a skipped
one is 0.04 s, out of ~470 s. Building once instead of twice-in-parallel is worth having for the
correctness reason above; it is not a speed story, and there is no speed story here — 398 real-browser
tests at 85% parallel efficiency on software-rasterised WebGL is close to inherent.

One incidental result: the pre-change control run failed `editor-project-screen.e2e.ts:456`, a test
that had not failed in any of the twenty measured runs and that passed on this tree in the very next
run. Another instance of the same family, found by accident, and the sort of thing that used to be
re-run and forgotten.

## What was found that this ticket did not ask for

- **`scripts/free-e2e-port.test.mjs` did not exist.** `free-e2e-port.mjs`'s comment said it "pins the
  parse" of the pid-0 hazard that once cost an afternoon. Nothing pinned it. Written, along with
  `scripts/retry-budget.test.mjs`, and `pnpm test` now runs `node --test scripts/*.test.mjs`.
  (`pnpm -r test` does not reach the repository root, which is why they need their own script.)
- **Both web servers built the viewer, at the same time, into one directory.** Playwright starts the
  two `webServer` commands in parallel; the viewer's `build` writes `apps/viewer/build` and the
  editor's `build` is `stage:viewer && vite build`, which writes the same directory and then *copies
  it* into the editor's assets. Two `vite build` processes emptying and filling one directory while a
  third step reads it stages a viewer bundle that is missing files, in one run and not the next, with
  both builds reporting success. `scripts/e2e-build.mjs` is now one sequential build behind a lock,
  shared by both commands. This was never diagnosed as a cause of any specific failure — it is a
  hazard that was there to be removed.
- **The build was never the wall-clock problem.** The ticket expected reusing a current build to be
  "the obvious win". Measured: a cold build of both apps is **8.1 s** and a skipped one is 0.04 s, out
  of a 444 s run. It is worth having for the correctness reason above and for the ~10 s a repeated
  run saves; it is not a speed story.

## Acceptance criteria

1. A recorded measurement of ten consecutive full runs on `main`, with every failure classified as crash, transient-state timeout, or assertion. Written into the ticket, with the date and the machine.
2. Each named flaky test above is either fixed at its cause or recorded as an app bug with a filed follow-up. For each one fixed, `--repeat-each=10` passes.
3. The flake rate after the work is measured over ten further full runs and stated as a number.
4. `playwright.config.ts`'s comment about workers and flakiness matches that measurement, with its date.
5. A retried test is visible in the output, and the suite fails when the retry rate crosses a stated threshold.
6. Single-run wall-clock time before and after, stated.
7. `pnpm -r build && pnpm -r test && pnpm lint && pnpm check` passes.

The mutation check applies to criterion 5: break the retry-rate threshold and confirm the suite fails.

## How each was discharged

1. **Done.** "Measured before the work" above: ten runs, every failure listed with its class, dated,
   with the machine and its load stated.
2. **Done, with one honest gap.** Fixed at their cause and passing `--repeat-each=10`:
   `editor-transfer` "says so when an export fails" (25/25, and again in a 560-test repeat block),
   `editor-workspace` "transitions saved → …" (10/10), `editor-pwa` "network off" (40/40),
   `editor-stored-image-pane` "two Historical Maps" (10/10), plus the four found afterwards —
   `editor-image-ingest` (in the same 560-test block), the two `editor-layers` keyboard tests (30/30)
   and `editor-alignment` "choosing the Base Map" (30/30).
   **The four that never reproduced take the criterion's second option, and here is the argument for
   it.** `viewer-reader:1286`, `editor-layers:1046`, `editor-workspace:336` and
   `editor-stored-image-pane:200` did not fail once in **11,970 test executions across thirty full
   runs**, plus the targeted `--repeat-each` blocks above. The criterion offers "fixed at its cause"
   or "recorded as an app bug with a filed follow-up", and neither fits: there is no cause to fix and
   no bug to file, because there is no failure. Filing four follow-ups for tests that pass would put
   four items on the epic's ledger that nobody can act on and that no future implementer could ever
   close — the ledger equivalent of a fence that passes vacuously.

   What discharges the criterion instead is that the *reason* those four were named is now accounted
   for. They were reported as flaky by implementers working before the port derivation landed, in the
   same runs that produced the "browser crashes" this ticket has shown were a reused `vite preview`
   losing its server mid-run — a failure mode that hits whatever happens to be executing, which is
   exactly why the four have nothing in common with each other or with the five real causes. They are
   not unexplained; they are explained by a bug that was fixed before this ticket began. If any of
   them fails again, it will now arrive with a trace attached and be a new investigation with real
   evidence, which is a better position than a speculative follow-up would leave anyone in.
3. **Done.** 0.025% — 1 first-attempt failure in 3990 executions, 1 of 10 runs, 0 surviving a retry.
   With the caveat above about the one fix that landed after those ten runs.
4. **Done.** `playwright.config.ts`'s `workers` comment now states the date, the machine, the load
   condition, the four-way classification and the counts, and says what the numbers argue for and
   what they do not. It no longer claims the cap fixed anything, and it no longer states a rate with
   no method. `CONTRIBUTING.md`'s "When the browser suite is red" repeated the same claim and was
   rewritten with it.
5. **Done, and checked in both directions.** `scripts/retry-budget.mjs` prints each retry as it
   happens (`↻ retry 1 of …`) and again in the summary with file and line, then fails the run over
   budget. The positive control is checked in as `e2e/editor-retry-budget-control.e2e.ts`, skipped by
   default so it cannot spend the budget it guards.
   **The mutation check, run:**
   - `BALLASTELLA_E2E_RETRY_CONTROL=1 BALLASTELLA_E2E_RETRY_BUDGET=0` → exit **1**, printing
     "retry budget exceeded — this run is being failed even though every test eventually passed".
   - `BALLASTELLA_E2E_RETRY_BUDGET=1` on the *same* run → exit **0**, still printing the retry. This
     is the half that matters: Playwright alone exits 0 for a flaky run, so it shows the first run was
     failed by the budget and not by the test.
   - Neither variable set → the control is skipped and the suite is unaffected.
   `scripts/retry-budget.test.mjs` pins the arithmetic underneath, including the boundary (1 retried
   test in 398 is inside the budget, 2 is not) and why the fence is a rate rather than a count.
6. **Done.** 471.3 s before, 474.2 s after, controlled A/B. Unchanged, and the section above says why
   the ticket's expectation of a build-reuse win did not survive measurement.
7. **Done**, 2026-08-07, re-run after the review fixes below:
   ```
   pnpm -r build   exit 0
   pnpm -r test    exit 0   53 files, 1383 passed, 15 skipped
   pnpm lint       exit 0
   pnpm check      exit 0
   pnpm test       exit 0   the above plus scripts/: 26 passed, 0 failed
   ```
   The retry-budget fence was re-checked in both directions afterwards as well (exit 1 at budget 0,
   exit 0 at budget 1), because the reporter's configuration moved during the fixes.

   ```
   pnpm exec playwright test   exit 0

   398 passed   0 flaky   1 skipped   0 failed       no lock left behind
   retry budget: 0 of 399 tests passed only after a retry (0.00%, budget 0.50% = 1 test)
   ```
   The one skipped test is `editor-retry-budget-control.e2e.ts`, which is skipped by design.

   **Green only because the three specs were routed.** Before that, the same tree ran
   395 passed / 1 flaky / 2 failed against a Base Map archive that had started answering 404 —
   and the run reported it properly, which is worth recording as the criterion-5 machinery working on
   a real degradation rather than a contrived one: the retry was printed with its file and line, the
   rate was stated against the budget, and the test that recovered was reported as recovered instead
   of as a pass.

Mutation checks were also run on the two changes this ticket makes to behaviour, neither of which
criterion 5 covers:

- **The store fix.** Remove the tolerance from `collectEntries` and
  "lists what is still there when a directory is deleted while the walk is running" goes red in both
  Chromium and Firefox with `NotFoundError: Entry not found`. Restored, green.
  The *first* cut of that fix forgave a vanished root as well, and
  `file-system-access-project-store.browser.test.ts`'s "reports a folder Workspace as unreachable
  once the folder is gone" caught it — ADR-0008 needs an unplugged folder to fail rather than to
  report an empty Workspace. The split between a vanished descendant and a vanished root is there
  because an existing test refused the sloppy version.
- **The save-transition test.** Remove `this.#publish('saving')` from `Autosave.#drainLoop` and the
  recorded sequence becomes `saved, unsaved, saved` and the test goes red. Worth noting what this
  proves: the two assertions the test *keeps* — `data-save-state` ends at `saved`, and the text reads
  "Saved" — both still pass with that line deleted. The recorded sequence is the only part with
  teeth, which is exactly the vacuity the epic keeps finding.

## What review found after the implementer reported all criteria met

Six defects, none of which had failed anything. Recorded because the pattern is the point: **four of
the six were in the parts of this work whose whole subject is "a green result that means nothing".**

1. **The build lock leaked and then could not be broken — two faults, and together they wedged the
   suite for fifteen minutes at a time.** `build()` called `process.exit()` on a failed build, and
   `process.exit` skips `finally`, so the lock survived the first failure or the first ^C. Recovery
   was then dead code, because `process.kill(pid, 0)` **throws `ESRCH` when the process is gone** and
   the `catch` read that as "still running" — the semantics are inverted from the way they read. The
   file's own comment promised "a lock whose owner is gone is broken rather than waited on"; the code
   did neither, and nothing exercised it because a lock is only reached when something else has
   already gone wrong. Fixed, and `scripts/e2e-build.test.mjs` now covers both signal directions
   (`ESRCH` gone, `EPERM` alive-and-not-ours) and all three ways of ending while holding it — exit
   non-zero, uncaught throw, and `SIGINT`, each in a real child process, since `process.exit`
   semantics cannot be observed in-process. Mutation-checked: restoring either original fault turns
   the relevant tests red.
2. **`collectEntries` silently truncated.** A descendant vanishing mid-drain returned the entries
   collected *so far*, with no signal — a short listing reporting success, which is quieter and worse
   than the throw it replaced, and would become a silently incomplete archive in ticket 13. It now
   re-reads the directory (the vanished entry is gone by the next pass, so it converges) and throws if
   it can never read it completely. Two new tests, one for each direction.
3. **The forgiveness only covered `list('')`.** `listPaths('amsterdam-1625/')` starts at the Project
   directory, so `workspace.ts`'s per-Project listings still threw on the very scenario the fix is
   named for. Checking the question the review asked — is the ADR-0008 intolerance really about the
   root? — the answer is yes and for a specific reason: every other prefix is resolved through
   `getDirectoryHandle`, whose `NotFoundError` is already caught and returned as `[]`, so a Project
   deleted a moment *earlier* had always listed as empty. Refusing to forgive one deleted a moment
   *later* made the answer depend on microseconds. The split is now `segments.length > 0`.
4. **The new sequence assertion could pass vacuously — the exact shape it was written to remove.**
   It read the `MutationObserver` record once, behind a guard that is satisfied by the `saved` the
   indicator shows *before* the edit lands. A first read winning that race returns `['saved']` and
   `toEqual` on it would have gone green having observed nothing. Now `expect.poll`, and
   mutation-checked again against an app that skips the transition.
5. **Two comments pointed at things that do not exist or were superseded.** A pin cited
   `directory-handle-store.test.ts`, which is not a file; and `support/saved.ts` — now the canonical
   explainer for this hazard — stated the three-state `saved → saving → saved` sequence that this
   ticket's own work disproved, in two places.
6. **Criterion 2 took a third option the criterion does not offer.** Argued explicitly above rather
   than left implicit.

Four judgement calls were also resolved:

- **One read, not four.** `e2e/support/stored-file.ts` now holds the retry-with-backoff read that
  `annotations.ts`, `alignment-workspace.ts`, `saved.ts` and `editor-alignment.e2e.ts` had each grown
  a copy of — and whose fourth copy, the one that omitted the retry, was the last failure in the ten
  measured runs. Each caller keeps its own contract (`null` for the pollers, a named throw for the
  rest); only the loop is shared.
- **`fingerprint` is no longer exported.** It had no importer and no test.
- **`scripts/` is no longer a build-input root.** It made editing `retry-budget.mjs` — a reporter
  that runs long after both apps are built — force a full two-app rebuild, against the allowlist's
  stated purpose. Exactly one script is a build input and it is now named individually. Verified both
  ways: editing `retry-budget.mjs` does not rebuild, editing `apps/viewer/src/` does.
- **`BALLASTELLA_E2E_REUSE` is referenced nowhere** in source, scripts, config, CI or docs. Confirmed
  by grep across the tree.

### The Base Map archive vanished mid-ticket, and the three specs that trusted it now route it

**`https://demo-bucket.protomaps.com/v4.pmtiles` began answering 404 during this session.** It served
every one of the thirty measured runs earlier the same day and does not serve now:

```
$ curl -sI https://demo-bucket.protomaps.com/v4.pmtiles
HTTP/2 404                       server: Tigris OS      (no access-control-allow-origin)
$ curl -X OPTIONS -H 'Origin: http://localhost:36790' …
HTTP/2 403                       (the CORS preflight a Range header triggers)
```

`packages/core/src/base-map/catalog.ts` points all four Base Map entries at that archive, and
`editor-alignment`, `editor-alignment-refinement` and `editor-align-route` were the only specs left
that did not route it. Three tests went red with `data-warped-status=""`, which reads exactly like
the feature being broken.

**Attribution, established rather than assumed:** stashing the whole branch fails the *same three
tests* on pre-ticket `main` in the same invocation (four there against two here); and a longer
timeout was tried first, on the theory that it was another budget exhaustion — at 30 s they failed
identically, which ruled timing out. That raise was reverted; only the consolidation into
`expectWarpedDrawn` was kept.

**Routed, on a human decision, against the committed `e2e/fixtures/base-map/amsterdam-centre.pmtiles`
that fourteen other specs already use.** ADR-0025 already says this bucket has "no published rate
limit, no uptime promise, and no terms of use" and that "nothing about it is suitable to rely on";
nothing in the three specs documented an intent to fetch it for real, and `editor-alignment` in fact
documented the *opposite* — it deliberately avoids `streets-worldwide` because depending on the demo
bucket "would buy nothing and cost a flake on every reading-room wifi this suite is ever run on". The
intent was right and the lever was wrong: **all four** catalog entries share one `REMOTE_ARCHIVE`.
That comment now says so.

#### What changed about coverage — measured, because the reasoning was wrong

The expected answer was "these specs stop exercising a live archive fetch, and in exchange they stop
depending on a third party". The first half is right. The second half was investigated properly
because the mutation check demanded it, **and the obvious causal story turned out to be false**:

| the three specs, run against… | result |
| --- | --- |
| the real fixture (the change) | **53 passed** |
| an archive of **all zeros**, same length | **53 passed** |
| the route answering **404** | **53 passed** |
| **no route at all** (the state before) | **red** |
| a **missing** fixture file | red, `ENOENT`, every test |

So "no Base Map means no warped render" is wrong. These specs never depended on the Base Map's
*content* at all — their warped-tile assertions read the Historical Map's own pyramid out of OPFS,
which never involved this archive. What they need is for the archive request to be **answered**, so
MapLibre's source initialises and the warped layer is added.

Which means the thing that broke them was not the 404. It was that an unrouted request is
cross-origin, the bucket's 404 carries no `access-control-allow-origin`, and its preflight answers
403 — so the browser blocks the fetch and the page receives *no response at all*, a worse state than
an HTTP error the app can handle. Routed-but-404 is green; unrouted-and-404 is red. That pair is the
proof.

**Coverage given up, precisely: nothing these three specs asserted.** Not the range-request path
(`editor-base-map.e2e.ts` asserts that and is untouched), not tile content (they pass with zeros),
not worldwide extent (they work in Amsterdam, where their Control Points are). What is given up is
DNS, TLS and a stranger's CORS configuration, none of which any test asserted.

⚠ **One thing this exposed that is not fixed:** `expectWarpedDrawn` passes with a Base Map that has
no tiles whatsoever. It reports that the warped layer was *added*, not that anything was drawn
underneath it. That is a pre-existing weakness in what the status means, it is now written down in
`support/alignment-workspace.ts`, and no test in this ticket was changed to rely on it more than it
already did.

**No measurement in this ticket changed**, but the conditions did, and that is worth stating plainly:
**the 0.20% → 0.025% figures were measured while `demo-bucket.protomaps.com` still answered, and
before the three specs above were routed.** They are honest about what they measured — thirty full
runs, 11,970 test executions — and they are not a claim about a machine that cannot reach that
bucket. The routing that followed can only have improved them, since it removes a failure mode
without touching an assertion, but it landed after the ten runs and the figures were not re-measured
with it in place. The two things that could have been affected by the review fixes themselves were
checked:

- *Wall clock.* The lock fix adds a handful of `process.on` registrations and removes a
  `process.exit`; it does nothing on the path a successful run takes. Re-measured after the fixes: a
  cold build of both apps 12.3 s, a skipped one 0.053 s, against 8.1 s and 0.04 s before — the
  difference is machine load, not the change, and it is 2% of a ~470 s run either way. The A/B figures
  (471.3 s before, 474.2 s after) stand.
- *Flake rate.* Every fix above either removes a failure mode or is confined to tests that were
  already passing, and the full suite was re-run to confirm it (below). The 0.025% figure is from the
  ten runs and remains the measured number; as already flagged, the shipped tree is newer than it.

## Follow-ups this ticket did not take

- **The Base Map catalog still points at a bucket that 404s.** Routing fixed the *suite*; it did not
  fix the *application*, which cannot draw a Base Map on this deployment at all right now.
  `pnpm check:deployment` already refuses the demo bucket for production and would have said so, but
  nothing runs it in the ordinary loop. Repointing `REMOTE_ARCHIVE` belongs with ADR-0020 and
  ticket 10, not here.
- **`expectWarpedDrawn` passes with a Base Map that has no tiles.** Measured above. The status reports
  that the warped layer was added, not that the map underneath drew. Whoever tightens it should know
  that no test currently depends on the difference.
- **`--reporter=…` on the command line silently disables the retry budget**, because it replaces
  Playwright's whole reporter list and there is no way to pin a reporter against that. Found by
  noticing the budget line missing from a run made with `--reporter=line` — the same defect class as
  everything else here: a fence that reports nothing when it is not running. Stated in
  `playwright.config.ts` and `CONTRIBUTING.md` with the spelling that keeps both
  (`--reporter=line,./scripts/retry-budget.mjs`); CI passes no `--reporter`, so CI is unaffected.

- **The pagehide flush is a race and the suite no longer depends on it.** ADR-0017 rule 3 flushes
  pending writes on `pagehide`, but a flush is asynchronous and a navigating page is not obliged to
  wait for it. The tests fixed above no longer rely on winning that race; **the user still does.** A
  scholar who reloads within 400 ms of an edit can lose it, and `autosave.test.ts` cannot see this
  because it dispatches `pagehide` without navigating. Not investigated further here — it is an
  ADR-0017 question, not an e2e one.
- **`e2e/` still holds fixed waits**, including `alignment-workspace.ts`'s and `annotations.ts`'s 3 s
  `idle` fallbacks, whose own comments say the event "does not fire when the view did not actually
  change". None of them caused a measured failure in twenty runs, so none was touched. They are a
  cost rather than a defect: roughly 30 s of wall clock across a run.
- **The nineteen tests that could move to a cheaper seam were left alone.** Worth ~16 s of a 470 s
  run. The three that take no `page` fixture are the clearest candidates, but `viewer.e2e.ts:15`
  reads `apps/viewer/build` and says in its own comment that it can do so *because this project's
  `webServer` built it* — moving it out means finding it a build, which is a bigger change than 16 s
  justifies.
