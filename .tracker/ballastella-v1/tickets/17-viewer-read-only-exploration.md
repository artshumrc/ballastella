# 17 — Viewer: read-only exploration, base map switcher, unwarped view, responsive

## What to build

The read-only experience a Reader gets from a Published Site. They arrive at a hub page, open a Project, and explore it: toggling Layers, adjusting the opacity of an aligned Historical Map, clicking an Annotation to read its title and description, switching Base Maps, and opening a Historical Map on its own to read it as a document.

It reads well on a phone. Nothing can be edited.

**Fulfills** — [SPEC.md](../SPEC.md) user stories 70, 71, 72, 83, 84, 85, and 86, plus the Reader half of 82 and the viewer's case of 77. With ticket 04: 98 — the catalog supplies the high-contrast entry, this ticket makes a Reader able to choose it.

## Where to start

[ADR-0006](../../../docs/adr/0006-the-project-directory-is-the-published-site.md) (the HTTP `ProjectStore` adapter), [ADR-0020](../../../docs/adr/0020-base-map-catalog-author-default-and-reader-switching.md) (reader switching and persistence), [ADR-0014](../../../docs/adr/0014-v1-scope-fences.md) (authoring is desktop, **viewing is fully responsive**), [ADR-0009](../../../docs/adr/0009-annotations-use-simplestyle-spec.md) (sanitisation), [ADR-0016](../../../docs/adr/0016-daisyui-only-with-mandated-component-methods.md) (theme ships with the viewer).

The bundle and its placement come from ticket 16.

## Contract

**The viewer is the same reading code with a third `ProjectStore` adapter: HTTP `fetch` over relative paths.** OPFS, File System Access, and now HTTP — ADR-0001's abstraction paying out a third time. Do not write a parallel data layer.

`size` may be left unsupported on this adapter. Nothing a Reader does needs it — the hosting-limit warnings belong to the editor (tickets 15 and 16) — and implementing it would mean a `HEAD` request per file for no benefit.

**Nothing is editable.** No drawing tools, no Control Point manipulation, no writes of any kind. The viewer has no store `write`.

Reader capabilities:

- **Layer visibility and opacity**, honouring `order` and stacking across kinds (ticket 09). These are *view* controls: they must not attempt to persist to `project.json`, which is read-only over HTTP anyway — a naive reuse of the editor's controls would try, fail, and surface a confusing error.
- **Annotation popups** rendering `title` and Markdown `description`, using **ticket 10's sanitised renderer**. This is the highest-stakes reuse in the epic: the viewer runs on the user's own domain, and the Project may have arrived from someone else.
- **Base Map switching**, starting at the author's default from `project.json`, persisted in **`localStorage` keyed per site** so a preference on one scholar's site does not leak into another's. **Never** written to Project data.
- Entries with `needsNetwork: true` are **marked or disabled**, or a Reader on a plane selects satellite imagery and gets a blank map with no explanation.
- **Unwarped viewing** via triiiceratops (ticket 14) reading through the HTTP adapter.

**Responsive.** Authoring is desktop-only and that is settled, but published sites must read well on a phone, because that is where Readers are. This is the one surface in the epic with a genuine mobile requirement — a scholar shows this to colleagues and cites it, so it is what most people will ever see.

**Tracy's theme ships here**, not only in the editor (ADR-0016). One theme signal still drives both the UI and the Base Map flavor, so a dark UI never frames a white map.

Graceful degradation, since a Published Site is a snapshot that may outlive its authoring app:

| Condition | Behaviour |
|---|---|
| Referenced image whose host is unreachable | Say so, naming the host; keep the rest of the site working |
| Base map id absent from the bundled catalog | Fall back to the catalog default with a quiet notice |
| `formatVersion` newer than the bundle understands | Say so plainly rather than misrendering (ADR-0010) |

A missing or broken single Layer must never take down the whole Project view.

## Out of scope

- **Any editing.** No drawing, no Control Points, no writes.
- **Distortion overlay and the warped graticule.** ADR-0013 keeps the distortion toggle out of `project.json` precisely so a Published Site cannot load colourised; a deliberate "show distortion" exhibit is a plausible future feature and is not this.
- **Reader accounts, comments, or annotation submission.**
- **Search within a Project.**
- **The service worker** — ticket 18.
- **Editing the author's default base map.** Readers deviate for themselves; the author's default governs first contact.
- **Persisting reader preferences beyond base map choice.**

## Acceptance criteria

