# A PWA with a narrowly scoped service worker and no silent activation

The authoring app ships a web app manifest and a service worker that precaches the app shell, making it installable and usable offline. Silent activation is disabled: no `skipWaiting`, and an explicit "Update available — reload" prompt.

Offline authoring is achievable rather than aspirational — storage is OPFS, and local tiles reach renderers without network via per-consumer injection (ADR-0011). And offline is the real use case: a scholar in a reading room or archive with hostile wifi is a primary user.

> **Narrowed by [ADR-0025](./0025-no-base-map-ships-offline-is-per-project-and-opt-in.md).** This paragraph originally claimed a bundled pmtiles extract as the base map. **No archive ships.** The honest claim is now: a user's map images, alignments, and annotations always work with no network; the **base map** works offline once that project has been made available offline, which caches the tiles its own content needs. One consequence lands on first contact: an installed app opened offline with a brand-new project has no base map, and that state must be named — "there's no connection, so the base map can't load yet; everything else works" — not left as a blank grey rectangle.
>
> ADR-0025 also requires `navigator.storage.persist()`, which belongs to this ADR's remit: it is called nowhere today, and installing the app is what usually grants it.

The only remaining network dependencies the user chose deliberately are referenced remote IIIF (ADR-0007) and remote base maps.

Installing also **fixes friction introduced by ADR-0001**. Chrome's persistent File System Access permission works best for installed PWAs, so "install this app" is the answer to "why does it keep asking about my folder?" The PWA is not decoration; it is the remedy for a cost the storage decision imposed.

ADR-0010 named a stale service worker as a version-skew vector, and that risk is handled by disabling silent activation. An explicit update prompt converts skew from invisible to visible, which is what ADR-0010's refusal path needs in order to function at all — silent activation is exactly how an old bundle quietly meets new data.

## Service worker scope fences

The default instinct is to cache everything; here that is a correctness bug, not merely waste.

1. **Precache only hashed build assets and the entry HTML.**
2. **Never cache project data.** It lives in OPFS. A Cache API copy would be a second source of truth competing with the store, and the two diverge the first time a user edits offline.
3. **Never cache remote IIIF tiles.** Referenced sources can be gigabytes, and the Cache API evicts unpredictably under quota pressure — producing a partially cached map that renders with holes.
4. **Never cache remote base map tiles**, for the same reason.
