// ═══════════════════════════════════════════════════════════════════════════════════════════════
// NO UNIT TEST MAY REACH THE NETWORK EITHER.
//
// **A human decision from the repository owner, and it says every test, not every browser test.**
// `e2e/support/network-fence.ts` is the same rule at the other seam; read its header for why the
// rule exists at all (a third party's bucket began answering 404 on 2026-08-07 and turned this
// repository red for a reason that had nothing to do with it).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS CHANGES, HONESTLY: FROM *FOLLOWED* TO *ENFORCED*
//
// The discipline was already there and it was real. Every unit test that needs an HTTP answer takes
// a `FetchFn` and is handed a fake — `remote-iiif/mirror.test.ts`, `store/http-project-store.test.ts`,
// `remote-iiif/referenced-image.test.ts`. Nothing in the suite reached the network before this file
// existed, which was checked rather than assumed.
//
// But *nothing stopped it*. There were no `setupFiles` at all, no `vi.stubGlobal('fetch')` anywhere
// in the tree, and a global `fetch(…)` inside a test would have worked, passed, and been indistinct
// from an injected one in review — the two spellings differ by a single `const` on a line thirty
// lines above. That is the same shape as the e2e defect it accompanies: a convention that held until
// somebody wrote the fourteenth file.
//
// So this is the difference between "no test reaches the network" as an observation about today and
// as a property of the suite.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// EVERY GLOBAL THAT CAN LEAVE THE MACHINE, NOT ONLY `fetch`
//
// Fencing `fetch` alone would be a fence that reads as complete and is not: `XMLHttpRequest` is what
// most third-party libraries still use, `sendBeacon` is the one that fires during teardown where
// nobody is looking, and `node:http`/`node:https` are one import away in a Node test. Each is
// wrapped rather than deleted, so the failure names the URL instead of being
// `TypeError: fetch is not a function` fifteen frames down.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// LOCAL IS NOT THE NETWORK, AND THAT IS LOAD-BEARING HERE
//
// In browser mode Vitest *is* a local server: the test page, every `import.meta.glob(…, 'url')`
// fixture, the module graph, and Vitest's own WebSocket back to the runner all go to `localhost`.
// A fence that refused those would not be strict, it would be broken — the browser project would
// not start. So the rule is the same one the e2e fence uses: `localhost`, `127.0.0.1` and `::1` are
// this machine; everything else is somebody's server.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ONE OPT-OUT, AND WHY IT IS THE EXISTING LEVER
//
// `remote-iiif/live-services.test.ts` deliberately fetches real IIIF services and the Allmaps
// community API, and it has always been `describe.runIf(BALLASTELLA_NETWORK_TESTS === '1')` — it
// does **not** run in `pnpm test`, and its own header explains at length why a captured corpus needs
// a live counterpart that is not part of the ordinary loop. That is precisely the "explicit, named,
// justified at its site" exception the rule allows, and it predates this fence.
//
// So the fence honours the same variable rather than inventing a second one. Setting it turns the
// fence off for the run, which is the intent: `BALLASTELLA_NETWORK_TESTS=1` means "this run is the
// live check". With it unset — every ordinary run, and CI — nothing may leave the machine.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The hosts that are this machine.
 *
 * **Deliberately a second copy of `e2e/support/network-fence.ts`'s list**, not an import. The
 * workspace tsconfig covers only `e2e/` and `playwright.config.ts`, and `packages/core` cannot
 * reach into the browser suite — the same boundary that makes `e2e/support/editor-deployment.ts`
 * re-declare the tile-path helper. The drift is safe in the direction that matters: a host added
 * here and not there makes the *other* fence stricter, never this one looser.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Whether this run is the deliberate live check. Absent in the browser, where it is never set. */
const liveRunRequested = (): boolean => {
	try {
		return (
			(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
				'BALLASTELLA_NETWORK_TESTS'
			] === '1'
		);
	} catch {
		return false;
	}
};

/**
 * Is `url` a request that would leave this machine?
 *
 * Relative URLs are resolved against the page in browser mode — a fixture at `/@fs/…` is Vitest's
 * own server and not the network — and are not requests at all in Node, where `fetch` refuses them
 * anyway. Anything unparseable is left alone rather than turned into a confusing failure.
 */
function reachesTheNetwork(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url, (globalThis as { location?: { href?: string } }).location?.href);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
	return !LOCAL_HOSTS.has(parsed.hostname);
}

/** The URL a `fetch` argument names, whatever shape it arrived in. */
function urlOf(input: unknown): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.href;
	if (typeof input === 'object' && input !== null && 'url' in input) {
		return String((input as { url: unknown }).url);
	}
	return String(input);
}

/**
 * What a test author sees. It names the URL, the API that asked, and the remedy this repository
 * already uses everywhere else — injection, not a mock of a global.
 */
export function refusedNetworkMessage(api: string, url: string): string {
	return [
		`This test reached the network: ${api} → ${url}`,
		'',
		'No test in this repository may depend on the network — a recorded decision by the',
		'repository owner. A suite that reaches a third party fails when that third party has a bad',
		'afternoon, and a red build then means nothing.',
		'',
		'The way this repository does it is dependency injection, not a stubbed global. Everything',
		'that fetches takes a `FetchFn` and the test hands it a fake:',
		'',
		'    const fetch: FetchFn = async (input) => new Response(bytes, { status: 200 });',
		'    const remote = await readRemoteImageService(uri, { fetch });',
		'',
		'`remote-iiif/mirror.test.ts` and `store/http-project-store.test.ts` are the worked examples.',
		'',
		'If a check genuinely has to reach a live service — and there is exactly one, the corpus',
		'check in `remote-iiif/live-services.test.ts` — it belongs behind',
		'`describe.runIf(process.env.BALLASTELLA_NETWORK_TESTS === "1")` with the reason written at',
		'its site, so it is never part of `pnpm test`.'
	].join('\n');
}

