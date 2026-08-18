// Ingesting a local image file: the job that turns a file the user picked into a level-0
// pyramid in their Project (SPEC stories 21, 22, 23).
//
// **A job, not a function call** (ADR-0003). Even a 2 megapixel phone photo becomes a pyramid —
// there is no shortcut for small images, because `@allmaps/iiif-parser` cannot construct an
// `Image` for an untiled level-0 service at all — and every image therefore takes long enough
// that the UI has to be able to say what is happening. So this reports progress, can be
// cancelled, and cleans up after itself when it is. `apps/editor` supplies the signal and a
// Cancel button beside the progress bar; a cancellation that no user can reach is not one, and
// this comment described that state of affairs for a while.
//
// **There is one tiler, and above the decode ceiling there is a refusal** (ADR-0027). There used
// to be a second, streaming implementation backed by `wasm-vips`, taken for images the browser
// cannot decode in one piece; it was removed because it could not run on the deployment target at
// all. The tiler is still injected rather than imported: it needs `createImageBitmap` and an
// `OffscreenCanvas`, and naming the seam here is what lets everything above it be tested in Node
// and keeps this module free of anything `apps/viewer` must not acquire (ADR-0019).

import { generateRandomId } from '@allmaps/id';

import type { Bytes, ProjectStore, StorePath } from '../store/project-store.js';
import {
	IMAGE_DIRECTORY,
	imageDirectory,
	imageInfoPath,
	imageManifestPath
} from '../project/image-files.js';
import { MAX_INGEST_PIXELS } from './decode-ceiling.js';
import { readImageHeaderFromBlob } from './image-header.js';
import { buildImageManifest } from './image-manifest.js';
import { buildImageInfo, planPyramid, serialiseJson, type PlannedTile } from './pyramid.js';

/**
 * A source image, opened and ready to be cut up.
 *
 * The seam between "what a pyramid is" and "how pixels are produced": the shipped implementation
 * decodes the whole image once and crops per tile, and nothing above this interface knows that.
 * Keeping the seam after ADR-0027 removed the second implementation is deliberate — it is what
 * lets every test above this line run in Node with no canvas, and it is where the `sharp` escape
 * hatch would attach if it were ever brought in-process.
 */
export interface TileSource {
	/** The image's real dimensions, as the decoder sees them. */
	readonly dimensions: { readonly width: number; readonly height: number };
	/**
	 * The bytes of one tile: the tile's region of the source, resized to **exactly**
	 * `tile.size.width` × `tile.size.height`, encoded as JPEG. See {@link PlannedTile.size} for
	 * why "exactly" is load-bearing.
	 */
	encodeTile(tile: PlannedTile): Promise<Bytes>;
	/** Release the decoded image, the WASM heap, or whatever else was held. */
	close(): Promise<void>;
}

/** Opens a source image. Rejects if this implementation cannot read the file at all. */
export type OpenTileSource = (file: Blob) => Promise<TileSource>;

/** What the UI needs in order to say something true while an ingest runs (SPEC story 23). */
export type IngestProgress = {
	readonly phase: 'inspecting' | 'opening' | 'tiling' | 'finishing' | 'done';
	readonly tilesWritten: number;
	/** Total tiles in the pyramid. 0 until the image's dimensions are known. */
	readonly tileCount: number;
	/** 0 to 1. Monotonic, and never 1 before the pyramid is complete. */
	readonly fraction: number;
};

export type IngestResult = {
	readonly imageId: string;
	/** The pyramid's directory, relative to the workspace root. */
	readonly directory: StorePath;
	readonly infoPath: StorePath;
	readonly manifestPath: StorePath;
	readonly width: number;
	readonly height: number;
	readonly tileCount: number;
};

export type IngestOptions = {
	readonly store: ProjectStore;
	readonly file: File | Blob;
	/** What to call this Map Image. Defaults to the file's name. */
	readonly label?: string;
	/**
	 * The image id to write this pyramid under. A fresh random one when absent.
	 *
	 * Absent is right for a file the user picked: there is no URI to derive an identity from, and two
	 * ingests of one file are two Map Images (ADR-0015). It is supplied by exactly one caller —
	 * `makeOfflineCopy`, making an offline copy of a referenced remote image — where the opposite
	 * holds and is load-bearing: that image's id is `generateId(uri)`, which is what every Alignment in
	 * the Workspace names and what `annotations.allmaps.org` keys the image on, so making an offline copy must land on
	 * the id the image already has rather than mint a second one.
	 */
	readonly imageId?: string;
	/** The decode-and-crop tiler. Required: it is the path every image takes. */
	readonly openDecodeAndCrop: OpenTileSource;
	/** Overridable so tests can drive the refusal without a 528-megapixel fixture. */
	readonly maxIngestPixels?: number;
	readonly onProgress?: (progress: IngestProgress) => void;
	readonly signal?: AbortSignal;
};

