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

- [x] A valid web app manifest exists and the editor is installable
- [x] A service worker registers and precaches hashed build assets and the entry HTML
- [x] The service worker caches **no** Project data, **no** remote IIIF tiles, and **no** remote Base Map tiles — asserted by inspecting cache contents after a full working session
- [x] `skipWaiting` is not used
- [x] A new service worker version does **not** activate silently; an update prompt appears and reload is user-initiated
- [x] After the prompt is dismissed without reloading, the old version continues serving
- [x] With the network disabled, the installed editor loads and a Project with a mirrored Historical Map and a bundled Base Map is fully usable: Control Points can be placed, Annotations drawn, and changes saved — **and the bundled Base Map is only usable because this ticket's own Out of scope was read narrowly. See [The bundled Base Map](#the-bundled-base-map-is-cached-and-that-needs-a-second-opinion).**
- [x] Offline, a **referenced** Historical Map shows a message naming its host and does not break the rest of the Project — with one limit of the test harness recorded below
- [x] The service worker does not intercept or serve `ProjectStore` reads
- [~] Installing the app makes the File System Access permission persist across sessions without re-prompting on Chrome 122+ — **not asserted, and not assertable here.** Installing needs a real user gesture in a real browser profile, and the persistent grant is a Chrome behaviour rather than one of ours: no Playwright context can install a PWA, and the folder suite already has to stub `showDirectoryPicker` because it opens an operating-system dialog. What is shipped is the offer, in the one place the question is asked, and it is asserted; the grant behind it needs a human on a real Chrome.
- [x] The update prompt is reachable and operable by keyboard and announced to assistive technology

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

## Implementation notes

### How offline is asserted

`e2e/editor-pwa.e2e.ts`, in a real Chromium, with `context.setOffline(true)` and then a whole
working session: a Project opened, its own pyramid decoded and drawn, three Control Point pairs
placed by clicking two MapLibre canvases, a fourth added, the warped Historical Map rendered over the
bundled Base Map, and an Annotation drawn on the Layers pane — with the Georeference Annotation and
the GeoJSON **read back out of OPFS** to prove they landed. `deployment.requests` is then read to
confirm the server heard nothing the app asked for across the whole session, which is what separates
"served from the cache" from "the offline flag did not take". The one exemption is
`service-worker.js`: Chromium checks for a new worker on navigation whatever the app does, and
Playwright's offline emulation does not cover a request the browser makes on its own behalf.

These tests bring their own static host (`e2e/support/editor-deployment.ts`) rather than using
`vite preview`, because two of the questions cannot be asked of a fixed directory at one path: ADR-0006
wants the same bytes served at a domain root *and* under a prefix, and an update is a change to what a
server hands out while a browser is already running. It resolves `/base-map` to `base-map.html`,
redirects `/base-map/` to the canonical URL, and byte-serves ranges — which is what GitHub Pages does,
and what the worker has to do offline.

### `start_url`, `scope`, and the two deployments

`start_url` and `scope` are both `"."` in `manifest.webmanifest`, and the manifest is linked with a
relative `href` (`asset('/manifest.webmanifest')`, which `paths.relative` makes page-relative in the
prerendered HTML). So the browser resolves both against the manifest's own URL, wherever that is. The
service worker is registered with `resolveDeploymentAsset('service-worker.js')`, and the scope a
browser derives from a script URL is that script's own directory — so resolving the URL relatively is
what scopes the worker to the deployment rather than to the origin.

Both are asserted at a domain root **and** at `/teaching/ballastella`, from the same build with no
reconfiguration: the resolved `start_url` and `scope` must equal the deployment's own URL, every icon
must resolve inside it and answer 200, `registration.scope` must equal it, and every cached URL must
begin with it. All three entry routes are then driven offline at both — a direct load at `start_url`
(which is what an installed app opens), a bookmark of `/base-map`, and a client-side link — plus the
trailing-slash spelling, which the worker answers with the redirect a static host would.

### The bundled Base Map is cached, and that needs a second opinion

**Two halves of this ticket disagree, and the disagreement was resolved by measurement rather than by
preference.** Out of scope says "Precaching a pmtiles Base Map on the fly. A bundled extract is a
workspace file (ticket 16), not a service-worker cache entry", and scope fence 1 says "precache only
hashed build assets and the entry HTML". Offline verification says the editor must, with the network
disabled, "open a Project, **view the aligned map**, place Control Points, **draw Annotations**, and
save", with "a bundled pmtiles Base Map"; ADR-0012 gives the same reason for believing offline is
achievable at all.

Measured with the archive left out: the MapLibre style never finishes loading, because a vector source
whose metadata never arrives is never `loaded()`, so `Map#isStyleLoaded()` stays false and `load` never
fires. `BaseMapPane` attaches the warped layer on `once('load')` and `drawLayerStack` is gated on
`isStyleLoaded()`, so **the warped Historical Map and the whole Layer stack — and therefore Annotation
drawing — are simply absent offline.** Control Point pairing survives, because a click on a canvas is a
coordinate whether or not a tile arrived. Leaving it out costs two of the four things Offline
verification names.

