# 06 — Injection layer: local tiles reach renderers

## What to build

The image pane stops reading a fixture from static assets and starts reading the pyramid the user just ingested. A user picks a local image, waits for it to be prepared, and then deep-zooms **their own map** in the app.

The problem being solved: **tiles in the store have no URL.** `<img src>` cannot reach them, MapLibre cannot fetch them, OpenSeadragon cannot fetch them.

**Fulfills** — [SPEC.md](../SPEC.md) user story 31, completing the projection work ticket 03 began. Also the mechanism behind story 8 (working with no network): local tiles reach the renderer without touching it.

## Where to start

[ADR-0011](../../../docs/adr/0011-local-tiles-reach-renderers-by-per-consumer-injection.md) (the whole slice) and [ADR-0004](../../../docs/adr/0004-image-service-base-url-is-resolved-at-load-time.md) (why the placeholder is the routing key).

The image pane and its tile-URL construction come from ticket 03; the pyramid and its placeholder `id` come from ticket 05.

Verified extension points:

```ts
// @allmaps/render — reachable as a public option on the MapLibre layer
type FetchFn = (input: Request | string | URL, init?: RequestInit) => Promise<Response>
new WarpedMapLayer({ fetchFn })

// MapLibre — the documented extension point; how pmtiles itself works
maplibregl.addProtocol(scheme, loadFn)
```

## Contract

**One shim, `ProjectStore` → `Response`**, used by every consumer. It keys on the placeholder base URL:

```
https://unset.invalid/<image-id>/...   →  read from the current Project's store
```

That is the second reason `.invalid` was chosen (ADR-0004, ADR-0011): a reserved TLD can never collide with a real host, so the routing rule needs no allowlist and can never accidentally capture a legitimate remote request.

Two consumers are wired here:

