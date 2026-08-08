// "Make an offline copy": a referenced remote Historical Map turned into a pyramid of our own
// (ADR-0007, SPEC stories 27 and 28).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS, IN ONE LINE
//
// A **funnel into ticket 05**. Both paths below end with one full-resolution image handed to
// `ingestImageFile`, so an offline copy's pyramid is not merely shaped like a locally ingested one — it is
// produced by the same code, over the same geometry, with the same `info.json` and the same
// `manifest.json`. `offline-copy.test.ts` asserts that byte for byte against a local ingest of the same
// dimensions, which is the only form of that claim worth having.
//
// That is also what makes the exact-resize question go away rather than be tolerated. Ticket 14's CORS
// probe can only check the one thing about a stranger's server that is checkable — a ragged tile's
// decoded dimensions must equal what was asked for — and has to tolerate the undetectable residue: a
// server that returns the right dimensions having padded rather than resized within them, bounded at
// 0.6% of one tile along two margins. **An offline copy removes that outright**, because every tile
// in it is cut by the tiler ticket 05 asserts exact-resize of, from pixels this app has in hand. The
// only geometry a remote server is trusted for here is 1:1 — a region served at its own size, where
// there is no resize to get wrong and a wrong answer is a wrong number of pixels rather than a
// sub-pixel stretch.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE TWO PATHS, AND WHY THE CHOICE IS NOT ABOUT COMPLIANCE LEVEL ALONE
//
// ADR-0007 frames it as level 2 versus level 0, and that is the shape of it:
//
//   `full-max`   One request for the whole image at full size, then the local path exactly.
//   `assembled`  Every tile of the service's **finest** level, stitched back into one image and
//                re-cut. Potentially thousands of requests against somebody else's server, which is
//                a politeness obligation to warn about and not a performance note.
//
// But the deciding question is narrower than a profile string, and measurement is why. All fourteen
// services captured in `fixtures/real-world-image-services.json` report
// `supportsAnyRegionAndSize` — so a plan keyed on "is this level 0" would send every real service
// down the cheap path, including **two that cannot serve it**: Cambridge Digital Library declares
// `maxWidth`/`maxHeight` of 2000 over a 4880×6174 image, and Micrio (as the Rijksmuseum runs it)
// declares `maxArea` of 17 550 000 over 27.7 megapixels. Asking either for the whole image is a 4xx
// — upstream's own `getImageUrl` throws `Width of requested image is too large: 4880 > 2000` rather
// than build the URL — or, worse on a lenient server, a silently smaller derivative tiled as though
// it were full resolution, which puts every Control Point in the wrong place.
//
// So the condition is "will this service serve the whole image in one request", which is
// `supportsAnyRegionAndSize` **and** the declared caps. The per-tile path then works for both of the
// cases that fail it, for the same reason: a tile is one tile wide, and a service that declares
// tiles it will not serve was already refused by `assertServiceWillServeItsOwnTiles`.

import type { Region } from '@allmaps/types';

import type { FetchFn } from '../injection/store-image-fetch.js';
import { MAX_INGEST_PIXELS } from '../tiler/decode-ceiling.js';
import { readImageHeader } from '../tiler/image-header.js';
import {
	ingestImageFile,
	type IngestProgress,
	type IngestResult,
	type OpenTileSource
} from '../tiler/ingest.js';
import type { ProjectStore } from '../store/project-store.js';
import type { RemoteImageService } from './image-service.js';

/**
 * Estimated bytes of pyramid per pixel of source image.
 *
 * **Measured**, and deliberately above the measurement. The committed 1200×851 pyramid in
 * `apps/editor/static/fixtures/images/floride-1657` — a real engraved chart, cut by the shipped tiler
 * at `TILE_JPEG_QUALITY` — is 29 tiles and 575 261 bytes, which is 0.563 bytes per source pixel across
 * the whole pyramid (all levels together add about a third again to the finest, so this figure already
 * includes them).
 *
 * 0.7 leaves about a quarter's headroom, and the direction of the margin is the point: this number's
 * only job is the ADR-0008 hosting warning, and an estimate that came in under the truth would be the
 * one that let a user walk off the cliff without being warned. Linework compresses worse than the
 * photographs most rules of thumb are calibrated on, so the true figure for a fine engraving is
 * higher than for a scan of a painting.
 */
export const ESTIMATED_OFFLINE_COPY_BYTES_PER_PIXEL = 0.7;

