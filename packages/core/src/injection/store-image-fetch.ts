// The one shim that gives a stored pyramid a URL (ADR-0011).
//
// Tiles in OPFS or in a picked folder have no URL, and every renderer wants one. `<img src>`
// cannot reach them, MapLibre cannot fetch them, OpenSeadragon cannot fetch them. So each
// consumer is handed its bytes through its own documented extension point — `addProtocol` for a
// MapLibre source, `fetchFn` for `@allmaps/maplibre`, a `TileSource` for OpenSeadragon — and all
// of them resolve through the single function below.
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
// This module is deliberately free of the tiler (ADR-0019): `apps/viewer` will read a site's
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
import { SiteFileUnreachableError } from '../store/http-project-store.js';
import { imageDirectory, imageInfoPath } from '../project/image-files.js';
import { IMAGE_SERVICE_PLACEHOLDER_ORIGIN } from '../tiler/pyramid.js';
import type { TileSourceFailure } from './tile-failure.js';

// **The placeholder resolves at the Workspace root, and takes no Project directory** (ADR-0023).
// A Map Image's pyramid is shared by every Project that references it, so there is one answer to
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
	 * saying so in the type is what lets an HTTP backend (ADR-0006) be handed to it: a
	 * Published Site's pyramid is read through exactly this function, and the viewer has no `write`
	 * to give. See {@link ReadOnlyProjectStore}.
	 */
	readonly store: ReadOnlyProjectStore;
	/**
	 * Where everything that is *not* the placeholder host goes. Defaults to the page's own
	 * `fetch`, and is injected so that the pass-through half of the rule can be asserted.
	 */
	readonly fetch?: FetchFn;
	/**
	 * Told what became of each request, so the app can say when a Map Image stops drawing.
	 *
	 * ⚠ **Optional, and each shim reports only to its own caller.** The published viewer passes one
	 * for the map it draws, and so does the editor's Project screen; the editor's other readers of
	 * this shim deliberately pass none.
	 *
	 * **That is the answer to the trap, rather than a gap.** A refused URL keeps the notice up until
	 * that URL comes back, and the editor makes requests through this shim that are *expected* to
	 * fail and are never retried — `add-remote-map`'s cross-origin tile probe deliberately asks a
	 * host for a tile to find out whether it will answer. Wired globally, one probe against an
	 * unreachable library would leave a permanent "a Map Image stopped drawing" over a Workspace
	 * where nothing is wrong. So `EditorSession#imageServiceFetch` hands out a shim per caller and
	 * only the Project map asks to be told; a probe, an offline copy and a thumbnail each get one
	 * that reports to nobody.
	 *
	 * The callers that report nothing are no worse off than a listener would make them:
	 * `MapImagePane.svelte`'s ADR-0008 catch and `tile-protocol.ts` already turn a refusal into a
	 * sentence a scholar reads, by throwing on a non-ok `Response`, and {@link refusal} carries the
	 * store's own cause through in `statusText` so that sentence still names it.
	 *
	 * See {@link TileFetchOutcome} for which requests are reported and which are deliberately not.
	 */
	readonly onOutcome?: (outcome: TileFetchOutcome) => void;
};

/**
 * What became of one request for a Map Image's bytes.
 *
 * ⚠ **Not every request produces one.** A **404 for a tile cell is not reported at all**, and that
 * is a measured decision rather than an omission: `@allmaps/iiif-parser` derives its own tile grid
 * from the `info.json` and asks for cells the tiler never planned, so a complete, healthy pyramid
 * answers 404 to some of the requests made against it on every load. `e2e/viewer-reader.e2e.ts`
 * records the same fact from the other side — its "no 404 for anything the page asked for"
 * assertion has to exclude `/default.jpg` for exactly this reason. Reporting those would put a
 * permanent "this map stopped drawing" over a map that is drawing perfectly, which is the failure
 * mode a notice can least afford.
 *
 * A 404 for the pyramid's own `info.json` **is** reported, because without it there is no map at
 * all: that is a site that was written incomplete, and it is the `file-missing` remedy.
 *
 * ⚠ **That policy leaves a hole, and the hole is written down as a hole:** a Published Site carrying
 * its `info.json` while missing some of its *tile* files draws a map with gaps in it and says
 * nothing. It is a known residual rather than a settled trade-off, and closing it needs the
 * pyramid to carry a record of which cells were actually written — a change to what the site write
 * emits, not to what the reader reports. **ADR-0028** states it, with the reason the obvious fix is
 * the wrong one.
 */