The reading taken is that "on the fly" is what that sentence turns on: what is out of scope is
accumulating base map data at runtime — fence 3 — and "a bundled extract is a workspace file (ticket
16)" is about the Published Site, where the extract really is a file in the user's Workspace. The
editor's own extract is same-origin, a fixed 4.9 MB, immutable per build, and this deployment's own
configuration (ADR-0020). It is in a **cache of its own**, `ballastella-base-map-<version>`, so that
`ballastella-shell-<version>` is exactly fence 1's list and reversing this judgement is deleting one
list and one branch.

**One thing must survive any reversal.** `Cache.match` ignores `Range`, and the archive is read
entirely by range. `pmtiles@4`'s `FetchSource` *rejects* a 200 whose content-length exceeds what it
asked for — "Server returned no content-length header or content-length exceeding request" — so a naive
precache of the archive breaks the Base Map **while online too**. The worker slices a 206 out of the
cached bytes, memoised because every tile is one request against the same several megabytes.

### What the service worker cannot cache, and what stops it

It imports `build`, `prerendered`, and `files` from `$service-worker` and takes: `prerendered` whole,
`build` filtered to `.js` and `.css`, and from `files` only what is under `base-map/`. Named as a
directory, not as an archive or a catalog entry id, so ADR-0020's "change the catalog and nothing
else" still holds and `scripts/check-base-map-catalog.mjs` stays satisfied.

That excludes, by construction: every OPFS path (Project data issues no HTTP request at all), every
cross-origin URL (the fetch handler returns before `respondWith` for them), `viewer-bundle/` — the
staged read-only viewer Publish writes into a Workspace — `fixtures/`, and both 5 MB copies of
`vips.wasm` that `build` carries. The last two are the ADR-0019 hole a precaching worker opens:
`check-viewer-deps.mjs` and `check-tiler-lazy.mjs` police what the viewer *imports*, and neither can
see what a worker *caches*. The suite asserts each cache's contents against its own rule and asserts
that nothing anywhere is a `.wasm`, a `viewer-bundle/` path, a `fixtures/` path, or a foreign origin.

The other half of ADR-0019 is that `apps/viewer` has no service worker at all, which the acceptance
command checks and which is why no Reader has a cache to fill.

### Story 9: an update never interrupts anybody

The worker never ends its own wait and never calls `clients.claim()`, so a page keeps the worker it
loaded under for the whole of its life. Nothing in the app reloads on its own. Asserted while
genuinely mid-alignment: two Control Point pairs made, a third pair half-made (the pending half exists
only in the page, so any reload at all destroys it), a mark written onto `window`, then a new version
published and discovered. The prompt appears; the mark is still there; the two rows and three points
are still there; the pending half is still pending; **focus is byte-identically where it was**; and
`navigator.serviceWorker.controller` is unchanged.

Dismissal is asserted against the artefact rather than against state: after "Not now" and a reload, the
newly published entry HTML's marker `<meta>` must be **absent**, which it can only be if the old worker
is still answering out of the old build's cache. Both builds' caches exist and the old one is not
empty.

**Taking the update drops the registration and then reloads, rather than reloading alone.** Measured in
this Chromium: with V1 active and V2 waiting, `location.reload()` leaves `active` at V1, `waiting` at
V2, and both caches in place — the reload's own navigation is answered by the old worker, so the client
is never released and Activate never runs. A "Reload now" button that did only that would be a lie. The
usual answer is the one call ADR-0012 forbids by name; dropping the registration achieves the same
outcome — the reload arrives uncontrolled and is therefore served the deployment's current bytes, and
the fresh registration installs and activates immediately. It needs the network for that one load,
which is why the button is disabled offline; a waiting worker exists only because the network delivered
it. Asserted end to end: after the click, the new build's marker is on the page and only the new
build's two caches remain.

### Two defects the harness found, and one flake investigated

- **`$service-worker`'s lists are file paths; a request carries a URL path.** The Base Map's glyph
  directories are named `Noto Sans Regular`, so comparing a list entry to `url.pathname` missed every
  one of them — and MapLibre's answer to a glyph range it cannot fetch is a `console.warn` and labels
  drawn in a local system font. The map looked right in every assertion. The offline test now watches
  the console for any message naming a Base Map file.
- **`editor-layers.e2e.ts`'s hanging-archive test was silently inverted** by this worker: it blocks the
  bundled pmtiles with `page.route`, which cannot see a request the worker answered from cache. It now
  blocks the service worker, which is also the case it can still reach — a first visit, and a
  `needsNetwork: true` entry the worker never caches.
- **`registration.active.state === 'activated'` is not "will control the next navigation".** Reloading
  in that window produces a page that is *permanently* uncontrolled, because the controller is assigned
  once when the document is created. It read as "the service worker did not install" and it was
  reproducible. `navigator.serviceWorker.ready` is the promise that means what is wanted.

### Recorded, not fixed

