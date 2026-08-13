import { playwright } from '@vitest/browser-playwright';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// The editor's two seams below Playwright: `editor` for code with no DOM, `editor-browser` for
// components rendered in a real browser.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THERE IS A SECOND PROJECT, AND WHAT IT IS EXPLICITLY NOT FOR
//
// The `node` project's own note below argues — correctly — that `annotation-editing.svelte.ts`
// needs no browser, and that a browser project for *it* would be the same assertions, slower. That
// argument covers classes. It does not reach a `.svelte` file, and for a long time nothing did:
// this app had no DOM at all, so every assertion about a rendered row, a dialog, a focus order or
// an `aria-live` announcement had exactly one home, the Playwright suite, at roughly four seconds
// each against a built app and a software-rasterised map.
//
// That is why this repository accumulated 675 end-to-end tests. Not because 675 claims need a real
// MapLibre and a real OPFS — most do not — but because the alternative to Playwright was nothing.
// `editor-layers.e2e.ts` spent 42 full application boots to assert 42 facts about one list.
//
// ⚠ **The new project is not a cheaper Playwright and must not be used as one.** It renders one
// component against props and fakes. It cannot see MapLibre, OPFS, a service worker, or a static
// site served at two base paths, and a claim about any of those asserted here is asserted against a
// mock — which is the vacuous green this repository's testing decisions exist to prevent. The
// division is: **what the interface itself does** belongs here; **what the application does when
// its real dependencies are underneath it** stays in `e2e/`.
//
// Concretely, these belong here — a row's text for an unaligned Layer, which control holds focus
// after a delete, what a live region says, whether a dialog is a real `<dialog>`. These do not —
// that a reordered Layer draws above another on the map, that a rename leaves `alignments/*.json`
// byte-identical on disk, that a Published Site's relative paths resolve in a subdirectory.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
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
	test: {
		projects: [
			{
				plugins: [svelte()],
				environments: { ssr: { consumer: 'client', resolve: { conditions: ['browser'] } } },
				test: {
					name: 'editor',
					environment: 'node',
					include: ['src/**/*.test.ts', 'vitest-setup/**/*.test.ts'],
					// `.browser.test.ts` is the other project's, and without this exclusion the node
					// project would try to render a component into a DOM it does not have — failing with
					// `document is not defined`, which reads as a broken test rather than a misrouted one.
					exclude: ['src/**/*.browser.test.ts', 'vitest-setup/**/*.browser.test.ts'],
					expect: { requireAssertions: true },
					// No test may reach the network (the standing rule; see the setup file's own header).
					setupFiles: ['./vitest-setup/refuse-network.ts']
				}
			},
			{
				plugins: [svelte()],
				// ⚠ **Not tuning — see the identical block in `packages/core/vitest.config.ts`.** Vite
				// re-optimizes dependencies during a browser-mode run and then reloads, which vitest
				// itself warns can hang the run; that cost a measured forty minutes there and went down
				// as unexplained flake. Every dependency a component test pulls in belongs here, and
				// **adding one to a component test means adding it here**.
				optimizeDeps: { include: ['@lucide/svelte', 'dompurify', 'marked'] },
				test: {
					name: 'editor-browser',
					include: ['src/**/*.browser.test.ts'],
					expect: { requireAssertions: true },
					setupFiles: ['./vitest-setup/refuse-network.ts'],
					browser: {
						enabled: true,
						headless: true,
						provider: playwright(),
						// Chromium alone, unlike `core`'s browser project. That one runs two engines
						// because SPEC story 4 is a claim about OPFS across browsers and Firefox is a
						// different implementation of it. Nothing here touches storage: these tests render
						// components, and Svelte's own output is not a per-engine question worth doubling
						// every local run for.
						instances: [{ browser: 'chromium' }]
					}
				}
			}
		]
	}
});
