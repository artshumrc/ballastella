import {
	PathNotFoundError,
	assertStorePath,
	type ReadOnlyProjectStore,
	type StorePath
} from '../store/project-store.js';
import { SiteFileUnreachableError } from '../store/http-project-store.js';
import { imageDirectory, imageInfoPath } from '../project/image-files.js';
import { IMAGE_SERVICE_PLACEHOLDER_ORIGIN } from '../tiler/pyramid.js';
import type { TileSourceFailure } from './tile-failure.js';

// Structurally `@allmaps/types`' `FetchFn`, declared here so core need not depend on the render stack.
export type FetchFn = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

const PLACEHOLDER_HOST = new URL(IMAGE_SERVICE_PLACEHOLDER_ORIGIN).hostname;

const parseUrl = (url: string): URL | undefined => {
	try {
		return new URL(url);
	} catch {
		return undefined;
	}
};

const urlOf = (input: Request | string | URL): string =>
	typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

export function isImageServicePlaceholderUrl(url: string): boolean {
	const hostname = parseUrl(url)?.hostname;
	return hostname === PLACEHOLDER_HOST || (hostname?.endsWith(`.${PLACEHOLDER_HOST}`) ?? false);
}

export class MissingImageServiceOverrideError extends Error {
	override readonly name = 'MissingImageServiceOverrideError';

	constructor(readonly url: string) {
		super(
			`Nothing can be fetched from ${url}. That is the deliberately unusable placeholder host ` +
				`every generated info.json carries (ADR-0004), so whatever built this URL never had its ` +
				`tiles routed anywhere: either assign Image#uri to the base the tiles are really served ` +
				`from, or give the consumer the ProjectStore shim — createStoreImageFetch, reached by ` +
				`addProtocol for a MapLibre source and by the fetchFn option for @allmaps/maplibre ` +
				`(ADR-0011).`
		);
	}
}

export type TileFetchOutcome =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly failure: TileSourceFailure;
			readonly imageId: string | null;
	  };

function classifyTileFailure(cause: unknown, host: string | null = null): TileSourceFailure {
	if (cause instanceof SiteFileUnreachableError) {
		const named = cause.host || null;
		return cause.status === 0
			? { kind: 'no-answer', host: named }
			: { kind: 'server-error', host: named, status: cause.status };
	}
	if (cause instanceof PathNotFoundError) {
		return { kind: 'file-missing', host };
	}
	if (cause instanceof TypeError) {
		// What `fetch` rejects with when no answer came: a dropped connection, a refused socket, CORS.
		return { kind: 'no-answer', host };
	}
	return { kind: 'unreadable', host, detail: describeCause(cause) };
}

const describeCause = (cause: unknown): string => {
	if (cause instanceof Error && typeof cause.message === 'string') return cause.message;
	try {
		return String(cause);
	} catch {
		return 'the reason could not be read';
	}
};

const MEDIA_TYPES: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	json: 'application/json',
	png: 'image/png',
	webp: 'image/webp'
};

const mediaType = (path: string): string => {
	const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
	return MEDIA_TYPES[extension] ?? 'application/octet-stream';
};

const notFound = (detail: string) =>
	new Response(detail, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });

const isAbort = (cause: unknown): boolean => cause instanceof Error && cause.name === 'AbortError';

function refusal(failure: TileSourceFailure): Response {
	const detail = describeFailure(failure);
	const wanted =
		failure.kind === 'server-error' ? failure.status : failure.kind === 'no-answer' ? 504 : 500;
	return new Response(JSON.stringify({ error: detail }), {
		status: wanted >= 200 && wanted <= 599 ? wanted : 500,
		statusText: reasonPhrase(detail),
		headers: { 'content-type': 'application/json' }
	});
}

const reasonPhrase = (detail: string): string =>
	detail
		.replace(/[^\x21-\x7e]+/gu, ' ')
		.trim()
		.slice(0, 200);

const describeFailure = (failure: TileSourceFailure): string => {
	const where = failure.host ?? 'this site';
	switch (failure.kind) {
		case 'no-answer':
			return `${where} could not be reached.`;
		case 'file-missing':
			return `${where} does not hold that file.`;
		case 'server-error':
			return `${where} answered ${failure.status}.`;
		case 'unreadable':
			return `${where} could not be read: ${failure.detail}`;
	}
};

