import { expect, test, type Page } from './support/test.js';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { openLayerRow } from './support/layers.js';
import { clickAt, hashesUnder } from './support/annotations.js';
import { seed } from './support/github-hosts.js';
import { IMAGE_ID } from './support/reader-project.js';
import { asJson } from './support/published-site.js';
import { emptyWorkspace } from './support/workspace.js';

test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

const DEPLOYMENT_VIEW = { lng: 0, lat: 20, zoom: 1 };

type BaseMapHandle = {
	loaded(): boolean;
	getCenter(): { lng: number; lat: number };
	getZoom(): number;
	jumpTo(options: { center: [number, number]; zoom: number }): void;
	getBounds(): {
		contains(lngLat: [number, number]): boolean;
		toArray(): [[number, number], [number, number]];
	};
};

type MapWindow = {
	ballastellaBaseMap?: BaseMapHandle;
	ballastellaOpfsWrites?: string[];
	ballastellaWebStorageWrites?: string[];
};
const IMAGE_WIDTH = 1000;
const IMAGE_HEIGHT = 800;

const SHEET_CONTROL_POINTS = [
	{ resource: [100, 100], geo: [-71.1, 42.38] },
	{ resource: [400, 100], geo: [-71.06, 42.38] },
	{ resource: [400, 300], geo: [-71.06, 42.36] },
	{ resource: [100, 300], geo: [-71.1, 42.36] }
] as const;

const CONTROL_POINT_BOX = { west: -71.1, south: 42.36, east: -71.06, north: 42.38 };
const CONTROL_POINT_CENTRE = { lng: -71.08, lat: 42.37 };
const SHEET_BOX = { west: -71.113333, south: 42.31, east: -70.98, north: 42.39 };
const SHEET_CENTRE = { lng: -71.046667, lat: 42.35 };

const BOSTON_PINS: readonly (readonly [number, number])[] = [
	[-71.0912, 42.3601],
	[-71.0656, 42.3554],
	[-71.0402, 42.3522]
];
const BOSTON_CENTRE = { lng: -71.0657, lat: 42.35615 };
const LONE_PIN: readonly [number, number] = [-71.0656, 42.3554];

const PACIFIC_PINS: readonly (readonly [number, number])[] = [
	[139.7671, 35.6812],
	[-122.4194, 37.7749]
];
const PACIFIC_CENTRE_LNG = -171.32615;
const PROJECT_DIRECTORY = 'boston-harbour';

const alignmentJson = (): string =>
	asJson({
		type: 'Annotation',
		'@context': [
			'http://iiif.io/api/extension/georef/1/context.json',
			'http://iiif.io/api/presentation/3/context.json'
		],
		motivation: 'georeferencing',
		target: {
			type: 'SpecificResource',
			source: {
				id: `https://unset.invalid/${IMAGE_ID}`,
				type: 'ImageService3',
				height: IMAGE_HEIGHT,
				width: IMAGE_WIDTH
			},
			selector: {
				type: 'SvgSelector',
				value:
					`<svg width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}">` +
					`<polygon points="0,0 ${IMAGE_WIDTH},0 ${IMAGE_WIDTH},${IMAGE_HEIGHT} 0,${IMAGE_HEIGHT}" />` +
					`</svg>`
			}
		},
		body: {
			type: 'FeatureCollection',
			transformation: { type: 'polynomial', options: { order: 1 } },
			features: SHEET_CONTROL_POINTS.map((point) => ({
				type: 'Feature',
				properties: { resourceCoords: point.resource },
				geometry: { type: 'Point', coordinates: point.geo }
			}))
		}
	});

const pinFeature = (index: number, coordinates: readonly [number, number]) => ({
	type: 'Feature',
	id: `1111111${index}-1111-4111-8111-111111111111`,
	geometry: { type: 'Point', coordinates },
	properties: { title: `Pin ${index}` }
});

const featureCollection = (pins: readonly (readonly [number, number])[]) =>
	asJson({ type: 'FeatureCollection', features: pins.map((at, index) => pinFeature(index, at)) });

