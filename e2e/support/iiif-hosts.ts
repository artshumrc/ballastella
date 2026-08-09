// The fake IIIF services every spec that needs one shares (ticket 07).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS ONE MODULE
//
// Three specs had grown their own: `editor-remote-iiif.e2e.ts`, `editor-offline-copy.e2e.ts` and
// `editor-pwa.e2e.ts`, each with its own host table, its own `info.json` builder, its own `json()`
// helper — byte-identical in two of the three — and its own tile-URL regex, which were **not**
// identical and matched different halves of a IIIF request. That is the shape of duplication that
// costs a session: a test asserting a host's behaviour asserts the behaviour of *its copy* of that
// host, so two specs can disagree about what a level 0 service does and both stay green.
//
// It also made a whole class of resource unreachable. There was no level-0-without-`tiles` host
// anywhere, which is the one shape this application must refuse when a map is *added* — and a
// refusal nobody can reach is a refusal nobody can check.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE NETWORK FENCE, AND WHY THESE ROUTES COME FIRST
//
// `e2e/support/network-fence.ts` installs `context.route('**/*')` in the `context` fixture, before
// any `beforeEach`, and aborts anything it did not expect. Playwright consults `page.route`
// handlers before `context.route` ones, so a host installed here is served and never reaches the
// fence. A spec that forgets to install them gets `net::ERR_BLOCKED_BY_CLIENT` and a teardown
// failure, which is the fence working: **no spec using this module reaches the internet.**
//
// `target` is `Pick<Page | BrowserContext, 'route'>`, the same signature `routeBaseMapArchive` takes
// and for the same measured reason: `page.route` cannot see requests a **service worker** makes, so
// a spec testing offline behaviour has to install these on the context. Passing a `BrowserContext`
// puts these handlers at the same level as the fence — still registered later, so still consulted
// first, because Playwright matches the most recently added route.

import { createHash } from 'node:crypto';
import type { BrowserContext, Page, Route } from '@playwright/test';

import { gradientPng } from './alignment-workspace.js';

/** Where every spec's images live on their fixture host. */
export const service = (host: string, name: string) => `https://${host}/iiif/3/${name}`;

/**
 * `generateId(uri)` — the identifier Allmaps keys an image on — computed from `node:crypto`.
 *
 * Deliberately an independent implementation rather than an import of `@allmaps/id`: the criterion
 * is that the app's id *equals* `generateId(uri)`, and asserting that with the same function the app
 * used would only prove the function is deterministic. SHA-1 of the URI, first 16 hex characters.
 * Verified against the live Allmaps API in `packages/core/src/remote-iiif/live-services.test.ts`.
 */
export const generateId = (uri: string): string =>
	createHash('sha1').update(uri).digest('hex').slice(0, 16);

/** The dimensions the ordinary fixture image has, which most specs assert against. */
export const IMAGE_WIDTH = 700;
export const IMAGE_HEIGHT = 500;

export type HostShape = {
	readonly profile: 'level0' | 'level2';
	readonly width: number;
	readonly height: number;
	readonly tile: number;
	/**
	 * Whether the service publishes a `tiles` property at all.
	 *
	 * `false` is the one shape this application refuses outright, and it exists here because it is
	 * unreachable otherwise. A level 0 service serves exactly the pre-cut tiles it declares — no
	 * arbitrary regions — so one declaring none has no tile at any address a client could construct.
	 * `@allmaps/iiif-parser` throws "Image does not support tiles or custom regions and sizes", and
	 * ADR-0007's rule is that the refusal lands when the resource is *added*, never when Align is
	 * clicked: a user must never be given a Layer whose Align button leads to a screen that cannot
	 * work.
	 *
	 * The document still carries `sizes`, because that is what such a service publishes in practice —
	 * a list of whole-image derivatives, which is not a pyramid.
	 */
	readonly tiles?: boolean;
	/** A declared limit on one request, as two of ticket 14's fourteen real services carry. */
	readonly maxWidth?: number;
	/** Milliseconds to hold each tile response, so a copy can be cancelled in the middle. */
	readonly tileDelayMs?: number;
	/** Whether `full/max` answers at all. `false` is what a level-0 pyramid on a web server does. */
	readonly wholeImage: boolean | 'error';
	/**
	 * Whether the host permits its tiles to be read cross-origin.
	 *
	 * `false` aborts them the way a browser aborts a request the host does not permit — the
	 * `info.json` readable and the tiles not, which is ADR-0007's whole reason for probing at add
	 * time rather than discovering it at render time.
	 */
	readonly tilesReadable?: boolean;
};

