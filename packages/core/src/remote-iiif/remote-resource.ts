// Reading a IIIF resource somebody else published: the URL the user pasted, turned into a
// parsed Manifest, Collection, or Image (ADR-0015).
//
// **Everything this module reads is a stranger's document fetched over the network**, and it is
// treated the way ticket 13 learned to treat an uploaded zip: nothing is trusted because it
// declares itself, every bound is stated as a number, and a refusal names what was wrong and
// which host said it. The failure this exists to prevent is the one a scholar cannot act on —
// a blank pane, or a stack trace about `undefined`, when the real answer is "that URL is an
// HTML error page" or "that manifest has forty thousand canvases".
//
// One `@allmaps/iiif-parser` call handles all three shapes, which is what ADR-0015 asks for and
// what makes a Collection cost nothing extra: a library hands a scholar one URL for an atlas,
// and without Collection support they have to go hunting for individual manifest URLs, which is
// the friction that makes people give up before aligning anything.
//
// **This is not the parser triiiceratops uses.** triiiceratops carries `manifesto.js` and does
// its own navigation; the only thing that crosses between them is an image service URI string
// (ADR-0018). So the two parsers never consume each other's interpretation, and any
// disagreement between them about anything else in the manifest cannot matter.

import { IIIF, type Collection, type Image, type Manifest } from '@allmaps/iiif-parser';

import type { FetchFn } from '../injection/store-image-fetch.js';

/** Which of the three IIIF shapes a pasted URL turned out to name. */
export type RemoteIiifKind = 'image' | 'manifest' | 'collection';

/**
 * The bounds this module applies to a document nobody vouches for.
 *
 * Every one of these is a number rather than a judgement, because ticket 13's review found the
 * opposite: a declared size that was trusted, and nothing bounding it. They are generous — the
 * point is that a hostile or broken response cannot exhaust the tab, not that a real library's
 * atlas is refused.
 */
export type RemoteIiifLimits = {
	/**
	 * Largest `info.json`, Manifest, or Collection this will read, in bytes.
	 *
	 * Enforced by **counting the bytes as they arrive**, not by believing `content-length`: a
	 * response may omit it, and a hostile one may lie. 8 MiB is roughly twenty times the largest
	 * real Manifest measured while building this (a 500-canvas atlas), and a hundredth of what a
	 * tab can lose to a chunked response with no end.
	 */
	readonly documentBytes: number;
	/** How long any one request may take before it is abandoned. */
	readonly timeoutMs: number;
	/**
	 * Most canvases this will navigate in one Manifest.
	 *
	 * A bound rather than an opinion about scholarship: a Manifest of a bound volume runs to
	 * hundreds of canvases and must work. What is refused is the shape that would make the
	 * browse list unusable and — because the Allmaps lookup fans out per canvas when the API has
	 * nothing for the Manifest as a whole — would turn one paste into thousands of third-party
	 * requests. See `community-alignments.ts`.
	 */
	readonly canvases: number;
	/** Most direct children this will list in one Collection. */
	readonly collectionItems: number;
};

export const REMOTE_IIIF_LIMITS: RemoteIiifLimits = {
	documentBytes: 8 * 1024 * 1024,
	timeoutMs: 20_000,
	canvases: 2_000,
	collectionItems: 2_000
};

/**
 * A remote IIIF resource will not be used, and why — in words a scholar can act on.
 *
 * **The host is a field, not only prose in the message.** SPEC story 24 asks for the host to be
 * named, and a caller that wants to say "ask your librarian whether `tile.loc.gov` allows this"
 * should not have to parse it back out of a sentence.
 */
export class RemoteIiifRejectedError extends Error {
	/** The URL that was refused, as it was asked for. */
	readonly url: string;
	/** Its host, or `''` when the URL was too malformed to have one. */
	readonly host: string;

	constructor(options: { url: string; host?: string; reason: string }) {
		super(options.reason);
		this.name = 'RemoteIiifRejectedError';
		this.url = options.url;
		this.host = options.host ?? '';
	}
}

