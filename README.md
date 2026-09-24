# Ballastella

A browser app for georeferencing historical map images and annotating them. There is no backend: the
app is static files, and a user's work is plain files (IIIF, GeoJSON) in storage they own, optionally
synced to a GitHub repository that can serve it as a read-only website.

## How it fits together

```
 ┌──────────── editor (PWA, static) ────────────┐        ┌── user's GitHub repo ──┐
 │ tile image → align → annotate                │  sync  │ projects/tiles/json    │
 │            │                                 │ ─────► │ + viewer bundle        │
 │      ProjectStore (OPFS or a real folder)    │        │ = GitHub Pages site    │
 └──────────────────────────────────────────────┘        └────────────────────────┘
```

- **Workspace → Projects.** A Workspace is one directory; each Project in it holds Map Images as
  level-0 IIIF tile pyramids (tiled in the browser), Alignments as IIIF Georeference Annotations,
  and Annotations as GeoJSON (simplestyle). All reads and writes go through one `ProjectStore`
  interface (`read`/`write`/`list`/`delete`) with adapters for OPFS (the default), a File System
  Access folder, memory (tests) and HTTP (read-only, for the viewer).
- **Rendering.** MapLibre draws the Base Map (a PMTiles archive), Allmaps warps aligned images onto
  it, and Terra Draw handles drawing annotations.
- **Sync.** The editor talks straight to the GitHub REST API from the browser. Each sync is a
  single commit. Users authenticate by pasting a fine-grained token, or through a GitHub App sign-in.
  The sign-in needs a small **broker** to swap the OAuth code for a token, because GitHub's token
  endpoint doesn't allow CORS. The broker holds the App secret and never sees any data. Its code
  lives in another repo.
- **Share Links.** When this is on, the editor writes the prebuilt viewer (`_app/`, `index.html`,
  `ballastella-site.json`) into the Workspace. The user's repo is then served by GitHub Pages as-is.
  Nothing needs building.

## Repository layout

| Path             | What it is                                                                              |
| ---------------- | --------------------------------------------------------------------------------------- |
| `packages/core`  | Framework-free logic: store adapters, tiler, alignment, annotations, sync, Base Map catalog |
| `packages/ui`    | Svelte components that both apps render                                                  |
| `apps/editor`    | SvelteKit authoring app, installable as a PWA. This is what gets deployed                |
| `apps/viewer`    | Lean read-only SvelteKit app. It is built and bundled into the editor, never deployed on its own |
| `e2e/`           | Playwright tests against both built apps                                                 |
| `scripts/`       | Lint fences, e2e wrappers and deploy checks called from `package.json`                   |
| `docs/adr/`      | Decision records. Code comments cite them by number                                      |

Read `CONTEXT.md` (domain vocabulary) and `CONTRIBUTING.md` (toolchain rules, test seams) before
changing anything.

## Develop

```sh
pnpm install
pnpm --filter @ballastella/editor dev   # also builds and stages the viewer
pnpm precommit                          # lint → check → test → e2e
```

Use `pnpm dev:clean` and `pnpm test:e2e` instead of `pkill` or running Playwright directly (see
`CLAUDE.md`).

## Deployment

`.github/workflows/pages.yml` runs on every push to `main`. It runs `pnpm build:deploy`, which builds
the viewer, stages it inside the editor, and removes dev-only routes and fixtures. It then checks the
artifact (relative asset paths only, `.nojekyll`, no dev harness) and deploys `apps/editor/build`
to GitHub Pages. `ci.yml` runs the test suite separately, so the deploy doesn't wait on it.

To run your own instance, fork the repo, set **Settings → Pages → Source** to **GitHub Actions**,
and push. You need no secrets or server. Things a fork should repoint:

- **Base Map archive** in `packages/core/src/base-map/catalog.ts`. It currently points at a public
  Protomaps build this project doesn't control, so `pnpm check:deployment` fails on purpose and the
  deploy only warns.
- **Place search** in `packages/core/src/places/service.ts`. It uses OSM's Nominatim by default.
- **GitHub App and broker** in `packages/core/src/remote/github-app.ts`. A fork can't reuse this
  deployment's App, so either register your own App and deploy a broker, or clear these values and
  rely on pasted tokens.

[`docs/hosting.md`](docs/hosting.md) covers each of these in full, plus the user-side sync and Share
Links flow and the known gaps.

## Licence

MIT. The Allmaps `apps/editor` and `apps/viewer` are GPL-3.0, so don't copy code from them (its
`packages/*` are MIT). See [ADR-0021](docs/adr/0021-mit-licence-and-gpl-hygiene.md).
