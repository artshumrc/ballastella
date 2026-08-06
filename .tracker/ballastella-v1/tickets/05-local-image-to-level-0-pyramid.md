# 05 — Local image to level-0 pyramid

## What to build

A user picks an image file from their computer. The app converts it to a level-0 IIIF pyramid with an `info.json` and a IIIF Presentation manifest, writes it into the Project, and shows progress while it works. A very large scan succeeds rather than being rejected.

This slice also settles two facts nobody can guess: **where the decode ceiling actually falls per browser** (which sets the streaming-tiler threshold), and **whether our generated `info.json` is accepted by Allmaps end to end**.

**Fulfills** — [SPEC.md](../SPEC.md) user stories 21, 22, and 23.

## Where to start

[ADR-0003](../../../docs/adr/0003-every-image-is-tiled-client-side.md) (the whole slice) and [ADR-0004](../../../docs/adr/0004-image-service-base-url-is-resolved-at-load-time.md) (the placeholder `id`).

Read this before writing code, because it is why there is no shortcut for small images: `@allmaps/iiif-parser` computes `tileZoomLevels` in the **`Image` constructor**, and `lib/tiles.js#getTileZoomLevels` throws `'Image does not support tiles or custom regions and sizes.'` when there is no valid `tiles` array and the profile is level 0. `@allmaps/render` reads only `tileZoomLevels`, never `sizes`. **An untiled level-0 image cannot even be parsed.** Every image gets a pyramid, including a 2 megapixel phone photo.

The store interface comes from ticket 02.

## Contract

One contract, two implementations: **`ImageSource → level-0 pyramid in the ProjectStore`.**

```
images/<image-id>/info.json
images/<image-id>/manifest.json
images/<image-id>/<region>/<size>/0/default.jpg
```

**Decode-and-crop** — the default, zero bundle cost:

```js
createImageBitmap(blob, sx, sy, sw, sh)   // crop rect, per tile
  → one tile-sized OffscreenCanvas → convertToBlob()
```

Canvas **area** limits never bind, because no canvas ever exceeds one tile — which matters because Safari's limit can be as low as 5,242,880 px. The binding constraint is full-image **decode memory**, roughly 4 bytes per pixel.

**Streaming** — `wasm-vips`, **lazily loaded** only above the measured decode ceiling. Use the **single-threaded build**: the threaded build requires COOP/COEP cross-origin isolation headers that GitHub Pages cannot set, which would break "anyone can fork and host their own instance."

Non-negotiables:

- **Tiles are square.** `getTileZoomLevelFromScaleFactor` does `const height = tileset.height || tileset.width`, so omitting `height` from `info.json` is only a bug for non-square tiles. Square tiles sidestep the pitfall the Berckenrode project documents.
- **Use `getTileImageRequest(zoomLevel, column, row)` to decide what to write.** Ticket 03's reader already uses it. Same function on both sides means reader and writer cannot disagree.
- **`info.json` is written with `id: "https://unset.invalid/<image-id>"`** (ADR-0004). It must satisfy `id: z.string().url()`. `.invalid` is reserved by RFC 2606 so DNS always fails — a forgotten override fails loudly instead of silently fetching from a wrong host. **Do not use a `urn:`**; it parses under some zod versions and not others.
- **Local images get `generateRandomId()`** from `@allmaps/id`. `generateId(uri)` is for remote resources and belongs to ticket 14.
- **Ingest is a job with progress, not a function call.** Even small files.

`wasm-vips` requires an entry in `THIRD-PARTY-NOTICES.md`: the wrapper is MIT, the artefact is compiled **libvips, LGPL-2.1-or-later** (ADR-0021). Ticket 01 pre-seeded this; verify it is accurate now that the dependency is real.

**Record the measured decode ceiling** — the number, the browser, and the method — somewhere durable. Later work depends on it and it cannot be re-derived from the code.

## Out of scope

