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
// The two tilers are injected rather than imported. That is what keeps `wasm-vips` out of the
// initial bundle (ADR-0019, and the acceptance criterion that greps the built entry chunk for
// it): `@ballastella/core` names a seam, `apps/editor` supplies a loader that dynamically
// imports the module, and `apps/viewer` supplies neither because it never ingests anything.

import { generateRandomId } from '@allmaps/id';

import type { Bytes, ProjectStore, StorePath } from '../store/project-store.js';
import { STREAMING_TILER_THRESHOLD_PIXELS } from './decode-ceiling.js';
import { readImageHeaderFromBlob } from './image-header.js';
import { buildImageManifest } from './image-manifest.js';
import {
	buildImageInfo,
	imageDirectory,
	imageInfoPath,
	imageManifestPath,
	planPyramid,
	serialiseJson,
	type PlannedTile
} from './pyramid.js';

/** Which implementation of the ADR-0003 contract produced a pyramid. */
export type TilerKind = 'decode-and-crop' | 'streaming';

/**
 * A source image, opened and ready to be cut up.
 *
 * The seam between "what a pyramid is" and "how pixels are produced". Both tilers implement it:
 * one decodes the whole image once and crops per tile, the other pushes each tile through
 * libvips. Nothing above this interface knows which one it has.
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
	/** Which tiler is running. Unknown during `inspecting`. */
	readonly tiler: TilerKind | undefined;
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
	readonly tiler: TilerKind;
};

export type IngestOptions = {
	readonly store: ProjectStore;
	/** The Project directory the image is being added to (ADR-0008). */
	readonly projectDirectory: string;
	readonly file: File | Blob;
	/** What to call this Historical Map. Defaults to the file's name. */
	readonly label?: string;
	/** The decode-and-crop tiler. Required: it is the default path for every image. */
	readonly openDecodeAndCrop: OpenTileSource;
	/**
	 * The streaming tiler, if this consumer has one. Absent is a legitimate configuration — a
	 * build that has no `wasm-vips` — and an image above the threshold then fails with a message
	 * that says so instead of being quietly decoded and killing the tab.
	 */
	readonly openStreaming?: OpenTileSource;
	/**
	 * Why {@link openStreaming} cannot run **in this document**, or `''` when it can. Asked before
	 * the tiler is opened, and only for an image above the threshold.
	 *
	 * This exists because "the streaming tiler is present" and "the streaming tiler can run" are
	 * different questions, and on a static host the answers differ: npm publishes only the threaded
	 * `wasm-vips`, which needs a cross-origin isolated document (ADR-0003). Asking first is what
	 * keeps the refusal a statement about the deployment rather than a false statement about the
	 * user's file — and it is the refusal `apps/editor` actually produces, since it always supplies
	 * `openStreaming`.
	 */
	readonly streamingTilerUnavailableReason?: () => string;
	/** Overridable so tests can drive the streaming path without a 268-megapixel fixture. */
	readonly streamingThresholdPixels?: number;
	readonly onProgress?: (progress: IngestProgress) => void;
	readonly signal?: AbortSignal;
};

/** One ingested image in a Project, as the UI lists them. */
export type IngestedImage = {
	readonly imageId: string;
	readonly directory: StorePath;
	readonly infoPath: StorePath;
};

/**
 * The images a Project holds, found by looking for `info.json` and nothing else.
 *
 * `info.json` is written last, so this reports only complete pyramids — the tiles of an
 * interrupted ingest are invisible here, which is the point of that write order.
 */
export async function listIngestedImages(
	store: ProjectStore,
	projectDirectory: string
): Promise<IngestedImage[]> {
	const prefix = `${projectDirectory}/images/`;
	const paths = await store.list(prefix);

	return (
		paths
			.filter((path) => path.endsWith('/info.json'))
			.map((path) => {
				const directory = path.slice(0, -'/info.json'.length);
				return { imageId: directory.slice(prefix.length), directory, infoPath: path };
			})
			// A nested `images/<id>/…/info.json` is not an image of this Project; only the top level is.
			.filter((image) => !image.imageId.includes('/'))
	);
}

/**
 * Thrown when the image is above the decode ceiling and the streaming tiler cannot take it.
 *
 * One error for two reasons, because to a user they are the same event and the difference is
 * ours: either this build has no streaming tiler at all, or it has one that cannot run in this
 * document (see {@link IngestOptions.streamingTilerUnavailableReason}). What must not happen is
 * what used to: the second case arriving as {@link UnreadableImageError}, whose first sentence
 * says the file could not be read and tells the user to convert a TIFF they may not have. SPEC's
 * *On the audience* makes "errors must name what is wrong and what to do" binding, and the size
 * of the image plus the reason the tiler is unavailable is that.
 */
export class StreamingTilerUnavailableError extends Error {
	/** The unadorned reason, for a caller that wants to render it on its own. */
	readonly reason: string;

