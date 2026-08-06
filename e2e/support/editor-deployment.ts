import { createServer, type Server } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
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

/** One answer to one request for bytes, ready to be written out or handed to `route.fulfill`. */
export type ServedBytes = {
	readonly status: 200 | 206 | 416;
	readonly headers: Record<string, string>;
	readonly body: Buffer;
};

/**
 * A file, or the slice of it a `Range` header asked for, answered the way a byte-serving host does.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS IS THE HOST THE SERVICE WORKER IS MODELLED ON
 *
 * The Base Map is one pmtiles archive read entirely by range, and `pmtiles`' `FetchSource` refuses a
 * `200` whose `Content-Length` exceeds what it asked for — so a host that cannot byte-serve is a
 * Base Map that never draws, and every Base Map assertion in the suite would be vacuous. Offline
 * there is no host, and `slice()` in `apps/editor/src/service-worker.ts` stands in for one out of the
 * shell cache. The suite's claim is that switching the network off changes nothing about the Base
 * Map, and that claim is only worth as much as the host the worker is compared against: a model with
 * no clamp and no `416` is a host the worker is not in fact imitating, and the two would drift with
 * nothing here to notice.
 *
 * The two cannot share a module — that one is a service worker built against `$service-worker`, this
 * is a Node test host — so this is the reference and that one is the copy, and each names the other.
 * Change one, change both: the suffix form, the clamp at zero, and the `416` carrying the total,
 * which is what `FetchSource` handles by asking again for the whole file.
 *
 * @param range the request's `Range` header, if it had one
 */
export function byteRange(body: Buffer, range: string | undefined, type: string): ServedBytes {
	const asked = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
	if (!asked) {
		return {
			status: 200,
			headers: {
				'content-type': type,
				'content-length': String(body.length),
				'accept-ranges': 'bytes'
			},
			body
		};
	}
	const last = body.length - 1;
	// `bytes=-500` is the final 500 bytes; `bytes=500-` is everything from 500 on.
	const start = asked[1] === '' ? Math.max(0, body.length - Number(asked[2])) : Number(asked[1]);
	const end = asked[1] === '' || asked[2] === '' ? last : Math.min(Number(asked[2]), last);
	if (start > last) {
		return {
			status: 416,
			headers: { 'content-range': `bytes */${body.length}` },
			body: Buffer.alloc(0)
		};
	}
	const part = body.subarray(start, end + 1);
	return {
		status: 206,
		headers: {
			'content-type': type,
			'content-length': String(part.length),
			'content-range': `bytes ${start}-${end}/${body.length}`,
			'accept-ranges': 'bytes'
		},
		body: part
	};
}

/**
 * This deployment's own bundled Base Map archive, read off disk.
 *
 * Found by extension rather than by name, because ADR-0020 says a fork swapping its extract changes
 * the catalog and nothing else — and a test that spelled the archive's file name would be one more
 * thing it had to change. Used to stand in for *somebody else's* archive: a test that needs a
 * `needsNetwork: true` Base Map to genuinely answer has to serve real pmtiles bytes from somewhere,
 * and reaching the real host it names would put an internet dependency in this suite.
 */
export async function bundledBaseMapArchive(): Promise<Buffer> {
	const directory = path.join(editorBuild, 'base-map');
	const names = await readdir(directory);
	const archive = names.find((name) => name.endsWith('.pmtiles'));
	if (archive === undefined) throw new Error(`no pmtiles archive in ${directory}`);
	return readFile(path.join(directory, archive));
}

export type EditorDeployment = {
	/** The deployment's address, with a trailing slash. This is what `start_url` must resolve to. */
	readonly url: string;
	/** The path this build is served under — `''` for a domain root. */
	readonly prefix: string;
	/** Every path this deployment was asked for, in order. */
	readonly requests: string[];
	/** Every path it answered with something other than 200, 301, 206 or 416. */
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
	/**
	 * Stop answering, in the middle of a test rather than at the end of one.
	 *
	 * Mechanically this is {@link close} — the same shutdown, and calling `close` after it is a no-op,
	 * so a test may use it and still be torn down normally. It has a name of its own because it is
	 * used for a different reason: what a dropped connection or a captive portal looks like from
	 * inside the page. Unlike Playwright's `setOffline` it leaves `navigator.onLine` saying yes, which
	 * is the case the update path has to survive rather than the one it can see coming.
	 */
	stopServing(): Promise<void>;
	close(): Promise<void>;
};

/**
 * Serve `apps/editor/build` over HTTP, optionally under `prefix`.
 *
 * @param prefix a leading path such as `/teaching/ballastella`, or `''` for a domain root
 */
