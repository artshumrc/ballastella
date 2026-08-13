# 04 — Fence the size of Seam 2

## What to build

A check that refuses a Seam 2 suite larger than a recorded ceiling, so the suite cannot grow back to thirteen minutes one ticket at a time. It joins the `check-*` family that `pnpm lint` already runs.

The ceiling starts at the current count and is **lowered** by later tickets as they land. Raising it is allowed but must be a decision someone wrote down, not an accretion nobody noticed.

## Where to start

- `package.json`'s `lint` script — the chain of `node scripts/check-*.mjs` calls this joins.
- `scripts/check-e2e-network-fence.mjs` — the closest model: a rule about the Seam 2 suite, enforced by a script, with its reasoning in its own header.
- `scripts/retry-budget.mjs` — the model for a threshold that carries its own argument, including the record of a previous threshold that was too strict and what that cost.
- `pnpm exec playwright test --list` is how the suite's size is known without running it.

## Contract

- **A count, not a wall-clock budget.** A timing gate on a shared, unevenly-loaded box fails for reasons nobody can act on, which is precisely the argument `retry-budget.mjs` already records about a gate that fires on something nobody can fix. The header must say that a count is a proxy and an imperfect one.
- **The failure message names the ceiling, the current count, the overage, and this spec**, so someone who trips it can tell whether they should move a claim down or argue for a higher ceiling.
- **The ceiling lives in one place** and is readable by a human without running anything.
- **There is a positive control.** Setting the ceiling below the current count must fail the check. A fence nobody has watched fail is a fence nobody should trust — the same discipline `BALLASTELLA_E2E_RETRY_BUDGET=0` provides for the retry budget.
- Listing the suite must not start the web servers or build the apps; `--list` does not, and the check must stay that cheap or `pnpm lint` stops being fast.

### User Stories

5, 9, 10.

## Out of scope

- Lowering the ceiling to a target. It starts at the current count; ticket 15 sets the final one.
- Fencing anything about the Vitest projects. They are nearly free and the whole point is that work should move *into* them.
- Enforcing the retirement rule mechanically — that a retired test names its replacement is a review criterion, not a script.

## Acceptance criteria

- [ ] `pnpm lint` runs the check and passes at the current count.
- [ ] Setting the ceiling one below the current count makes `pnpm lint` fail, with a message naming both numbers.
- [ ] The check does not start a web server or trigger a build, and adds no more than a second or two to `pnpm lint`.
- [ ] The ceiling and its rationale are readable in one file.

```bash
pnpm lint                                   # passes
pnpm exec playwright test --list | tail -3  # the count the ceiling is set from
# then temporarily lower the ceiling by one and re-run:
pnpm lint                                   # must fail, naming ceiling and count
time pnpm lint                              # comparable to before this ticket
```

Success: `pnpm lint` passes as it stands and fails when the ceiling is lowered by one.

## Blocked by

- 01
