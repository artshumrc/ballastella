# 03 — Profile Seam 2 by cost per test

## What to build

A repeatable way to ask "which specs cost the most, and which individual tests inside them", so that later tickets target the next worst file by measurement rather than by guess.

Every wrong estimate in this epic so far came from generalising a partial measurement. The counter to that is a profile anyone can regenerate.

## Where to start

- `playwright.config.ts` — the `reporter` array. ⚠ **Do not tell anyone to pass `--reporter=…` on the command line**: it replaces the whole list and silently drops the retry budget. `CLAUDE.md` and the config both record this. If a reporter is the mechanism, it is added to the list in the config, or spelled in full as `--reporter=line,./scripts/retry-budget.mjs,<yours>`.
- `scripts/retry-budget.mjs` — the model for a custom reporter in this repo: it prints per-event detail as it happens, reports a rate at the end, and carries its own argument for its threshold.
- `scripts/precommit.mjs` — the model for a per-stage timing summary.

Known figures to reproduce or correct, from the investigation that produced this epic: `editor-annotations` and `editor-layers` at roughly 11.8 worker-seconds per test, `viewer-reader` at roughly 2.5, and a whole-suite average near 1 second.

## Contract

- The profile reports **worker-seconds per test and per spec**, not just wall time. Wall time depends on how the scheduler happened to pack the run; worker-seconds is what a migration actually removes.
- It reports the **total**, so a later ticket can state what fraction of the suite it removed.
- It is **regenerable by one documented command** and its output is committed somewhere a later ticket can read — the epic's tracker or a file beside it. A profile that lives only in a terminal is a measurement that was not taken.
- It must not disturb the retry budget. Running the profile and running the gate must give the same pass/fail verdict.

### User Stories

20, 36.

## Out of scope

- Acting on the profile. This ticket measures; tickets 06 onward cut.
- Changing worker counts, timeouts, or any test.
- Building a dashboard. A committed table is enough.

## Acceptance criteria

- [ ] One documented command produces a per-spec table of test count, total worker-seconds, and worker-seconds per test, sorted by total cost.
- [ ] The table is committed and referenced from `TRACKER.md`.
- [ ] The retry budget still fires: a run with any retry still reports it, and `BALLASTELLA_E2E_RETRY_BUDGET=0` on a run with a retry still fails.
- [ ] The profile's own total wall time is within noise of an unprofiled run — it measures the suite rather than changing it.

```bash
# the documented command, whatever it ends up being, e.g.
pnpm test:e2e --profile
BALLASTELLA_E2E_RETRY_BUDGET=0 pnpm test:e2e viewer-reader.e2e.ts   # must fail if anything retried
```

Success: a committed table naming the most expensive specs; the retry budget's positive control still fails as designed.

## Blocked by

- 01
