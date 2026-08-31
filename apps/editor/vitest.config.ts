import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The editor's two seams below Playwright: `editor` for code with no DOM, `editor-dom` for
// components rendered into a DOM implementation. Both run in Node; nothing here starts a browser.
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
// ─────────────────────────────────────────────────────────────────────────────────────────
// ⚠ IT RUNS IN NODE, NOT IN A BROWSER, AND THE THIRD OPTION IS NOT ON THE TABLE
//
// The first cut of this project was vitest's browser mode, on the Chromium provider `packages/core`
// already used, because that was the shortest path from the configuration that existed. It was the
// wrong shape: a component rendered against props touches no OPFS, no WebGL and no service worker,
// so a browser process per run bought nothing but a scaled-down copy of the cost `e2e/` charges.
// `packages/core`'s browser project has a subject only a real engine has — OPFS, and Firefox's is a
// different implementation of it. Nothing of that argument reaches here.
//
// So a DOM implementation is a **fake**, and this repository's standing rule is that a fake agreeing
// with itself is not a test. The boundary is therefore drawn by where the fake is known to diverge,
// and where it is insufficient the claim goes back to `e2e/` — **never to a browser-mode component
// tier**, which would be a fake with a browser attached: most of Seam 2's cost and less of its
// truth.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS DOM IMPLEMENTATION WAS ASKED, AND WHAT IT ANSWERED
//
// Probed directly on 2026-08-13, against both happy-dom 20.11 and jsdom 30.0, before any claim was
// ported. Each of these decides whether an existing assertion can be made here at all.
//
// 1. **`focus()` on a `disabled` button.** Both refuse it: `document.activeElement` does not move,
//    and a `click()` on a disabled button dispatches no listener. This is the one that mattered
//    most — "at the bottom of the stack Move down is disabled, so the keyboard is handed the other
//    half of the same control" is asserted below and turns entirely on it. Had it been allowed, that
//    claim would have gone back to `e2e/`. Re-probed inside this project, against the real component
//    rather than a fragment, by `layer-list.dom.test.ts`'s first test.
// 2. **Accessible-name computation**, as `toHaveAccessibleName` uses it. `aria-label` on an
//    `<input>`, the `sr-only` text content of a `<button>`, and `aria-label` on the `<ol>` all
//    compute correctly. It is `dom-accessibility-api`'s *approximation* of an accessibility tree,
//    not one — see the catalog entry. Good enough for a name; not good enough to be an accessibility
//    claim's only home.
// 3. **Focus after a keyed node moves** — the behaviour `moveByButton` exists for. The keyed
//    `{#each}` really moves the node, the focused element really is blurred to `document.body` by
//    the move, and the restoration really lands. This is asserted three ways below.
//
// 4. **DOMPurify, probed on 2026-08-14, and it is INERT here.** `DOMPurify.isSupported` answers
//    `true` against happy-dom 20.11, so `isDescriptionRendererSupported()` says yes and
//    `renderDescription` runs — and then returns its input essentially untouched. Measured, the
//    whole string surviving the allowlist:
//
//        renderDescription('… and <img src=x onerror=alert(1)>')
//          → '<p>… and <img src="x" onerror="alert(1)">'
//
//    `img` is not in `ALLOWED_TAGS` and `onerror` is in no allowlist at all, so a real browser
//    removes both; here neither goes. **This is the exact shape of the failure this project's header
//    exists to refuse** — a fake that answers "supported" and then agrees with whatever it is given —
//    and it is worse than an unsupported dependency, because it is silently green rather than loudly
//    absent. So the Annotation *description* surface does not come here at all: "the description
//    reads as rendered Markdown, not as source" would pass against a component that had dropped the
//    sanitiser, which is the one bug on that surface that matters. It stays in `e2e/`, and the
//    payload matrix stays in `packages/core/src/annotation/markdown.browser.test.ts`, over a real
//    engine. ⚠ Nothing under this project may assert anything about `renderDescription`'s output.
//
// 5. **`DragEvent`.** Probed 2026-08-14, and the answer was no on both members that matter.
//    happy-dom's `DragEvent` does not extend `MouseEvent`, and its constructor ignores both
//    `dataTransfer` and `relatedTarget` from the init dictionary — `new DragEvent('dragstart', {
//    dataTransfer })` arrives with `event.dataTransfer === undefined`. So `LayerList`'s
//    `dragTheWholeCard` takes its own early return and never calls `setDragImage`, and its
//    `ondragleave` guard — `relatedTarget` inside this card is not a departure, which is the whole
//    of the anti-flicker fix — sees `undefined` every time and treats every leave as real. **The
//    workaround is the trap:** dispatching a `MouseEvent` named `dragleave` makes both pass, and it
//    is a fake agreeing with a fake about the one member the fake gets wrong. Every drag claim
//    therefore stays in `e2e/editor-layers.e2e.ts`, which says so beside them.
//
// 6. **The Web Animations API.** Probed 2026-08-14 (the Annotation row disclosure): `Element`
//    has no `animate`, in happy-dom 20.11 and in jsdom 30 alike. Svelte's `transition:` calls it for
//    any transition with a duration or a delay, so such a component throws from inside Svelte's
//    runtime the moment its block opens or closes — in a microtask, so the run fails as an unhandled exception
//    somewhere other than the test that caused it. `vitest-setup/web-animations.ts` supplies the
//    smallest object that runtime reads, and its header states the rule that goes with it:
//    **nothing here may assert anything about an animation.** What a component *decides* about one
//    it can put in the DOM, and that is where the reduced-motion claim is asserted.
//
// Known-absent and therefore off limits here, rather than worked around:
//
// - **No layout.** No `offsetWidth`, no scroll geometry, no visibility derived from paint. Any
//   "does not widen the page" or "is readable inside the viewport" claim stays in `e2e/`.
// - **No real hit testing.** A `click()` here reaches a hidden or covered element that a user could
//   not reach, so "this control is actually clickable" is not a question this seam can answer.
// - **No paint.** The computed-colour comparisons in `e2e/` — the selected Annotation row wearing
//   the card's own tint — cannot move here.
//
// `happy-dom` over `jsdom` on speed, both having answered the three probes identically.
//
// **What the move cost and bought**, measured three runs each on the same machine, same 13 claims
// plus the probe: browser mode ran its tests in 1.04–1.08s inside a 2.88–3.04s wall clock; Node
// runs them in 0.09–0.11s inside a 2.34–2.40s wall clock. Ten times cheaper in the tests themselves
// and about 20% off the wall clock, which is the honest figure — a run this small is mostly Vite
// transforming, and the transform is now the floor rather than the browser. The saving that matters
// is per-test rather than per-run: this is the seam claims move *into*, and it no longer takes a
// browser process to add one.
//
// Concretely, these belong here — a row's text for an unaligned Layer, which control holds focus
// after a delete, what a live region says, whether a dialog is a real `<dialog>`. These do not —
// that a reordered Layer draws above another on the map, that a rename leaves `alignments/*.json`
// byte-identical on disk, that a Published Site's relative paths resolve in a subdirectory.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// The editor's unit seam.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS NOW AND DID NOT BEFORE
//
// `apps/editor/` had no `*.test.ts` and no vitest project at all, so the only seam under
// `EditorSession` and the Project screen was the 7-minute Playwright suite. That is why a
// silent-return guard could survive unnoticed: a browser test that drives the interface cannot
// easily reach a branch the interface has no gesture for, and nobody writes twenty of them.
//
// **What made it worth having is the carve.** The Project screen's 369-line annotation state layer
// lives in `annotation-editing.svelte.ts`, a class whose whole dependency on the application is
// four methods (`AnnotationWriter`). That is a unit — it can be handed a fake writer and a `$state`
// array of Layers — and until it existed there was nothing in this app that could be tested without
// a browser.
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
					// `.dom.test.ts` is the other project's, and without this exclusion the DOM-less
					// project would try to render a component into a DOM it does not have — failing with
					// `document is not defined`, which reads as a broken test rather than a misrouted one.
					exclude: ['src/**/*.dom.test.ts', 'vitest-setup/**/*.dom.test.ts'],
					expect: { requireAssertions: true },
					// No test may reach the network (the standing rule; see the setup file's own header).
					setupFiles: ['./vitest-setup/refuse-network.ts']
				}
			},
			{
				plugins: [svelte()],
				// ⚠ **Not tuning — this is what makes every assertion below mean anything, and it is
				// spelled differently here from the project above.** Measured on this configuration
				// with a post-`enforce` transform probe: under `environment: 'happy-dom'` vitest
				// transforms in vite's **`client`** environment, not `ssr`, so the plugin already sees
				// `consumer: 'client'` and `LayerList.svelte` emits `svelte/internal/client` with
				// nothing asked of it. What is *not* free is how `svelte`'s own public modules
				// resolve: its export map is `worker` / `browser` / `default`, and without this line
				// `import { mount } from 'svelte'` gets the server build, which throws
				// `mount(...) is not available on the server`. All fourteen tests fail without it and
				// pass with it.
				//
				// A top-level `resolve` is correct **here and wrong in the project above**, whose own
				// note records that for `environment: 'node'` the same setting lands on the `client`
				// environment and reaches nothing. The two projects transform in different vite
				// environments, so they configure the same fact in different places; neither spelling
				// works for the other, and both were measured rather than reasoned about.
				// The list *replaces* vite's defaults rather than adding to them, so `browser` alone
				// would drop `module` and the dev/prod condition and resolve other packages wrongly:
				// vite's own defaults have to be spelled out alongside it.
				resolve: {
					conditions: ['module', 'browser', 'development|production'],
					// `$lib` is SvelteKit's alias and this project does not run under SvelteKit, so it has
					// to be spelled here or a component that uses it fails to resolve at import time.
					// The `editor` project above needs none because nothing without a DOM imports through
					// it; the moment something does, it needs the same line in the same place its own
					// `resolve` note describes.
					alias: {
						$lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
						// SvelteKit generates `$app/paths` at build time and there is no build here. The
						// stub's own header records why its `base` is `''` and what that forbids.
						'$app/paths': fileURLToPath(new URL('./vitest-setup/app-paths.ts', import.meta.url)),
						'$app/navigation': fileURLToPath(
							new URL('./vitest-setup/app-navigation.ts', import.meta.url)
						)
					}
				},
				// **No `optimizeDeps.include`, deliberately.** `packages/core`'s browser project needs
				// one because Vite re-optimizes dependencies *during* a browser-mode run and then
				// reloads, which cost a measured forty minutes there. That failure mode is browser
				// mode's; running in Node is an escape from it rather than an inheritance of it, and a
				// list copied here would be a workaround for a problem this project does not have.
				test: {
					name: 'editor-dom',
					environment: 'happy-dom',
					include: ['src/**/*.dom.test.ts'],
					expect: { requireAssertions: true },
					setupFiles: [
						'./vitest-setup/refuse-network.ts',
						'./vitest-setup/dom-matchers.ts',
						'./vitest-setup/web-animations.ts'
					]
				}
			}
		]
	}
});
