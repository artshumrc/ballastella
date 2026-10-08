#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { assertControls, repoRoot } from './fence.mjs';

export const SEAM_2_CEILING = 674;

export const sizeVerdict = ({ count, ceiling }) => {
	const overage = count - ceiling;
	return {
		overage,
		overCeiling: overage > 0,
		summary: `${count} Seam 2 tests against a ceiling of ${ceiling}`
	};
};

export const countInListing = (output) => {
	const match = /^Total:\s+(\d+)\s+tests?\s+in\s+\d+\s+files?$/m.exec(output);
	return match ? Number(match[1]) : null;
};

const CEILING_ENVIRONMENT_VARIABLE = 'BALLASTELLA_SEAM_2_CEILING';

const ceilingFromEnvironment = (environment) => {
	const raw = environment[CEILING_ENVIRONMENT_VARIABLE];
	if (raw === undefined || raw === '') return SEAM_2_CEILING;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) {
		console.error(
			`\n${CEILING_ENVIRONMENT_VARIABLE} must be a whole number of tests, got ${JSON.stringify(raw)}.\n`
		);
		process.exit(1);
	}
	return parsed;
};

const runControls = () => {
	const controlFailures = [];
	if (!sizeVerdict({ count: SEAM_2_CEILING + 1, ceiling: SEAM_2_CEILING }).overCeiling) {
		controlFailures.push('one test over the ceiling is no longer refused');
	}
	if (sizeVerdict({ count: SEAM_2_CEILING, ceiling: SEAM_2_CEILING }).overCeiling) {
		controlFailures.push('a suite exactly at the ceiling is now refused');
	}
	if (countInListing('Total: 669 tests in 35 files') !== 669) {
		controlFailures.push('the listing’s total is no longer being read');
	}
	assertControls(controlFailures, '');
};

const main = () => {
	runControls();
	const ceiling = ceilingFromEnvironment(process.env);

	let listing;
	try {
		listing = execFileSync('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=list'], {
			cwd: repoRoot,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe']
		});
	} catch (error) {
		console.error(
			'\ncheck-seam-2-size: `playwright test --list` failed, so the suite was not counted.\n'
		);
		console.error(error.stdout ?? '');
		console.error(error.stderr ?? '');
		process.exit(1);
	}

	const count = countInListing(listing);
	if (count === null) {
		console.error(
			'\ncheck-seam-2-size: `playwright test --list` printed no `Total: N tests in M files` line,\n' +
				'so the count could not be read. This check is not guarding anything until that is fixed.\n'
		);
		process.exit(1);
	}

	const verdict = sizeVerdict({ count, ceiling });
	if (!verdict.overCeiling) {
		console.log(`check-seam-2-size: ${verdict.summary} (${ceiling - count} to spare).`);
		process.exit(0);
	}

	console.error(`\ncheck-seam-2-size: ${verdict.summary} — ${verdict.overage} over.\n`);
	console.error(
		'Seam 2 costs roughly four worker-seconds per test at its cheapest and ten at its dearest, and it\n' +
			'grew to thirteen minutes by adding a few tests at a time with nothing watching the total.\n\n' +
			'Put the claim at the highest seam at which it can still fail for the right reason: Seam 1 for\n' +
			'application logic, Seam 1c for what a component renders, announces and focuses, Seam 2 for the\n' +
			'application with real MapLibre, real OPFS, a real service worker and a real static server\n' +
			'underneath it. If it belongs here, move another claim down or raise the ceiling in\n' +
			`scripts/check-seam-2-size.mjs with a row saying why.\n`
	);
	process.exit(1);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
