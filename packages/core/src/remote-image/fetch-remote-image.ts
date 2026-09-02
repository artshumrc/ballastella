// A plain image at a URL — a JPEG or a PNG served with no IIIF service in front of it — fetched
// into the bytes the tiler cuts a pyramid from.
//
// **This is a download, not a reference.** A IIIF image service can be left where it is and drawn
// tile by tile; a single image file cannot be, because there is no request that returns part of it.
// So the only way to draw one is to copy it into the Workspace and cut its own tiles, which is
// exactly what a file on the user's computer goes through — and this module's whole job is to turn
// a URL into the `File` that path already takes. Nothing here writes anything: `ingestImageFile` is
// the one writer, and it leaves nothing behind if it fails.
//
// The consequence a scholar should be told once, and is: the Workspace gains the pixels, so the map
// stays readable offline and in a Published Site, and it is *not* a citation of a library's service.
// Where it came from is not recorded beside the pyramid — a `remote.json` says "the tiles are on
// this host", which is untrue of a copy, and this is not a IIIF service URI to record in one.
//
// The bounds are the same discipline as `remote-iiif/remote-resource.ts` and `offline-copy.ts`: a
// stranger's server is asked for a large binary, so the bytes are counted as they arrive rather than
// believed from `content-length`, and the read is abandoned the moment the bound is passed.

import type { FetchFn } from '../injection/store-image-fetch.js';
import { remoteIiifUrl } from '../remote-iiif/remote-resource.js';
import { isImageContentType } from './content-type.js';

/** What this will download before it refuses. */
export const REMOTE_IMAGE_LIMITS = {
	/**
	 * Largest image file this will hold in one piece, in bytes.
	 *
	 * The same number as `OFFLINE_COPY_LIMITS.responseBytes` and for the same reason: it is far above
	 * any real map scan served as one file, and small enough that a response with no end cannot take
	 * the tab with it. The pixel ceiling is a separate and later refusal — `ingestImageFile` reads the
	 * container's header before anything is decoded (ADR-0027) — because a 30 MB JPEG can be more
	 * megapixels than a browser will decode and a 200 MB TIFF can be fewer.
	 */
	responseBytes: 256 * 1024 * 1024,
	/** Longer than a JSON document's timeout, because this really is a large download. */
	timeoutMs: 120_000
} as const;

export type RemoteImageLimits = { readonly responseBytes: number; readonly timeoutMs: number };

/**
 * A remote image file will not be added, and why — in words a scholar can act on.
 *
 * Its own class rather than `RemoteIiifRejectedError`, because nothing on this path is IIIF and the
 * advice differs: there is no Manifest to go looking for and no “IIIF link on that page” to find.
 */
export class RemoteImageRefusedError extends Error {
	/** The URL that was refused, as it was asked for. */
	readonly url: string;
	/** Its host, for a caller that wants to say which server said this. */
	readonly host: string;

	constructor(options: { url: string; host: string; reason: string }) {
		super(options.reason);
		this.name = 'RemoteImageRefusedError';
		this.url = options.url;
		this.host = options.host;
	}
}

export type FetchRemoteImageOptions = {
	/**
	 * How the network is reached. Injected for the reason every other remote read is: a test serves a
	 * stranger's bytes without a network, and the app hands in the ADR-0011 shim, which passes every
	 * non-placeholder host straight through.
	 */
	readonly fetch: FetchFn;
	readonly limits?: Partial<RemoteImageLimits>;
	readonly signal?: AbortSignal;
};

/**
 * Download the image a URL names, as the `File` {@link ingestImageFile} takes.
 *
 * The URL goes through `remoteIiifUrl` — which is the *IIIF* reader's normaliser only in where it
 * lives. What it enforces is a URL hygiene rule this path needs identically: absolute, `http(s)`
 * only, no credentials to be written into a Workspace, no deep-link fragment. In the editor it has
 * already run by the time this is reached, and running it again costs nothing.
 */
