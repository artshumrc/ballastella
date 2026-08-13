# Tracker for the-suite-runs-in-three-minutes

## Purpose

This document tracks the status of all tickets in the epic.

The goal of `the-suite-runs-in-three-minutes` is to take `pnpm test:e2e` from thirteen minutes to two or three by **moving** claims out of Playwright and into component-and-DOM tests in Node — and by fencing the result so it cannot grow back.

**Moving, not removing.** Playwright and Seam 2 stay: they are the only place the application is proved to work with real MapLibre, real OPFS, a real service worker and a real static server underneath it. What leaves is the large body of claims about the interface's own behaviour and about pure logic, which lived at Seam 2 only because `apps/editor` had no DOM and there was no seam between a class with no DOM and the whole application. The suite may well end up with *more* tests in total; what has to fall is time at Seam 2.

Scope, the seam boundaries, and the measured baseline are in [SPEC.md](./SPEC.md); the standing testing rules are in [ballastella-v1's SPEC](../ballastella-v1/SPEC.md#testing-decisions) and [CONTRIBUTING](../../CONTRIBUTING.md); vocabulary is in [CONTEXT.md](../../CONTEXT.md).

## Current Status

Overall status: `In Progress`

Current ticket: 01 and 02 complete; 03, 04, 05, 06, 08, 09, 10 and 12 unblocked.

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

Two faults predating this epic are recorded in the spec and are **not** in scope here: a deterministic failure in `editor-remote-binding` on `main`, and a habitual flake in `viewer-reader`.

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

Last updated: 2026-08-13

## Ledger

Tickets 01–05 are groundwork and instrumentation; 06–14 are the migration, orderable by whoever picks them up; 15 closes the epic.

**06, 09, 10 and 12 depend only on 01** and can run in parallel with the component-seam work — they rehouse to Seam 1, which already exists.

| Number | Filename                                                       | Status      | Depends On                         |
| ------ | -------------------------------------------------------------- | ----------- | ---------------------------------- |
| 01     | 01-land-the-scheduling-and-recorded-workspace-groundwork.md      | Completed   | —                                  |
| 02     | 02-move-the-component-seam-into-node.md                          | Completed   | 01                                 |
| 03     | 03-profile-seam-2-by-cost-per-test.md                            | Not Started | 01                                 |
| 04     | 04-fence-the-size-of-seam-2.md                                   | Not Started | 01                                 |
| 05     | 05-record-the-two-pre-existing-faults.md                         | Not Started | 01                                 |
| 06     | 06-rehouse-the-annotation-document-claims.md                     | Not Started | 01                                 |
| 07     | 07-rehouse-the-annotation-interface-claims.md                    | Not Started | 02, 06                             |
| 08     | 08-finish-the-layer-stack-migration.md                           | Not Started | 02                                 |
| 09     | 09-rehouse-the-base-map-arithmetic-and-catalog-claims.md         | Not Started | 01                                 |
| 10     | 10-rehouse-the-project-bundle-refusals.md                        | Not Started | 01                                 |
| 11     | 11-rehouse-the-workspace-and-project-screen-claims.md            | Not Started | 02, 03                             |
| 12     | 12-rehouse-the-publish-output-claims.md                          | Not Started | 01                                 |
| 13     | 13-decide-the-remote-family-by-measurement.md                    | Not Started | 03, 05                             |
| 14     | 14-consolidate-the-duplicated-platform-and-keyboard-claims.md    | Not Started | 02, 08                             |
| 15     | 15-close-the-epic-lower-the-fence-and-record-the-cost.md         | Not Started | 04, 06, 07, 08, 09, 10, 11, 12, 13, 14 |

## User story coverage

All 45 stories in [SPEC.md](./SPEC.md) are claimed by at least one ticket. The mapping is in each ticket's **User Stories** section; stories 5 and 9 — rehousing rather than deleting, and naming a retired test's new home — are carried by every migration ticket rather than by one.
