// The fourth ADR-0011 injection point: an OpenSeadragon `TileSource` that resolves a stored
// pyramid through the `ProjectStore`.
//
// The other three are one line each — `addProtocol` for a MapLibre source, `fetchFn` for
// `@allmaps/maplibre`, real HTTP for a published site. This one is the substantial work ADR-0011
// names, and it is written as an **upstreamable plugin object** rather than as app glue, because it
// is what makes triiiceratops able to open local IIIF for everyone rather than only here.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// KEPT DELIBERATELY, WITH NO CALLER — TICKET 15, 2026-08-09
//
// **This module has no consumer in this repository, and that is a recorded decision rather than an
// oversight.** It never had one: the editor's `UnwarpedView` named it in a comment as the object it
// would pass if it could, and ticket 15 deleted that component, so the only thing left pointing here
// was a file that no longer exists. Saying that out loud is the whole point of this block — the
// alternative was an exported, tested function nobody could explain.
//
// **The upstream gap it waits on**, precisely: `triiiceratops` 1.0.0-rc.35 has no prop, plugin hook,
// or config path that accepts an OpenSeadragon `TileSource`. `TriiiceratopsViewer` takes
// `manifestId`, `manifestJson`, `canvasId`, `plugins`, `config` and `viewerState`; its `tileSources`
// are derived internally from the canvases by `getViewerTileSources` and are always a URL string or
// `{ type: 'image', url }`. `config.openSeadragonConfig` reaches OpenSeadragon's own options, but the
// internal `$effect` on `tileSources` calls `viewer.open()` and replaces whatever was constructed.
// The plugin API is for panels and flyouts.
//
// **What one upstream prop would unlock, in both apps**: the editor could show a locally ingested
// pyramid unwarped (it never could — a stored pyramid has no URL), and the published viewer could
// show one whose `info.json` still carries the ADR-0004 `unset.invalid` placeholder, which today it
// refuses by design rather than draw a blank (see `apps/viewer/src/lib/unwarped-manifest.ts`). One
// change closes both, which is why this is kept rather than deleted and rewritten later: it is
// measured against a real viewer's tile geometry and its tests encode that.
//
// It is exported from `@ballastella/core`'s index and costs a published site nothing: the export is
// duck-typed and value-imports no OpenSeadragon, so `apps/viewer` gains no dependency from it
// (ADR-0019). If the upstream prop is declined rather than shipped, delete this module and its test
// — a kept-for-later that nobody is waiting on is just an orphan with a longer comment.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY IT IS DUCK-TYPED AND IMPORTS NOTHING FROM OPENSEADRAGON
//
// OpenSeadragon accepts a plain object as a tile source when it carries the members below; it does
// not have to be an instance of `OpenSeadragon.TileSource`. Building one that way keeps
// `openseadragon` out of `@ballastella/core`'s dependency tree, which matters for ADR-0019: the
// published viewer depends on core, and every published site ships that bundle. Since ticket 15
// `apps/viewer` is the only app that owns a triiiceratops component and therefore OpenSeadragon;
// core owns the *rule* about where bytes come from.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY `downloadTileStart` AND NOT `getTileUrl`
//
// A pyramid in OPFS has no URL. OpenSeadragon's default tile loader assigns `getTileUrl`'s answer
// to an `<img src>`, and there is nothing a `ProjectStore` can put there — `<img>` cannot be
// intercepted by `fetch`, by `addProtocol`, or by anything else short of a service worker, which
// ADR-0011 rejects on File System Access permission semantics.
//
// So the loading itself is overridden. `downloadTileStart(context)` is OpenSeadragon 5's documented
// hook for a tile source that fetches its own bytes: it is handed a context with `src`, and calls
// `finish(data)` or `finish(null, errorMessage)`. Here `src` is the ADR-0004 placeholder URL — which
// is exactly the routing key `createStoreImageFetch` matches on — so the bytes come back through
// the *same* shim that serves MapLibre and `@allmaps/maplibre`, and there is one implementation of
// "where is this tile" rather than a second one for OpenSeadragon.
//
// The decoded value handed to `finish` is an `ImageBitmap` where the browser has
// `createImageBitmap`, because that is what OpenSeadragon 5's canvas and WebGL drawers want and it
// avoids a second decode. A blob URL is used where it does not, and it is revoked on abort — a
// pyramid is tens of thousands of tiles and a leaked object URL per tile is a leak per pan.

import { imageServiceId } from '../tiler/pyramid.js';
import type { FetchFn } from './store-image-fetch.js';

/**
 * The context OpenSeadragon 5 hands to `downloadTileStart`. Declared structurally, so this module
 * needs no `openseadragon` import — see the header.
 */
export type OpenSeadragonTileContext = {
	readonly src: string;
	/** `finish(data)` on success; `finish(null, message)` on failure. */
	finish(data: unknown, request?: unknown, errorMessage?: string): void;
	/** Set by `downloadTileStart` and read by `downloadTileAbort`, per OpenSeadragon's own pattern. */
	userData?: Record<string, unknown>;
};

/**
 * The members OpenSeadragon needs to treat a plain object as a tile source.
 *
 * `minLevel`/`maxLevel` are OpenSeadragon's own level numbering: 0 is the coarsest. IIIF counts the
 * other way, by scale factor, so the mapping is done once, in {@link storedPyramidTileSource}, and
 * nowhere else.
 */
