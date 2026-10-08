import type { FetchFn } from '../injection/store-image-fetch.js';
import { remoteIiifUrl } from '../remote-iiif/remote-resource.js';
import { RemoteRefusal, fetchWithin, isImageContentType, readCapped } from './fetch-within.js';

export const REMOTE_IMAGE_LIMITS = {
	responseBytes: 256 * 1024 * 1024,
	timeoutMs: 120_000
};

export class RemoteImageRefusedError extends RemoteRefusal {
	override readonly name = 'RemoteImageRefusedError';
}

export async function fetchRemoteImageFile(
	input: string | URL,
	options: {
		readonly fetch: FetchFn;
		readonly limits?: Partial<typeof REMOTE_IMAGE_LIMITS>;
		readonly signal?: AbortSignal;
	}
): Promise<File> {
	const url = input instanceof URL ? input : remoteIiifUrl(input);
	const limits = { ...REMOTE_IMAGE_LIMITS, ...options.limits };
	const host = url.hostname;
	const refuse = (reason: string) => new RemoteImageRefusedError({ url: url.href, host, reason });

	return fetchWithin(
		url.href,
		{
			fetch: options.fetch,
			signal: options.signal,
			timeoutMs: limits.timeoutMs,
			refuse: (fault) =>
				refuse(
					fault.kind === 'timeout'
						? `${host} did not finish sending that image within ` +
								`${Math.round(limits.timeoutMs / 1000)} seconds. Nothing has been added.`
						: fault.kind === 'unreachable'
							? `${host} could not be reached (${fault.detail}). Either it is not responding, ` +
								`you are offline, or it does not allow other websites to read its files — which ` +
								`it has to do for Ballastella to copy this image. If you can open the image in a ` +
								`browser tab, save it and add it from a file instead.`
							: `${host} answered ${fault.answered} for that address. Nothing has been added.`
				)
		},
		async (response) => {
			const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';

			if (!isImageContentType(contentType)) {
				throw refuse(
					`${host} sent ${contentType || 'a response with no type'} rather than an image. ` +
						`Nothing has been added.`
				);
			}

			// An SVG has no pixel dimensions to cut a pyramid to.
			if (/^image\/svg\b/i.test(contentType)) {
				throw refuse(
					`That address is an SVG drawing rather than a picture of a sheet. Ballastella cuts ` +
						`tiles from pixels, so export it as a PNG or a JPEG at the size you want and add ` +
						`that instead. Nothing has been added.`
				);
			}

			const bytes = await readCapped(response, limits.responseBytes, (read) =>
				refuse(
					`${host} is sending an image larger than the ` +
						`${Math.round(limits.responseBytes / (1024 * 1024))} MB Ballastella will hold in one ` +
						`piece (${read} bytes so far). Nothing has been added.`
				)
			);
			return new File([bytes], fileNameFor(url, contentType), { type: contentType });
		}
	);
}

function fileNameFor(url: URL, contentType: string): string {
	const segment = url.pathname.split('/').filter(Boolean).pop() ?? '';
	let name: string;
	try {
		name = decodeURIComponent(segment);
	} catch {
		name = segment;
	}
	if (name === '') name = url.hostname;
	if (/\.[a-z0-9]{2,4}$/i.test(name)) return name;
	const subtype = contentType.slice('image/'.length).toLowerCase();
	return `${name}.${subtype === 'jpeg' ? 'jpg' : /^[a-z0-9]+$/.test(subtype) ? subtype : 'img'}`;
}
