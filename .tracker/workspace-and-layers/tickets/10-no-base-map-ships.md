# No Base Map ships

## What to build

The 4.0 MB `amsterdam-centre.pmtiles` archive stops shipping. The deployment must name its own Base Map archive, and the build fails while it still points at Protomaps' public demo bucket. Glyphs and sprites keep shipping, because without them the map draws with the wrong fonts and says nothing about it.

Demonstrable end to end: the built editor contains no `.pmtiles` file; `pnpm check:deployment` fails while the catalog names the demo bucket and passes once it names something else; and an installed app opened with no connection and a new Project shows a named explanation rather than a blank grey rectangle.

Read [ADR-0025](../../../docs/adr/0025-no-base-map-ships-offline-is-per-project-and-opt-in.md) first.

## Where to start

- `packages/core/src/base-map/catalog.ts` — `BUNDLED_ARCHIVE`, `REMOTE_ARCHIVE`, the four entries, `defaultId`. **Read the comment on `REMOTE_ARCHIVE`**: it already records that Protomaps' bucket has no rate limit, no uptime promise, and no terms of use, and that "nothing about it is suitable to rely on." That comment is the justification for the fence.
- `apps/editor/static/base-map/` — `amsterdam-centre.pmtiles` (4.0 MB), `fonts/` (636 KB), `sprites/` (184 KB), `PROVENANCE.md`. Only the archive goes.
- `apps/editor/static/base-map/PROVENANCE.md` — must be rewritten: it currently documents a shipped archive.
- `scripts/check-base-map-catalog.mjs` — already fails `pnpm lint` if any module outside the catalog names an entry id or an archive. This is where the demo-bucket refusal goes.
- `apps/editor/src/service-worker.ts` — `BASE_MAP_DIRECTORY` and the `BASE_MAP` precache list. Read the comment on why it names a *directory* and not an archive: a fork that repoints its catalog keeps working, and a fork that points every entry at a remote archive simply finds this list empty. That design already anticipates this change.
- `apps/editor/src/lib/base-map/deployment-assets.ts` and `scripts/stage-viewer-bundle.mjs` — both name the same directory.
- `e2e/support/editor-deployment.ts` around the `.pmtiles` lookup — it finds "the `.pmtiles` archive in the directory" and serves it byte-range. This is where the Amsterdam extract goes on living.
- `apps/viewer/src/lib/ReaderMapPane.svelte` around line 88 — the check for whether a published site carries the Base Map's own files.

## Contract

**No `.pmtiles` file is shipped by either app.** `BUNDLED_ARCHIVE` is gone from the catalog.

**Glyphs and sprites keep shipping.** `@protomaps/basemaps` gates every label layer behind its `lang` option, and the service worker's own comment records the resulting bug: the archive was served, the style loaded, the map drew, and MapLibre silently fell back to system fonts because it could not fetch one glyph range — "loud enough to find only because it warns; silent in every assertion about the map." Those 820 KB are not optional.

**`scripts/check-base-map-catalog.mjs --deployment` fails while the catalog names `demo-bucket.protomaps.com`.** The message must say what to do: point the entry at an archive this deployment controls, which ADR-0020 makes a change to one line of one file. Ordinary development lint accepts the explicit temporary educational-development exception recorded below; production remains blocked.

**The Amsterdam extract moves to the e2e fixtures and stays there.** Several suites need real pmtiles bytes to assert anything, and `editor-deployment.ts` already serves them byte-range. It stops being shipped output; it is not deleted.

**`PROVENANCE.md` is rewritten** to describe what actually ships — glyphs, sprites, and their licences — plus the archive kept as a fixture and why. The ODbL, OFL, and BSD-3-Clause obligations do not lapse.

**The offline first-run state is named, not blank.** An installed app opened with no connection and no cached tiles must say so: there is no connection, so the Base Map cannot load yet, and everything else works — a Historical Map can be added now and placed when the connection is back. **Not a spinner, not an empty canvas.** This is a user's first contact with the application and a blank grey rectangle is the worst version of it.

