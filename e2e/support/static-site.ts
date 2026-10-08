import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

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
	readonly url: string;
	readonly prefix: string;
	readonly requests: string[];
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
			answer(404, `${url.pathname} is outside ${prefix}/`, 'text/plain; charset=utf-8');
			return;
		}

		let relative = decodeURIComponent(url.pathname.slice(prefix.length + 1));
		if (relative === '' || relative.endsWith('/')) relative += 'index.html';
		const file = path.resolve(directory, relative);
		if (file !== directory && !file.startsWith(`${directory}${path.sep}`)) {
			answer(403, 'outside the served folder', 'text/plain; charset=utf-8');
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
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			})
	};
}
