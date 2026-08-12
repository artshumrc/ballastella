# A Workspace-held Historical Map shows its picture on the hub

## What to build

On the Workspace hub, every Historical Map whose tiles are in the Workspace shows a small picture of
the sheet beside its name. The picture is the **single tile at the coarsest level of the pyramid the map
already has** — nothing is generated, no file is written, and no ingest step is added.

A Historical Map that is referenced from a Library shows a neutral glyph for now; its picture is
ticket 03. A Workspace-held map whose geometry cannot be read shows the same glyph.

This slice establishes everything the later tickets reuse: the resolver in the domain layer, the
component, and both test seams.

Read `../SPEC.md` and `docs/adr/0030-a-historical-maps-thumbnail-is-its-coarsest-pyramid-tile.md`
first. Every decision below is already made; none of them is yours to revisit.

## Where to start

- `packages/core/src/tiler/pyramid.ts` — `pyramidScaleFactors` (the doubling that guarantees the
  coarsest level is one tile), `imageServiceId`, `imageSizeFromInfo`, `PYRAMID_TILE_SIZE`.
- `packages/core/src/tiler/image-manifest.ts` — `wholeImageDerivative(width, height, tileSize)`. **This
  is the function that computes the URL. Do not write a second one.** Its doc comment explains why
  `/full/max/` does not exist on a level-0 service.
- `packages/core/src/tiler/pyramid.test.ts` — the test named *"paints a body URL that the pyramid
  actually contains"* proves `wholeImageDerivative`'s output is a real tile path. Read it; it is the
  evidence this whole ticket rests on.
- `packages/core/src/project/historical-maps.ts` — `WorkspaceHistoricalMap` (the listing type),
  `listWorkspaceHistoricalMaps` (already reads `manifest.json` per map for the label), `tileLocation`,
  `readManifestLabel`.
- `apps/editor/src/lib/components/ProjectHub.svelte` — the "Historical Maps" section; the `{#each
  session.historicalMaps as map (map.imageId)}` list of daisyUI cards whose body is
  `card-body flex-row flex-wrap items-center justify-between`.
- `apps/editor/src/lib/editor-session.svelte.ts` — `imageServiceFetch()` returns the ADR-0011 shim.
  This is how the component gets bytes.
- `packages/core/src/injection/store-image-fetch.ts` — **read the file header before writing any
  code.** It states that `<img src>` cannot reach stored tiles and why a service worker is refused.
- `apps/editor/src/lib/historical-maps/` — where `AddHistoricalMap.svelte` lives; put the new component
  here.
- `e2e/support/historical-maps.ts` — helpers for driving the add-a-map dialog, including the
  `settle`/`ensureAddHistoricalMapOpen` discipline. Use them; the dialog's timing has already cost this
  suite a lot of flakes.
- `e2e/editor-workspace.e2e.ts` — the hub's existing spec. Read it for how a Workspace with maps in it
  is set up and reached, then put the new assertions in their own feature-scoped spec (the house style
  has both: `editor-workspace` by surface, `editor-offline-copy` and `editor-opening-view` by feature).
- `e2e/editor-image-ingest.e2e.ts` and `e2e/editor-layers.e2e.ts` — the latter has a `completedPyramid`
  poll for waiting until an ingest has actually finished. A thumbnail assertion made before `info.json`
  is written will be flaky, and this is the existing answer to that.

## Contract

**A new geometry reader in the tiler, beside `imageSizeFromInfo` and not replacing it.** The thumbnail
needs three facts from a stored `info.json`, and `imageSizeFromInfo` deliberately returns two — its
comment says so, and its narrowness serves the starter-Alignment path. Add a separate reader:

```
// null when the document does not carry all three as positive integers
imageGeometryFromInfo(info: unknown): { width: number; height: number; tileSize: number } | null
```

`tileSize` comes from the document's `tiles[0].width`. **Do not default it to `PYRAMID_TILE_SIZE`.** 256
is the value this app writes and would be right almost always, which is exactly what makes assuming it
a trap: a pyramid on another tile side would yield a URL at the wrong scale factor and a broken box.

**The listing type gains one nullable string.**

