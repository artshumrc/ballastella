import { playwright } from '@vitest/browser-playwright';
import { configDefaults, defineConfig } from 'vitest/config';

import { chromiumLaunchArgs } from '../../scripts/gpu-launch-args.mjs';

const chromiumArgs = chromiumLaunchArgs();

export default defineConfig({
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				test: {
					name: 'node',
					environment: 'node',
					include: ['src/**/*.test.ts', 'vitest-setup/**/*.test.ts'],
					exclude: ['src/**/*.browser.test.ts', 'vitest-setup/**/*.browser.test.ts'],
					expect: { requireAssertions: true },
					setupFiles: ['./vitest-setup/refuse-network.ts']
				}
			},
			{
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
					globalSetup: ['../../scripts/assert-gpu.mjs'],
					browser: {
						enabled: true,
						headless: true,
						provider: playwright(),
						instances: [
							{
								browser: 'chromium',
								...(chromiumArgs === null ? {} : { launchOptions: { args: [...chromiumArgs] } })
							},
							...(chromiumArgs === null
								? [
										{
											browser: 'firefox' as const,
											exclude: [
												...configDefaults.exclude,
												'src/render/map-snapshot.browser.test.ts'
											]
										}
									]
								: [])
						]
					}
				}
			}
		]
	}
});
