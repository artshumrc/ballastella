# Every image is tiled to a level-0 pyramid, client-side, with no size exemption

Every image brought into a project — a 1.4 gigapixel archival scan or a 2 megapixel phone photo — is converted in the browser to a level-0 IIIF pyramid (tiles plus `info.json`) written into the ProjectStore. There is no shortcut for small images.

This is forced, not chosen. `@allmaps/iiif-parser` computes `tileZoomLevels` in the `Image` **constructor** (`classes/image.js:309`), and `lib/tiles.js#getTileZoomLevels` throws `'Image does not support tiles or custom regions and sizes.'` when there is no valid `tiles` array and the profile is level 0. For a level-0 profile, `supportsAnyRegionAndSize` is false unless `extraFeatures` includes both `regionByPx` and `sizeByWh`, which a static file server cannot offer. So an untiled level-0 image cannot even be parsed. The `sizes` array is parsed and exposed but `@allmaps/render` never consults it for rendering — only `tileZoomLevels`. A "just serve a few widths" image is therefore unusable at any size.

## Two tiler implementations, one contract

The contract is `ImageSource → level-0 pyramid in the ProjectStore`, which is the same seam ADR-0001 established.

- **Decode-and-crop (default, zero bundle cost).** `createImageBitmap(blob, sx, sy, sw, sh)` into a single tile-sized `OffscreenCanvas`, then `convertToBlob()`. Browser canvas *area* limits never bind, because no canvas is ever larger than one tile — which matters because Safari's limit can be as low as 5,242,880 px. The binding constraint is instead full-image **decode memory**, roughly 4 bytes per pixel.
- **Streaming (`wasm-vips`, lazily loaded above the decode ceiling).** libvips `dzsave` supports `layout: iiif`/`iiif3` natively and streams rather than holding the image in memory. Loaded on demand only, because it is 10–20 MB and the *threaded* build requires COOP/COEP cross-origin isolation headers that GitHub Pages cannot set — which would break "anyone can fork and host their own instance." Use the single-threaded build.

For images that defeat even single-threaded WASM in a tab, the docs describe a Node CLI using `sharp` — the same approach the Berckenrode project used. Documented in prose; not code we ship.

## Consequences

- `getTileImageRequest(zoomLevel, column, row)` serves double duty: it tells the tiler what to **write**, and the Leaflet image-pane tile layer what to **read**. Both sides use the same function, so they cannot disagree.
- Emit **square** tiles. `getTileZoomLevelFromScaleFactor` does `const height = tileset.height || tileset.width`, so omitting `height` from `info.json` is only a bug for non-square tiles. This is the pitfall the Berckenrode README warns about; square tiles sidestep it.
- Ingesting an image is a slow, progress-bearing operation even for small files. The UI must treat it as a job, not a function call.