/**
 * The URL to fetch, or a refusal.
 *
 * Four things are refused, and each is a paste that would otherwise fail somewhere less
 * legible:
 *
 *   * **A relative or unparseable URL** — there is no page-relative IIIF service; the user
 *     pasted a fragment of one.
 *   * **Any scheme but `http`/`https`.** `data:` and `blob:` would let a pasted string become a
 *     document this app parses and then stores a reference to, and `file:` cannot be fetched
 *     from a page at all. IIIF requires an HTTP(S) URI, so nothing legitimate is lost.
 *   * **Credentials in the URL.** `https://user:secret@host/…` would be written into
 *     `project.json` and into the Alignment, and then handed to a colleague in a zip. A URL is
 *     not a place to keep a password, and silently stripping it would produce a reference that
 *     404s with no explanation.
 *   * **A fragment.** `#…` is never part of a IIIF service URI and its presence means the user
 *     copied a viewer's deep link. Stripped rather than refused — it is unambiguous what they
 *     meant — but stripped *here*, so the identifier minted downstream is minted from the URI
 *     and not from the deep link. `generateId` hashes the string it is given.
 */
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

	url.hash = '';
	return url;
}

export type ReadRemoteIiifOptions = {
	/**
	 * How the network is reached. Injected rather than reached for, so a test can serve a
	 * stranger's document without a network, and so the app's ADR-0011 shim — which passes
	 * every non-placeholder host straight through — is what real requests go through.
	 */
	readonly fetch: FetchFn;
	readonly limits?: Partial<RemoteIiifLimits>;
};

/** One parsed remote resource, with the URL it was read from kept beside it. */
export type RemoteIiifResource = {
	readonly kind: RemoteIiifKind;
	/** The URL that was fetched, after {@link remoteIiifUrl} normalised it. */
	readonly url: string;
	/** The document as it arrived, unmodified. Kept so nothing has to re-fetch to re-read it. */
	readonly document: unknown;
	readonly parsed: Image | Manifest | Collection;
};

/**
 * Fetch and parse whatever IIIF resource a URL names.
 *
 * Deliberately does **not** decide anything about the resource beyond its shape. Whether an
 * image service can actually be used is `image-service.ts` and `cors-probe.ts`; which canvas is
 * the map is the user's, through triiiceratops.
 */
export async function readRemoteIiifResource(
	input: string | URL,
	options: ReadRemoteIiifOptions
): Promise<RemoteIiifResource> {
	const url = input instanceof URL ? input : remoteIiifUrl(input);
	const limits = { ...REMOTE_IIIF_LIMITS, ...options.limits };
	const document = await fetchRemoteJson(url, { ...options, limits });

	let parsed: Image | Manifest | Collection;
	try {
		parsed = IIIF.parse(document);
	} catch (cause) {
		throw new RemoteIiifRejectedError({
			url: url.href,
			host: url.hostname,
			reason:
				`${url.hostname} answered, but what it sent is not a IIIF Manifest, Collection, or ` +
				`image description: ${message(cause)}. If you pasted the address of a viewer page ` +
				`rather than of the IIIF resource itself, look for a “IIIF” link on that page.`
		});
	}

	assertWithinLimits(parsed, url, limits);
	return { kind: parsed.type, url: url.href, document, parsed };
}

/** What a Manifest or Collection may contain before it stops being navigable. */
function assertWithinLimits(
	parsed: Image | Manifest | Collection,
	url: URL,
	limits: RemoteIiifLimits
): void {
	if (parsed.type === 'manifest' && parsed.canvases.length > limits.canvases) {
		throw new RemoteIiifRejectedError({
			url: url.href,
			host: url.hostname,
			reason:
				`That Manifest lists ${parsed.canvases.length} canvases, past the ${limits.canvases} ` +
				`Ballastella will browse at once. Nothing has been added. If it is a Collection of ` +
				`volumes, paste the Collection's address instead — Ballastella will let you open one ` +
				`volume at a time.`
		});
	}

	if (parsed.type === 'collection' && parsed.items.length > limits.collectionItems) {
		throw new RemoteIiifRejectedError({
			url: url.href,
			host: url.hostname,
			reason:
				`That Collection lists ${parsed.items.length} items, past the ` +
				`${limits.collectionItems} Ballastella will browse at once. Nothing has been added.`
		});
	}
}

