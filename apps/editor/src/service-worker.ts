/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ THE APP SHELL, AND NOTHING ELSE (ADR-0012).                                               │
// │                                                                                           │
// │ This worker exists so a scholar can keep working with their own files when the network is   │
// │ absent, and so that installing the app is a real offer rather than a bookmark (ADR-0012).   │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS CACHED, AND WHY THE LISTS ARE SO SHORT
//
// **Two caches, each with a rule that can be stated in one line**, so that what is in them is
// reviewable rather than emergent:
//
//   `ballastella-shell-<version>@<base>/`     the hashed build's code and styles, and the entry HTML
//   `ballastella-base-map-<version>@<base>/`  this deployment's glyphs and sprites
//
// The `@<base>/` is the deployment, and it is load-bearing rather than tidy — see `HERE` below.
//
// Everything else is refused, and the refusals are the point:
//
//   1. **Project data is never cached.** It lives in OPFS, reached through `ProjectStore`. A Cache
//      API copy would be a *second source of truth* competing with the store, and the two diverge
//      the first time a user edits offline. This is the most damaging thing this file could do.
//   2. **Remote IIIF tiles are never cached.** A referenced source can be gigabytes, and the Cache
//      API evicts unpredictably under quota pressure — producing a partially cached Map Image
//      that renders *with holes*, which reads as corruption rather than as absence.
//   3. **Remote Base Map tiles are never cached**, for the same reason. Note the difference from the
//      bundled archive below: `needsNetwork: true` entries are somebody else's server and a whole
//      planet of tiles, and nothing here touches them.
//   4. **The rest of `static/` is never cached.** This is the ADR-0019 hole a precaching worker
//      opens: the editor's `static/` also holds the staged read-only viewer (`viewer-bundle/`),
//      which Publish writes into a Workspace, and this repository's test fixtures.
//      `check-viewer-deps.mjs` polices what the viewer *imports*; it cannot
//      see what a service worker *caches*. Naming the one directory that is wanted, rather than
//      taking `files` whole, is what closes it — and the offline suite asserts each cache's contents
//      against its rule.
//   5. **There is no `.wasm` in `build` to decide about, and that is ADR-0027's doing.** This slot
//      held the longest of these five rules, because the shell's `.js`/`.css` filter existed partly
//      to dodge a 5,084,535-byte `vips.wasm` that `vite build` emitted twice. Precaching it was
//      measured and reverted: it cost 23% more than the 4,137,622-byte pmtiles archive removed
//      alongside it, and it bought criterion 7 — an installed app with no connection accepting a
//      Map Image file on first run — **nothing**, because the streaming tiler could not run in
//      this deployment at all and every image a browser can decode went through the browser-native
//      decode-and-crop tiler, which reaches nothing.
//
//      The tiler that could not run is now gone, and with it the module. The filter stays as it is:
//      it states a rule ("code and styles") rather than a list of things to dodge, so it needs no
//      edit when the thing it was dodging leaves — and the next heavy asset a bundler emits into
//      `build` is excluded by it rather than by somebody remembering. Criterion 7 is still met by
//      the decode-and-crop path, and the offline suite still asserts it with the network off. The
//      residual cost is now honest and narrow in the other direction: an image above the measured
//      decode ceiling cannot be prepared here at all, offline or on, and is refused by name.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// IT DOES NOT SERVE THE STORE
//
// ADR-0011 rejected a service worker serving the `ProjectStore` at a virtual path, because File
// System Access directory handles have murky permission semantics inside a service worker — and
// that is the backend most users will have. A service worker existing does not reopen that
// decision. Tile reads continue through `fetchFn` and `addProtocol` in the page. Concretely: the
// fetch handler below answers **only** URLs it precached, and calls `respondWith` for nothing
// else, so a request it does not recognise behaves exactly as if no worker were installed.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// NO SILENT ACTIVATION
//
// **Nothing here cuts a waiting worker's wait short, and nothing may.** ADR-0012 forbids that one
// call by name, and the source is grepped for it — which is why no comment in this file spells it
// either, so the grep has no decoys to sift.
//
// ADR-0010 named a stale service worker as a version-skew vector, and an explicit prompt is the
// mitigation: silent activation is exactly how an old bundle quietly meets new data. A new worker
// installs, fills its own cache, and then **waits**. `$lib/pwa/installed-app.svelte.ts` notices and
// says so; the user chooses when. Nothing in this file reloads a page or takes over a client,
// because an update must never interrupt somebody mid-alignment.
//
// The consequence of that is deliberate and is what the old-version criterion rests on: while a
// new worker waits, the *old* one keeps serving out of the *old* cache, because the cache is named
// for the build that filled it and `activate` is the only thing that ever deletes another.
//
// ⚠ **A new worker waits only where there is a client to protect.** A page loaded before this
// browser had ever seen this worker is not controlled by it and is therefore not a client of the
// registration, so a version published during that one page's life installs and activates
// immediately — the browser has nobody to wait for, and no code here or in the page can make it
// wait. `activate` then runs, and the caches this build filled go. `$lib/pwa/installed-app.svelte.ts`
// says so when it happens rather than pretending it did not; see `#considerNewer` there for why
// nothing better is available.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// IT WORKS AT A DOMAIN ROOT AND IN A SUBDIRECTORY (ADR-0006)
//
// Nothing here writes a leading `/`. `$service-worker`'s `base` is
// `location.pathname.split('/').slice(0, -1).join('/')` — the worker's own directory, computed at
// runtime — and every entry of `build` and `prerendered` is already prefixed with it. The
// registration in `$lib/pwa/installed-app.svelte.ts` asks for `service-worker.js` relative to the
// deployment, so the scope the browser derives is the deployment's own directory and not the
// origin. A hardcoded `/` here would work at `example.org/` and 404 at `example.org/ballastella/`,
// which is the failure ADR-0006 exists to prevent and which the suite drives at both.
//
// **Cache storage is the one place a scope does not reach**, and it is why `HERE` exists: two
// deployments of this app on one origin share `caches`, so the deployment has to be written into the
// names by hand or each one's `activate` deletes the other's shell.

