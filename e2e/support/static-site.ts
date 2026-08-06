import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// A static web server for a published Workspace, so that "the site works" can be asserted against a
// site rather than against a directory listing.
//
// ADR-0006's whole claim is that **one build serves a domain root and a project subdirectory**, and
// the only way to find out is to serve the same bytes at both and drive them. `vite preview` cannot:
// it serves an app's own build, and what is being served here is the user's Workspace as it came out
// of OPFS. So this is a plain file server, deliberately dumb — no rewriting, no SPA fallback, no
// index-guessing beyond a trailing slash — because a static host does none of those either, and a
// server cleverer than GitHub Pages would hide exactly the failure being looked for.
//
// The `prefix` is the point. Given one directory, one server can answer at `/` and another at
// `/deep/nested/`, from the same files with no reconfiguration — so an asset referenced as `/_app/…`
// rather than `./_app/…` is a 404 on the second, which is what the tests assert on.

/** Media types by extension. A `.js` served as `text/plain` is a module the browser will not run. */
const MEDIA_TYPES: Record<string, string> = {
	'.css': 'text/css; charset=utf-8',
	'.geojson': 'application/geo+json',
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
	'.webp': 'image/webp'
};

export type StaticSite = {
	/** The site's address, with a trailing slash. */
	readonly url: string;
	/** The path this site is published under — `''` for a domain root. */
	readonly prefix: string;
	/** Every path this server was asked for, in order, as it arrived. */
	readonly requests: string[];
	/** Every path it answered with something other than 200. */
	readonly failures: { path: string; status: number }[];
	close(): Promise<void>;
};

/**
 * Serve `directory` over HTTP, optionally under `prefix`.
 *
 * @param prefix a leading path such as `/deep/nested`, or `''` for a domain root
 */
export async function serveDirectory(directory: string, prefix = ''): Promise<StaticSite> {
	const requests: string[] = [];
	const failures: { path: string; status: number }[] = [];

	const server: Server = createServer(async (request, response) => {
		const asked = request.url ?? '/';
		requests.push(asked);
		const answer = (status: number, body: Buffer | string, type?: string) => {
			if (status !== 200) failures.push({ path: asked, status });
			response.writeHead(status, type ? { 'content-type': type } : undefined);
			response.end(body);
		};

		const url = new URL(asked, 'http://localhost');
		if (!url.pathname.startsWith(`${prefix}/`)) {
			// Exactly what a static host does with a path outside the published folder. An asset
			// referenced absolutely lands here, which is the failure ADR-0006 exists to prevent.
			answer(404, `${url.pathname} is outside ${prefix}/`, 'text/plain; charset=utf-8');
			return;
		}

		let relative = decodeURIComponent(url.pathname.slice(prefix.length + 1));
		if (relative === '' || relative.endsWith('/')) relative += 'index.html';
		// `path.resolve` normalises `..` away; the containment check is what makes it safe to say so.
		const file = path.resolve(directory, relative);
		if (file !== directory && !file.startsWith(`${directory}${path.sep}`)) {
			answer(403, 'outside the published folder', 'text/plain; charset=utf-8');
			return;
		}

		try {
			answer(200, await readFile(file), MEDIA_TYPES[path.extname(file).toLowerCase()]);
		} catch {
			answer(404, `${relative} is not in this site`, 'text/plain; charset=utf-8');
		}
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${port}${prefix}/`,
		prefix,
		requests,
		failures,
		close: () =>
			new Promise<void>((resolve, reject) => {
				// Keep-alive sockets first, or `close()` waits for a browser that has no reason to hang up and
				// the teardown times out. A page that has just loaded a site holds one open by default, so
				// this is the ordinary case rather than a stuck request — and a static host closing its
				// listener does not owe a browser its connection either.
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			})
	};
}
