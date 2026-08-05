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
						instances: [{ browser: 'chromium' }]
					}
				}
			}
		]
	}
});
