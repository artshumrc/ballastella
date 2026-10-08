import { IIIF, type Collection, type Image, type Manifest } from '@allmaps/iiif-parser';

import type { FetchFn } from '../injection/store-image-fetch.js';
import {
	RemoteRefusal,
	fetchWithin,
	isImageContentType,
	readCapped
} from '../remote-image/fetch-within.js';
import { asRecord, messageOf } from '../store/project-store.js';

export type RemoteIiifLimits = {
	readonly documentBytes: number;
	readonly timeoutMs: number;
	readonly canvases: number;
	readonly collectionItems: number;
};

export const REMOTE_IIIF_LIMITS: RemoteIiifLimits = {
	documentBytes: 8 * 1024 * 1024,
	timeoutMs: 20_000,
	canvases: 2_000,
	collectionItems: 2_000
};

export class RemoteIiifRejectedError extends RemoteRefusal {
	override readonly name: string = 'RemoteIiifRejectedError';
}

export class RemoteImageResponseError extends RemoteIiifRejectedError {
	override readonly name = 'RemoteImageResponseError';
	readonly contentType: string;

	constructor(options: { url: string; host: string; contentType: string }) {
		super({
			url: options.url,
			host: options.host,
			reason:
				`${options.host} sent an image file (${options.contentType}) rather than a IIIF ` +
				`Manifest, Collection, or image description.`
		});
		this.contentType = options.contentType;
	}
}

export function remoteIiifUrl(input: string): URL {
	const text = input.trim();

	if (text === '') {
		throw new RemoteIiifRejectedError({
			url: text,
			reason: 'Paste the address of a IIIF Manifest, Collection, or image service to add a map.'
		});
	}

	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new RemoteIiifRejectedError({
			url: text,
			reason:
				`“${text}” is not a web address. A IIIF resource is named by an absolute URL — it ` +
				`starts with https:// — so this looks like part of one rather than the whole.`
		});
	}

	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new RemoteIiifRejectedError({
			url: text,
			host: url.hostname,
			reason:
				`Only https:// and http:// addresses can be added, and this one is ` +
				`${url.protocol.replace(':', '')}:. A IIIF resource is always served over HTTP.`
		});
	}

	if (url.username !== '' || url.password !== '') {
		throw new RemoteIiifRejectedError({
			url: text,
			host: url.hostname,
			reason:
				`That address carries a username or password. Ballastella would write it into this ` +
				`Project's files and into anything you exported from it, so it will not accept one. ` +
				`Use the plain address of the resource — ${url.origin}${url.pathname} — and if it ` +
				`needs a login, download the image and add it from a file instead.`
		});
	}

	// `generateId` hashes the whole string, so a viewer deep link would mint a second identity.
	url.hash = '';
	return url;
}

export type RemoteIiifResource = {
	readonly kind: 'image' | 'manifest' | 'collection';
	readonly url: string;
	readonly document: unknown;
	readonly parsed: Image | Manifest | Collection;
};