/** What a copy of a `width` × `height` image will add to the Workspace, roughly. */
export const estimateOfflineCopyBytes = (width: number, height: number): number =>
	Math.round(width * height * ESTIMATED_OFFLINE_COPY_BYTES_PER_PIXEL);

/**
 * The bounds this applies to bytes coming off somebody else's server.
 *
 * Ticket 13's review found the matching failure on the other untrusted path: a declared size trusted,
 * with nothing bounding it, and a truncated archive importing silently. So `responseBytes` is enforced
 * by **counting the bytes as they arrive** rather than by believing `content-length`, which a IIIF
 * service may omit and a hostile one may lie about.
 *
 * 256 MiB is far above any real `full/max` derivative — a 4000×3000 JPEG is a couple of megabytes —
 * and small enough that a response with no end cannot take the tab with it. The timeout is longer than
 * `REMOTE_IIIF_LIMITS.timeoutMs` because this really is a large download rather than a JSON document.
 */
export const OFFLINE_COPY_LIMITS = {
	responseBytes: 256 * 1024 * 1024,
	timeoutMs: 120_000
} as const;

export type OfflineCopyLimits = { readonly responseBytes: number; readonly timeoutMs: number };

/** Which of the two paths a copy takes. See the note at the top of this file. */
export type OfflineCopyPath = 'full-max' | 'assembled';

/** One 1:1 piece of the source, as the `assembled` path fetches it. */
export type OfflineCopyPiece = {
	readonly url: string;
	/** Where this piece belongs in the source, in source pixels. Its served size is the same. */
	readonly region: Region;
};

/** A fetched piece, ready to be stitched. */
export type OfflineCopyPiecePayload = OfflineCopyPiece & { readonly bytes: Blob };

/**
 * What a copy will do, decided before anything is fetched so the user can be told and can decline.
 *
 * Everything the dialog shows comes from here rather than being recomputed in the UI, so what the
 * user agreed to and what runs cannot differ: {@link makeOfflineCopy} takes the same plan back.
 *
 * **Decisions, not restatements.** Every field below is something `planOfflineCopy` worked out and nothing
 * else can; a number that is a pure function of two other fields is not carried, because a stored copy
 * of an arithmetic result is a thing that can disagree with the fields it was computed from. So the
 * estimated size is {@link estimateOfflineCopyBytes} of `width` and `height` at the one place that shows it,
 * and "is this more than one request" is `requests.length > 1` at the one place that asks.
 */
export type OfflineCopyPlan = {
	readonly path: OfflineCopyPath;
	readonly width: number;
	readonly height: number;
	/** The host this will ask, for the warning that has to name it. */
	readonly host: string;
	/**
	 * Every URL this will fetch, in order. One for `'full-max'`.
	 *
	 * Carried rather than derived from {@link pieces}, which only looks redundant: the `'full-max'`
	 * path has no pieces at all, and its one URL is the version-dependent spelling
	 * {@link wholeImageUrl} works out. This is the list, and `pieces` is the subset of it that has a
	 * region to stitch into.
	 */
	readonly requests: readonly string[];
	/** The pieces the `assembled` path stitches. `[]` for `'full-max'`. */
	readonly pieces: readonly OfflineCopyPiece[];
	/**
	 * Which of the service's own declared limits rules out one whole-image request, or `''`.
	 *
	 * A phrase rather than a boolean, because the warning quotes it: a user asking their librarian why
	 * a copy took five hundred requests needs the field name and the number.
	 */
	readonly cappedBy: string;
	/** Everything the user must be told before the copy starts, in the order to say it. */
	readonly notes: readonly string[];
	/** Why this cannot be copied at all, or `''`. */
	readonly refusal: string;
};

export type PlanOfflineCopyOptions = {
	/**
	 * Largest source a copy can be made of, in pixels. Defaults to the tiler's own `MAX_INGEST_PIXELS`.
	 *
	 * Overridable so a test can drive the refusal without a 528-megapixel fixture.
	 */
	readonly maxIngestPixels?: number;
};

/**
 * The copy will not happen, and why — in words a scholar can act on.
 *
 * Separate from `RemoteIiifRejectedError` and `RemoteImageUnusableError` because the recovery is
 * different again: the resource is fine and the host is fine, and what has gone wrong is this
 * particular copy. The Layer is untouched and still renders from the library.
 */
export class OfflineCopyRefusedError extends Error {
	readonly host: string;
	readonly url: string;

