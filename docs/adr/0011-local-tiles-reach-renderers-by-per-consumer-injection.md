# Local tiles reach renderers by per-consumer injection, not a service worker

Tiles in OPFS or a picked directory have no URL, and every renderer wants one. Each consumer gets its bytes through its own documented extension point, all backed by the same `ProjectStore`:

- **`@allmaps/maplibre`** — pass `fetchFn` to `new WarpedMapLayer({ fetchFn })`. This is a public, supported option; the type chain resolves `MapLibreWarpedMapLayerOptions → WebGL2RenderOptions → BaseRenderOptions → WarpedMapListOptions → WarpedMapOptions`, which declares `fetchFn?: FetchFn`, where `FetchFn = (input: Request | string | URL, init?: RequestInit) => Promise<Response>` — a `fetch` drop-in.
- **MapLibre's own sources** (including a bundled pmtiles base map, and the image pane's raster tiles) — `maplibregl.addProtocol()`, the documented extension point and exactly how pmtiles itself works.
- **OpenSeadragon inside triiiceratops** — a custom `TileSource` resolving tiles through a `ProjectStore`, authored as a triiiceratops plugin.
- **The published site** needs nothing: real HTTP, real URLs.

A service worker serving the store at a virtual path (`/__store/<project>/…`) is genuinely more elegant — one mechanism for everything, and unmodified third-party IIIF viewers would work untouched. It was rejected on a specific risk: **File System Access directory handles have murky permission semantics inside a service worker.** Handles are structured-cloneable and can be sent there, but the permission grant lives in the page's context and a service worker can outlive the page holding it. OPFS in a service worker is fine; the directory-picker backend from ADR-0001 is where this becomes uncertain — and that is the backend Chromium users will actually use, so the risk lands on the majority path.

Supporting reasons: two of the four consumers cost roughly a line each; there is no service-worker activation race, where the first read can happen before the worker controls the page; and there is no service-worker-versus-Vite-HMR friction, which would otherwise tax every day of development.

## Consequences

- **The placeholder base URL from ADR-0004 is the routing key.** `https://unset.invalid/<image-id>` is what `fetchFn` and the protocol handler match on to decide "this is a local read." A second reason the `.invalid` choice was right: it can never collide with a real host.
- Three mechanisms exist rather than one, and any future consumer needs its own injection point.
- We maintain a `ProjectStore`-to-`Response` shim that a service worker would have provided for free.
- The OpenSeadragon `TileSource` is the only substantial work, and it is where maintainer leverage pays off: it makes triiiceratops able to open local IIIF for everyone, not only for this app.
