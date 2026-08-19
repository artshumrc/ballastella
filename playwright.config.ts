import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import process from 'node:process';

import { editorPort, viewerPort } from './scripts/e2e-port.mjs';
import { GPU_LAUNCH_ARGS } from './scripts/gpu-launch-args.mjs';

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
//
// The derivation itself is `scripts/e2e-port.mjs`, because `scripts/e2e.mjs` frees these same ports
// before handing off and a second copy of the arithmetic would drift.

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

// Hand Chromium the real GPU, where there is one to hand it.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// HALF THE COST OF SEAM 2 IS THE SOFTWARE RASTERISER
//
// Headless Chromium rasterises WebGL in software (SwiftShader), and every test here drives a real
// MapLibre over it. Measured on `editor-layers.e2e.ts`, 35 tests, this box, warm:
//
//   software (SwiftShader)          143.7s – 213.0s of worker time     4.10 – 6.09s per test
//   ANGLE over Vulkan               103.4s / 103.7s / 103.9s           2.96s per test   ← the default
//   `--headed`, so the real GPU     112.2s                             3.21s per test
//   ANGLE over GL/EGL               270.3s                             7.72s per test
//
// **A third to a half of Seam 2's cost is the software rasteriser**, which is worth knowing before
// anyone deletes another test to save four seconds. Note the spread: the software path varies with
// load across a 70-second band on the same box and the Vulkan path does not, so the saving is
// somewhere between 28% and 51% rather than a single figure — three back-to-back Vulkan runs landed
// within half a second of each other. The first Vulkan run against a cold shader cache cost 145.4s;
// 103s is the steady state.
//
// ⚠ **Whether these flags degrade gracefully on a GPU-less machine is NOT known, and the obvious
// experiment does not answer it.** Pointing `VK_DRIVER_FILES` at a file that is not there fails three
// `editor-project-screen` tests — theme flavour, the navigation bar, a part-drawn shape — but it does
// so **with these flags off as well**, measured, so it breaks Chromium's whole GPU stack rather than
// the ANGLE path specifically. A poisoned Vulkan environment is not a model of a machine that simply
// has no GPU, and reading it as one is how this comment came to claim the opposite for an afternoon.
//
// So the detection below is prudence rather than a proven necessity: the flags are asked for only
// where a render node *and* an installed ICD are both present. Force it either way when the
// detection is wrong: `BALLASTELLA_E2E_GPU=1` to insist, `=0` to refuse.
//
//     BALLASTELLA_E2E_GPU=0 pnpm test:e2e     # the software rasteriser, wherever you are
//
// ⚠ **A workstation never reaches the software path by accident.** It used to: a wrong answer from
// the detection dropped the run onto SwiftShader, where each worker holds a core, and nothing said
// so — the only symptom was a hot machine and a suite that felt slow. Both halves are now refused
// out loud, the detection's answer below and the browser's own answer in `scripts/assert-gpu.mjs`,
// and CI — which has no render node and no other path — is the one case exempt from both.
//
// ⚠ **Two tests had to be fixed before this could be the default, and what they were pinning is worth
// knowing.** `viewer-reader.e2e.ts`'s two outage tests failed under the GPU, deterministically and in
// about a second. Neither was about tile failure: both read `queryRenderedFeatures` once, immediately
// after a `redrawMapLayer()` that re-adds the Annotation symbol layer — and that call answers about
// symbol *placement*, not about the style. Measured, the layer was in the style at t=0 with 0
// features placed, and 1 from t=1s on; the failure screenshot showed the pin already drawn. Under
// SwiftShader everything upstream was slow enough that the placement frame had always run by then. So
// the tests passed for a reason unrelated to what they asserted, and the GPU exposed it rather than
// broke it. They poll now, which is what the same claim elsewhere in that file already did.
//
// The lesson generalises: **a test that only passes under one rasteriser is pinning the rasteriser.**
//
// `--headed` is the other way to reach the real GPU and needs no flags, but it opens a window per
// worker and cannot run unattended.
/**
 * Whether this machine can actually serve ANGLE's Vulkan backend.
 *
 * Both halves are needed and the second is the one that bites. A render node is the device; an
 * **installed ICD** is the driver that talks to it, and Chromium asked for Vulkan without one is the
 * case that fails three tests rather than falling back. `lvp_icd.json` (lavapipe) counts — it is
 * software Vulkan, so it is merely slow rather than broken, which is the right side of the line.
 */