	constructor(options: { host: string; url: string; reason: string }) {
		super(options.reason);
		this.name = 'OfflineCopyRefusedError';
		this.host = options.host;
		this.url = options.url;
	}
}

/**
 * Decide how to copy this service, and what to tell the user first.
 *
 * Pure, and takes no `fetch`: everything here comes out of the `info.json` the service already
 * served, which is what lets the whole decision be asserted against a corpus of captured real-world
 * documents with no network at all.
 */
export function planOfflineCopy(
	service: RemoteImageService,
	options: PlanOfflineCopyOptions = {}
): OfflineCopyPlan {
	const { width, height, uri } = service;
	const host = hostOf(uri);
	// The tiler's own cap, because a copy meets it twice: the `assembled` path has to hold the whole
	// source at full resolution in one image in order to re-cut it, and the pyramid it then cuts is
	// `ingestImageFile`'s work either way. Refused up front and named, rather than discovered as a
	// dead tab after several thousand requests to somebody else's server.
	//
	// Note this is the *canvas* as well as the decode: ADR-0003 records that WebKit's canvas area
	// limit can be as low as 5 242 880 pixels, which the decode-and-crop tiler avoids by never making
	// a canvas larger than one tile. The `assembled` path cannot, so a large copy may fail on Safari
	// well below this bound. That is recorded rather than guessed at, here and in ADR-0027.
	const maxIngestPixels = options.maxIngestPixels ?? MAX_INGEST_PIXELS;

	const cappedBy = declaredCap(service);
	const wholeImageInOneRequest = service.pane.image.supportsAnyRegionAndSize && cappedBy === '';
	const path: OfflineCopyPath = wholeImageInOneRequest ? 'full-max' : 'assembled';

	const pieces = path === 'assembled' ? finestLevelPieces(service) : [];
	const requests =
		path === 'full-max' ? [wholeImageUrl(service)] : pieces.map((piece) => piece.url);

	const pixels = width * height;
	const notes: string[] = [];
	let refusal = '';

	if (path === 'assembled') {
		notes.push(
			cappedBy === ''
				? `${host} serves only the tiles it has already cut, so copying this map means ` +
						`${requests.length} separate requests to ${host} — one for every tile at full ` +
						`resolution. That is a real load on somebody else's server, and it is worth being sure ` +
						`you want the copy before starting it.`
				: `${host} declares ${cappedBy}, so it will not serve this ${width}×${height} image in ` +
						`one request. The copy is assembled from its own full-resolution tiles instead: ` +
						`${requests.length} separate requests to ${host}. That is a real load on somebody ` +
						`else's server.`
		);
	}

	// **One refusal for both paths, and it is a refusal rather than the warning it used to be**
	// (ADR-0027). An offline copy has to exist as one full-resolution image before it can be re-cut
	// — `full-max` downloads one and decodes it, `assembled` stitches thousands of pieces into one —
	// so both inherit the `createImageBitmap` decode ceiling and neither has anywhere to escape to.
	// The `needsStreamingTiler` note that used to stand here promised that a copy this size "needs
	// the streaming tiler", which is no longer true of any deployment and was never true of this
	// one; it closes v1 ticket 15's `[~]` criterion by removing the route it was hedging about.
	if (pixels > maxIngestPixels) {
		// One word for the thing throughout (CONTEXT.md, *Historical Map*: avoid map, image, scan,
		// source). This sentence used to say "this map … this Historical Map" in one breath.
		refusal =
			`At ${megapixels(pixels)} megapixels this Historical Map is past the ` +
			`${megapixels(maxIngestPixels)} megapixels a browser will decode in one piece, and an ` +
			`offline copy has to be held whole before it can be cut into tiles` +
			(path === 'assembled'
				? ` — ${host} serves only pre-cut tiles${cappedBy === '' ? '' : ` and ${cappedBy}`}, so ` +
					`the copy would have to be reassembled at full resolution first`
				: '') +
			`. Nothing has been copied and this Historical Map still works, read from ${host}. To hold ` +
			`it offline, ask whoever runs ${host} for the original file and prepare a IIIF pyramid from ` +
			`it outside the browser.`;
	}

	return {
		path,
		width,
		height,
		host,
		requests,
		pieces,
		cappedBy,
		notes,
		refusal
	};
}