```
WorkspaceHistoricalMap gains:
  readonly thumbnail: string | null
```

`null` means "no picture is available" and is the only failure representation. There is no error field,
no reason string, and no second discriminator: **how the URL must be fetched is already answered by the
existing `tiles: TileLocation` field on the same record.**

**Resolution happens in `listWorkspaceHistoricalMaps`, not in the component.** For a map whose
`tileLocation` is `'in-workspace'`: read its `info.json`, run it through the new geometry reader, and
build the URL as

```
wholeImageDerivative(width, height, tileSize).url(imageServiceId(imageId))
```

For anything else in this ticket — a referenced map, or a document that will not yield geometry —
`thumbnail` is `null`.

**⚠ The base is always `imageServiceId(imageId)`. Never the `id` field of the stored `info.json`.**
After an opt-in canonical stamp that field holds the *published* address, so building on it would send
the editor to the internet for pictures of files it is already holding — silently working or silently
broken according to whether the site happens to be live. Take **only** `width`, `height`, and
`tiles[0].width` from the document.

**This costs one extra `read` per Workspace-held map** in a scan that already reads one per map. That is
accepted. It also means the existing test asserting the exact sorted set of paths
`listWorkspaceHistoricalMaps` reads will go red; **extend it to expect the new read** rather than
loosening it to a subset match.

**A new component, `MapThumbnail.svelte`, owning one job: turn a listing record into a picture.**

- Props: the `WorkspaceHistoricalMap` (or its `thumbnail` and `tiles`), and the shim from
  `session.imageServiceFetch()`.
- When `thumbnail` is `null`: render the glyph and do nothing else.
- When `tiles` is `'in-workspace'`: fetch the URL through the shim, **check `response.ok` before
  touching the body**, then `URL.createObjectURL(await response.blob())`. A missing tile answers with a
  non-ok response whose body would otherwise become a broken object URL that renders as an empty box.
- **Revoke the object URL when the component unmounts.** Not on a `setTimeout` — `save-file.ts` does
  that for a download and it is wrong here, because revoking while the element still needs the URL
  destroys the picture.
- The referenced branch is ticket 03's. Leave a place for it; do not implement it.

**Presentation, exactly.**

- A leading child of the existing `card-body` flex row, before the text block. **The card stays a row.
  Do not convert the list to a gallery grid.**
- A fixed box of about 96 px with `object-contain`. **Never `object-cover`** — a sheet's proportions are
  information, and cropping destroys them; a panoramic sheet legitimately reduces to a sliver.
- Explicit `width` and `height` attributes on the element, so cards do not shift as pictures resolve at
  wildly different times.
- `alt=""`. The map's name is immediately adjacent and no useful alternative text exists for a picture
  of a map; `alt="Thumbnail of …"` would make a screen reader say the name twice.
- A Lucide `map` glyph fills the box **from the first frame** and is replaced when an image decodes.
  `@lucide/svelte` is already a dependency of `apps/editor`; import the one glyph
  (`@lucide/svelte/icons/map`). There is no skeleton, no spinner, and no third state — loading, absent,
  and failed are one visual.
- **The picture is not interactive.** No link, no button, no click handler, no `tabindex`.

### User Stories

Covers SPEC stories **1, 2, 4, 5, 6, 7, 8, 11, 15, 16, 17, 18, 20, 21, 22, 23, 25, 26, 27, 28, 29, 30,
32, 33, 34**.

## Out of scope

- **The picker in `AddHistoricalMap.svelte`.** Ticket 02. Build the component so it can be dropped in
  unchanged, but do not drop it in.
- **Anything about referenced maps.** No `tileSize` on `remote.json`, no Library URL, no
  `loading="lazy"`. Ticket 03. Referenced maps show the glyph after this ticket and that is correct.
- **A service worker.** `store-image-fetch.ts`'s header ends *"Do not reintroduce it as the cleaner
  approach."* You will hit the "`<img>` cannot reach OPFS" wall; the object URL is the way through.
- **A second path resolver.** Do not build `images/<id>/…` anywhere. `scripts/check-workspace-rooted-paths.mjs`
  is in `pnpm lint` and its header explains why the failure mode it guards is invisible.