/**
 * Every fixture host, in one table.
 *
 * ```
 *   images.test       level 2, 700×500 — the ordinary case nearly every spec uses.
 *   static.test       level 0 with tiles, whose `full/max` is a 404. What a pre-cut pyramid on a
 *                     web server really is, and — per ticket 07 — alignable exactly like level 2.
 *   sizes-only.test   level 0 with NO `tiles`, only `sizes`. Refused when added. See `tiles`.
 *   tiles-only.test   level 2 whose info.json is readable cross-origin and whose tiles are not.
 *   capped.test       level 2 declaring a `maxWidth` smaller than the tiles it declares.
 *   huge.test         level 2 declaring a 1.4-gigapixel image, above ADR-0027's decode cap.
 *   large.test        level 2 at 520 megapixels — just under that cap.
 *   slow.test         level 0 with enough tiles, served slowly enough, to cancel in the middle of.
 *   broken.test       level 2 whose `full/max` is a 500.
 * ```
 */
export const HOSTS: Record<string, HostShape> = {
	'images.test': { profile: 'level2', width: 700, height: 500, tile: 256, wholeImage: true },
	'static.test': { profile: 'level0', width: 700, height: 500, tile: 256, wholeImage: false },
	'sizes-only.test': {
		profile: 'level0',
		width: 700,
		height: 500,
		tile: 256,
		tiles: false,
		wholeImage: false
	},
	'tiles-only.test': {
		profile: 'level2',
		width: 700,
		height: 500,
		tile: 256,
		wholeImage: true,
		tilesReadable: false
	},
	'capped.test': {
		profile: 'level2',
		width: 700,
		height: 500,
		tile: 256,
		maxWidth: 400,
		wholeImage: true
	},
	'huge.test': { profile: 'level2', width: 40_000, height: 36_000, tile: 256, wholeImage: true },
	'large.test': { profile: 'level2', width: 26_000, height: 20_000, tile: 256, wholeImage: true },
	'slow.test': {
		profile: 'level0',
		width: 2000,
		height: 1500,
		tile: 256,
		tileDelayMs: 120,
		wholeImage: false
	},
	'broken.test': { profile: 'level2', width: 700, height: 500, tile: 256, wholeImage: 'error' }
};

/**
 * The scale factors a pyramid of this size needs, computed rather than written down.
 *
 * Computed because `createImagePane` refuses a pyramid whose coarsest level does not reduce the whole
 * image to a single tile, and a literal list drifts from the dimensions beside it the first time a
 * host's size changes — at which point the fixture is refused and the test reads as an app defect.
 */
export const scaleFactorsFor = (width: number, height: number, tile: number): number[] => {
	const factors = [1];
	while (
		Math.ceil(width / (tile * factors[factors.length - 1]!)) > 1 ||
		Math.ceil(height / (tile * factors[factors.length - 1]!)) > 1
	) {
		factors.push(factors[factors.length - 1]! * 2);
	}
	return factors;
};

export const infoJson = (host: string, name: string) => {
	const shape = HOSTS[host]!;
	return {
		'@context': 'http://iiif.io/api/image/3/context.json',
		id: service(host, name),
		type: 'ImageService3',
		protocol: 'http://iiif.io/api/image',
		profile: shape.profile,
		width: shape.width,
		height: shape.height,
		...(shape.maxWidth === undefined
			? {}
			: { maxWidth: shape.maxWidth, maxHeight: shape.maxWidth }),
		...(shape.tiles === false
			? // What such a service publishes instead. Whole-image derivatives, not a pyramid.
				{ sizes: [{ width: shape.width, height: shape.height }] }
			: {
					tiles: [
						{
							width: shape.tile,
							height: shape.tile,
							scaleFactors: scaleFactorsFor(shape.width, shape.height, shape.tile)
						}
					]
				})
	};
};