/** Throw, naming what asked and for what. */
const refuse = (api: string, url: string): never => {
	throw new Error(refusedNetworkMessage(api, url));
};

if (!liveRunRequested()) {
	const target = globalThis as Record<string, unknown> & {
		fetch?: typeof fetch;
		XMLHttpRequest?: typeof XMLHttpRequest;
		WebSocket?: typeof WebSocket;
		EventSource?: typeof EventSource;
		navigator?: Navigator;
	};

	// ── fetch ────────────────────────────────────────────────────────────────────────────────
	const realFetch = target.fetch;
	if (realFetch) {
		target.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = urlOf(input);
			if (reachesTheNetwork(url)) refuse('fetch', url);
			return realFetch(input, init);
		}) as typeof fetch;
	}

	// ── XMLHttpRequest ───────────────────────────────────────────────────────────────────────
	// Wrapped at `open`, which is where the URL is named and before anything is sent, so the throw
	// lands on the caller's own line rather than inside an event handler with no stack to speak of.
	const XHR = target.XMLHttpRequest;
	if (XHR) {
		const realOpen = XHR.prototype.open;
		XHR.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
			const url = String(args[1]);
			if (reachesTheNetwork(url)) refuse('XMLHttpRequest', url);
			return (realOpen as (...rest: unknown[]) => void).apply(this, args);
		} as typeof XHR.prototype.open;
	}

	// ── WebSocket ────────────────────────────────────────────────────────────────────────────
	// Vitest's browser runner talks to its own server over one of these, on `localhost`, so this
	// must be a filter and never a removal — deleting the global stops the browser project booting.
	const RealWebSocket = target.WebSocket;
	if (RealWebSocket) {
		const Fenced = function (this: unknown, url: string | URL, protocols?: string | string[]) {
			const asked = urlOf(url).replace(/^ws/, 'http');
			if (reachesTheNetwork(asked)) refuse('WebSocket', urlOf(url));
			return new RealWebSocket(url, protocols);
		} as unknown as typeof WebSocket;
		Fenced.prototype = RealWebSocket.prototype;
		Object.setPrototypeOf(Fenced, RealWebSocket);
		target.WebSocket = Fenced;
	}

	// ── EventSource ──────────────────────────────────────────────────────────────────────────
	const RealEventSource = target.EventSource;
	if (RealEventSource) {
		const Fenced = function (this: unknown, url: string | URL, init?: EventSourceInit) {
			if (reachesTheNetwork(urlOf(url))) refuse('EventSource', urlOf(url));
			return new RealEventSource(url, init);
		} as unknown as typeof EventSource;
		Fenced.prototype = RealEventSource.prototype;
		Object.setPrototypeOf(Fenced, RealEventSource);
		target.EventSource = Fenced;
	}

	// ── sendBeacon ───────────────────────────────────────────────────────────────────────────
	// The one that fires during teardown, returns a boolean nobody checks, and would otherwise be
	// the single API whose use is invisible in both the test's output and its assertions.
	const navigatorLike = target.navigator as {
		sendBeacon?: (url: string, data?: unknown) => boolean;
	};
	if (navigatorLike?.sendBeacon) {
		const realBeacon = navigatorLike.sendBeacon.bind(navigatorLike);
		navigatorLike.sendBeacon = (url: string, data?: unknown) => {
			if (reachesTheNetwork(urlOf(url))) refuse('navigator.sendBeacon', urlOf(url));
			return realBeacon(url, data);
		};
	}
}

// ── node:http and node:https ────────────────────────────────────────────────────────────────
//
// One `import https from 'node:https'` away in any Node test, and not covered by anything above:
// `fetch` in Node is undici and does not go through these. `createServer` is untouched — the
// deployment fence and several store tests stand up local servers, and listening is not reaching.
//
// A dynamic import inside a guarded block, because this module is also loaded into a browser, where
// `node:http` does not resolve at all.
if (!liveRunRequested() && typeof (globalThis as { process?: unknown }).process === 'object') {
	for (const specifier of ['node:http', 'node:https']) {
		const module = (await import(/* @vite-ignore */ specifier)) as {
			default: {
				request: (...args: unknown[]) => unknown;
				get: (...args: unknown[]) => unknown;
			};
		};
		const node = module.default;
		for (const method of ['request', 'get'] as const) {
			const real = node[method];
			node[method] = (...args: unknown[]) => {
				const first = args[0];
				const url =
					typeof first === 'string' || first instanceof URL
						? urlOf(first)
						: `${(first as { protocol?: string })?.protocol ?? 'http:'}//${
								(first as { host?: string; hostname?: string })?.host ??
								(first as { hostname?: string })?.hostname ??
								'localhost'
							}`;
				if (reachesTheNetwork(url)) refuse(`${specifier}.${method}`, url);
				return real(...args);
			};
		}
	}
}
