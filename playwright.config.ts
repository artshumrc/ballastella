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

/** @param app the workspace package name suffix, e.g. `editor` */
const serveStatic = (app: string, port: number) => ({
	command:
		`pnpm --filter @ballastella/${app} run build && ` +
		`pnpm --filter @ballastella/${app} exec vite preview --port ${port} --strictPort`,
	port,
	reuseExistingServer: !process.env.CI,
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
	// not a race in any one test. It matters because `retries` below makes CI green anyway, so a
	// flaky suite is one that can absorb a genuine race without anyone noticing. Four costs about
	// ten seconds of wall clock; raise it only with the flake rate measured over several full runs.
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
