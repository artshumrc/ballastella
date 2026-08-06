// The streaming tiler: libvips, for images above the measured decode ceiling (ADR-0003).
//
// The decode-and-crop path holds the whole image decoded, at about 4 bytes per pixel, and above
// `STREAMING_TILER_THRESHOLD_PIXELS` that allocation is what kills the tab. libvips does not
// hold the image: it reads a horizontal band, uses it, and moves on. So this path's memory is
// one band of the source — `imageWidth × tileSize × scaleFactor × 3` bytes — regardless of how
// large the scan is.
//
// **libvips' own `dzsave layout=iiif3` is deliberately not used.** It decides its own tile
// geometry and builds each level by halving the level above it, which is not the same thing as
// an exact resize of each tile's region of the *source*: the rounding accumulates, and every
// ragged tile at the right and bottom margins ends up displaced by a fraction of a pixel. The
// writer is bound to `getTileImageRequest` (ADR-0003) and to IIIF `size=w,h` semantics
// (`PlannedTile.size`), and the only way to be bound by them is to ask for each tile explicitly.
//
// **The module is injected, never imported.** `@ballastella/core` does not depend on
// `wasm-vips`; `apps/editor` supplies a loader that dynamically imports it, which is what keeps
// it out of the initial bundle and out of `apps/viewer` altogether (ADR-0019).
//
// ## A blocker recorded here because it is discovered here
//
// npm's `wasm-vips` ships **only the threaded build**, which needs `SharedArrayBuffer` and
// therefore a cross-origin isolated document — the COOP/COEP headers GitHub Pages cannot set.
// ADR-0003 calls for the single-threaded build for exactly this reason, and there is no
// published artefact of it. Measured, 2026-08-05, over plain HTTP with no COOP/COEP:
// `Vips()` never settles — it hangs indefinitely in Chromium 151 and Firefox 153 alike, after a
// `DataCloneError` from the pthread worker's `postMessage` — and with the two headers set it
// initialises normally and reports libvips 8.18.3. A hang is the worst possible failure here: an
// ingest that shows a progress bar and never moves. So {@link openStreamingSource} is reached
// only through a loader that must decide *before* loading whether this document can run it;
// `apps/editor`'s refuses when `crossOriginIsolated` is false rather than hanging.

import type { OpenTileSource, TileSource } from './ingest.js';
import { TILE_JPEG_QUALITY, type PlannedTile } from './pyramid.js';

/**
 * The slice of libvips this tiler uses.
 *
 * Structural, and declared here rather than imported from `wasm-vips`, so that nothing under
 * `packages/core/src` imports that package at all — not even for its types, which is the import
 * a later refactor turns into a runtime one by accident. `wasm-vips` is a devDependency of this
 * package only so that `streaming-tiler.test.ts` can drive real libvips.
 */
export interface VipsImage {
	readonly width: number;
	readonly height: number;
	crop(left: number, top: number, width: number, height: number): VipsImage;
	resize(scale: number, options?: { vscale?: number; kernel?: string | number }): VipsImage;
	/** Force the pixels into memory, so what follows can read them in any order. */
	copyMemory(): VipsImage;
	writeToBuffer(formatString: string, options?: Record<string, unknown>): Uint8Array;
	/** Embind: every image has to be released by hand. */
	delete(): void;
}

export interface VipsModule {
	Image: {
		newFromBuffer(
			data: Uint8Array,
			stringOptions?: string,
			options?: { access?: string | number; [key: string]: unknown }
		): VipsImage;
	};
	Access: { sequential: string | number; random: string | number };
	Kernel: { lanczos3: string | number };
}

/** Loads libvips. Called at most once per ingest, and only when the streaming path is taken. */
export type LoadVips = () => Promise<VipsModule>;

/**
 * Builds an {@link OpenTileSource} backed by libvips.
 *
 * Curried on the loader so that the seam `ingestImageFile` sees is the same shape as the
 * decode-and-crop tiler's, and neither it nor anything above it knows that one of the two has a
 * 5 MB WebAssembly module behind it.
 */
export const streamingTiler =
	(loadVips: LoadVips): OpenTileSource =>
	async (file: Blob): Promise<TileSource> => {
		const vips = await loadVips();
		const bytes = new Uint8Array(await file.arrayBuffer());

		const openSource = (): VipsImage =>
			vips.Image.newFromBuffer(bytes, '', { access: vips.Access.sequential });

		const probe = openSource();
		const dimensions = { width: probe.width, height: probe.height };
		probe.delete();

		// One sequential source per pyramid level, and one band of it at a time. `ingestImageFile`
		// walks the plan in raster order within each level, which is the order a sequential libvips
		// source can be read in; a caller that jumped around would still get correct tiles, because
		// a band that is not the current one is simply re-read from a fresh source.
		let source: VipsImage | undefined;
		let sourceScaleFactor: number | undefined;
		let band: { scaleFactor: number; top: number; image: VipsImage } | undefined;

		const releaseBand = () => {
			band?.image.delete();
			band = undefined;
		};

		const releaseSource = () => {
			source?.delete();
			source = undefined;
			sourceScaleFactor = undefined;
		};

		/** The band of source rows tile `tile` sits in, in memory and safe to read at random. */
		const bandFor = (tile: PlannedTile): VipsImage => {
			const bandHeight = tile.region.height;
			const top = tile.region.y;

			if (band && band.scaleFactor === tile.scaleFactor && band.top === top) {
				return band.image;
			}

			releaseBand();

			// A new level, or a band behind the one the sequential source is on: start the source
			// again. Reading forward is free; reading backward is what a sequential source refuses.
			const rewind = sourceScaleFactor !== tile.scaleFactor || (band?.top ?? -1) > top;
			if (!source || rewind) {
				releaseSource();
				source = openSource();
				sourceScaleFactor = tile.scaleFactor;
			}

			const strip = source.crop(0, top, dimensions.width, bandHeight);
			try {
				band = { scaleFactor: tile.scaleFactor, top, image: strip.copyMemory() };
			} finally {
				strip.delete();
			}

			return band.image;
		};

		return {
			dimensions,

			async encodeTile(tile: PlannedTile) {
				const { region, size } = tile;
				const strip = bandFor(tile);
				const cropped = strip.crop(region.x, 0, region.width, region.height);

				try {
					// Scale factors given as size ÷ region, not as 1 ÷ scaleFactor. `vips_resize`
					// computes its output size as `rint(input × scale)`, so these land on exactly
					// `size.width` × `size.height` and map the region's full extent onto the tile's full
					// extent — IIIF `size=w,h` semantics, which `PlannedTile.size` explains the image
					// pane depends on.
					const resized = cropped.resize(size.width / region.width, {
						vscale: size.height / region.height,
						kernel: vips.Kernel.lanczos3
					});

					try {
						if (resized.width !== size.width || resized.height !== size.height) {
							throw new Error(
								`libvips resized a ${region.width}×${region.height} region to ` +
									`${resized.width}×${resized.height}, not the ${size.width}×${size.height} IIIF ` +
									`says this tile is served at. A tile whose bytes disagree with its own URL is ` +
									`unreadable by every IIIF client, including this app's own image pane.`
							);
						}
						// `writeToBuffer` returns a view onto the WASM heap, which the next operation may
						// reuse — so it is copied before it leaves this function.
						return new Uint8Array(resized.writeToBuffer('.jpg', { Q: TILE_JPEG_QUALITY }));
					} finally {
						resized.delete();
					}
				} finally {
					cropped.delete();
				}
			},

			async close() {
				releaseBand();
				releaseSource();
			}
		};
	};