export const canvas = (index: number, label: string, host: string, name: string) => {
	const shape = HOSTS[host]!;
	return {
		id: `https://library.test/iiif/atlas/canvas/${index}`,
		type: 'Canvas',
		label: { none: [label] },
		width: shape.width,
		height: shape.height,
		items: [
			{
				id: `https://library.test/iiif/atlas/page/${index}`,
				type: 'AnnotationPage',
				items: [
					{
						id: `https://library.test/iiif/atlas/annotation/${index}`,
						type: 'Annotation',
						motivation: 'painting',
						target: `https://library.test/iiif/atlas/canvas/${index}`,
						body: {
							id: `${service(host, name)}/full/max/0/default.jpg`,
							type: 'Image',
							format: 'image/jpeg',
							width: shape.width,
							height: shape.height,
							service: [{ id: service(host, name), type: 'ImageService3', profile: shape.profile }]
						}
					}
				]
			}
		]
	};
};

/**
 * The Manifest at `https://library.test/iiif/atlas/manifest.json`.
 *
 * A function of its canvases rather than a constant, because the two specs that had one wanted
 * different numbers of them: three, to test *choosing* a canvas, and one, so that adding needs no
 * choice. Both are legitimate, and folding them into a single constant would have made one spec's
 * "click add" silently mean "add whichever canvas is first".
 */
export const atlasManifest = (canvases: unknown[] = DEFAULT_CANVASES) => ({
	'@context': 'http://iiif.io/api/presentation/3/context.json',
	id: 'https://library.test/iiif/atlas/manifest.json',
	type: 'Manifest',
	label: { en: ['A Sea Atlas of the Western Approaches'] },
	summary: { en: ['Three charts, engraved 1657.'] },
	metadata: [
		{ label: { en: ['Date'] }, value: { en: ['1657'] } },
		{ label: { en: ['Shelfmark'] }, value: { none: ['MS Atlas 44'] } }
	],
	requiredStatement: {
		label: { en: ['Attribution'] },
		value: { en: ['Provided by the Example Library'] }
	},
	rights: 'http://creativecommons.org/licenses/by/4.0/',
	items: canvases
});

const DEFAULT_CANVASES = [
	canvas(1, 'Title page', 'images.test', 'title-page'),
	canvas(2, 'Chart of the Florida coast', 'images.test', 'florida'),
	canvas(3, 'Chart of the Chesapeake', 'images.test', 'chesapeake')
];

/** The single canvas a spec uses when adding must take no choosing. */
export const singleCanvas = [canvas(2, 'Chart of the Florida coast', 'images.test', 'florida')];

export const collection = {
	'@context': 'http://iiif.io/api/presentation/3/context.json',
	id: 'https://library.test/iiif/collection',
	type: 'Collection',
	label: { en: ['Sea atlases'] },
	items: [
		{
			id: 'https://library.test/iiif/atlas/manifest.json',
			type: 'Manifest',
			label: { en: ['A Sea Atlas of the Western Approaches'] }
		}
	]
};

/** A single-canvas Manifest on the host whose tiles are not readable cross-origin. */
export const hostileManifest = {
	'@context': 'http://iiif.io/api/presentation/3/context.json',
	id: 'https://library.test/iiif/locked/manifest.json',
	type: 'Manifest',
	label: { en: ['A chart from a locked-down host'] },
	items: [canvas(1, 'The chart', 'tiles-only.test', 'locked')]
};

/** A single-canvas Manifest on the level 0 host that publishes no tiles. */
export const unalignableManifest = {
	'@context': 'http://iiif.io/api/presentation/3/context.json',
	id: 'https://library.test/iiif/sizes-only/manifest.json',
	type: 'Manifest',
	label: { en: ['A chart from a service with no tiles'] },
	items: [canvas(1, 'The chart', 'sizes-only.test', 'plain')]
};

