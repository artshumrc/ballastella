import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Route } from '@playwright/test';
import type { Page } from './test.js';
import { PMTiles } from 'pmtiles';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const editorBuild = path.join(repoRoot, 'apps/editor/build');
const baseMapFixture = path.join(repoRoot, 'e2e/fixtures/base-map/amsterdam-centre.pmtiles');
const terrainFixture = path.join(repoRoot, 'e2e/fixtures/base-map/terrain-tile.png');

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

export const NEXT_VERSION_MARKER = 'ballastella-next-version';

type ServedBytes = {
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

export const baseMapArchiveFixture = (): Promise<Buffer> => readFile(baseMapFixture);

const fulfillRange = async (route: Route, archive: Buffer): Promise<void> => {
	const served = byteRange(archive, route.request().headers()['range'], 'application/octet-stream');
	await route.fulfill({
		status: served.status,
		headers: { ...served.headers, 'access-control-allow-origin': '*' },
		body: served.body
	});
};

const PIXEL = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOIygsAAAI+ARlMR/knAAAAAElFTkSuQmCC',
	'base64'
);

export async function routeBaseMapArchive(target: Pick<Page, 'route'>): Promise<void> {
	const archive = await baseMapArchiveFixture();
	await target.route(/\.pmtiles$/, (route) => fulfillRange(route, archive));
	const terrain = await readFile(terrainFixture);
	for (const [pattern, body] of [
		[/elevation-tiles-prod\/terrarium\//, terrain],
		[/s2cloudless|USGSNAIPImagery/, PIXEL]
	] as const) {
		await target.route(pattern, (route) =>
			route.fulfill({
				status: 200,
				headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*' },
				body
			})
		);
	}
}

export async function refuseBaseMapArchive(target: Pick<Page, 'route'>): Promise<void> {
	await target.route(/\.pmtiles$/, (route) => route.abort('blockedbyclient'));
}

type PartialArchive = {
	hang(): void;
	serve(): void;
	tileRangesAsked(): number;
};

export async function routePartialBaseMapArchive(
	target: Pick<Page, 'route' | 'unroute'>
): Promise<PartialArchive> {
	const archive = await baseMapArchiveFixture();
	let tiles: 'refuse' | 'hang' | 'serve' = 'refuse';
	let asked = 0;
	await target.unroute(/\.pmtiles$/);
	await target.route(/\.pmtiles$/, async (route) => {
		const header = route.request().headers()['range']?.startsWith('bytes=0-') ?? false;
		if (header) return fulfillRange(route, archive);
		asked += 1;
		if (tiles === 'hang') return new Promise<void>(() => undefined);
		if (tiles === 'serve') return fulfillRange(route, archive);
		await route.abort('blockedbyclient');
	});
	return {
		hang: () => void (tiles = 'hang'),
		serve: () => void (tiles = 'serve'),
		tileRangesAsked: () => asked
	};
}

function baseMapArchiveKey(archive: string): string {
	const slug = (archive.split(/[/\\]/).pop() ?? '')
		.replace(/\.pmtiles$/i, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 24)
		.replace(/-+$/, '');
	const bytes = new TextEncoder().encode(archive);
	const round = (basis: number): string => {
		let hash = basis;
		for (const byte of bytes) {
			hash ^= byte;
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash.toString(16).padStart(8, '0');
	};
	return `${slug || 'archive'}-${round(0x811c9dc5)}${round(0x9dc5811c)}`;
}

export const baseMapTileDirectory = (archive: string): string =>
	`base-map/tiles/${baseMapArchiveKey(archive)}/`;

export const baseMapTileSourcePath = (archive: string): string =>
	`${baseMapTileDirectory(archive)}tile-source.json`;

const cachedTilePath = (archive: string, tile: { z: number; x: number; y: number }): string =>
	`${baseMapTileDirectory(archive)}${tile.z}/${tile.x}/${tile.y}.mvt`;

function tilesForBounds(
	bounds: { west: number; south: number; east: number; north: number },
	maxZoom: number
): { z: number; x: number; y: number }[] {
	const limit = 85.0511287798066;
	const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
	const tileX = (lng: number, z: number) => Math.floor(((lng + 180) / 360) * 2 ** z);
	const tileY = (lat: number, z: number) => {
		const radians = (clamp(lat, -limit, limit) * Math.PI) / 180;
		const fraction = (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
		return clamp(Math.floor(fraction * 2 ** z), 0, 2 ** z - 1);
	};
	const tiles: { z: number; x: number; y: number }[] = [];
	for (let z = 0; z <= maxZoom; z += 1) {
		const width = 2 ** z;
		const first = tileX(bounds.west, z);
		const columns = Math.min(tileX(bounds.east, z) - first + 1, width);
		for (let step = 0; step < columns; step += 1) {
			const x = (((first + step) % width) + width) % width;
			for (let y = tileY(bounds.north, z); y <= tileY(bounds.south, z); y += 1)
				tiles.push({ z, x, y });
		}
	}
	return tiles;
}

/**
 * The fixture archive's tiles as the Workspace cache holds them:
 * `base-map/tiles/<key>/{z}/{x}/{y}.mvt`.
 *
 * **Real bytes out of the real archive, decompressed exactly as the app decompresses them.**
 * `PMTiles#getZxy` applies `decompress(data, header.tileCompression)` before returning, which is why
 * the cache stores decompressed MVT and why the protocol handler serves it unconverted (ADR-0025).
 * Producing these any other way — a zero-filled placeholder, or the archive's gzipped bytes — would
 * make the Published Site's offline assertion vacuous in the exact direction the ADR warns about: the
 * tiles would arrive, MapLibre would parse nothing, and no error would be raised anywhere.
 *
 * **It also weighs them, and that is not a by-product.** ADR-0025's per-tile byte estimate and the
 * refusal threshold both rest on a measurement of this archive, and a measurement in a comment is
 * prose. This returns the totals so a test can assert them, and `editor-base-map.e2e.ts` does, so the
 * figure cannot rot unnoticed.
 *
 * @param archive the catalog entry's own `archive` string, which the directory is keyed on
 * @param bounds the extent to cache, defaulting to the whole fixture archive's own extent
 * @param maxZoom the deepest zoom to include, defaulting to the archive's own maximum
 */
export async function cachedBaseMapTiles(
	archive: string,
	bounds?: { west: number; south: number; east: number; north: number },
	maxZoom?: number
): Promise<CachedBaseMapTiles> {
	const bytes = await baseMapArchiveFixture();
	const source = {
		getKey: () => 'fixture',
		async getBytes(offset: number, length: number) {
			const end = Math.min(offset + length, bytes.length);
			return {
				data: bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + end) as ArrayBuffer
			};
		}
	};
	const opened = new PMTiles(source);
	const compressed = new PMTiles(source, undefined, async (data: ArrayBuffer) => data);
	const header = await opened.getHeader();
	const extent = bounds ?? {
		west: header.minLon,
		south: header.minLat,
		east: header.maxLon,
		north: header.maxLat
	};
	const top = maxZoom ?? header.maxZoom;
	const files: Record<string, Uint8Array> = {};
	let decompressedBytes = 0;
	let gzippedBytes = 0;
	let asked = 0;
	for (const tile of tilesForBounds(extent, top)) {
		asked += 1;
		const found = await opened.getZxy(tile.z, tile.x, tile.y);
		if (!found) continue;
		files[cachedTilePath(archive, tile)] = new Uint8Array(found.data);
		decompressedBytes += found.data.byteLength;
		gzippedBytes += (await compressed.getZxy(tile.z, tile.x, tile.y))?.data.byteLength ?? 0;
	}
	return {
		files,
		maxZoom: top,
		archiveBytes: bytes.length,
		tilesInExtent: asked,
		tilesPresent: Object.keys(files).length,
		decompressedBytes,
		gzippedBytes
	};
}

type CachedBaseMapTiles = {
	readonly files: Record<string, Uint8Array>;
	readonly maxZoom: number;
	readonly archiveBytes: number;
	readonly tilesInExtent: number;
	readonly tilesPresent: number;
	readonly decompressedBytes: number;
	readonly gzippedBytes: number;
};

export type EditorDeployment = {
	readonly url: string;
	readonly prefix: string;
	readonly requests: string[];
	readonly failures: { path: string; status: number }[];
	deployNewVersion(): void;
	stopServing(): Promise<void>;
	close(): Promise<void>;
};

/**
 * Serve `apps/editor/build` over HTTP, optionally under `prefix`.
 *
 * @param prefix a leading path such as `/teaching/ballastella`, or `''` for a domain root
 */
export const deployEditor = async (prefix = ''): Promise<EditorDeployment> =>
	(await deployEditors(prefix))[0]!;

/**
 * Two or more deployments of the same build **on one origin**, which is a different question from
 * two servers and the reason this exists.
 *
 * ADR-0045's subdirectory case is `user.github.io/` and `user.github.io/ballastella/`: one host, two
 * served folders, and — the part nothing else in this harness can express — *one* cache storage,
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
		const heard = prefix === undefined ? [...state.values()] : [state.get(prefix)!];
		for (const record of heard) record.requests.push(asked);

		const answer = (
			status: number,
			body: Buffer | string,
			headers: Record<string, string> = {}
		) => {
			if (status !== 200 && status !== 301 && status !== 206 && status !== 416)
				for (const record of heard) record.failures.push({ path: asked, status });
			response.writeHead(status, headers);
			response.end(request.method === 'HEAD' ? undefined : body);
		};

		if (prefix === undefined) {
			answer(404, `${url.pathname} is outside ${prefixes.map((p) => `${p}/`).join(', ')}`, {
				'content-type': 'text/plain; charset=utf-8'
			});
			return;
		}
		const nextVersion = state.get(prefix)!.nextVersion;
		let relative = decodeURIComponent(url.pathname.slice(prefix.length + 1));

		if (relative === '' || relative.endsWith('/')) relative += 'index.html';
		else if (path.extname(relative) === '') {
			try {
				await readFile(path.join(editorBuild, `${relative}.html`));
				relative = `${relative}.html`;
			} catch {}
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
		const served = byteRange(body, request.headers.range, type);
		answer(served.status, served.body, served.headers);
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;

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
			deployNewVersion: () => void (record.nextVersion = true),
			stopServing: stop,
			close: stop
		};
	});
}

function asNextVersion(relative: string, body: Buffer): Buffer {
	if (relative === 'service-worker.js') {
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