- **`navigator.onLine` cannot be driven across a reload in Playwright.** The emulation fires `offline`
  and flips `navigator.onLine` on a running page, but a page *loaded* while it is in force reports
  `true` — where a genuinely disconnected machine reports `false`. Both feed the same one signal, so the
  referenced-Historical-Map notice is asserted on the live transition, and the reload that follows
  asserts the half that matters most anyway: a Project holding a referenced Historical Map still opens
  and still works offline.
- **The first load of any visit is uncontrolled**, deliberately, because claiming a live client is the
  mid-alignment takeover story 9 rules out. So offline works from the second load onward — which for an
  installed application is its first launch, and for a browser tab is the first reload.
- **`wasm-vips` is not precached**, so preparing a *new* Historical Map needs the network on first use.
  ADR-0019 keeps the 5 MB module behind a dynamic import so it does not land in every page load;
  precaching it would reimpose that cost — twice, since Vite emits it for the worker as well — on
  everybody who installs the app.
- **`beforeinstallprompt` is synthesised in one test.** Chromium's install criteria include engagement
  heuristics no automated run satisfies. What is asserted is this app's handling of the event — that it
  is kept and shown as a button rather than prompted on arrival, which is ADR-0012's "do not nag" — and
  that is entirely ours. The fallback state, which is what every non-Chromium user sees, is asserted
  against the real browser.
- **`kit.serviceWorker.register` is `false`.** SvelteKit's own registration is an inline
  `navigator.serviceWorker.register(...)` that hands nothing back, so there is nowhere to attach the
  `updatefound` listener story 9 is made of, and recovering the registration afterwards races the update
  it exists to observe.

## Follow-ups

### A service worker *can* supply the COOP/COEP headers open question 3 is blocked on

**A finding, not a change.** Ticket 05 holds open question 3 because npm publishes only the threaded
`wasm-vips` build, which needs `SharedArrayBuffer` and therefore cross-origin isolation, and GitHub
Pages sends no COOP/COEP. Its option 2 is the `coi-serviceworker` pattern. Now that this ticket's
worker exists, that option can be assessed concretely.

Measured in the Chromium this repository drives, against a host sending **no** COOP and **no** COEP,
with a worker that re-serves navigation responses carrying `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: credentialless`:

| Document                       | `crossOriginIsolated` | `new SharedArrayBuffer(8)` |
| ------------------------------ | --------------------- | -------------------------- |
| first load (no controller yet) | `false`               | throws                     |
| once the worker controls it    | **`true`**            | **succeeds**               |

With ticket 05's own measurement — COOP `same-origin` + COEP `require-corp` and `Vips()` initialises,
libvips 8.18.3 — the mechanism is real, and the plumbing is small: this worker already answers
navigations from its own cache, so the headers are two lines in one function.

**It is still not an implementer's call, and there are two reasons a human may say no.**

1. **`require-corp` versus the unwarped viewer.** Under `require-corp` a cross-origin subresource must
   be CORS-fetched or carry `Cross-Origin-Resource-Policy`. Tiles that reach the renderer through
   `fetchFn` are CORS fetches and are fine; OpenSeadragon's default loader puts a URL into an
   `<img src>`, which is a no-cors load — this is stated in `UnwarpedView.svelte`'s own header — so a
   library that sends no CORP would stop rendering in the unwarped view, which is ticket 14's whole
   subject. `credentialless` removes that requirement and is what was measured above, and Safari does
   not implement it. SPEC story 4 makes Safari a first-class target.
2. **The pattern needs the app to reload itself on a first visit**, because a worker cannot add headers
   to a document it does not control and this one deliberately never claims a live client. That is
   survivable — the very first load has nothing open — but a page that reloads itself is the one
   behaviour story 9 argues against, and it deserves a decision rather than an implementation.

Ticket 05's option 1 — build a single-threaded `wasm-vips` and vendor it — needs no isolation, no
headers, and no interaction with this worker at all, and would leave the two objections above moot. The
choice between them is the human's.

### Smaller ones

- **The install offer is shown only where a folder Workspace is possible**, because its copy is about
  the folder permission, which is what ADR-0012 says the PWA is *for*. A Firefox or Safari user gets no
  install offer even though the offline shell would serve them equally well. Deliberate, and worth
  revisiting with copy that does not lean on the folder.
- **`base-map/PROVENANCE.md` is precached** along with the archive, glyphs, and sprites, because the
  rule is a directory rather than a list of extensions. Three kilobytes of licence prose, and arguably
  the right thing to carry with ODbL data; `stage-viewer-bundle.mjs` filters it out of a published
  Workspace, so the two now differ. Harmless, and stated so nobody has to re-derive it.
- **`resolveDeploymentAsset` lives in `$lib/base-map/`** and is now imported by publishing and by the
  PWA registration as well as by the Base Map pane. It is general ADR-0006 machinery and its home is
  misleading; moving it is churn this ticket did not want while another slice is in `apps/viewer`.
- **The update check when a tab is returned to is throttled to fifteen minutes** and is the only thing
  beyond the browser's own navigation check that will notice a new version. A scholar who leaves the
  app open for a day and never switches tabs will not be told. A longer-lived interval is a judgement
  about how much a background request is worth.