/**
 * A Georeference Annotation of the shape `annotations.allmaps.org` answers with: three Control
 * Points, which is what a first-order polynomial needs (ADR-0013), and a Resource Mask inside the
 * sheet.
 *
 * @param reading which of two *different* readings of the same sheet. Some tests turn on which
 *   Alignment ended up on disk, and identical documents are indistinguishable there — so
 *   `'refined'` is a second colleague's placement of the same map, differing in every Control Point
 *   and in the Mask.
 */
export const communityAnnotation = (
	host: string,
	name: string,
	reading: 'first' | 'refined' = 'first'
) => ({
	type: 'Annotation',
	'@context': [
		'http://iiif.io/api/extension/georef/1/context.json',
		'http://iiif.io/api/presentation/3/context.json'
	],
	motivation: 'georeferencing',
	target: {
		type: 'SpecificResource',
		source: {
			id: service(host, name),
			type: 'ImageService3',
			width: IMAGE_WIDTH,
			height: IMAGE_HEIGHT
		},
		selector: {
			type: 'SvgSelector',
			value:
				reading === 'first'
					? `<svg width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}"><polygon points="10,10 690,10 690,490 10,490" /></svg>`
					: `<svg width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}"><polygon points="30,30 670,30 670,470 30,470" /></svg>`
		}
	},
	body: {
		type: 'FeatureCollection',
		transformation: { type: 'polynomial', options: { order: 1 } },
		features:
			reading === 'first'
				? [
						{
							type: 'Feature',
							properties: { resourceCoords: [60, 80] },
							geometry: { type: 'Point', coordinates: [-82.5, 27.9] }
						},
						{
							type: 'Feature',
							properties: { resourceCoords: [640, 90] },
							geometry: { type: 'Point', coordinates: [-80.1, 28.1] }
						},
						{
							type: 'Feature',
							properties: { resourceCoords: [340, 430] },
							geometry: { type: 'Point', coordinates: [-81.2, 25.7] }
						}
					]
				: [
						{
							type: 'Feature',
							properties: { resourceCoords: [70, 90] },
							geometry: { type: 'Point', coordinates: [-82.4, 27.8] }
						},
						{
							type: 'Feature',
							properties: { resourceCoords: [630, 100] },
							geometry: { type: 'Point', coordinates: [-80.2, 28.2] }
						},
						{
							type: 'Feature',
							properties: { resourceCoords: [350, 420] },
							geometry: { type: 'Point', coordinates: [-81.3, 25.6] }
						}
					]
	}
});

export const json = (route: Route, body: unknown) =>
	route.fulfill({
		status: 200,
		contentType: 'application/json',
		headers: { 'access-control-allow-origin': '*' },
		body: JSON.stringify(body)
	});

const CORS = { 'access-control-allow-origin': '*' };

const notFound = (route: Route, body = 'no such tile') =>
	route.fulfill({ status: 404, headers: CORS, body });

/**
 * The size a IIIF tile URL asked for, so the fixture host can honour it **exactly**.
 *
 * Both spellings, and the order matters. A full IIIF tile request is
 * `{region}/{size}/0/default.jpg` — four numbers then two — and the size-only form is what a request
 * for a scaled derivative looks like. The two specs this module replaces had one regex each, and the
 * size-only one *also matches* a full tile request while capturing the region's width and height
 * instead of the size's: a fixture serving tiles of the wrong dimensions, which the CORS probe then
 * refuses for a reason that has nothing to do with the test. So the four-number form is tried first.
 *
 * Exactness matters twice over: the CORS probe refuses a tile whose decoded dimensions are not what
 * was asked for, and `assembleWithCanvas` refuses a piece whose decoded dimensions are not its
 * region's.
 */
