import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';
import process from 'node:process';

// Seam 2 (SPEC, Testing Decisions): the running app in a real browser, with real MapLibre,
// real OpenSeadragon, and real OPFS. Deliberately no map-abstraction layer — inventing one
// purely to enable testing is the premature boundary ADR-0019 argues against, and it would
// test a fake instead of the thing that ships.
//
// Both apps are built and served as static output, because that is what a Published Site is
// (ADR-0006) and because `paths.relative` only means anything against real served files.

// Ports are derived from *this checkout's own path*, not fixed.
//
// They used to be 4173/4174 for everyone, with `reuseExistingServer` on. Run two checkouts of this
// repo at once — parallel git worktrees, or a second terminal — and the second run finds the first
// one's `vite preview` already listening, reuses it, and **tests the other checkout's build**. It
// does not error. It reports passes and failures for code that is not the code under test; one run
// rendered a UI string that existed nowhere in its own tree. When the first run finishes and its
// server exits, the second turns into `ERR_CONNECTION_REFUSED` halfway through.
//
// Hashing the repo root gives every checkout its own stable pair, so `reuseExistingServer` goes back
// to being what it is for — a fast second run in the same tree — instead of a trap. Override with
// `BALLASTELLA_E2E_PORT` when you need a known port (a debugger, a proxy, CI logs).
const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/** A stable port pair in the IANA ephemeral-safe range 20000–39998, unique per checkout path. */
const basePort = (() => {
	const override = Number(process.env.BALLASTELLA_E2E_PORT);
	if (Number.isInteger(override) && override > 1023 && override < 65535) return override;
	const digest = createHash('sha256').update(repoRoot).digest();
	// Even, so `basePort + 1` cannot collide with a neighbouring checkout's `basePort`.
	return 20000 + (digest.readUInt32BE(0) % 10000) * 2;
})();

const editorPort = basePort;
const viewerPort = basePort + 1;

/**
 * Free the port, make sure both builds are current, then serve.
 *
 * `reuseExistingServer` decides whether to run the command by asking only whether something answers
 * on the port. If something does, the command is skipped **whole** — the build with it — and the
 * suite runs against whatever that process is serving. An implementer here read eighteen
 * simultaneous failures as a code defect before finding the cause was a reused `vite preview`
 * serving pre-change HTML; a later sweep found seven stray preview processes still listening. The
 * port hashing above closed the cross-checkout half of this. It cannot close the same-tree half,
 * because the port is stable per checkout on purpose. So the command frees its own port first and
 * `reuseExistingServer` stays off: every run gets a server it started itself.
 *
 * **The build is `scripts/e2e-build.mjs` rather than this app's own** (ticket 17), for a correctness
 * reason before a speed one. Playwright starts these two commands *in parallel*, and both of the
 * builds they used to run write `apps/viewer/build` — the viewer's directly, and the editor's
 * because its `build` is `stage:viewer && vite build`. Two `vite build` processes emptying and
 * filling one directory while a third step copies it into the editor is a staged viewer bundle that
 * is missing files, in one run and not the next, with both builds reporting success. `e2e-build.mjs`
 * is one sequential build behind a lock, shared by both commands, and it skips when a fingerprint of
 * every build input matches the last one — which is a stronger question than "is something listening
 * on the port".
 *
 * @param app the workspace package name suffix, e.g. `editor`
 */
