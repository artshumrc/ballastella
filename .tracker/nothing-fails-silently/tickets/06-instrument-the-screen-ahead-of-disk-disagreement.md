# Instrument the screen-ahead-of-disk disagreement

## What to build

An answer, with evidence, to one observation: the screen showed **three Control Points and the store held two**. Seen once, never reproduced.

**This is an investigation, and it has no promised outcome.** "Still open, and here is what it is not" is a complete and acceptable delivery. What is *not* acceptable is closing it against a plausible cause without evidence — a lead in this repository stayed mis-diagnosed for months in exactly that way, with captured evidence that fitted two very different stories, and the eventual real cause was one nobody had guessed.

## What is already known — do not re-derive it

- The failure was `e2e/editor-alignment.e2e.ts:678`, observed once during ticket 07 of the previous epic, then **20/20 green on targeted repeats**, including 12 at load average 48. It has not recurred in any full run since.
- **The confirmed `Autosave` drain gap is ruled out for it, by timeline.** The observation postdates the per-map Alignment write queue that closes that gap on this path, and that test writes through the queue. Do not close this with the drain gap.
- **The per-map write queue itself was traced and exonerated** — drop, reorder, last-write-of-a-burst, write-issued-while-queued, rejection wedging, leak, key space, and baseline placement were all checked and none reproduce it. Do not re-audit it from scratch; read the trace and extend it if you disagree.

## Two candidate mechanisms, named and unchecked

1. **The journal entry plus stale pending bytes.** `#drainLoop` calls `journal.forget(path)` **only** when the store took the bytes, so a wedged or stranded file keeps *both* a live journal entry and stale pending bytes. That is a second route to a state where what is replayed and what is on disk disagree, and it lives on `project.json` — a path the Alignment write queue does not cover.
2. **Success reported from somewhere other than the store's acknowledgement.** Any path where a caller learns "written" from a different place than the store saying so. Ticket 01 closed one such path; look for others.

## Where to start

- `packages/core/src/autosave/autosave.ts` after tickets 01 and 02 have landed — the ground has moved, so read it fresh.
- `apps/editor/src/lib/editor-session.svelte.ts` — the per-map Alignment write queue and `#writeAlignmentNow`.
- `packages/core/src/alignment/alignment-file.ts` — the single writer, and its stated residual: check-then-write with no lock, narrowed to one store write, **not closed**.
- `e2e/editor-alignment.e2e.ts` around the Control Point drag tests.
- **Instrument with durable markers, not `console.log`.** Console messages emitted in the last ~80 ms before a navigation are dropped — that cost one wrong reading during the previous epic before `localStorage` markers were used instead.

## Contract

**Measure, do not argue.** The findings that held in the previous epic came from probing the running system: a transform probe proving which runtime was emitted, `--repeat-each` at two worker counts separating "load causes it" from "load widens the window", a mutation to an id that does not exist. The findings that did not hold came from reading code and reasoning.

**Rule load in or out with a number.** Before attributing anything to contention, produce the measurement that settles it. This repository has been wrong about that repeatedly and each time the real cause was a defect.

**A negative result is a result, and must be recorded as one.** If a candidate mechanism is excluded, write down what was excluded and by what evidence, so the next person starts narrower rather than from scratch.

**Do not raise the retry budget** and do not add a wait, a retry, or a later observation to the test to make it steadier. The budget is the instrument that surfaced this.

**Any probe you add to ship must earn its place.** Temporary instrumentation is deleted before the commit; anything kept must be a test that can go red.

## Out of scope

- **Fixing the drain gap or adding retries** — tickets 01 and 02, and they must land first.
- **Re-auditing the per-map write queue from scratch.** It has been traced; extend that work rather than repeating it.
- **The render seam** — tickets 04 and 05.
- **Changing the alignment write path** unless the investigation produces evidence that it is the cause. A speculative hardening is not a finding.
- **Closing this by making the test more patient.**

## Acceptance criteria

One of the following two outcomes, delivered with evidence. Both are acceptable.

**Either — a named cause:**

- [ ] The mechanism is reproduced deterministically, or with a measured rate.
- [ ] A test exists that goes red on it and green with the fix.
- [ ] The mutation check is recorded.

**Or — an honestly narrowed open question:**

- [ ] Each of the two named candidate mechanisms is either reproduced or **excluded with the evidence that excluded it** — not with an argument.
- [ ] A measured attempt to reproduce the original observation is recorded, with the number of runs, the worker count, and the load average.
- [ ] Any newly-suspected mechanism is written up precisely enough that the next person can test it directly.
- [ ] The lead is updated in the epic's tracker to say what it is **not**, so the search is narrower than it was.

In both cases:

- [ ] No test was made more patient, no retry budget raised, no assertion weakened.
- [ ] Temporary instrumentation is removed; anything kept is a test that can go red.

```sh
pnpm exec playwright test e2e/editor-alignment.e2e.ts --repeat-each=20
pnpm --filter @ballastella/core exec vitest run src/autosave
pnpm lint && pnpm check && pnpm -r build && pnpm -r test
pnpm test:e2e
```

All exit 0. Read exit codes directly; **never pass `--reporter=`** — it silently disables the retry budget, which is the instrument this ticket depends on. Do not pipe gate output through `grep`. Record the load average alongside any timing claim.

## Blocked by

- Ticket 01 — a write that reports success has been written.
- Ticket 02 — a failed write retries itself, within a stated bound.
