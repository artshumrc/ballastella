# Tracker for nothing-fails-silently

## Purpose

Every failure to write, and every failure to fetch, either succeeds, is retried, or is **said** — in words, on the screen, to the person who can act on it. Three findings from `workspace-and-layers` say Ballastella currently has states where something has gone wrong and nothing anywhere reports it: a `commit` that resolves successfully while its bytes never reach the store, a Historical Map whose tiles stop arriving and answer with an uncaught error, and one unexplained case of the screen being ahead of the disk.

Scope, user stories, and the testing approach are in [SPEC.md](./SPEC.md).

## Current status

**Not Started.** Six tickets, sliced 2026-08-09.

**Ready now: 01 and 04.** They do not collide — 01 is the write path in the domain package, 04 is the render seam and the viewer — so they can run in parallel. `02 → 03` and `04 → 05` are the two chains; `06` waits on the write path settling under 01 and 02.

The three seams are decided and are all existing ones (human decision, 2026-08-09): the domain package's **node** vitest project for the write path and the failure sentences; the Playwright **viewer** project for the Reader-facing half, whose existing "no uncaught page error on any navigation" assertion is what surfaced two of these; and the Playwright **editor** project for the author-facing half. **No new seam is to be introduced.**

Last updated: 2026-08-09.

## What is already known — do not re-derive it

**The write gap is confirmed, not suspected.** Reproduced deterministically in the domain package with a store whose writes resolve on command: a `commit` landing in the microtask between the drain loop finishing and its memo being cleared is handed the settling promise, records its bytes as pending, and nothing restarts. The caller's promise **resolves successfully**. Two further measured facts: a flush recovers the bytes, because they are still pending; and the next write to that path destroys them, because it overwrites pending before draining. So the last write of a burst is lost permanently and a superseded one silently.

**The symptom is not "Saved over missing bytes".** The indicator reads `unsaved`, because the derived state still sees pending. It presents as *Unsaved, forever, for no reason*, with one caller told it succeeded.

**Reachability in production is unproven and is not claimed.** The window is one microtask, entered only by a continuation registered on a promise settling in the same batch after the drain loop registered its own. Synthetic reproduction is trivial; that real storage timing produces it has not been shown.

**The render-seam error is measured at 3 failures in 8 runs, and at the same rate on the commit before the work that found it** — so it is pre-existing and not contention. The store's unreachable-file error escapes the third-party image loader uncaught when the connection is cut with a warped Layer on screen.

**The unexplained case is genuinely unexplained.** One observation of three Control Points on screen against two on disk, never reproduced, and the confirmed write gap is ruled out **by timeline** — the observation postdates the change that closes that gap on the affected path. Do not close it with that. Two candidate mechanisms are named in the spec and should be instrumented first.

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
| 01 | [01-a-write-that-reports-success-has-been-written.md](./tickets/01-a-write-that-reports-success-has-been-written.md) | Not Started | — | 6, 7, 8, 23, 24, 30 |
| 02 | [02-a-failed-write-retries-itself.md](./tickets/02-a-failed-write-retries-itself.md) | Not Started | 01 | 1, 9, 29 |
| 03 | [03-a-save-that-gave-up-says-so.md](./tickets/03-a-save-that-gave-up-says-so.md) | Not Started | 02 | 2, 3, 4, 5, 10, 27, 28, 31, 33–38 |
| 04 | [04-a-reader-is-told-when-tiles-stop-arriving.md](./tickets/04-a-reader-is-told-when-tiles-stop-arriving.md) | Not Started | — | 14–21, 27, 28, 32, 33 |
| 05 | [05-the-same-sentence-on-the-authors-side.md](./tickets/05-the-same-sentence-on-the-authors-side.md) | Not Started | 04 | 11, 12, 13, 19, 22, 32 |
| 06 | [06-instrument-the-screen-ahead-of-disk-disagreement.md](./tickets/06-instrument-the-screen-ahead-of-disk-disagreement.md) | Not Started | 01, 02 | 25, 26 |

**Stories 39 and 40 are cross-cutting and deliberately absent from the ledger** — keep the uncaught-error assertions in the end-to-end suites, and make any deliberate exception to them narrow, measured, and stated. They belong inside tickets 04 and 05, and inside anything later that touches those suites.

**06 has no promised outcome, by design.** "Still open, and here is what it is not" is a complete delivery. Closing it against a plausible cause without evidence is the failure this epic exists to prevent.

## Critical path

**01 → 02 → 03** is the write path and the longest chain. **04 → 05** is the render seam. **06** hangs off 01 and 02.

**03 is the ticket most likely to hurt**: it is the one that has to make a distinction the interface does not currently draw — "a debounce is pending" against "a write gave up" — and it inherits the repo's settled but easily-missed rules about which announcement mechanism is reliable for text that is inserted rather than changed.
