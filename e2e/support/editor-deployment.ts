import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

// A static web server for the **editor's own build**, so that the PWA slice can be driven at a
// domain root and in a project subdirectory, and so that a second version of the app can be
// published under a running browser's feet.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY NOT `vite preview`, AND WHY NOT `support/static-site.ts`
//
// `vite preview` serves one app at one origin at `/`, which answers neither of the two questions
// here. ADR-0006 says one build must serve a domain root *and* a project subdirectory, and a
// service worker's scope and a manifest's `start_url` are exactly the values that quietly hardcode
// `/` — so both have to be driven under a prefix as well as at the root. And a service worker
// update is a change to the *bytes a server hands out* while a browser is already running: nothing
// that serves a fixed directory can express it.
//
// `support/static-site.ts` serves a published Workspace and is deliberately dumb about paths — no
// index-guessing beyond a trailing slash — because that is what a published Workspace needs. The
// editor's build is shaped differently: `trailingSlash: 'never'` means its pages are flat files
// (`base-map.html`, not `base-map/index.html`), so a host has to resolve `/base-map` to
// `base-map.html` and redirect `/base-map/` to `/base-map`, which is what GitHub Pages does and
// what the service worker has to do offline. Teaching the published-site server two behaviours it
// must not have, in order to serve a different app, would make it a worse model of a static host.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// SECURE CONTEXT
//
// Service workers need one. `127.0.0.1` is potentially trustworthy by specification, so plain HTTP
// here is enough and no certificate is involved.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const editorBuild = path.join(repoRoot, 'apps/editor/build');

/** Media types by extension. A `.js` served as `text/plain` is a module the browser will not run. */
const MEDIA_TYPES: Record<string, string> = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.pbf': 'application/x-protobuf',
	'.png': 'image/png',
	'.pmtiles': 'application/octet-stream',
	'.svg': 'image/svg+xml',
	'.txt': 'text/plain; charset=utf-8',
	'.wasm': 'application/wasm',
	'.webmanifest': 'application/manifest+json',
	'.webp': 'image/webp'
};

/**
 * The marker a newly published version carries in its entry HTML.
 *
 * The point of it is that "the old version is still serving" and "the new version is serving now"
 * become questions about **what the browser rendered**, rather than about a cache name or a
 * registration's state. A `<meta>` in `index.html` is the smallest thing that is genuinely part of
 * the shell and genuinely visible from the page.
 */
export const NEXT_VERSION_MARKER = 'ballastella-next-version';

export type EditorDeployment = {
	/** The deployment's address, with a trailing slash. This is what `start_url` must resolve to. */
	readonly url: string;
	/** The path this build is served under — `''` for a domain root. */
	readonly prefix: string;
	/** Every path this server was asked for, in order. */
	readonly requests: string[];
	/** Every path it answered with something other than 200 or 301. */
	readonly failures: { path: string; status: number }[];
	/**
	 * Serve a *different* build from now on: a new service worker, and an entry HTML carrying
	 * {@link NEXT_VERSION_MARKER}.
	 *
	 * The service worker's own bytes change, which is the only thing that makes a browser treat it as
	 * a new worker, and its cache name changes with them — so which build answered a request is
	 * decidable from `caches.keys()` as well as from the page.
	 */
	publishNewVersion(): void;
	close(): Promise<void>;
};

/**
 * Serve `apps/editor/build` over HTTP, optionally under `prefix`.
 *
 * @param prefix a leading path such as `/teaching/ballastella`, or `''` for a domain root
 */
