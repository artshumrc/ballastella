# 05 — Local image to level-0 pyramid

## What to build

A user picks an image file from their computer. The app converts it to a level-0 IIIF pyramid with an `info.json` and a IIIF Presentation manifest, writes it into the Project, and shows progress while it works. A very large scan succeeds rather than being rejected.

This slice also settles two facts nobody can guess: **where the decode ceiling actually falls per browser** (which sets the streaming-tiler threshold), and **whether our generated `info.json` is accepted by Allmaps end to end**.

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

- [ ] A local image becomes a complete pyramid plus `info.json` and `manifest.json` in the store
- [ ] The generated `info.json` constructs a `@allmaps/iiif-parser` `Image` **without throwing**
- [ ] For every zoom level, column, and row, the tile written is exactly the tile `getTileImageRequest` describes — asserted exhaustively over a fixture, not sampled
- [ ] Tiles are square and edge tiles are correctly truncated at the right and bottom margins
- [ ] `info.json` has `id === "https://unset.invalid/<image-id>"` and passes `z.string().url()`
- [ ] A small image (≈2 MP) is tiled, not shortcut
- [ ] An image above the measured decode ceiling routes to the streaming tiler and produces output **byte-comparable in structure** to the decode-and-crop path (same paths, same tile geometry)
- [ ] `wasm-vips` is not in the initial bundle — it is fetched only when the streaming path is taken
- [ ] Progress is reported for both paths and for small files
- [ ] The measured decode ceiling is recorded with browser and method
- [ ] `THIRD-PARTY-NOTICES.md` carries an accurate libvips/LGPL entry
- [ ] The generated `info.json` and pyramid are confirmed to load in **Allmaps' own viewer** (manual check; record the outcome)

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