/**
 * Which declared limit stops this service serving the whole image in one request, or `''`.
 *
 * `maxHeight` defaults to `maxWidth` because the Image API says it does — "if maxHeight is not
 * specified, it is assumed to be the same as maxWidth" — and a plan that read the absence literally
 * would ask a service that said 1000 for a 4000-pixel-tall image.
 */
function declaredCap(service: RemoteImageService): string {
	const { maxWidth, maxHeight, maxArea } = service.pane.image;
	const { width, height } = service;
	const effectiveHeight = maxHeight ?? maxWidth;

	if (typeof maxWidth === 'number' && width > maxWidth) {
		return `a maxWidth of ${maxWidth} pixels`;
	}
	if (typeof effectiveHeight === 'number' && height > effectiveHeight) {
		return maxHeight === undefined
			? `a maxHeight of ${effectiveHeight} pixels, implied by its maxWidth`
			: `a maxHeight of ${effectiveHeight} pixels`;
	}
	if (typeof maxArea === 'number' && width * height > maxArea) {
		return `a maxArea of ${maxArea} pixels`;
	}
	return '';
}

/**
 * The URL of the whole image at its full size, in the spelling this service's version understands.
 *
 * **Not built by `Image#getImageUrl`, and this is a real difference rather than a preference.**
 * `size=full` was removed in Image API 3 and `size=max` did not exist before 2.1, so asking either
 * version for the other's spelling is a 400 from a strict server. Upstream's `getImageUrl` emits
 * `full/full` for a version 3 service — recorded with the ticket as an upstream defect — and it
 * cannot express `max` at all: passing `{ region: 'full', size: 'max' }` produces
 * `undefined,undefined,undefined,undefined/NaN,NaN`.
 */
function wholeImageUrl(service: RemoteImageService): string {
	const size = service.pane.image.majorVersion >= 3 ? 'max' : 'full';
	return `${service.uri}/full/${size}/0/default.jpg`;
}

/**
 * The service's own full-resolution tiles: every tile at scale factor 1.
 *
 * These are the **only** geometry a stranger's server is trusted for, and they are the safe kind:
 * scale factor 1 means the region is served at its own size, so there is no resize to get wrong.
 * A server that answers with the wrong number of pixels is caught by the stitcher measuring what it
 * decoded, and a wrong answer there is a piece that will not fit rather than a sub-pixel stretch
 * nobody can see.
 */
function finestLevelPieces(service: RemoteImageService): OfflineCopyPiece[] {
	return service.pane
		.allTiles()
		.filter((tile) => tile.scaleFactor === 1)
		.map((tile) => {
			const { region, size } = tile.request;
			if (size.width !== region.width || size.height !== region.height) {
				// Unreachable for a scale factor of 1, where `getTileImageRequest` returns the region's own
				// dimensions as the size. Stated because the whole argument above rests on it: if the parser
				// ever changed, the pieces would silently stop being 1:1 crops and the stitch would resample.
				throw new Error(
					`A scale factor 1 tile of ${service.uri} is served at ${size.width}×${size.height} for a ` +
						`${region.width}×${region.height} region, so it is not a 1:1 crop and cannot be stitched.`
				);
			}
			return { url: tile.url, region };
		});
}

/** What the UI needs in order to say something true while a copy runs (SPEC stories 28, 96). */
export type OfflineCopyProgress = {
	readonly phase: 'fetching' | 'assembling' | 'tiling' | 'done';
	readonly requestsDone: number;
	readonly requestCount: number;
	/** The ingest underneath, once it is running. `null` before that. */
	readonly ingest: IngestProgress | null;
	/** 0 to 1. Monotonic, and never 1 before the pyramid is complete. */
	readonly fraction: number;
};

/**
 * How much of the bar the fetching gets.
 *
 * Fetching and tiling are both real work and neither dominates: a `full-max` copy is one download and
 * thousands of tile encodes, an `assembled` copy is thousands of downloads and the same encodes. One
 * split rather than one per path, because a bar whose meaning changes between two runs of the same
 * action is worse than a bar that is only roughly right.
 */
const FETCH_SHARE = 0.3;

