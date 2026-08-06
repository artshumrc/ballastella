// The add-time gate on a remote image service: can this host's tiles actually reach a WebGL
// texture, and does it serve the pixels it was asked for?
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY AT ADD TIME AND NOT AT RENDER TIME
//
// ADR-0007. `@allmaps/maplibre` uploads every tile into a WebGL texture, which requires the
// response to be cross-origin *readable* — not merely fetchable. Most IIIF services send
// `Access-Control-Allow-Origin: *`, and most of the rest reflect the requesting origin, but not
// all do: `viewerd.kbr.be` answers with a single allowlisted origin that is not ours. **Without
// that header the map renders blank with no error at all** — unactionable for a humanities
// scholar, and a support request for whoever maintains this. So the question is asked once, at
// the moment the user adds the resource, when there is still a dialog to put the answer in.
//
// Mirroring is not a way round it (ticket 15): an offline copy has to fetch the tiles too.
//
// **`info.json` and one tile are both probed, and the tile is the one that matters.** They are
// commonly served by different infrastructure — a JSON endpoint behind one proxy, image bytes
// behind a CDN — so a gate that checks only `info.json` passes a naive test and then ships
// exactly the blank map it was written to prevent.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// AND WHILE WE HAVE A TILE IN HAND: THE EXACT-RESIZE ASSUMPTION
//
// `ImagePaneTile.placement` is `region ÷ scaleFactor`, which is right only under IIIF's own
// semantics for `size=w,h`: the returned image *is* exactly w×h pixels and its full extent is
// the full extent of the requested region. Ticket 05 asserts our own tiler honours that. **We
// cannot assert it of a stranger's server** — and the error, up to 0.6% at the right and bottom
// margins of a ragged tile, is sub-pixel, systematic, and invisible to every other test.
//
// So the one thing that *is* checkable is checked, on the one tile that can show it: the probe
// tile is ragged (see `chooseProbeTiles`), and its **decoded** dimensions must equal the dimensions
// that were requested. That catches every server that rounds, floors, pads to a whole tile, or
// silently substitutes a size — the whole class of "the map is very slightly stretched and nobody
// can tell why".
//
// What it cannot catch is a server that returns the right dimensions having *padded* rather than
// resized within them. Detecting that would mean decoding a full-resolution tile as well and
// comparing pixels, per service, on every add — expensive, and a false positive on any lossily
// compressed tile. So it is tolerated and written down rather than detected: the residue is bounded
// at 0.6% of one tile along two margins of the sheet, it is inside the same order as the JPEG noise
// the tiles already carry, and "make an offline copy" removes it outright by re-cutting the pyramid
// with the tiler ticket 05 *does* assert exact-resize of.

import type { FetchFn } from '../injection/store-image-fetch.js';
import type { RemoteImageService } from './image-service.js';
import { REMOTE_IIIF_LIMITS } from './remote-resource.js';

/** Which half of the gate refused, so a caller can say something specific. */
export type RemoteProbeStage =
	/** The `info.json` could not be read cross-origin. */
	| 'info'
	/** A tile could not be read cross-origin — the failure that renders a blank map. */
	| 'tile'
	/** The tile arrived, and is not the size it was asked for. */
	| 'geometry';

/**
 * This host's images cannot be drawn, and why.
 *
 * Separate from `RemoteIiifRejectedError` because the recovery is different: that one means the
 * document is wrong, this one means the *host's policy or server* is wrong, and the only things
 * the user can do about it are ask the institution to allow cross-origin reads or download the
 * image and add it from a file.
 */
export class RemoteImageUnusableError extends Error {
	readonly host: string;
	readonly url: string;
	readonly stage: RemoteProbeStage;

	constructor(options: { host: string; url: string; stage: RemoteProbeStage; reason: string }) {
		super(options.reason);
		this.name = 'RemoteImageUnusableError';
		this.host = options.host;
		this.url = options.url;
		this.stage = options.stage;
	}
}