export type OpenSeadragonTileSource = {
	readonly width: number;
	readonly height: number;
	readonly tileSize: number;
	readonly tileOverlap: 0;
	readonly minLevel: number;
	readonly maxLevel: number;
	getTileUrl(level: number, x: number, y: number): string;
	getNumTiles(level: number): { x: number; y: number };
	getLevelScale(level: number): number;
	downloadTileStart(context: OpenSeadragonTileContext): void;
	downloadTileAbort(context: OpenSeadragonTileContext): void;
};

export type StoredPyramidTileSourceOptions = {
	/** The image whose pyramid this draws. */
	readonly imageId: string;
	readonly width: number;
	readonly height: number;
	/** Tile side in pixels. Square, per ADR-0003. */
	readonly tileSize: number;
	/**
	 * The IIIF scale factors the pyramid has, finest first or in any order. `1, 2, 4, …`, which
	 * `createImagePane` has already insisted on for anything this app will read.
	 */
	readonly scaleFactors: readonly number[];
	/**
	 * The ADR-0011 shim — `createStoreImageFetch` bound to this Project. The one seam: hand in a
	 * different `fetch` and this source reads from wherever that goes, which is how a *copied*
	 * copy and a remote service are the same code path.
	 */
	readonly fetch: FetchFn;
	/**
	 * How bytes become something OpenSeadragon can draw. Defaults to `createImageBitmap`, and is
	 * injected so a test can assert the fetch-and-finish protocol without a browser decoder.
	 */
	readonly decode?: (bytes: Blob) => Promise<unknown>;
};

/**
 * An OpenSeadragon tile source for a pyramid inside a Project.
 *
 * The URL every tile is asked for is `https://unset.invalid/<image-id>/<region>/<size>/0/default.jpg`
 * — the ADR-0004 placeholder — and it never reaches the network: `options.fetch` is the injection
 * layer, which answers that host from the store and refuses to let it escape.
 */
export function storedPyramidTileSource(
	options: StoredPyramidTileSourceOptions
): OpenSeadragonTileSource {
	const { imageId, width, height, tileSize } = options;

	if (!(width > 0) || !(height > 0)) {
		throw new Error(`A pyramid's dimensions must be positive, got ${width}×${height}.`);
	}
	if (!(tileSize > 0)) {
		throw new Error(`A pyramid's tile size must be positive, got ${tileSize}.`);
	}

	// Coarsest first, which is OpenSeadragon's level order. IIIF's coarsest level is its *largest*
	// scale factor, so the two orders are reverses of each other — the single place that is known.
	const scaleFactors = [...options.scaleFactors].sort((a, b) => b - a);
	if (scaleFactors.length === 0) {
		throw new Error(`The pyramid for “${imageId}” declares no scale factors.`);
	}

	const base = imageServiceId(imageId);
	const decode = options.decode ?? ((bytes: Blob) => createImageBitmap(bytes));

	const scaleFactorAt = (level: number): number =>
		scaleFactors[Math.min(Math.max(level, 0), scaleFactors.length - 1)] as number;

	return {
		width,
		height,
		tileSize,
		tileOverlap: 0,
		minLevel: 0,
		maxLevel: scaleFactors.length - 1,

		getNumTiles(level) {
			const span = tileSize * scaleFactorAt(level);
			return { x: Math.ceil(width / span), y: Math.ceil(height / span) };
		},

		getLevelScale(level) {
			return 1 / scaleFactorAt(level);
		},

		getTileUrl(level, x, y) {
			const scaleFactor = scaleFactorAt(level);
			const span = tileSize * scaleFactor;
			const regionX = x * span;
			const regionY = y * span;
			// Ragged tiles at the right and bottom margins, in IIIF's own arithmetic: the region is
			// clipped to the image and the size is the ceiling of the clipped region over the scale
			// factor. The same numbers `Image#getTileImageRequest` produces, which is what the tiler
			// wrote the files under — so this cannot address a tile that does not exist.
			const regionWidth = Math.min(span, width - regionX);
			const regionHeight = Math.min(span, height - regionY);
			const sizeWidth = Math.ceil(regionWidth / scaleFactor);
			const sizeHeight = Math.ceil(regionHeight / scaleFactor);
			return (
				`${base}/${regionX},${regionY},${regionWidth},${regionHeight}/` +
				`${sizeWidth},${sizeHeight}/0/default.jpg`
			);
		},

		downloadTileStart(context) {
			const abort = new AbortController();
			const userData = (context.userData ??= {});
			userData['abort'] = abort;

			void (async () => {
				try {
					const response = await options.fetch(context.src, { signal: abort.signal });
					if (!response.ok) {
						// A 404 here is the store saying the tile is not written, which for an immutable
						// pyramid means the pyramid is incomplete — worth saying, because OpenSeadragon's own
						// message would be about a URL on a host that does not exist.
						context.finish(
							null,
							undefined,
							`${context.src} is not in this Workspace (${response.status}).`
						);
						return;
					}
					const data = await decode(await response.blob());
					if (abort.signal.aborted) {
						closeBitmap(data);
						return;
					}
					context.finish(data);
				} catch (cause) {
					if (abort.signal.aborted) return;
					context.finish(null, undefined, cause instanceof Error ? cause.message : String(cause));
				}
			})();
		},

		downloadTileAbort(context) {
			const abort = context.userData?.['abort'];
			if (abort instanceof AbortController) abort.abort();
		}
	};
}

/** Release a decoded bitmap that arrived after its tile was abandoned. */
function closeBitmap(data: unknown): void {
	const closeable = data as { close?: () => void } | null;
	if (typeof closeable?.close === 'function') closeable.close();
}