**The Base Map switcher must still distinguish available-offline from needs-network** (ADR-0020). With no bundled archive every catalog entry needs the network until ticket 11 caches tiles, so the switcher's marking must be honest about that rather than silently claiming offline capability.

**SPEC story 69's claim is narrowed in the documentation, not quietly broken.** A user's Historical Maps, Alignments, and Annotations always work with no network; the Base Map works offline once that Project has been made available offline. ADR-0012 already carries this amendment — check that no user-facing copy still promises otherwise.

## Out of scope

- **Do not build the offline tile cache.** Ticket 11. This slice removes; that one adds.
- **Do not delete `BASE_MAP_CATALOG.initialView`.** Ticket 09 left it as the fallback for a Project with nothing placed.
- **Do not add a COOP/COEP service worker.** You will be in `service-worker.ts` and it will be adjacent. It is a site-wide restriction on how the page may load other origins' files, it risks referenced IIIF tiles and the Base Map archive, and it is a human's open decision. Leave it.
- **Do not change how styles or flavours are built.** The zero-extra-bytes property — several looks over one dataset — must survive untouched.
- **Do not bundle a smaller archive instead**, a world overview or otherwise. A global low-zoom extract is over a thousand tiles rather than the 43 that made Amsterdam 4 MB, and it was considered and declined.
- **Do not remove the `needsNetwork` flag** or the switcher's marking of it.

## Acceptance criteria

- [x] `apps/editor/build/` and the viewer bundle contain no `.pmtiles` file.
- [x] `apps/editor/build/base-map/fonts/` and `sprites/` are present.
- [x] `pnpm check:deployment` fails, naming the entries and remedy, while the catalog points at `demo-bucket.protomaps.com`; ordinary development verification passes under the recorded temporary exception.
- [x] The e2e suite still serves real pmtiles bytes from a fixture and every Base Map spec passes.
- [x] `PROVENANCE.md` describes only what ships, plus the fixture, and carries every licence obligation.
- [x] With the service worker in control, no connection, and a new Project, the Project screen shows a named explanation naming the absence of a connection — asserted on its text, not on the absence of a canvas.
- [x] In that state, adding a Historical Map from a file still works and the Layer appears.
- [x] The Base Map switcher marks every entry that needs the network as needing it.
- [x] No user-facing copy claims the Base Map works offline without the Project having been made available offline.
- [x] The three Base Map looks still resolve over one dataset with no extra archive.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
find apps/editor/build apps/viewer/build -name '*.pmtiles' | tee /dev/stderr | wc -l   # expect 0
ls apps/editor/build/base-map/fonts apps/editor/build/base-map/sprites               # expect contents
pnpm exec playwright test e2e/editor-base-map.e2e.ts e2e/editor-pwa.e2e.ts e2e/viewer-reader.e2e.ts
pnpm test:e2e
```

To prove the fence is not vacuous, point `REMOTE_ARCHIVE` back at `https://demo-bucket.protomaps.com/v4.pmtiles`, run `node scripts/check-base-map-catalog.mjs`, confirm it exits non-zero and names the remedy, then restore. Note that this repo has already shipped a fence that printed its success message unconditionally — assert the failing direction, not only the passing one.

## Blocked by

- Ticket 09

## Implementation notes

- Human decision, 2026-08-07: there is no Base Map hosting budget during educational development
  and evaluation. Retain `https://demo-bucket.protomaps.com/v4.pmtiles` temporarily; do not invent a
  replacement URL.
- The safeguard is a deployment fence: ordinary development verification remains green, while
  `pnpm check:deployment` refuses the demo bucket and names the remedy. Production deployment
  remains blocked until `REMOTE_ARCHIVE` points at an archive that deployment controls.