const canUseVulkan = (): boolean => {
	if (process.platform !== 'linux') return false;
	const populated = (directory: string): boolean => {
		try {
			return readdirSync(directory).length > 0;
		} catch {
			return false;
		}
	};
	let renderNode: boolean;
	try {
		renderNode = readdirSync('/dev/dri').some((node) => node.startsWith('renderD'));
	} catch {
		renderNode = false;
	}
	// A named driver file wins, but only if it is really there: pointing `VK_DRIVER_FILES` at nothing
	// is how the failing case was reproduced, and it has to read as "no Vulkan" rather than as "yes".
	const named = process.env.VK_DRIVER_FILES ?? process.env.VK_ICD_FILENAMES;
	const driver = named
		? named.split(':').some((file) => existsSync(file))
		: populated('/usr/share/vulkan/icd.d') || populated('/etc/vulkan/icd.d');
	return renderNode && driver;
};

const wantsGpu = process.env.BALLASTELLA_E2E_GPU;
const useGpu = wantsGpu === '0' ? false : wantsGpu === '1' || canUseVulkan();

/**
 * A workstation may not fall through to the software rasteriser without saying so.
 *
 * {@link canUseVulkan} is a heuristic over two directories, and its wrong answer is silent and
 * expensive: every worker takes the software path, each one holds a core rasterising WebGL, and the
 * run pins the machine instead of failing. That is indistinguishable from "the suite is slow today"
 * from the outside, so it is refused here rather than discovered from a fan curve.
 *
 * CI is the case this does *not* fire for: `ubuntu-latest` has no render node, the software path is
 * the only one it has, and the worker count below is already conditional on that.
 */
if (!useGpu && !process.env.CI && wantsGpu !== '0') {
	throw new Error(
		'No Vulkan GPU was detected, and this is not CI, so the run would rasterise WebGL on the CPU ' +
			'and hold one core per worker.\n\n' +
			'  BALLASTELLA_E2E_GPU=1 pnpm test:e2e   insist, when the detection is wrong\n' +
			'  BALLASTELLA_E2E_GPU=0 pnpm test:e2e   accept the software rasteriser deliberately\n\n' +
			'The detection wants a render node in /dev/dri and an installed Vulkan ICD ' +
			'(/usr/share/vulkan/icd.d or /etc/vulkan/icd.d, or a file named by VK_DRIVER_FILES).'
	);
}

const gpuLaunchOptions = useGpu
	? {
			launchOptions: { args: [...GPU_LAUNCH_ARGS] }
		}
	: {};

/**
 * Workers to run by default, which is a question about the rasteriser before it is one about cores.
 *
 * The long note beside `workers` below has the measurements. In short: with the GPU a worker no
 * longer holds a core, so 8 is where the GPU itself becomes the bottleneck; on the software path a
 * worker still costs a core, so the count has to stay under the machine's — and on a four-vCPU CI
 * runner, eight of them is what turned the suite red.
 */
const defaultWorkers = useGpu ? 8 : Math.max(1, Math.min(4, availableParallelism()));

const reporter: ReporterDescription[] = process.env.CI
	? [['github'], ['html', { open: 'never' }], ['./scripts/retry-budget.mjs']]
	: [['list'], ['./scripts/retry-budget.mjs']];
