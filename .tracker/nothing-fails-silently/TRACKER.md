# Tracker for nothing-fails-silently

## Purpose

Every failure to write, and every failure to fetch, either succeeds, is retried, or is **said** — in words, on the screen, to the person who can act on it. Three findings from `workspace-and-layers` say Ballastella currently has states where something has gone wrong and nothing anywhere reports it: a `commit` that resolves successfully while its bytes never reach the store, a Historical Map whose tiles stop arriving and answer with an uncaught error, and one unexplained case of the screen being ahead of the disk.

Scope, user stories, and the testing approach are in [SPEC.md](./SPEC.md).

## Current status

**01 and 04 are delivered and merged to `main`.** 02 is superseded — see the ledger. Re-sliced 2026-08-09 after a change of direction recorded in [SPEC.md](./SPEC.md); three new tickets (07, 08, 09) replace the durability half.

**Ready now: 07 and 09.** They do not collide — 07 is `replay.ts`, 09 is `autosave.ts`'s internal state — and 09 has no dependency at all. `07 → 08`, `07 → 03`, `07 → 06`, and `04 → 05`.

**What the two delivered tickets cost, for calibration.** 01 took four commits and three review rounds; 04 took five commits and four. Every round found something real, and several rounds found defects introduced by the previous round's fix. That is the argument for 09: the defects were not carelessness, they were a state machine held together by convention.

The three seams are decided and are all existing ones (human decision, 2026-08-09): the domain package's **node** vitest project for the write path and the failure sentences; the Playwright **viewer** project for the Reader-facing half, whose existing "no uncaught page error on any navigation" assertion is what surfaced two of these; and the Playwright **editor** project for the author-facing half. **No new seam is to be introduced.**

Last updated: 2026-08-09.

## What is already known — do not re-derive it

**The write gap is confirmed, not suspected.** Reproduced deterministically in the domain package with a store whose writes resolve on command: a `commit` landing in the microtask between the drain loop finishing and its memo being cleared is handed the settling promise, records its bytes as pending, and nothing restarts. The caller's promise **resolves successfully**. Two further measured facts: a flush recovers the bytes, because they are still pending; and the next write to that path destroys them, because it overwrites pending before draining. So the last write of a burst is lost permanently and a superseded one silently.

**The symptom is not "Saved over missing bytes".** The indicator reads `unsaved`, because the derived state still sees pending. It presents as *Unsaved, forever, for no reason*, with one caller told it succeeded.

**Reachability in production is unproven and is not claimed.** The window is one microtask, entered only by a continuation registered on a promise settling in the same batch after the drain loop registered its own. Synthetic reproduction is trivial; that real storage timing produces it has not been shown.

**The render-seam error is measured at 3 failures in 8 runs, and at the same rate on the commit before the work that found it** — so it is pre-existing and not contention. The store's unreachable-file error escapes the third-party image loader uncaught when the connection is cut with a warped Layer on screen.

**The unexplained case is genuinely unexplained.** One observation of three Control Points on screen against two on disk, never reproduced, and the confirmed write gap is ruled out **by timeline** — the observation postdates the change that closes that gap on the affected path. Do not close it with that. Two candidate mechanisms are named in the spec and should be instrumented first.

## A defect found while measuring, and not this epic's to fix

`editor-align-referenced.e2e.ts:735` retried across several runs during this epic. It was measured rather than argued about, on an exclusive box, and the answer is **a pre-existing application defect, not load and not ticket 04**.

- **It is not ticket 04.** It reproduces on `7868a4b`, one commit before ticket 04 existed, with an identical stack and an identical call log. The `await passThrough(...)` / `inFlight` microtask suspect is ruled out as the introducer.
- **It is not load, and this is the number.** The passing retry ran under *identical* concurrency to the failure — same run, same 4 workers, dispatched as test #169 of 523 with ~350 still in flight — and finished in **11.5–23.8s against the failed attempt's 180s**. Load was not lower when it passed. Contention makes work slow; it does not make a laid-out button vanish for 172 consecutive seconds.
- **What it is.** `locator.click` on `getByTestId('remote-read')` (`e2e/editor-align-referenced.e2e.ts:113`, inside `addReferenced`) logs `element is not stable` twice, then `element is not visible` **345 times** — ~172s of polling an already-resolved button. The Add-Historical-Map dialog closes under the click and never returns. `e2e/support/historical-maps.ts` documents this exact signature as the bug `HTMLDialogElement.open` was introduced to fix. **It is not fully fixed.** `openAddHistoricalMap` verifies `open === true` and all three sources visible, and the dialog closes anyway after that check passes.

That is an app/helper race in the Add-Historical-Map dialog, not a harness problem and not this epic's subject. It needs its own ticket.

**Not measured:** any workers=1 or workers=2 cell, on any commit. So the "load *widens* an existing window" half is unproven and is not claimed — only the "pre-existing" half is.

This is the fourth time this repository has had a failure attributed to load and found a defect underneath. The standing constraint below is why it was caught.

## Standing constraints

These are carried from `workspace-and-layers`, where each was paid for.

