// The one shim that gives a stored pyramid a URL (ADR-0011).
//
// Tiles in OPFS or in a picked folder have no URL, and every renderer wants one. `<img src>`
// cannot reach them, MapLibre cannot fetch them, OpenSeadragon cannot fetch them. So each
// consumer is handed its bytes through its own documented extension point — `addProtocol` for a
// MapLibre source, `fetchFn` for `@allmaps/maplibre`, a `TileSource` for OpenSeadragon at
// ticket 14 — and all of them resolve through the single function below.
//
// **The routing key is the ADR-0004 placeholder.** Every generated `info.json` carries
// `id: "https://unset.invalid/<image-id>"`, `@allmaps/iiif-parser` builds every tile URL by
// concatenating onto it, and `.invalid` is reserved by RFC 2606 — so a rule that captures that
// host needs no allowlist and can never accidentally swallow a legitimate remote request. That
// is the second reason the placeholder was chosen, and it is why this file matches on a host
// rather than on a scheme of its own.
//
// A service worker serving the store at a virtual path would have given all of this away for
// free, and ADR-0011 rejects it on a specific risk: File System Access directory handles have
// murky permission semantics inside a service worker, and that is the backend most users will
// have. Do not reintroduce it as the cleaner approach.
//
// This module is deliberately free of the tiler (ADR-0019): `apps/viewer` will read published
// pyramids through this same shim, and it must not acquire one. What it
// does import from the tiler's `pyramid.ts` is the pyramid *format* — where an image's files
// live and what its placeholder `id` is — which is exactly the knowledge a reader has to share
// with the writer for the two not to drift.

import {
	PathNotFoundError,
	assertStorePath,
	type ReadOnlyProjectStore,
	type StorePath
} from '../store/project-store.js';
import { imageDirectory } from '../project/image-files.js';
import { IMAGE_SERVICE_PLACEHOLDER_ORIGIN } from '../tiler/pyramid.js';

// **The placeholder resolves at the Workspace root, and takes no Project directory** (ADR-0023).
// A Historical Map's pyramid is shared by every Project that references it, so there is one answer to
// "where are this image's tiles" and it does not depend on which Project is open. That change is the
// riskiest in ADR-0023 precisely because its failure mode is not an error: rooted at the wrong place,
// the shim answers with *somebody else's map*, at the right size, in the right pane. Hence
// `scripts/check-workspace-rooted-paths.mjs`, which refuses any module outside this layer that builds
// an image or Alignment path from a Project directory.

/**
 * A `fetch` drop-in. Structurally identical to `@allmaps/types`' `FetchFn`, which is what
 * `new WarpedMapLayer({ fetchFn })` takes, and declared here so `@ballastella/core` does not
 * have to depend on the render stack to describe its own seam.
 */
export type FetchFn = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

/** The reserved host every placeholder `id` is under. */
const PLACEHOLDER_HOST = new URL(IMAGE_SERVICE_PLACEHOLDER_ORIGIN).hostname;

const parseUrl = (url: string): URL | undefined => {
	try {
		return new URL(url);
	} catch {
		// A relative URL, which is a perfectly ordinary thing to fetch and is never a placeholder.
		return undefined;
	}
};

/** The URL a `fetch` argument is asking for, in whatever form it arrived. */
const urlOf = (input: Request | string | URL): string =>
	typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/**
 * Whether `url` addresses the ADR-0004 placeholder host, and so belongs to the injection layer.
 *
 * Matched on the host exactly, or on a subdomain of it — not with `endsWith`, which would also
 * claim a hypothetical `notunset.invalid`. The point of a reserved TLD is that this rule can be
 * exact and still never miss.
 */
export function isImageServicePlaceholderUrl(url: string): boolean {
	const hostname = parseUrl(url)?.hostname;
	return hostname === PLACEHOLDER_HOST || (hostname?.endsWith(`.${PLACEHOLDER_HOST}`) ?? false);
}

/**
 * Thrown when a request for the placeholder host escaped the injection layer.
 *
 * ADR-0004 promises that a forgotten `Image#uri` override fails loudly. What the browser
 * actually says on its own is `TypeError: Failed to fetch` from a DNS failure against
 * `.invalid`, which names nothing and reads as the tool being broken. This is that failure,
 * said out loud — see {@link refuseUnroutedImageServiceRequests}.
 */
export class MissingImageServiceOverrideError extends Error {
	readonly url: string;