if (process.env.BALLASTELLA_E2E_PROFILE) reporter.push(['./scripts/cost-profile.mjs']);

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.e2e.ts',
	forbidOnly: !!process.env.CI,

	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// FULLY PARALLEL: THE SCHEDULING FIX, AND IT BUYS MORE THAN ANY OF THE OTHERS.
	//
	// Without this, Playwright parallelises across **files** and runs the tests inside one file
	// serially in a single worker. This suite's files are not the same size — `viewer-reader.e2e.ts`
	// holds 63 tests and `editor.e2e.ts` holds 1 — so the run could never finish faster than its
	// longest single file, however many workers were free. Measured on
	// `editor-alignment-refinement.e2e.ts`: 21 tests, 4 workers configured, and a wall time equal to
	// the *sum* of the test durations, because 20 of them were queued behind one worker while the
	// other three had nothing to do.
	//
	// **This does not increase concurrency and therefore does not touch the contention argument
	// below.** `workers: 4` is still the cap; what changes is that four workers are actually used
	// when the work is in one file. The failure analysis in the `workers` comment stands unaltered.
	//
	// ⚠ **It does mean tests in one file no longer share a page or an order.** Every spec here
	// already builds its own Workspace in a `beforeEach` or in `start()` and empties OPFS first, so
	// there was nothing to inherit; a spec that ever *did* want to hand state from one test to the
	// next must say so with `test.describe.serial`, which is the honest spelling of that dependency
	// and was silently free before.
	fullyParallel: true,
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
	// ─────────────────────────────────────────────────────────────────────────────────────────────
	// ⚠ **"EIGHT WORKERS MEASURED 19% FASTER, SO THE SUITE IS NEAR THIS CPU'S CEILING" WAS WRONG,
	// AND IT WAS WRONG BECAUSE OF `fullyParallel`.**
	//
	// That measurement was taken with file-level parallelism only. A worker's unit of work was then a
	// whole *file*, and this suite's files run from 1 test to 63 — so the run was bounded by its
	// longest file and adding workers past "one per long file" could not help. The 19% measured the
	// scheduling, not the processor, and the conclusion drawn from it does not follow.
	//
	// Re-measured 2026-08-13 with `fullyParallel: true` on a 156-test sample of the heaviest specs
	// (`viewer-reader`, `editor-annotations`, `editor-layers`): **4 workers 314s, 10 workers 206s.**
	// 1.5× for 2.5× the workers — still sublinear, but now for the real reason: every test drives a
	// software-rasterised WebGL context, so this is CPU-bound before it is core-bound.
	//
	// **It was 4 because a worker cost a core, and the GPU default changed that — but only where there
	// is a GPU.** The reason for 4 was never the benchmark: this repository is worked by
	// several agents at once on one machine, and under the software rasteriser each worker held a core
	// rasterising WebGL, so raising the count oversubscribed the box and slowed down whoever else was
	// working. That cost goes away with `useGpu` and stays exactly where it was without it, which is
	// why the default below is conditional rather than flat.
	//
	// ⚠ **A flat 8 was merged on 2026-08-14 and turned CI red the same afternoon.** `ubuntu-latest` is
	// four vCPUs with no render node, so it takes the software path, and eight workers over four cores
	// failed five tests and made another five flaky — every one a timeout rather than a wrong answer.
	// `viewer-reader`'s two outage tests were the sharpest: both waited out `mapReady`'s 30 s while the
	// pane's 15 s style budget expired under the contention. Reproduced on this box by emulating the
	// runner — `BALLASTELLA_E2E_GPU=0 BALLASTELLA_E2E_WORKERS=8 taskset -c 0-3`, that spec's 21 tests:
	//
	//   4 workers    25.5s    21 passed
	//   8 workers    44.2s    19 passed, 2 failed at `mapReady`
	//
	// Oversubscription cost wall clock *and* correctness, so the software default is also the fast one
	// there. Hence: cores, when a machine has fewer than the software path's four.
	//
	// Re-measured 2026-08-14 on this 20-core box with the GPU default, `editor-layers` +
	// `editor-annotations`, 72 tests, wall against **average cores busy** — which is what a machine
	// feels, and what the old default was really protecting:
	//
	//   4 workers    65.0s    1.03 cores
	//   8 workers    39.6s    1.90 cores   ← here
	//   12 workers   34.1s    2.54 cores
	//
	// Full suite at 8: **3m 40s and 2.91 cores of 20**, against 6m 32s and 1.56 cores at 4 — nearly
	// twice as fast for a third of a core more than the *old* four-worker software default cost. Past
	// 8 the GPU is the shared bottleneck rather than the cores: 12 workers buys 14% for 34% more CPU,
	// which is why the default stops here. `BALLASTELLA_E2E_WORKERS` overrides it in both directions —
	// lower it when the box is shared with something that matters more than this run.
	//
	// Real speed is still not in this number — it is in not asking Playwright for work that belongs
	// one seam down. A Vitest component test costs ~7ms against ~4.6s here — its fourteen tests run
	// in ~0.10s total, in Node with no browser at all — because it exercises a module rather than
	// booting the built app and software-rasterising MapLibre. `apps/editor` has an `editor-dom`
	// project for exactly that since 2026-08-13.
	workers: Number(process.env.BALLASTELLA_E2E_WORKERS) || defaultWorkers,

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
	//
	// The cost profiler is *appended* to that list for the same reason, rather than being something a
	// caller selects with `--reporter`: `pnpm test:e2e --profile` sets the environment variable below,
	// and a profiled run therefore gives exactly the verdict the gate gives.
	retries: 1,
	reporter,
	// Proves the flags above actually landed on a GPU before a single worker starts; see the script.
	globalSetup: './scripts/assert-gpu.mjs',
	use: {
		...devices['Desktop Chrome'],
		...gpuLaunchOptions,
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
