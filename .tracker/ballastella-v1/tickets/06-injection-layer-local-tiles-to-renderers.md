# 06 — Injection layer: local tiles reach renderers

## What to build

The image pane stops reading a fixture from static assets and starts reading the pyramid the user just ingested. A user picks a local image, waits for it to be prepared, and then deep-zooms **their own map** in the app.

The problem being solved: **tiles in the store have no URL.** `<img src>` cannot reach them, MapLibre cannot fetch them, OpenSeadragon cannot fetch them.

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

- [ ] A locally ingested image renders in the image pane, read from the store, with no static-asset fallback
- [ ] Tiles at every `scaleFactor` load from the store, including ragged edge tiles
- [ ] `addProtocol` and `fetchFn` both resolve through the same `ProjectStore` → `Response` shim
- [ ] A request whose host is not `unset.invalid` passes through to the network unmodified
- [ ] A code path that constructs an `Image` without assigning `uri` produces a **clear, surfaced error** naming the missing override — not a silent blank map and not an unhandled rejection
- [ ] Ticket 03's projection round-trip assertions still pass against the fixture
- [ ] Switching between two ingested images in the same Project renders the correct pyramid for each
- [ ] `@allmaps/maplibre` is constructed with `fetchFn` supplied

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