	constructor(pixels: number, threshold: number, reason: string) {
		super(
			`This image is ${Math.round(pixels / 1e6)} megapixels, above the ${Math.round(
				threshold / 1e6
			)} megapixel limit of the built-in tiler. ${reason} Nothing has been added to the Project.`
		);
		this.name = 'StreamingTilerUnavailableError';
		this.reason = reason;
	}
}

/** The reason used when a build simply has no `wasm-vips` — `apps/viewer`, and nothing else. */
const NO_STREAMING_TILER = 'This build has no streaming tiler to fall back to.';

/**
 * Thrown when the tiler that was chosen could not read the file — an unsupported format, or a
 * truncated one.
 *
 * The advice depends on which tiler failed, because the two read different things. Telling
 * someone whose TIFF libvips choked on that "a TIFF archival master needs to be converted first"
 * is advice to do the thing that just failed.
 */
export class UnreadableImageError extends Error {
	constructor(tiler: TilerKind, cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(
			tiler === 'decode-and-crop'
				? `This file could not be read as an image. Browsers read JPEG, PNG, WebP, GIF and AVIF; ` +
						`a TIFF or JPEG 2000 archival master needs to be converted first. (${detail})`
				: `This file could not be read as an image by the streaming tiler. (${detail})`
		);
		this.name = 'UnreadableImageError';
	}
}

/**
 * Turn a local image file into a level-0 pyramid inside `projectDirectory`.
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
		projectDirectory,
		file,
		openDecodeAndCrop,
		openStreaming,
		streamingThresholdPixels = STREAMING_TILER_THRESHOLD_PIXELS,
		onProgress,
		signal
	} = options;

	const label = options.label ?? (file instanceof File ? file.name : 'Untitled image');

	let tilesWritten = 0;
	let tileCount = 0;

	// `tiler` is passed in rather than closed over, because it is decided exactly once and only the
	// first report is made before that. The counts below really do change as the job runs.
	const report = (phase: IngestProgress['phase'], tiler?: TilerKind) => {
		onProgress?.({
			phase,
			tiler,
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

	// The header first, so that an image above the ceiling is never handed to a decoder. An
	// unrecognised container falls through with `undefined` and is decoded, which is right for
	// the formats a browser reads and this does not — but it means the routing decision for those
	// is made by the decoder itself, which either succeeds or reports a decode failure.
	const header = await readImageHeaderFromBlob(file);
	const headerPixels = header ? header.width * header.height : undefined;

	const overThreshold = headerPixels !== undefined && headerPixels > streamingThresholdPixels;

	if (overThreshold) {
		// Asked before the tiler is opened, so a deployment that cannot run libvips refuses with a
		// sentence about the deployment — and never fetches the module to find out.
		const unavailable = openStreaming
			? (options.streamingTilerUnavailableReason?.() ?? '')
			: NO_STREAMING_TILER;

		if (unavailable) {
			throw new StreamingTilerUnavailableError(
				headerPixels!,
				streamingThresholdPixels,
				unavailable
			);
		}
	}

	const tiler: TilerKind = overThreshold ? 'streaming' : 'decode-and-crop';

	report('opening', tiler);
	signal?.throwIfAborted();

	const open = tiler === 'streaming' ? openStreaming! : openDecodeAndCrop;
	let source: TileSource;
	try {
		source = await open(file);
	} catch (cause) {
		throw new UnreadableImageError(tiler, cause);
	}

	const written: StorePath[] = [];

	try {
		const { width, height } = source.dimensions;
		const imageId = await generateRandomId();
		const directory = `${projectDirectory}/${imageDirectory(imageId)}`;
		const info = buildImageInfo({ imageId, width, height });
		const tiles = planPyramid(info, directory);
		tileCount = tiles.length;

		report('tiling', tiler);

		for (const tile of tiles) {
			signal?.throwIfAborted();
			const bytes = await source.encodeTile(tile);
			await store.write(tile.path, bytes);
			written.push(tile.path);
			tilesWritten += 1;
			report('tiling', tiler);
		}

		report('finishing', tiler);
		signal?.throwIfAborted();

		const infoPath = `${projectDirectory}/${imageInfoPath(imageId)}`;
		const manifestPath = `${projectDirectory}/${imageManifestPath(imageId)}`;
		// The manifest first, then `info.json`: the same argument one level up. `info.json` is the
		// completion marker for the whole directory, so nothing may be missing once it is there.
		await store.write(manifestPath, serialiseJson(buildImageManifest({ imageId, label, info })));
		written.push(manifestPath);
		await store.write(infoPath, serialiseJson(info));
		written.push(infoPath);

		report('done', tiler);

		return {
			imageId,
			directory,
			infoPath,
			manifestPath,
			width,
			height,
			tileCount,
			tiler
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
