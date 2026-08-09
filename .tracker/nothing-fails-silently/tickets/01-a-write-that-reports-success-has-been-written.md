# A write that reports success has been written

## What to build

Close the window in `Autosave` where a `commit` resolves successfully while its bytes never reach the store, and assert the invariant that makes it impossible rather than merely unlikely.

The invariant, which is what to state in code and test: **if a file has pending bytes, a drain is scheduled or running for it.** There is no state in which bytes sit pending with nothing coming for them.

## What is already known — do not re-derive it

**The defect is confirmed by deterministic reproduction**, not suspected. In `packages/core/src/autosave/autosave.ts`, `#drain` memoises the in-flight drain:

```ts
file.draining ??= this.#drainLoop(path, file).finally(() => {
    file.draining = undefined;
    …
});
```

`#drainLoop` clears `file.pending` and exits its `while` **synchronously**, then resolves; the `.finally` callback runs one microtask later. A `commit` landing in that gap sees `file.draining` still set, is handed back the settling promise, sets `file.pending = bytes`, and **no loop ever restarts**. The caller's promise resolves successfully.

It was reproduced with a probe chained on the *same* promise `#drainLoop` awaits, registered after it, so its callback ran between the loop's continuation and the `.finally`:

```
WRITTEN [{"path":"p/project.json","text":"one"}]   ← "two" never written
GATES   1                                          ← store.write called once
STATE   unsaved
```

Two further measured facts:
- **`flush()` recovers it** — the bytes are still in `file.pending`.
- **The next `commit` to that path destroys it** — `commit` overwrites `pending` before draining.

So the last write of a burst is lost permanently; a superseded one is lost silently.

**The symptom is not "Saved over missing bytes".** `#derive()` sees `pending`, so `state` reads `'unsaved'`. It presents as *Unsaved, forever, for no reason*, with one caller told it succeeded. Saying otherwise in a comment or commit message is the failure mode this epic exists to remove.

**Production reachability is unproven and is not to be claimed.** The window is one microtask, entered only by a continuation registered on a promise settling in the same batch after `#drainLoop` registered its own. Synthetic reproduction is trivial; that real OPFS timing produces it has *not* been shown, and this ticket does not try to show it (human decision, 2026-08-09).

## Where to start

- `packages/core/src/autosave/autosave.ts` — `#drain`, `#drainLoop`, `commit`, `queue`, `flush`, `#derive`. Read `#drainLoop`'s existing comments first: the "only clear what the store actually took" and "rethrown so `commit`'s caller cannot report a mutation it did not get" decisions are load-bearing and must survive.
- `packages/core/src/autosave/autosave.test.ts` — the existing suite and its fake-timer idiom.
- `packages/core/src/store/memory-project-store.ts` — the in-memory store the reproduction used.
- ADR-0017, especially rule 2 (per-file debounce) and rule 5 (an indicator that cannot read Saved over unwritten bytes).

## Contract

**One writer per path stays.** Two edits to the same file must still reach the store in order. That is rule 2 and it is not what is being changed.

**A failing write still keeps its bytes pending and still rethrows to `commit`'s caller.** Both are existing, deliberate, and documented in `#drainLoop`. Do not "simplify" either.

**The journal's forget rule stays.** The entry is dropped only when the store took *those* bytes and nothing newer arrived while the write was in flight.

**No busy loop and no unbounded rescheduling.** Closing the gap must not turn a failing write into a spin.

**Note for the record, do not fix here:** `#drainLoop` forgets the journal entry only when the store took the bytes, so a stranded write keeps *both* a live journal entry and stale pending bytes. That is a candidate second route to a symptom investigated in the previous epic and it belongs to ticket 06.

## Out of scope

- **Retrying a failed write.** That is ticket 02. This ticket is about a write that was never attempted, not one the store refused.
- **Widening `SaveState` or adding a reason surface.** That is ticket 03.
- **The Write-Ahead Journal's design**, the debounce policy, `capture()`, or `abandon`/`settled`. Read them; do not reshape them.
- **Proving reachability against OPFS.** Explicitly decided out.
- **`apps/editor` or `apps/viewer`.** This slice does not touch either app.

## Acceptance criteria

- [ ] A `commit` whose bytes are recorded while a previous drain is settling results in those bytes reaching the store, without any further `commit`, `queue`, or `flush`.
- [ ] The invariant is asserted directly: after any operation that leaves `pending` set, a drain is scheduled or running for that path.
- [ ] `commit` still rejects when the store rejected, and the bytes are still pending afterwards (existing behaviour, re-asserted so this change cannot have removed it).
- [ ] Two edits to one path still reach the store in order (existing behaviour, re-asserted).
- [ ] The journal entry is still forgotten only when the store took those exact bytes (existing behaviour, re-asserted).
- [ ] The mutation check is recorded per criterion: break the behaviour, watch the test go red, restore, and say in the commit message what you broke. **If a mutation stays green, report it as green with the reason — do not reword it into a pass.**

```sh
pnpm --filter @ballastella/core exec vitest run src/autosave/autosave.test.ts
pnpm lint && pnpm check && pnpm -r build && pnpm -r test
pnpm test:e2e
```

All must exit 0. Read the exit codes directly — **never pass `--reporter=` on the command line** (it replaces Playwright's reporter list and silently disables the retry budget), and do not pipe gate output through `grep`.

## Blocked by

None — can start immediately.
