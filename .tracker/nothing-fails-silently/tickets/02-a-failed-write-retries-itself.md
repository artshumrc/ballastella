# A failed write retries itself, within a stated bound

## What to build

A write the store refused is retried on its own, up to a bound written in code. A scholar who has stopped typing does not have to make another edit to un-stick their work.

Today the bytes stay pending and wait for the next `commit`, `queue`, or `flush` to carry them. That is a correct floor and an insufficient policy: recovery depends on the scholar doing something they have no reason to do, because nothing has told them anything is wrong.

This ticket delivers the retry and the concept of **giving up**. Saying so to the scholar is ticket 03 — but the state ticket 03 renders must exist and be reachable when this lands.

## Where to start

- `packages/core/src/autosave/autosave.ts` — `#drainLoop`'s `catch`, which currently sets `file.error` and rethrows. Read its comment first: clearing the bytes before the attempt and returning on failure *lost the edit outright*, which is why the bytes stay pending. That decision stays.
- The bound and its injectability: `AutosaveOptions` already carries `debounceMs` and `onJournalRefused`, and ticket 21 of the previous epic added an injectable in-flight wait to this class — follow that shape rather than inventing a new one. A test must be able to set the bound without waiting real seconds.
- `packages/core/src/autosave/autosave.test.ts` — the fake-timer idiom.
- ADR-0017 rule 5.

## Contract

**The bound is a real number in code, injectable, and asserted.** "It retries" must not become "it hangs". The previous epic shipped a bounded wait whose *shipped default* was unasserted — deleting the default left the suite green. Do not repeat that: assert the constructed default, not only that *a* bound exists.

**Retrying does not lose the newest bytes.** If a newer edit arrives while a retry is in flight, the newer bytes win and the older ones are not resurrected. This is the same rule `#drainLoop` already keeps with `if (file.pending === bytes)`.

**A retry is not a spin.** Space the attempts; do not re-enter immediately on failure.

**Giving up is a state, not a silence.** When the bound is exhausted the bytes stay pending, `lastError` holds the cause, and the save state reflects that this is not going to fix itself. **Ticket 03 renders it — this ticket must make it reachable and observable at the domain seam.**

**`commit`'s caller still learns about the failure.** Rule: a caller may not report a mutation it did not get. If retries change *when* `commit` rejects, that is a decision to state explicitly in the code, not a side effect to discover.

**Do not weaken `flush`.** It is the closed-laptop path and resolves rather than rejects deliberately.

## Out of scope

- **Any UI.** No `apps/editor`, no `apps/viewer`. The sentence, the announcement, the dismissal are all ticket 03.
- **The drain gap** — ticket 01 closed it. Build on it; do not revisit it.
- **Retrying anything other than a store write.** Not journal refusals, not the render seam.
- **Persisting retry state across a reload.** The Write-Ahead Journal already carries the bytes across a navigation; this is in-session only.
- **Making the bound configurable by the user.** It is a constant with a stated reason.

## Acceptance criteria

- [ ] A store that rejects once and then accepts results in the bytes reaching the store with no further `commit`, `queue`, or `flush` from the caller.
- [ ] A store that rejects every time stops attempting after the bound, rather than retrying forever.
- [ ] **The shipped default bound is asserted** — changing the number, or deleting the default and letting it fall back, fails a test. (A test that only proves *some* bound exists is not enough.)
- [ ] After the bound is exhausted, the bytes are still pending, `lastError` holds the cause, and the save state distinguishes "gave up" from "a debounce is pending".
- [ ] A newer edit arriving mid-retry is the one that reaches the store; the older bytes are not written afterwards.
- [ ] Existing behaviour re-asserted so this cannot have removed it: `commit` rejects when the store rejected; `flush` still resolves rather than rejecting; the journal entry is forgotten only when the store took those bytes.
- [ ] The mutation check is recorded per criterion. **Report any surviving mutation as green with its reason rather than rewording it.**

```sh
pnpm --filter @ballastella/core exec vitest run src/autosave/autosave.test.ts
pnpm lint && pnpm check && pnpm -r build && pnpm -r test
pnpm test:e2e
```

All exit 0. Read exit codes directly; never pass `--reporter=`; do not pipe gate output through `grep`.

## Blocked by

- Ticket 01 — a write that reports success has been written.
