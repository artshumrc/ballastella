import { defineConfig, devices } from '@playwright/test';
import process from 'node:process';

// Seam 2 (SPEC, Testing Decisions): the running app in a real browser, with real MapLibre,
// real OpenSeadragon, and real OPFS. Deliberately no map-abstraction layer — inventing one
// purely to enable testing is the premature boundary ADR-0019 argues against, and it would
// test a fake instead of the thing that ships.
//
// Both apps are built and served as static output, because that is what a Published Site is
// (ADR-0006) and because `paths.relative` only means anything against real served files.

const editorPort = 4173;
const viewerPort = 4174;

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
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
	use: { ...devices['Desktop Chrome'] },
	projects: [
		{
			// `editor*.e2e.ts`, so a slice's browser tests can live in their own file instead of
			// every ticket appending to one growing one.
			name: 'editor',
			testMatch: '**/editor*.e2e.ts',
			use: { baseURL: `http://localhost:${editorPort}` }
		},
		{
			name: 'viewer',
			testMatch: '**/viewer.e2e.ts',
			use: { baseURL: `http://localhost:${viewerPort}` }
		}
	],
	webServer: [serveStatic('editor', editorPort), serveStatic('viewer', viewerPort)]
});