- **Widening `imageSizeFromInfo`.** Add a reader beside it.
- **Writing a `thumbnail.jpg`, at any size, at ingest or anywhere else.**
- **Touching the tiler, `planPyramid`, `wholeImageDerivative`, or `buildImageManifest`.** They already
  do everything needed. If you find yourself editing them, stop and re-read the ADR.
- **The Layer sidebar in `ProjectScreen.svelte`.** It lists Layers and is a different question.
- **`apps/viewer` and anything published.** Its hub lists Projects and never Historical Maps.
- **`CONTEXT.md`.** Deliberately unchanged; the reasoning is in the SPEC's Further Notes.
- **Reporting a missing tile as an outage.** ADR-0028's residual is recorded, not closed.

## Acceptance criteria

- [ ] `imageGeometryFromInfo` returns width, height and tile side from an `info.json` this app wrote,
      and `null` when any of the three is missing or is not a positive integer.
- [ ] `listWorkspaceHistoricalMaps` sets `thumbnail` to the coarsest-tile URL on the
      `https://unset.invalid/<imageId>` host for a Workspace-held map, and `null` for a referenced one.
- [ ] `listWorkspaceHistoricalMaps` sets `thumbnail` to `null` for a Workspace-held map whose
      `info.json` will not yield geometry, and still lists the map.
- [ ] The URL is built on `imageServiceId(imageId)` even when the stored `info.json` carries a stamped
      absolute `id` — asserted with a document whose `id` is an unrelated `https://example.test/…`.
- [ ] The existing assertion on the exact set of paths `listWorkspaceHistoricalMaps` reads is extended
      to include the new `info.json` read, and still passes.
- [ ] On the hub, a Historical Map added from a file shows a picture that has actually decoded:
      `naturalWidth > 0`.
- [ ] On the hub, a referenced Historical Map shows the glyph and no broken image.
- [ ] `pnpm lint` passes, including `check-workspace-rooted-paths.mjs` and the e2e network fence.
- [ ] `pnpm precommit` passes.
- [ ] A mutation record is written into this ticket (see below).

```sh
# Domain layer, Node seam. Run by spec name, never by file:line.
pnpm --filter @ballastella/core test --project node -t "thumbnail"
pnpm --filter @ballastella/core test --project node -t "imageGeometryFromInfo"

# Browser seam. Create e2e/editor-historical-map-thumbnails.e2e.ts and take `test` from
# e2e/support/network-fence.ts, or scripts/check-e2e-network-fence.mjs will fail the lint.
pnpm test:e2e editor-historical-map-thumbnails.e2e.ts

# Everything, cheapest first.
pnpm precommit
```

Success is exit code 0 from each. **Read the exit codes directly. Do not pipe any of these through
`grep`, and do not pass `--reporter=…` to `test:e2e`** — it replaces the whole reporter list and
silently drops the retry budget.

### The mutation record

Mandatory, and the first row is the one this ticket exists to prove. Fill in and leave in the ticket.

| Criterion | Mutation | Result |
| --- | --- | --- |
| the picture actually decoded | change the coarsest scale factor (e.g. halve it) so the URL names a tile that was never written | expect red — **and if it stays green, the assertion is `toBeVisible` or an attribute check, not `naturalWidth`** |
| the URL is built on the placeholder host | build it from the stored `info.json`'s `id` instead of `imageServiceId(imageId)` | expect red |
| geometry is read, not assumed | default the tile side to `PYRAMID_TILE_SIZE` instead of reading `tiles[0].width` | expect red against a pyramid on another tile side |

⚠ **`expect(img).toBeVisible()` passes for a broken image.** An `<img>` that 404s is visible and laid
out at its attribute dimensions with no pixels in it. There is **no precedent for `naturalWidth` in
this suite**, so it will not be copied from a neighbouring spec — write it deliberately.

⚠ **Do not assert that `src` equals a string you have just computed.** That compares the computation
with itself and passes however wrong the arithmetic is. Assert that the image decoded.

## Blocked by

None - can start immediately.
