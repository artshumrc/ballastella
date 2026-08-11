# 03 — A public instance ships only the app

## What to build

A deployment build of the editor that carries neither the `/image-pane` developer harness route nor
the test fixtures it reads, and a check on the artifact that says so.

**Fulfills** — no SPEC user story. It is a consequence of ticket 02: the moment there is a workflow
that publishes the editor, what the editor's build *contains* becomes a public fact rather than a
local one.

## Why this exists

Found while writing ticket 02's workflow, by reading what the artifact would actually hold:

- `apps/editor/static/fixtures/` — 988 kB of the Sanson 1657 fixture pyramid, committed test data.
- `image-pane.html` — a prerendered route nothing in the UI links to, built in ticket 03 of
  `ballastella-v1` as a harness for the image pane "before the storage layer or the tiler exist".

Neither is a security problem: the map is public domain, no user data is involved, and
`editor-pwa.e2e.ts` already asserts that no fixture path is ever precached. But both would be served
publicly by every fork, and a page that nothing links to and that shows a developer readout is not
part of the application a forker is offering their students.

## The trap: it cannot be pruned after the build

**`apps/editor/src/service-worker.ts` precaches `[...prerendered, ...build.filter(js|css)]`, and
`cache.addAll` rejects atomically.** Delete `image-pane.html` from `build/` and the manifest names a
document that is not there, so `install` rejects — for ever. The new worker is never promoted, the app
stops updating and stops working offline, and nothing on screen says why.

So the route has to be absent when SvelteKit *writes* the manifest, which means absent from the routes
directory the build reads.

The fixtures are the opposite case and could safely have been deleted afterwards — they are `static/`,
`BASE_MAP` takes only `base-map/`, and nothing else precaches them. They go through the same mechanism
anyway, because one rule with one explanation beats two rules a reader has to keep apart.

## The harness is excluded, not deleted

`/image-pane` carries `e2e/editor-image-pane.e2e.ts` — 329 lines of Seam 2 coverage that nothing else
makes: MapLibre's `project` and `unproject` composed in opposite directions against a point drawn by
`resourceToSynthetic`, a pan pinned to a physical distance, and the zoom-stability acceptance criterion
of `ballastella-v1` ticket 03. It needs a bare pane with no alignment workspace around it.

So it stays in the app — type-checked, linted, driven by the suite — and it is the *deployed artifact*
that leaves it out. Deleting the route and retiring the spec was considered and rejected on that
coverage. `@ballastella/core`'s unit tests read the same fixture pyramid off disk and are untouched.

## Contract

`scripts/stage-deploy-build.mjs` writes `apps/editor/.deploy/{routes,static}` — copies of
`src/routes` and `static` with `image-pane` and `fixtures` left out. `svelte.config.js` reads
`BALLASTELLA_DEPLOY=1` and points `kit.files` at them. An env var rather than a second config file,
because everything else about the two builds must be identical and a copied config is how they drift.

**A name in `EXCLUDED` that no longer exists is an error, not a no-op.** Excluding by name means a
rename silently stops excluding anything: the harness reappears in the artifact and the build still
reports success.

`pnpm build:deploy` at the root; `pages.yml` runs it instead of `pnpm -r build`.

### The check, and why it is not optional

The exclusion is invisible from a developer's loop — the ordinary build still holds both, every test
drives them, and nothing local ever looks at a deployment build. So every way it silently stops
happening is live: a dropped env var, a `kit.files` rename in a SvelteKit upgrade, `pages.yml` edited
back to the ordinary build. Each produces **a successful build of the wrong artifact**.

`scripts/check-deploy-artifact.mjs` therefore reads the output: the two exclusions are absent, the real
pages are *present* (positive controls, or it passes on an empty directory), and the built service
worker names neither excluded path — gated on the absence, so the same worker naming the same path is
correctly fine in an ordinary build and fatal in a deployment one.

### One hazard this created, and closed

`pnpm build:deploy` writes the same `apps/editor/build` that `scripts/e2e-build.mjs` fingerprints, and
the fingerprint is over build *inputs* — which are identical. So a developer who ran a deployment build
would have had the e2e suite silently served it, failing `editor-image-pane.e2e.ts` on a missing route
for a reason nothing connects to a build they ran earlier. Exactly the stale-build failure that stamp
exists to prevent, through the one door it could not see.

Closed by adding `image-pane.html` to `OUTPUTS` as a sentinel — a document only the ordinary build
writes — and `.deploy` to `SKIP_DIRECTORIES`, since it is output living under a source root like
`viewer-bundle`. A test reads the `omit:` names out of the staging script and requires `OUTPUTS` to
name one of them, so the two cannot drift apart quietly.

## Out of scope

- **Deleting the harness route or its spec.** See above.
- **Trimming anything else from the artifact.** `viewer-bundle/` is cargo publishing needs
  (ADR-0006) and `base-map/` is deployment assets (ADR-0020). Both belong there.

## Acceptance criteria

- [x] `pnpm build:deploy` produces an artifact with no `image-pane.html` and no `fixtures/`
- [x] The built service worker in that artifact names neither
- [x] `pnpm build` is unchanged, and still produces both — verified after a deployment build
- [x] A renamed or deleted `EXCLUDED` entry fails the staging script rather than excluding nothing
- [x] `check-deploy-artifact.mjs` passes on a deployment artifact, fails on an ordinary one, fails on a
      missing real page, fails on a mismatched service worker, and fails on an empty directory
- [x] A deployment build left in place forces `e2e-build.mjs` to rebuild — demonstrated, not reasoned
- [x] `OUTPUTS` and the staging script's exclusions are pinned against drift by a test
- [x] `pages.yml` deploys the deployment build; `ci.yml` builds and checks it last, after the suite