export async function fetchRemoteImageFile(
	input: string | URL,
	options: FetchRemoteImageOptions
): Promise<File> {
	const url = input instanceof URL ? input : remoteIiifUrl(input);
	const limits = { ...REMOTE_IMAGE_LIMITS, ...options.limits };
	const host = url.hostname;
	const refuse = (reason: string) => new RemoteImageRefusedError({ url: url.href, host, reason });

	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), limits.timeoutMs);
	const cancel = () => abort.abort();
	options.signal?.addEventListener('abort', cancel, { once: true });

	try {
		let response: Response;
		try {
			response = await options.fetch(url.href, { signal: abort.signal });
		} catch (cause) {
			// A cancellation the caller asked for is not a refusal to report.
			options.signal?.throwIfAborted();
			throw refuse(
				abort.signal.aborted
					? `${host} did not finish sending that image within ` +
							`${Math.round(limits.timeoutMs / 1000)} seconds. Nothing has been added.`
					: `${host} could not be reached (${message(cause)}). Either it is not responding, ` +
							`you are offline, or it does not allow other websites to read its files — which ` +
							`it has to do for Ballastella to copy this image. If you can open the image in a ` +
							`browser tab, save it and add it from a file instead.`
			);
		}

		if (!response.ok) {
			throw refuse(
				`${host} answered ${response.status}${
					response.statusText ? ` ${response.statusText}` : ''
				} for that address. Nothing has been added.`
			);
		}

		const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';

		if (!isImageContentType(contentType)) {
			throw refuse(
				`${host} sent ${contentType || 'a response with no type'} rather than an image. ` +
					`Nothing has been added.`
			);
		}

		// **An SVG is refused here rather than by the decoder.** It is a drawing rather than a
		// photograph of a sheet: it has no pixel dimensions of its own to cut a pyramid to, and
		// `createImageBitmap` rejects it in browsers that will not decode one without a declared size.
		// Meeting that as "this file could not be read as an image" would send the user looking for a
		// corrupt download.
		if (/^image\/svg\b/i.test(contentType)) {
			throw refuse(
				`That address is an SVG drawing rather than a picture of a sheet. Ballastella cuts ` +
					`tiles from pixels, so export it as a PNG or a JPEG at the size you want and add ` +
					`that instead. Nothing has been added.`
			);
		}

		const bytes = await readBounded(response, limits, refuse, host);
		return new File([bytes], fileNameFor(url, contentType), { type: contentType });
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', cancel);
	}
}

/** The body, refused past `limits.responseBytes`, counted as it arrives. */
async function readBounded(
	response: Response,
	limits: RemoteImageLimits,
	refuse: (reason: string) => RemoteImageRefusedError,
	host: string
): Promise<Blob> {
	const tooLarge = (bytes: number) =>
		refuse(
			`${host} is sending an image larger than the ` +
				`${Math.round(limits.responseBytes / (1024 * 1024))} MB Ballastella will hold in one ` +
				`piece (${bytes} bytes so far). Nothing has been added.`
		);

	const body = response.body;
	// A `Response` built by a test or by a shim may have no `body`; the bound still holds, but the
	// read cannot be stopped early.
	if (!body) {
		const blob = await response.blob();
		if (blob.size > limits.responseBytes) throw tooLarge(blob.size);
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
			if (read > limits.responseBytes) throw tooLarge(read);
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	return new Blob(chunks as BlobPart[]);
}

/**
 * What to call the file, which is what the Map Image is labelled.
 *
 * The last path segment, because that is what the user would have got had they saved the image
 * themselves — and it is very often the shelfmark. A URL that ends in a slash or in a bare
 * identifier has nothing better than its host to offer.
 */
function fileNameFor(url: URL, contentType: string): string {
	const segment = url.pathname.split('/').filter(Boolean).pop() ?? '';
	let name: string;
	try {
		name = decodeURIComponent(segment);
	} catch {
		// A percent-escape that is not valid UTF-8 is a name to fall back from, not to raise over.
		name = segment;
	}
	if (name === '') name = url.hostname;
	return /\.[a-z0-9]{2,4}$/i.test(name) ? name : `${name}.${extensionFor(contentType)}`;
}

const extensionFor = (contentType: string): string => {
	const subtype = contentType.slice('image/'.length).toLowerCase();
	return subtype === 'jpeg' ? 'jpg' : /^[a-z0-9]+$/.test(subtype) ? subtype : 'img';
};

const message = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);
