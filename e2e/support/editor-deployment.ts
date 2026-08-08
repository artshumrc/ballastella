import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Page } from './test.js';
import { PMTiles } from 'pmtiles';

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
const baseMapFixture = path.join(repoRoot, 'e2e/fixtures/base-map/amsterdam-centre.pmtiles');

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
 * The real PMTiles archive retained only for browser tests, read off disk.
 *
 * Used to stand in for the catalog's network archive: tests need genuine byte-range PMTiles
 * responses without either shipping this regional extract or depending on somebody else's host.
 */
export async function baseMapArchiveFixture(): Promise<Buffer> {
	return readFile(baseMapFixture);
}

/**
 * Route this deployment's network Base Map to the repository's real-byte fixture.
 *
 * Takes a `Page` **or** a `BrowserContext`, because both carry `route` with the same contract and
 * the choice between them is per-suite: a `beforeEach` that runs before the page exists routes the
 * context. Written once, so that "serve real pmtiles bytes" cannot drift between suites.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT ROUTING STILL EXERCISES, AND WHAT IT GIVES UP
 *
 * Stated from measurement rather than from reasoning, because ticket 17 extended this to the last
 * three specs that reached the network for real, and the reasoning turned out to be wrong.
 *
 * **Still exercised:** PMTiles is a byte-range format, and {@link byteRange} answers with genuine
 * `206`, `content-range` and `accept-ranges` over the real bytes of a real Protomaps extract, not a
 * stub. `editor-base-map.e2e.ts` is where that path is actually asserted, and it is unaffected.
 *
 * **Given up:** the live fetch — DNS, TLS, and that host's CORS — to a third party. Nothing asserted
 * any of it. And worldwide coverage: the fixture is a city-centre extract of Amsterdam, which is
 * where every spec routed here works and where the alignment fixtures place their Control Points.
 *
 * ⚠ **For the three specs ticket 17 added, the honest answer is that this gives up nothing at all,
 * and the measurement is worth keeping because it is surprising.** They pass with this fixture, they
 * pass with an archive of **all zeros**, and they pass with the route answering **404**. They never
 * depended on the Base Map's content: what they need is for the archive request to be *answered* so
 * MapLibre's source initialises and the warped layer gets added. Their warped-tile assertions read
 * the Historical Map's own pyramid out of OPFS, which never involved this archive.
 *
 * So what broke them was not the 404. It was that an **unrouted** request is cross-origin, and the
 * bucket's 404 carries no `access-control-allow-origin` while its preflight answers 403 — so the
 * browser blocks the fetch outright and the page gets no response at all, which is a different and
 * much worse state than an HTTP error it can handle. Verified by running the same specs unrouted
 * (red) and routed-but-404 (green).
 *
 * **What is gained is ADR-0025's warning made operational.** That ADR already says this bucket has
 * "no published rate limit, no uptime promise, and no terms of use" and that "nothing about it is
 * suitable to rely on"; on 2026-08-07 it began answering 404 and turned three specs red for a reason
 * that had nothing to do with this repository. A suite whose failures mean something cannot depend
 * on a stranger's uptime.
 *
 * `editor-alignment.e2e.ts` had already reached for this and missed: it picks a "bundled" catalog
 * entry over `streets-worldwide` and says doing otherwise "would buy nothing and cost a flake on
 * every reading-room wifi this suite is ever run on". The intent was right; the lever was wrong,
 * because **all four** catalog entries share one `REMOTE_ARCHIVE`.
 */
export async function routeBaseMapArchive(target: Pick<Page, 'route'>): Promise<void> {
	const archive = await baseMapArchiveFixture();
	await target.route(/\.pmtiles$/, async (route) => {
		const served = byteRange(
			archive,
			route.request().headers()['range'],
			'application/octet-stream'
		);
		await route.fulfill({
			status: served.status,
			headers: { ...served.headers, 'access-control-allow-origin': '*' },
			body: served.body
		});
	});
}