export type MakeOfflineCopyOptions = {
	readonly store: ProjectStore;
	readonly service: RemoteImageService;
	/** What to call this Historical Map. The library's label, normally. */
	readonly label?: string;
	/** How the network is reached. The ADR-0011 shim passes a remote host straight through. */
	readonly fetch: FetchFn;
	/** How fetched pieces become one image. See {@link AssembleImage}. */
	readonly assemble: AssembleImage;
	readonly openDecodeAndCrop: OpenTileSource;
	readonly maxIngestPixels?: number;
	/**
	 * The plan the user was shown, so that what was agreed to is what runs.
	 *
	 * Recomputed when absent. Passing it matters because the plan is what the rights statement, the
	 * request count, and the size warning were displayed beside — a copy that quietly took a different
	 * path would have been agreed to on the strength of a different sentence.
	 */
	readonly plan?: OfflineCopyPlan;
	readonly limits?: Partial<OfflineCopyLimits>;
	readonly onProgress?: (progress: OfflineCopyProgress) => void;
	readonly signal?: AbortSignal;
};

export type OfflineCopyResult = {
	/** `generateId(uri)`, unchanged by the copy. */
	readonly imageId: string;
	readonly path: OfflineCopyPath;
	/** Every URL that was actually fetched. The last requests this image will ever need. */
	readonly requests: readonly string[];
	readonly bytesFetched: number;
	/** The pyramid, as ticket 05 reports it. */
	readonly ingest: IngestResult;
};

/**
 * Stitch 1:1 pieces of a source image back into one image, and hand back its bytes.
 *
 * Injected for the same two reasons `MeasureTile` is: the browser's answer is `createImageBitmap`
 * and a canvas, neither of which exists in Node, and *using* the browser's own decoder is half the
 * point — a piece this cannot decode is a piece that would not have reached a WebGL texture either.
 *
 * **Implementations must refuse a piece whose decoded dimensions are not its region's dimensions.**
 * That is the exact-resize check applied to every piece rather than to one probe tile, and it is what
 * makes the stitch a copy rather than a resample: a piece drawn at a size it was not served at would
 * shift everything to the right of it.
 */
export type AssembleImage = (
	dimensions: { readonly width: number; readonly height: number },
	pieces: readonly OfflineCopyPiecePayload[]
) => Promise<Blob>;

/**
 * Copy a referenced remote Historical Map into the Workspace as local tiles.
 *
 * **Writes nothing until the pixels are in hand**, and then writes only through
 * `ingestImageFile` — so a copy that fails or is cancelled leaves the Workspace exactly as it was, the
 * Layer still `'referenced'`, and the map still rendering from the library. That is not this
 * function's own discipline: `ingestImageFile` writes `info.json` last and removes what it wrote on
 * failure, and everything here happens before it or is delegated to it.
 *
 * The `remote.json` record beside the image is deliberately **not** touched. It is the citation
 * ADR-0007 exists to protect, and a copy that orphaned it would have thrown away the one thing that
 * says where this map came from.
 */
