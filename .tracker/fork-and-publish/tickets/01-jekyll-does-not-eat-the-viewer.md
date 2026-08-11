# 01 — Jekyll does not eat the viewer

## What to build

An empty `.nojekyll` at the root of every site this repository produces — the editor's own build, and
every Workspace that publishing turns into a site — plus a fence that keeps it there.

**Fulfills** — protects [SPEC.md](../../ballastella-v1/SPEC.md) stories 78, 80, 81, 83, 84, and 99.
Not by adding behaviour: all six are already implemented and all six are unreachable on a
branch-deployed GitHub Pages site without this file.

## The defect

GitHub Pages, deploying from a branch, runs the repository through Jekyll. Jekyll excludes every path
beginning with `_`. `PUBLISHED_APP_DIRECTORY` is `_app/`, which is where SvelteKit puts the whole
JavaScript and CSS payload of both apps.

So: `index.html` is served, every `<script>` in it 404s, and the page is blank. Nothing appears in the
UI, nothing appears in the server log the user can see, and the only diagnosis is a browser's network
panel. `@sveltejs/adapter-static@3.0.10` does not write the marker — checked, not assumed — and
nothing in this repository created one.

## Where the failure lands, which is not where it looks like it lands

**The author's repository, not ours.** Publishing writes a site into the user's Workspace and the
Publish dialog tells them to "Push the folder to GitHub Pages". They do that by hand, to a repository
of their own, with the default branch deploy and no workflow of ours in it. That is the site Jekyll
eats.

This matters for the shape of the fix. A `.nojekyll` in the editor's build alone would look like a fix
and would protect nobody who publishes anything — and a fork deployed through
`.github/workflows/pages.yml` never meets Jekyll at all, because `actions/deploy-pages` does not run
it. **The deployment that proves this file is one we never see.**

## Contract

Two links, carried by deliberately different mechanisms.

**The editor's own build** ships the marker from `apps/editor/static/`, so it arrives the same way
`robots.txt` does. That covers a forker who deploys from a branch rather than through `pages.yml`.

**Every published Workspace** gets it from `publishSite`, which *authors* it — zero bytes,
`source: ''`, nothing fetched — exactly as it already authors `ballastella-site.json`. It is
recorded in `VIEWER_FILE_PATHS` like every other published path.

### Why the second one is not simply staged into the viewer's bundle

Because that was the first attempt and it broke the Publish button outright.

The marker was put in `apps/viewer/static/`, which staged it into the bundle and made publishing
`fetch` it like any other asset. `vite preview` — which serves the editor for the whole e2e suite —
**does not serve dotfiles**. Twelve publish specs failed with the flow hanging on an empty status
line, because `readBundleAsset` got a 404 for a file with nothing in it.

**The lesson is not about the dev server.** Refusing dotfiles is ordinary static-host behaviour, so
any deployment of the *editor* onto such a host would have had the same dead button — failing only
there, on somebody's fork, where nobody is looking. An empty file is worth neither a round trip nor
a dependency on how the authoring host feels about hidden files.

Recording it in `VIEWER_FILE_PATHS` is load-bearing twice over: `publish.test.ts` asserts that list
against what `publishSite` actually wrote, in **both** directions, so the entry cannot be added
without the file being written; and the backup tar and data-only zip exclude the list, which is
correct here — the marker is published output, regenerated on every publish, and restoring a stale
one alongside a stale viewer is exactly what ADR-0024 leaves out.

## The fence, and why the fence needs a test

An empty file in `static/` is the least noticeable thing a repository can hold. Nothing imports it, no
type mentions it, and deleting it breaks no build, no test, and no lint — it would be tidied away as
"an empty file nobody explained" and everything would stay green, because the failure is on somebody
else's host.

`scripts/check-nojekyll.mjs` asserts the editor's build carries it, that `JEKYLL_OFF_MARKER` still
names it (everything downstream is spelled from that constant), and — from the other direction — that
the marker is **not** in the staged bundle, because its presence there means somebody has put it back
in `apps/viewer/static/` and publishing is fetching an empty file over HTTP again.

The published half is asserted where it lives: `publish.test.ts` checks `VIEWER_FILE_PATHS` against
what `publishSite` actually wrote, in both directions, so the marker cannot be dropped from either
side without a red test.

That gives the fence the same invisibility as the thing it fences, so
`scripts/check-nojekyll.test.mjs` breaks each link against fixture trees and requires the check to
notice, and asserts the passing case too, so a check that refused everything could not satisfy the
rest. `--root` exists for that: a fence that has never been seen to fail is indistinguishable from
`exit 0`.

It reads built output, so it cannot live in `pnpm lint`, which does not build. It runs in `ci.yml`
after the build — beside the ADR-0006 absolute-path scan, which is there for the same reason — and
again in `pages.yml` against the artifact about to be uploaded.

## Out of scope

- **Making the editor's own Pages deploy need it.** It does not; `deploy-pages` skips Jekyll. The
  editor's marker is for a forker who chooses a branch deploy instead of the workflow.
- **A new writing mechanism.** `publishSite` already authors a file with `source: ''`; this is the
  second one, through the same seam.

## Acceptance criteria

- [x] `apps/editor/static/.nojekyll` exists, is empty, and appears in built output — verified by
      building, not by reading the Vite config
- [x] `publishSite` writes `.nojekyll` at the Workspace root, authored rather than fetched
- [x] It is **not** in the viewer's build or the staged bundle, so nothing fetches it
- [x] `VIEWER_FILE_PATHS` records it, and `publish.test.ts`'s two-way assertion passes with it
- [x] The progress total counts both authored files, so it cannot tick past its own maximum
- [x] The backup tar and the data-only zip exclude it, as published output (ADR-0024)
- [x] `scripts/check-nojekyll.mjs` passes on a built tree and fails, by name, on each of: no marker in
      the editor build, the marker back inside the staged bundle, a renamed `JEKYLL_OFF_MARKER`, and a
      build directory that does not exist
- [x] The fence runs in `ci.yml` after the build, and in `pages.yml` before upload
- [x] The twelve publish e2e specs pass — the ones the fetched-marker version broke