/** One ingested Map Image of the Workspace, as the UI lists them. */
export type IngestedImage = {
	readonly imageId: string;
	readonly directory: StorePath;
	readonly infoPath: StorePath;
};

/**
 * The Map Images the **Workspace** holds, found by looking for `info.json` and nothing else
 * (ADR-0023). Shared by every Project, so this asks the Workspace root and takes no Project directory.
 *
 * `info.json` is written last, so this reports only complete pyramids — the tiles of an
 * interrupted ingest are invisible here, which is the point of that write order.
 */
export async function listIngestedImages(store: ProjectStore): Promise<IngestedImage[]> {
	const prefix = `${IMAGE_DIRECTORY}/`;
	const paths = await store.list(prefix);

	return (
		paths
			.filter((path) => path.endsWith('/info.json'))
			.map((path) => {
				const directory = path.slice(0, -'/info.json'.length);
				return { imageId: directory.slice(prefix.length), directory, infoPath: path };
			})
			// A nested `images/<id>/…/info.json` is not a Map Image; only the top level is.
			.filter((image) => !image.imageId.includes('/'))
	);
}

/**
 * Thrown when the image is larger than a browser will decode, so no pyramid can be cut from it
 * here at all (ADR-0027).
 *
 * **The message says the size and the remedy, and nothing about the deployment.** It used to name
 * `Cross-Origin-Embedder-Policy` and cross-origin isolation, because the refusal was really about
 * a streaming tiler that could not start; with that tiler gone the refusal is about the image, and
 * the only thing the user can do about it is prepare the pyramid outside the browser. SPEC's *On
 * the audience* makes "errors must name what is wrong and what to do" binding, and a scholar who
 * has never heard of COEP could act on neither half of the old sentence.
 *
 * What must also not happen is what used to happen before that: this arriving as
 * {@link UnreadableImageError}, whose first sentence says the file could not be read and tells the
 * user to convert a TIFF they may not have.
 */
export class ImageTooLargeError extends Error {
	/** The image's size in pixels, for a caller that wants to render its own sentence. */
	readonly pixels: number;
	/** The cap this image exceeded, in pixels. */
	readonly maxPixels: number;

	constructor(pixels: number, maxPixels: number) {
		// **"This file", not "this image"** (CONTEXT.md, *Map Image*: avoid map, image, scan,
		// source). What the user picked is a file; it would have become a Map Image, and did not.
		super(
			`This file is ${Math.round(pixels / 1e6)} megapixels, above the ` +
				`${Math.round(maxPixels / 1e6)} megapixel limit of what a browser can decode. Convert it ` +
				`to a IIIF pyramid outside the browser and add that instead. Nothing has been added to ` +
				`the Workspace.`
		);
		this.name = 'ImageTooLargeError';
		this.pixels = pixels;
		this.maxPixels = maxPixels;
	}
}

/**
 * Thrown when the tiler could not read the file — an unsupported format, or a truncated one.
 *
 * Distinct from {@link ImageTooLargeError} on purpose, and the pair is asserted: a TIFF under the
 * cap must fail as a format this browser does not read, not as an image that is too large, because
 * the advice differs and one of them is advice to do the thing that just failed.
 */
export class UnreadableImageError extends Error {
	constructor(cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(
			`This file could not be read as an image. Browsers read JPEG, PNG, WebP, GIF and AVIF; ` +
				`a TIFF or JPEG 2000 archival master needs to be converted first. (${detail})`
		);
		this.name = 'UnreadableImageError';
	}
}

/**
 * Turn a local image file into a level-0 pyramid at `images/<image-id>/` in the Workspace (ADR-0023).
 *
 * Order of writes matters and is deliberate: **every tile lands before `info.json` does.** A
 * Workspace is a folder in git or Dropbox (ADR-0008), so an ingest interrupted halfway is a
 * folder somebody else may look at, and `info.json` is what says "this is a readable IIIF
 * image". Writing it first would make a half-finished pyramid claim to be a whole one; writing
 * it last makes its presence the completion marker. The stray tiles left by an interrupted run
 * are removed here on cancellation, and are in any case unreachable — nothing looks for tiles
 * except by way of an `info.json`.
 */
