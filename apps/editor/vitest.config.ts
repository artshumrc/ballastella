import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const local = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const alias = {
	$lib: local('./src/lib'),
	'$app/paths': local('./vitest-setup/app-paths.ts'),
	'$app/navigation': local('./vitest-setup/app-navigation.ts')
};

export default defineConfig({
	test: {
		projects: [
			{
				plugins: [svelte()],
				environments: { ssr: { consumer: 'client', resolve: { conditions: ['browser'] } } },
				resolve: { alias },
				test: {
					name: 'editor',
					environment: 'node',
					include: ['src/**/*.test.ts', 'vitest-setup/**/*.test.ts'],
					exclude: ['src/**/*.dom.test.ts', 'vitest-setup/**/*.dom.test.ts'],
					expect: { requireAssertions: true },
					setupFiles: ['./vitest-setup/refuse-network.ts']
				}
			},
			{
				plugins: [svelte()],
				resolve: { conditions: ['module', 'browser', 'development|production'], alias },
				test: {
					name: 'editor-dom',
					environment: 'happy-dom',
					include: ['src/**/*.dom.test.ts'],
					expect: { requireAssertions: true },
					setupFiles: [
						'./vitest-setup/refuse-network.ts',
						'@ballastella/ui/vitest-setup/dom-matchers',
						'@ballastella/ui/vitest-setup/web-animations'
					]
				}
			}
		]
	}
});
