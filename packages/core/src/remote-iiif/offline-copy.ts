import type { Region } from '@allmaps/types';

import type { FetchFn } from '../injection/store-image-fetch.js';
import { RemoteRefusal, fetchWithin, hostOf, readCapped } from '../remote-image/fetch-within.js';
import { messageOf, type ProjectStore } from '../store/project-store.js';
import { MAX_INGEST_PIXELS } from '../tiler/decode-ceiling.js';
import { IMAGE_HEADER_BYTES, readImageHeader } from '../tiler/image-header.js';
import {
	ingestImageFile,
	type IngestProgress,
	type IngestResult,
	type OpenTileSource
} from '../tiler/ingest.js';
import type { RemoteImageService } from './image-service.js';

export const ESTIMATED_OFFLINE_COPY_BYTES_PER_PIXEL = 0.7;

export const estimateOfflineCopyBytes = (width: number, height: number): number =>
	Math.round(width * height * ESTIMATED_OFFLINE_COPY_BYTES_PER_PIXEL);

export const OFFLINE_COPY_LIMITS = {
	responseBytes: 256 * 1024 * 1024,
	timeoutMs: 120_000
};

type OfflineCopyPiece = { readonly url: string; readonly region: Region };

export type OfflineCopyPlan = {
	readonly path: 'full-max' | 'assembled';
	readonly width: number;
	readonly height: number;
	readonly host: string;
	readonly requests: readonly string[];
	readonly pieces: readonly OfflineCopyPiece[];
	readonly cappedBy: string;
	readonly notes: readonly string[];
	readonly refusal: string;
};

export class OfflineCopyRefusedError extends RemoteRefusal {
	override readonly name = 'OfflineCopyRefusedError';
}

export function planOfflineCopy(
	service: RemoteImageService,
	options: { readonly maxIngestPixels?: number } = {}
): OfflineCopyPlan {
	const { width, height, uri } = service;
	const host = hostOf(uri);
	const maxIngestPixels = options.maxIngestPixels ?? MAX_INGEST_PIXELS;
	const cappedBy = declaredCap(service);
	const path =
		service.pane.image.supportsAnyRegionAndSize && cappedBy === '' ? 'full-max' : 'assembled';

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

	// Both paths hold the whole source at full resolution before re-cutting it, so both meet the decode ceiling.
	if (pixels > maxIngestPixels) {
		refusal =
			`At ${megapixels(pixels)} megapixels this Map Image is past the ` +
			`${megapixels(maxIngestPixels)} megapixels a browser will decode in one piece, and an ` +
			`offline copy has to be held whole before it can be cut into tiles` +
			(path === 'assembled'
				? ` — ${host} serves only pre-cut tiles${cappedBy === '' ? '' : ` and ${cappedBy}`}, so ` +
					`the copy would have to be reassembled at full resolution first`
				: '') +
			`. Nothing has been copied and this Map Image still works, read from ${host}. To hold ` +
			`it offline, ask whoever runs ${host} for the original file and prepare a IIIF pyramid from ` +
			`it outside the browser.`;
	}

	return { path, width, height, host, requests, pieces, cappedBy, notes, refusal };
}

// The Image API: "if maxHeight is not specified, it is assumed to be the same as maxWidth".
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

function wholeImageUrl(service: RemoteImageService): string {
	const size = service.pane.image.majorVersion >= 3 ? 'max' : 'full';
	return `${service.uri}/full/${size}/0/default.jpg`;
}

function finestLevelPieces(service: RemoteImageService): OfflineCopyPiece[] {
	return service.pane
		.allTiles()
		.filter((tile) => tile.scaleFactor === 1)
		.map((tile) => {
			const { region, size } = tile.request;
			if (size.width !== region.width || size.height !== region.height) {
				throw new Error(
					`A scale factor 1 tile of ${service.uri} is served at ${size.width}×${size.height} for a ` +
						`${region.width}×${region.height} region, so it is not a 1:1 crop and cannot be stitched.`
				);
			}
			return { url: tile.url, region };
		});
}

export type OfflineCopyProgress = {
	readonly phase: 'fetching' | 'assembling' | 'tiling' | 'done';
	readonly requestsDone: number;
	readonly requestCount: number;
	readonly ingest: IngestProgress | null;
	readonly fraction: number;
};

const FETCH_SHARE = 0.3;

export type AssembleImage = (
	dimensions: { readonly width: number; readonly height: number },
	pieces: readonly (OfflineCopyPiece & { readonly bytes: Blob })[]
) => Promise<Blob>;

