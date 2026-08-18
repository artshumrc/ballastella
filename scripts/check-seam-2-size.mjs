#!/usr/bin/env node
// The Seam 2 suite may not be larger than a recorded ceiling.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ WHY THIS EXISTS: THIRTEEN MINUTES ARRIVED ONE TICKET AT A TIME.                            │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// Nobody decided to spend a quarter of an hour on every gate. Eighteen tickets each added a handful
// of browser tests, every one of them defensible on its own, and 675 tests is what that looks like
// once nothing is watching the total. See
// `.tracker/the-suite-runs-in-three-minutes/SPEC.md` for the measurement and the argument.
//
// This makes regrowth a *decision*. The ceiling can be raised — it is a number in a file, not a
// principle — but raising it means editing {@link SEAM_2_CEILING} and writing down why, which is a
// thing a reviewer can see. Accretion is what it stops, not growth.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// A COUNT IS A PROXY FOR TIME, AND AN IMPERFECT ONE.
//
// What actually hurts is worker-seconds, and tests here differ by more than a factor of two: 4.14s
// per test in `viewer-reader` against 9.63s in `editor-annotations`
// (`.tracker/the-suite-runs-in-three-minutes/COST-PROFILE.md`). So a run can lose ten cheap tests,
// gain two dear ones, and this check will call that an improvement when it was not. `pnpm test:e2e
// --profile` (`scripts/cost-profile.mjs`) is where cost per test is read; this is only the fence.
//
// It is still a count rather than a wall-clock budget, deliberately. A timing gate on a shared,
// unevenly-loaded box fails for reasons nobody can act on, which is exactly the argument
// `scripts/retry-budget.mjs` records about the 0.5% budget that fired on contention no code change
// removed. A gate that fires on something nobody can fix stops being a signal and becomes a toll.
// A count is at least a number the person who tripped it chose.
//
// The count is whatever `playwright test --list` reports, skips included — 628 today, one of which
// is a deliberate skip. Listing does not build the apps or start the web servers, which is what
// keeps this affordable inside `pnpm lint`; it costs about a second.
//
// Override with `BALLASTELLA_SEAM_2_CEILING` to watch the fence fail on purpose, which is the
// positive control this check's contract requires:
//
//     BALLASTELLA_SEAM_2_CEILING=627 node scripts/check-seam-2-size.mjs   # must fail

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * The most Seam 2 tests this repository will carry.
 *
 * | When | Ceiling | Why |
 * | --- | --- | --- |
 * | 2026-08-13 | 669 | Where the epic starts: the count after scheduling and the first migration, so the fence holds the line before it starts moving it. |
 * | 2026-08-13 | 637 | Tickets 06, 09, 10 and 12: the annotation document, Base Map catalog and arithmetic, Project Bundle refusal and publish output claims now live at Seam 1. |
 * | 2026-08-13 | 634 | The slow-test pass: a footnote-syntax claim already asserted six times at Seam 1 retired from `editor-annotations`, and the transformation picker's option list and disclosure rehoused to Seam 1c. |
 * | 2026-08-14 | 628 | Tickets 07, 08 and 11: the Annotation row, editor panel and tool announcements, the foreign Layer row and the problem-action gating, and the hub's wording all move to Seam 1c. |
 * | 2026-08-14 | 630 | Binding on the strength of a GitHub sign-in, and the grant record surviving it. The bug was that the *dialog* validated its paste field regardless, so a signed-in scholar was asked for a token anyway — a claim about a component reading a store, which Seam 1 cannot reach (no `WorkspaceStorage` harness exists) and which a fake store at Seam 1c would assert about the fake. |
 * | 2026-08-18 | 631 | A pasted address that is a plain image file, copied into the Workspace and tiled here. The download and its refusals are asserted at Seam 1 (`remote-image/fetch-remote-image.test.ts`) and the tiler at Seam 1 already; what only Seam 2 can see is that the three halves are wired together — the IIIF reader hands the address over, the dialog closes on the download, and a pyramid of this Workspace's own is what the Layer ends up drawing. |
 * | 2026-08-18 | 632 | A dragged Resource Mask corner and Annotation vertex must repaint MapLibre's real GeoJSON source before pointer-up. The transient geometry can only be proved against the renderer that draws the outline, not against the editing state that feeds it. |
 *
 * Lowered by the tickets of `the-suite-runs-in-three-minutes` as claims move down a seam; ticket 15
 * sets the final one. **Raising it needs a row above and a reason in it.**
 */
export const SEAM_2_CEILING = 632;

/**
 * Whether a suite of this size is over the ceiling, and the sentence saying so.
 *
 * A pure function of two numbers so the decision can be read, and tested, without a Playwright
 * process around it.
 */
export const sizeVerdict = ({ count, ceiling }) => {
	const overage = count - ceiling;
	return {
		overage,
		overCeiling: overage > 0,
		summary: `${count} Seam 2 tests against a ceiling of ${ceiling}`
	};
};

/**
 * The test count in `playwright test --list` output.
 *
 * Read from the `Total: N tests in M files` line rather than by counting printed lines, because the
 * listing carries a reporter summary underneath it and a line count would quietly include it. A
 * listing whose shape changed returns `null` rather than a number that happens to parse: this fence
 * dying silent is the failure mode worth spending a branch on.
 */
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

// ── Positive control ──────────────────────────────────────────────────────────────────────────
//
// A fence nobody has watched fail is a fence nobody should trust, and this one's way of dying is
// silent: if `sizeVerdict` ever stopped saying yes, a growing suite and a shrinking one would print
// the same success line. The end-to-end half of the control is the environment variable above.

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
	if (controlFailures.length > 0) {
		console.error('\nThis check can no longer detect what it exists to detect.\n');
		for (const failure of controlFailures) console.error(`  ${failure}`);
		console.error('');
		process.exit(1);
	}
};

// ── The count ─────────────────────────────────────────────────────────────────────────────────

const main = () => {
	runControls();

	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const ceiling = ceilingFromEnvironment(process.env);

	let listing;
	try {
		// `--list` resolves and prints the suite without running anything, so no web server starts and no
		// app is built. Keep it that way: a `pnpm lint` that builds the editor is a `pnpm lint` nobody runs.
		//
		// ⚠ `--reporter` is pinned here, and `playwright.config.ts`'s warning against passing it does not
		// apply: that warning is about losing the retry budget on a *run*, and `--list` runs nothing and
		// retries nothing. It has to be pinned because this inherits `process.env`, and under `CI` the
		// config selects `github` + `html` instead of `list` — which prints no `Total:` line for the
		// parser below (so `pnpm lint` failed outright on CI) and writes a `playwright-report/`
		// describing a run that never happened, for a later e2e step to find.
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
			`scripts/check-seam-2-size.mjs with a row saying why.\n\n` +
			'  .tracker/the-suite-runs-in-three-minutes/SPEC.md\n'
	);
	process.exit(1);
};

// Importing this module must not spend a second listing the suite, which is what lets the two pure
// functions above be tested at all.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
