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
 * The build is *inside* this command, and that is what makes reuse dangerous.
 *
 * `reuseExistingServer` decides whether to run the command by asking only whether something answers
 * on the port. If something does, the command is skipped **whole** — the build with it — and the
 * suite runs against whatever that process is serving. An implementer here read eighteen
 * simultaneous failures as a code defect before finding the cause was a reused `vite preview`
 * serving pre-change HTML; a later sweep found seven stray preview processes still listening. The
 * port hashing above closed the cross-checkout half of this. It cannot close the same-tree half,
 * because the port is stable per checkout on purpose.
 *
 * So the command frees its own port first, and reuse is opt-in rather than the default. The cost is
 * a rebuild per run. `BALLASTELLA_E2E_REUSE=1` takes the old behaviour back for fast iteration
 * against a build you know is current.
 *
 * @param app the workspace package name suffix, e.g. `editor`
 */
const serveStatic = (app: string, port: number) => ({
	command:
		`node scripts/free-e2e-port.mjs ${port} && ` +
		`pnpm --filter @ballastella/${app} run build && ` +
		`pnpm --filter @ballastella/${app} exec vite preview --port ${port} --strictPort`,
	port,
	reuseExistingServer: !process.env.CI && process.env.BALLASTELLA_E2E_REUSE === '1',
	timeout: 120_000
});

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.e2e.ts',
	forbidOnly: !!process.env.CI,
	// Capped rather than left to default to one worker per core.
	//
	// Every worker drives a real WebGL context and the same origin's OPFS, and at the default (7
	// here) the suite flaked in roughly one full run in three — a *different* test each time, never
	// reproducible in isolation even at `--repeat-each=10 --workers=6`. That profile is contention,
	// not a race in any one test.
	//
	// ⚠ **The cap did not fix it, and this comment used to imply it had.** Measured across four
	// implementers and roughly a dozen full runs at `workers: 4`: still about one run in three, one
	// to four failures each time, a *different* set every time, every one green when its own file is
	// re-run. One run failed `pwa`+`transfer`, the next `remote-iiif`+`transfer`. So four workers is
	// the current setting, not a remedy, and lowering the number further has not been tried against
	// a measured rate.
	//
	// This matters more than the wasted wall clock. `retries` below makes CI green regardless, so a
	// suite in this state can absorb a genuine race without anyone noticing — and it taxes every
	// implementer, who must re-run and often bisect against the merge-base to show a failure is not
	// theirs. `pnpm flake:check` exists so that costs one command. Ticket 17 owns the real fix and
	// should start from the numbers above rather than re-deriving them.
	//
	// **Eight workers measured 19% faster (360s against 444s) and four is still the right number.**
	// Recorded so the measurement does not read as an argument for raising it. This repository is
	// worked by several agents at once on one machine, so a run does not have the box to itself; a
	// per-run figure taken in isolation is not the figure that matters, and eight workers each would
	// oversubscribe the cores and make every concurrent run slower and flakier. Four is a deliberate
	// share of a shared machine. Raise it only for a checkout that genuinely runs alone.
	//
	// Note also what the 19% says about the ceiling: doubling the workers bought a fifth, so the
	// suite is already close to what this CPU can do. Real speed is not in this number — it is in
	// not asking Playwright for work that belongs one seam down. A Vitest browser test costs ~12ms
	// against ~4.6s here, because it exercises a module rather than booting the built app and
	// software-rasterising MapLibre. Moving forty tests down beats any worker count.
	workers: 4,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
	use: { ...devices['Desktop Chrome'] },
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
