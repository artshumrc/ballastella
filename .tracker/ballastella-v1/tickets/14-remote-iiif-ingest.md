# 14 — Remote IIIF ingest: triiiceratops browse, CORS probe, ids, community lookup

## What to build

A user pastes a IIIF URL — a Manifest, a Collection, or a bare image service — browses what is inside it, reads its metadata and rights, and picks the canvas that is the map. It becomes a Layer in their Project, referenced rather than copied.

If the Allmaps community has already aligned that map, they are offered the chance to import that Alignment instead of starting from scratch. They can also view any Historical Map on its own, unwarped, as a document rather than as geography.

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

- [ ] A Manifest URL, a Collection URL, and a bare `info.json` URL are each accepted and browsable
- [ ] A multi-canvas Manifest can be navigated and a canvas selected
- [ ] Metadata, rights, and attribution are shown during selection
- [ ] Only an image service **URI** crosses from triiiceratops to the alignment path — asserted at the boundary, with no parsed object passed
- [ ] A Historical Map can be viewed unwarped in triiiceratops, both for a remote resource and for a **locally ingested** pyramid via the `ProjectStore` `TileSource`
- [ ] A resource whose host omits CORS headers is rejected at add time with a message naming the host — and the rejection is triggered by the **tile** probe as well as the `info.json` probe
- [ ] A remote image's id equals `generateId(uri)` for its URI
- [ ] When the Allmaps API reports existing annotations, the count is shown and importing one produces a working Alignment
- [ ] The lookup discloses itself in the UI and can be disabled in settings; disabled, **no request is made** to `annotations.allmaps.org`
- [ ] A referenced image produces a Layer with `imageMode: 'referenced'` and renders from the remote host
- [ ] triiiceratops is imported from `./svelte`; the web-component export is not used
- [ ] Browsing, selection, and the import offer are reachable and operable by keyboard

```bash
pnpm --filter @ballastella/core test    # id generation, parser boundary, CORS probe logic, lookup parsing
pnpm test:e2e                    # browse, select, unwarped view, CORS rejection, lookup on/off
pnpm -r build && pnpm lint && pnpm check

# lookup disabled ⇒ zero requests to the Allmaps API (assert via request interception)
```

Success: all exit 0. The CORS test must use a fixture host that serves `info.json` **with** CORS and tiles **without** it — an implementation that probes only `info.json` passes a naive test and ships the blank-map failure this ticket exists to prevent.

## Blocked by

- Ticket 09