/**
 * Refuse this deployment's network Base Map, deliberately and at the test's own request.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY A TEST WOULD ASK FOR THIS, AND WHY IT IS NOT A WAY ROUND THE FENCE
 *
 * `support/network-fence.ts` refuses every request to an external origin, so a spec whose *subject*
 * is an unreachable Base Map — `editor-pwa.e2e.ts`'s "the app with the network off" — trips the
 * fence merely by being what it is. Routing that archive to the fixture would answer it, which is
 * the opposite of what those tests are about: one asserts the app explains an absent Base Map, and
 * the other's central paragraph turns on the fact that with no archive MapLibre never even reaches
 * the point of asking for a glyph range.
 *
 * So the archive is refused *here*, in the spec, rather than by the network being down. The
 * behaviour under test is unchanged — the request fails either way — and what changes is that the
 * absence is now stated by the test instead of inherited from the machine it runs on. Before this,
 * "the Base Map does not load in these tests" was true because `demo-bucket.protomaps.com` was
 * unreachable, which is a fact about someone else's server and not a decision anybody made.
 *
 * `blockedbyclient` rather than `failed`, matching the fence, so a page's console says a policy
 * refused this rather than implying a host is down.
 */
export async function refuseBaseMapArchive(target: Pick<Page, 'route'>): Promise<void> {
	await target.route(/\.pmtiles$/, (route) => route.abort('blockedbyclient'));
}

/**
 * `base-map/tiles/{z}/{x}/{y}.mvt`, and the tiles a box needs from zoom 0 up.
 *
 * Duplicated from `@ballastella/core`'s `base-map/tile-cache.ts` rather than imported, because the
 * workspace-level tsconfig deliberately covers only `e2e/` and `playwright.config.ts` — the same
 * reason `viewer-reader.e2e.ts` re-declares the Reader's map handle structurally. The duplication is
 * safe in the direction that matters: this harness *produces* the layout the app *reads*, so a drift
 * between the two makes the offline assertion fail rather than pass quietly.
 *
 * **The archive is a parameter and is never named here.** Since ticket 12 the directory is keyed by
 * the catalog entry's own `archive` string, and `scripts/check-base-map-catalog.mjs` exempts
 * `*.e2e.ts` but not this file — for the good reason that a fork repointing its catalog must not have
 * to edit the harness. So the specs supply it and this computes the key.
 */
export function baseMapArchiveKey(archive: string): string {
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

/** Where one archive's cached tiles live in a Workspace, with its trailing `/`. */
export const baseMapTileDirectory = (archive: string): string =>
	`base-map/tiles/${baseMapArchiveKey(archive)}/`;

/** Where one archive's record of its own depth lives, inside its keyed directory. */
export const baseMapTileSourcePath = (archive: string): string =>
	`${baseMapTileDirectory(archive)}tile-source.json`;

export const cachedTilePath = (
	archive: string,
	tile: { z: number; x: number; y: number }
): string => `${baseMapTileDirectory(archive)}${tile.z}/${tile.x}/${tile.y}.mvt`;

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
 * refusal threshold both rest on a measurement of this archive, and the epic's tracker forbids a
 * ticket committing to that measurement unverified. A table in a comment is prose; this returns the
 * totals so a test can assert them, and `editor-base-map.e2e.ts` does, so the figure cannot rot
 * unnoticed.
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
	// The same archive read with decompression switched off, so the gzipped size of each tile can be
	// weighed beside the decompressed one. That difference is the measured cost of ADR-0025's
	// compression decision, and it is quoted in `tile-cache.ts`.
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

/** What {@link cachedBaseMapTiles} produced, and what it weighed on the way. */
export type CachedBaseMapTiles = {
	readonly files: Record<string, Uint8Array>;
	readonly maxZoom: number;
	/** The archive's own size on disk, for the row of the table that names it. */
	readonly archiveBytes: number;
	/** How many tiles the extent needs, from `tilesForBounds`. */
	readonly tilesInExtent: number;
	/** How many of those the archive actually carries. */
	readonly tilesPresent: number;
	/** What the cache holds, in bytes: decompressed MVT, as ADR-0025 decided. */
	readonly decompressedBytes: number;
	/** What those same tiles weigh inside the archive, for the cost of that decision. */
	readonly gzippedBytes: number;
};

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
