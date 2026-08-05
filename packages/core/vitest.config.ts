import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Seam 1 (SPEC, Testing Decisions): an in-memory ProjectStore drives application
		// logic and assertions are on the resulting files. No browser required.
		environment: 'node',
		include: ['src/**/*.{test,spec}.ts'],
		expect: { requireAssertions: true }
	}
});
