// One remote IIIF image service, read and judged: is this a Historical Map this app can
// actually draw, and what is its identity?
//
// This is the module where ticket 03's guards stop being theoretical. Everything before this
// slice parsed an `info.json` that *this app wrote*, so a pyramid whose finest level is not full
// resolution, or whose levels disagree about tile size, could not occur. Here the document comes
// from somebody else's server, so both can — and both render *plausibly and wrongly* rather than
// failing. `createImagePane` refuses them; this module's job is to turn each refusal into a
// sentence that names the host, because "the pane is blank" is not a bug report a scholar can
// file and "scale factors must be 1, 2, 4, …" is not one they can act on.
//
// **The guards are not relaxed for a real service.** If a library's service trips one, the
// answer is a legible refusal and an offline copy (ticket 15, which re-tiles it with our own
// geometry), never a guard loosened until the pane draws something.

import { generateId } from '@allmaps/id';
import { Image } from '@allmaps/iiif-parser';

import {
	createImagePane,
	type ImagePane,
	type ImagePaneTile
} from '../image-pane/iiif-image-pane.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import {
	REMOTE_IIIF_LIMITS,
	RemoteIiifRejectedError,
	fetchRemoteJson,
	remoteIiifUrl,
	type RemoteIiifLimits
} from './remote-resource.js';

/**
 * Largest image, in pixels, this will accept a reference to.
 *
 * A bound on a number a stranger declared, in the spirit of ticket 13's review: `width` and
 * `height` come out of the document and are multiplied together in several places before
 * anything is fetched. 4 gigapixels is about eight times the largest map sheet in the Library of
 * Congress' collection and still nowhere near overflowing anything; what it refuses is a
 * document claiming 2³¹ × 2³¹.
 */
export const MAX_REMOTE_IMAGE_PIXELS = 4_000_000_000;

/**
 * A remote image service this app is willing to draw, with its identity settled.
 *
 * The pyramid reader is on it rather than beside it, because building one is how every guard was
 * checked — so a `RemoteImageService` that exists is one whose geometry has already been
 * accepted, and no caller can get an unchecked one.
 */
export type RemoteImageService = {
	/**
	 * The canonical service URI: the `id` the service's own `info.json` declares, with any
	 * trailing slash removed.
	 *
	 * **Not the URL the user pasted, and the difference is real.** `ids.lib.harvard.edu` answers
	 * `…/ids/iiif/47174896/info.json` with a document whose `id` is on `mps.lib.harvard.edu`; the
	 * IIIF Image API requires `id` to be the base every image request is built on, so this is the
	 * one that works. Using it is also what makes {@link imageId} stable across the several URLs
	 * that redirect to one service, and what makes it agree with the identifier
	 * `annotations.allmaps.org` holds — see {@link imageId}.
	 */
	readonly uri: string;
	/** The URL that was actually fetched, kept so a refusal can name what the user typed. */
	readonly requestedUrl: string;
	/**
	 * `generateId(uri)` — the identifier Allmaps itself uses (ADR-0015).
	 *
	 * Not an arbitrary choice and not merely "deterministic": measured against the live API on
	 * 2026-08-06, `https://annotations.allmaps.org/?url=<uri>/info.json` **redirects to
	 * `/images/<generateId(uri)>`**, so this value *is* the key the community lookup is keyed on.
	 * That is the whole mechanism behind "3 existing alignments found" costing a dozen lines
	 * rather than being a feature.
	 *
	 * A locally ingested image gets `generateRandomId()` instead (ticket 05): there is no URI to
	 * hash, and two ingests of one file are two Historical Maps.
	 */
	readonly imageId: string;
	readonly width: number;
	readonly height: number;
	/** Tile side in pixels, as the service declares it. Square, or `createImagePane` refused it. */
	readonly tileSize: number;
	/** The `info.json` exactly as it arrived. */
	readonly info: unknown;
	/** The accepted pyramid reader. Its guards have all run. */
	readonly pane: ImagePane;
	/**
	 * The tiles to fetch at add time. See `cors-probe.ts`.
	 *
	 * The first is a **ragged** tile at full resolution wherever the image has one, which is what
	 * makes one request answer both the CORS question and the exact-resize question. A second is
	 * added when {@link synthesisedCoarsestScaleFactor} is set, because that level is one this app
	 * worked out rather than one the service declared, and asking for a tile is the only honest way
	 * to find out whether the service will really serve it.
	 */
	readonly probeTiles: readonly ImagePaneTile[];
	/** Whether the full-resolution probe tile really is ragged, i.e. not a whole tile. */
	readonly probeTileIsRagged: boolean;
	/**
	 * The coarsest scale factor this app added to the service's declared pyramid, or `null` when it
	 * added none. See {@link extendedTileset}.
	 */
	readonly synthesisedCoarsestScaleFactor: number | null;
};