export async function readRemoteIiifResource(
	input: string | URL,
	options: { readonly fetch: FetchFn; readonly limits?: Partial<RemoteIiifLimits> }
): Promise<RemoteIiifResource> {
	const url = input instanceof URL ? input : remoteIiifUrl(input);
	const limits = { ...REMOTE_IIIF_LIMITS, ...options.limits };
	const document = await fetchRemoteJson(url, { fetch: options.fetch, limits });
	const refuse = (reason: string) =>
		new RemoteIiifRejectedError({ url: url.href, host: url.hostname, reason });

	let parsed: Image | Manifest | Collection;
	try {
		parsed = IIIF.parse(document);
	} catch (cause) {
		throw refuse(
			looksLikeImageService(document)
				? `${url.hostname} describes an image but publishes no tiles for it, and does not offer ` +
						`arbitrary regions either — so there is no request Ballastella could make that would ` +
						`return part of this sheet: ${messageOf(cause)}\n\n` +
						`This is a refusal rather than a blank map on purpose, and it is made now rather than ` +
						`when you press Align, so that you are never given a Layer that cannot be aligned. If ` +
						`you need this map, download the image and add it from a file — Ballastella then cuts ` +
						`its own tiles.`
				: `${url.hostname} answered, but what it sent is not a IIIF Manifest, Collection, or ` +
						`image description: ${messageOf(cause)}. If you pasted the address of a viewer page ` +
						`rather than of the IIIF resource itself, look for a “IIIF” link on that page.`
		);
	}

	if (parsed.type === 'manifest' && parsed.canvases.length > limits.canvases) {
		throw refuse(
			`That Manifest lists ${parsed.canvases.length} canvases, past the ${limits.canvases} ` +
				`Ballastella will browse at once. Nothing has been added. If it is a Collection of ` +
				`volumes, paste the Collection's address instead — Ballastella will let you open one ` +
				`volume at a time.`
		);
	}

	if (parsed.type === 'collection' && parsed.items.length > limits.collectionItems) {
		throw refuse(
			`That Collection lists ${parsed.items.length} items, past the ` +
				`${limits.collectionItems} Ballastella will browse at once. Nothing has been added.`
		);
	}

	return { kind: parsed.type, url: url.href, document, parsed };
}

export async function fetchRemoteJson(
	url: URL,
	options: { fetch: FetchFn; limits: RemoteIiifLimits }
): Promise<unknown> {
	const { limits } = options;
	const host = url.hostname;
	const refuse = (reason: string) => new RemoteIiifRejectedError({ url: url.href, host, reason });

	const text = await fetchWithin(
		url.href,
		{
			fetch: options.fetch,
			timeoutMs: limits.timeoutMs,
			headers: { accept: 'application/ld+json, application/json;q=0.9' },
			refuse: (fault) =>
				refuse(
					fault.kind === 'timeout'
						? `${host} did not answer within ${Math.round(limits.timeoutMs / 1000)} ` +
								`seconds. Nothing has been added; try again, or check the address.`
						: fault.kind === 'unreachable'
							? `${host} could not be reached (${fault.detail}). Either it is not ` +
								`responding, you are offline, or it does not allow other websites to read its ` +
								`files — which it has to do for Ballastella to read a map from it.`
							: `${host} answered ${fault.answered} for that address. Nothing has been added.`
				)
		},
		async (response) => {
			const contentType = response.headers.get('content-type') ?? '';

			if (isImageContentType(contentType)) {
				throw new RemoteImageResponseError({
					url: url.href,
					host,
					contentType: contentType.split(';')[0]?.trim() ?? contentType
				});
			}

			if (/^\s*text\/html\b/i.test(contentType)) {
				throw refuse(
					`${host} sent a web page rather than a IIIF description. That usually means ` +
						`the address is a viewer page, or a “not found” page answered with a 200. Look for a ` +
						`“IIIF” or “Manifest” link on the page you copied it from.`
				);
			}

			const bytes = await readCapped(response, limits.documentBytes, (read) =>
				refuse(
					`${host} is sending more than ${Math.round(limits.documentBytes / 1024)} kB of ` +
						`IIIF description (${read} bytes so far), which is past what Ballastella will read. ` +
						`Nothing has been added.`
				)
			);
			return bytes.text();
		}
	);

	try {
		return JSON.parse(text) as unknown;
	} catch (cause) {
		throw refuse(`${host} sent something that is not JSON: ${messageOf(cause)}.`);
	}
}

function looksLikeImageService(document: unknown): boolean {
	const record = asRecord(document);
	if (record === null) return false;

	if (record['protocol'] === 'http://iiif.io/api/image') return true;

	for (const key of ['type', '@type']) {
		const value = record[key];
		if (typeof value === 'string' && value.startsWith('ImageService')) return true;
	}

	const contexts = record['@context'];
	for (const context of Array.isArray(contexts) ? contexts : [contexts]) {
		if (typeof context === 'string' && context.includes('/api/image/')) return true;
	}

	return false;
}
