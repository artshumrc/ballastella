import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// The editor's unit seam (ticket 06).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS NOW AND DID NOT BEFORE
//
// `apps/editor/` had no `*.test.ts` and no vitest project at all, so the only seam under
// `EditorSession` and the Project screen was the 7-minute Playwright suite. That is why a
// silent-return guard survived a whole epic: a browser test that drives the interface cannot
// easily reach a branch the interface has no gesture for, and nobody writes twenty of them.
//
// **What made it worth having is the carve.** Ticket 06 moved the Project screen's 369-line
// annotation state layer into `annotation-editing.svelte.ts`, a class whose whole dependency on
// the application is four methods (`AnnotationWriter`). That is a unit — it can be handed a fake
// writer and a plain array of Layers — and until it existed there was nothing in this app that
// could be tested without a browser.
//
// **Node, not browser.** There is no OPFS or WebGL below this seam and nothing here touches the
// DOM: `packages/core`'s browser project exists because OPFS has no Node implementation, and that
// argument does not reach any of this. A browser project here would be the same assertions,
// slower.
//
// ⚠ **`resolve.conditions` is not tuning.** `.svelte.ts` runes are compiled by
// `@sveltejs/vite-plugin-svelte`, and with Node's default resolution it compiles them for the
// *server*, where `$state` and `$derived` are inert pass-throughs — every reactivity assertion
// would pass vacuously by reading the value once at construction. The `browser` condition is what
// selects the client runtime, and it is the whole reason a derived recomputes in these tests.
export default defineConfig({
	plugins: [svelte()],
	resolve: { conditions: ['browser'] },
	test: {
		name: 'editor',
		environment: 'node',
		include: ['src/**/*.test.ts', 'vitest-setup/**/*.test.ts'],
		expect: { requireAssertions: true },
		// No test may reach the network (the standing rule; see the setup file's own header).
		setupFiles: ['./vitest-setup/refuse-network.ts']
	}
});
