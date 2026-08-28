# Ballastella

`CONTRIBUTING.md` is the contributor guide and takes precedence on anything it covers — layout, the
six toolchain rules, the deployment checks, the test seams. Read it before changing build or
publish behaviour.

## Scripts

**Prefer these over ad-hoc bash.** Each one exists because the hand-typed equivalent has already gone
wrong here in a way that produced a confident wrong answer rather than an error.

| Instead of                                 | Run                       |
| ------------------------------------------ | ------------------------- |
| `pkill -f vite`, `pkill -f "vite dev"`     | `pnpm dev:clean [ports…]` |
| `playwright test`, `CI=1 pnpm test:e2e`    | `pnpm test:e2e [args…]`   |
| chaining lint + check + test + e2e by hand | `pnpm precommit [stage…]` |

- **`pnpm dev:clean`** stops dev servers by the port they hold (5173/5174 by default; pass ports to
  override) **and only when they belong to this checkout**. Never `pkill` by name pattern: it matches
  every checkout on the machine and every other agent's server, including the one the current run is
  testing against. `dev-clean` reads each holder's working directory and leaves anything outside the 
  repo root alone, naming the pid and
  command so the caller can see what it refused. An unreadable cwd counts as *not ours*.
- **`pnpm test:e2e`** clears this checkout's derived ports, then runs the suite. Extra arguments pass
  through to Playwright (a spec name, `--headed`, `--project`). **Do not pass `--reporter=…`** — it
  replaces the whole reporter list and silently drops the retry budget; spell it
  `--reporter=line,./scripts/retry-budget.mjs` if you need both.
- **`pnpm precommit`** runs lint → check → test → e2e, cheapest first, stopping at the first failure
  and printing a per-stage timing summary. Name stages to run a subset: `pnpm precommit lint check`.
  It excludes `check:deployment`, which asks about a published site rather than a working tree.

### The e2e ports are derived, not fixed and not random

`scripts/e2e-port.mjs` hashes the checkout path into a stable pair in 20000–39998, imported by both
`playwright.config.ts` and `scripts/e2e.mjs`. Do not replace this with a fixed port or a random one.

A stale listener in the *same* tree is the remaining case, and it is why both the wrapper and
Playwright's `webServer` call `scripts/free-e2e-port.mjs` before binding.

## Ticket Tracker

Epics and Tickets live in Botley; the `botley` command is the only way to read or write them.
They track work in flight and are deleted once it lands, so **nothing in this repository may
cite one**. What survives a completed Epic is the code, `CONTEXT.md`'s glossary, `CONTRIBUTING.md`,
and an ADR where the decision was hard to reverse.