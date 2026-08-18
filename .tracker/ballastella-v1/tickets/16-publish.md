# 16 — Publish: viewer build, additive publish, relative paths, canonical URL

## What to build

A user clicks Publish. An `index.html` and a read-only viewer bundle are written into their Workspace, next to the data already there. That folder, pushed to GitHub Pages or uploaded to any static host, is a working website — at a domain root or in a subdirectory, without reconfiguration.

Optionally, the user supplies a canonical URL and their Map Images become real, citable IIIF endpoints.

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

The alternative — exporting to a separate directory containing the viewer *and a copy of the data* — was rejected on tile bytes: a single large Map Image is hundreds of megabytes to gigabytes of pyramid, and copying it on every publish is slowest precisely in OPFS, the most constrained backend (ADR-0006).

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

- [x] Publishing writes `index.html` and the viewer bundle at the workspace root and **modifies no Project data** — verified by hashing every Project file before and after
- [x] No image pyramid is copied or duplicated by publishing
- [x] The built site works served from a **domain root** and from a **subdirectory**, from the same build, with no reconfiguration
- [x] All asset references in the output are relative — no leading `/`
- [x] The hub page lists every Project and `?p=<dir>` opens one
- [x] The viewer file set is enumerated and recorded, and ticket 13's data-only zip excludes exactly that set
- [x] The viewer bundle carries a version stamp readable by the editor
- [x] `apps/viewer`'s built output contains no `terra-draw`, tiler, or `wasm-vips` code
- [x] The resolved base map catalog is present in the bundle
- [x] Publishing with a referenced Layer warns that the site needs a network
- [x] Bundling a pmtiles extract states its size before adding it
- [x] A workspace approaching 1 GB produces a warning naming the hosting limit, computed via `ProjectStore#size` without reading tile bytes
- [x] Publishing a **second** time after adding a Project extends the hub page to include it, leaves every earlier Project's files byte-identical, and refreshes the bundle's version stamp — the semester-long, one-repository workflow
- [x] Building, publishing, and serving the site require no API key, token, or secret: CI builds with no project-specific environment variables set, and no `*_KEY`, `*_TOKEN`, or `*_SECRET` reference exists in either app's source
- [x] Stamping a canonical URL rewrites every `info.json` `id`, and the value is remembered
- [x] A stamped Project still opens in the editor, because load-time override wins
- [x] Publish is reachable and operable by keyboard, and progress and warnings are announced

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

## Implementation notes

**How the Published Site is asserted.** `e2e/editor-publish.e2e.ts` publishes through the UI, reads the whole Workspace out of OPFS, writes it to a temporary directory, and serves **that one directory** behind two plain file servers — one at `/`, one at `/student/atlas-2026` — with no rewriting and no SPA fallback (`e2e/support/static-site.ts`), because a static host does none of those either. It then drives the site: the hub lists the Project, the link the hub rendered opens `?p=`, the Layer names come out of the Project's own `project.json` fetched over HTTP, nothing 404s, and no request escapes the published folder. Inspecting the files is a separate, weaker assertion kept beside it.

Verified by mutation that the subdirectory case is the load-bearing half: with the data reads pointed at `/` instead of at the document, the root site still passes and only the subdirectory fails — which is the discrimination the ticket's success criterion asks for.

**The site record.** A static host has no directory listing, so the viewer cannot discover a Project the way the editor's Workspace does. `ballastella-site.json` at the Workspace carries the Project list, the viewer's version stamp, and the resolved Base Map catalog. It is not an index *of the data*: it holds no file paths and nothing a Project needs, so deleting it leaves every Project complete and readable with no proprietary index (SPEC story 94).

**`VIEWER_FILE_PATHS` is now an invariant, not a comment.** `publishSite` refuses to write a path the recorded list does not name. The list stayed in `transfer/viewer-files.ts` — a leaf module importing nothing — so that the zip exporter reaching it does not drag the publish machinery into `apps/viewer`'s bundle through core's barrel, which a review of `check-viewer-deps.mjs` had already identified as a hole. `e2e/viewer.e2e.ts` now asserts the built viewer carries none of publishing's marker strings, with the counterpart that every marker *is* present in the built editor.

**`canonicalUrl` is omitted from `project.json` when unset.** Writing it as `null` would have changed the bytes of every Project ever written and broken the byte-identity contract across reorder, rename, toggle, and opacity — asserted by a test that mutation-checks red when the field is written unconditionally.

**No keys, tokens, or secrets.** CI sets no project-specific environment variables, and `grep -rn "_KEY\|_TOKEN\|_SECRET"` over both apps' and core's source finds no credential: every `*_KEY` hit is a `localStorage` or IndexedDB key name or an object-key list, and there is no `*_TOKEN` or `*_SECRET` at all.

**The hosting-limit total.** Computed by ticket 15's `workspaceSize(store)` — `reclaimAbandonedWrites`, then `list`, then `size` per path — and never by reading a file. Asserted with a spy on the public `read`: the only path publishing reads while planning is each `project.json`, which it needs for the referenced-image warning. The sentence is publishing's own, but the arithmetic is `crossesHostingLimit` and the figures `describeBytes`, so the two moments ticket 15 and this ticket warn at cannot give one Workspace two different answers.

## Follow-ups

- **The HTTP `ProjectStore` adapter ADR-0006 names is not built.** The viewer reads `ballastella-site.json` and `project.json` through a two-function helper (`apps/viewer/src/lib/site-files.ts`) rather than through a third adapter. Nothing in this ticket needs one — two JSON reads — but ticket 17 reads Annotations, Alignments, and tiles, and that is the point at which the adapter earns its place and the shared reading code pays out a third time.
- **`e2e/editor-image-pane.e2e.ts:86` is missing an `await`**: `expect(page.getByTestId('pane-tiles')).toHaveAttribute('data-tiles-loaded', 'true')` returns a promise nothing waits on, so that assertion cannot fail the test. Left alone deliberately — fixing it may turn a green test red for reasons unrelated to this ticket — but it is the epic's recurring shape and should be someone's ticket.
- **Per-Project pretty URLs and a per-Project `index.html` remain out of scope** (ADR-0008), which is why `VIEWER_FILE_PATHS` records Workspace-relative names. `isViewerFile` still bites for a Project directory that *holds* a viewer — the shape a folder has when somebody unpacks a Published Site into one — which is the case ADR-0006 means by "the two export flavours are indistinguishable", and it is asserted.
- **The version stamp covers the viewer's files only**, not the bundled Base Map. Changing the pmtiles extract therefore does not mark a Published Site as out of date. Deliberate — ADR-0006 stamps *the viewer* — but worth knowing before anyone repoints the catalog.
