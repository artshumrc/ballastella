# 09 — One state per path, instead of six fields

## The argument for doing this

`Autosave` tracks each file with six independent mutable fields — `pending`, `draining`, `timer`, `error`, `failedAttempts`, `quiescing` — whose legal combinations are maintained by convention across six methods. **Roughly half of every defect this epic found was two of those fields disagreeing**, and two of them were introduced by fixes for earlier ones.

The list, so this is an argument from evidence rather than taste:

| Defect | The disagreement |
|---|---|
| The original write gap | `pending` set, `draining` memo about to clear, nothing scheduled |
| A throwing subscriber killed the path | `draining` held a rejected promise for ever |
| The journal-`forget` ending | `pending` clear and `error` clear, but `commit` rejected |
| The unbounded retry | `error` stale from an earlier refusal, `failedAttempts` frozen |
| `settled()` answering `true` with a write coming | `timer` armed behind a caller that was told it was quiet |
| A refused deletion killing the retry | `quiescing` set with nothing left to clear it |

Every one is expressible as "these two fields say different things about what is happening to this file". A discriminated union makes them unspellable.

Fulfills stories **23** (a write that reports success and did not happen is impossible rather than rare) and **30** (a stranded write is visible in the save state).

## What to do

Replace the six fields with one state per path — roughly `Idle | Debouncing | Writing | Retrying | GaveUp`, though the exact set is yours to design against what the code actually needs.

The invariant this epic spent four rounds testing —

> if bytes are pending, a drain is scheduled or running

— should stop being a thing we assert and become a thing that cannot be written down. If a state carries bytes, it carries whatever is going to write them.

**Publish out-of-band while you are here.** `#publish` calls listeners synchronously from inside the code that owns the invariant, which is why a throwing subscriber has been able to corrupt it twice. Ticket 04 already built the pattern worth copying: catch, and rethrow via `queueMicrotask`, so the path survives and the subscriber's failure still reaches `window.onerror` and the suite's `pageerror` watch. That retires the class rather than defending against it in three places.

## What must not regress

`autosave.test.ts` carries roughly 150 tests, many of which were bought at high cost. Treat them as the specification. In particular, keep:

- the `vi.getTimerCount()` discipline — three separate assertions were found unable to distinguish "nothing scheduled" from "scheduled for ever", because they asserted only end state. That discriminator is what caught them;
- the throwing-subscriber, throwing-journal and re-entrancy tests, each of which pins a real past defect;
- the two long-standing equivalent mutants (`M16`, `M18`) and their disclosures, or a statement of why they no longer apply.

**A refactor can silently disarm a mutation that killed before.** This happened twice in this epic — a stray timer that used to strand bytes began firing harmlessly, and bounding a map cost a test its discrimination. Both were found by re-running earlier rounds' mutation matrices, not by reading. Re-run them.

## Acceptance criteria

- [ ] The six fields are gone, or those that remain are argued for individually.
- [ ] Illegal combinations from the table above are unrepresentable — demonstrated by trying to write one and showing the type rejects it, not by asserting it in a test.
- [ ] The full existing autosave suite passes unchanged, or every change to it is justified as a specification change rather than an accommodation.
- [ ] Prior rounds' mutations are re-run and still kill. Any that stopped killing is reported and fixed.
- [ ] A throwing subscriber cannot affect the write path from any seam, driven at each publish point.
- [ ] Mutation check on everything new: break it, watch it go red, restore, record it.

## Out of scope

- **The retry policy itself.** Ticket 02 is superseded; do not rebuild the bounded retry, `strandedWrites`, `quiescing` or `resume`. If a state named `Retrying` is convenient, that is fine, but it is not this ticket's job to make retrying work.
- **`replay.ts`** — that is ticket 07, running alongside.
- **Widening `SaveState`** — the app-facing enum stays as it is; this is about `Autosave`'s internals.