- **MapLibre raster sources** (the image pane's tiles) via `addProtocol`.
- **`@allmaps/maplibre`** via `fetchFn`, so warped rendering is ready for ticket 07. Wire it now even though nothing is warped yet — it is the same shim and doing it later means touching this code twice.

The OpenSeadragon `TileSource` is **not** in this slice (ticket 14).

**The invariant this slice must enforce and test: every code path that constructs an `Image` sets `uri` before requesting a tile.** SPEC calls this the most fragile invariant in the project. `Image#uri` is a plain public field, so the override is a single assignment — and a single assignment is exactly what gets forgotten on a new code path. Make the failure observable: a request that escapes to `unset.invalid` must be surfaced as a clear error, not swallowed.

A remote referenced image must keep working through the normal network path. The shim intercepts the placeholder host only; everything else passes through untouched.

## Out of scope

- **The OpenSeadragon `TileSource`** — ticket 14, with triiiceratops.
- **A service worker serving the store at a virtual path.** ADR-0011 rejects this: File System Access handle permissions have murky semantics inside a service worker, and that is the backend most users will have. Do not reintroduce it as a "cleaner" approach.
- **Warped rendering behaviour.** `fetchFn` is wired; no alignment exists yet.
- **Ticket 03's fixture.** Keep it — it remains the projection round-trip fixture and must not be deleted.
- **Blob URLs per tile.** Does not scale to a pyramid and creates revocation bugs.

## Acceptance criteria

- [x] A locally ingested image renders in the image pane, read from the store, with no static-asset fallback
- [x] Tiles at every `scaleFactor` load from the store, including ragged edge tiles
- [x] `addProtocol` and `fetchFn` both resolve through the same `ProjectStore` → `Response` shim
- [x] A request whose host is not `unset.invalid` passes through to the network unmodified
- [x] A code path that constructs an `Image` without assigning `uri` produces a **clear, surfaced error** naming the missing override — not a silent blank map and not an unhandled rejection
- [x] Ticket 03's projection round-trip assertions still pass against the fixture
- [x] Switching between two ingested images in the same Project renders the correct pyramid for each
- [x] `@allmaps/maplibre` is constructed with `fetchFn` supplied

```bash
pnpm --filter @ballastella/core test    # shim routing: placeholder captured, other hosts pass through
pnpm test:e2e                    # ingest → deep zoom own image; missing-uri error surfaces
pnpm -r build && pnpm lint && pnpm check

# no request should ever leave for the placeholder host
# (assert in Playwright via request interception; failing this is a hard fail)
```

Success: all exit 0, and the e2e suite asserts by request interception that **zero** requests are issued to `unset.invalid` during normal operation.

## Blocked by

- Ticket 03
- Ticket 05

## Comments

### Implementation, 2026-08-05

**Every acceptance criterion above is met and green.** The pane renders a pyramid that ticket 05's
tiler wrote, from the store, with zero requests to `unset.invalid` and zero to ticket 03's fixture.
`pnpm --filter @ballastella/core test` 472 passed, `CI=1 pnpm test:e2e` 78 passed with no retries,
`pnpm -r build && pnpm lint && pnpm check` all exit 0.

**But one of ADR-0011's three injection points does not carry bytes, and that needs a human. See
[The `fetchFn` injection point is broken upstream](#the-fetchfn-injection-point-is-broken-upstream).**

**How the two ADRs were reconciled, because they appear to disagree.** ADR-0004 says the placeholder
`id` must always be overridden and `createImagePane` refuses it as a base URI; ADR-0011 and SPEC say
the placeholder prefix *is* the routing key that every consumer matches on. Both are right, and the
resolution is that a stored pyramid's base really is `https://unset.invalid/<image-id>` — resolved,
at load time, to "the store". `createImagePane`'s second argument is therefore now
`string | { storedImageId }`: the string form is refused if it is the placeholder, exactly as before,
so a caller that passes `info.id` through still throws. Forgetting and choosing have the same *value*
and different *types*, which is the only way to keep the guard while allowing the local case.

**Where the invariant is enforced now.** With a shim installed, a placeholder URL is no longer a loud
failure — it is a store read, by design. So the "forgot the override" failure moves to the code path
that never got a shim, and `refuseUnroutedImageServiceRequests` wraps the global `fetch` in
`+layout.svelte` to catch it: a placeholder request that reaches the network is refused before it is
made, with a message naming `Image#uri` and both injection points. Without it the failure is
`TypeError: Failed to fetch` from a DNS failure, which ADR-0004 calls loud and which in fact names
nothing.

**Round-trip precision holds, against a store-backed pyramid.** Sampled at 8 800 points chosen off
the binary grid — the pitfall ticket 03's review recorded, where integers on a power-of-two window
come out exact and the measurement reads 0 while asserting nothing:

| Pyramid, read back through the shim | worst Δx | worst Δy |
|---|---|---|
| 700 × 500, scale factors 1–4 (written by `ingestImageFile`) | 2.32e-10 px | 2.32e-10 px |
| 60000 × 24000, scale factors 1–256 | 1.49e-8 px | 1.49e-8 px |

Against `ROUND_TRIP_TOLERANCE_PX` = 1e-6. The larger figure matches ticket 03's recorded 1.4e-8 at a
comparable window, so **this slice spent none of the headroom** — as expected, since where the bytes
come from does not enter the arithmetic. No tolerance was touched.

**What asserts the pane against a real pyramid, end to end.** `store-image-fetch.test.ts`'s last
describe runs `ingestImageFile` into a `MemoryProjectStore`, reads the resulting `info.json` back
*through the shim*, builds the pane on it, and fetches **every tile of every level** — asserting all
200 and that each tile's bytes are the ones the tiler wrote at that column and row, in both
directions. Not a fixture and not a hand-written `info.json`. The browser suite then adds what only a
browser can: every scale factor served with ragged tiles at both margins, and the two negatives.

### The `fetchFn` injection point is broken upstream

**`@allmaps/maplibre`'s `fetchFn` reaches a stored pyramid's `info.json` and cannot reach its
tiles.** This is a defect in `@allmaps/render@1.0.0-beta.83`, not in this repository, and there is no
workaround available here.

`WarpedMapLayer.onAdd` builds a `WebGL2Renderer`, whose tile factory is
`CacheableWorkerImageDataTile`. Its `fetch()` calls into a Comlink worker and passes `this.fetchFn`
**unproxied** — the abort callback in the very same argument list is wrapped in `Comlink.proxy()` and
this one is not — so `postMessage` refuses to clone it. A function cannot cross a structured-clone
boundary, so **nothing this repository could pass would work**: proxying it ourselves is not
possible from outside `@allmaps/render`, and would in any case return a proxied `Response` that
`createImageBitmap` cannot consume.

Measured 2026-08-05, Chromium 151, against a pyramid produced by the shipped `ingestImageFile` and a
four-point georeferenced map added through the dev route's test handle:

- `addGeoreferencedMap` **succeeds** and the layer reports bounds, so `info.json` was fetched through
  our shim on the main thread. That half of ADR-0011 holds.
- Every tile then fails with `DataCloneError: Failed to execute 'postMessage' on 'Worker'`, naming
  our own shim as the object that could not be cloned, at
  `CacheableTile.fetch → comlink apply → postMessage`. The errors are logged and swallowed by
  `@allmaps/render`, so the visible symptom is a **blank warped map with no error surfaced**.

`e2e/editor-warped-fetch.e2e.ts` asserts this deliberately, so the slice does not claim an injection
point that does not deliver bytes. **When that test starts failing, the upstream fix has landed** —
delete the expectation and assert the tiles instead.

**Why it needs a human, and what it touches.** ADR-0011 chose `fetchFn` over a service worker partly
because it "costs roughly a line", and rejected the service worker on File System Access permission
semantics. That trade now has a different price on one side. Options, none of which an implementer
should pick alone:

1. **Upstream a one-line fix** — wrap `fetchFn` in `Comlink.proxy()` in
   `CacheableWorkerImageDataTile.fetch`, or move the fetch out of the worker. Cheapest, and the
   maintainer-leverage argument ADR-0011 already makes for the OpenSeadragon `TileSource` applies
   here too. Needs an upstream release, which ADR-0010 makes a migration event.
2. **Vendor or patch `@allmaps/render`** (a `pnpm.patchedDependencies` entry) until that lands.
3. **Revisit the service worker** for the warped consumer specifically, accepting ADR-0011's stated
   risk on the File System Access backend.
4. **Warp from bytes we hand over ourselves**, if `@allmaps/render` offers a non-worker tile path —
   it does not appear to: the factory is a constructor argument to `BaseRenderer`, not an option.

**Ticket 07 is what this blocks.** It needs warped rendering of a locally stored pyramid, which is
precisely the path that does not work. The image pane, Control Point *pairing*, and everything
ticket 06 delivers are unaffected.

### Deviations and things worth knowing

- **`ProjectView` now hosts the image pane**, so story 31 is delivered on the user's own Project page
  rather than on a dev route. The Historical Maps list became one button per map; the existing
  ingest e2e still counts them as list items and reads the id from the button text, unchanged.
- **A dev route `/warped`** exercises `@allmaps/maplibre`'s injection point, in the same spirit as
  ticket 03's `/image-pane`. **Ticket 07 should absorb it into the Base Map pane** — a warped
  Historical Map belongs over geography, not on a bare map — and delete it.
- **`window.ballastellaServedTiles`** is a new browser-test handle, on the same terms as ticket 04's
  `ballastellaBaseMap`. It exists because this slice makes tiles **unobservable from outside the
  page**: up to ticket 05 "tiles at every scale factor load" was asserted on Playwright's `response`
  event, and a pyramid read from OPFS issues no request at all. Dropping the criterion was the
  alternative.
- **The injection layer imports `tiler/pyramid.js`** for the placeholder origin and `imageDirectory`.
  That is the pyramid *format*, not a tiler, and it brings no `wasm-vips` — verified: the
  viewer-manifest fence passes and `wasm-vips` is still absent from the built entry chunk. It is
  deliberate reuse for the same reason both sides use `getTileImageRequest`: a reader that computed
  paths itself could drift from the writer.
- **Three of the new browser tests first failed on the test's own assumptions**, and the comments say
  so where it would otherwise be rediscovered: Historical Maps list in image-id order rather than
  insertion order; a Project is selected client-side, so the hub's list items are still on screen for
  a moment after the click; and full-resolution map zoom is derived from the pyramid (13 here, 14 for
  ticket 03's fixture).
- **One flake was mine and is fixed, not absorbed.** Scale factor 2 was absent about one run in
  three, which looked like the pane failing to load a level. MapLibre never fetches a tile twice, so
  a served-tile log started *after* the pane had opened permanently lost the levels the opening view
  had visited. Logging now starts before navigation; `--repeat-each=6` at two workers passed 30 of
  30, and the full suite passed 78 of 78 with no retries. **The suite-wide flakiness the tracker
  records is a separate matter and was not observed in these runs.**
- **`pnpm test:e2e` was run with `CI=1` on the committed ports 4173/4174**, verified free before each
  run; `playwright.config.ts` is unmodified.
