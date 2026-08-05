# 04 — Base map pane: catalog, pmtiles, author default, theme signal

## What to build

A pannable, zoomable Base Map pane in the editor, with a switcher offering more than one Base Map. The Project remembers which one the author chose as the default. Switching the app between light and dark switches the Base Map's appearance with it.

**Fulfills** — [SPEC.md](../SPEC.md) user stories 68, 69, 72 (in the editor's switcher; the Reader side of 70–72 is ticket 17), and 100. With ticket 17: 98 — the catalog entry is provided here, the Reader-facing selection is there. Enables 88 and 101: pmtiles over Range requests needs no tile server and no API key.

## Where to start

[ADR-0005](../../../docs/adr/0005-maplibre-and-terra-draw.md) (MapLibre, pmtiles, Protomaps) and [ADR-0020](../../../docs/adr/0020-base-map-catalog-author-default-and-reader-switching.md) (catalog, default, id-not-URL).

Relevant packages:

```
maplibre-gl               registers the pmtiles:// protocol via addProtocol
pmtiles                   single-archive tiles over HTTP Range requests
@protomaps/basemaps       exports LIGHT, DARK, GRAYSCALE, WHITE, BLACK + namedFlavor
@allmaps/basemap          "Allmaps Basemap style for MapLibre"; pulls maplibre-contour
```

A `Flavor` is **a struct of colours per layer class** — `water`, `wood_a`, `wood_b`, `scrub_a`, `scrub_b`, `glacier`, `sand`, `beach`, `park_a`, `park_b`, `buildings`, `highway`, `railway`, `boundaries`, and many more. That is why a "streets" and a "physical geography" Base Map are **two style documents over one dataset**, costing no extra data.

## Contract

The **catalog is deployment configuration**, not Project data. Each entry:

```ts
type BaseMapEntry = {
  id: string            // stable; what project.json records
  label: string
  needsNetwork: boolean // pmtiles bundled in the workspace → false; remote → true
  // plus whatever the style needs to be constructed
}
```

`project.json` records **`baseMap: "<id>"` — a stable id, never a URL** (ADR-0020). This is the ADR-0004 discipline applied again: portable data records *intent*, never *addresses*. It matters more here, because a Base Map that fails to resolve renders a **plausible-looking but wrong map** rather than an obvious error.

An unknown id falls back to the deployment default and says so quietly. It must not throw and must not render a blank map.

Ship at least **two content-distinct variants over one pmtiles source** — one emphasising streets and labels, one emphasising water, woodland, sand, and glacier — to prove the zero-extra-data claim rather than assert it.

**One catalog entry must be high-contrast or muted.** `@protomaps/basemaps` exports `GRAYSCALE`, `WHITE`, and `BLACK` alongside `LIGHT` and `DARK`, so this is one more style document over the same source and costs nothing. It is not a nicety: ticket 17 has an acceptance criterion that a low-vision Reader can select such a Base Map, and without an entry here that criterion cannot pass.

**The catalog lives in exactly one module, and adding or removing an entry must require no change anywhere else.** That is the whole of what "the catalog is deployment configuration" means operationally, and it is what a forker pointing at their own tiles depends on.

**One theme signal drives both the UI and the Base Map flavor** (ADR-0016). A dark UI framing a bright white map is the most obvious way a themed app looks unfinished. There must be a single source of truth, not two independent toggles that happen to agree.

`needsNetwork` must be **used**, not merely stored: an entry requiring network is marked in the switcher. Ticket 17 relies on this for the published viewer.

## Out of scope

- **Reader-side base map switching and `localStorage` persistence** — ticket 17. Here the author picks a default and can preview switching; nothing is remembered outside `project.json`.
- **Authors curating which Base Maps appear.** They set the default only (ADR-0020, ADR-0014).
- **Hillshade and contours.** `@allmaps/basemap` pulls `maplibre-contour`, but a `raster-dem` source and a `hillshade` layer are not in v1.
- **The image pane** — ticket 03. Different pane, different coordinate system.
- **Warped map rendering.** No `@allmaps/maplibre` here.
- **Documenting how to produce a pmtiles extract.** Out of this epic; use any small regional extract as a fixture.
- **Control Points and drawing** — ticket 07.

## Acceptance criteria

- [ ] The Base Map pane renders, pans, and zooms
- [ ] At least two content-distinct Base Maps are offered and switching between them visibly changes the map
- [ ] Both variants are served from **one** pmtiles source, demonstrated by the network requests referencing a single archive
- [ ] A pmtiles archive is loaded via `addProtocol` and Range requests, from a static file with no tile server
- [ ] The author's choice is written to `project.json` as an id, and the file contains **no URL** for the base map
- [ ] Reopening the Project restores the author's default
- [ ] An unrecognised id in `project.json` falls back to the deployment default, renders a map, and surfaces a quiet notice — it does not throw or render blank
- [ ] Toggling the app theme changes the Base Map flavor in the same action, from one source of truth
- [ ] Entries with `needsNetwork: true` are visibly marked in the switcher
- [ ] The catalog carries a high-contrast or muted entry, selectable in the switcher
- [ ] Swapping the catalog module for a fixture with different entries changes the switcher and requires **no** change outside that module — the forkability property, asserted rather than intended
- [ ] The switcher uses a native `<select>` (ADR-0016) and is keyboard operable

```bash
pnpm --filter @ballastella/core test    # id→style resolution, unknown-id fallback
pnpm test:e2e                    # render, switch, theme coupling, network marking, persistence
pnpm -r build && pnpm lint && pnpm check

# one archive for both variants: expect exactly one .pmtiles URL
# (assert inside the Playwright test via request interception, not by eye)
```

Success: all exit 0, and the e2e test asserts by request interception that switching variants issues no request to a second `.pmtiles` archive.

## Blocked by

- Ticket 01

---

## Implementation notes

Recorded here because they are decisions and seams a reviewer needs, not defects.

### `maplibre-gl` is pinned to `^5`, not `^6`

Two reasons, both in the `pnpm-workspace.yaml` catalog comment. `@allmaps/maplibre` and
`@allmaps/basemap` peer on `^5`, and two MapLibre copies in one page is not a version warning but
a broken map — ticket 07 needs those packages. And v6 moved its worker into a sibling file whose
URL it computes from `import.meta.url` at runtime, which no bundler can see: with v6 the built app
404s on `maplibre-gl-worker.mjs` and the map never loads. v5 inlines the worker. This was found by
building and running, not by reading.

### `@allmaps/basemap` is not used

The ticket lists it as a relevant package. It is `1.0.0-beta.9`, pulls `maplibre-contour`, and
exists to add hillshade and contours — which this ticket puts out of scope — so it would be a
pre-1.0 dependency (an ADR-0010 migration event) bought for nothing. `@protomaps/basemaps` is used
directly instead, which is what `@allmaps/basemap` wraps.

### Seams left for ticket 02

Ticket 02 owns `project.json`, `ProjectStore`, and autosave; none of it existed in this branch.
Two places stand in for it, both marked in the source and both meant to be deleted:

- `apps/editor/src/lib/base-map/project-base-map.ts` — a `ProjectDefaultBaseMap` port with a
  read/write pair over the one field this slice needs, and a throwaway OPFS implementation. The
  write is read-modify-write over the whole document so existing keys survive, and it is **not
  atomic**: that is ADR-0017's rule and ticket 02's to implement. Pretending to implement it here
  would have been worse than leaving it visibly absent.
- `apps/editor/src/routes/base-map/+page.svelte` — reads `?p=<dir>` per ADR-0008 and otherwise
  falls back to a `demo-project` directory, so "reopening restores the default" is an assertion
  about a real file rather than about a variable.

The document written matches ticket 02's contract exactly: `{ formatVersion: 1, name, layers: [],
baseMap }`. The two pure functions the field goes through — `readBaseMapId` and `withBaseMapId` —
are in `core` and survive ticket 02 unchanged.

### The pane is its own route

`/base-map/` rather than a panel on the editor's home page, because tickets 02 and 03 were being
implemented in parallel and both own `routes/+page.svelte`. **Nothing links to it yet.** Ticket 07
composes the two panes; until then the route is reachable only by URL.

### The forkability property, and how far it is asserted

"Swapping the catalog module changes the switcher and requires no change outside that module" is
asserted as a composition of three things rather than by literally swapping the module in a second
build:

1. `resolve.test.ts` and `style.test.ts` drive resolution, the option model, and style construction
   from `FORKED_CATALOG` — different ids, labels, archives, flavors, view, and asset paths.
2. `scripts/check-base-map-catalog.mjs`, wired into `pnpm lint`, fails if any module outside the
   catalog names an entry id or an archive. Verified to fail on an injected violation.
3. The browser suite asserts the rendered `<select>` options are exactly this deployment's catalog.

Together: the switcher is `baseMapOptions(catalog)` and nothing else, and nothing else knows an id.
A literal swap would need a second Playwright project against a second build with an aliased
module, which SvelteKit's `vite preview` makes awkward (both builds share one output directory).
If a reviewer wants the literal form, that is the shape it would take.

### One assertion the browser cannot make

Arrow-key selection inside a focused native `<select>` is Chromium's own popup, which headless
Chromium does not run — pressing ArrowDown on a focused `<select>` changes nothing. So the
keyboard test asserts the tab order reaches the switcher and that the element is a native
`<select>` (which is *why* ADR-0016 mandates it), and leaves the popup to the platform.

### Bundled base map assets

`apps/editor/static/base-map/` carries a 4.1 MB Protomaps v4 extract of central Amsterdam, the
Latin glyph ranges for the three Noto Sans stacks the labels use, and the five flavor sprite
sheets — 4.8 MB in total. Provenance and licences are in `PROVENANCE.md` beside them and in
`THIRD-PARTY-NOTICES.md`. The glyphs matter more than they look: `@protomaps/basemaps` gates every
label layer behind its `lang` option, so "streets and labels" needs them bundled or it needs the
network, and needing the network for labels would quietly defeat story 88.