export type TileFetchOutcome =
	/**
	 * Every URL that had been refused has now come back. The app takes its notice down.
	 *
	 * Not "some bytes arrived": during a partial outage plenty of bytes arrive while the map stays
	 * holed, and a notice withdrawn on that evidence is a notice withdrawn over a broken map.
	 */
	| { readonly ok: true }
	/** Bytes did not arrive, for a reason a person can be told. */
	| {
			readonly ok: false;
			readonly failure: TileSourceFailure;
			/**
			 * The Map Image whose bytes these were, or `null` for a request that named no image.
			 *
			 * The app resolves it to a Layer's name, because "a Map Image stopped drawing" sends a
			 * Reader looking through a stack and "*this* one stopped drawing" does not. `null` for the
			 * pass-through half, which carries a URL and no image id — a sentence that named the wrong
			 * map would be worse than one that named none.
			 */
			readonly imageId: string | null;
	  };

/** `SiteFileUnreachableError` uses `''` for "no host in the URL"; the notice layer uses `null`. */
const hostOrHere = (host: string): string | null => (host === '' ? null : host);

/**
 * A refusal, in the terms the sentence branches on.
 *
 * **Branching on the facts the error carries, never on which app is asking** — the same store error
 * means the same thing to a Reader on a published site and to a scholar whose Library stopped
 * answering, and the two deployments must be incapable of describing it differently.
 */
function classifyTileFailure(cause: unknown, host: string | null = null): TileSourceFailure {
	if (cause instanceof SiteFileUnreachableError) {
		// The two message forms `SiteFileUnreachableError` already distinguishes, kept distinct: a
		// status means a server answered and is failing, and its absence means nothing answered at
		// all. The remedies are opposites — one is worth waiting out, the other may be your own wifi.
		// Its own host wins over the caller's, because it is the URL the read actually went to.
		const named = hostOrHere(cause.host);
		return cause.status === 0
			? { kind: 'no-answer', host: named }
			: { kind: 'server-error', host: named, status: cause.status };
	}
	if (cause instanceof PathNotFoundError) {
		return { kind: 'file-missing', host };
	}
	if (cause instanceof TypeError) {
		// What `fetch` rejects with when the request never got an answer — a dropped connection, a
		// refused socket, a CORS refusal. The pass-through half meets this rather than a store error,
		// and it is the same fact `SiteFileUnreachableError`'s `status === 0` records.
		return { kind: 'no-answer', host };
	}
	return { kind: 'unreadable', host, detail: describeCause(cause) };
}

/**
 * A cause as text, from something that need not be an `Error` and need not be describable at all.
 *
 * ⚠ **`String(cause)` is a third way this module could reject**, in a docblock that says there are
 * exactly two. `String(Object.create(null))` throws `TypeError: Cannot convert object to primitive
 * value`, and a cause whose own `toString` throws throws that instead — and either escapes as an
 * unhandled rejection into the renderer, which is the one class this whole boundary exists to stop.
 * A store can reject with anything; `throw` takes any value.
 */