/**
 * A JSON document from somebody else's server, read under every bound in {@link
 * RemoteIiifLimits}.
 *
 * **The bytes are counted as they arrive.** `content-length` is advisory — plenty of real IIIF
 * services omit it, and a response that lies about it is exactly the case a bound exists for —
 * so the limit is enforced against the stream and the read is abandoned the moment it is passed.
 * That is the same lesson as ticket 13's truncated archive: a declared size is a claim, not a
 * fact.
 *
 * An HTML response is named as such rather than reported as a JSON syntax error. It is the most
 * common single failure on this path — a 404 page, an institutional login wall, a viewer URL
 * pasted instead of a manifest URL — and "Unexpected token '<'" tells a scholar nothing about
 * any of them.
 */
export async function fetchRemoteJson(
	url: URL,
	options: { fetch: FetchFn; limits: RemoteIiifLimits }
): Promise<unknown> {
	const { limits } = options;
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), limits.timeoutMs);

	try {
		let response: Response;
		try {
			response = await options.fetch(url.href, {
				signal: abort.signal,
				// `accept` says what we can read; `redirect: 'follow'` is the default and is left so,
				// because a IIIF service redirecting `info.json` to its canonical host is ordinary —
				// `ids.lib.harvard.edu` does exactly that. Which URL the *identifier* is minted from is
				// settled in `image-service.ts`, not here.
				headers: { accept: 'application/ld+json, application/json;q=0.9' }
			});
		} catch (cause) {
			throw new RemoteIiifRejectedError({
				url: url.href,
				host: url.hostname,
				reason: abort.signal.aborted
					? `${url.hostname} did not answer within ${Math.round(limits.timeoutMs / 1000)} ` +
						`seconds. Nothing has been added; try again, or check the address.`
					: // A `fetch` that rejects cross-origin is usually CORS, and saying so here is worth
						// more than the browser's own "Failed to fetch" — but it can also be DNS or an
						// offline laptop, so both are offered rather than one guessed at.
						`${url.hostname} could not be reached (${message(cause)}). Either it is not ` +
						`responding, you are offline, or it does not allow other websites to read it — ` +
						`which is what a IIIF service has to do for Ballastella to draw its tiles.`
			});
		}

		if (!response.ok) {
			throw new RemoteIiifRejectedError({
				url: url.href,
				host: url.hostname,
				reason: `${url.hostname} answered ${response.status}${
					response.statusText ? ` ${response.statusText}` : ''
				} for that address. Nothing has been added.`
			});
		}

		const contentType = response.headers.get('content-type') ?? '';
		if (/^\s*text\/html\b/i.test(contentType)) {
			throw new RemoteIiifRejectedError({
				url: url.href,
				host: url.hostname,
				reason:
					`${url.hostname} sent a web page rather than a IIIF description. That usually means ` +
					`the address is a viewer page, or a “not found” page answered with a 200. Look for a ` +
					`“IIIF” or “Manifest” link on the page you copied it from.`
			});
		}

		const text = await readBounded(response, url, limits);

		try {
			return JSON.parse(text) as unknown;
		} catch (cause) {
			throw new RemoteIiifRejectedError({
				url: url.href,
				host: url.hostname,
				reason: `${url.hostname} sent something that is not JSON: ${message(cause)}.`
			});
		}
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The response body as text, refused past `limits.documentBytes`.
 *
 * Streams where the platform gives a stream, and falls back to `text()` where it does not — a
 * `Response` built by a test or by a shim may have no `body`. The fallback still checks the
 * size, so the bound holds either way; what it cannot do is stop reading early.
 */
async function readBounded(
	response: Response,
	url: URL,
	limits: RemoteIiifLimits
): Promise<string> {
	const tooLarge = (bytes: number) =>
		new RemoteIiifRejectedError({
			url: url.href,
			host: url.hostname,
			reason:
				`${url.hostname} is sending more than ${Math.round(limits.documentBytes / 1024)} kB of ` +
				`IIIF description (${bytes} bytes so far), which is past what Ballastella will read. ` +
				`Nothing has been added.`
		});

	const body = response.body;
	if (!body) {
		const text = await response.text();
		const bytes = new TextEncoder().encode(text).byteLength;
		if (bytes > limits.documentBytes) throw tooLarge(bytes);
		return text;
	}

	const reader = body.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: false });
	let read = 0;
	let text = '';

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			read += value.byteLength;
			if (read > limits.documentBytes) throw tooLarge(read);
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		// Releases the lock whether the read finished or was refused, so a bounded-out response
		// cannot leave a body pinned open.
		reader.releaseLock();
	}

	return text + decoder.decode();
}

const message = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);