- **Remote IIIF ingest** — ticket 14. This slice handles local files only.
- **Mirroring a remote image** — ticket 15, which reuses this contract.
- **Reading these tiles back through renderers** — ticket 06. Verify output by inspecting store contents and by feeding `info.json` to `@allmaps/iiif-parser` directly.
- **A `sharp` CLI for images that defeat even streaming.** ADR-0003 makes this prose in the docs, not code we ship.
- **Alignment.** No Control Points here.
- **Emitting `sizes` and hoping it helps.** It does nothing; see above.

## Acceptance criteria

- [x] A local image becomes a complete pyramid plus `info.json` and `manifest.json` in the store
- [x] The generated `info.json` constructs a `@allmaps/iiif-parser` `Image` **without throwing**
- [x] For every zoom level, column, and row, the tile written is exactly the tile `getTileImageRequest` describes — asserted exhaustively over a fixture, not sampled
- [x] Tiles are square and edge tiles are correctly truncated at the right and bottom margins
- [x] `info.json` has `id === "https://unset.invalid/<image-id>"` and passes `z.string().url()`
- [x] A small image (≈2 MP) is tiled, not shortcut
- [x] An image above the measured decode ceiling routes to the streaming tiler and produces output **byte-comparable in structure** to the decode-and-crop path (same paths, same tile geometry) — asserted, but **the streaming tiler cannot run in a browser on a static host**; see [The streaming tiler cannot run where ADR-0003 needs it to](#the-streaming-tiler-cannot-run-where-adr-0003-needs-it-to)
- [x] `wasm-vips` is not in the initial bundle — it is fetched only when the streaming path is taken
- [x] Progress is reported for both paths and for small files
- [x] The measured decode ceiling is recorded with browser and method
- [x] `THIRD-PARTY-NOTICES.md` carries an accurate libvips/LGPL entry — corrected; it was wrong twice
- [x] The generated `info.json` and pyramid are confirmed to load in **Allmaps' own viewer** (manual check; record the outcome)

```bash
pnpm --filter @ballastella/core test    # tile geometry, info.json validity, parser construction
pnpm test:e2e                    # file pick → progress → store contents; lazy wasm-vips
pnpm -r build && pnpm lint && pnpm check

# confirm wasm-vips is not eagerly bundled
grep -rl "wasm-vips" apps/editor/build/_app/immutable/entry/ && echo "FAIL: eager" || echo "OK: lazy"
```

Success: all exit 0 and the `grep` prints `OK: lazy`. The Allmaps-viewer check is manual; its outcome is recorded in the ticket before closing, because ADR-0003 requires validating the format before anything is built on top of it.

## Blocked by

- Ticket 02

## Outcome

Implemented. Every acceptance-criteria command passes, and both of the slice's named risk items
were settled by measurement rather than by inspection. **One thing needs a human**, and it is
structural rather than a defect in this work: see the last section.

New code: `packages/core/src/tiler/` — `pyramid.ts` (what a pyramid *is*), `image-header.ts`,
`image-manifest.ts`, `decode-ceiling.ts`, `ingest.ts` (the job), `decode-and-crop-tiler.ts`,
`streaming-tiler.ts`; `apps/editor/src/lib/ingest/libvips-loader.ts`; the Historical Maps section
of `ProjectView.svelte`; `e2e/editor-image-ingest.e2e.ts`.

### The measured `createImageBitmap` decode ceiling

**528,006,700 pixels** — the largest image both measured browsers decoded. Recorded in
`packages/core/src/tiler/decode-ceiling.ts` beside the constant it sets, with the method, because
it cannot be re-derived from the code.

| Browser                | Largest decoded           | Smallest refused          |
| ---------------------- | ------------------------- | ------------------------- |
| Chromium 151.0.7922.34 | 26733×20050 = 535,996,650 | 32767×16384 = 536,854,528 |
| Firefox 153.0          | 26533×19900 = 528,006,700 | 26733×20050 = 535,996,650 |

**Method.** A greyscale PNG whose pixels are all zero compresses to almost nothing, so a probe
image of any declared size is cheap to build and transfer while the bitmap the browser must
allocate to decode it is full size. A ladder of such images through `createImageBitmap(blob)`,
binary-searched between the last success and the first failure, therefore measures the decode
ceiling directly and does not depend on how well any real image compresses. Each probe ran in a
fresh browser process; each decoded bitmap was sampled at its far corner so a lazy decode could
not pass. Linux x86-64, 62 GiB RAM, 2026-08-05.

Both engines refuse in single-digit milliseconds — 15 ms Chromium, 3 ms Firefox — with no
allocation attempt, which says the ceiling is a **cap** and not the host's free memory:
536,870,912 pixels is exactly 2 GiB at 4 bytes per pixel and both refuse just below it. Firefox
additionally caps a single side at 65535 pixels; Chromium does not (200000×100 decodes).

The **threshold** is set at 2^28 = 268,435,456 pixels, about half the measurement. The margin is
argued in `decode-ceiling.ts`: the measurement was taken on a workstation, Safari is unmeasured,
and the two failure directions are not symmetric — routing early costs time, routing late costs
the user their ingest partway through.

**Safari/WebKit is unmeasured for the ceiling.** Playwright's WebKit was used for the resampling
measurement below, but no ceiling ladder was run against it.

### The generated `info.json`, validated against Allmaps end to end

**It loads and renders in Allmaps' own hosted editor.** A real pyramid was generated on disk by
the shipped `ingestImageFile` and streaming tiler (29 tiles from a 1200 × 851 source rebuilt from
the committed fixture's scale-factor-1 tiles) and served at an HTTPS origin with the placeholder
`id` rewritten to that base — which is ADR-0004's publish-time stamp. Then
`https://editor.allmaps.org/images?url=…` was driven in Chromium 151.

What it exercised, all of it Allmaps' own code:

- **`info.json`**: fetched, parsed, and accepted. No error state; the editor's Images → Draw mask →
  Georeference flow became available.
- **Tile geometry**: Allmaps computed tile requests from `tileZoomLevels` and fetched **6 tiles at
  scale factor 2, all 200, zero 404s** — including the ragged ones,
  `1024,0,176,512/88,256/0/default.jpg` and `0,512,512,339/256,170/0/default.jpg`. That a IIIF
  client independently derives the same URLs the tiler wrote is the strongest available statement
  that reader and writer agree.
- **Rendering**: the map drew correctly — whole, right way up, correct aspect ratio, no seams and
  no misalignment between tiles.
- **`manifest.json`**: also loaded on its own. Allmaps showed the label ("La Floride, Sanson,
  1657") and the canvas size ("1200 × 851 pixels"), and fetched the same 6 tiles with no 404s.

Caveat for anyone repeating this: Allmaps Editor **refuses non-HTTPS IIIF URLs** outright, and
Chrome refuses a public page's fetch of a loopback address whatever the scheme. So the pyramid was
served through a Playwright route on a public-looking HTTPS origin. Everything above the transport
was real.

### The exact-resize contract from ticket 03's review

Settled first by measurement against the committed fixture, then asserted in both tilers.

**The fixture's semantics is IIIF Image API 3.0 `size=w,h` read literally: the tile's bytes are the
whole region resized onto exactly `w` × `h`.** Established by reconstructing the 1200 × 851 source
from the 20 scale-factor-1 tiles and comparing each ragged tile's per-row mean brightness against
the source rows each output row would be drawn from under each hypothesis — a 1-D profile, so the
comparison does not depend on which resampler made the fixture. Mean squared error per tile:

| Tile                          | IIIF `size=w,h` | scale by 1/scaleFactor |
| ----------------------------- | --------------- | ---------------------- |
| `0,0,1200,851` → `150,107`    | 7.2             | 162.8                  |
| `0,512,512,339` → `256,170`   | 12.7            | 210.0                  |
| `0,0,1024,851` → `256,213`    | 10.1            | 29.8                   |
| `1024,0,176,851` → `44,213`   | 6.7             | 20.8                   |
| `1024,512,176,339` → `88,170` | 10.5            | 165.8                  |
| `512,512,512,339` → `256,170` | 11.7            | 200.6                  |

This is the same conclusion as ticket 03's, and it is worth stating plainly because the two
descriptions of it can be read as contradicting each other. `placement = region ÷ scaleFactor`
(106.375 for a 107-pixel file) is correct **because** the file's full extent is the region's full
extent: drawing a 107-pixel-tall file into 106.375 pixels of the cell puts the region's content
exactly where the region is. A file whose content stopped at 106.375 of its own 107 pixels would be
drawn 0.6% short. So "an exact resize of the region onto `w`×`h`", and "not a 1/scaleFactor resize
padded up to whole pixels" — the wording of the forward contract — is what both tilers do.

**Asserted, not inherited**, by two statistics that survive the difference between resamplers:

- *Extent.* A uniform region with a contrasting surround outside it must produce a tile every pixel
  of which is that colour. Under `size=w,h` the content covers all `w` × `h`; under
  1/scaleFactor-plus-padding the last row and column are a blend. It also catches a resize that
  sampled outside its own region. Applied to every ragged tile of a 1201 × 851 pyramid — ragged in
  *both* directions at every scale factor, which the committed fixture is not.
- *Slope.* An edge swept across the region, with output position fitted against source position, so
  each engine's constant sampling offset drops out. Must be nearer `size ÷ region` than
  `1 ÷ scaleFactor`.

Absolute pixel positions turned out **not** to separate the hypotheses cleanly, and the reason is
worth recording: each engine's resampler carries its own sub-pixel offset (fitted over an edge
sweep, a 177-pixel region onto 89 pixels — Chromium 151 slope 0.50418 intercept −0.12, Firefox 153
slope 0.50255 intercept +0.02, against 89/177 = 0.50282), and JPEG ringing clips asymmetrically
against black and white. A first draft of these tests asserted absolute positions and produced a
*false negative* on the right-hand margin: it read as 1/scaleFactor semantics where the extent
measurement proves both engines fill the tile completely.

**Byte-comparable to the committed fixture pyramid?** Not byte-identical, and it cannot be: JPEG is
lossy and the only available source is a reconstruction from the fixture's own JPEG tiles. What is
identical:

- **`info.json` is deep-equal to the committed fixture's**, field for field, including
  `tiles: [{width: 256, height: 256, scaleFactors: [1,2,4,8]}]`. Only the on-disk whitespace differs
  (this tiler writes tab-indented JSON, matching `serialiseProjectFile`; the fixture's throwaway
  script used two spaces).
- **The 29 tile paths are exactly the fixture's 29 files**, asserted as a set.
- **The scale-factor-1 tiles are reproduced at mean squared error < 30** — a JPEG generation apart
  and nothing else, which is what pins the regions, their order, and their orientation.
- **The ragged coarse tiles agree on semantics**, by the profile test tabulated above.

### The streaming tiler cannot run where ADR-0003 needs it to

**This needs a human, and no implementer can decide it away.**

ADR-0003 and this ticket both require the **single-threaded** `wasm-vips` build, because the
threaded one needs COOP/COEP cross-origin isolation and GitHub Pages cannot send those headers —
which would break "anyone can fork and host their own instance". **npm publishes only the threaded
build.** `wasm-vips`' own README says so: *"Since wasm-vips requires the `SharedArrayBuffer` API,
the website needs to opt-in to a cross-origin isolated state"*. All three shipped entry points
(`vips.js`, `vips-es6.js`, `vips-node.mjs`) construct a shared `WebAssembly.Memory`.

Measured 2026-08-05, serving the package's own files:

| Document                                 | Chromium 151                | Firefox 153                 |
| ---------------------------------------- | --------------------------- | --------------------------- |
| no COOP/COEP                             | `Vips()` **never settles**  | `Vips()` **never settles**  |
| COOP `same-origin` + COEP `require-corp` | initialises, libvips 8.18.3 | initialises, libvips 8.18.3 |

Without the headers it does not reject — it hangs, after a `DataCloneError` from the pthread
worker's `postMessage`. A hang is the worst failure available here: an ingest that shows a progress
bar and never moves. So `libvips-loader.ts` **refuses before importing anything** when
`crossOriginIsolated` is false, with a message a user can act on, and `ingestImageFile` refuses an
over-threshold image outright when no streaming tiler is supplied. Nothing hangs; but nothing above
268 megapixels can be ingested on a static host either, which is a real dent in SPEC story 22.

The options, none of which is an implementer's call:

1. **Build a single-threaded `wasm-vips` and vendor the artefact.** Upstream can build one; it is
   not published. Adds a committed binary, and sharpens the LGPLv3 obligation below.
2. **Inject COOP/COEP with a service worker** (the `coi-serviceworker` pattern), which does work on
   GitHub Pages. But `require-corp` then breaks fetching remote IIIF tiles that carry no CORP
   header, which is ticket 14's whole subject; `credentialless` fixes that in Chromium and not in
   Safari. It also interacts with ticket 18's own service worker.
3. **Drop the streaming tiler from v1.** Cap ingest at the decode ceiling with the refusal that now
   exists, and lean on ADR-0003's already-documented `sharp` CLI as the escape hatch for images that
   defeat the browser. Cheapest, and honest, but it retires part of story 22.
4. Something else — a different WASM codec path, or server-side tiling, both of which are larger
   decisions than this ticket.

The seam is built so that whichever is chosen is a small change: `streamingTiler(loadVips)` takes
the module through an injected loader, and the geometry it produces is already asserted against real
libvips in `streaming-tiler.test.ts`, which runs in the Node project where `SharedArrayBuffer`
always exists.

### Recorded, not fixed

- **WebKit resamples large reductions poorly.** `createImageBitmap`'s `resizeWidth`/`resizeHeight`
  with `resizeQuality: 'high'` is what the decode-and-crop tiler uses, and it measures at the
  exact-box-filter noise floor in Chromium 151 (MSE 2) and Firefox 153 (1.3) on an 8× reduction of
  3-pixel diagonal hatching. WebKit honours the options but scores **1047** — roughly a bilinear
  reduction. These tiles are the archive, so it matters; fixing it means reducing in repeated halving
  steps, and for the coarse levels of a large pyramid the intermediates would be far larger than one
  tile, which is a slice of its own. For comparison, a single `drawImage` step scores 275 in Firefox
  and 2 in Chromium, which is why the reduction is asked for in the `createImageBitmap` call and not
  on the canvas.
- **The editor build now carries 10 MB of `vips.wasm`** — Vite emits it twice, once for the main
  thread and once for the worker. It is lazily fetched, and the *viewer* build has none of it, so no
  published site pays for it; the editor deployment does. Resolved for free by option 1 or 3 above.
- **JPEG only.** Tiles are `default.jpg` per the ADR-0003 contract, so a PNG source with
  transparency loses its alpha channel. Right for scans; worth knowing before someone ingests a
  cut-out.
- **Ingest runs on the main thread.** Progress moves because each tile write awaits, but a gigapixel
  ingest will make the tab sluggish. A Worker is a later question.
- **`project.json` is untouched by an ingest**, asserted in the e2e suite. The Layer that refers to
  an image is ticket 09; writing one now would stamp a fresh `updatedAt` with nothing behind it.
- **Two claims in `THIRD-PARTY-NOTICES.md` were wrong and are corrected; a third item is opened.**
  The pre-seeded entry said libvips is LGPL-2.1-or-later (the package says **LGPLv3**, via the "any
  later version" clause of LGPLv2.1) and that the LGPL text ships in the package (**it does not** —
  only the MIT text for the wrapper). The LGPLv3 text now joins OFL 1.1 and BSD-3-Clause in that
  file's open item for a human to fetch.
