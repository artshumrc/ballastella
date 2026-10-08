import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import { availableParallelism } from 'node:os';
import process from 'node:process';

import { editorPort, viewerPort } from './scripts/e2e-port.mjs';
import { chromiumLaunchArgs } from './scripts/gpu-launch-args.mjs';

/**
 * Free the port, then serve a current build. A reused preview serves pre-change HTML, and parallel builds share one viewer directory.
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

const gpuArgs = chromiumLaunchArgs();
const gpuLaunchOptions = gpuArgs === null ? {} : { launchOptions: { args: [...gpuArgs] } };
const defaultWorkers = gpuArgs === null ? Math.max(1, Math.min(4, availableParallelism())) : 8;

const reporter: ReporterDescription[] = process.env.CI
	? [['github'], ['html', { open: 'never' }], ['./scripts/retry-budget.mjs']]
	: [['list'], ['./scripts/retry-budget.mjs']];
if (process.env.BALLASTELLA_E2E_PROFILE) reporter.push(['./scripts/cost-profile.mjs']);

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.e2e.ts',
	forbidOnly: !!process.env.CI,
	fullyParallel: true,
	workers: Number(process.env.BALLASTELLA_E2E_WORKERS) || defaultWorkers,
	expect: { timeout: 10_000 },
	timeout: 60_000,
	retries: 1,
	reporter,
	globalSetup: './scripts/assert-gpu.mjs',
	use: {
		...devices['Desktop Chrome'],
		...gpuLaunchOptions,
		trace: 'on-first-retry',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
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
