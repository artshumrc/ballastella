// The third `ProjectStore` backend: a Published Site read over HTTP (ADR-0006).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A {@link ReadOnlyProjectStore} AND NOT A {@link ProjectStore}
//
// ADR-0001's abstraction paying out a third time — OPFS, a picked folder, and now somebody's web
// server — but only for the half a web server has. Four of `ProjectStore`'s six methods have no
// honest implementation here, and the reasons are different in kind rather than degrees of
// inconvenience:
//
//   * **`write`, and therefore `reclaimAbandonedWrites`.** A static host does not accept bytes.
//     The viewer has no store `write`, and the way to make that true is for there to be no method —
//     not a method that rejects. A rejecting `write` is reachable code
//     the compiler will not argue with, and the failure it produces is a Reader being shown an
//     error at the end of a gesture that should never have been offered.
//   * **`list`.** *There is no directory listing on a static host*, which is the fact the whole of
//     a Published Site is shaped around: `ballastella-site.json` exists because the hub page cannot
//     enumerate the Workspace, and that record deliberately holds no file paths (see
//     `published-site/published-site.ts`). So `list` is not merely unimplemented, it is **unanswerable** — and an
//     implementation returning `[]` would be a lie in the worst direction, since every caller reads
//     an empty list as "there is nothing there" rather than as "I cannot see". A Reader's page
//     therefore follows the references it is given — a map Layer's `imageId` and an Annotation Layer's
//     `geojsonRef`, with `alignments/<id>.json` and `images/<id>/` derived from the image id — all of
//     which are named in `project.json`.
//   * **`size`.** Nothing a Reader does needs it, the hosting-limit warnings belong to the editor,
//     and it would cost one `HEAD` per file.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// EVERY URL IS RELATIVE, AND THIS MODULE IS NOT WHERE THAT IS DECIDED
//
// `resolve` is injected for the same reason ADR-0011's shim takes a `fetch`: one build has to serve
// a domain root *and* `username.github.io/some-repo/`, and which one is unknown at build time
// (ADR-0006). Where a Published Site's files are is the app's knowledge — see
// `apps/viewer/src/lib/site-files.ts` — and core has no business knowing what a deployment looks
// like. It is also what lets the tests drive this with no server at all.

import {
	PathNotFoundError,
	assertStorePath,
	type Bytes,
	type ReadOnlyProjectStore,
	type StorePath
} from './project-store.js';

/**
 * A `fetch` drop-in, structurally the same as ADR-0011's {@link FetchFn}.
 *
 * Declared here rather than imported from the injection layer so that the storage layer does not
 * depend on the renderer's seam to describe its own.
 */
export type HttpFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type HttpProjectStoreOptions = {
	/**
	 * A Workspace-relative store path as a URL this page can fetch.
	 *
	 * Injected, never built here — see the note at the top of this file. It must produce a URL
	 * *relative to the document* rather than to the host's root, or the site works at a domain root
	 * and 404s in a subdirectory, which is the GitHub Pages case ADR-0006 exists for.
	 */
	readonly resolve: (path: StorePath) => string;
	/** The page's own `fetch` by default. Injected so the tests need no server. */
	readonly fetch?: HttpFetch;
};

/**
 * A request for a Published Site's file failed in a way that is not "there is nothing there".
 *
 * Distinct from {@link PathNotFoundError} because the two mean opposite things to a Reader, and
 * conflating them is a defect this codebase has met in another form: a Layer whose document is
 * *absent* is a Project that was written incomplete, and one whose host answered 500 or refused the
 * connection is a Project that is fine and a server that is not. Told apart, the page can say which;
 * folded together, a Reader on a train is told their scholar's work is missing.
 *
 * The host is named because that is the actionable part of the sentence — the viewer's degradation
 * table asks for exactly that of an unreachable referenced image.
 */
export class SiteFileUnreachableError extends Error {
	readonly path: StorePath;
	/** The host that failed, or `''` when the URL was not one that has a host. */
	readonly host: string;
	/** The HTTP status, or `0` when the request never got an answer at all. */
	readonly status: number;

	constructor(path: StorePath, url: string, status: number, detail: string) {
		const host = hostOf(url);
		const where = host === '' ? 'this site' : host;
		super(
			status === 0
				? `${where} could not be reached, so ${path} could not be read: ${detail}`
				: `${where} answered ${status} for ${path}, so it could not be read.`
		);
		this.name = 'SiteFileUnreachableError';
		this.path = path;
		this.host = host;
		this.status = status;
	}
}

const hostOf = (url: string): string => {
	try {
		return new URL(url).host;
	} catch {
		return '';
	}
};

/**
 * Read a Published Site's files over HTTP.
 *
 * `cache: 'no-cache'` — revalidate rather than serve blind from the browser cache. A Published Site
 * is rewritten in place — one repository for a whole semester — so a Reader who looked at it last
 * week must not be shown last week's `project.json` beside this week's tiles. It is
 * `no-cache` and not `no-store` deliberately: a conditional request that comes back 304 costs
 * nothing, and a pyramid is thousands of files.
 *
 * @throws {PathNotFoundError} for 404 and 410 — the file is not on this site
 * @throws {SiteFileUnreachableError} for any other failure, naming the host
 */
export function createHttpProjectStore(options: HttpProjectStoreOptions): ReadOnlyProjectStore {
	const { resolve } = options;
	const request = options.fetch ?? ((input, init) => fetch(input, init));

	return {
		async read(path: StorePath): Promise<Bytes> {
			// Validated by the same function every other backend validates with, so a traversal or an
			// empty segment is refused identically whatever a Project is being read from. It matters more
			// here than anywhere else: a path reaches a URL, and `..` in one resolves against the site.
			const wanted = assertStorePath(path);
			const url = resolve(wanted);

			let response: Response;
			try {
				response = await request(url, { cache: 'no-cache' });
			} catch (cause) {
				// A network failure, a refused connection, a CORS refusal. Never a status.
				throw new SiteFileUnreachableError(
					wanted,
					url,
					0,
					cause instanceof Error ? cause.message : String(cause)
				);
			}

			if (response.status === 404 || response.status === 410) {
				throw new PathNotFoundError(wanted);
			}
			if (!response.ok) {
				throw new SiteFileUnreachableError(wanted, url, response.status, '');
			}

			// `new Uint8Array(await arrayBuffer())` and not the response's own view: `Bytes` is
			// `Uint8Array<ArrayBuffer>`, and every parser in this codebase takes that.
			return new Uint8Array(await response.arrayBuffer());
		}
	};
}