export async function makeOfflineCopy(options: MakeOfflineCopyOptions): Promise<OfflineCopyResult> {
	const { store, service, fetch, assemble, signal } = options;
	const limits: OfflineCopyLimits = { ...OFFLINE_COPY_LIMITS, ...options.limits };
	const plan = options.plan ?? planOfflineCopy(service, options);
	const host = plan.host;

	if (plan.refusal !== '') {
		throw new OfflineCopyRefusedError({ host, url: service.uri, reason: plan.refusal });
	}

	let requestsDone = 0;
	let bytesFetched = 0;
	let ingest: IngestProgress | null = null;

	const report = (phase: OfflineCopyProgress['phase']) => {
		const fetched = plan.requests.length === 0 ? 1 : requestsDone / plan.requests.length;
		options.onProgress?.({
			phase,
			requestsDone,
			requestCount: plan.requests.length,
			ingest,
			// Clamped below 1 until `done`, the same rule `IngestProgress.fraction` follows: a bar sitting
			// at 100% while a job is still running is the failure story 28 is written against.
			fraction:
				phase === 'done'
					? 1
					: Math.min(0.99, FETCH_SHARE * fetched + (1 - FETCH_SHARE) * (ingest?.fraction ?? 0))
		});
	};

	const fetchPiece = async (url: string): Promise<Blob> => {
		signal?.throwIfAborted();
		const bytes = await fetchBounded(url, { fetch, host, limits, signal });
		bytesFetched += bytes.size;
		requestsDone += 1;
		report('fetching');
		return bytes;
	};

	report('fetching');
	signal?.throwIfAborted();

	let source: Blob;

	if (plan.path === 'full-max') {
		const url = plan.requests[0] as string;
		source = await fetchPiece(url);
		await assertServedTheWholeImage(source, { service, plan, url });
	} else {
		const pieces: OfflineCopyPiecePayload[] = [];
		for (const piece of plan.pieces) {
			pieces.push({ ...piece, bytes: await fetchPiece(piece.url) });
		}
		report('assembling');
		signal?.throwIfAborted();
		try {
			source = await assemble({ width: plan.width, height: plan.height }, pieces);
		} catch (cause) {
			throw new OfflineCopyRefusedError({
				host,
				url: service.uri,
				reason:
					`The ${pieces.length} tiles ${host} served could not be put back together into one ` +
					`${plan.width}×${plan.height} image: ${message(cause)}. Nothing has been copied and this ` +
					`Historical Map still works, read from ${host}.`
			});
		}
	}

	report('tiling');
	signal?.throwIfAborted();

	const result = await ingestImageFile({
		store,
		file: source,
		// The whole reason ingest takes an id: making an offline copy must not change it. ADR-0015's `generateId(uri)`
		// is what every Alignment in the Workspace names and what `annotations.allmaps.org` keys the image
		// on, so a copy that minted a fresh one would break both while looking like it had worked.
		imageId: service.imageId,
		...(options.label === undefined ? {} : { label: options.label }),
		openDecodeAndCrop: options.openDecodeAndCrop,
		...(options.maxIngestPixels === undefined ? {} : { maxIngestPixels: options.maxIngestPixels }),
		...(signal === undefined ? {} : { signal }),
		onProgress: (progress) => {
			ingest = progress;
			report('tiling');
		}
	});

	// Belt as well as braces. The header check above is the cheap one and runs before any byte is
	// written; this is the authoritative one, because the dimensions here are the decoder's rather than
	// a container's declaration — and a pyramid at the wrong resolution is a map whose every Control
	// Point is in the wrong place, not a smaller map.
	if (result.width !== service.width || result.height !== service.height) {
		await removePyramid(store, result.directory);
		throw new OfflineCopyRefusedError({
			host,
			url: plan.requests[0] ?? service.uri,
			reason: servedWrongSizeReason({
				host,
				service,
				served: { width: result.width, height: result.height }
			})
		});
	}

	report('done');

	return {
		imageId: result.imageId,
		path: plan.path,
		requests: plan.requests,
		bytesFetched,
		ingest: result
	};
}

/**
 * Refuse a `full/max` response that is not the size the service said the image is.
 *
 * Checked from the container's header — before a single byte is written, and without decoding
 * anything — because this is the failure mode a lenient server has: `max` is defined as "the largest
 * size this server will serve", so a service that caps without declaring it answers with a smaller
 * derivative and a `200`. Tiling that would produce a pyramid whose pixel coordinates are not the ones
 * every Control Point, every community Alignment, and the `remote.json` record are written in.
 *
 * An unrecognised container falls through, and the post-ingest check catches it from the decoder's own
 * dimensions instead.
 */
async function assertServedTheWholeImage(
	blob: Blob,
	context: { service: RemoteImageService; plan: OfflineCopyPlan; url: string }
): Promise<void> {
	const { service, plan, url } = context;
	const header = readImageHeader(new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer()));
	if (!header) return;
	if (header.width === service.width && header.height === service.height) return;

	throw new OfflineCopyRefusedError({
		host: plan.host,
		url,
		reason: servedWrongSizeReason({ host: plan.host, service, served: header })
	});
}

const servedWrongSizeReason = (context: {
	host: string;
	service: RemoteImageService;
	served: { width: number; height: number };
}): string =>
	`${context.host} describes this map as ${context.service.width}×${context.service.height} pixels ` +
	`but served a ${context.served.width}×${context.served.height} image for the whole of it. ` +
	`Ballastella refuses that rather than copying it: every Control Point, and every alignment anyone ` +
	`has published for this image, is measured in the pixels the service declared — so a copy at a ` +
	`different size would put the whole map in the wrong place while looking perfectly fine. Nothing ` +
	`has been copied and this Historical Map still works, read from ${context.host}.`;

/** Remove a pyramid this function wrote and then refused. Best effort; nothing reads it either way. */
async function removePyramid(store: ProjectStore, directory: string): Promise<void> {
	const paths = await store.list(`${directory}/`).catch(() => []);
	await Promise.all(paths.map((path) => store.delete(path).catch(() => undefined)));
}

