# Contributing to Ballastella

Read [`CONTEXT.md`](CONTEXT.md) first. It defines the project's vocabulary — Workspace,
Project, Layer, Historical Map, Alignment, Control Point — and the near-synonyms to avoid.
The code and the UI are required to use those words, so a pull request that calls an
Alignment a "georeference" or a Control Point a "GCP" will be asked to change.

Then read [`.tracker/ballastella-v1/SPEC.md`](.tracker/ballastella-v1/SPEC.md). The
[ADRs](docs/adr) explain _why_ rather than _what_, and are best read on demand when the
spec cites one.

## ⚠️ Do not copy code from the Allmaps applications

**`apps/` in the Allmaps repository is GPL-3.0. `packages/*` is MIT.**

**Reading Allmaps Editor for architecture is fine.** It has been done deliberately —
particularly for the MapLibre image-pane projection, which is the hardest part of this
project. **Copying code from it silently relicenses this project.**

This is precisely what a well-meaning contributor does while "just fixing the projection
bug", and it is near-impossible to unwind afterwards. Ballastella is MIT because
[ADR-0021](docs/adr/0021-mit-licence-and-gpl-hygiene.md) commits us to upstreaming code
into [triiiceratops](https://github.com/wetterberg/triiiceratops), which is MIT: under
GPL-3.0 code could flow from triiiceratops into this app but never back out.

So: read it, understand it, then write it yourself. If you are unsure whether something you
wrote is too close, say so in the pull request rather than leaving it to be discovered.

New dependencies whose licence is not plainly permissive — and any dependency that ships a
compiled artefact under a different licence from its wrapper — need an entry in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

## Layout

```
packages/core          @ballastella/core — domain model, ProjectStore + adapters,
                       IIIF glue, alignment serialisation, annotation styling
apps/editor            @ballastella/editor — the authoring app
apps/viewer            @ballastella/viewer — the read-only viewer written into
                       published sites
e2e/                   Playwright browser tests, run against both built apps
scripts/               repository checks
```

One `core` package, deliberately, until a seam proves itself
([ADR-0019](docs/adr/0019-minimal-pnpm-monorepo.md)). `core` publishes its TypeScript source
rather than a build artefact, so there is no build step to keep in sync and no stale `dist`
to debug; the apps' bundlers compile it. That is why `core` has `check` and `test` scripts
but no `build`.

## Commands

| Command                              | Purpose                                        |
| ------------------------------------ | ---------------------------------------------- |
| `pnpm install`                       | install                                        |
| `pnpm -r build`                      | build all packages and apps                    |
| `pnpm -r test`                       | unit and integration tests (Vitest)            |
| `pnpm test`                          | the above, plus `scripts/` (`node --test`)     |
| `pnpm --filter @ballastella/core test` | core tests only                              |
| `pnpm test:e2e`                      | browser tests (Playwright, headless Chromium)  |
| `pnpm lint`                          | lint, format check, and the source fences      |
| `pnpm check:deployment`              | refuse development-only deployment settings   |
| `pnpm check:places`                  | ask the configured lookup service whether it still answers (hand-run, reaches the network) |
| `pnpm check:dev`                     | both apps answer their root route under `vite dev` |
| `pnpm check`                         | Svelte and TypeScript checks                   |
| `pnpm format`                        | rewrite formatting in place                    |

CI runs the ordinary development verification commands on every push. `pnpm check:deployment`
intentionally **fails** while the Base Map catalog reads an archive this deployment does not control
— Protomaps' demo bucket originally, and since 2026-08-10 the Source Cooperative mirror that replaced
it when the demo bucket began answering 404 — accepted for educational development and evaluation
(ADR-0025, an explicit human decision of 2026-08-07), so it is not part of `pnpm lint`. It is not
left to be remembered either: `scripts/check-deployment-runs.test.mjs` runs it against the shipped
catalog inside `pnpm test` and asserts its verdict *matches* that catalog — production blocked while
a borrowed host is named, clear once it is repointed — and prints which of the two is true. Run
`pnpm check:deployment` itself before a production deployment.

Three checks read **built output** rather than source, so they live in `.github/workflows/` instead
of in `pnpm lint`, which does not build: the ADR-0006 scan for absolute asset paths,
`scripts/check-nojekyll.mjs`, and `scripts/check-deploy-artifact.mjs`. Run them by hand after a
build if you have touched either app's `static/`, its adapter, the publish file set, or the routes.

## Deploying

`.github/workflows/pages.yml` builds the editor and deploys it to GitHub Pages on every push to
`main`. What a forker has to do, what a *user* has to do to publish their own Workspace, and the
outstanding Base Map decision are all in [`docs/hosting.md`](docs/hosting.md).

**There are two editor builds, and the difference is one directory each.** `pnpm build` is what you
and the test suite use. `pnpm build:deploy` is what ships: it reads a filtered source tree so a public
instance carries neither the `/image-pane` developer harness nor its test fixtures
(`scripts/stage-deploy-build.mjs` explains why this has to happen at build time — deleting the route
from `build/` afterwards leaves the service worker's precache manifest naming a document that is not
there, and `cache.addAll` rejects atomically, so the PWA silently never installs again).

Everything above the deployment build in `ci.yml` runs against the *ordinary* build, because that is
what the specs drive. CI therefore produces the deployment artifact last and checks it, so the shape
that actually ships is not the one shape nothing looks at.

## Five rules the toolchain enforces for you

**`apps/viewer` must never depend on `terra-draw` or the tiler**
([ADR-0019](docs/adr/0019-minimal-pnpm-monorepo.md)). The viewer is a separate build so that
its leanness is enforced by the dependency graph rather than by tree-shaking, because
tree-shaking is not a boundary: one incautious import and every published site silently
grows by megabytes, with no error and nobody looking. `scripts/check-viewer-deps.mjs` runs
as part of `pnpm lint` and fails if either appears in the viewer's manifest, or in the manifest
of a workspace package the viewer reaches.

This was a pair of checks until [ADR-0027](docs/adr/0027-no-streaming-tiler-in-v1.md).
`scripts/check-tiler-lazy.mjs` fenced the half no manifest can see — `wasm-vips` reachable only by
dynamic import — and that package is no longer in the repository, so the script and its
`pnpm check:bundles` step were deleted rather than left inspecting an absence. The tiler that
remains is `createImageBitmap` and an `OffscreenCanvas`, injected by whichever app has one, and it
draws in no dependency for a manifest to name.

**No asset may be referenced by an absolute path.** `paths.relative: true` is set in both
apps' `svelte.config.js` and is mandatory
([ADR-0006](docs/adr/0006-the-project-directory-is-the-published-site.md)): the publish
target — a domain root or a project subdirectory — is unknown at build time. CI greps the
built output, because the config is not what ships.

**No test may depend on the network.** A decision by the repository owner, enforced at both
seams rather than left to discipline. `e2e/support/network-fence.ts` gives every browser test a
`context` that refuses any request to an origin other than `localhost`, naming the URL and the
remedy, and `scripts/check-e2e-network-fence.mjs` fails `pnpm lint` if a spec imports `test` from
`@playwright/test` instead of from the fence — the spelling every Playwright example on the internet
uses, and the one that would quietly leave a new spec outside it.
`packages/core/vitest-setup/refuse-network.ts` is the same rule at the unit seam, for `fetch`,
`XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon` and `node:http`/`node:https`, in the Node
project and in the two browser engines.

The remedy is never a stubbed global: everything that fetches takes a `FetchFn` and the test hands
it a fake, or a browser test routes the URL to a fixture under `e2e/fixtures/`. There is exactly one
opt-out, `BALLASTELLA_NETWORK_TESTS=1`, and exactly one thing behind it —
`remote-iiif/live-services.test.ts`, which checks the captured IIIF corpus against the services
themselves and is not part of `pnpm test`. Both fences carry positive controls that run every time
(`e2e/editor-network-fence.e2e.ts`, `packages/core/vitest-setup/refuse-network*.test.ts`), because a
suite that reaches nothing and a fence that has stopped blocking print the same output.

**No module outside `packages/core/src/base-map/catalog.ts` may name a Base Map entry.** The
catalog is deployment configuration, and replacing it is the whole of pointing a fork at its own
tiles ([ADR-0020](docs/adr/0020-base-map-catalog-author-default-and-reader-switching.md)).
`scripts/check-base-map-catalog.mjs` runs as part of `pnpm lint` and fails if an entry id or an
archive appears anywhere else, because a special case keyed on one id still works perfectly on
this deployment and fails only on the fork, where nobody is looking. Tests are exempt: the
browser suite asserts that the switcher offers exactly this deployment's catalog, which it can
only do by naming it.

The same script's `--deployment` mode refuses an archive on a host this deployment does not control,
naming the catalog entries and the remedy. That URL is an explicit temporary development exception
under ADR-0025, never production configuration.

**No module outside `packages/core/src/places/service.ts` may name the place lookup service's
host.** The same property for the same reason, and `scripts/check-place-service.mjs` runs in
`pnpm lint` to hold it ([ADR-0029](docs/adr/0029-place-lookup-is-a-warned-service-that-leaves-nothing-behind.md)).
It scans for **the address**, not the service's name: `lookup.ts` quotes that service's autocomplete
policy by name, and a fence firing on documentation offers "delete the explanation" as its remedy.

Its `--deployment` mode **warns and exits 0** while the borrowed default is configured, where the
Base Map check *fails*. That asymmetry is argued in ADR-0029 and is not an oversight; the short of
it is that the remedies are not comparable, and it is written out on `BORROWED_SERVICES` in the
script for anyone tempted to tighten it. `pnpm check:deployment` is the composite that runs both,
and it runs **every** check whatever the one before it said, because a short-circuit here would
print the Base Map's failure and silently never reach the lookup at all. The Pages workflow raises
that warning as an annotation on every deploy, unconditionally — hung off the composite's exit code
it would go silent the day the archive is provisioned.

`pnpm check:places` is the exception to the network rule above, and the only one in this repository
that reaches a service: it issues one query and reports whether the answer still carries the fields
`readPlace` reads. **It is in no gate** — not `pnpm lint`, not `pnpm test`, not CI — because a
committed fixture goes on passing after reality has moved, and a check in a gate hands a stranger's
uptime the power to turn this repository red. `scripts/check-place-service.test.mjs` asserts it stays
out of all three.

## Dependency versions

Shared versions live in the `catalog:` block of `pnpm-workspace.yaml`, not in individual
manifests, so both apps cannot drift apart and a bump is one visible diff.

**Every `@allmaps/*` entry is an exact version with no range specifier.** All of them are
pre-1.0, and an Allmaps upgrade is a migration event
([ADR-0010](docs/adr/0010-integer-format-version-with-forward-only-migrations.md)) — which
is what the committed alignment fixtures and their round-trip test exist to catch. Nothing
else is pinned exactly.

## Accessibility

A Harvard-hosted teaching tool is held to WCAG 2.1 AA, and interactive components are where
that is won or lost. [ADR-0016](docs/adr/0016-daisyui-only-with-mandated-component-methods.md)
**mandates a method per surface** rather than only a library, because daisyUI documents
several options per component and states no preference:

| Surface           | Mandated                                       |
| ----------------- | ---------------------------------------------- |
| Modal             | `<dialog>` + `showModal()` / `close()`         |
| Dropdown / menu   | Popover API (`popover` + `popovertarget`)      |
| Tabs              | radio inputs with `role="tablist"`             |
| Select            | native `<select>`                              |
| Opacity           | native `<input type="range">`                  |
| Status            | `aria-live="polite"` region                    |

Banned: the checkbox-hack modal, the anchor/hash modal, the `<details>` dropdown, and the
CSS-focus dropdown.

**Tooltips are not an information channel.** daisyUI renders them via CSS `::before`, so
they are neither announced nor dismissable. Anything a user needs is visible text or
`aria-describedby`.

Accessibility is an acceptance criterion inside every change that adds UI — keyboard reach,
focus management, announced status — not a pass at the end. A single accessibility pass at
the end reliably becomes a graveyard.

## Tests

[SPEC.md's Testing Decisions](.tracker/ballastella-v1/SPEC.md#testing-decisions) is binding.
The short version: **the user's folder is the product**, so "after this sequence of actions
the store contains these files with this content" is not a proxy for behaviour — it _is_ the
behaviour. Assert on file contents and on rendered UI, never on internal call sequences,
private state, or module structure. A test that would still pass after `core` is reorganised
and would fail if a user's Project stopped loading is a good test; a test asserting that a
particular function was called is not.

There are two seams and no others: an in-memory `ProjectStore` for application logic, and
Playwright against headless Chromium for the running app. There is deliberately no
map-abstraction layer — Playwright drives real MapLibre.

### A green test is not evidence until you have watched it go red

Every ticket reviewed in this project so far — all of `ballastella-v1` and, at the time of writing,
eight of eight in `workspace-and-layers` — reported all its acceptance criteria passing and still had
substantive defects. Several criteria passed **vacuously**: delete the code under test and the test
stays green. Three of those were data loss.

So the mutation check is part of writing a test, not a review step someone else performs. Break the
behaviour, watch the assertion fail, restore it. Record what you broke and what went red, because
that record is the only evidence anyone has that the assertion is load-bearing.

Two patterns from real examples here, both of which passed review reading:

- **Assert on the thing, not on the page.** An offline test proved the Base Map drew by calling
  `queryRenderedFeatures()` over the whole map — which the Project's own Annotation Layer satisfied.
  The cached Base Map could be blank and the assertion stayed green. Filtering for the Base Map's own
  layers (`roads_`, `water`) is what made the claim real.
- **A resource nobody requests cannot prove it was cached.** An assertion that no console complaint
  named `base-map/` was the only proof glyphs still shipped — but with no archive, MapLibre never
  requests a glyph range, so nothing complained and nothing was proved. The fix was to fetch the
  glyph and the sprite directly.

**An assertion that a name is *absent* earns its place when a plausible one-line change would make
it appear again — and not otherwise.** These read as decoration once whatever they named has been
deleted, and the temptation is to remove them as vacuous. That is the wrong test. What makes a check
vacuous is having no reachable path to red, not having a subject that has gone: `expect(cached).not
.toMatch(/\.wasm$/)` still fails the day someone widens a precache filter, whether or not any `.wasm`
exists today. Conversely, an assertion no edit could turn red should go, and go in the same commit
that made it so. Apply one reading to every site of the shape at once; the worked example, with all
five of this repo's, is in `e2e/editor-pwa.e2e.ts`.

**Fences need a positive control.** This repo has shipped a fence that printed its success message
unconditionally. `scripts/check-alignment-writers.mjs` and `scripts/check-workspace-rooted-paths.mjs`
show the shape: a `KNOWN_BAD` specimen per pattern, asserted to be caught before the real scan runs,
so a pattern that has stopped matching fails the fence instead of passing it. Write the escape out,
watch it pass, then close it.

### When the browser suite is red

**Read it as real.** For most of this epic it flaked at roughly one run in three and the settled
advice was to re-run; ticket 17 measured ten consecutive runs, classified every failure, and found no
contention at all. There were no browser crashes, and every remaining failure had a nameable cause —
including one genuine application bug, a Workspace walk that raised when a directory was deleted
underneath it. The measured rate and the method are in `playwright.config.ts`'s `workers` comment,
with a date. A red run is now evidence about your change until you have shown otherwise.

Two things the suite does for you that it did not before:

- **A retried test is printed, and the rate is a budget.** `retries: 1` applies everywhere, and
  `scripts/retry-budget.mjs` fails the run when more than 0.5% of tests passed only on a second
  attempt — one test in 398. Green after a retry is data, not success. Its positive control is
  `e2e/editor-retry-budget-control.e2e.ts`; the two commands are in that file's header.
  ⚠ **`--reporter=…` replaces the reporter list and disables the budget.** `--reporter=line` is an
  ordinary thing to type and it turns the fence off silently. Write
  `--reporter=line,./scripts/retry-budget.mjs` if you want both. CI passes no `--reporter`.
- **A retried test keeps a trace.** `trace: 'on-first-retry'`, so
  `pnpm exec playwright show-trace test-results/…/trace.zip` shows the DOM at the moment it went
  wrong. That is how the export-button failure above was identified, after four implementers had
  filed it as contention.

Before reporting a failure as a known flake, prove it:

```sh
pnpm flake:check --against main e2e/editor-pwa.e2e.ts
```

That re-runs the spec alone and then against the merge-base in a throwaway worktree, and prints
`REAL` / `PRE-EXISTING` / `SUSPECT` / `CONSISTENT WITH FLAKE`. Doing this by hand is what people
skip when they are tired, and the cost of skipping it is shipping a regression labelled "known
flake". Someone who did it properly found a defect the suite had been red on for three commits.

**Wait for what happened, not for what is on screen.** The largest single source of the historical
flake was helpers returning as soon as a row was visible and then reloading the page, which takes the
Workspace as it is *on disk* — and `project.json` is written on a 400 ms debounce (ADR-0017 rule 2).
`e2e/support/saved.ts` holds the two honest waits. In particular, **do not wait for the save
indicator to read "Saved"**: its sequence is `saved → unsaved → saving → saved`, so "Saved" is also
what it says before the save begins, and `SaveIndicator.svelte` deliberately lags it by 400 ms so it
does not strobe. A transient state cannot be caught by polling for it at all; record it with a
`MutationObserver` and assert the sequence.

**And since ticket 20 a reload no longer loses a pending write, which changes what a green reload
proves.** An edit inside its debounce window is copied synchronously to a write-ahead journal
(ADR-0017 rule 3) and put back at the next startup, so `page.reload()` is no longer a way to assert
that something reached the Workspace *by the route under test* — it may have arrived by the replay.
A test about a write should assert the file, in place, without reloading. A test about the journal
should say so and should provoke a real navigation rather than dispatching `pagehide`: the dispatched
version was green while the user's case was losing the edit 8 times out of 8, which is the sharpest
example this repository has of a test that could not see the bug it was named after. If a spec needs
a Workspace with no journalled edits in it, clear the `ballastella.journal.` keys the way
`editor-workspace.e2e.ts` does.

**The browser suite runs against `apps/*/build`, so development mode is not covered by it.** That is
the right default — the shipped Published Site is prerendered static files with no server (ADR-0006),
so the build is what a Reader gets. But it left `vite dev` as the one configuration nothing exercised,
and it broke: a dependency resolving to its CommonJS build under SSR made every route of both apps
answer 500 while lint, typecheck, the unit suite, the browser suite and both bundle fences stayed
green. `pnpm check:dev` is the floor under that — it boots each app's dev server and asserts the root
route answers 200. It is a boot check on purpose; what a page then *does* belongs in the browser suite,
against the build that ships.