import { base, build, files, prerendered, version } from '$service-worker';

const worker = self as unknown as ServiceWorkerGlobalScope;

/**
 * Which deployment a cache belongs to, spelled into every cache name.
 *
 * **`caches.keys()` is origin-wide, and a deployment is not.** ADR-0006 exists because one build has
 * to serve `user.github.io/` *and* `user.github.io/ballastella/`, and both of those are one origin
 * with one cache storage between them. A name carrying only the build version makes each deployment
 * read the other's caches as some foreign app's, so whichever one activates last deletes the other's
 * shell and Base Map — and the offline promise this whole file is for is gone from a deployment
 * nobody touched. `base` is this worker's own directory, computed at runtime, which is exactly the
 * thing that differs between the two.
 *
 * The `@` is not decoration: it anchors the suffix, so that a deployment at `/a/` cannot match a
 * deployment at `/x/a/` by ending in the same characters.
 */
const HERE = `@${base}/`;

/**
 * One cache per build, per kind, per deployment.
 *
 * Named for the build rather than reused, so that an old worker waiting on the user's decision is
 * still serving the bytes it was installed with. A single shared cache name would let a newly
 * *installed* worker overwrite what the still-*active* one is serving — silent activation through
 * the back door, without any worker ever cutting its wait short.
 */
const SHELL_CACHE = `ballastella-shell-${version}${HERE}`;
const BASE_MAP_CACHE = `ballastella-base-map-${version}${HERE}`;

/**
 * Every cache **this deployment** makes, so `activate` can tell the builds it replaces from another
 * app's caches and from a sibling deployment's on the same origin. See {@link HERE}.
 */
const ours = (name: string) => /^ballastella-(shell|base-map)-/.test(name) && name.endsWith(HERE);

/**
 * The app shell: the entry HTML for every route, and the code and styles that run it.
 *
 * `build` filtered to `.js` and `.css` — see rule 5 in the header. The filter is by extension and
 * not by name so that it states a rule ("code and styles") rather than a list of things to dodge.
 * Since ADR-0027 removed `wasm-vips` there is no longer a 5 MB `.wasm` in `build` for it to
 * exclude — `build` is code, styles, and SvelteKit's own `version.json` update marker, which the
 * update check fetches from the network on purpose and which a cached copy would defeat. The filter
 * is left exactly as it was, which is the value of having written it as a rule: the thing it was
 * added to dodge has gone, and the rule has not had to change.
 */
const SHELL: readonly string[] = [
	...prerendered,
	...build.filter((url) => url.endsWith('.js') || url.endsWith('.css'))
];

/**
 * A path from one of the lists above, spelled the way a request for it will be.
 *
 * **This is not tidying.** `$service-worker`'s lists are file paths, and a file path is not a URL
 * path: the bundled Base Map's glyphs live in directories called `Noto Sans Regular`, so the list
 * says `…/Noto Sans Regular/0-255.pbf` and every request for one says `…/Noto%20Sans%20Regular/…`.
 * Comparing the two directly is a miss on every file whose name contains a space — which was exactly
 * the bug: the archive was served from the cache, the style loaded, the map drew, and MapLibre
 * quietly fell back to rendering labels with local system fonts because it could not fetch a single
 * glyph range. Loud enough to find only because it warns; silent in every assertion about the map.
 */