export async function deployEditor(prefix = ''): Promise<EditorDeployment> {
	const [only] = await deployEditors(prefix);
	return only as EditorDeployment;
}

/**
 * Two or more deployments of the same build **on one origin**, which is a different question from
 * two servers and the reason this exists.
 *
 * ADR-0006's subdirectory case is `user.github.io/` and `user.github.io/ballastella/`: one host, two
 * published folders, and — the part nothing else in this harness can express — *one* cache storage,
 * *one* set of registrations, and one OPFS between them. A second `deployEditor` call gets a second
 * port and therefore a second origin, where every one of those is private again and the interesting
 * failure cannot happen.
 *
 * Paths are routed by longest matching prefix, so a root deployment and a subdirectory one can
 * coexist exactly as they do on a static host — noting that on that host a root deployment's service
 * worker has a scope of `/` and therefore *controls* the subdirectory's pages too, until its own
 * registration exists. Every returned deployment shares the server; the first `close` shuts it down
 * and the rest are no-ops.
 *
 * @param prefixes a leading path such as `/teaching/ballastella`, or `''` for a domain root
 */
export async function deployEditors(...prefixes: string[]): Promise<EditorDeployment[]> {
	/** Longest first, so `/teaching/ballastella/x` is that deployment's and not the root's. */
	const byDepth = [...prefixes].sort((a, b) => b.length - a.length);
	const state = new Map(
		prefixes.map((prefix) => [
			prefix,
			{
				requests: [] as string[],
				failures: [] as { path: string; status: number }[],
				nextVersion: false
			}
		])
	);

	const server: Server = createServer(async (request, response) => {
		const asked = request.url ?? '/';
		const url = new URL(asked, 'http://127.0.0.1');
		const prefix = byDepth.find((candidate) => url.pathname.startsWith(`${candidate}/`));
		// A path outside every published folder is nobody's and everybody's: it is the ADR-0006
		// failure, and whichever deployment a test is looking at has to be able to see it.
		const heard = prefix === undefined ? [...state.values()] : [state.get(prefix)!];
		for (const record of heard) record.requests.push(asked);

		const answer = (
			status: number,
			body: Buffer | string,
			headers: Record<string, string> = {}
		) => {
			// 416 is a correct answer to an impossible range, not a failure — see the byte-serving
			// block below.
			if (status !== 200 && status !== 301 && status !== 206 && status !== 416)
				for (const record of heard) record.failures.push({ path: asked, status });
			response.writeHead(status, headers);
			response.end(request.method === 'HEAD' ? undefined : body);
		};

		if (prefix === undefined) {
			// What a static host does with a path outside the published folder. An asset referenced
			// absolutely lands here, which is the failure ADR-0006 exists to prevent.
			answer(404, `${url.pathname} is outside ${prefixes.map((p) => `${p}/`).join(', ')}`, {
				'content-type': 'text/plain; charset=utf-8'
			});
			return;
		}
		const nextVersion = state.get(prefix)!.nextVersion;

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

		// Byte-serving, because the Base Map is one pmtiles archive read entirely by range. See
		// {@link byteRange} for why this host's arithmetic is worth being exact about.
		const served = byteRange(body, request.headers.range, type);
		answer(served.status, served.body, served.headers);
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;

	/**
	 * Shut down once, however many deployments ask.
	 *
	 * Memoised rather than guarded by a flag, so that a test which stops the server mid-way and then
	 * lets its teardown close it waits for the same shutdown instead of racing it. Live connections
	 * are destroyed: the browser holds keep-alives open, and `close` alone would wait for them.
	 */
	let shutdown: Promise<void> | null = null;
	const stop = () => {
		shutdown ??= new Promise<void>((resolve, reject) => {
			server.closeAllConnections();
			server.close((error) => (error ? reject(error) : resolve()));
		});
		return shutdown;
	};

	return prefixes.map((prefix) => {
		const record = state.get(prefix)!;
		return {
			url: `http://127.0.0.1:${port}${prefix}/`,
			prefix,
			requests: record.requests,
			failures: record.failures,
			publishNewVersion: () => {
				record.nextVersion = true;
			},
			stopServing: stop,
			close: stop
		};
	});
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
		// The cache names are `ballastella-shell-${version}@${base}/` and its base-map twin; these make
		// them `ballastella-shell-next-${version}@${base}/`, so they are different caches as well as a
		// different worker. **The prefix is what changes and the `@${base}/` suffix is what does not**,
		// which is deliberate: `activate` recognises a cache as this deployment's to clean up after by
		// that suffix, so a substitution that touched it would leave the old build's caches orphaned
		// for ever and make "the new version took over" untestable.
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
