# 13 — Decide the Remote family by measurement

## What to build

Four specs — `editor-clone-remote` (18), `editor-review-remote` (20), `editor-remote-binding` (20), `editor-github-signin` (20) — total 78 tests and **reference no map or canvas at all**. During the investigation that produced this epic they were first proposed as the biggest single count reduction, and then set aside on the grounds that count is not cost. Neither claim was measured.

**Measure first, then act on what you find.** This ticket is deliberately shaped as a decision, not a foregone migration.

## Where to start

- Ticket 03's profile is the input. Read it before touching anything.
- `e2e/support/github-hosts.ts` — `routeGitHubHosts`, the fake these specs drive. Each spec also has its own local `start()` that is *not* the alignment bootstrap: it routes the fake, navigates, empties storage and reloads. That is cheap, which is why these tests may already be near the floor.
- `packages/core/src/remote/fake-github.test.ts` — the fake already has Seam 1 coverage; `bind-remote.test.ts`, `clone-from-remote.test.ts`, `review-from-remote.test.ts`, `github-sign-in.test.ts`, `credential-store.test.ts` and `remote-tree.test.ts` are the adjacent modules.
- ADR-0031 (the broker exchanges a code, never data), ADR-0032 (publish means the Remote), ADR-0033 (a publish mirrors an owned namespace).
- ⚠ `editor-remote-binding.e2e.ts` contains the deterministic failure ticket 05 documents. **Do not fix it here** and do not let it be masked by a migration.

## Contract

- **If the profile says these tests are near the suite floor, say so and move little or nothing.** A ticket that reports "78 tests removed" while removing two minutes from a thirteen-minute suite has optimised the wrong number, and this epic has already made that mistake once in the other direction.
- **What must stay at Seam 2 whatever the profile says**: that a credential is held in `sessionStorage` and not written to the Workspace; that a first visit asks GitHub nothing at all; that the sign-in flow's redirect and code exchange work through the real browser. ADR-0031's whole point is what does and does not leave the machine, and a fake asserting that is a fake agreeing with itself.
- **What is a candidate**: the shape of what a Clone or a Review *writes into the Workspace*, and the refusals — a repository that does not exist, a namespace not owned, a conflicting local Project. Those are document questions.
- The credential-scan support module (`e2e/support/credential-scan.ts`) exists because "no credential anywhere in the Workspace" is a claim about real storage. It stays.
- Every retired Seam 2 test names its replacement.

### User Stories

5, 9, 29.

## Out of scope

- Fixing the `editor-remote-binding` failure — ticket 05 records it, and a separate epic owns it.
- Changing the fake, the broker contract, or anything in `core`'s remote modules.
- Publishing — ticket 12.

## Acceptance criteria

- [ ] The four specs' measured cost per test and total worker-seconds are recorded before any change, and compared against the suite average.
- [ ] A written decision states, per spec, how much is worth moving and why — including "little or nothing" where that is the answer.
- [ ] Whatever is moved is watched to fail once against a deliberate break.
- [ ] The credential and first-visit claims are untouched at Seam 2.
- [ ] The `editor-remote-binding` failure profile is unchanged: still exactly one deterministic failure, still the same test.
- [ ] `pnpm precommit lint check test` passes.

```bash
pnpm test:e2e editor-clone-remote.e2e.ts editor-review-remote.e2e.ts \
              editor-remote-binding.e2e.ts editor-github-signin.e2e.ts
pnpm --filter @ballastella/core test
pnpm precommit lint check test
```

Success: a recorded decision backed by the profile, and a change proportional to the cost actually found — including no change, if that is what the numbers say.

## Blocked by

- 03
- 05