const describeCause = (cause: unknown): string => {
	if (cause instanceof Error && typeof cause.message === 'string') return cause.message;
	try {
		return String(cause);
	} catch {
		return 'the reason could not be read';
	}
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
 * Whether a rejection is the caller cancelling rather than a failure.
 *
 * By `name` and not by class: `AbortError` is a `DOMException` in a browser and something else again
 * under `undici`, and the one thing every runtime agrees on is the name. Upstream recognises it the
 * same way — `CacheableWorkerImageDataTile.fetch` catches `err.name === 'AbortError'` and does
 * nothing — so an abort is rethrown untouched rather than reported.
 */
const isAbort = (cause: unknown): boolean => cause instanceof Error && cause.name === 'AbortError';

/**
 * The `Response` a refusal becomes.
 *
 * The status is the refusal's own where there is one, so a caller reading `response.status` reads
 * what the server said. The body is the sentence's *facts*, not the sentence: a renderer's log is
 * not where a person is told anything, and {@link mapImageTilesUnavailableNotice} owns the
 * wording so that the two deployments cannot drift.
 *
 * ⚠ **`statusText` carries the cause, and that is not decoration.** Two callers in the editor build
 * a sentence a scholar reads out of `${status} ${statusText}` — `MapImagePane.svelte`'s
 * ADR-0008 catch and `tile-protocol.ts`'s tile loader — and both of them used to receive the store's
 * own thrown error. Answering with a bare status turned `“abc123” could not be opened: the quota was
 * exceeded` into `… (500 )`, losing the cause and leaving a dangling space. Measured, and fixed here
 * rather than by editing those two call sites, because the fault is this function throwing away
 * something it was handed.
 *
 * ⚠ **The status is clamped.** `SiteFileUnreachableError.status` is a plain `number` on an exported
 * class, and `new Response(…, { status: 999 })` throws `RangeError` — out of the one function in
 * this module that promises never to reject for a request it answers.
 */
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

/**
 * `detail` as something `statusText` will accept.
 *
 * ⚠ **The accepted set is narrower than it looks, and it was measured rather than assumed.** A
 * `Response`'s `statusText` throws `TypeError` for a newline, for `NUL`, for `BEL`, for `DEL` — and
 * **for any character above US-ASCII at all**, which matters here because this repository's own error
 * messages are full of typographic dashes and curly quotes. A first version of this folded only
 * `< 0x20` and would have thrown on the shim's own wording.
 *
 * So the filter is the grammar rather than a list of things noticed: `SP` and `VCHAR` (0x20–0x7E)
 * survive, everything else becomes a space. Then collapsed, trimmed, and cut short, because a
 * reason-phrase is a label and not a log.
 *
 * Two small corrections to what this used to say about itself. `HTAB` was named as a third survivor;
 * it is legal in a reason-phrase, but the collapse turns it into a space either way, so the branch
 * was dead and is gone. And the code-point iteration was credited with turning an astral character
 * into one space rather than two — the collapse does that, whatever the iteration produces.
 *
 * ⚠ **Those characters are FOLDED, not carried.** This is the transport that cannot take them, so
 * `“abc123” could not be opened` reaches the editor's sentence as `abc123 could not be opened` —
 * curly quotes and dashes become spaces and the spaces collapse. That is the intended trade (the
 * cause survives, its typography does not) and it is written here because the paragraph above is
 * *about* those characters and would otherwise read as though they come through.
 */
const reasonPhrase = (detail: string): string =>
	[...detail]
		.map((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code >= 0x20 && code <= 0x7e ? character : ' ';
		})
		.join('')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200);

/** The facts, for a log or a `Response` body. Never shown to a person — see the note above. */
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

