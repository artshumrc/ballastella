#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const checks = [
	{ what: 'Base Map archive', script: 'check-base-map-catalog.mjs' },
	{ what: 'place lookup service', script: 'check-place-service.mjs' }
];

const failures = [];
for (const { what, script } of checks) {
	const run = spawnSync(process.execPath, [path.join(here, script), '--deployment'], {
		stdio: 'inherit'
	});
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