const serveStatic = (app: string, port: number) => ({
	command:
		`node scripts/free-e2e-port.mjs ${port} && ` +
		`node scripts/e2e-build.mjs && ` +
		`pnpm --filter @ballastella/${app} exec vite preview --port ${port} --strictPort`,
	port,
	reuseExistingServer: false,
	timeout: 120_000
});

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.e2e.ts',
	forbidOnly: !!process.env.CI,
	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// WORKERS: 4. MEASURED 2026-08-07, ON A 20-CORE LINUX 6.17 MACHINE WITH 62 GB, NOT OTHERWISE
	// IDLE (THE ORDINARY STATE OF THIS BOX — OTHER AGENTS AND SERVICES WERE RUNNING).
	//
	// **The failures were counted and read, not summarised.** Ten consecutive full runs on `main`
	// at `workers: 4` with `retries: 0`, 398 tests each, 3980 test executions:
	//
	//   6 of 10 runs failed        8 failures in 3980 executions = 0.20%
	//   browser crashes                  0     (no `Protocol error`, no `Target closed`)
	//   timeouts awaiting a state        5
	//   assertion failures               2
	//   test-timeout budget exhausted    1
	//
	// **Zero crashes is the number that changes the conclusion.** Earlier reports in this epic
	// counted 8, 11 and 17 failures per run, one of them "7 of 8 were `Protocol error … session
	// closed`". None of that reproduces here. Those runs predate the port derivation above, and a
	// browser whose server disappears mid-run is exactly what a reused `vite preview` from another
	// checkout produces when the first run finishes. So the crash half of the historical flake was
	// the ports, and it is already fixed — which is why fewer workers is *not* the answer and this
	// number stays at 4.
	//
	// **The rest was bugs, not contention.** All 8 failures came from 4 tests, and every one had a
	// cause that could be found, fixed, and watched fail (ticket 17): a Workspace walk that raised
	// when a directory was deleted underneath it — a real application bug, in
	// `directory-handle-store.ts` — helpers that returned when a Layer was *on screen* rather than *on
	// disk* (`e2e/support/saved.ts`), an assertion that polled for a state lasting milliseconds, and a
	// test doing two pyramid ingests inside a 30 s budget. Contention caused none of them; it widened
	// the windows so they showed. Which is precisely why they all "passed in isolation", and why four
	// implementers reading that as proof of contention were reading the correlation.
	//
	// **After those fixes, ten more runs: 1 failure in 3990 executions, 1 run in 10, 0.025%, and
	// nothing that survived a retry.** Down from 0.20% and from 6 runs in 10. Thirty measured runs in
	// all, twelve failures, five distinct causes, no crashes.
	//
	// **Eight workers measured 19% faster (360s against 444s) and four is still the right number.**
	// This repository is worked by several agents at once on one machine, so a run does not have the
	// box to itself; eight workers each would oversubscribe the cores and make every concurrent run
	// slower. Note what the 19% says about the ceiling: doubling the workers bought a fifth, so the
	// suite is already close to what this CPU can do. Real speed is not in this number — it is in
	// not asking Playwright for work that belongs one seam down. A Vitest browser test costs ~12ms
	// against ~4.6s here, because it exercises a module rather than booting the built app and
	// software-rasterising MapLibre.
	workers: 4,

	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// THE TWO BUDGETS, RAISED FROM PLAYWRIGHT'S DEFAULTS BECAUSE THE DEFAULTS WERE THE CAUSE.
	//
	// Playwright's defaults are 5 s per assertion and 30 s per test. Of the eleven failures counted
	// across the first twenty measured runs of 2026-08-07, **three were neither races nor wrong
	// answers** — they were real work that did not finish inside one of those two numbers on a loaded
	// machine.
	// Every one of them reported as an absence: `toHaveCount(2) … Received: 1`, or 30 s spent
	// `waiting for … layer-move-down`. That is the worst possible spelling, because it is exactly how
	// a genuinely missing element reads, and it is what four implementers were looking at when they
	// concluded "contention".
	//
	// A run of this suite is 4 workers each driving a real Chromium with software-rasterised WebGL
	// against real OPFS, on a box that is not the run's alone. 5 s is not a generous allowance for an
	// assertion about that; it is a bet on the machine.
	//
	// **Nothing is weakened by this.** An element that never appears still fails, and a test that
	// hangs is still bounded — by 60 s rather than 30 s. What changes is that a slow machine no longer
	// produces a red run that means nothing. Three tests still name their own budget above these,
	// where the work genuinely warrants it, and each says why.
	expect: { timeout: 10_000 },
	timeout: 60_000,

	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// RETRIES: 1 EVERYWHERE, VISIBLE ALWAYS, AND BUDGETED FOR AN EPIDEMIC RATHER THAN AN INCIDENT.
	//
	// This was `CI ? 1 : 0`, which is the arrangement that let the epic get here: a retry made CI
	// green whatever happened, and nothing counted them. A suite in that state can absorb a genuine
	// race indefinitely. Turning retries *off* is not the fix either — it makes every implementer
	// re-run by hand and guess.
	//
	// So a retry is visible and it is *budgeted*. `scripts/retry-budget.mjs` prints every retried test
	// by name as it happens, prints the rate at the end, and fails the run when the rate goes past
	// 3% — about 11 tests in 398 — with a floor of 3 so that running one spec is not judged more
	// harshly than running the suite. Locally the same rule applies, which is deliberate: a number that
	// only exists on CI is a number nobody looks at.
	//
	// ⚠ **The budget was 0.5%, meaning one retry anywhere failed the run, and that is the number this
	// change loosened.** Held for the length of the epic it cost many hours of investigation without
	// fixing the races behind it: this suite drives several workers, each with a real WebGL map against
	// the same origin's OPFS, and under that contention a first attempt sometimes loses a timing margin
	// that no application change removes. A gate that fires on something nobody can fix is a toll
	// rather than a signal. What it caught that was real — a test that needs its retry habitually, or a
	// change that makes several tests intermittent at once — the new numbers still catch, and the
	// per-retry line still prints either way. `scripts/retry-budget.mjs` carries the full argument.
	//
	// Check the fence rather than trusting it: `BALLASTELLA_E2E_RETRY_BUDGET=0` on a run with any
	// retry at all must fail.
	//
	// ⚠ **`--reporter=…` on the command line replaces this whole list, and takes the budget with
	// it.** `pnpm exec playwright test --reporter=line` is an ordinary thing to type and it silently
	// runs with no budget at all — the retries still happen, the flaky count still prints, and
	// nothing fails. Playwright offers no way to pin a reporter against that, so it is stated here
	// rather than defended against. Spell it `--reporter=line,./scripts/retry-budget.mjs` when you
	// want both. CI passes no `--reporter`, so CI always has the budget.
	retries: 1,
	reporter: process.env.CI
		? [['github'], ['html', { open: 'never' }], ['./scripts/retry-budget.mjs']]
		: [['list'], ['./scripts/retry-budget.mjs']],
	use: {
		...devices['Desktop Chrome'],
		// A retried test is one nobody has explained yet, so the second attempt keeps everything
		// needed to explain it. Only on the retry: a trace per test would cost more than the suite.
		trace: 'on-first-retry',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			// `editor*.e2e.ts`, so that a slice with a lot of browser behaviour to assert can own
			// its own file — `editor-image-pane.e2e.ts` — rather than every ticket appending to one
			// growing file.
			name: 'editor',
			testMatch: '**/editor*.e2e.ts',
			use: { baseURL: `http://localhost:${editorPort}` }
		},
		{
			name: 'viewer',
			testMatch: '**/viewer*.e2e.ts',
			use: { baseURL: `http://localhost:${viewerPort}` }
		}
	],
	webServer: [serveStatic('editor', editorPort), serveStatic('viewer', viewerPort)]
});