/**
 * A `fetch` that answers the placeholder host from the Workspace's Map Images, and leaves every
 * other host alone.
 *
 * **Workspace-rooted, and it takes no Project directory** (ADR-0023). One instance therefore serves
 * every Project, which is what makes two Projects referencing the same `imageId` draw the same pyramid
 * from the same bytes.
 *
 * The pass-through is the half that is easy to get wrong and matters as much: a remote referenced
 * image must keep working through the ordinary network path, so the original `input` and `init` are
 * handed on **unmodified** rather than rebuilt from a parsed URL — a remote IIIF service is entitled
 * to the request its caller made, headers included.
 *
 * **A request this function answers itself — anything addressed to the placeholder host — comes back
 * as a `Response`, whatever went wrong.** There are exactly two ways the returned promise rejects,
 * both of them deliberate and both asserted: a **pass-through** request rejects with whatever the
 * network gave it, because that answer is the caller's rather than this shim's; and an **abort**
 * rethrows untouched, because the caller asked for it. Nothing else. In particular a store that
 * refused, a store that could not be reached, and a subscriber that threw all still produce a
 * `Response` — each of those was a way this function used to reject, and each is a way a refusal
 * used to escape into a renderer that would not catch it.
 *
 * ⚠ That guarantee used to be written here as "never rejects", flatly, twenty lines above two
 * documented rejections. The headline is what a reader takes away, so it says what is true.
 *
 * ⚠ It also used to have an exception — "a store that cannot be reached at all is the caller's to
 * render" — and that exception was the defect. This function is installed inside other
 * people's renderers, and the caller never sees the promise: `@allmaps/render`'s `WarpedMap.loadImage`
 * rethrows whatever `fetchFn` rejected with, and `WebGL2Renderer` calls it without awaiting or
 * catching, so the rejection arrived as an uncaught `pageerror` and reached nobody at all. On a
 * published site there is no console anyone is watching, so an error that only reaches the console
 * reaches nobody.
 *
 * So the refusal is caught **here**, at the boundary that supplied the fetch, and turned into two
 * things: a `Response` the renderer can do what it likes with, and a {@link TileFetchOutcome} the app
 * can turn into a sentence. The render layer is never asked what to say.
 *
 * ⚠ **This is necessary and it is not sufficient, and saying otherwise here would be the mistake
 * this module exists to prevent.** `@allmaps/stdlib`'s `fetchUrl` throws for any non-ok `Response`
 * — so a refusal answered politely still becomes an upstream `Error`, raised *after* this function
 * has returned, and still lands in the promise `WebGL2Renderer` drops. That half is fixed in
 * `patches/@allmaps__render@1.0.0-beta.83.patch`, which makes that one renderer settle those promises
 * the way upstream's other three already do, and `scripts/check-allmaps-patch.mjs` fails the build if
 * it stops applying. Measured: with the patch reverted, the page error comes straight back.
 */
