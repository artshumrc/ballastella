# 16 — Publish: viewer build, additive publish, relative paths, canonical URL

## What to build

A user clicks Publish. An `index.html` and a read-only viewer bundle are written into their Workspace, next to the data already there. That folder, pushed to GitHub Pages or uploaded to any static host, is a working website — at a domain root or in a subdirectory, without reconfiguration.

Optionally, the user supplies a canonical URL and their Historical Maps become real, citable IIIF endpoints.

**Fulfills** — [SPEC.md](../SPEC.md) user stories 78, 79, 80, 81, 88, 89, 90, 92, 99, and 101. Story 82's hub page is written here; its Reader behaviour is ticket 17. With ticket 13: 87 and 93. With ticket 15: 15. With ticket 09: 29.

## Where to start

[ADR-0006](../../../docs/adr/0006-the-project-directory-is-the-published-site.md) (additive publishing, relative paths, the enumerable file set), [ADR-0008](../../../docs/adr/0008-projects-live-in-a-workspace.md) (workspace is the site root; `?p=` addressing), [ADR-0019](../../../docs/adr/0019-minimal-pnpm-monorepo.md) (the viewer is a separate lean build), [ADR-0004](../../../docs/adr/0004-image-service-base-url-is-resolved-at-load-time.md) (canonical URL stamping), [ADR-0020](../../../docs/adr/0020-base-map-catalog-author-default-and-reader-switching.md) (the catalog ships in the bundle).

The viewer's *behaviour* is ticket 17; this ticket produces and places the bundle, and the hub page.

## Contract

**Publishing is additive. No data is copied.**

```
workspace/
├── index.html            ← written by publish
├── _app/                 ← the viewer bundle
├── amsterdam-1625/       ← untouched
└── boston-1775/          ← untouched
```

The alternative — exporting to a separate directory containing the viewer *and a copy of the data* — was rejected on tile bytes: a single large Historical Map is hundreds of megabytes to gigabytes of pyramid, and copying it on every publish is slowest precisely in OPFS, the most constrained backend (ADR-0006).

**`paths.relative: true`** was set in ticket 01 and this ticket proves it: `paths.base` is baked at build time, but at build time we cannot know whether the user publishes to `username.github.io/some-repo/` or to a domain root. **Both must work from one build.**

**The viewer file set must be enumerable and recorded**, so ticket 13's data-only zip can exclude it. Ticket 13 built the mechanism and left the list empty; **populate it here.** Without it the two export flavours are indistinguishable.

**The viewer stamps its version**, so the app can notice when a re-publish is due after the data changes (ADR-0006).

**The hub page lists Projects** with their names — a scholar's portfolio at one address, which ADR-0008 treats as a feature rather than scaffolding. Projects are addressed `?p=<directory-name>`.

**The resolved base map catalog travels in the bundle** (ADR-0020), so a Published Site keeps working even if the authoring deployment later changes its catalog.

### Warnings — required, not optional

| Condition | Warning |
|---|---|
| Any Layer has `imageMode: 'referenced'` | The site depends on remote images; a Reader without a network sees nothing (ADR-0007) |
| Bundling a pmtiles extract | State the size it is about to add, **before** adding it (ADR-0020) |
| Workspace approaching ~1 GB | GitHub Pages caps a published site around 1 GB, with a hard 100 MB per-file limit in git. This is a **cliff**, not a slowdown: warn rather than letting `git push` fail cryptically (ADR-0008). Computed from ticket 02's `ProjectStore#size` — never by reading tile bytes. Ticket 15 warns earlier, when a mirror is about to cause the growth |

### Canonical URL stamping — opt-in

The user supplies a URL; every `info.json` `id` is rewritten from the `unset.invalid` placeholder to that address, and it is remembered in the Project.

This delivers something the placeholder cannot: **the tiles become a real, citable IIIF endpoint that Allmaps, Theseus, and OpenSeadragon can consume directly** (ADR-0004). Load-time override still always wins, so a stamped Project that is later moved keeps working in the app.

## Out of scope

- **Viewer behaviour** — ticket 17: exploration, popups, base map switching, unwarped viewing, responsiveness.
- **The service worker and PWA manifest** — ticket 18.
- **Publishing a single Project standalone.** The Workspace is the site; single-project output is a deferred second mode (ADR-0008).
- **Pretty per-project URLs** (`/amsterdam-1625/`). ADR-0008 chose `?p=` precisely to avoid post-build path rewriting and per-project artefacts that rot on rename; adding them is additive later.
- **In-app git.** Publishing produces files; committing is the user's business, documented in prose (ADR-0014).
- **Documenting how to produce a pmtiles extract.** Out of this epic.

## Acceptance criteria

- [ ] Publishing writes `index.html` and the viewer bundle at the workspace root and **modifies no Project data** — verified by hashing every Project file before and after
- [ ] No image pyramid is copied or duplicated by publishing
- [ ] The built site works served from a **domain root** and from a **subdirectory**, from the same build, with no reconfiguration
- [ ] All asset references in the output are relative — no leading `/`
- [ ] The hub page lists every Project and `?p=<dir>` opens one
- [ ] The viewer file set is enumerated and recorded, and ticket 13's data-only zip excludes exactly that set
- [ ] The viewer bundle carries a version stamp readable by the editor
- [ ] `apps/viewer`'s built output contains no `terra-draw`, tiler, or `wasm-vips` code
- [ ] The resolved base map catalog is present in the bundle
- [ ] Publishing with a referenced Layer warns that the site needs a network
- [ ] Bundling a pmtiles extract states its size before adding it
- [ ] A workspace approaching 1 GB produces a warning naming the hosting limit, computed via `ProjectStore#size` without reading tile bytes
- [ ] Publishing a **second** time after adding a Project extends the hub page to include it, leaves every earlier Project's files byte-identical, and refreshes the bundle's version stamp — the semester-long, one-repository workflow
- [ ] Building, publishing, and serving the site require no API key, token, or secret: CI builds with no project-specific environment variables set, and no `*_KEY`, `*_TOKEN`, or `*_SECRET` reference exists in either app's source
- [ ] Stamping a canonical URL rewrites every `info.json` `id`, and the value is remembered
- [ ] A stamped Project still opens in the editor, because load-time override wins
- [ ] Publish is reachable and operable by keyboard, and progress and warnings are announced

```bash
pnpm -r build
pnpm --filter @ballastella/core test    # additive publish, file-set enumeration, stamping, warnings
pnpm test:e2e                    # serve the published workspace at root AND at a subpath

# no absolute asset paths in the published output
grep -rEo '(src|href)="/[^"]*"' <published workspace> || echo "OK: relative only"

# viewer leanness
grep -rl "terra-draw\|wasm-vips" apps/viewer/build && echo "FAIL" || echo "OK: lean"
```

Success: all exit 0; both `grep`s print their OK line; and the e2e suite loads the same published output from **two different base paths**, since serving only from a root would pass while the GitHub Pages case — the one students will actually use — remained broken.

## Blocked by

- Ticket 09
- Ticket 10