export async function deployEditor(prefix = ''): Promise<EditorDeployment> {
	const requests: string[] = [];
	const failures: { path: string; status: number }[] = [];
	let nextVersion = false;

	const server: Server = createServer(async (request, response) => {
		const asked = request.url ?? '/';
		requests.push(asked);

		const answer = (
			status: number,
			body: Buffer | string,
			headers: Record<string, string> = {}
		) => {
			if (status !== 200 && status !== 301 && status !== 206)
				failures.push({ path: asked, status });
			response.writeHead(status, headers);
			response.end(request.method === 'HEAD' ? undefined : body);
		};

		const url = new URL(asked, 'http://127.0.0.1');
		if (!url.pathname.startsWith(`${prefix}/`)) {
			// What a static host does with a path outside the published folder. An asset referenced
			// absolutely lands here, which is the failure ADR-0006 exists to prevent.
			answer(404, `${url.pathname} is outside ${prefix}/`, {
				'content-type': 'text/plain; charset=utf-8'
			});
			return;
		}

		let relative = decodeURIComponent(url.pathname.slice(prefix.length + 1));

		// The two path behaviours a flat prerendered build needs from its host, and that GitHub Pages
		// has: an extensionless page resolves to `<name>.html`, and a trailing slash on one is a
		// redirect to the canonical URL rather than a directory. The redirect matters beyond tidiness —
		// the pages reference their assets relatively, so at `/base-map/` every `./_app/…` is a 404.
		if (relative === '' || relative.endsWith('/')) relative += 'index.html';
		else if (path.extname(relative) === '') {
			try {
				await readFile(path.join(editorBuild, `${relative}.html`));
				relative = `${relative}.html`;
			} catch {
				// Not a page. Fall through and 404 as the file it claimed to be.
			}
		}
		if (relative.endsWith('/index.html') && relative !== 'index.html') {
			const canonical = `${prefix}/${relative.slice(0, -'/index.html'.length)}`;
			answer(301, '', { location: `${canonical}${url.search}` });
			return;
		}

		const file = path.resolve(editorBuild, relative);
		if (!file.startsWith(`${editorBuild}${path.sep}`)) {
			answer(403, 'outside the served folder', { 'content-type': 'text/plain; charset=utf-8' });
			return;
		}

		let body: Buffer;
		try {
			body = await readFile(file);
		} catch {
			answer(404, `${relative} is not in this build`, {
				'content-type': 'text/plain; charset=utf-8'
			});
			return;
		}

		if (nextVersion) body = asNextVersion(relative, body);

		const type = MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

		// Range requests, because the Base Map is one pmtiles archive read by range and `pmtiles`
		// refuses a 200 whose content-length exceeds what it asked for. A host that cannot byte-serve
		// is a Base Map that never draws, which would make every base-map assertion here vacuous.
		const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
		if (range) {
			const start = range[1] === '' ? body.length - Number(range[2]) : Number(range[1]);
			const end = range[2] === '' || range[1] === '' ? body.length - 1 : Number(range[2]);
			const slice = body.subarray(start, Math.min(end, body.length - 1) + 1);
			answer(206, slice, {
				'content-type': type,
				'content-length': String(slice.length),
				'content-range': `bytes ${start}-${start + slice.length - 1}/${body.length}`,
				'accept-ranges': 'bytes'
			});
			return;
		}

		answer(200, body, {
			'content-type': type,
			'content-length': String(body.length),
			'accept-ranges': 'bytes'
		});
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${port}${prefix}/`,
		prefix,
		requests,
		failures,
		publishNewVersion: () => {
			nextVersion = true;
		},
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve()))
			)
	};
}

/**
 * The same build, one version on.
 *
 * Two substitutions and no rebuild, because what has to change is small and exact: the service
 * worker's bytes (or the browser will not treat it as a new worker) together with the cache name it
 * derives from them, and something in the entry HTML that a test can see from the page. Rebuilding
 * the app with a different `version.name` would do the same thing and cost a minute per test.
 */
function asNextVersion(relative: string, body: Buffer): Buffer {
	if (relative === 'service-worker.js') {
		// The cache names are `ballastella-shell-${version}` and `ballastella-base-map-${version}`;
		// these make them `…-next-${version}`, so they are different caches as well as a different
		// worker, and `activate` still recognises them as ours to clean up after.
		return Buffer.from(
			body
				.toString('utf8')
				.replaceAll('ballastella-shell-', 'ballastella-shell-next-')
				.replaceAll('ballastella-base-map-', 'ballastella-base-map-next-')
		);
	}
	if (relative.endsWith('.html')) {
		return Buffer.from(
			body
				.toString('utf8')
				.replace('</head>', `<meta name="${NEXT_VERSION_MARKER}" content="yes" /></head>`)
		);
	}
	return body;
}
