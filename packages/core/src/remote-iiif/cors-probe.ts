// Probe info.json plus a ragged tile; only a rejected fetch proves CORS, timeouts/5xx retry.

import type { FetchFn } from '../injection/store-image-fetch.js';
import { RemoteRefusal, fetchWithin, type FetchFault } from '../remote-image/fetch-within.js';
import { messageOf } from '../store/project-store.js';
import type { RemoteImageService } from './image-service.js';
import { REMOTE_IIIF_LIMITS } from './remote-resource.js';

type RemoteProbeStage = 'info' | 'tile' | 'geometry';

export class RemoteImageUnusableError extends RemoteRefusal {
	override readonly name = 'RemoteImageUnusableError';
	readonly stage: RemoteProbeStage;
	readonly attempts: number;
	readonly transient: boolean;

	constructor(options: {
		host: string;
		url: string;
		stage: RemoteProbeStage;
		reason: string;
		attempts?: number;
		transient?: boolean;
	}) {
		super(options);
		this.stage = options.stage;
		this.attempts = options.attempts ?? 1;
		this.transient = options.transient ?? false;
	}
}

export type MeasureTile = (bytes: Blob) => Promise<{ width: number; height: number }>;

export const measureTileWithImageBitmap: MeasureTile = async (bytes) => {
	const bitmap = await createImageBitmap(bytes);
	try {
		return { width: bitmap.width, height: bitmap.height };
	} finally {
		bitmap.close();
	}
};

export const PROBE_ATTEMPTS = 3;
const TRANSIENT_BACKOFF_MS: readonly number[] = [500, 2000];

type ProbeRemoteImageOptions = {
	readonly fetch: FetchFn;
	readonly measureTile: MeasureTile;
	readonly timeoutMs?: number;
	readonly delay?: (ms: number) => Promise<void>;
};

export async function probeRemoteImageService(
	service: RemoteImageService,
	options: ProbeRemoteImageOptions
): Promise<{
	readonly host: string;
	readonly tileUrls: readonly string[];
	readonly checkedGeometry: boolean;
}> {
	const host = new URL(service.uri).hostname;
	const timeoutMs = options.timeoutMs ?? REMOTE_IIIF_LIMITS.timeoutMs;
	const infoUrl = `${service.uri}/info.json`;

	await readOrRefuse(infoUrl, {
		...options,
		host,
		stage: 'info',
		timeoutMs,
		refusals: {
			subject: 'its description of this image',
			crossOrigin: (detail) =>
				`${host} will not let another website read its image descriptions${detail}. Ballastella ` +
				`needs to read ${infoUrl} from your browser, and this host does not send the ` +
				`Access-Control-Allow-Origin header that permits it. Nothing has been added. Ask whoever ` +
				`runs ${host} to allow cross-origin reads — most IIIF services do — or download the image ` +
				`and add it from a file.`,
			declined: (status) =>
				`${host} answered ${status} for ${infoUrl}. That is the image description Ballastella ` +
				`has to read before it can draw anything, so there is nothing to add. Check the address ` +
				`— if you copied it from a viewer page rather than from a “IIIF” link, it may name a page ` +
				`rather than the image service.`
		}
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
			refusals: {
				subject: synthesised
					? 'the wider tile Ballastella needs to show the whole sheet at once'
					: 'a tile of this image',
				crossOrigin: (detail) =>
					`${host} serves its image descriptions to other websites but not its image ` +
					`tiles${detail}. Ballastella draws a Map Image by uploading tiles into the ` +
					`graphics card, which the browser only permits for a response marked readable ` +
					`cross-origin — so this map would appear completely blank with nothing to say why. ` +
					`Nothing has been added. The tile that was refused is ${tileUrl}.`,
				declined: (status) =>
					synthesised
						? `${host} declares tiles only down to a zoom at which this image is still ` +
							`${Math.ceil(service.width / (service.tileSize * (service.synthesisedCoarsestScaleFactor ?? 1)))} ` +
							`tiles across, and it also declares that it serves any region at any size — so ` +
							`Ballastella asked for the wider tile it needs to show the whole sheet at once, and ` +
							`the answer was no — it answered ${status}. Nothing has been added. The request was ` +
							`${tileUrl}.`
						: `${host} answered ${status} for a tile its own image description says it serves. ` +
							`Ballastella asked for ${tileUrl}, which is the ${tile.request.size.width}×` +
							`${tile.request.size.height} tile at the corner of the sheet. Either this image is ` +
							`incomplete on the host or its description does not match what it will serve — ` +
							`nothing has been added, and this is one to report to whoever runs ${host}.`
			}
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
					`(${messageOf(cause)}). Ballastella has to be able to read a tile's pixels to draw it, so ` +
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

type ProbeRefusals = {
	readonly crossOrigin: (detail: string) => string;
	readonly declined: (status: number) => string;
	readonly subject: string;
};

type Failure = FetchFault | { readonly kind: 'opaque'; readonly detail: string };

class AttemptFailed extends Error {
	constructor(readonly failure: Failure) {
		super(failure.kind);
	}
}

const isTransient = (failure: Failure): boolean =>
	failure.kind === 'timeout' ||
	(failure.kind === 'status' && (failure.status >= 500 || failure.status === 429));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function readOrRefuse(
	url: string,
	options: ProbeRemoteImageOptions & {
		host: string;
		stage: RemoteProbeStage;
		timeoutMs: number;
		refusals: ProbeRefusals;
	}
): Promise<Blob> {
	const wait = options.delay ?? sleep;
	let attempts = 0;
	let failure: Failure;

	for (;;) {
		if (attempts > 0) await wait(TRANSIENT_BACKOFF_MS[attempts - 1] ?? 0);
		attempts += 1;

		try {
			// No `mode` and no `credentials`: the same request `@allmaps/maplibre` will make.
			return await fetchWithin(
				url,
				{ ...options, refuse: (fault) => new AttemptFailed(fault) },
				(response, signal) =>
					response.blob().catch((cause: unknown) => {
						throw new AttemptFailed(
							signal.aborted ? { kind: 'timeout' } : { kind: 'opaque', detail: messageOf(cause) }
						);
					})
			);
		} catch (cause) {
			if (!(cause instanceof AttemptFailed)) throw cause;
			failure = cause.failure;
		}
		if (attempts >= PROBE_ATTEMPTS || !isTransient(failure)) break;
	}

	const { host, stage, refusals } = options;
	const refuse = (reason: string, transient = false) =>
		new RemoteImageUnusableError({ host, url, stage, reason, attempts, transient });
	const unavailable = (detail: string) =>
		refuse(
			`${host} did not manage to serve ${refusals.subject}. Ballastella asked ${attempts} times, ` +
				`pausing between each, and ${detail}. That is a fault at the host — it says nothing about ` +
				`your Project or about this map, and a service that answers most requests and fails some is ` +
				`usually busy or briefly broken rather than unable to do it at all. Nothing has been added; ` +
				`trying again, now or in a few minutes, is often all it takes. The request was ${url}.`,
			true
		);

	switch (failure.kind) {
		case 'unreachable':
			throw refuse(refusals.crossOrigin(` (${failure.detail})`));
		case 'opaque':
			throw refuse(refusals.crossOrigin(` (its response could not be read: ${failure.detail})`));
		case 'status':
			if (!isTransient(failure)) throw refuse(refusals.declined(failure.status));
			throw unavailable(`the last answer was ${failure.status}`);
		case 'timeout':
			throw unavailable('nothing came back inside the time allowed');
	}
}
