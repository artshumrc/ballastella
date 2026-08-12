# A referenced Historical Map shows a picture from its Library

## What to build

A Historical Map whose tiles are on a Library's server shows a picture too, fetched from that Library —
one small request, not a download of the sheet. After this ticket the hub and the picker show a picture
for every Historical Map in the Workspace, however its tiles are held.

The picture is the same thing it is for a Workspace-held map: **the single tile at the coarsest level of
the pyramid.** The one input the Workspace does not currently record is the Library service's tile side,
so `remote.json` starts carrying it.

## Where to start

- `packages/core/src/remote-iiif/referenced-image.ts` — `ReferencedImage`, `ReferencedImageFields`,
  `referencedImage()`, `serialiseReferencedImage`, `parseReferencedImage`, and the `positiveInteger` /
  `text` helpers at the bottom. Read the doc comment above `ReferencedImage`: it explains why this record
  holds provenance that cannot be recovered once the remote resource is out of reach.
- `packages/core/src/remote-iiif/image-service.ts` — `RemoteImageService.tileSize` (*"Tile side in
  pixels, as the service declares it. Square, or `createImagePane` refused it."*). **This is the value to
  write; it is already in hand at add time and currently discarded.**
- The same file's `extendedTileset` and `chooseProbeTiles`, plus the comment above `extendedTileset`.
  Read them: together they are why a coarsest whole-image tile is **guaranteed servable** for every
  accepted referenced map. `createImagePane` requires the coarsest level to reduce the sheet to one tile,
  a service that declares no such level gets one synthesised, and the add-time probe **fetches that exact
  tile** before the resource is accepted. This ticket relies on that invariant rather than on a
  compliance level.
- `apps/editor/src/lib/remote-iiif/add-remote-map.svelte.ts` — `add()`, which builds the
  `ReferencedImage` from the accepted service.
- `packages/core/src/remote-iiif/service-uri.ts` — `canonicalServiceUri`. Already applied by
  `referencedImage()`, so a parsed record's `service` is canonical. **Do not re-normalise it and do not
  hand-trim slashes.**
- The resolver ticket 01 added in `packages/core/src/project/historical-maps.ts`, and the
  `MapThumbnail` component it added.
- `e2e/support/iiif-hosts.ts` — `requestedSize` and the `library.test` route. **The fixture already
  serves what this ticket needs**: it parses the full `{region}/{size}/0/default.jpg` form — four numbers
  then two — and answers with a generated gradient at exactly the requested size, i.e. real decodable
  bytes. It was built exact because the CORS probe refuses a tile whose decoded dimensions are not what
  was asked for. **No fixture extension is required.**

## Contract

**`remote.json` gains the service's square tile side.**

```
ReferencedImage gains:
  readonly tileSize: number    // the service's declared square tile side; 0 when unrecorded
```

- **Required, not optional.** Because `ReferencedImageFields` omits only the provenance fields, adding
  `tileSize` to `ReferencedImage` makes it required at every construction site and the compiler will
  find them all. **Do not add it to the `Partial<Pick<…>>` list to avoid that** — being forced to supply
  it at each site is the point.
- Written by `serialiseReferencedImage` along`width` and `height`.
- Read by `parseReferencedImage` through the existing **`positiveInteger`** helper, so a missing or
  malformed value becomes `0`.
- **It is provenance-grade, not address-grade.** Losing it costs a picture. Only a bad service URI costs
  the map — that asymmetry is stated in `parseReferencedImage`'s own doc comment and must not change.

**The resolver's referenced branch.** For a map whose `tileLocation` is `'referenced'`, the record is
already being read for its label. Build:

```
wholeImageDerivative(width, height, tileSize).url(service)
```

`null` when `tileSize`, `width`, or `height` is `0`. **The same function as the Workspace-held case** —
one derivation, two sources for its inputs.

**⚠ Never default `tileSize` to 256.** `PYRAMID_TILE_SIZE` is right there and 256 is the commonest value
a Library declares, which is precisely what makes defaulting dangerous: a service on 512 or 1024 px tiles
would get a URL at the wrong scale factor and render a broken box instead of an honest glyph. Absent
geometry means the glyph.

**⚠ Do not use `/full/!256,256/0/default.jpg`.** It is sharper and it 404s on a level-0 service, which
this app accepts whenever the declared pyramid is already deep enough — the `declared >= needed` early
return in `extendedTileset`. That population is not exotic: it is what this app itself writes and what
`libvips dzsave --layout=iiif` writes.

**The component's referenced path: a plain URL, no fetch, no blob.**

- The URL goes straight into `src`, with **`loading="lazy"`**.
- **No object URL and nothing to revoke.**
- **Do not route it through `session.imageServiceFetch()`.** The shim passes non-placeholder hosts
  through to the network, so this *would work* — and it would pointlessly buffer the bytes, discard the
  laziness, and hide the one real asymmetry in this feature.
- Laziness is for referenced maps **only**. For a Workspace-held map the bytes are already read by the
  time an object URL exists, so `loading="lazy"` there buys nothing and implies a saving that does not
  exist. Do not add it to both for symmetry.
- A failed load shows the same glyph as an absent one, via the element's `error` event. No message, no
  retry, no distinction between offline, 404, and a Library that has gone away.

### User Stories

Covers SPEC stories **9, 10, 12, 19, 24, 31**.

## Out of scope

- **Backfilling `tileSize` onto records written before it existed.** The application has never been
  deployed; re-adding the map is the whole remedy. **Do not add a refresh affordance, and do not fetch
  `info.json` on open to repair a record** — ADR-0010 forbids writing on open, and it would put a network
  request per map on hub load in an app whose suites ban the network.
- **The Offline Copy flip.** Ticket 04.
- **The Manifest's advertised `thumbnail` property.** Not captured, not used; the coarsest tile is the
  decision.
- **Warning the scholar that the hub now touches the network.** Decided against: ADR-0007's concern is
  copying a Library's bytes into the Workspace, not displaying what the Library publishes to be
  displayed. Do not add a notice, a setting, or an opt-in.
- **Anything about CORS.** An `<img>` needs no cross-origin readability, unlike the WebGL texture upload
  that forced ADR-0007's probe. Do not add a probe, and do not gate the picture on the existing one.
- **Changing what is accepted at add time.** No new refusal, no new guard, no change to
  `acceptRemoteImageService`, `extendedTileset`, or `chooseProbeTiles`.
- **Reporting a Library's failure as an outage.** One silent glyph.

## Acceptance criteria

- [ ] `serialiseReferencedImage` writes `tileSize`, and `parseReferencedImage` reads it back; a
      round-trip preserves it.
- [ ] A malformed or absent `tileSize` parses as `0` and does **not** throw — the map is still readable
      and still listed.
- [ ] Adding a Historical Map from a Library writes the service's declared tile side into `remote.json`.
- [ ] `listWorkspaceHistoricalMaps` sets `thumbnail` to the coarsest-tile URL on the Library's canonical
      service URI for a referenced map, and `null` when `tileSize`, `width`, or `height` is `0`.
- [ ] The existing test asserting `remote.json`'s exact serialised text is **extended** to cover the new
      field, not loosened, and passes.
- [ ] On the hub, a referenced Historical Map served by `library.test` shows a picture that has actually
      decoded: `naturalWidth > 0`.
- [ ] A referenced Historical Map whose record has no `tileSize` shows the glyph and no broken image.
- [ ] The referenced picture's element carries `loading="lazy"`; the Workspace-held one does not.
- [ ] `pnpm precommit` passes.
- [ ] A mutation record is written into this ticket.

```sh
pnpm --filter @ballastella/core test --project node -t "tileSize"
pnpm --filter @ballastella/core test --project node -t "thumbnail"
pnpm --filter @ballastella/core test --project node -t "referenced"

pnpm test:e2e editor-historical-map-thumbnails.e2e.ts
pnpm test:e2e editor-add-historical-map.e2e.ts

pnpm precommit
```

Success is exit code 0 from each. Read exit codes directly; no `grep`, and no `--reporter=…`.

### The mutation record

| Criterion | Mutation | Result |
| --- | --- | --- |
| the referenced picture actually decoded | change the scale factor so the URL names a tile the fixture will not serve at that size | expect red |
| geometry is read, not assumed | default `tileSize` to `PYRAMID_TILE_SIZE` when the record lacks it | expect red — the no-`tileSize` case must show the glyph, not a broken box |
| the tile side reaches the record | stop passing the service's tile side at add time | expect red |

⚠ **`loading="lazy"` will hang this assertion if the card is below the fold**, because the request never
fires and the test waits on an image the browser has declined to fetch. The card being in the viewport
must be **deliberate** — scroll it into view or size the viewport on purpose — not incidental to the
default window size. A test that passes only because the list happens to be short is a test that will
fail when someone adds a map to the fixture.

⚠ `toBeVisible()` passes for a broken image. Assert `naturalWidth`.

⚠ Asserting `src` against a computed string compares the computation with itself.

## Blocked by

- 01 — the resolver, the `thumbnail` field, and the component do not exist before it.