/**
 * How a fetched tile's real pixel dimensions are measured.
 *
 * Injected because the browser's answer is `createImageBitmap`, which does not exist in Node,
 * and because *using* it is half the point: `createImageBitmap` on a `Blob` from a
 * non-CORS-readable response is precisely the operation `@allmaps/maplibre` performs before the
 * texture upload, so a probe that succeeds here has demonstrated the thing that matters rather
 * than argued for it.
 */
export type MeasureTile = (bytes: Blob) => Promise<{ width: number; height: number }>;

/** `createImageBitmap`, as the browser provides it. Not used in Node. */
export const measureTileWithImageBitmap: MeasureTile = async (bytes) => {
	const bitmap = await createImageBitmap(bytes);
	try {
		return { width: bitmap.width, height: bitmap.height };
	} finally {
		bitmap.close();
	}
};

export type ProbeRemoteImageOptions = {
	readonly fetch: FetchFn;
	readonly measureTile: MeasureTile;
	readonly timeoutMs?: number;
};

/**
 * What the gate found, when it did not refuse.
 *
 * **Nothing shows this yet.** It is returned so that a caller can tell the user which requests were
 * made on their behalf — the community lookup discloses itself (ADR-0015) and a probe of a third
 * party's server has the same claim on being disclosed — but the one call site,
 * `add-remote-map.svelte.ts`, discards it. Surfacing it is a line beside the "checking Allmaps…"
 * note in the add flow, listing {@link tileUrls}; until that exists the fields are asserted by
 * `cors-probe.test.ts` and read by nothing else, which is said here rather than left to be
 * discovered.
 */
export type RemoteImageProbe = {
	readonly host: string;
	/** Every tile URL that was fetched, in the order they were fetched. */
	readonly tileUrls: readonly string[];
	/** Whether a ragged tile was among them, and so whether the exact-resize check meant anything. */
	readonly checkedGeometry: boolean;
};

/**
 * Fetch `info.json` and one tile under CORS, and refuse the resource if either cannot be read.
 *
 * Throws {@link RemoteImageUnusableError} naming the host. Never resolves for a host whose tiles
 * would render blank.
 */
