# 05 — Record the two pre-existing faults so the gate does not absorb them

## What to build

Two faults predate this epic. Neither is this epic's to fix, and both will otherwise be quietly absorbed — one into "the suite is red anyway while it is being reworked", the other into the retry budget. Write them down where they will be acted on, with the evidence already gathered, and make sure the epic's own measurements are not confused by them.

**This ticket investigates and records. It does not fix.** Folding a product investigation into a test-speed epic is how an epic stops finishing.

## Where to start

**Fault 1 — a deterministic failure on `main`.** `e2e/editor-remote-binding.e2e.ts`, "a first visit › shows no sign-in affordance anywhere". A visible element matching `/GitHub/i` is present on a first visit, where the test expects none. Already established during the investigation:

- reproduces on clean `main`, in isolation, and in a full-suite run;
- reproduces with and without `fullyParallel`, so it is not a scheduling artefact;
- **fails its retry**, so it is deterministic rather than flake.

It is a product question — ADR-0031 and ADR-0032 territory, and the sibling test "asks GitHub nothing at all" is the one that says what a first visit is supposed to be.

**Fault 2 — a habitual flake.** `e2e/viewer-reader.e2e.ts`, "a Published Site that is not entirely well › tells a server that is failing apart from a connection that is gone". It retried in three separate runs during the investigation, including on clean `main`. Read `scripts/retry-budget.mjs`'s header: a test that needs its retry habitually is exactly what the budget is still supposed to catch, and a rate that absorbs a known-bad test is a rate that means less.

Both belong in a new epic or as leads on an existing one — see `.tracker/workspace-and-layers/TRACKER.md`'s "Open leads" section for the house form, which insists a lead carries evidence rather than suspicion.

## Contract

- Fault 1 is recorded with its reproduction and the fact that it fails its retry. **Do not attach it to a plausible-sounding cause without evidence** — `workspace-and-layers` lead 1 records what months of a confidently wrong diagnosis cost.
- Fault 2 is recorded with the observed retry occurrences and the runs they came from.
- The epic's own baseline is annotated so that "1 failed, 1 flaky" is understood as the expected profile of an unmodified run, and any ticket reporting a different profile knows to explain it.
- If either fault turns out to be trivially fixable while writing it up, fixing it is allowed — but the write-up still happens, and a fix is not attempted by guesswork.

### User Stories

39, 40.

## Out of scope

- Fixing the sign-in affordance behaviour, or changing anything in the editor's remote binding.
- Quarantining either test with `test.skip`. A skipped test is a test nobody will come back to; both stay running and visible.
- Adjusting the retry budget threshold to accommodate fault 2.
- Investigating any other flake. These two, both with evidence already in hand.

## Acceptance criteria

- [ ] Both faults are written up where they will be seen, with reproduction steps and the evidence already gathered.
- [ ] Fault 1's write-up states plainly that it fails its retry and therefore is not flake.
- [ ] Fault 2's write-up gives the runs in which it retried.
- [ ] Neither test is skipped, and the suite's failure profile is unchanged by this ticket.
- [ ] `TRACKER.md` records "1 failed, 1 flaky" as the expected baseline profile, so later tickets can spot a change.

```bash
pnpm test:e2e editor-remote-binding.e2e.ts   # 1 failed, deterministic
pnpm test:e2e viewer-reader.e2e.ts           # watch for the named retry
```

Success: both faults documented with evidence; no test skipped; the expected failure profile recorded.

## Blocked by

- 01
