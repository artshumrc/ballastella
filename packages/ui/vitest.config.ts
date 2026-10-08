import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [svelte()],
	resolve: { conditions: ['module', 'browser', 'development|production'] },
	test: {
		name: 'ui',
		environment: 'happy-dom',
		include: ['src/**/*.test.ts'],
		expect: { requireAssertions: true },
		setupFiles: [
			'@ballastella/core/test-fence',
			'./vitest-setup/dom-matchers.ts',
			'./vitest-setup/web-animations.ts'
		]
	}
});
