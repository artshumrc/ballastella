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
// writer and a `$state` array of Layers — and until it existed there was nothing in this app that
// could be tested without a browser.
//
// **Node, not browser.** There is no OPFS or WebGL below this seam and nothing here touches the
// DOM: `packages/core`'s browser project exists because OPFS has no Node implementation, and that
// argument does not reach any of this. A browser project here would be the same assertions,
// slower. Svelte's *client* runtime needs no DOM to make a `$derived` invalidate — only the signal
// graph — which is why the client runtime runs here under `environment: 'node'`.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ⚠ `environments.ssr` IS NOT TUNING. IT IS WHAT MAKES THE REACTIVITY ASSERTIONS MEAN ANYTHING.
//
// Both fields below are on the **`ssr` environment**, which is the environment vitest's node pool
// transforms and runs in, and neither of them can be written anywhere else and still work.
//
// **`consumer: 'client'` chooses which Svelte runtime `.svelte.ts` compiles to.** The plugin reads
// the Vite *environment*, never resolution: `@sveltejs/vite-plugin-svelte`'s
// `plugins/compile-module.js` is `const ssr = this.environment.config.consumer === 'server'` and
// then `generate: ssr ? 'server' : 'client'`. `ssr`'s consumer defaults to `'server'`, so without
// this line these files emit `import * as $ from 'svelte/internal/server'`.
//
// A top-level `resolve.conditions: ['browser']` stood here first, claiming to do that job. It did
// nothing at all, twice over. Conditions steer resolution, and by then the compiler has already
// written the specifier — and worse, a *top-level* `resolve.conditions` never reached this
// environment: Vite's `getDefaultEnvironmentOptions` passes the shared `resolve` down with
// `conditions: undefined`, so it landed on the `client` environment, which nothing in this project
// ever runs in. Measured on a real `startVitest` run with a probe in `configResolved` and a
// post-`enforce` transform probe: with that line present, `ssr`'s conditions were `["node", …]`
// and the emitted code was `svelte/internal/server`.
//
// **`resolve.conditions: ['browser']`, scoped to this environment, is the other half.** Choosing
// the client runtime for compiled runes does not change how Svelte's own public modules resolve,
// and `svelte`'s export map is `worker` / `browser` / `default` — so an `import { untrack } from
// 'svelte'` in a test would otherwise silently get the *server* build's no-op while the code under
// test ran on client signals. Measured: with `consumer` alone, mutating `#annotationLayers` into an
// `untrack`ed derived — a derived that caches and tracks nothing, the exact bug these tests are
// for — stayed green, because the `untrack` was the no-op. With this line it goes red.
//
// What server mode does is not "an inert pass-through read once at construction", which is what an
// earlier version of this comment claimed. It is worse than that, because it *looks* like
// reactivity. Outside a render (`ssr_context === null` — every unit test)
// `svelte/internal/server`'s `derived` is `ssr_context === null ? fn : once(fn)`: an **uncached
// thunk re-invoked on every read**. So a derived over a plain, signal-free array recomputes
// eagerly and every assertion about it passes. A real client `derived` caches and invalidates on
// *signal* writes, which is the behaviour the application actually has. The two disagree in the
// one direction that matters: compiled for the server, `annotation-editing.svelte.test.ts`'s
// "follows the open Layer being deleted" passed against a plain `Layer[]` — a thing with no
// signals in it, which could never have driven the real screen. That fixture is `$state` now, and
// the test is red without it.
//
// Vitest re-asserts the two environment fields its runner needs (`dev.moduleRunnerTransform`,
// `keepProcessEnv`) after this config is merged and never touches `ssr`'s `consumer`, so this
// survives; vitest sets exactly this field itself for its own `vmThreads` environment.
export default defineConfig({
	plugins: [svelte()],
	environments: { ssr: { consumer: 'client', resolve: { conditions: ['browser'] } } },
	test: {
		name: 'editor',
		environment: 'node',
		include: ['src/**/*.test.ts', 'vitest-setup/**/*.test.ts'],
		expect: { requireAssertions: true },
		// No test may reach the network (the standing rule; see the setup file's own header).
		setupFiles: ['./vitest-setup/refuse-network.ts']
	}
});
