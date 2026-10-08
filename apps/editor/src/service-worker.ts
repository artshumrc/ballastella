/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

import { base, build, files, prerendered, version } from '$service-worker';

const worker = self as unknown as ServiceWorkerGlobalScope;
const HERE = `@${base}/`;
const SHELL_CACHE = `ballastella-shell-${version}${HERE}`;
const BASE_MAP_CACHE = `ballastella-base-map-${version}${HERE}`;
const ours = (name: string) => /^ballastella-(shell|base-map)-/.test(name) && name.endsWith(HERE);

const SHELL: readonly string[] = [
	...prerendered,
	...build.filter((url) => url.endsWith('.js') || url.endsWith('.css'))
];

const asRequested = (path: string) => new URL(path, location.href).pathname;
const BASE_MAP_DIRECTORY = 'base-map/';

const BASE_MAP: readonly string[] = files.filter((url) =>
	url.startsWith(`${base}/${BASE_MAP_DIRECTORY}`)
);

const SHELL_PATHS = new Set(SHELL.map(asRequested));
const BASE_MAP_PATHS = new Set(BASE_MAP.map(asRequested));

const ENTRY_HTML = new Map(
	prerendered.map((path) => [normalise(asRequested(path)), asRequested(path)])
);

function normalise(pathname: string): string {
	const withoutIndex = pathname.replace(/(^|\/)index\.html$/, '$1');
	return withoutIndex.length > 1 ? withoutIndex.replace(/\/$/, '') : withoutIndex;
}

worker.addEventListener('install', (event) => {
	event.waitUntil(
		Promise.all([
			caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)),
			caches.open(BASE_MAP_CACHE).then((cache) => cache.addAll(BASE_MAP))
		])
	);
});

worker.addEventListener('activate', (event) => {
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
});

worker.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== location.origin) return;

	if (request.mode === 'navigate') {
		const canonical = ENTRY_HTML.get(normalise(url.pathname));
		if (canonical === undefined) return;
		if (canonical !== url.pathname) {
			return event.respondWith(
				Promise.resolve(Response.redirect(`${canonical}${url.search}${url.hash}`, 301))
			);
		}
		return event.respondWith(fromCache(SHELL_CACHE, canonical, request));
	}

	if (SHELL_PATHS.has(url.pathname)) {
		return event.respondWith(fromCache(SHELL_CACHE, url.pathname, request));
	}
	if (BASE_MAP_PATHS.has(url.pathname)) {
		return event.respondWith(fromCache(BASE_MAP_CACHE, url.pathname, request));
	}
});

async function fromCache(name: string, path: string, request: Request): Promise<Response> {
	const cache = await caches.open(name);
	const hit = await cache.match(path);
	if (!hit) return fetch(request);
	const range = request.headers.get('range');
	return range === null ? hit : slice(hit, range, path);
}

async function slice(response: Response, range: string, path: string): Promise<Response> {
	const bytes = await bodyOf(response, path);
	const asked = /^bytes=(\d*)-(\d*)$/.exec(range);
	if (!asked) return response;
	const last = bytes.byteLength - 1;
	const start =
		asked[1] === '' ? Math.max(0, bytes.byteLength - Number(asked[2])) : Number(asked[1]);
	const end = asked[1] === '' || asked[2] === '' ? last : Math.min(Number(asked[2]), last);
	if (start > last) {
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

const bodies = new Map<string, Promise<ArrayBuffer>>();

function bodyOf(response: Response, path: string): Promise<ArrayBuffer> {
	const known = bodies.get(path);
	if (known) return known;
	const reading = response.arrayBuffer();
	bodies.set(path, reading);
	return reading;
}
