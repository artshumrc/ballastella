# Align a referenced Historical Map in place

## What to build

A Historical Map whose tiles are on a Library's server can be aligned without being copied first. The alignment view shows it in the same pane, with the same gestures, as a map whose tiles are in the Workspace.

Demonstrable end to end: add a remote IIIF map, click Align on its Layer, deep-zoom the sheet served from the Library, place Control Points, and see it draw warped on the Base Map — with no pyramid in the Workspace.

The gap this closes is narrow. `createImagePane(info, tiles)` **already** accepts an absolute base URI as well as `{ storedImageId }`, and the tile protocol is already generic over its injected `fetch`, which passes non-placeholder hosts straight to the network. One component hardcodes the local case.

## Where to start

- `apps/editor/src/lib/image-pane/HistoricalMapPane.svelte` — the one place to change. It always fetches `` `${imageServiceId(wanted)}/info.json` `` and always builds `createImagePane(info, { storedImageId: wanted })`.
- `packages/core/src/image-pane/iiif-image-pane.ts` — `createImagePane` and `ImagePaneTileBase = string | { storedImageId: string }`. Read its two guards: it refuses the `unset.invalid` placeholder passed as a string, and it refuses an image *id* passed where a base URI belongs. Both exist because those are the plausible slips.
- `apps/editor/src/lib/image-pane/tile-protocol.ts` — `registerImagePaneTiles(paneId, pane, fetchTile)`. Already source-agnostic; read the comment saying it cannot tell a fixture from a stored pyramid, which is the point.
- `@allmaps/iiif-parser`'s `getTileZoomLevels` — throws `"Image does not support tiles or custom regions and sizes."` for a level-0 service with no `tiles` and no arbitrary-region support. That throw is the refusal this ticket must surface at add time.
- The add flow from ticket 06, and `apps/editor/src/lib/remote-iiif/add-remote-map.svelte.ts` — where the CORS probe lives, and where the alignability probe joins it.
- `e2e/editor-remote-iiif.e2e.ts` and `e2e/editor-mirroring.e2e.ts` — each has its own routed fake-service host table and `json()` helper. Read both; they are being consolidated.
- `apps/editor/src/lib/pwa/installed-app.svelte.ts` — the app's one online signal. Do not add a second `online`/`offline` listener.

## Contract

**`HistoricalMapPane` takes where its tiles come from.** An `ImagePaneTileBase` prop, plus the `info.json` URL to read. For a Workspace-held map that is the placeholder and `{ storedImageId }`, exactly as now; for a referenced map it is the Library's service base and the service's own `info.json`. The pane must not decide this for itself — passing it in is what stops a future caller silently getting the wrong one.

**The refusal is decided when the resource is added, never when Align is clicked.** ADR-0007 already establishes the principle for CORS: probed at add time, not discovered at render time. Extend the same probe to **build the image pane**; if it throws, refuse the resource then, naming the host and the reason. A user must never be given a Layer with an Align button that leads to a screen which cannot work.

**Offline, before the pane exists: refuse to open, and name the host.** `info.json` is on the Library's server, so with no connection the pane cannot be built at all. `remote.json` carries width and height but **not** the tileset, so synthesising a pane from it is guesswork — do not.

**Offline, after the pane exists: keep working.** The pane's coordinate space is valid whether tiles arrive or not, so clicks stay geometrically correct over a blank pane. Show the offline notice, naming the host, and **do not block placing Control Points** — blocking would discard an alignment legitimately in progress, and the user can see perfectly well that the sheet has gone.

**A referenced map's Alignment records the Library's service as `resource.id`**, not the ADR-0004 placeholder. That is what makes the file resolvable by Allmaps (ADR-0007, SPEC story 60) and what makes the warped Layer render at all, since `@allmaps/maplibre` fetches tiles from that id. This is existing behaviour in `addReferencedMap`; authoring an Alignment for a referenced map must produce the same thing.

**The Layer card says when its map needs the network** — as text in the accessibility tree, not as a colour. Same treatment as the not-aligned state from ticket 05.

**Aligning looks identical either way.** No extra step, no different control, no "remote mode". If the two paths need different UI, something has been done wrong.

## Out of scope

- **Do not introduce a second image viewer.** triiiceratops is not the answer here: it cannot accept a custom OpenSeadragon `TileSource`, and it has no per-feature focusable overlay, which is the accessibility reason ADR-0005 chose the `overlayPoints` seam for every editable point in this application.
- **Do not attempt to cache remote tiles for offline alignment.** ADR-0012 fence 2: a partially cached remote pyramid renders *with holes*, which reads as corruption rather than absence.
- **Do not change the mirroring pipeline.** Making an offline copy of an aligned map already works — `#recordLocalCopy` re-serialises the Alignment through `serialiseAlignment(parseAlignment(...))`, which rewrites `resource.id` back to the placeholder. Ticket 11 owns where that action lives.
- **Do not remove the editor's unwarped view.** Ticket 15, deliberately after this one.
- **Do not add a second online/offline listener.**

## Acceptance criteria

- [ ] A remote level-2 IIIF image is alignable: the pane deep-zooms it, Control Points place, and the warped Layer reports tiles fetched **and decoded** on the Base Map.
- [ ] A remote level-0 image that publishes `tiles` is alignable the same way.
- [ ] A remote level-0 image with **no** `tiles` property is refused **when added**, with a message naming the host and the reason, and no Layer is created.
- [ ] A remote resource whose `info.json` is CORS-readable but whose tiles are not is still refused when added — the existing behaviour must not regress.
- [ ] No pyramid appears in the Workspace for a referenced map that has been aligned; `images/<id>/` holds `remote.json` and no tiles.
- [ ] The Alignment written for a referenced map carries the Library's service as `resource.id` and round-trips through `@allmaps/annotation` unchanged.
- [ ] With the network cut before opening the alignment view, it refuses to open and names the host.
- [ ] With the network cut *while* the alignment view is open, Control Points can still be placed, and an offline notice names the host.
- [ ] Making an offline copy of a referenced map that has been aligned in place keeps every Control Point and rewrites `resource.id` to the placeholder.
- [ ] The Layer card states in text that its map needs the network.
- [ ] The fake remote IIIF service lives in `e2e/support/` and is used by every spec that needs one, and its host table includes a level-0-without-`tiles` host.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
pnpm exec playwright test e2e/editor-remote-iiif.e2e.ts e2e/editor-mirroring.e2e.ts e2e/editor-warped-fetch.e2e.ts
pnpm test:e2e
```

All green, and **no spec may reach the internet** — every host routed, as both existing specs already guarantee.

The "tiles fetched and decoded" criterion must be asserted through `window.ballastellaLayerStack`'s per-Layer tile cache, as `e2e/editor-warped-fetch.e2e.ts` does. **A check for an absence of console errors is not acceptable**: the pre-patch `@allmaps/render` failure was a swallowed error, and a console-only check went green while the map rendered blank.

`createImagePane`'s three remote cases (level 2, level-0-with-tiles, level-0-without-tiles) belong in `packages/core/src/image-pane/iiif-image-pane.test.ts` as pure-function tests over captured `info.json` documents — that is what makes the add-time refusal decidable without a browser.

## Blocked by

- Ticket 06