export function requestedSize(url: string): { width: number; height: number } | null {
	const full = /\/(\d+),(\d+),(\d+),(\d+)\/(\d+),(\d+)\/0\/default\.(jpg|png)$/.exec(url);
	if (full) return { width: Number(full[5]), height: Number(full[6]) };
	const sizeOnly = /\/(\d+),(\d+)\/0\/default\.(jpg|png)$/.exec(url);
	if (sizeOnly) return { width: Number(sizeOnly[1]), height: Number(sizeOnly[2]) };
	return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type InstallIiifHostsOptions = {
	/**
	 * What `annotations.allmaps.org` answers with, or `null` for a 404 — which is what the real API
	 * answers for a resource it has nothing for.
	 */
	readonly communityAnnotations?: unknown[] | null;
	/** The canvases of the atlas Manifest. See {@link atlasManifest}. */
	readonly manifestCanvases?: unknown[];
};

/**
 * Install every fixture host on `target`.
 *
 * Pass a `Page` for an ordinary spec; pass a `BrowserContext` when the requests come from a service
 * worker, which `page.route` cannot see. See the module header.
 */
export async function installIiifHosts(
	target: Pick<Page | BrowserContext, 'route'>,
	options: InstallIiifHostsOptions = {}
): Promise<void> {
	const annotations = options.communityAnnotations ?? null;
	const manifest = atlasManifest(options.manifestCanvases);

	await target.route('https://library.test/**', (route) => {
		const url = route.request().url();
		if (url.endsWith('/atlas/manifest.json')) return json(route, manifest);
		if (url.endsWith('/locked/manifest.json')) return json(route, hostileManifest);
		if (url.endsWith('/sizes-only/manifest.json')) return json(route, unalignableManifest);
		if (url.endsWith('/iiif/collection')) return json(route, collection);
		if (url.endsWith('/maps/1657')) {
			// A viewer page answered with a 200, which is the most common single failure on this path.
			return route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				headers: CORS,
				body: '<!DOCTYPE html><title>A Sea Atlas</title><p>Look at this map.</p>'
			});
		}
		return route.fulfill({ status: 404, headers: CORS, body: '{}' });
	});

	for (const host of Object.keys(HOSTS)) {
		const shape = HOSTS[host]!;
		await target.route(`https://${host}/**`, async (route) => {
			const url = route.request().url();
			const name = /\/iiif\/3\/([^/]+)/.exec(url)?.[1] ?? '';

			if (url.endsWith('/info.json')) return json(route, infoJson(host, name));

			// The whole image, in either spelling. A level-0 pyramid has no such file, which is what
			// makes it level 0 — so answering 404 here is the fixture being honest rather than awkward.
			if (/\/full\/(max|full)\/0\/default\.jpg$/.test(url)) {
				if (shape.wholeImage === false) {
					return notFound(route, 'this service serves only its own tiles');
				}
				if (shape.wholeImage === 'error') {
					return route.fulfill({ status: 500, headers: CORS, body: 'the image server fell over' });
				}
				return route.fulfill({
					status: 200,
					contentType: 'image/png',
					headers: CORS,
					body: gradientPng(shape.width, shape.height)
				});
			}

			const size = requestedSize(url);
			if (!size) return notFound(route);
			// The whole point of a host with `tilesReadable: false`: its description is readable
			// cross-origin and its tiles are not, which is what a browser does to a request the host
			// does not permit.
			if (shape.tilesReadable === false) return route.abort('accessdenied');
			if (shape.tileDelayMs) await sleep(shape.tileDelayMs);
			return route.fulfill({
				status: 200,
				contentType: 'image/png',
				headers: CORS,
				body: gradientPng(size.width, size.height)
			});
		});
	}

	await routeCommunityAnnotations(target, annotations);
}

/**
 * Re-route `annotations.allmaps.org` alone.
 *
 * Separate from {@link installIiifHosts} because a test needs to change what the Allmaps API offers
 * *after* the app has already asked once. Playwright consults the most recently registered handler,
 * so calling this again shadows the previous one.
 */
export async function routeCommunityAnnotations(
	target: Pick<Page | BrowserContext, 'route'>,
	annotations: unknown[] | null
): Promise<void> {
	await target.route('https://annotations.allmaps.org/**', (route) =>
		annotations === null
			? route.fulfill({
					status: 404,
					contentType: 'application/json',
					headers: CORS,
					body: JSON.stringify({ status: 404, error: 'Not Found' })
				})
			: json(route, { '@context': 'x', type: 'AnnotationPage', items: annotations })
	);
}
