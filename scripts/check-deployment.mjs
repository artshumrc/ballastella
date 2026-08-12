#!/usr/bin/env node
// `pnpm check:deployment` — every question this repository asks about *the world it deploys into*,
// asked in one command. Two today: the Base Map archive (ADR-0020, ADR-0025) and the place lookup
// service (ADR-0029).
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ EVERY CHECK RUNS. THIS DOES NOT SHORT-CIRCUIT, AND THAT IS THE WHOLE DESIGN.               │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// Written as `a && b` — the obvious spelling, and the one a shell offers — this would report on the
// lookup service only while the Base Map check passed. On this repository it never does: ADR-0025
// records the deliberate decision that the borrowed archive stays until there is a hosting budget,
// so the second half would have been dead from the day it was written and nobody would have noticed
// that the warning it exists to print was never printed.
//
// That failure has already happened here once in a different form. `check-base-map-catalog.mjs`
// records on its own `let failed` that exiting early on the deployment refusal is how
// `pnpm check:deployment` came to skip the ADR-0020 containment scan entirely — the check gating
// production, silently doing half its job. The same mistake at the next level up would be this file.
//
// So: each check runs, whatever the one before it said; every output reaches the terminal; and the
// exit code is non-zero if **any** of them failed. The two are not the same kind of statement, and
// that asymmetry is deliberate and argued in ADR-0029 —
//
//   - the Base Map archive **fails**: repointing it is putting a file in a bucket you control, which
//     an instructor can do in an afternoon.
//   - the lookup service **warns and stays green**: repointing it means running a planet-scale
//     geocoder, and a check that fails with a remedy nobody can take is one people learn to route
//     around — taking the satisfiable check beside it down with it.
//
// Neither is advisory to the *composite*, though. A check that warns still runs, still prints, and
// still gets to fail for its own other reasons — the lookup check's containment scan is a `pnpm
// lint` failure in either mode.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Every deployment question, in the order a forker meets them in `docs/hosting.md`. */
const checks = [
	{ what: 'Base Map archive', script: 'check-base-map-catalog.mjs' },
	{ what: 'place lookup service', script: 'check-place-service.mjs' }
];

const failures = [];
for (const { what, script } of checks) {
	const run = spawnSync(process.execPath, [path.join(here, script), '--deployment'], {
		stdio: 'inherit'
	});
	// A check that never ran and a check that failed are both blocking and are not the same news:
	// `spawnSync` reports a missing or unrunnable script as `status: null` and an `error`, which
	// counted silently would read as a verdict about the deployment rather than about this file.
	if (run.error) {
		console.error(`\n${script} could not be run: ${run.error.message}\n`);
		failures.push(`${what} (its check did not run)`);
	} else if (run.status !== 0) {
		failures.push(what);
	}
}

if (failures.length > 0) {
	console.error(`\ncheck:deployment — blocked by: ${failures.join(', ')}.\n`);
	process.exit(1);
}

console.log(`\ncheck:deployment — ${checks.length} checks ran, none blocking.\n`);
