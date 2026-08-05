# 18 — PWA: manifest, service worker, update prompt

## What to build

The editor becomes installable and works offline. A scholar in a reading room with hostile wifi opens the installed app and keeps aligning maps. When a new version is available they are told, and they choose when to reload.

**Fulfills** — [SPEC.md](../SPEC.md) user stories 6, 8, and 9. Story 6 is the remedy for the permission friction ticket 12 introduces; story 8's prerequisites are spread across tickets 04, 06, and 15, and this is where the whole claim is verified end to end.

## What this actually fixes

Offline is the real use case, and every other piece is already in place: storage is OPFS, local tiles reach renderers without network (ticket 06), and a bundled pmtiles extract provides a Base Map (ticket 04).

But the more immediate payoff is different: **installing fixes friction that ADR-0001 introduced.** Chrome's persistent File System Access permission works best for an installed PWA, so "install this app" is the honest answer to "why does it keep asking about my folder?" The PWA is not decoration; it is the remedy for a cost the storage decision imposed (ADR-0012).

## Where to start

[ADR-0012](../../../docs/adr/0012-pwa-with-explicit-update-prompt.md) (the whole slice), [ADR-0010](../../../docs/adr/0010-integer-format-version-with-forward-only-migrations.md) (a stale service worker is a named version-skew vector), [ADR-0011](../../../docs/adr/0011-local-tiles-reach-renderers-by-per-consumer-injection.md) (why the service worker does **not** serve the store), [ADR-0001](../../../docs/adr/0001-opfs-first-project-store.md) and ticket 12 (the permission interaction).

## Contract

A web app manifest plus a service worker precaching **the app shell only**.

### Four scope fences

The default instinct is to cache everything. Here that is a **correctness bug**, not merely waste:

1. **Precache only hashed build assets and the entry HTML.**
2. **Never cache Project data.** It lives in OPFS. A Cache API copy would be a **second source of truth** competing with the store, and the two diverge the first time a user edits offline. This is the most damaging thing this ticket could get wrong.
3. **Never cache remote IIIF tiles.** Referenced sources can be gigabytes, and the Cache API evicts unpredictably under quota pressure — producing a partially cached map that renders **with holes**, which reads as corruption.
4. **Never cache remote Base Map tiles**, for the same reason.

### No silent activation

**No `skipWaiting`.** An explicit "Update available — reload" prompt.

ADR-0010 named a stale service worker as a version-skew vector, and this is the mitigation. An explicit prompt converts skew from invisible to visible, which is what ADR-0010's `formatVersion` refusal needs in order to function at all — **silent activation is exactly how an old bundle quietly meets new data.** Getting this wrong reintroduces the failure the refusal path exists to prevent.

### The service worker does not serve the store

ADR-0011 rejected a service worker serving the project store at a virtual path, because File System Access directory handles have murky permission semantics inside a service worker — and that is the backend most users will have. **Do not reintroduce it here** on the grounds that a service worker now exists. Tile reads continue through `fetchFn` and `addProtocol` in the page.

### Offline verification

With the app installed, an OPFS workspace, a mirrored Historical Map, and a bundled pmtiles Base Map, the editor must load and be fully usable **with the network disabled**: open a Project, view the aligned map, place Control Points, draw Annotations, and save.

A referenced Historical Map naturally cannot render offline. It must say so, naming the host, and must not break the rest of the Project (the degradation contract from ticket 17).

## Out of scope

- **A service worker for `apps/viewer`.** Published Sites are visited over the network by Readers; offline reading is not a v1 goal, and a service worker on a user's own domain that they did not ask for is a support liability.
- **Background sync or push notifications.**
- **Precaching a pmtiles Base Map on the fly.** A bundled extract is a workspace file (ticket 16), not a service-worker cache entry.
- **Prompting installation aggressively.** Offer it where it answers the permission question; do not nag.
- **Serving the store through the service worker.** See above.

## Acceptance criteria

- [ ] A valid web app manifest exists and the editor is installable
- [ ] A service worker registers and precaches hashed build assets and the entry HTML
- [ ] The service worker caches **no** Project data, **no** remote IIIF tiles, and **no** remote Base Map tiles — asserted by inspecting cache contents after a full working session
- [ ] `skipWaiting` is not used
- [ ] A new service worker version does **not** activate silently; an update prompt appears and reload is user-initiated
- [ ] After the prompt is dismissed without reloading, the old version continues serving
- [ ] With the network disabled, the installed editor loads and a Project with a mirrored Historical Map and a bundled Base Map is fully usable: Control Points can be placed, Annotations drawn, and changes saved
- [ ] Offline, a **referenced** Historical Map shows a message naming its host and does not break the rest of the Project
- [ ] The service worker does not intercept or serve `ProjectStore` reads
- [ ] Installing the app makes the File System Access permission persist across sessions without re-prompting on Chrome 122+
- [ ] The update prompt is reachable and operable by keyboard and announced to assistive technology

```bash
pnpm -r build
pnpm test:e2e                    # install, offline session, update prompt, cache-content assertions
pnpm lint && pnpm check

# no skipWaiting anywhere
grep -rn "skipWaiting" apps/editor/src && echo "FAIL" || echo "OK: no skipWaiting"

# the viewer must have no service worker
test -f apps/viewer/src/service-worker.ts && echo "FAIL" || echo "OK: viewer has none"
```

Success: all exit 0 and both `grep`/`test` checks print their OK line. The offline test must run with Playwright's network genuinely disabled and must **exercise a write** — loading offline while silently failing to save would pass a weaker test and is precisely the failure a scholar in an archive would discover hours later.

## Blocked by

- Ticket 16