export async function makeOfflineCopy(options: {
	readonly store: ProjectStore;
	readonly service: RemoteImageService;
	readonly label?: string;
	readonly fetch: FetchFn;
	readonly assemble: AssembleImage;
	readonly openDecodeAndCrop: OpenTileSource;
	readonly maxIngestPixels?: number;
	readonly plan?: OfflineCopyPlan;
	readonly limits?: Partial<typeof OFFLINE_COPY_LIMITS>;
	readonly onProgress?: (progress: OfflineCopyProgress) => void;
	readonly signal?: AbortSignal;
}): Promise<{
	readonly imageId: string;
	readonly path: OfflineCopyPlan['path'];
	readonly requests: readonly string[];
	readonly bytesFetched: number;
	readonly ingest: IngestResult;
}> {
	const { store, service, signal } = options;
	const limits = { ...OFFLINE_COPY_LIMITS, ...options.limits };
	const plan = options.plan ?? planOfflineCopy(service, options);
	const host = plan.host;
	const refuse = (reason: string, url = service.uri) =>
		new OfflineCopyRefusedError({ host, url, reason });

	if (plan.refusal !== '') throw refuse(plan.refusal);
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
			fraction:
				phase === 'done'
					? 1
					: Math.min(0.99, FETCH_SHARE * fetched + (1 - FETCH_SHARE) * (ingest?.fraction ?? 0))
		});
	};

	const fetchPiece = async (url: string): Promise<Blob> => {
		signal?.throwIfAborted();
		const bytes = await fetchWithin(
			url,
			{
				fetch: options.fetch,
				signal,
				timeoutMs: limits.timeoutMs,
				refuse: (fault) =>
					refuse(
						fault.kind === 'timeout'
							? `${host} did not finish sending this map within ` +
									`${Math.round(limits.timeoutMs / 1000)} seconds. Nothing has been copied.`
							: fault.kind === 'unreachable'
								? `${host} could not be reached for ${url} (${fault.detail}). Nothing has been copied.`
								: `${host} answered ${fault.answered} for ${url}. Nothing has been copied, and ` +
									`this Map Image still works read from ${host}.`,
						url
					)
			},
			(response) =>
				readCapped(response, limits.responseBytes, (read) =>
					refuse(
						`${host} is sending an image larger than the ` +
							`${Math.round(limits.responseBytes / (1024 * 1024))} MB Ballastella will hold in one piece ` +
							`(${read} bytes so far). Nothing has been copied.`,
						url
					)
				)
		);
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
		const header = readImageHeader(
			new Uint8Array(await source.slice(0, IMAGE_HEADER_BYTES).arrayBuffer())
		);
		if (header && (header.width !== service.width || header.height !== service.height)) {
			throw refuse(servedWrongSizeReason(host, service, header), url);
		}
	} else {
		const pieces = [];
		for (const piece of plan.pieces) {
			pieces.push({ ...piece, bytes: await fetchPiece(piece.url) });
		}
		report('assembling');
		signal?.throwIfAborted();
		try {
			source = await options.assemble({ width: plan.width, height: plan.height }, pieces);
		} catch (cause) {
			throw refuse(
				`The ${pieces.length} tiles ${host} served could not be put back together into one ` +
					`${plan.width}×${plan.height} image: ${messageOf(cause)}. Nothing has been copied and this ` +
					`Map Image still works, read from ${host}.`
			);
		}
	}

	report('tiling');
	signal?.throwIfAborted();

	const result = await ingestImageFile({
		store,
		file: source,
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

	if (result.width !== service.width || result.height !== service.height) {
		const paths = await store.list(`${result.directory}/`).catch(() => []);
		await Promise.all(paths.map((path) => store.delete(path).catch(() => undefined)));
		throw refuse(servedWrongSizeReason(host, service, result), plan.requests[0] ?? service.uri);
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

const servedWrongSizeReason = (
	host: string,
	service: RemoteImageService,
	served: { width: number; height: number }
): string =>
	`${host} describes this map as ${service.width}×${service.height} pixels ` +
	`but served a ${served.width}×${served.height} image for the whole of it. ` +
	`Ballastella refuses that rather than copying it: every Control Point, and every alignment anyone ` +
	`has published for this image, is measured in the pixels the service declared — so a copy at a ` +
	`different size would put the whole map in the wrong place while looking perfectly fine. Nothing ` +
	`has been copied and this Map Image still works, read from ${host}.`;

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
			context.drawImage(bitmap, piece.region.x, piece.region.y);
		} finally {
			bitmap.close();
		}
	}

	return canvas.convertToBlob({ type: 'image/png' });
};

const megapixels = (pixels: number): number => Math.round(pixels / 1e6);
