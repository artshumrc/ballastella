# 09 — Rehouse the Base Map arithmetic and catalog claims to Seam 1

## What to build

`editor-base-map.e2e.ts` is 47 tests, and two large blocks of it are arithmetic and record-keeping driven through a browser:

1. **Offline Copy arithmetic** — that a city-centre Project at every zoom is tens of tiles and a few megabytes; that the whole fixture extent weighs what the compression decision says; that a tile file is written for every zoom from 0 to the source maximum; that an extent past the threshold is refused with the numbers and writes nothing; that a re-run fetches only the tiles not already present; that a second Project in the same area reports available offline without fetching; that a Project whose extent has grown reports not available.
2. **Catalog resolution and the author's default** — that the choice is written to `project.json` as an id with no URL anywhere in the file; that it is restored when the Project is reopened; that an unrecognised id falls back to the deployment default and says so; that an unrecognised id is left in `project.json` so moving the Project back restores it; that `updatedAt` is stamped because one write path owns the document.

Both belong at Seam 1. ADR-0020's whole point is that a Base Map is an **id**, never a URL — which makes this a question about a document, not about a map.

## Where to start

- `e2e/editor-base-map.e2e.ts` — the Offline Copy block and the "written to project.json" block.
- `packages/core/src/base-map/offline-cache.ts` / `offline-cache.test.ts` and `tile-cache.ts` / `tile-cache.test.ts` — where the arithmetic belongs, and where some of it may already be.
- `packages/core/src/base-map/project.ts` / `project.test.ts` and `resolve.ts` / `resolve.test.ts` — the author's default, and id-to-catalog resolution with fallback.
- `packages/core/src/base-map/fixture-catalogs.ts` — existing catalog fixtures to reuse.
- `e2e/fixtures/base-map/amsterdam-centre.pmtiles` — the 4 MB archive the Seam 2 tests serve. A Seam 1 test asking "how many tiles for this extent" should not need to read it; if it does, that is a hint the claim is really about the archive.

## Contract

- **What stays at Seam 2**: that the map *draws* across the extent with the archive unreachable, at the lowest zoom and the highest; that the OpenStreetMap attribution survives with the cache serving; that the switcher is within keyboard reach and the muted Base Map renders; that toggling the theme changes the flavor in the same action (ADR-0016). Those are the renderer.
- ⚠ **The Base Map outage-notice sequence stays at Seam 2 entirely** — the notice going up, coming down when the archive answers again, being withdrawn when the author switches, and not being shown when the archive answers. It is a real state machine over real network conditions, and asserting it against a fake would make it agree with itself. This is named because it *looks* like a pure state machine and is the tempting wrong turn in this file.
- A Seam 1 test that needs the real `.pmtiles` bytes to answer its question has probably not moved a claim; it has moved a browser test into Node. Say so and leave it.
- Every retired Seam 2 test names its replacement.

### User Stories

5, 9, 25, 26, 32.

## Out of scope

- The Place lookup block ("shows the candidates a query matched", the 429 handling, the live region, the attribution). It is its own surface (ADR-0029) and its own decision; `packages/core/src/places/` already has `lookup.test.ts` and `notice.test.ts`, but sequencing it here would make this ticket two tickets.
- Changing catalogs, thresholds, or anything in `core`'s Base Map modules.
- The Reader's half of the Base Map story — `viewer-reader.e2e.ts` is protected.

## Acceptance criteria

- [ ] Offline Copy tile counts, byte estimates, zoom coverage, the refusal threshold and the incremental re-run are asserted at Seam 1.
- [ ] The author's default, its restoration, the unrecognised-id fallback and the preservation of an unrecognised id are asserted at Seam 1.
- [ ] The outage-notice tests are untouched and still at Seam 2.
- [ ] Each new Seam 1 test is watched to fail once against a deliberate break.
- [ ] Every retired Seam 2 test is named alongside its replacement.
- [ ] `pnpm test:e2e editor-base-map.e2e.ts` passes; count and wall time recorded before and after.
- [ ] `pnpm precommit lint check test` passes.

```bash
pnpm test:e2e editor-base-map.e2e.ts
pnpm --filter @ballastella/core test
pnpm precommit lint check test
```

Success: the arithmetic asserts in milliseconds; the renderer and the outage state machine still assert in a browser.

## Blocked by

- 01
