# 14 — Remote IIIF ingest: triiiceratops browse, CORS probe, ids, community lookup

## What to build

A user pastes a IIIF URL — a Manifest, a Collection, or a bare image service — browses what is inside it, reads its metadata and rights, and picks the canvas that is the map. It becomes a Layer in their Project, referenced rather than copied.

If the Allmaps community has already aligned that map, they are offered the chance to import that Alignment instead of starting from scratch. They can also view any Historical Map on its own, unwarped, as a document rather than as geography.

**Fulfills** — [SPEC.md](../SPEC.md) user stories 16, 17, 18, 19, 20, 24, 25, 26, and 48. Sets `imageMode: 'referenced'`, the other half of what story 29 needs.

## Where to start

[ADR-0015](../../../docs/adr/0015-ingest-surface-ids-and-community-alignment-lookup.md) (ingest surface, ids, the lookup), [ADR-0007](../../../docs/adr/0007-remote-iiif-is-referenced-by-default-mirrored-on-request.md) (referenced by default; the CORS gate), [ADR-0018](../../../docs/adr/0018-triiiceratops-embedded-as-a-svelte-component.md) (how triiiceratops is embedded and the parser boundary), [ADR-0011](../../../docs/adr/0011-local-tiles-reach-renderers-by-per-consumer-injection.md) (the OpenSeadragon `TileSource`).

```
triiiceratops           import from ./svelte — NOT the web component
@allmaps/iiif-parser    Manifest | Collection | Image
@allmaps/id             generateId(uri) · generateRandomId()
@allmaps/stdlib         fetchAnnotationsFromApi(parsedIiif)
@allmaps/annotation     parse an imported Georeference Annotation
```

## Contract

### Accepted inputs

**Manifest, Collection, and bare image service `info.json`** — all three handled by one `@allmaps/iiif-parser` call. Collections matter more than they appear: a library hands a scholar *one* URL for an atlas, and without Collection support they must hunt for individual manifest URLs, which is the friction that makes people give up before aligning anything.

Deferred (ADR-0015): **IIIF Content State**, and **arbitrary non-IIIF image URLs** — CORS fails unpredictably there and the failure is indistinguishable from a broken link; the local-file path (ticket 05) covers that need reliably.

### triiiceratops

Imported from its **`./svelte` export as an ordinary Svelte component**, not as a web component. A custom OpenSeadragon `TileSource` must be passed in, which is natural as a prop and awkward as an attribute; web-component style isolation would also fight the theme (ADR-0018). Svelte 5 is a declared peer.

It owns Manifest and Collection navigation, canvas selection, metadata/rights display, and **unwarped viewing**.

**The parser boundary: triiiceratops selects; only an image service URI crosses.** Never a parsed object. The bundle carries two IIIF parsers — `manifesto.js` inside triiiceratops, `@allmaps/iiif-parser` in the alignment path — and this rule is what makes any disagreement between them invisible, because neither consumes the other's interpretation.

An **OpenSeadragon `TileSource` resolving through `ProjectStore`** is written here, so triiiceratops can display *local* pyramids too. Author it as an upstreamable plugin — it makes triiiceratops able to open local IIIF for everyone, not only this app (ADR-0011).

### CORS

**Probe at add-image time, not at render time.** `@allmaps/maplibre` uploads tiles into WebGL textures, requiring cross-origin-readable responses. Most IIIF servers send `Access-Control-Allow-Origin: *`, but not all, and **without it the map renders blank with no error** — unactionable for a humanities scholar and a support request for you.

Fetch **`info.json` *and one tile*** under CORS before accepting the resource. Reject with a diagnostic **naming the host**. Mirroring is not a workaround; it also has to fetch.

### Identity

- Remote → **`generateId(uri)`**. Not arbitrary: it yields *the same identifier Allmaps uses*, which is what makes the next section possible.
- Local → `generateRandomId()` (already in ticket 05).

### Community alignment lookup

