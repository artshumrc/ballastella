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
 * | 2026-08-19 | 634 | The Label: two tests for a kind of Annotation whose whole product is pixels. That a Label's words are drawn at all, that the Pin beside it did not also draw as one, that an empty title draws nothing, and that the chip grew with the words are claims about glyphs, an SDF and `icon-text-fit` — happy-dom has none of the three, so they are Seam 2 or nowhere. Everything about the Label that is arithmetic went to Seam 1 (`label-chip.test.ts`, `stack-layers.test.ts`, `annotation-mark.test.ts`) and its row's wording to `packages/ui`; the two here are folded as far as they will go, one per fixture. |
 * | 2026-08-19 | 635 | A third Label test, for the geometry ticket 01 proved in a browser and the chip then changed: the shape stops short of the image's border so the halo has somewhere to be, which moves `content`, both stretch zones and the icon's extent. Whether `icon-text-fit` still lands on the words after that is MapLibre's arithmetic over a shaped text block, so it is unreachable at Seam 1 — and it needs its own fixture, six Labels far enough apart that the widest chip cannot reach the next one's coordinate, which is why it did not fold into either test above. |
 * | 2026-08-19 | 636 | One test for the gesture that *makes* a Label, which every Label test before it seeded instead. It is the only place three things meet: the keyboard alone reaching the tool and placing at the crosshair, the coalesced write count for placing and then typing (real OPFS, and a count no fake can stand in for), and — the claim the inheritance carve-out exists for — that the Pin drawn straight after a Label is written and painted as a Pin. The style arithmetic behind all of it is asserted at Seam 1 (`annotation.test.ts`, `annotation-editing.svelte.test.ts`) and the toolbar's fourth button at Seam 1c; this is one browser test rather than the four the criteria could have been read as. |
 * | 2026-08-19 | 639 | Label portability needs three browser tests: opening a Project must leave its OPFS files untouched; a bundled Label must draw in a Review Workspace; and a restored Label must draw. Core asserts the bytes and the transfer paths without parsing them, but only the running applications can prove the real Project files and MapLibre rendering meet at each handoff. |
 * | 2026-08-19 | 641 | Two tests for the Reader's half of the Label, and both need a **served** site rather than a dev server: that publishing a Project changes nothing about how its Labels look is a claim only a real Published Site can falsify, since the glyphs their words are shaped from are files the publish copies, the stack is rebuilt from a Project parsed out of static HTTP, and the Inspector is compiled into a second application. One reads the drawing — the bucket, the coordinate, the chip's width per `marker-size`, and the two colours off the framebuffer, none of which exists outside a browser; the other clicks a Label and sweeps the Inspector for the author's controls, which is the absence-of-a-snippet rule holding on the app that actually ships. |
 * | 2026-08-19 | 645 | Four Label tests: the keyboard journey adds Tab-reachability with no pointer, plus the style and delete legs; the 636 row already covers reaching the tool and placing at the crosshair with Enter. The Layers test needs a browser for MapLibre visibility and for a neighbouring Map Image's opacity slider leaving Annotation paint untouched; its count rides along, already provable at Seam 1c in `packages/ui/src/annotation-list.dom.test.ts`. The other two use real OPFS to prove deletion restores the source Layer's exact bytes and position, including an untitled Label. |
 * | 2026-08-19 | 646 | One test for dragging an Annotation: onto another row to reorder it, and onto another Annotation Layer's card to move it between two GeoJSON files. happy-dom's `DragEvent` constructor drops `dataTransfer`, which is the member both decisions read — what tells an Annotation being dragged from a Layer being dragged is the format the drag carries — so a Seam 1c claim would be a fake agreeing with a fake about the one thing the fake gets wrong. The ordering arithmetic is at Seam 1 (`annotation.test.ts`), and the two-file write order, the hidden-target read and the refusal at Seam 1 too (`annotation-editing.svelte.test.ts`); the keyboard path — the Inspector's Move buttons and its Layer picker — needs no browser and is not here. |
 * | 2026-08-22 | 647 | One test for an Import that did not finish. Every decision recovery makes is asserted per durable boundary at Seam 1 (`project-import-recovery.test.ts`), including that both real backings agree, because the sweep and the reclaim are the shared adapter suite's subject. What no seam below can falsify is that the *applications* are gated on it: the Project list is an effect over `?p=` that runs the moment the layout mounts, the Map Image list and the Workspace's size are two more walks of real OPFS, and a Backup is a third — five readers of one Workspace, in a browser, none of which may see a provisional file. It is one test with three restarts in it rather than three, and the chosen-folder half folded into `editor-folder-workspace.e2e.ts`'s existing adoption sweep. |
 * | 2026-08-22 | 650 | Three tests for Remote Status. The six determinations, the table behind them, the bounded interval, the coalescing, the retained failure and the per-Workspace isolation are all exhausted at Seam 1 (`remote-status.test.ts`, `local-change-index.test.ts`, `synchronization-planner.test.ts`) with no browser. What no seam below can falsify is that the *bar* carries it: a signed-out session that polls nothing until a keyboard press, an authenticated one that checks itself on sign-in and on window focus without spending a request per focus, a persistent control that survives the route change onto a Project while `Saved locally` stays the page's one `status` region, and a pending listing that a Workspace switch cannot land on the arriving Workspace. Real IndexedDB metadata, real OPFS writes through the change index, and the real navigation bar are the three things being wired together, and there is no `WorkspaceStorage` harness at Seam 1c to reach any of them. |
 *
 * Lowered by the tickets of `the-suite-runs-in-three-minutes` as claims move down a seam; ticket 15
 * sets the final one. **Raising it needs a row above and a reason in it.**
 * | 2026-08-22 | 654 | Four tests for Import, the inverse of Export. The engine is exhausted at Seam 1 without a browser — fresh Map Image identities, repeated references, name and directory allocation against every namespace, the publication reset, provenance inheritance, and the atomic transaction with its quota and collision refusals are five test files there. What no seam below can falsify is that the *application* performs the operation it offers: that three actions on one screen mean three different things to real OPFS (Import writes into the Workspace that is open, Review creates a second one, New Project creates neither), that the Workspace named in the offer is the one written to and no other is created, that a Project arriving under an allocated name is reachable and ordinary afterwards, and that a refusal leaves every byte as it was. There is no `WorkspaceStorage` harness at Seam 1c to reach any of it, and "no second Workspace exists on disk" is the assertion that tells Import and Review apart at all. One test per claim that cannot fold: the successful copy, the three-way distinction with its two free exits, the two refusals, and the progress a pyramid's wait needs. |
 * | 2026-08-22 | 655 | One test for Update from GitHub, the inbound transfer. The three-way plan, the commit-pinned inventory, the SHA verification, the deletion refusal, the graph refusals, the rollback and the Baseline arithmetic are exhausted at Seam 1 against the same fake GitHub (`update-from-github.test.ts`), each refusal asserted against a complete before-and-after snapshot of the Workspace — none of it needs a browser. What no seam below can falsify is that the *application* only ever does this when asked: that a window focus and a status check apply nothing, that the one control on the bar does, and that afterwards a real OPFS Workspace holds the Remote's Project as ordinary work that opens while the author's own unpublished Project is untouched, GitHub's head has not moved, and the status beside it has been recomputed against what the Update left. The Workspace-switch leg rides along in the same workflow rather than as a second test, because it needs the same held raw-host response to reach the moment it is about.
 * | 2026-08-22 | 656 | One test for a confirmed Remote deletion. The engine is exhausted at Seam 1 — the three-way row that makes a deletion a deletion, the Conflict row that makes it not one, the preview's grouping into Projects and Map Images, the transaction interrupted at all sixteen of its durable boundaries, and both real backings agreeing about the committed files, the recovery choice, the Project and Map Image lists and the Baseline (`update-transaction.test.ts`, `update-transaction-suite.ts`). What no seam below can falsify is the *question*: that a destructive inbound change reaches a scholar as a modal naming their Project by the name they gave it, that cancelling it writes nothing and puts focus back on the control that opened it, and that confirming it removes the Project from a real OPFS Workspace and leaves the two sides agreeing. Cancel and confirm are one test rather than two, because cancel's whole claim is that the state it leaves is the one confirm then starts from. |
 * | 2026-08-22 | 657 | One test for an Import into a bound Workspace. The evidence a bound Workspace's Remote adds to an Import is exhausted at Seam 1 against the fake repository and a real store (`project-import-own-remote.test.ts`): the current inventory taken before allocation, the refusal when GitHub cannot be listed authoritatively, the own-Remote refusal and its two remedies, and a complete Workspace, Baseline and Remote snapshot unchanged after every refusal. What no seam below can falsify is that the three halves are wired together in the application: that the hub's Import asks GitHub what this Workspace's Remote holds *before* it allocates a directory, that the arriving files register in the IndexedDB change index the navigation bar's status control reads, and that the ordinary Publish — which is told nothing about Imports — carries the imported closure while the Project only GitHub had survives it. One test rather than three: the reservation is only observable in what the publish afterwards contains, so the allocation, the status and the publish are one workflow or they are assertions about a fake. |
 */
export const SEAM_2_CEILING = 657;

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