/**
 * One URL's bytes, under every bound in {@link OfflineCopyLimits}.
 *
 * The bytes are counted as they arrive rather than taken from `content-length`, which is the same
 * discipline `fetchRemoteJson` applies to a IIIF document and for the same reason: a declared size is
 * a claim. The caller's `signal` and the timeout are both wired to one controller, so cancelling a
 * copy abandons the download in flight instead of waiting for it.
 */
async function fetchBounded(
	url: string,
	options: {
		fetch: FetchFn;
		host: string;
		limits: OfflineCopyLimits;
		signal: AbortSignal | undefined;
	}
): Promise<Blob> {
	const { host, limits } = options;
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), limits.timeoutMs);
	const cancel = () => abort.abort();
	options.signal?.addEventListener('abort', cancel, { once: true });

	const refuse = (reason: string) => new OfflineCopyRefusedError({ host, url, reason });

	try {
		let response: Response;
		try {
			response = await options.fetch(url, { signal: abort.signal });
		} catch (cause) {
			// The caller's cancellation is not a refusal to report — it is what the user asked for — so it
			// is rethrown as itself and the copy's own cleanup handles it.
			options.signal?.throwIfAborted();
			throw refuse(
				abort.signal.aborted
					? `${host} did not finish sending this map within ` +
							`${Math.round(limits.timeoutMs / 1000)} seconds. Nothing has been copied.`
					: `${host} could not be reached for ${url} (${message(cause)}). Nothing has been copied.`
			);
		}

		if (!response.ok) {
			throw refuse(
				`${host} answered ${response.status}${
					response.statusText ? ` ${response.statusText}` : ''
				} for ${url}. Nothing has been copied, and this Historical Map still works read from ${host}.`
			);
		}

		const body = response.body;
		if (!body) {
			const blob = await response.blob();
			if (blob.size > limits.responseBytes) throw refuse(tooLarge(host, blob.size, limits));
			return blob;
		}

		const reader = body.getReader();
		const chunks: Uint8Array[] = [];
		let read = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				read += value.byteLength;
				if (read > limits.responseBytes) throw refuse(tooLarge(host, read, limits));
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}

		return new Blob(chunks as BlobPart[], {
			type: response.headers.get('content-type') ?? 'application/octet-stream'
		});
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', cancel);
	}
}

const tooLarge = (host: string, bytes: number, limits: OfflineCopyLimits): string =>
	`${host} is sending an image larger than the ` +
	`${Math.round(limits.responseBytes / (1024 * 1024))} MB Ballastella will hold in one piece ` +
	`(${bytes} bytes so far). Nothing has been copied.`;

/**
 * Stitch the pieces with a canvas — the browser implementation of {@link AssembleImage}.
 *
 * PNG rather than JPEG, and that is not incidental: the tiler is about to encode every tile as JPEG,
 * and a lossy intermediate between the library's pixels and those tiles would put a second generation
 * of compression artefacts into an archival copy for nothing. The intermediate is discarded as soon as
 * the tiler has read it.
 *
 * Every piece's decoded dimensions are compared with its region's, which is the exact-resize check
 * applied to all of them rather than to one probe (see {@link AssembleImage}).
 */
export const assembleWithCanvas: AssembleImage = async (dimensions, pieces) => {
	const canvas = new OffscreenCanvas(dimensions.width, dimensions.height);
	const context = canvas.getContext('2d');
	if (!context) {
		throw new Error(
			`No 2d context for a ${dimensions.width}×${dimensions.height} canvas, so the tiles this host ` +
				`serves cannot be put back together. That is a limit on how large an image this browser will ` +
				`hold at once, not a problem with the map.`
		);
	}

	for (const piece of pieces) {
		const bitmap = await createImageBitmap(piece.bytes);
		try {
			if (bitmap.width !== piece.region.width || bitmap.height !== piece.region.height) {
				throw new Error(
					`a tile covering ${piece.region.width}×${piece.region.height} pixels arrived as ` +
						`${bitmap.width}×${bitmap.height} (${piece.url})`
				);
			}
			// 1:1, so no filtering is involved at all and the copy is exact.
			context.drawImage(bitmap, piece.region.x, piece.region.y);
		} finally {
			bitmap.close();
		}
	}

	return canvas.convertToBlob({ type: 'image/png' });
};

const megapixels = (pixels: number): number => Math.round(pixels / 1e6);

const hostOf = (url: string): string => {
	try {
		return new URL(url).hostname;
	} catch {
		return '';
	}
};

const message = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);