export async function ingestImageFile(options: IngestOptions): Promise<IngestResult> {
	const {
		store,
		file,
		openDecodeAndCrop,
		maxIngestPixels = MAX_INGEST_PIXELS,
		onProgress,
		signal
	} = options;

	const label = options.label ?? (file instanceof File ? file.name : 'Untitled image');

	let tilesWritten = 0;
	let tileCount = 0;

	const report = (phase: IngestProgress['phase']) => {
		onProgress?.({
			phase,
			tilesWritten,
			tileCount,
			// Tiling is all of the work, so the fraction is the tile count and the two ends are
			// reserved: never 1 until the pyramid is complete, because a progress bar that sits at
			// 100% while the job is still running is the failure story 23 is written against.
			fraction:
				phase === 'done' ? 1 : tileCount === 0 ? 0 : Math.min(0.99, tilesWritten / tileCount)
		});
	};

	report('inspecting');
	signal?.throwIfAborted();

	// The header first, so that an image above the cap is never handed to a decoder. An
	// unrecognised container falls through with `undefined` and is decoded, which is right for
	// the formats a browser reads and this does not — but it means the size decision for those
	// is made by the decoder itself, which either succeeds or reports a decode failure.
	const header = await readImageHeaderFromBlob(file);
	const headerPixels = header ? header.width * header.height : undefined;

	if (headerPixels !== undefined && headerPixels > maxIngestPixels) {
		throw new ImageTooLargeError(headerPixels, maxIngestPixels);
	}

	report('opening');
	signal?.throwIfAborted();

	let source: TileSource;
	try {
		source = await openDecodeAndCrop(file);
	} catch (cause) {
		throw new UnreadableImageError(cause);
	}

	const written: StorePath[] = [];

	try {
		const { width, height } = source.dimensions;
		const imageId = options.imageId ?? (await generateRandomId());
		const directory = imageDirectory(imageId);
		const info = buildImageInfo({ imageId, width, height });
		const tiles = planPyramid(info, directory);
		tileCount = tiles.length;

		report('tiling');

		for (const tile of tiles) {
			signal?.throwIfAborted();
			const bytes = await source.encodeTile(tile);
			await store.write(tile.path, bytes);
			written.push(tile.path);
			tilesWritten += 1;
			report('tiling');
		}

		report('finishing');
		signal?.throwIfAborted();

		const infoPath = imageInfoPath(imageId);
		const manifestPath = imageManifestPath(imageId);
		// The manifest first, then `info.json`: the same argument one level up. `info.json` is the
		// completion marker for the whole directory, so nothing may be missing once it is there.
		await store.write(manifestPath, serialiseJson(buildImageManifest({ imageId, label, info })));
		written.push(manifestPath);
		// ─────────────────────────────────────────────────────────────────────────────────────────
		// CANCEL MEANS CANCEL, ACROSS THE LAST TWO WRITES AS WELL
		//
		// There used to be one check at the top of `finishing` and nothing after it, while the Cancel
		// affordance stays live until `done` — so a cancel landing anywhere in this window aborted
		// nothing at all: the map the user cancelled was created, with no error and no way to tell.
		// The two writes are short, but "short" is the same argument that would have removed the
		// tiling loop's per-tile check, and it is wrong for the same reason on a loaded machine.
		//
		// Aborting *after* `info.json` still leaves nothing behind: the `catch` below deletes every
		// path in `written`, and `info.json` is one of them.
		signal?.throwIfAborted();
		await store.write(infoPath, serialiseJson(info));
		written.push(infoPath);
		signal?.throwIfAborted();

		report('done');

		return {
			imageId,
			directory,
			infoPath,
			manifestPath,
			width,
			height,
			tileCount
		};
	} catch (cause) {
		// Leave nothing behind. An abandoned pyramid is unreachable — nothing finds tiles except
		// through an `info.json`, which is written last — but it still occupies the bytes ticket 15
		// and 16 have to count for ADR-0008's hosting warning, and in ticket 12's real folder it is
		// litter in the user's own directory.
		await Promise.all(written.map((path) => store.delete(path).catch(() => undefined)));
		throw cause;
	} finally {
		await source.close().catch(() => undefined);
	}
}