type LayerSpec = { kind: 'map' | 'annotation'; id: string; visible?: boolean };

function workspaceFiles(options: {
	layers: readonly LayerSpec[];
	pins?: readonly (readonly [number, number])[];
	unaligned?: boolean;
}): Record<string, string> {
	const files: Record<string, string> = {
		[`${PROJECT_DIRECTORY}/project.json`]: asJson({
			formatVersion: 1,
			name: 'Boston Harbour',
			updatedAt: '2026-01-02T03:04:05.000Z',
			layers: options.layers.map((layer, order) =>
				layer.kind === 'map'
					? {
							kind: 'map',
							id: layer.id,
							name: 'The sheet',
							visible: layer.visible ?? true,
							order,
							opacity: 1,
							imageId: IMAGE_ID
						}
					: {
							kind: 'annotation',
							id: layer.id,
							name: 'Pins',
							visible: layer.visible ?? true,
							order,
							geojsonRef: `annotations/${layer.id}.geojson`,
							defaultStyle: {}
						}
			),
			baseMap: null
		})
	};
	for (const layer of options.layers) {
		if (layer.kind === 'map') {
			files[`images/${IMAGE_ID}/info.json`] = asJson({
				'@context': 'http://iiif.io/api/image/3/context.json',
				id: `https://unset.invalid/${IMAGE_ID}`,
				type: 'ImageService3',
				protocol: 'http://iiif.io/api/image',
				profile: 'level0',
				width: IMAGE_WIDTH,
				height: IMAGE_HEIGHT,
				tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4] }]
			});
		}
		if (layer.kind === 'map' && !options.unaligned) {
			files[`alignments/${IMAGE_ID}.json`] = alignmentJson();
		}
		if (layer.kind === 'annotation') {
			files[`${PROJECT_DIRECTORY}/annotations/${layer.id}.geojson`] = featureCollection(
				options.pins ?? BOSTON_PINS
			);
		}
	}
	return files;
}

async function open(page: Page, files: Record<string, string>): Promise<void> {
	await page.goto('/');
	await emptyWorkspace(page);
	await seed(page, files);
	await page.goto(`/?p=${PROJECT_DIRECTORY}`);
	await settled(page);
}

async function settled(page: Page): Promise<void> {
	await expect(page.getByTestId('opening-view')).toHaveAttribute(
		'data-opening-view',
		/^(content|default)$/,
		{ timeout: 30_000 }
	);
	await page.waitForFunction(
		() => (window as unknown as MapWindow).ballastellaBaseMap?.loaded() === true,
		undefined,
		{ timeout: 45_000 }
	);
}

const viewport = (page: Page) =>
	page.evaluate(() => {
		const map = (window as unknown as MapWindow).ballastellaBaseMap!;
		return { lng: map.getCenter().lng, lat: map.getCenter().lat, zoom: map.getZoom() };
	});

const showing = (page: Page, corners: readonly (readonly [number, number])[]) =>
	page.evaluate((points) => {
		const map = (window as unknown as MapWindow).ballastellaBaseMap!;
		return (points as [number, number][]).every((point) => map.getBounds().contains(point));
	}, corners);

async function parkAt(page: Page, lng: number, lat: number, zoom: number): Promise<void> {
	await page.evaluate(
		(at) =>
			(window as unknown as MapWindow).ballastellaBaseMap!.jumpTo({
				center: [at.lng, at.lat],
				zoom: at.zoom
			}),
		{ lng, lat, zoom }
	);
}

const PARKED = { lng: 2.3522, lat: 48.8566, zoom: 11 };

async function stillParked(page: Page, after: string): Promise<void> {
	const at = await viewport(page);
	expect(at.lng, `the map moved in longitude ${after}`).toBeCloseTo(PARKED.lng, 6);
	expect(at.lat, `the map moved in latitude ${after}`).toBeCloseTo(PARKED.lat, 6);
	expect(at.zoom, `the map changed zoom ${after}`).toBeCloseTo(PARKED.zoom, 6);
}