const asRequested = (path: string) => new URL(path, location.href).pathname;

/**
 * The one directory of `static/` this worker takes: glyphs and sprites used by Base Map styles.
 *
 * A **directory**, deliberately, and no archive name and no catalog entry id. ADR-0020 requires that
 * a fork repointing its catalog change the catalog and nothing else, and
 * `scripts/check-base-map-catalog.mjs` enforces it; `scripts/stage-viewer-bundle.mjs` names the same
 * directory for the same reason. So a fork that swaps its extract keeps this working, and a fork that
 * points every entry at a remote archive still keeps labels and symbols available once tiles exist.
 */
const BASE_MAP_DIRECTORY = 'base-map/';

const BASE_MAP: readonly string[] = files.filter((url) =>
	url.startsWith(`${base}/${BASE_MAP_DIRECTORY}`)
);

/** What each list answers to, as a request's `pathname`. See {@link asRequested}. */
const SHELL_PATHS = new Set(SHELL.map(asRequested));
const BASE_MAP_PATHS = new Set(BASE_MAP.map(asRequested));

/**
 * Where a navigation lands, by the pathname a browser would ask for.
 *
 * `prerendered` carries the canonical paths — `/`, `/align`, `/image-pane`, each already prefixed
 * with the deployment's own directory — while a browser may ask for `/align/` or
 * `/align/index.html`, and a Project is addressed by `?p=` on top of that (ADR-0008). So the
 * lookup is over a normalised pathname, and the query string is dropped: it selects a Project
 * inside the page and never a different document.
 */
const ENTRY_HTML = new Map(
	prerendered.map((path) => [normalise(asRequested(path)), asRequested(path)])
);

function normalise(pathname: string): string {
	const withoutIndex = pathname.replace(/(^|\/)index\.html$/, '$1');
	// A trailing slash is dropped, except where it is all that is left: `<base>/` is a path.
	return withoutIndex.length > 1 ? withoutIndex.replace(/\/$/, '') : withoutIndex;
}

worker.addEventListener('install', (event) => {
	// `cache.addAll` is one atomic-enough unit: it rejects if any request fails, and a rejected
	// `install` leaves the old worker in place rather than promoting a half-filled cache. An
	// installed worker that cannot serve the shell offline is worse than no new worker at all.
	event.waitUntil(
		Promise.all([
			caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)),
			caches.open(BASE_MAP_CACHE).then((cache) => cache.addAll(BASE_MAP))
		])
	);
	// Deliberately nothing here that would end this worker's wait. See the header.
});

worker.addEventListener('activate', (event) => {
	// The old build's caches go only once this worker is genuinely in charge, which is the moment the
	// user's decision has been taken and nothing is left serving out of them. **The old builds of
	// *this* deployment**, and no others: `caches.keys()` answers for the whole origin, which may be
	// hosting a second deployment of this same app one directory along. See {@link HERE}.
	const keep = new Set([SHELL_CACHE, BASE_MAP_CACHE]);
	event.waitUntil(
		caches
			.keys()
			.then((names) =>
				Promise.all(
					names.filter((name) => ours(name) && !keep.has(name)).map((name) => caches.delete(name))
				)
			)
	);
	// Deliberately no `clients.claim()`. A page that loaded under the previous worker keeps it for
	// the rest of its life; taking over a live client is the mid-alignment interruption ADR-0012
	// rules out, and it is how an old page comes to be served new bytes.
});

worker.addEventListener('fetch', (event) => {
	const { request } = event;
	// Anything that is not a plain same-origin read is left entirely alone — no `respondWith`, so
	// the browser behaves as though no worker were installed. That covers every OPFS read (which
	// issues no request at all), every remote IIIF tile, and every remote Base Map range request.
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	if (url.origin !== location.origin) return;

	if (request.mode === 'navigate') {
		const canonical = ENTRY_HTML.get(normalise(url.pathname));
		if (canonical === undefined) return;
		if (canonical !== url.pathname) {
			// ──────────────────────────────────────────────────────────────────────────────────────
			// THE STATIC HOST'S REDIRECT, PERFORMED OFFLINE
			//
			// `trailingSlash: 'never'`, so the prerendered pages are flat files — `align.html`, not
			// `align/index.html` — and their asset references are relative. That makes `/align`
			// the only URL those references resolve correctly from: at `/align/`, `./_app/…` means
			// `/align/_app/…`, which is nothing. A static host and `vite preview` both answer
			// `/align/` with a redirect to `/align`, and offline nobody is left to do that — so
			// this does, rather than serving HTML from a URL its own `<link>`s are wrong at. Handing
			// back the right bytes at the wrong address is precisely how a page renders blank.
			return event.respondWith(
				Promise.resolve(Response.redirect(`${canonical}${url.search}${url.hash}`, 301))
			);
		}
		return event.respondWith(fromCache(SHELL_CACHE, canonical, request));
	}

	// Hashed asset names, so an exact match or nothing: there is no normalising to do and no reason
	// to guess. Anything absent is left to the network, which is what keeps this worker out of the way
	// of every remote tile and of everything else in `static/`.
	if (SHELL_PATHS.has(url.pathname)) {
		return event.respondWith(fromCache(SHELL_CACHE, url.pathname, request));
	}
	if (BASE_MAP_PATHS.has(url.pathname)) {
		return event.respondWith(fromCache(BASE_MAP_CACHE, url.pathname, request));
	}
});

