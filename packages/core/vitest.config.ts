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
					include: ['src/**/*.test.ts'],
					exclude: ['src/**/*.browser.test.ts'],
					expect: { requireAssertions: true }
				}
			},
			{
				test: {
					name: 'browser',
					include: ['src/**/*.browser.test.ts'],
					expect: { requireAssertions: true },
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
