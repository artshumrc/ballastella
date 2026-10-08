import { createHash } from 'node:crypto';
import type { BrowserContext, Page, Route } from '@playwright/test';

import { gradientPng } from './alignment-workspace.js';

export const service = (host: string, name: string) => `https://${host}/iiif/3/${name}`;

export const generateId = (uri: string): string =>
	createHash('sha1').update(uri).digest('hex').slice(0, 16);

const IMAGE_WIDTH = 700;
const IMAGE_HEIGHT = 500;

type HostShape = {
	readonly profile: 'level0' | 'level2';
	readonly width: number;
	readonly height: number;
	readonly tile: number;
	readonly tiles?: boolean;
	readonly maxWidth?: number;
	readonly tileDelayMs?: number;
	readonly wholeImage: boolean | 'error';
	readonly tilesReadable?: boolean;
};

const small = { width: 700, height: 500, tile: 256 } as const;
const HOSTS: Record<string, HostShape> = {
	'images.test': { ...small, profile: 'level2', wholeImage: true },
	'static.test': { ...small, profile: 'level0', wholeImage: false },
	'sizes-only.test': { ...small, profile: 'level0', tiles: false, wholeImage: false },
	'tiles-only.test': { ...small, profile: 'level2', wholeImage: true, tilesReadable: false },
	'capped.test': { ...small, profile: 'level2', maxWidth: 400, wholeImage: true },
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
	'broken.test': { ...small, profile: 'level2', wholeImage: 'error' }
};

const scaleFactorsFor = (width: number, height: number, tile: number): number[] => {
	const factors = [1];
	while (
		Math.ceil(width / (tile * factors[factors.length - 1]!)) > 1 ||
		Math.ceil(height / (tile * factors[factors.length - 1]!)) > 1
	) {
		factors.push(factors[factors.length - 1]! * 2);
	}
	return factors;
};

const infoJson = (host: string, name: string) => {
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
			? { sizes: [{ width: shape.width, height: shape.height }] }
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

const canvas = (index: number, label: string, host: string, name: string) => {
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

const atlasManifest = (canvases: unknown[] = DEFAULT_CANVASES) => ({
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

export const singleCanvas = [canvas(2, 'Chart of the Florida coast', 'images.test', 'florida')];

const collection = {
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

const hostileManifest = {
	'@context': 'http://iiif.io/api/presentation/3/context.json',
	id: 'https://library.test/iiif/locked/manifest.json',
	type: 'Manifest',
	label: { en: ['A chart from a locked-down host'] },
	items: [canvas(1, 'The chart', 'tiles-only.test', 'locked')]
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
		features: (reading === 'first'
			? [
					[60, 80, -82.5, 27.9],
					[640, 90, -80.1, 28.1],
					[340, 430, -81.2, 25.7]
				]
			: [
					[70, 90, -82.4, 27.8],
					[630, 100, -80.2, 28.2],
					[350, 420, -81.3, 25.6]
				]
		).map(([x, y, lng, lat]) => ({
			type: 'Feature',
			properties: { resourceCoords: [x, y] },
			geometry: { type: 'Point', coordinates: [lng, lat] }
		}))
	}
});

const CORS = { 'access-control-allow-origin': '*' };

const json = (route: Route, body: unknown) =>
	route.fulfill({
		status: 200,
		contentType: 'application/json',
		headers: CORS,
		body: JSON.stringify(body)
	});

const notFound = (route: Route, body = 'no such tile') =>
	route.fulfill({ status: 404, headers: CORS, body });

function requestedSize(url: string): { width: number; height: number } | null {
	const full = /\/(\d+),(\d+),(\d+),(\d+)\/(\d+),(\d+)\/0\/default\.(jpg|png)$/.exec(url);
	if (full) return { width: Number(full[5]), height: Number(full[6]) };
	const sizeOnly = /\/(\d+),(\d+)\/0\/default\.(jpg|png)$/.exec(url);
	if (sizeOnly) return { width: Number(sizeOnly[1]), height: Number(sizeOnly[2]) };
	return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type InstallIiifHostsOptions = {
	readonly communityAnnotations?: unknown[] | null;
	readonly manifestCanvases?: unknown[];
};

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
		if (url.endsWith('/iiif/collection')) return json(route, collection);
		if (url.endsWith('/maps/1657')) {
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
