import type { FetchFn } from '../injection/store-image-fetch.js';
import { messageOf } from '../store/project-store.js';

export const isImageContentType = (contentType: string): boolean =>
	/^\s*image\//i.test(contentType);

export const hostOf = (url: string): string => {
	try {
		return new URL(url).hostname;
	} catch {
		return '';
	}
};

export class RemoteRefusal extends Error {
	readonly url: string;
	readonly host: string;

	constructor(options: { url: string; host?: string; reason: string }) {
		super(options.reason);
		this.url = options.url;
		this.host = options.host ?? '';
	}
}

export type FetchFault =
	| { readonly kind: 'timeout' }
	| { readonly kind: 'unreachable'; readonly detail: string }
	| { readonly kind: 'status'; readonly status: number; readonly answered: string };

export async function fetchWithin<T>(
	url: string,
	options: {
		readonly fetch: FetchFn;
		readonly timeoutMs: number;
		readonly signal?: AbortSignal | undefined;
		readonly headers?: Record<string, string>;
		readonly refuse: (fault: FetchFault) => Error;
	},
	read: (response: Response, signal: AbortSignal) => Promise<T>
): Promise<T> {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), options.timeoutMs);
	const cancel = () => abort.abort();
	options.signal?.addEventListener('abort', cancel, { once: true });

	try {
		let response: Response;
		try {
			const { headers } = options;
			response = await options.fetch(url, { signal: abort.signal, ...(headers && { headers }) });
		} catch (cause) {
			options.signal?.throwIfAborted();
			throw options.refuse(
				abort.signal.aborted
					? { kind: 'timeout' }
					: { kind: 'unreachable', detail: messageOf(cause) }
			);
		}

		if (!response.ok) {
			const { status, statusText } = response;
			throw options.refuse({
				kind: 'status',
				status,
				answered: statusText ? `${status} ${statusText}` : `${status}`
			});
		}

		return await read(response, abort.signal);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', cancel);
	}
}

/** Counts the bytes as they arrive rather than believing `content-length`. */
export async function readCapped(
	response: Response,
	maxBytes: number,
	tooLarge: (bytes: number) => Error
): Promise<Blob> {
	const type = response.headers.get('content-type') ?? 'application/octet-stream';
	if (!response.body) {
		const blob = await response.blob();
		if (blob.size > maxBytes) throw tooLarge(blob.size);
		return blob;
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let read = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			read += value.byteLength;
			if (read > maxBytes) throw tooLarge(read);
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return new Blob(chunks as BlobPart[], { type });
}