export function createStoreImageFetch(options: StoreImageFetchOptions): FetchFn {
	const { store, onOutcome } = options;
	const passThrough = options.fetch ?? ((input, init) => fetch(input, init));

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// WHEN A NOTICE GOES UP, AND WHEN IT COMES DOWN: THE BYTES THAT DID NOT ARRIVE
	//
	// **A refusal is reported the moment it happens. An arrival is reported when the last URL that was
	// refused has come back** — not before, and not on the strength of some *other* URL succeeding.
	//
	// ⚠ **This replaced a rule that counted concurrent requests, and the replacement is here because
	// the first rule's stated guarantee was false.** That rule withdrew the notice when a burst of
	// in-flight requests completed with no refusal in it, which is sound while requests overlap and
	// nonsense when they do not: requests issued one at a time each formed their own "burst", so three
	// serial refusals interleaved with three serial successes produced three withdrawals.
	// `@allmaps/render` mostly fetches concurrently, but the tail of a burst and a re-fetched
	// `info.json` are serial, so the hole was reachable.
	//
	// ⚠ **That is measured by `keeps a partial outage's notice up, concurrently and serially alike`,
	// and for one commit it was not.** That test built both promises in a single array literal and
	// chose only whether to *collect* them together — so both fetches were already in flight and its
	// "serial" pass drove the concurrent shape a second time. It passed against the rule it named as
	// broken, while three separate comments said "Measured" about a measurement nothing performed. It
	// issues the second request after the first has settled now, and against the old rule it reports
	// `serial: expected [{ok:true},{ok:true},{ok:true}] to deeply equal []`.
	//
	// Naming the URLs removes the question rather than answering it better. There is no burst and no
	// difference between the serial and the concurrent case: the notice is up exactly while some URL
	// the map asked for has not come back. A *partial* outage keeps its notice, because the cells it
	// refuses stay outstanding however many others succeed.
	//
	// ⚠ **Two requests for the SAME URL are the one place order could still have decided it, and it
	// does not.** Nothing stops two of them overlapping — `WarpedMap.loadImage` fills
	// `imagesById` only after its fetch resolves, so two Layers on one `imageId` (which ADR-0023
	// exists to make legal, and the viewer supports) both fetch that `info.json` at once. Mid-outage
	// one can fail while the other succeeds, and if the failure settled last a set keyed on URL alone
	// recorded a refusal for bytes the page was holding — a notice that never came down over a map
	// with nothing wrong with it. So a refusal is dropped when a request for the same URL, issued
	// before it settled, has already come back: the bytes are in hand, whoever fetched them.
	//
	// A clock and not a timer — a counter ticked on each issue and each arrival, so the rule is
	// decided by program order and the tests are not timing tests.
	//
	// ⚠ **The consequence, stated because it is the thing a reader will want to know:** a refused URL
	// that is never asked for again keeps the notice up. That is deliberate — those bytes really are
	// missing from the map — and it is why the sentence's remedy has to name the gesture that fetches
	// them rather than promising the map will heal on its own. See `tile-failure.ts`, and the two
	// end-to-end tests that measure which failures self-heal and which do not.
	//
	// ⚠ **What each collection holds, because an earlier comment here got the bound wrong twice in
	// one sentence.** `outstanding` holds URLs that were refused and have not come back; it deletes on
	// arrival, so it is as large as the map's current shortfall. `arrivedAt` is bookkeeping for the
	// race above and is needed only while a request for that URL is still in flight, so it is dropped
	// when the last one settles — a handful of entries, not one per URL of the session. The comment
	// this replaces claimed both were "bounded by the pyramid, which is the same bound the renderer's
	// own tile cache carries": `arrivedAt` had no delete at all and grew monotonically, and the
	// renderer's cache is bounded by the viewport neighbourhood and *shrinks* (`TileCache.prune`).
	// Neither half was true.
	//
	// ⚠ **What the tests do and do not hold here, measured rather than assumed.** Forgetting a URL's
	// timestamp *too early* is caught — `does not report a refusal for bytes an overlapping request
	// already brought back` goes red the moment `closed` stops waiting for the last request. Never
	// forgetting at all is **not** caught, and cannot be: keeping an entry longer than necessary is
	// behaviourally identical to keeping it for ever, so deleting `arrivedAt.delete(url)` leaves the
	// suite green. So the half that can be wrong is pinned and the half that can only waste memory is
	// not, and that is written here so the next reader does not have to rediscover which is which.
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
		// Nothing is asking for this URL any more, so no refusal can still be in flight against an
		// arrival of it. The timestamp has nothing left to decide.
		inFlight.delete(url);
		arrivedAt.delete(url);
	};

	/**
	 * Hand an outcome to the app, and never let the app's own failure destroy this request.
	 *
	 * ⚠ **A subscriber is application code and it can throw.** `onOutcome` is called from the middle
	 * of a fetch — once from a `catch`, once beside a 200 whose `Response` is already built — so an
	 * unguarded call turns a tile that *arrived* into a rejected promise, inside a function whose
	 * whole purpose is that refusals do not escape into a renderer. That is the `9ee43b5` defect at a
	 * new seam, and this is the same answer: the path is not the subscriber's to break.
	 *
	 * Rethrown out of band rather than swallowed, because a silent subscriber failure is precisely
	 * what this module exists to stop. `queueMicrotask` puts it where an uncaught error goes, with
	 * nothing of ours left on the stack to catch it, so the page's error handling and the suite's
	 * `pageerror` watch both see it — and the tile still arrives.
	 */
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
		// Another request for these very bytes, overlapping this one, already brought them back. The
		// map has them; saying they are missing would be false and the notice would never come down.
		if ((arrivedAt.get(url) ?? 0) > issuedAt) return;
		outstanding.add(url);
		tell({ ok: false, failure, imageId });
	};

	const answer: FetchFn = async (input, init) => {
		const url = urlOf(input);
		const issuedAt = tick();

		if (!isImageServicePlaceholderUrl(url)) {
			// The pass-through half fails too — a referenced image on a Library's server (ADR-0023) is
			// fetched over the ordinary network path — so its failures are **reported**, which is what
			// makes "a Library's server is failing" a row somebody can meet rather than a row that only
			// exists in a test.
			//
			// ⚠ **Reported and then RETHROWN, unlike the store half, and that asymmetry was paid for.**
			// The first version answered a pass-through rejection with a `Response` the way the store
			// half does, and it broke `editor-remote-iiif.e2e.ts`'s cross-origin probe: that probe tells
			// a host whose tiles cannot be read cross-origin ("completely blank") from a host that is
			// merely busy, and it tells them apart *by the rejection*. Handed a synthetic 504 instead, it
			// reported the wrong one of two sentences a scholar acts on. Measured, on both attempts.
			//
			// The general rule behind it: this shim owns what happens to a request **it** answers, and a
			// pass-through request is somebody else's — the caller made it, the caller is entitled to its
			// answer, rejection included. Nothing is lost by rethrowing: the renderer's own tile path
			// already catches a rejected tile (`CacheableWorkerImageDataTile.fetch`), and the one place
			// that dropped one — `WebGL2Renderer`'s `loadMissingImagesInViewport` — is patched.
			//
			// `input` and `init` are handed on **unmodified**: a remote IIIF service is entitled to the
			// request its caller made, headers included, and to answer it however it likes.
			try {
				const response = await passThrough(input, init);
				if (response.ok) arrived(url);
				return response;
			} catch (cause) {
				// An abort is the caller changing its mind, not a failure: the viewport moved and the
				// tile is no longer wanted. Reporting one would put "the tiles stopped arriving" on
				// screen every time a Reader panned the map.
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
			if (isAbort(cause)) throw cause;
			const failure = classifyTileFailure(cause);
			// **A missing tile is not reported; a missing `info.json` is.** `@allmaps/iiif-parser`
			// derives its own grid from the `info.json` and asks for cells the tiler never planned, so
			// a complete pyramid answers 404 to some requests on every single load — see
			// {@link TileFetchOutcome}. Without the `info.json` there is no map at all, and that is a
			// site written incomplete.
			if (failure.kind !== 'file-missing' || path === imageInfoPath(imageId)) {
				refused(url, issuedAt, failure, imageId);
			}
			if (failure.kind === 'file-missing') {
				return notFound(`Nothing is stored at ${path}, which is where ${url} resolves to.`);
			}
			return refusal(failure);
		}

		arrived(url);

		const headers = {
			'content-type': mediaType(path),
			'content-length': String(bytes.byteLength)
		};

		return method === 'HEAD'
			? new Response(null, { status: 200, headers })
			: new Response(bytes, { status: 200, headers });
	};

	// The in-flight bookkeeping wraps every path, including the ones that answer without a read — a
	// 405 or a malformed path opened a request too, and one that never closed would pin `arrivedAt`
	// for ever. It calls no subscriber, so a throwing `onOutcome` cannot reach it.
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

/** Marks a `fetch` this module has already wrapped, so installing twice is not two wrappers. */
const GUARDED = Symbol.for('ballastella.imageServiceGuard');

/**
 * Make a request that escaped the injection layer say so, instead of failing at DNS.
 *
 * ADR-0004's rule that "every code path constructing an `Image` sets `uri` before requesting a
 * tile" is the most fragile invariant in the project, and it is fragile for a mundane reason:
 * `Image#uri` is a plain public field, so the override is a single assignment, and a single
 * assignment is what a new code path forgets. The consumers wired here cannot forget — a MapLibre
 * source reaches its tiles only through the registered protocol, and `@allmaps/maplibre` is
 * constructed with `fetchFn` — but the *next* consumer can, and what it gets for free is a blank
 * map and a DNS error naming nothing.
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