export type ReadRemoteImageServiceOptions = {
	readonly fetch: FetchFn;
	readonly limits?: Partial<RemoteIiifLimits>;
};

/**
 * Read the image service at `uri` and decide whether it can be used.
 *
 * `uri` is an image service base — no `/info.json`, no region and size. That is what crosses the
 * parser boundary from triiiceratops (ADR-0018) and what a user pastes for a bare service. A
 * URL ending in `/info.json` is accepted too, because it is what a user copies out of a browser
 * address bar, and trimming it here is better than a refusal that reads as pedantry.
 */
export async function readRemoteImageService(
	uri: string,
	options: ReadRemoteImageServiceOptions
): Promise<RemoteImageService> {
	const requested = remoteIiifUrl(uri);
	const base = requested.href.replace(/\/info\.json$/, '').replace(/\/$/, '');
	const infoUrl = remoteIiifUrl(`${base}/info.json`);
	const limits = { ...REMOTE_IIIF_LIMITS, ...options.limits };
	const info = await fetchRemoteJson(infoUrl, { fetch: options.fetch, limits });

	return acceptRemoteImageService(info, { requestedUrl: infoUrl.href, fallbackUri: base });
}

/**
 * Judge an `info.json` that has already been fetched, and mint its identity.
 *
 * Split from the fetch so that every guard is testable against a captured real-world document
 * with no network at all — which is the only way to have a test corpus of awkward services — and
 * so that a Manifest whose canvas carries an embedded `info.json` needs no second request.
 */
export async function acceptRemoteImageService(
	info: unknown,
	context: { requestedUrl: string; fallbackUri: string }
): Promise<RemoteImageService> {
	const host = hostOf(context.requestedUrl);
	const declaredId = readDeclaredId(info);
	// A document with no `id` at all is not spec-legal, but it happens, and the URL it was fetched
	// from is the only other candidate — IIIF's own rule for a service is that its base is where
	// its `info.json` lives, so this is the same answer by a different route.
	const uri = (declaredId ?? context.fallbackUri).replace(/\/$/, '');

	assertDeclaredSizeIsSane(info, { url: context.requestedUrl, host });

	const refuse = (cause: unknown) =>
		new RemoteIiifRejectedError({
			url: context.requestedUrl,
			host,
			reason:
				`Ballastella cannot draw the image service at ${host}: ${message(cause)}\n\n` +
				`This is a refusal rather than a blank map on purpose. Every shape refused here is one ` +
				`that would otherwise render something plausible and wrong. If you need this map, use ` +
				`“make an offline copy” — Ballastella then re-cuts its own tiles — or add the image ` +
				`from a file.`
		});

	let pane: ImagePane;
	let synthesised: number | null = null;

	try {
		pane = createImagePane(info, uri);
	} catch (declaredFault) {
		const extended = extendedTileset(info);
		if (!extended) throw refuse(declaredFault);
		try {
			pane = createImagePane(extended.info, uri);
		} catch {
			// The extension did not help, so the real fault is whatever the service's own declaration
			// was. Reporting *our* second failure here would blame the user for something this app did.
			throw refuse(declaredFault);
		}
		synthesised = extended.coarsest;
	}

	assertServiceWillServeItsOwnTiles(pane, { url: context.requestedUrl, host });

	const probeTiles = chooseProbeTiles(pane, synthesised);
	const raggedProbe = probeTiles[0] as ImagePaneTile;

	return {
		uri,
		requestedUrl: context.requestedUrl,
		imageId: await generateId(uri),
		width: pane.image.width,
		height: pane.image.height,
		tileSize: pane.tileSize,
		info,
		pane,
		probeTiles,
		probeTileIsRagged:
			raggedProbe.request.size.width < pane.tileSize ||
			raggedProbe.request.size.height < pane.tileSize,
		synthesisedCoarsestScaleFactor: synthesised
	};
}

