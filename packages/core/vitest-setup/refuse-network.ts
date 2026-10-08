const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

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

function urlOf(input: unknown): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.href;
	if (typeof input === 'object' && input !== null && 'url' in input) {
		return String((input as { url: unknown }).url);
	}
	return String(input);
}

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
		'`remote-iiif/offline-copy.test.ts` and `store/http-project-store.test.ts` are the worked examples.',
		'',
		'If a check genuinely has to reach a live service — and there is exactly one, the corpus',
		'check in `remote-iiif/live-services.test.ts` — it belongs behind',
		'`describe.runIf(process.env.BALLASTELLA_NETWORK_TESTS === "1")` with the reason written at',
		'its site, so it is never part of `pnpm test`.'
	].join('\n');
}

const refuse = (api: string, url: string): never => {
	throw new Error(refusedNetworkMessage(api, url));
};

if (!liveRunRequested()) {
	const target = globalThis as Record<string, unknown> & {
		fetch?: typeof fetch;
		XMLHttpRequest?: typeof XMLHttpRequest;
		navigator?: Navigator;
	};

	const realFetch = target.fetch;
	if (realFetch) {
		target.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = urlOf(input);
			if (reachesTheNetwork(url)) refuse('fetch', url);
			return realFetch(input, init);
		}) as typeof fetch;
	}

	const XHR = target.XMLHttpRequest;
	if (XHR) {
		const realOpen = XHR.prototype.open;
		XHR.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
			const url = String(args[1]);
			if (reachesTheNetwork(url)) refuse('XMLHttpRequest', url);
			return (realOpen as (...rest: unknown[]) => void).apply(this, args);
		} as typeof XHR.prototype.open;
	}

	const fenceConstructor = (
		api: 'WebSocket' | 'EventSource',
		asHttp: (url: string) => string = (url) => url
	): void => {
		const Real = target[api] as (new (url: string | URL, options?: unknown) => object) | undefined;
		if (!Real) return;
		const Fenced = function (this: unknown, url: string | URL, options?: unknown) {
			if (reachesTheNetwork(asHttp(urlOf(url)))) refuse(api, urlOf(url));
			return new Real(url, options);
		};
		Fenced.prototype = Real.prototype;
		Object.setPrototypeOf(Fenced, Real);
		target[api] = Fenced;
	};
	fenceConstructor('WebSocket', (url) => url.replace(/^ws/, 'http'));
	fenceConstructor('EventSource');

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
