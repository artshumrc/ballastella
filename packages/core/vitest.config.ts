import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Two projects, because the storage layer has two kinds of test and only one of them can run
// in Node.
//
// `node` is SPEC's Seam 1 (the primary seam): an in-memory ProjectStore drives application
// logic and assertions are on the resulting files. Fast, deterministic, no browser.
//
// `browser` exists because there is no OPFS in Node. The shared adapter suite has to run
// against the real backend — a Node stub of OPFS would only prove the stub agrees with the
// memory adapter, which is the very thing the suite exists to check. Ticket 12's File System
// Access adapter joins this project for the same reason.
//
// It runs in **two engines**. SPEC story 4 is that OPFS is the universal backend, so the tool
// works fully where folder access is impossible — Firefox, Safari, iPad — and a claim about other
// browsers asserted only in Chromium is not asserted. Firefox is where the divergence would show:
// it is a different OPFS implementation, not a different rendering of the same one.
//
// It is deliberately only this project. The Playwright suite drives MapLibre over WebGL, which is
// a much larger cross-engine question and a CI decision of its own; the storage layer is where
// story 4 actually lives.
export default defineConfig({
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				test: {
					name: 'node',
					environment: 'node',
					// `vitest-setup/` as well as `src/`, so the network fence's positive control sits
					// beside the fence rather than in a directory of its own.
					include: ['src/**/*.test.ts', 'vitest-setup/**/*.test.ts'],
					exclude: ['src/**/*.browser.test.ts', 'vitest-setup/**/*.browser.test.ts'],
					expect: { requireAssertions: true },
					// No test may reach the network — see the file's own header. Named per project
					// rather than once at the top, because a `setupFiles` on the root config is not
					// inherited by `projects` and would have applied to nothing at all.
					setupFiles: ['./vitest-setup/refuse-network.ts']
				}
			},
			{
				// ⚠ **`optimizeDeps.include` is not tuning; it is what stops this project hanging.**
				// Vite re-optimizes dependencies when the lockfile changes, and in browser mode it
				// does so *during* the run and then reloads — which vitest itself warns "may cause
				// tests to fail, lead to flaky behaviour or duplicated test runs". Measured on the
				// run that added `modern-tar` (ticket 13): the suite produced its last line at
				// 10:06:49 and was still alive with no further output forty minutes later. The run
				// before it exited 1 for the same reason, and its output had been discarded, so it
				// went down as unexplained. A second run always passes, because by then the cache
				// is warm — which is exactly what makes this look like flake rather than a cause.
				//
				// So every dependency the browser tests pull in is listed here. **Adding a
				// dependency to a browser test means adding it here**, or the next person after a
				// `pnpm install` pays the same forty minutes and is told it was contention.
				optimizeDeps: {
					include: [
						'@allmaps/annotation',
						'@allmaps/transform',
						'@protomaps/basemaps',
						'modern-tar'
					]
				},
				test: {
					name: 'browser',
					include: ['src/**/*.browser.test.ts', 'vitest-setup/**/*.browser.test.ts'],
					expect: { requireAssertions: true },
					setupFiles: ['./vitest-setup/refuse-network.ts'],
					browser: {
						enabled: true,
						headless: true,
						provider: playwright(),
						instances: [{ browser: 'chromium' }, { browser: 'firefox' }]
					}
				}
			}
		]
	}
});