/**
 * Cache-first, out of *this* build's cache, honouring a `Range` header if there is one.
 *
 * Cache-first is not merely a speed choice; it is what the no-silent-activation contract rests on.
 * While a new worker waits for the user's decision, this one keeps answering out of the caches it was
 * installed with and never consults the server for a shell asset — so the running session stays
 * whole, rather than a page of the old build gradually acquiring chunks of the new one.
 */
async function fromCache(name: string, path: string, request: Request): Promise<Response> {
	const cache = await caches.open(name);
	const hit = await cache.match(path);
	if (!hit) return fetch(request);
	const range = request.headers.get('range');
	return range === null ? hit : slice(hit, range, path);
}

/**
 * A `206` cut out of a cached `200`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS IS NOT OPTIONAL, AND IT IS NOT DEFENSIVE
 *
 * `Cache.match` ignores the `Range` header: it answers a ranged request with the whole response. The
 * Base Map is one pmtiles archive read entirely by range, and `pmtiles`' `FetchSource` **rejects**
 * that answer — measured in `pmtiles@4`, it throws "Server returned no content-length header or
 * content-length exceeding request" when a `200` arrives whose `Content-Length` is larger than what
 * it asked for. So a naive precache of the archive does not merely fail to help; it *breaks the Base
 * Map while online too*, which is worse than not caching it at all. Anything that revisits the
 * caching judgement in the header has to keep this or drop both.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE HOST THIS IMITATES IS `byteRange` IN `e2e/support/editor-deployment.ts`
 *
 * That is the model and this is the copy. What the suite proves is that switching the network off
 * changes nothing about the Base Map, and that is only true if the two answer a `Range` identically
 * — a difference in the clamping or the `416` would be a worker imitating a host nothing serves.
 * They cannot share a module: this file is a service worker built against `$service-worker` and that
 * one is a Node test host, so the duplication is deliberate and each copy names the other. Change
 * one, change both: the suffix form, the clamp at zero, and the `416` carrying the total.
 */
async function slice(response: Response, range: string, path: string): Promise<Response> {
	const bytes = await bodyOf(response, path);
	const asked = /^bytes=(\d*)-(\d*)$/.exec(range);
	if (!asked) return response;
	const last = bytes.byteLength - 1;
	// `bytes=-500` is the final 500 bytes; `bytes=500-` is everything from 500 on.
	const start =
		asked[1] === '' ? Math.max(0, bytes.byteLength - Number(asked[2])) : Number(asked[1]);
	const end = asked[1] === '' || asked[2] === '' ? last : Math.min(Number(asked[2]), last);
	if (start > last) {
		// What a byte-serving host answers, and what `FetchSource` handles by asking again for the
		// whole file: the range is past the end, and the total length is the useful part of the reply.
		return new Response(null, {
			status: 416,
			headers: { 'content-range': `bytes */${bytes.byteLength}` }
		});
	}
	const part = bytes.slice(start, end + 1);
	return new Response(part, {
		status: 206,
		statusText: 'Partial Content',
		headers: {
			'content-type': response.headers.get('content-type') ?? 'application/octet-stream',
			'content-length': String(part.byteLength),
			'content-range': `bytes ${start}-${end}/${bytes.byteLength}`,
			'accept-ranges': 'bytes'
		}
	});
}

/**
 * The cached bytes of one file, read once.
 *
 * Memoised because the archive is several megabytes and every single Base Map tile is one range
 * request against it: re-reading the whole response per tile would turn panning the map into tens of
 * megabytes of reads. One entry per path, and the worker is torn down when it goes idle, so this is
 * bounded by the Base Map list — which is this deployment's own configuration and a known size.
 */
const bodies = new Map<string, Promise<ArrayBuffer>>();

function bodyOf(response: Response, path: string): Promise<ArrayBuffer> {
	const known = bodies.get(path);
	if (known) return known;
	const reading = response.arrayBuffer();
	bodies.set(path, reading);
	return reading;
}