/**
 * The same `info.json` with enough extra coarse levels that its coarsest level is a single tile —
 * or `null` when that is not the problem, or not something this app may do.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY IT IS NOT A LOOSENED GUARD
 *
 * `createSyntheticProjection` requires the coarsest level to reduce the whole image to one tile,
 * because the synthetic window *is* that tile and the whole Mercator grid alignment rests on it.
 * Our own tiler satisfies that by construction — `pyramidScaleFactors` runs up to exactly that
 * factor — so nothing before this slice could fail it.
 *
 * **Real IIIF services routinely do not satisfy it, and nothing in the Image API says they must.**
 * Measured over the fourteen live services captured in `fixtures/real-world-image-services.json`:
 * three fall short, and two of the three are the IIIF Image API's *own* reference examples (a
 * 4032×3024 image with 512px tiles and scale factors 1, 2, 4 — a window of 2048px). So "refuse it"
 * would mean refusing the specification's canonical example.
 *
 * Nothing is relaxed to accommodate that. Every guard still runs, on the extended pyramid, and all
 * of them still hold: contiguous factors from 1, one square tile size, a single-tile coarsest
 * level. What changes is only *which levels are asked for* — and asking is legitimate exactly when
 * the service says it will serve any region at any size, which is what `supportsAnyRegionAndSize`
 * records and what makes a IIIF tile request for an undeclared scale factor a normal request
 * rather than a guess. A service that does **not** say so (a level 0 pre-cut pyramid) gets `null`
 * from here and is refused, because for one of those an undeclared tile really is a 404.
 *
 * It is also not a new idea: `@allmaps/iiif-parser` already invents a whole tileset for a service
 * that declares none, on the same `supportsAnyRegionAndSize` condition. It invents one level too
 * few — `getDefaultTileset` emits `maxExponent` factors starting at 2**0, so its coarsest spans
 * `tileWidth * 2**(maxExponent-1)` and always falls one short of covering the image. That is an
 * upstream off-by-one, reported with the ticket; this function is what makes it not matter here.
 *
 * The cost is that these levels are this app's arithmetic rather than the service's declaration,
 * so `cors-probe.ts` fetches one of them before the resource is accepted. That is the difference
 * between "the service should serve this" and "the service does".
 */
export function extendedTileset(
	info: unknown
): { readonly info: unknown; readonly coarsest: number } | null {
	let image: Image;
	try {
		image = Image.parse(info);
	} catch {
		// Not parseable at all, which is a different fault with a better message elsewhere.
		return null;
	}

	if (!image.supportsAnyRegionAndSize) return null;

	const levels = [...image.tileZoomLevels].sort((a, b) => a.scaleFactor - b.scaleFactor);
	const finest = levels[0];
	if (!finest) return null;

	// Only a single square tile size, and only a pyramid that already starts at full resolution.
	// Both of those are ticket 03's guards, and extending a pyramid that fails either would replace
	// its diagnostic with a different one — the two failures this slice exists to make legible.
	const square = levels.every(
		(level) => level.width === finest.width && level.height === finest.width
	);
	if (!square || finest.scaleFactor !== 1) return null;

	const tileSize = finest.width;
	const declared = levels[levels.length - 1]?.scaleFactor ?? 1;
	const needed =
		2 ** Math.max(0, Math.ceil(Math.log2(Math.max(image.width, image.height) / tileSize)));
	if (declared >= needed) return null;

	const scaleFactors: number[] = [];
	for (let factor = 1; factor <= needed; factor *= 2) scaleFactors.push(factor);

	return {
		// One tileset replacing however many the document had. Safe because `square` above has
		// established they all agree about the tile size, so this loses no geometry — and it is the
		// shape `createImagePane` accepts.
		info: {
			...(info as Record<string, unknown>),
			tiles: [{ width: tileSize, height: tileSize, scaleFactors }]
		},
		coarsest: needed
	};
}

/** The `id` (Image API 3) or `@id` (Image API 2) a document declares, if it declares one. */
function readDeclaredId(info: unknown): string | null {
	const record = info as { id?: unknown; '@id'?: unknown } | null;
	for (const candidate of [record?.id, record?.['@id']]) {
		if (typeof candidate === 'string' && candidate !== '') return candidate;
	}
	return null;
}

/**
 * Refuse a declared size that is not a size.
 *
 * Before `createImagePane`, because `Image.parse` accepts what its schema accepts and the
 * pyramid arithmetic downstream multiplies these two numbers. Ticket 13's review found the
 * matching failure on the other untrusted path: a declared size trusted, with nothing bounding
 * it.
 */