- [x] The hub page lists Projects and `?p=<dir>` opens one, served over plain HTTP with no server-side logic
- [x] The viewer reads exclusively through the HTTP `ProjectStore` adapter, and exposes no `write`
- [x] Layer visibility and opacity work and honour `order`, including an annotation Layer drawing above a map Layer
- [x] Changing a view control makes **no** write attempt and produces no error
- [x] Annotation popups render `title` and Markdown `description`
- [x] A `description` containing an XSS payload renders inert in the **viewer** — asserted here as well as in ticket 10, because this is the origin that matters
- [x] The Base Map starts at the author's default
- [x] Switching Base Maps works, persists via `localStorage`, and is restored on return
- [x] The `localStorage` key is per site: two Published Sites on different paths do not share a preference
- [x] Base Map choice is **never** written to Project data
- [x] Entries needing network are marked or disabled
- [~] A Historical Map opens unwarped via triiiceratops, reading over HTTP — **works, and only for a Project the author published with an address.** See "The unwarped view is limited by upstream" below.
- [x] The site is usable at a 375 px viewport width: no horizontal page scroll, controls reachable, popups readable
- [x] Tracy's theme is applied, and toggling theme changes the Base Map flavor in the same action
- [x] An unreachable referenced host, an unknown base map id, and a newer `formatVersion` each degrade with a clear message and do not blank the site
- [x] Every Reader control is reachable and operable by keyboard, and layer state changes are announced
- [x] A low-contrast-sensitive Reader can select a high-contrast or muted Base Map

```bash
pnpm -r build
pnpm test:e2e                    # served at root AND at a subpath; desktop AND 375px viewport
pnpm --filter @ballastella/core test    # HTTP adapter, per-site localStorage keying, degradation paths
pnpm lint && pnpm check

# the viewer must ship no write path
grep -rn "createWritable\|getFileHandle(.*create: *true" apps/viewer/src && echo "FAIL" || echo "OK: read-only"
```

Success: all exit 0 and the `grep` prints `OK: read-only`. The e2e suite must run the responsive assertions at a real 375 px viewport — a desktop-only run would pass while the phone experience, which is where most Readers arrive, stayed broken.

## Blocked by

- Ticket 16

## What was found while building this

### The unwarped view is limited by upstream, and it is the one criterion left `[~]`

**A Historical Map reads unwarped over HTTP, and it is asserted doing so — but only for a Project the
author published with an address** (the opt-in canonical stamp, SPEC story 92). For an unstamped
Project the page refuses with a sentence a Reader can act on rather than mounting a viewer that could
only draw nothing. Both paths are asserted in `e2e/viewer-reader.e2e.ts`.

Measured against `triiiceratops@1.0.0-rc.35` and the OpenSeadragon it bundles:

1. `getCanvasTileSources` turns a canvas's image service into the **string** `` `${serviceId}/info.json` ``
   (`dist/utils/resolveCanvasImage.js`). There is no path on which an inline service *object* reaches
   OpenSeadragon — which also means an embedded service entry of `{ id, type, profile }` produces **not one
   tile request**, silently, and the whole `info.json` has to be embedded for the document to be usable at
   all.
2. OpenSeadragon then builds every tile URL from `this._id = this['@id'] || this.id || this.identifier` —
   **the fetched document's own id**, not the URL it was fetched from. (The URL wins only when the document
   carries no `@context`, which a generated `info.json` always has.)

So a Published Site cannot redirect its own pyramid's tiles by describing it differently: whatever
`images/<image-id>/info.json` says its `id` is, that is where the tiles are fetched from. For a locally
ingested pyramid that is the ADR-0004 placeholder, and every request fails at DNS — measured, eight
`ERR_NAME_NOT_RESOLVED` with triiiceratops reporting "Image load aborted" per tile.

**This is the same missing upstream prop the editor's own `UnwarpedView` already records** — a
`TileSource` (or an `infoJson`) a host can pass in — and one upstream change closes both. A human's
options, none of which an implementer should pick:

- **Upstream it** (preferred, and it is our own package): triiiceratops accepts a tile source or an
  `infoJson` override. Ticket 19 is the precedent for how that is owned.
- **Have publishing resolve the address**, which is what `stampCanonicalUrl` already does — but make it
  automatic rather than opt-in, which is a change to ADR-0004's reasoning about what a published `id`
  means and to ADR-0006's "the address is unknown at build time".
- **Accept the limitation** and leave the refusal, which is what ships today.

### Two defects this ticket fixed in code it did not own

- **A Published Site with no bundled Base Map asked for it anyway.** Including the Base Map's 4.9 MB is
  opt-in at publish time (ADR-0020, SPEC stories 88 and 89), and a bundled entry's archive, glyphs, and
  sprites are all *site-relative* paths — so on a site published without them the viewer fired a pmtiles
  range request and two sprite requests at files that are not there: three 404s, a blank map, and no
  account of either. The pane now builds a bare style in that case and the page says why. Found by
  `e2e/editor-publish.e2e.ts`, which had asserted "nothing 404'd" since ticket 16 and only started
  failing once the viewer drew a map at all.
- **`stack-status`'s `data-drawn` counting Layers that have left the stack** was not inherited. The
  editor's `outcomes` merges over a `rendered` record it never prunes; the Reader's is built from the
  Layers currently shown, so hiding one removes it from the count. Asserted both ways.

### The HTTP adapter cannot pass ticket 02's shared suite, and that is recorded rather than worked around

27 of the suite's 30 tests either assert a write or use `store.write` to arrange their fixture —
including all four `listing` tests and both `size` tests — and `StoreUnderTest` requires three
write-shaped hooks. The three routes to a green suite are each worse than the honest answer; the
reasoning is at the top of `packages/core/src/store/http-project-store.test.ts`, along with why `list`
is **unanswerable** on a static host rather than merely unimplemented.