const rows = (page: Page) => page.getByTestId('layer-row');

test.describe('a Project opens on its own content', () => {
	test('frames an aligned Map Image on its Resource Mask, not on its Control Points', async ({
		page
	}) => {
		await open(page, workspaceFiles({ layers: [{ kind: 'map', id: 'l-map' }] }));

		const at = await viewport(page);
		expect(at.lng).toBeCloseTo(SHEET_CENTRE.lng, 3);
		expect(at.lat).toBeCloseTo(SHEET_CENTRE.lat, 3);
		expect(Math.abs(at.lng - CONTROL_POINT_CENTRE.lng)).toBeGreaterThan(0.005);

		expect(
			await showing(page, [
				[SHEET_BOX.west, SHEET_BOX.south],
				[SHEET_BOX.east, SHEET_BOX.north]
			])
		).toBe(true);
		expect(SHEET_BOX.west).toBeLessThan(CONTROL_POINT_BOX.west);
	});

	test('stops at the zoom cap for a Project whose only content is one pin', async ({ page }) => {
		await open(
			page,
			workspaceFiles({ layers: [{ kind: 'annotation', id: 'l-pins' }], pins: [LONE_PIN] })
		);

		const at = await viewport(page);
		expect(at.lng).toBeCloseTo(LONE_PIN[0], 4);
		expect(at.lat).toBeCloseTo(LONE_PIN[1], 4);
		expect(at.zoom).toBeLessThanOrEqual(16);
		expect(at.zoom).toBeCloseTo(16, 4);
	});

	test('frames on content the author has hidden, rather than on the default', async ({ page }) => {
		await open(
			page,
			workspaceFiles({ layers: [{ kind: 'annotation', id: 'l-pins', visible: false }] })
		);

		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '0');
		const at = await viewport(page);
		expect(at.lng).toBeCloseTo(BOSTON_CENTRE.lng, 3);
		expect(at.lat).toBeCloseTo(BOSTON_CENTRE.lat, 3);
	});

	test('prefers what is visible when only some of the work is hidden', async ({ page }) => {
		await open(page, {
			...workspaceFiles({
				layers: [
					{ kind: 'annotation', id: 'l-pins' },
					{ kind: 'map', id: 'l-map', visible: false }
				]
			})
		});

		expect(await showing(page, BOSTON_PINS)).toBe(true);
		expect(await showing(page, [[SHEET_BOX.west, SHEET_BOX.south]])).toBe(false);
	});

	test('takes the short way round the antimeridian', async ({ page }) => {
		await open(
			page,
			workspaceFiles({ layers: [{ kind: 'annotation', id: 'l-pins' }], pins: PACIFIC_PINS })
		);

		const at = await viewport(page);
		const lng = ((((at.lng + 180) % 360) + 360) % 360) - 180;
		expect(lng).toBeCloseTo(PACIFIC_CENTRE_LNG, 2);

		const [[west], [east]] = await page.evaluate(() =>
			(window as unknown as MapWindow).ballastellaBaseMap!.getBounds().toArray()
		);
		expect(east >= west ? east - west : east + 360 - west).toBeLessThan(180);
	});
});

test.describe('the fit happens once, on open', () => {
	test('a toggled Layer, a renamed Layer, and a new Annotation all leave the viewport alone', async ({
		page
	}) => {
		await open(
			page,
			workspaceFiles({
				layers: [
					{ kind: 'annotation', id: 'l-pins' },
					{ kind: 'map', id: 'l-map' }
				]
			})
		);

		await parkAt(page, PARKED.lng, PARKED.lat, PARKED.zoom);
		await stillParked(page, 'before anything was edited');

		await rows(page).nth(1).getByTestId('layer-visible').uncheck();
		await expect(page.getByRole('status')).toHaveText('Saved here');
		await stillParked(page, 'after a Layer was hidden');

		await rows(page).nth(1).getByTestId('layer-visible').check();
		await expect(page.getByRole('status')).toHaveText('Saved here');
		await stillParked(page, 'after a Layer was shown again');

		const renaming = await openLayerRow(page, rows(page).nth(0));
		await renaming.getByTestId('layer-rename').click();
		await renaming.getByTestId('layer-name').fill('The pins, renamed');
		await expect(page.getByRole('status')).toHaveText('Saved here');
		await stillParked(page, 'after a Layer was renamed');

		await openLayerRow(page, 0);
		await stillParked(page, 'after a Layer was opened');

		await page.getByTestId('annotation-new').click();
		await page.getByTestId('annotation-tool-point').click();
		await clickAt(page.getByTestId('base-map-pane'), 0.5, 0.5);
		await expect(page.getByRole('status')).toHaveText('Saved here');
		await stillParked(page, 'after an Annotation was drawn');
	});
});