export async function probeRemoteImageService(
	service: RemoteImageService,
	options: ProbeRemoteImageOptions
): Promise<RemoteImageProbe> {
	const host = new URL(service.uri).hostname;
	const timeoutMs = options.timeoutMs ?? REMOTE_IIIF_LIMITS.timeoutMs;
	const infoUrl = `${service.uri}/info.json`;

	// The `info.json` half. It has already been fetched once to get here, but not necessarily by
	// the browser under CORS — a captured document, a mirrored copy, or an embedded service
	// description in a Manifest all reach `acceptRemoteImageService` without a cross-origin read.
	// Asking again is one request and removes the case where the gate only *looks* like it ran.
	await readOrRefuse(infoUrl, {
		...options,
		host,
		stage: 'info',
		timeoutMs,
		reason: (detail) =>
			`${host} will not let another website read its image descriptions${detail}. Ballastella ` +
			`needs to read ${infoUrl} from your browser, and this host does not send the ` +
			`Access-Control-Allow-Origin header that permits it. Nothing has been added. Ask whoever ` +
			`runs ${host} to allow cross-origin reads — most IIIF services do — or download the image ` +
			`and add it from a file.`
	});

	const tileUrls: string[] = [];

	for (const tile of service.probeTiles) {
		const tileUrl = tile.url;
		tileUrls.push(tileUrl);

		const synthesised = tile.scaleFactor === service.synthesisedCoarsestScaleFactor;
		const tileBytes = await readOrRefuse(tileUrl, {
			...options,
			host,
			stage: 'tile',
			timeoutMs,
			reason: (detail) =>
				synthesised
					? // A level this app worked out rather than one the service declared — see
						// `extendedTileset`. The service said it serves any region at any size, and it does
						// not, so the honest report says exactly that rather than blaming CORS.
						`${host} declares tiles only down to a zoom at which this image is still ` +
						`${Math.ceil(service.width / (service.tileSize * (service.synthesisedCoarsestScaleFactor ?? 1)))} ` +
						`tiles across, and it also declares that it serves any region at any size — so ` +
						`Ballastella asked for the wider tile it needs to show the whole sheet at once, and ` +
						`the answer was no${detail}. Nothing has been added. The request was ${tileUrl}.`
					: `${host} serves its image descriptions to other websites but not its image ` +
						`tiles${detail}. Ballastella draws a Historical Map by uploading tiles into the ` +
						`graphics card, which the browser only permits for a response marked readable ` +
						`cross-origin — so this map would appear completely blank with nothing to say why. ` +
						`Nothing has been added. The tile that was refused is ${tileUrl}.`
		});

		const requested = tile.request.size;
		let measured: { width: number; height: number };
		try {
			measured = await options.measureTile(tileBytes);
		} catch (cause) {
			throw new RemoteImageUnusableError({
				host,
				url: tileUrl,
				stage: 'tile',
				reason:
					`${host} answered for a tile, but your browser could not decode it as an image ` +
					`(${message(cause)}). Ballastella has to be able to read a tile's pixels to draw it, so ` +
					`this map would render blank. Nothing has been added. The tile was ${tileUrl}.`
			});
		}

		if (measured.width !== requested.width || measured.height !== requested.height) {
			throw new RemoteImageUnusableError({
				host,
				url: tileUrl,
				stage: 'geometry',
				reason:
					`${host} served a ${measured.width}×${measured.height} tile where Ballastella asked ` +
					`for ${requested.width}×${requested.height}. IIIF's size parameter means the returned ` +
					`image *is* exactly that many pixels, and Ballastella places every tile on that basis — ` +
					`so a service that rounds, pads, or substitutes a size draws this map slightly stretched ` +
					`at its right and bottom edges, which looks like an imprecise alignment rather than ` +
					`like a broken service. That is why this is refused instead of drawn. Nothing has been ` +
					`added; “make an offline copy” re-cuts the tiles with Ballastella's own geometry and ` +
					`avoids the problem entirely. The tile was ${tileUrl}.`
			});
		}
	}

	return { host, tileUrls, checkedGeometry: service.probeTileIsRagged };
}

/**
 * Fetch one URL and hand back its bytes, or refuse with the caller's sentence.
 *
 * **A cross-origin `fetch` that the host does not permit rejects**, so the `catch` here *is* the
 * CORS failure in a real browser; a 4xx or 5xx is a different fault and is reported with its
 * status. Both land in the same refusal because the user's options are the same either way, and
 * the detail says which happened.
 */
async function readOrRefuse(
	url: string,
	options: ProbeRemoteImageOptions & {
		host: string;
		stage: RemoteProbeStage;
		timeoutMs: number;
		reason: (detail: string) => string;
	}
): Promise<Blob> {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), options.timeoutMs);
	try {
		let response: Response;
		try {
			// No `mode` and no `credentials`: the page's own `fetch` defaults are `cors` and
			// `same-origin`, which is exactly the request `@allmaps/maplibre` will make. Setting
			// `mode: 'no-cors'` here would make the probe pass for every host on earth and hand back
			// an opaque response — the single most tempting way to make this gate useless.
			response = await options.fetch(url, { signal: abort.signal });
		} catch (cause) {
			throw new RemoteImageUnusableError({
				host: options.host,
				url,
				stage: options.stage,
				reason: options.reason(
					abort.signal.aborted ? ' (it did not answer in time)' : ` (${message(cause)})`
				)
			});
		}

		if (!response.ok) {
			throw new RemoteImageUnusableError({
				host: options.host,
				url,
				stage: options.stage,
				reason: options.reason(` — it answered ${response.status}`)
			});
		}

		try {
			return await response.blob();
		} catch (cause) {
			// An opaque response reaching here means somebody made the request `no-cors`. Reading its
			// body yields nothing, and that is the state this whole module exists to refuse.
			throw new RemoteImageUnusableError({
				host: options.host,
				url,
				stage: options.stage,
				reason: options.reason(` (its response could not be read: ${message(cause)})`)
			});
		}
	} finally {
		clearTimeout(timer);
	}
}

const message = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);
