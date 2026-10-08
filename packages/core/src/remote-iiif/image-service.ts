import { generateId } from '@allmaps/id';
import { Image } from '@allmaps/iiif-parser';

import {
	createImagePane,
	type ImagePane,
	type ImagePaneTile
} from '../image-pane/iiif-image-pane.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import { hostOf } from '../remote-image/fetch-within.js';
import { messageOf } from '../store/project-store.js';
import {
	REMOTE_IIIF_LIMITS,
	RemoteIiifRejectedError,
	fetchRemoteJson,
	remoteIiifUrl,
	type RemoteIiifLimits
} from './remote-resource.js';
import { canonicalServiceUri } from './service-uri.js';

const MAX_REMOTE_IMAGE_PIXELS = 4_000_000_000;

export type RemoteImageService = {
	readonly uri: string;
	readonly requestedUrl: string;
	readonly imageId: string;
	readonly width: number;
	readonly height: number;
	readonly tileSize: number;
	readonly info: unknown;
	readonly pane: ImagePane;
	readonly probeTiles: readonly ImagePaneTile[];
	readonly probeTileIsRagged: boolean;
	readonly synthesisedCoarsestScaleFactor: number | null;
};

export async function readRemoteImageService(
	uri: string,
	options: { readonly fetch: FetchFn; readonly limits?: Partial<RemoteIiifLimits> }
): Promise<RemoteImageService> {
	const requested = remoteIiifUrl(uri);
	const base = canonicalServiceUri(requested.href);
	const infoUrl = remoteIiifUrl(`${base}/info.json`);
	const limits = { ...REMOTE_IIIF_LIMITS, ...options.limits };
	const info = await fetchRemoteJson(infoUrl, { fetch: options.fetch, limits });

	return acceptRemoteImageService(info, { requestedUrl: infoUrl.href, fallbackUri: base });
}

export async function acceptRemoteImageService(
	info: unknown,
	context: { requestedUrl: string; fallbackUri: string }
): Promise<RemoteImageService> {
	const host = hostOf(context.requestedUrl);
	const declaredId = readDeclaredId(info);
	const uri = canonicalServiceUri(
		declaredId === null
			? context.fallbackUri
			: adoptDeclaredId(declaredId, { url: context.requestedUrl, host })
	);

	assertDeclaredSizeIsSane(info, { url: context.requestedUrl, host });

	const refuse = (cause: unknown) =>
		new RemoteIiifRejectedError({
			url: context.requestedUrl,
			host,
			reason:
				`Ballastella cannot draw the image service at ${host}: ${messageOf(cause)}\n\n` +
				`This is a refusal rather than a blank map on purpose. Every shape refused here is one ` +
				`that would otherwise render something plausible and wrong. If you need this map, add ` +
				`the image from a file — or, once it is in a Project, use “make an offline copy”, which ` +
				`re-cuts Ballastella's own tiles.`
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

// Adds coarse levels until one tile covers the sheet, only for a service that serves any region and size.
function extendedTileset(
	info: unknown
): { readonly info: unknown; readonly coarsest: number } | null {
	let image: Image;
	try {
		image = Image.parse(info);
	} catch {
		return null;
	}

	if (!image.supportsAnyRegionAndSize) return null;
	const levels = [...image.tileZoomLevels].sort((a, b) => a.scaleFactor - b.scaleFactor);
	const finest = levels[0];
	if (!finest) return null;

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
		info: {
			...(info as Record<string, unknown>),
			tiles: [{ width: tileSize, height: tileSize, scaleFactors }]
		},
		coarsest: needed
	};
}

function adoptDeclaredId(declaredId: string, at: { url: string; host: string }): string {
	try {
		return remoteIiifUrl(declaredId).href;
	} catch (cause) {
		throw new RemoteIiifRejectedError({
			...at,
			reason:
				`${at.host} answered with an image description that names itself “${declaredId}”, and ` +
				`Ballastella will not adopt that as this map's address: ${messageOf(cause)}\n\n` +
				`Every tile request, the identifier this Map Image is filed under, and the citation ` +
				`written beside it all come from that address, so it is checked exactly as a pasted one ` +
				`is. Nothing has been added.`
		});
	}
}

function readDeclaredId(info: unknown): string | null {
	const record = info as { id?: unknown; '@id'?: unknown } | null;
	for (const candidate of [record?.id, record?.['@id']]) {
		if (typeof candidate === 'string' && candidate !== '') return candidate;
	}
	return null;
}

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

// The finest level's last tile is the corner one, ragged unless the sheet divides evenly into tiles.
function chooseProbeTiles(pane: ImagePane, synthesised: number | null): readonly ImagePaneTile[] {
	const tiles = pane.allTiles();
	const at = (scaleFactor: number): ImagePaneTile | undefined => {
		const level = tiles.filter((tile) => tile.scaleFactor === scaleFactor);
		return level[level.length - 1];
	};

	const finest = Math.min(...tiles.map((tile) => tile.scaleFactor));
	const chosen = [at(finest) as ImagePaneTile];
	const coarsest = synthesised === null ? undefined : at(synthesised);
	if (coarsest) chosen.push(coarsest);
	return chosen;
}