test('a Project opens framed on the city its Annotations are in, writing nothing, and “Frame project” re-frames there on demand', async ({
	page
}) => {
	await page.goto('/');
	await emptyWorkspace(page);
	await seed(page, workspaceFiles({ layers: [{ kind: 'annotation', id: 'l-pins' }] }));
	const before = await hashesUnder(page, '', '');

	await watchWrites(page);
	await page.goto(`/?p=${PROJECT_DIRECTORY}`);
	await settled(page);

	const at = await viewport(page);
	expect(at.lng).toBeCloseTo(BOSTON_CENTRE.lng, 3);
	expect(at.lat).toBeCloseTo(BOSTON_CENTRE.lat, 3);
	expect(Math.abs(at.lng - DEPLOYMENT_VIEW.lng)).toBeGreaterThan(50);
	expect(await showing(page, BOSTON_PINS)).toBe(true);

	expect(
		await page.evaluate(() => (window as unknown as MapWindow).ballastellaOpfsWrites ?? [])
	).toEqual([]);
	expect(
		await page.evaluate(() => (window as unknown as MapWindow).ballastellaWebStorageWrites ?? [])
	).toEqual([]);
	expect(await page.evaluate(() => ({ ...window.localStorage }))).toEqual({
		'ballastella.visited': 'yes'
	});
	expect(await hashesUnder(page, '', '')).toEqual(before);

	await parkAt(page, PARKED.lng, PARKED.lat, PARKED.zoom);

	await page.getByRole('button', { name: 'Frame project' }).click();

	await expect
		.poll(async () => (await viewport(page)).lng, { timeout: 15_000 })
		.toBeCloseTo(BOSTON_CENTRE.lng, 3);
	expect((await viewport(page)).lat).toBeCloseTo(BOSTON_CENTRE.lat, 3);

	await parkAt(page, PARKED.lng, PARKED.lat, PARKED.zoom);
	await page.getByRole('button', { name: 'Frame project' }).click();
	await expect.poll(async () => (await viewport(page)).lat).toBeCloseTo(BOSTON_CENTRE.lat, 3);

	await expect(page.getByTestId('opening-view')).toContainText('Framed on this Project');
});

async function watchWrites(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const names: string[] = [];
		(window as unknown as { ballastellaOpfsWrites?: string[] }).ballastellaOpfsWrites = names;
		const proto = FileSystemFileHandle.prototype;
		const original = proto.createWritable;
		proto.createWritable = function (
			this: FileSystemFileHandle,
			options?: FileSystemCreateWritableOptions
		) {
			names.push(this.name);
			return original.call(this, options);
		};

		const web: string[] = [];
		(window as unknown as { ballastellaWebStorageWrites?: string[] }).ballastellaWebStorageWrites =
			web;
		const storage = Storage.prototype;
		const setItem = storage.setItem;
		storage.setItem = function (this: Storage, key: string, value: string) {
			web.push(`set ${key}`);
			return setItem.call(this, key, value);
		};
		const removeItem = storage.removeItem;
		storage.removeItem = function (this: Storage, key: string) {
			web.push(`remove ${key}`);
			return removeItem.call(this, key);
		};
		const clear = storage.clear;
		storage.clear = function (this: Storage) {
			web.push('clear');
			return clear.call(this);
		};
	});
}