- **The mutation check is mandatory.** Break the behaviour, confirm the test goes red, restore, and record what you broke. Two-axis review found real defects after a green report in **sixteen of sixteen** tickets there, and the highest-value findings were against *fix* commits rather than original ones.
- **The failure mode is claims outrunning code.** A comment or commit message asserting more than was delivered, with a suite that passes either way. If something is left open, say so plainly rather than describing it as closed.
- **Reviews must measure, not read.** What worked: probing the build to prove which runtime was emitted, running at two worker counts to separate "load causes it" from "load widens the window", mutating a test id to one that does not exist. The one review that only read produced a confidently wrong finding, which the implementer refuted by mutation.
- **Before attributing anything to load, find the number that rules it out.** This repository has been wrong about that repeatedly, and each time the real cause was a defect.
- **No test may depend on the network.** Enforced by a composed root fixture and a check that fails any spec importing the raw test function, plus setup fences on the unit projects.
- **Never pass a reporter override on the command line.** It replaces the reporter list and silently disables the retry budget — the instrument that surfaced two of the three problems here. Do not filter gate output through a pattern; read exit codes.

## Ledger

`Fulfills` lists the [SPEC.md](./SPEC.md) user stories a ticket delivers.

| Number | Filename | Status | Depends On | Fulfills |
| --- | --- | --- | --- | --- |
| 01 | [01-a-write-that-reports-success-has-been-written.md](./tickets/01-a-write-that-reports-success-has-been-written.md) | Completed | — | 6, 7, 8, 23, 24, 30 |
| 02 | [02-a-failed-write-retries-itself.md](./tickets/02-a-failed-write-retries-itself.md) | Out of Scope | 01 | — |
| 03 | [03-a-save-that-gave-up-says-so.md](./tickets/03-a-save-that-gave-up-says-so.md) | Not Started | 07 | 2, 3, 4, 5, 10, 27, 28, 31, 33–38 |
| 04 | [04-a-reader-is-told-when-tiles-stop-arriving.md](./tickets/04-a-reader-is-told-when-tiles-stop-arriving.md) | Completed | — | 14–21, 27, 28, 32, 33 |
| 05 | [05-the-same-sentence-on-the-authors-side.md](./tickets/05-the-same-sentence-on-the-authors-side.md) | Not Started | 04 | 11, 12, 13, 19, 22, 32 |
| 06 | [06-instrument-the-screen-ahead-of-disk-disagreement.md](./tickets/06-instrument-the-screen-ahead-of-disk-disagreement.md) | Not Started | 07 | 25, 26 |
| 07 | 07-replay-never-reverts-newer-bytes.md *(to write)* | Not Started | 01 | 1, 6, 9 |
| 08 | 08-leaving-with-unwritten-work-is-refused.md *(to write)* | Not Started | 07 | 2, 5, 9 |
| 09 | 09-one-state-per-path-instead-of-six-fields.md *(to write)* | Not Started | — | 23, 30 |

### Why 02 is Out of Scope rather than Completed

Its branch is at `d5bc878` (3 commits on `ticket/nfs-01`), reviewed on both axes plus a verification pass, 38 mutations / 36 red, unit gates green, e2e never run. **It is not merged and should not be.** Everything it built — the bounded retry, `strandedWrites`, `quiescing`, `resume(prefix)`, the widened `#publish` — is what the change of direction deletes. Merging it in order to remove it next week is churn.

Two things in it are worth salvaging into 07 and 09 rather than losing: the measurement that `settled()` could answer `true` with a write still coming, and the `vi.getTimerCount()` discipline that caught three assertions which could not distinguish "nothing scheduled" from "scheduled for ever".

### The three new tickets

- **07 — replay never reverts newer bytes.** The prerequisite. Everything else waits on it. It is a correctness fix to `replayJournal`, not a feature: compare what the store holds against what the entry carries before writing, and stop reporting a revert as `restored`.
- **08 — leaving with unwritten work is refused.** The `beforeunload` warning. Small, and only honest once 07 lands.
- **09 — one state per path instead of six fields.** `Autosave` carries `pending`, `draining`, `timer`, `error`, `failedAttempts` and `quiescing` as independent fields whose legal combinations are held by convention across six methods. Roughly half of everything this epic found was two of those fields disagreeing, and two such defects were introduced *by fixes for earlier ones*. Replace them with `Idle | Debouncing | Writing | Retrying | GaveUp`, so the invariant "if bytes are pending, a drain is scheduled or running" stops being a thing we test and becomes a thing that cannot be spelled. Publish out-of-band at one seam while there, which retires the throwing-subscriber class the same way.

  09 does not depend on 07 and can run alongside it. It is the highest ratio of deleted defect-classes to work in the epic.

**Stories 39 and 40 are cross-cutting and deliberately absent from the ledger** — keep the uncaught-error assertions in the end-to-end suites, and make any deliberate exception to them narrow, measured, and stated. They belong inside tickets 04 and 05, and inside anything later that touches those suites.

**06 has no promised outcome, by design.** "Still open, and here is what it is not" is a complete delivery. Closing it against a plausible cause without evidence is the failure this epic exists to prevent.

## Critical path

**01 → 02 → 03** is the write path and the longest chain. **04 → 05** is the render seam. **06** hangs off 01 and 02.

**03 is the ticket most likely to hurt**: it is the one that has to make a distinction the interface does not currently draw — "a debounce is pending" against "a write gave up" — and it inherits the repo's settled but easily-missed rules about which announcement mechanism is reliable for text that is inserted rather than changed.
