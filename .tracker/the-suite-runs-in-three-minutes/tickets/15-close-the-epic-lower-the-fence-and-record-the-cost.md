# 15 — Close the epic: lower the fence and record what it cost

## What to build

The epic's closing ticket. Measure the finished suite end to end, lower the fence to the count actually achieved, confirm nothing that had to stay at Seam 2 was lost, and write down what the work really cost so the next planner is not guessing.

## Where to start

- `TRACKER.md` — every migration ticket recorded a before-and-after; this ticket totals them and reconciles the sum against a real full-suite run.
- Ticket 04's fence — its ceiling comes down to the achieved count, with headroom stated as a number rather than left implicit.
- Ticket 03's profile — regenerate it and compare with the original to show where the cost actually went.
- `.tracker/workspace-and-layers/TRACKER.md` is the house model for an epic retrospective: what each ticket cost, what the review found, and open leads carrying evidence rather than suspicion.

## Contract

**Every number in the closing report comes from a full-suite run, before and after.** The epic's own history is the reason this is a contract rather than advice: three estimates during the investigation were wrong, and all three were partial measurements generalised to the whole — a per-file speedup quoted as a suite speedup, a per-test cost inferred from a killed run, an ingest cost assumed rather than timed.

**The baseline to compare against is 675 tests in 13m 04s on clean `main`.** The interim figure after the groundwork was 669 tests in 10m 55s.

**Confirm the protected coverage survived**, by inspection and not by the test count:

- the Reader's Published Site at both base paths (ADR-0006);
- the Base Map outage-notice sequence;
- warped rendering, the Resource Mask, and MapLibre layer order;
- service worker and PWA update behaviour;
- OPFS through the built application, and the File System Access grant path;
- byte-identity of the documents a Workspace holds.

**If the suite did not reach two to three minutes, say so plainly and say what remains.** A closing report that reports the target as met when it was not is worse than one that reports a shortfall with a number attached.

### User Stories

1, 4, 6, 11, 13, 14, 31, 32, 33, 34, 45 — and confirmation that every other story's ticket delivered.

## Out of scope

- Any further migration. If the target is not met, that is a finding and the next epic's work, not this ticket's.
- Raising the worker default to make the number look better. The override exists; the default belongs to the shared machine.
- Fixing the two faults ticket 05 recorded.
- Removing anything from Seam 2 to reach a number. The fence ceiling follows the achieved count, never the other way round.

## Acceptance criteria

- [ ] A full-suite run is recorded: test count, wall time, and failure profile, compared against 675 / 13m04s.
- [ ] The Vitest projects' counts and wall times are recorded alongside, so the total gate cost is one number.
- [ ] The profile is regenerated and the shift in cost distribution recorded.
- [ ] The fence ceiling is lowered to the achieved count, with stated headroom, and its positive control still fails when lowered by one.
- [ ] Each item of protected coverage is confirmed present by naming the test that carries it.
- [ ] The retrospective records the real ratio of work to saving — the first file took 13 component tests and a parent harness to retire 6 Seam 2 tests — and whether that held across the epic.
- [ ] Whether the two-to-three-minute target was met is stated plainly, with the shortfall quantified if there is one.
- [ ] `pnpm precommit` passes in full, including the e2e stage.

```bash
time pnpm test:e2e                 # the closing number
pnpm -r test                       # Vitest total
pnpm exec playwright test --list | tail -3
pnpm lint                          # the fence at its new ceiling
pnpm precommit                     # all four stages
```

Success: a closing report whose every figure came from a full run, a fence set to reality, and an honest statement of whether the target was met.

## Blocked by

- 04
- 06
- 07
- 08
- 09
- 10
- 11
- 12
- 13
- 14