	constructor(url: string) {
		super(
			`Nothing can be fetched from ${url}. That is the deliberately unusable placeholder host ` +
				`every generated info.json carries (ADR-0004), so whatever built this URL never had its ` +
				`tiles routed anywhere: either assign Image#uri to the base the tiles are really served ` +
				`from, or give the consumer the ProjectStore shim — createStoreImageFetch, reached by ` +
				`addProtocol for a MapLibre source and by the fetchFn option for @allmaps/maplibre ` +
				`(ADR-0011).`
		);
		this.name = 'MissingImageServiceOverrideError';
		this.url = url;
	}
}

export type StoreImageFetchOptions = {
	/**
	 * The store to resolve a pyramid out of. **The read half only** — this shim writes nothing, and
	 * saying so in the type is what lets ticket 17's HTTP backend (ADR-0006) be handed to it: a
	 * Published Site's pyramid is read through exactly this function, and the viewer has no `write`
	 * to give. See {@link ReadOnlyProjectStore}.
	 */
	readonly store: ReadOnlyProjectStore;
	/**
	 * Where everything that is *not* the placeholder host goes. Defaults to the page's own
	 * `fetch`, and is injected so that the pass-through half of the rule can be asserted.
	 */
	readonly fetch?: FetchFn;
};

/** Media types by file extension. Tiles are always JPEG (ADR-0003); `info.json` is not. */
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

/**
 * A `fetch` that answers the placeholder host from the Workspace's Historical Maps, and leaves every
 * other host alone.
 *
 * **Workspace-rooted, and it takes no Project directory** (ADR-0023). One instance therefore serves
 * every Project, which is what makes two Projects referencing the same `imageId` draw the same pyramid
 * from the same bytes.
 *
 * The pass-through is the half that is easy to get wrong and matters as much: a remote
 * referenced image (ticket 14) must keep working through the ordinary network path, so the
 * original `input` and `init` are handed on **unmodified** rather than rebuilt from a parsed
 * URL — a remote IIIF service is entitled to the request its caller made, headers included.
 *
 * Answers with a `Response` for anything addressed to the placeholder, including failures, and
 * never throws for one: this function is installed inside other people's renderers, where a
 * rejection for a stray tile is an unhandled rejection rather than a missing tile. A store that
 * cannot be reached at all is the exception — that is ADR-0008's unreachable Workspace, and it
 * is the caller's to render.
 */
export function createStoreImageFetch(options: StoreImageFetchOptions): FetchFn {
	const { store } = options;
	const passThrough = options.fetch ?? ((input, init) => fetch(input, init));

	return async (input, init) => {
		const url = urlOf(input);

		if (!isImageServicePlaceholderUrl(url)) {
			return passThrough(input, init);
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

		// `new URL` has already normalised away any `..`, so what is left is a list of segments
		// under the placeholder host: the image id, then the IIIF path the parser built.
		const segments = parseUrl(url)!.pathname.split('/').slice(1).map(decodeURIComponent);
		const [imageId, ...rest] = segments;

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
			// Not a path this store could hold, so there is nothing there — said as a 404 rather
			// than as a throw, and without a read, so a malformed request cannot become a probe.
			return notFound(`${url} does not name a file this Project could hold.`);
		}

		let bytes;
		try {
			bytes = await store.read(path);
		} catch (cause) {
			if (cause instanceof PathNotFoundError) {
				return notFound(`Nothing is stored at ${path}, which is where ${url} resolves to.`);
			}
			throw cause;
		}

		const headers = {
			'content-type': mediaType(path),
			'content-length': String(bytes.byteLength)
		};

		return method === 'HEAD'
			? new Response(null, { status: 200, headers })
			: new Response(bytes, { status: 200, headers });
	};
}

/** Marks a `fetch` this module has already wrapped, so installing twice is not two wrappers. */
const GUARDED = Symbol.for('ballastella.imageServiceGuard');

/**
 * Make a request that escaped the injection layer say so, instead of failing at DNS.
 *
 * SPEC calls "every code path constructing an `Image` sets `uri` before requesting a tile" the
 * most fragile invariant in the project, and it is fragile for a mundane reason: `Image#uri` is
 * a plain public field, so the override is a single assignment, and a single assignment is what
 * a new code path forgets. The consumers wired here cannot forget — a MapLibre source reaches
 * its tiles only through the registered protocol, and `@allmaps/maplibre` is constructed with
 * `fetchFn` — but the *next* consumer can, and what it gets for free is a blank map and a DNS
 * error naming nothing.
 *
 * So the app installs this once, at startup, over the global `fetch`. Anything addressed to the
 * placeholder that reaches the network is refused before the request is made, with a message
 * that names the missing override. Nothing else is touched.
 *
 * Idempotent, and its teardown restores what was there when *it* wrapped — so installing twice
 * leaves one wrapper and tearing down twice does not strip somebody else's.
 */
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