function assertDeclaredSizeIsSane(info: unknown, at: { url: string; host: string }): void {
	const { width, height } = (info ?? {}) as { width?: unknown; height?: unknown };
	const bad = [
		['width', width],
		['height', height]
	].find(([, value]) => !Number.isSafeInteger(value) || (value as number) < 1);

	if (bad) {
		throw new RemoteIiifRejectedError({
			...at,
			reason:
				`${at.host} describes an image whose ${bad[0]} is ${JSON.stringify(bad[1])}. An image ` +
				`service has to state its pixel dimensions as whole positive numbers, and every ` +
				`coordinate in an Alignment is in those pixels.`
		});
	}

	const pixels = (width as number) * (height as number);
	if (pixels > MAX_REMOTE_IMAGE_PIXELS) {
		throw new RemoteIiifRejectedError({
			...at,
			reason:
				`${at.host} describes an image of ${width}×${height} pixels — ` +
				`${Math.round(pixels / 1e9)} gigapixels, past the ` +
				`${Math.round(MAX_REMOTE_IMAGE_PIXELS / 1e9)} Ballastella will accept.`
		});
	}
}

/**
 * Refuse a service whose own declared limits are smaller than the tiles it declares.
 *
 * `maxWidth`, `maxHeight`, and `maxArea` are the Image API's way of saying "do not ask me for
 * anything bigger than this". A service that declares 1024-pixel tiles and `maxWidth: 600` has
 * described a pyramid it will not serve — every tile request comes back 4xx, or worse comes back
 * downscaled, which puts the wrong number of pixels in a cell and looks like blur rather than
 * like an error. Nothing before this slice could carry these fields, because our own generated
 * `info.json` has no reason to.
 */
function assertServiceWillServeItsOwnTiles(
	pane: ImagePane,
	at: { url: string; host: string }
): void {
	const { maxWidth, maxHeight, maxArea } = pane.image;
	const tile = pane.tileSize;
	const limit = [
		['maxWidth', maxWidth, tile],
		['maxHeight', maxHeight, tile],
		['maxArea', maxArea, tile * tile]
	].find(([, declared, needed]) => typeof declared === 'number' && declared < (needed as number));

	if (limit) {
		throw new RemoteIiifRejectedError({
			...at,
			reason:
				`${at.host} declares ${tile}×${tile} tiles but also ${limit[0]} of ${limit[1]}, so it ` +
				`will not serve the tiles it just described. Ballastella refuses this rather than ` +
				`requesting them: a service that answers a too-large request by shrinking the image ` +
				`puts the wrong number of pixels in every tile, which looks like a blurry scan rather ` +
				`than like a broken service.`
		});
	}
}

/**
 * The tiles to fetch at add time.
 *
 * **First, the last tile of the finest level.** Chosen, not arbitrary: that tile is at the
 * right-and-bottom corner of the image, so it is ragged for any image whose dimensions are not
 * whole multiples of the tile size — which is almost every scan. A ragged tile is the only tile
 * whose served dimensions can disagree with what was asked for, so this one request tests the CORS
 * gate *and* the placement arithmetic. A full-square tile would test only the first.
 *
 * **Then, when levels were synthesised, the coarsest tile.** Those levels are this app's
 * arithmetic rather than the service's declaration (see {@link extendedTileset}), and the whole
 * argument for synthesising them is that the service said it serves any region at any size. This
 * is where that claim is checked instead of trusted.
 */
function chooseProbeTiles(pane: ImagePane, synthesised: number | null): readonly ImagePaneTile[] {
	const tiles = pane.allTiles();
	const at = (scaleFactor: number): ImagePaneTile | undefined => {
		const level = tiles.filter((tile) => tile.scaleFactor === scaleFactor);
		// `allTiles` walks rows then columns, so the last tile of a level is its far corner.
		return level[level.length - 1];
	};

	const finest = Math.min(...tiles.map((tile) => tile.scaleFactor));
	// Non-null: `createImagePane` has already refused a pyramid with no levels.
	const chosen = [at(finest) as ImagePaneTile];
	const coarsest = synthesised === null ? undefined : at(synthesised);
	if (coarsest) chosen.push(coarsest);
	return chosen;
}

const hostOf = (url: string): string => {
	try {
		return new URL(url).hostname;
	} catch {
		return '';
	}
};

const message = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);