// Installed inside other people's renderers, whose callers never see the promise: answer, don't reject.
export function createStoreImageFetch(options: {
	readonly store: ReadOnlyProjectStore;
	readonly fetch?: FetchFn;
	readonly onOutcome?: (outcome: TileFetchOutcome) => void;
}): FetchFn {
	const { store, onOutcome } = options;
	const passThrough = options.fetch ?? ((input, init) => fetch(input, init));
	const outstanding = new Set<string>();
	const arrivedAt = new Map<string, number>();
	const inFlight = new Map<string, number>();
	let clock = 0;
	const tick = (): number => (clock += 1);

	const opened = (url: string): void => {
		inFlight.set(url, (inFlight.get(url) ?? 0) + 1);
	};
	const closed = (url: string): void => {
		const left = (inFlight.get(url) ?? 1) - 1;
		if (left > 0) {
			inFlight.set(url, left);
			return;
		}
		inFlight.delete(url);
		arrivedAt.delete(url);
	};

	const tell = (outcome: TileFetchOutcome): void => {
		try {
			onOutcome?.(outcome);
		} catch (cause) {
			queueMicrotask(() => {
				throw cause;
			});
		}
	};

	const arrived = (url: string): void => {
		arrivedAt.set(url, tick());
		if (outstanding.delete(url) && outstanding.size === 0) tell({ ok: true });
	};
	const refused = (
		url: string,
		issuedAt: number,
		failure: TileSourceFailure,
		imageId: string | null
	): void => {
		if ((arrivedAt.get(url) ?? 0) > issuedAt) return;
		outstanding.add(url);
		tell({ ok: false, failure, imageId });
	};

	const answer: FetchFn = async (input, init) => {
		const url = urlOf(input);
		const issuedAt = tick();

		if (!isImageServicePlaceholderUrl(url)) {
			try {
				const response = await passThrough(input, init);
				if (response.ok) arrived(url);
				return response;
			} catch (cause) {
				if (!isAbort(cause)) {
					refused(url, issuedAt, classifyTileFailure(cause, parseUrl(url)?.hostname ?? null), null);
				}
				throw cause;
			}
		}

		const method = (
			init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
		).toUpperCase();

		if (method !== 'GET' && method !== 'HEAD') {
			return new Response(`${method} is not something a stored pyramid can answer.`, {
				status: 405,
				headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }
			});
		}

		const [imageId, ...rest] = parseUrl(url)!.pathname.split('/').slice(1).map(decodeURIComponent);

		if (!imageId || rest.length === 0) {
			return notFound(
				`${url} names no tile. A pyramid answers at ` +
					`${IMAGE_SERVICE_PLACEHOLDER_ORIGIN}/<image-id>/<iiif-path>.`
			);
		}

		let path: StorePath;
		try {
			path = assertStorePath(`${imageDirectory(imageId)}/${rest.join('/')}`);
		} catch {
			return notFound(`${url} does not name a file this Project could hold.`);
		}

		let bytes;
		try {
			bytes = await store.read(path);
		} catch (cause) {
			if (isAbort(cause)) throw cause;
			const failure = classifyTileFailure(cause);
			// A missing tile is routine (the parser asks for cells the tiler never cut); a missing info.json is not.
			if (failure.kind !== 'file-missing' || path === imageInfoPath(imageId)) {
				refused(url, issuedAt, failure, imageId);
			}
			if (failure.kind === 'file-missing') {
				return notFound(`Nothing is stored at ${path}, which is where ${url} resolves to.`);
			}
			return refusal(failure);
		}

		arrived(url);

		return new Response(method === 'HEAD' ? null : bytes, {
			status: 200,
			headers: { 'content-type': mediaType(path), 'content-length': String(bytes.byteLength) }
		});
	};

	return async (input, init) => {
		const url = urlOf(input);
		opened(url);
		try {
			return await answer(input, init);
		} finally {
			closed(url);
		}
	};
}

const GUARDED = Symbol.for('ballastella.imageServiceGuard');

export function refuseUnroutedImageServiceRequests(
	scope: { fetch: FetchFn } = globalThis as unknown as { fetch: FetchFn }
): () => void {
	const original = scope.fetch;

	if (GUARDED in original) {
		return () => undefined;
	}

	const guarded: FetchFn = (input, init) => {
		const url = urlOf(input);
		return isImageServicePlaceholderUrl(url)
			? Promise.reject(new MissingImageServiceOverrideError(url))
			: original.call(scope, input, init);
	};

	Object.defineProperty(guarded, GUARDED, { value: true });
	scope.fetch = guarded;

	return () => {
		if (scope.fetch === guarded) {
			scope.fetch = original;
		}
	};
}