`fetchAnnotationsFromApi(parsedIiif)`, parsed with `@allmaps/annotation`. Offer "Import existing alignment — 3 found." This delivers the authoring-versus-importing split: **authoring always happens in-app; importing an existing Alignment is a separate, cheap path.**

**The lookup is disclosed and switchable, on by default.** It is a network call to `annotations.allmaps.org` carrying a hash of what the user is looking at. For a tool whose premise is "your data stays in your folder," silently contacting a third party on every image add is a real contradiction — and for a scholar working on unpublished material, *which manifests this person is examining* is not nothing. Show a one-line note at the point of use ("checking Allmaps for existing georeferences") and provide a setting to disable it.

### Layer creation

A referenced remote image produces a `kind: 'map'` Layer with **`imageMode: 'referenced'`** (ticket 09's union). Tiles come from the remote host over the network; the injection shim from ticket 06 must pass those requests through untouched.

## Out of scope

- **Mirroring** — ticket 15. Reference only here.
- **Aligning a IIIF `Choice`.** Choice may be *viewed*; alignment operates on one selected image (ADR-0014).
- **Content State and non-IIIF image URLs.**
- **Time-based media.** triiiceratops does not support it either.
- **Cross-project search of ingested resources.**
- **Contributing alignments back to Allmaps.** Read-only interaction with their API.
- **Replacing `@allmaps/iiif-parser` with `manifesto.js` or vice versa.** Two parsers is the accepted decision; the URI boundary is the mitigation.

## Acceptance criteria

- [x] A Manifest URL, a Collection URL, and a bare `info.json` URL are each accepted and browsable
- [~] A multi-canvas Manifest can be navigated and a canvas selected — **selection is this app's own list of canvas buttons, not triiiceratops'.** See "triiiceratops owns unwarped viewing, not selection" below.
- [x] Metadata, rights, and attribution are shown during selection
- [x] Only an image service **URI** crosses from triiiceratops to the alignment path — asserted at the boundary, with no parsed object passed (`imageServiceUriCrossingBoundary`, asserted against a real parsed `Canvas`)
- [~] A Historical Map can be viewed unwarped in triiiceratops — **done for a remote resource; blocked upstream for a locally ingested pyramid.** See "the `ProjectStore` `TileSource` has nowhere to be passed" below.
- [x] A resource whose host omits CORS headers is rejected at add time with a message naming the host — and the rejection is triggered by the **tile** probe as well as the `info.json` probe
- [x] A remote image's id equals `generateId(uri)` for its URI
- [x] When the Allmaps API reports existing annotations, the count is shown and importing one produces a working Alignment
- [x] The lookup discloses itself in the UI and can be disabled in settings; disabled, **no request is made** to `annotations.allmaps.org`
- [x] A referenced image produces a Layer with `imageMode: 'referenced'` and renders from the remote host
- [x] triiiceratops is imported from `./svelte`; the web-component export is not used
- [x] Browsing, selection, and the import offer are reachable and operable by keyboard

```bash
pnpm --filter @ballastella/core test    # id generation, parser boundary, CORS probe logic, lookup parsing
pnpm test:e2e                    # browse, select, unwarped view, CORS rejection, lookup on/off
pnpm -r build && pnpm lint && pnpm check

# lookup disabled ⇒ zero requests to the Allmaps API (assert via request interception)
```

Success: all exit 0. The CORS test must use a fixture host that serves `info.json` **with** CORS and tiles **without** it — an implementation that probes only `info.json` passes a naive test and ships the blank-map failure this ticket exists to prevent.

## Blocked by

- Ticket 09

---

## Implementation notes

Status: **In Progress → needs review.** Everything is green (`pnpm --filter @ballastella/core test`
710 passed / 15 skipped; `CI=1 pnpm test:e2e` 131 passed; `pnpm -r build && pnpm lint && pnpm check`
all clean). Two criteria are `[~]` and both are recorded below with the measurement behind them.

### What was tested against, and what it found

`packages/core/src/remote-iiif/fixtures/real-world-image-services.json` holds **fourteen `info.json`
documents captured verbatim from live services** on 2026-08-06: the Library of Congress Geography
and Map Division (a real map sheet) and its World Digital Library service, Digital Bodleian, Harvard
IDS, Cambridge Digital Library, Stanford, Wellcome, e-codices, UB Leipzig, NYPL, Micrio (Rijksmuseum),
the IIIF Image API 3.0 and 2.1 reference examples, and the Bayerische Staatsbibliothek.
`live-services.test.ts` re-fetches all fourteen against the live internet under
`BALLASTELLA_NETWORK_TESTS=1` (15 assertions, all passing) so the corpus cannot quietly stop
describing reality.

**Neither of ticket 03's two guards was tripped by any live service.** No service in the corpus
declares a finest level other than 1, and none declares levels of differing tile sizes. Both guards
are held for shapes the Image API permits — the 3.0 specification gives the multi-tileset shape as an
example — and are asserted against synthetic documents *plus* a mutation test that feeds the same two
documents straight into `createImagePane`, so the guards cannot migrate into ticket 14's module and be
asserted twice over.

**A third assumption was tripped, by three of fourteen, and it is the main finding.**
`createSyntheticProjection` requires the coarsest level to reduce the whole image to a single tile.
Our own tiler satisfies that by construction; **real IIIF services routinely do not, and nothing in
the Image API says they must.** The IIIF cookbook reference example is 4032×3024 with 512px tiles and
scale factors 1, 2, 4 — a window of 2048px — so refusing the shape would mean refusing the
specification's own canonical example. `extendedTileset` handles it without relaxing anything: where
a service declares `supportsAnyRegionAndSize`, the missing coarser levels are appended and **every
guard then runs on the extended pyramid unchanged**. Where it does not (a level 0 pre-cut pyramid, for
which an undeclared tile really is a 404) it stays a refusal naming the host. Those synthesised levels
are this app's arithmetic rather than the service's declaration, so the CORS probe fetches one of them
before the resource is accepted — the claim is checked, not trusted.

Three other real-world behaviours the corpus surfaced, none of them predicted:

- **`ids.lib.harvard.edu` declares an `id` on a different host** (`mps.lib.harvard.edu`) from the URL
  it answers. The canonical URI is therefore the document's own, which is also what keeps
  `generateId` stable across the several URLs that redirect to one service.
- **e-codices and both Library of Congress services omit `tiles[].height`** — the ADR-0003
  non-square pitfall, in the wild. `@allmaps/iiif-parser` falls back to `height || width`.
- **`ids.lib.harvard.edu` reflects the request's `Origin` rather than sending `*`.** A probe that does
  not make a real browser CORS request sees no `Access-Control-Allow-Origin` and would wrongly reject
  it. `viewerd.kbr.be` goes further and allowlists one specific origin, which is a real host this
  gate would refuse.

### The exact-resize assumption for a third-party service: detect what is detectable, document the rest

`ImagePaneTile.placement` is `region ÷ scaleFactor`, correct only if `size=w,h` returns exactly w×h.
Ticket 05 asserts our own tiler honours it; a stranger's server cannot be asserted.

**Decided: detect the detectable half, at no extra cost, and write the residue down.** The probe tile
is chosen to be the *ragged* corner tile of the finest level — the only tile whose served dimensions
can disagree with what was asked for — and its **decoded** dimensions must equal the request, or the
resource is refused with the reason spelled out. That is one fetch, the same one the CORS gate needs,
and it catches every server that rounds, floors, pads to a whole tile, or substitutes a size.

What it cannot catch is a server returning the right dimensions having padded rather than resized
*within* them. Detecting that would mean decoding a full-resolution tile as well and comparing pixels,
per service, on every add — expensive, and a false positive on any lossily compressed tile. So it is
tolerated and recorded in `cors-probe.ts`: bounded at 0.6% of one tile along two margins of the sheet,
inside the same order as the JPEG noise the tiles already carry, and removed outright by "make an
offline copy", which re-cuts the pyramid with the tiler ticket 05 *does* assert exact-resize of.

### How a remote image is distinguished from a local one

`HistoricalMapSource` in `referenced-image.ts` is a discriminated union on ticket 09's `imageMode`,
and `tileBaseFor` is the single expression that turns it into ticket 03's `ImagePaneTileBase`:
`{ storedImageId }` for a local copy, the real service URI for a referenced one. Only a referenced
source carries a `service`, so "referenced, address unknown" is unrepresentable.

Asserted in four places:

1. **`createImagePane` itself.** Pass a local image's placeholder as a *string* base and it throws,
   naming the missing ADR-0004 override — so `tileBaseFor`'s two branches genuinely mean different
   things (`referenced-image.test.ts`).
2. **`createStoreImageFetch`'s pass-through**, against the base `tileBaseFor` produces, so a remote
   request reaches the network unmodified and a local one never does.
3. **`imageModeOf`**, so the Layer's `imageMode` is derived from the source rather than typed in
   beside a `service` nobody checked. Mutating it to `'mirrored'` turns the e2e Layer test red.
4. **`_everyImageModeHasASource`**, a compile error the day `ImageMode` gains a third member.

A referenced image's address lives in `images/<image-id>/remote.json`, beside where a local pyramid
keeps its own files — which makes ticket 15 a re-tiling job rather than a migration, keeps
`project.json`'s single writer single, and leaves ticket 09's Layer type untouched. That is not a
contradiction of ADR-0004: that ADR is about *our* tiles, whose address depends on where the Project
is published; a remote service's URI is the citation, and the citation is the intent.

### triiiceratops owns unwarped viewing, not selection

The Contract says triiiceratops owns Manifest and Collection navigation and canvas selection. As
shipped, it owns **unwarped viewing**; navigation, canvas selection, and the metadata/rights panel are
this app's own, built from `@allmaps/iiif-parser`'s parse and a list of ordinary `<button>`s.

Wiring selection through triiiceratops was attempted (`bind:viewerState`, an effect on
`viewerState.canvasId`, and a `selectCanvasId` that looks the canvas up in *our* parse so not even a
URI crosses from `manifesto.js`). It **raced**: triiiceratops auto-selects its first canvas
asynchronously, so an effect firing after the user's click reselected the title page and the wrong
image was added. Four of ten e2e tests went red, including the id/Layer test and the warped-render
test. Converging the two surfaces needs a two-way binding on `canvasId`, and triiiceratops' own source
carries a comment warning about "infinite loops when it auto-sets canvasId". Shipping a race in the
selection path at the end of a ticket is exactly the class of silent defect this epic keeps finding,
so it was reverted rather than shipped. **This needs a decision: either an upstream
`onCanvasSelected`-style callback, or accept the app's own list as the selection surface** — which is
also the keyboard and screen-reader path, since an OpenSeadragon gallery is a canvas and story 95 has
to be assertable.

### The `ProjectStore` `TileSource` has nowhere to be passed

`storedPyramidTileSource` in `packages/core/src/injection/openseadragon-tile-source.ts` is the ADR-0011
deliverable: duck-typed so core gains no `openseadragon` dependency, fetching through
`downloadTileStart` so the bytes come out of the store, and asserted against `planPyramid` and
`createImagePane` — every URL it asks for, at every level, is the same set the tiler wrote and the same
set the image pane reads.

**triiiceratops 1.0.0-rc.35 cannot accept it.** `TriiiceratopsViewer`'s props are `manifestId`,
`manifestJson`, `canvasId`, `plugins`, `theme`, `themeConfig`, `config`, `searchProvider`,
`viewerState`, `initialCanvasRegion`, `onpluginerror`, `onviewererror`. Its tile sources are derived
internally by `getViewerTileSources` and are always a URL string or `{ type: 'image', url }`; the
plugin API is for panels and flyouts; `config.openSeadragonConfig` reaches OpenSeadragon's
constructor, but the internal effect on `tileSources` calls `viewer.open()` and replaces whatever was
built. A stored pyramid has no URL, and OpenSeadragon's default loader puts `getTileUrl`'s answer into
an `<img src>`, which no `fetch` shim can intercept and which a service worker is the only other
answer to — rejected by ADR-0011 on File System Access permission semantics.

ADR-0018 anticipates this exactly: "any prop or plugin hook the integration needs is an upstream
change rather than a workaround." **The upstream change is a `tileSources` prop on
`TriiiceratopsViewer` that, when supplied, wins over the internal derivation.** Meanwhile a locally
ingested map is still readable unwarped in ticket 03's image pane, which draws it through the same
shim — so SPEC story 48 is delivered for both kinds of image, by two different viewers.

### Upstream defects found (all in pinned pre-1.0 packages)

1. **`@allmaps/iiif-parser@1.0.0-beta.48` — `getDefaultTileset` is one level short.** For a service
   that declares no `tiles`, it invents a 768px tileset with `Array.from({ length: maxExponent })`
   scale factors starting at 2⁰ — so the coarsest spans `768 · 2^(maxExponent-1)` and can never cover
   the image. Measured on `api.digitale-sammlungen.de` (4098×3109): it invents 1, 2, 4 → 3072px. The
   fix is `maxExponent + 1`. Worked around by `extendedTileset`.
2. **`@allmaps/stdlib@1.0.0-beta.41` — `fetchAnnotationsFromApi` fans out one third-party request per
   canvas on the ordinary case.** `annotations.allmaps.org/?url=…` answers **404** for a resource it
   has nothing for (measured 2026-08-06), `fetchJson` throws on a 404, and
   `fetchAnnotationsForManifest` catches that and loops over every canvas. A Collection is worse:
   every manifest, then every canvas of each. For a manifest nobody has georeferenced — the common
   case — one paste becomes one request per page of the volume, on the path ADR-0015 is explicitly
   worried about. Avoided here by looking up only the one image the user selected.
3. **`@allmaps/stdlib@1.0.0-beta.41` — `?url=${url}` is not encoded.** A IIIF URL containing `&` or
   `#` alters the API query. Not exploited here (the id is derived locally), but it is a real defect.
4. **`@allmaps/stdlib@1.0.0-beta.41` — `fetchUrl` calls `response.json()` on every non-ok response**,
   so a non-JSON error body produces a `SyntaxError` instead of the intended message.
5. **`triiiceratops@1.0.0-rc.35` — `manifestJson` is silently ignored without `manifestId`.** The
   effect is `if (manifestId && manifestJson)`, and the debug log that would say so is off by default
   in a production build. The observable result is a viewer that mounts its full chrome over nothing.
   Worked around by passing both.

### Also worth a reviewer's attention

- **A rights statement from a remote document was an XSS vector.** Svelte does not sanitise `href`, so
  `"rights": "javascript:…"` in a Manifest would have produced a link that ran script the moment a
  scholar clicked it to read the licence. `describeRemoteResource` now returns `rightsLink` as a
  separate field, http(s) only; the string still shows either way.
- **`showAlignment` gained a `service` parameter** (`apps/editor/src/lib/warped/warped-map-layer.ts`,
  ticket 09's file), because a referenced image handed the ADR-0004 placeholder parses, solves, reports
  a map id, and then asks the injection layer for a pyramid the Project does not contain. The layers
  pane derives the service from `imageMode`, and a referenced Layer with no record comes back `''` and
  is refused *visibly* rather than drawn from nowhere.
- **`serialiseReferencedAlignment` rewrites one field of `serialiseAlignment`'s output** rather than
  re-implementing it, so the Resource Mask's plain-decimal fix, the absent timestamps, and the
  byte-for-byte formatting all still come from the single writer that owns them. It throws if
  `target.source.id` is not where it expects, because the alternative is silently writing an
  unresolvable placeholder. `packages/core/src/alignment/**` was **not** touched (ticket 08 owns it) —
  a reviewer may reasonably want this folded into `serialiseAlignment` once ticket 08 lands.
- The e2e suite was developed on ports 4183/4184 via a config in the scratchpad, because sibling
  agents held 4173/4174 for most of the work. `playwright.config.ts` is unmodified and the final run
  was `CI=1 pnpm test:e2e` verbatim with the canonical ports free.
