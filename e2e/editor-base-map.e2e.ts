import { expect, test } from './support/test.js';
import { type Locator, type Page } from '@playwright/test';

import { start as startAlignment } from './support/alignment-workspace.js';
import { unavailableNotice } from './support/base-map-notice.js';
import {
	baseMapOptionsButton,
	borderOption,
	drawSwitch,
	openBaseMapOptions
} from './support/base-map-options.js';
import {
	baseMapTileDirectory,
	baseMapTileSourcePath,
	cachedBaseMapTiles,
	refuseBaseMapArchive,
	routeBaseMapArchive,
	routePartialBaseMapArchive
} from './support/editor-deployment';
import { AMBIGUOUS_QUERY, routePlaceLookup } from './support/places.js';
import { readStoredFile, readStoredFileOrNull, seedFile } from './support/stored-file.js';
import { HUB, emptyWorkspace } from './support/workspace.js';

type BaseMapHandle = {
	loaded(): boolean;
	isStyleLoaded(): boolean;
	getCenter(): { lng: number; lat: number };
	getZoom(): number;
	setZoom(zoom: number): void;
	jumpTo(options: { center: [number, number]; zoom: number }): void;
	getStyle(): { layers: { id: string; paint?: Record<string, unknown> }[] };
	queryRenderedFeatures(): { layer: { id: string } }[];
};

declare global {
	interface Window {
		ballastellaBaseMap?: BaseMapHandle;
		ballastellaServedBaseMapTiles?: { z: number; x: number; y: number; bytes: number }[];
		ballastellaMissedBaseMapTiles?: { z: number; x: number; y: number }[];
	}
}

const PROJECT_DIRECTORY = 'amsterdam-1625';
const PROJECT_PATH = `${PROJECT_DIRECTORY}/project.json`;
const paneUrl = (directory: string = PROJECT_DIRECTORY) => `${HUB}?p=${directory}`;

const projectJson = (fields: Record<string, unknown> = {}) =>
	JSON.stringify({
		formatVersion: 1,
		name: 'Amsterdam 1625',
		updatedAt: '2026-01-01T00:00:00.000Z',
		layers: [],
		baseMap: null,
		...fields
	});

const APPEARANCE_SWITCHES = [
	'Streets — roads, buildings and places',
	'Satellite — photographs of the ground instead of a drawn map',
	'Topography — shaded relief and contour lines',
	'High contrast — black and white, for maximum legibility'
];

const themePicker = (page: Page) => page.getByRole('button', { name: 'Theme', exact: true });

async function tabUntilFocused(page: Page, target: Locator, what: string): Promise<void> {
	for (let press = 0; press < 20; press += 1) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press('Tab');
	}
	throw new Error(`“${what}” could not be reached with the keyboard`);
}

async function tabThrough(page: Page, targets: Locator[]): Promise<void> {
	for (const target of targets) {
		await page.keyboard.press('Tab');
		await expect(target).toBeFocused();
	}
}

async function waitForLoadedMap(page: Page): Promise<void> {
	await page.waitForFunction(() => window.ballastellaBaseMap?.loaded() === true, undefined, {
		timeout: 45_000
	});
}

async function seedWorkspace(page: Page, contents?: string): Promise<void> {
	await page.goto(HUB);
	await emptyWorkspace(page);
	if (contents !== undefined) await seedFile(page, PROJECT_PATH, contents);
}

async function openPane(page: Page, contents: string = projectJson()): Promise<void> {
	await seedWorkspace(page, contents);
	await page.goto(paneUrl());
	await waitForLoadedMap(page);
}

async function workspaceEntries(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const root = await workspaceRoot();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		return names.sort();
	});
}

const renderedLayerIds = (page: Page) =>
	page.evaluate(() => {
		const map = window.ballastellaBaseMap;
		if (map === undefined) return [];
		return [...new Set(map.queryRenderedFeatures().map((feature) => feature.layer.id))];
	});

const styleLayerIds = (page: Page) =>
	page.evaluate(() => window.ballastellaBaseMap?.getStyle().layers.map((layer) => layer.id) ?? []);

const backgroundColour = (page: Page) =>
	page.evaluate(() =>
		JSON.stringify(
			window.ballastellaBaseMap?.getStyle().layers.find((layer) => layer.id === 'background')
				?.paint ?? null
		)
	);

const zoomOf = (page: Page) => page.evaluate(() => window.ballastellaBaseMap?.getZoom() ?? 0);

const centre = (page: Page) =>
	page.evaluate(() => ({
		lng: window.ballastellaBaseMap?.getCenter().lng ?? 0,
		lat: window.ballastellaBaseMap?.getCenter().lat ?? 0
	}));

const jumpTo = (page: Page, center: [number, number], zoom: number) =>
	page.evaluate(([center, zoom]) => window.ballastellaBaseMap?.jumpTo({ center, zoom }), [
		center,
		zoom
	] as const);

const drawsRoads = async (page: Page) =>
	(await renderedLayerIds(page)).some((id) => id.startsWith('roads_'));

const baseMapIsDrawn = async (page: Page): Promise<boolean> =>
	(await renderedLayerIds(page)).some((id) => id.startsWith('roads_') || id.startsWith('water'));

test.describe('the Base Map pane', () => {
	test.beforeEach(async ({ context }) => {
		await routeBaseMapArchive(context);
	});

	test('renders with zoom at the bottom-left, and pans and zooms by keyboard, drag and wheel', async ({
		page
	}) => {
		await openPane(page);

		const canvas = page.locator('canvas.maplibregl-canvas');
		await expect(canvas).toBeVisible();

		const pane = page.getByTestId('base-map-pane');
		const bottomLeft = pane.locator('.maplibregl-ctrl-bottom-left');
		await expect(bottomLeft.locator('button.maplibregl-ctrl-zoom-in')).toBeVisible();
		await expect(bottomLeft.locator('button.maplibregl-ctrl-zoom-out')).toBeVisible();
		await expect(pane.locator('.maplibregl-ctrl-top-right .maplibregl-ctrl')).toHaveCount(0);

		const search = await page.getByTestId('base-map-place-search').boundingBox();
		const options = await baseMapOptionsButton(page).boundingBox();
		const fit = await page.getByTestId('fit-to-project').boundingBox();
		const snapshot = await page.getByTestId('download-map-snapshot').boundingBox();
		const zoom = await bottomLeft.boundingBox();
		const navigation = await page.getByTestId('navigation-bar').boundingBox();
		const project = await page.getByTestId('project-screen').boundingBox();
		expect(project!.y - (navigation!.y + navigation!.height)).toBeLessThanOrEqual(1);
		expect(
			Math.abs(search!.y + search!.height / 2 - (options!.y + options!.height / 2))
		).toBeLessThan(2);
		expect(fit!.y + fit!.height).toBeLessThan(zoom!.y);
		expect(search!.y + search!.height).toBeLessThan(zoom!.y);
		expect(snapshot!.y).toBeGreaterThanOrEqual(fit!.y);
		expect(snapshot!.y + snapshot!.height).toBeLessThan(zoom!.y);

		const start = { ...(await centre(page)), zoom: await zoomOf(page) };
		await canvas.focus();
		await page.keyboard.press('ArrowRight');
		await expect.poll(async () => (await centre(page)).lng).toBeGreaterThan(start.lng);
		await page.keyboard.press('Equal');
		await expect.poll(() => zoomOf(page)).toBeGreaterThan(start.zoom);

		const box = (await canvas.boundingBox())!;
		const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		const before = { ...(await centre(page)), zoom: await zoomOf(page) };
		await page.mouse.move(middle.x, middle.y);
		await page.mouse.down();
		await page.mouse.move(middle.x, middle.y - 120, { steps: 12 });
		await page.mouse.up();
		await expect.poll(async () => (await centre(page)).lat).toBeLessThan(before.lat);
		await page.mouse.wheel(0, -400);
		await expect.poll(() => zoomOf(page)).toBeGreaterThan(before.zoom);
	});

	test('draws content-distinct maps from one static archive read over Range requests', async ({
		page
	}) => {
		const archiveRequests: { url: string; range: string | undefined }[] = [];
		page.on('request', (request) => {
			if (!request.url().includes('.pmtiles')) return;
			archiveRequests.push({ url: request.url(), range: request.headers()['range'] });
		});

		await openPane(page);

		expect(archiveRequests.length).toBeGreaterThan(0);
		for (const request of archiveRequests) {
			expect(request.url).toMatch(/\.pmtiles$/);
			expect(request.range).toMatch(/^bytes=\d+-\d+$/);
		}

		await expect.poll(() => styleLayerIds(page), { timeout: 30_000 }).toContain('water');
		await expect(page.getByTestId('base-map-unavailable')).toHaveCount(0);

		await openBaseMapOptions(page);
		await jumpTo(page, [4.9041, 52.3676], 14);
		await expect.poll(() => drawsRoads(page), { timeout: 30_000 }).toBe(true);
		await drawSwitch(page, 'Streets').click();
		await expect.poll(() => drawsRoads(page), { timeout: 30_000 }).toBe(false);
		await expect.poll(() => styleLayerIds(page)).toContain('water');

		expect(new Set(archiveRequests.map((request) => request.url)).size).toBe(1);
	});

	test('puts everything behind one button, and the satellite swaps the ground and takes high contrast away', async ({
		page
	}) => {
		await openPane(page);

		await expect(page.getByTestId('base-map-appearance')).toBeHidden();
		await expect(baseMapOptionsButton(page)).toHaveAttribute('aria-expanded', 'false');

		await openBaseMapOptions(page);

		await expect(page.getByRole('combobox', { name: 'Base Map' })).toHaveCount(0);
		const switches = page.getByTestId('base-map-appearance').getByRole('checkbox');
		await expect(switches).toHaveCount(4);
		expect(
			await switches.evaluateAll((elements) =>
				elements.map((element) => element.getAttribute('aria-label'))
			)
		).toEqual(APPEARANCE_SWITCHES);
		await expect(page.getByTestId('border-switcher').getByRole('radio')).toHaveCount(3);

		await expect.poll(() => styleLayerIds(page), { timeout: 30_000 }).toContain('earth');
		const highContrast = drawSwitch(page, 'High contrast');
		await highContrast.click();
		await expect(highContrast).toBeChecked();

		await drawSwitch(page, 'Satellite').click();

		await expect.poll(() => styleLayerIds(page), { timeout: 30_000 }).not.toContain('earth');
		const ids = await styleLayerIds(page);
		expect(ids[0]).toBe('satellite');
		expect(ids).not.toContain('landuse_park');
		expect(ids.some((id) => id.startsWith('roads_'))).toBe(true);
		expect(ids).toContain('places_locality');
		await expect(highContrast).not.toBeChecked();
		await expect(highContrast).toBeDisabled();

		await drawSwitch(page, 'Satellite').click();
		await expect(highContrast).toBeEnabled();
	});

	test('puts the switches within keyboard reach, and the high-contrast Base Map renders', async ({
		page
	}) => {
		await openPane(page);

		await expect(page.getByTestId('download-map-snapshot')).toBeEnabled({ timeout: 30_000 });

		await tabThrough(page, [
			page.getByTestId('workspace-switcher'),
			page.getByTestId('all-projects'),
			page.getByTestId('edit-project-name'),
			page.getByTestId('app-wordmark'),
			page.getByTestId('connect-to-github'),
			themePicker(page)
		]);
		await tabUntilFocused(page, page.getByTestId('place-search-query'), 'place search');
		await tabThrough(page, [
			page.getByTestId('place-search-submit'),
			baseMapOptionsButton(page),
			page.getByTestId('fit-to-project'),
			page.getByTestId('download-map-snapshot')
		]);

		await baseMapOptionsButton(page).focus();
		await page.keyboard.press('Enter');
		await expect(baseMapOptionsButton(page)).toHaveAttribute('aria-expanded', 'true');
		await tabThrough(
			page,
			(['Streets', 'Satellite', 'Topography', 'High contrast'] as const).map((label) =>
				drawSwitch(page, label)
			)
		);

		await page.keyboard.press('Space');
		await expect(drawSwitch(page, 'High contrast')).toBeChecked();
		await expect.poll(() => styleLayerIds(page), { timeout: 30_000 }).toContain('water');
		await tabThrough(page, [borderOption(page, 'all')]);
	});

	test('shows the save state, and says so when the choice could not be written', async ({
		page
	}) => {
		await openPane(page);
		const indicator = page.locator('[data-save-state]');
		await expect(indicator).toHaveAttribute('data-save-state', 'saved');

		await page.evaluate(() => {
			FileSystemWritableFileStream.prototype.close = () =>
				Promise.reject(new DOMException('Quota exceeded', 'QuotaExceededError'));
		});

		await openBaseMapOptions(page);
		await drawSwitch(page, 'Streets').click();

		await expect(indicator).toHaveAttribute('data-save-state', 'unsaved');
		await expect(indicator).toHaveText('Unsaved changes');
		expect(
			JSON.parse((await readStoredFileOrNull(page, PROJECT_PATH)) ?? '{}').baseMapAppearance
		).toBeUndefined();
	});

	test('changes the Base Map flavor in the same action as the interface theme', async ({
		page
	}) => {
		await openPane(page);

		await expect(page.locator('html')).toHaveAttribute('data-theme', 'carto-light');
		const light = await backgroundColour(page);

		await themePicker(page).click();
		await page.getByTestId('theme-option-carto-dark').click();

		await expect(page.locator('html')).toHaveAttribute('data-theme', 'carto-dark');
		await expect.poll(() => backgroundColour(page), { timeout: 30_000 }).not.toBe(light);
	});
});

const ARCHIVE = 'https://data.source.coop/protomaps/openstreetmap/v4.pmtiles';
const ARCHIVE_HOST = new URL(ARCHIVE).host;

test.describe('a Base Map archive that does not answer', () => {
	test('says so in visible text, names the host, and says the Workspace is unaffected', async ({
		page,
		context
	}) => {
		const crashes: Error[] = [];
		page.on('pageerror', (error) => crashes.push(error));
		await refuseBaseMapArchive(context);

		await seedWorkspace(page, projectJson());
		await page.goto(paneUrl());

		const notice = page.getByTestId('base-map-unavailable');
		await expect(notice).toBeVisible({ timeout: 45_000 });
		await expect(notice.locator('p')).toHaveText(unavailableNotice('Worldwide', ARCHIVE_HOST));
		await expect(notice).toHaveAttribute('role', 'alert');

		await expect(baseMapOptionsButton(page)).toBeVisible();
		expect(crashes.map((error) => error.message)).toEqual([]);
	});

	test('is taken down when the archive starts answering again', async ({ page, context }) => {
		const archive = await routePartialBaseMapArchive(context);
		await openPane(page);

		const notice = page.getByTestId('base-map-unavailable');
		await expect(notice).toBeVisible({ timeout: 45_000 });
		expect(archive.tileRangesAsked()).toBeGreaterThan(0);

		archive.serve();
		let step = 0;
		const nudgedUntil = <T>(probe: () => Promise<T>) =>
			expect.poll(
				async () => {
					await jumpTo(page, [4.9041, 52.3676], 12 + (step++ % 2));
					await page.waitForTimeout(500);
					return probe();
				},
				{ timeout: 60_000 }
			);
		await nudgedUntil(() => baseMapIsDrawn(page)).toBe(true);
		await nudgedUntil(() => notice.count()).toBe(0);
	});

	test('is withdrawn when the author redraws a Base Map it has not asked yet', async ({
		page,
		context
	}) => {
		const archive = await routePartialBaseMapArchive(context);
		await openPane(page);

		const notice = page.getByTestId('base-map-unavailable');
		await expect(notice).toBeVisible({ timeout: 45_000 });
		await expect(notice).toContainText('Worldwide');

		archive.hang();
		await openBaseMapOptions(page);
		await drawSwitch(page, 'High contrast').click();

		await expect(notice).toHaveCount(0);
		await page.waitForTimeout(3_000);
		await expect(notice).toHaveCount(0);
		await expect(drawSwitch(page, 'High contrast')).toBeChecked();
		await page.unrouteAll({ behavior: 'ignoreErrors' });
	});
});

test.describe('the Project the pane opens', () => {
	test('creates nothing, whether no Project is named or the one named does not exist', async ({
		page
	}) => {
		await seedWorkspace(page);

		await page.goto(paneUrl('never-existed'));
		await expect(page.getByRole('alert')).toContainText('never-existed');
		expect(await workspaceEntries(page)).toEqual([]);

		await page.goto(HUB);
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
		await expect(baseMapOptionsButton(page)).toHaveCount(0);
		await expect(page.getByRole('listitem')).toHaveCount(0);
		expect(await workspaceEntries(page)).toEqual([]);
	});

	const refused = [
		{
			title: 'refuses a project.json it cannot read, and does not replace it',
			contents: '{"formatVersion":1,"name":"Amsterdam 1625","layers":[],"baseMap":null,}',
			says: ['could not be read']
		},
		{
			title: 'refuses a Project from a newer version and leaves it untouched',
			contents:
				'{"formatVersion":2,"name":"Tomorrow","layers":[{"kind":"something-new"}],"baseMap":"a-fork’s-own"}',
			says: ['newer version of Ballastella', 'left untouched']
		}
	];
	for (const { title, contents, says } of refused) {
		test(title, async ({ page }) => {
			await seedWorkspace(page, contents);
			await page.goto(paneUrl());

			for (const text of says) await expect(page.getByRole('alert')).toContainText(text);
			await expect(baseMapOptionsButton(page)).toHaveCount(0);
			expect(await readStoredFileOrNull(page, PROJECT_PATH)).toBe(contents);
		});
	}
});

const CANAL_BELT_BOX = { west: 4.88, south: 52.36, east: 4.92, north: 52.38 };
const TILES = baseMapTileDirectory(ARCHIVE);

const CANAL_BELT_RING = [
	[4.88, 52.36],
	[4.92, 52.36],
	[4.92, 52.38],
	[4.88, 52.38],
	[4.88, 52.36]
];

async function seedProjectWithWork(page: Page): Promise<void> {
	await seedFile(
		page,
		PROJECT_PATH,
		projectJson({
			layers: [
				{
					kind: 'annotation',
					id: 'notes',
					name: 'Notes',
					visible: true,
					order: 0,
					geojsonRef: 'annotations/notes.geojson',
					defaultStyle: {}
				}
			]
		})
	);
	await seedFile(
		page,
		`${PROJECT_DIRECTORY}/annotations/notes.geojson`,
		JSON.stringify({
			type: 'FeatureCollection',
			features: [
				{
					type: 'Feature',
					id: 'a1',
					properties: { 'ballastella:id': 'a1', title: 'The canal belt' },
					geometry: { type: 'Polygon', coordinates: [CANAL_BELT_RING] }
				}
			]
		})
	);
}

async function cachedTilePaths(page: Page): Promise<string[]> {
	return page.evaluate(async (prefix) => {
		const walk = async (
			directory: FileSystemDirectoryHandle,
			prefix: string
		): Promise<string[]> => {
			const found: string[] = [];
			for await (const [name, handle] of directory.entries()) {
				const path = `${prefix}${name}`;
				if (handle.kind === 'directory') {
					found.push(...(await walk(handle as FileSystemDirectoryHandle, `${path}/`)));
				} else {
					found.push(path);
				}
			}
			return found;
		};
		try {
			let directory = await workspaceRoot();
			for (const segment of prefix.split('/').filter(Boolean)) {
				directory = await directory.getDirectoryHandle(segment);
			}
			return (await walk(directory, prefix)).filter((path) => path.endsWith('.mvt')).sort();
		} catch {
			return [];
		}
	}, TILES);
}

const servedTiles = (page: Page) => page.evaluate(() => window.ballastellaServedBaseMapTiles ?? []);
const missedTiles = (page: Page) => page.evaluate(() => window.ballastellaMissedBaseMapTiles ?? []);

async function openProjectScreen(page: Page): Promise<void> {
	await page.goto(paneUrl());
	await waitForLoadedMap(page);
}

async function makeAvailableOffline(page: Page): Promise<void> {
	await page.getByTestId('edit-project-name').click();
	await page.getByTestId('make-offline').click();
	await expect(page.getByTestId('offline-status')).toHaveAttribute('data-step', 'deciding');
	await page.getByTestId('offline-start').click();
	await expect(page.getByTestId('offline-done')).toContainText('Fetched', { timeout: 120_000 });
}

async function reloadWithoutArchive(page: Page): Promise<void> {
	await page.context().route(/\.pmtiles$/, (route) => route.abort());
	await page.reload();
	await waitForLoadedMap(page);
}

test.describe('what ADR-0025’s numbers were measured against', () => {
	test('a city-centre Project at every zoom is tens of tiles and a few megabytes', async () => {
		const measured = await cachedBaseMapTiles(ARCHIVE, CANAL_BELT_BOX, 14);
		expect(measured.tilesInExtent).toBe(23);
		expect(measured.tilesPresent).toBe(23);
		expect(measured.decompressedBytes).toBe(3_485_916);
		expect(measured.gzippedBytes).toBe(2_478_805);
		expect(measured.tilesInExtent).toBeLessThan(100);
	});

	test('the whole fixture extent weighs what the compression decision says it does', async () => {
		const measured = await cachedBaseMapTiles(ARCHIVE);
		expect(measured.archiveBytes).toBe(4_137_622);
		expect(measured.tilesInExtent).toBe(43);
		expect(measured.decompressedBytes).toBe(5_818_431);
		expect(measured.gzippedBytes).toBe(4_136_082);
		const overhead = measured.decompressedBytes / measured.gzippedBytes - 1;
		expect(overhead).toBeGreaterThan(0.4);
		expect(overhead).toBeLessThan(0.42);
	});
});

test.describe('making a Project available offline', () => {
	test.beforeEach(async ({ context, page }) => {
		await routeBaseMapArchive(context);
		await seedWorkspace(page);
		await seedProjectWithWork(page);
		await openProjectScreen(page);
		await makeAvailableOffline(page);
	});

	test('is not listed on the hub, and the Project draws and says it is available offline with the archive unreachable', async ({
		page
	}) => {
		const availability = page.getByTestId('offline-availability');
		await expect(availability).toHaveAttribute('data-offline', 'yes');
		expect(await readStoredFile(page, baseMapTileSourcePath(ARCHIVE))).toContain('"maxZoom":14');
		expect(await cachedTilePaths(page)).toHaveLength(23);

		await page.goto(HUB);
		await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Map Images' })).toBeVisible();
		await expect(page.getByText('Offline Base Map')).toHaveCount(0);
		await expect(page.getByTestId('clear-base-map-cache')).toHaveCount(0);
		expect(await cachedTilePaths(page)).toHaveLength(23);

		await openProjectScreen(page);
		await expect(availability).toHaveAttribute('data-offline', 'yes');

		await reloadWithoutArchive(page);

		await expect(availability).toHaveAttribute('data-offline', 'yes', { timeout: 30_000 });
		await expect(availability).toContainText('Available offline: all 23 Base Map tiles');
		await expect(availability).toContainText('because there is no connection');
		await expect(availability).toHaveAttribute('data-cache-serving', 'yes');
		await expect(page.locator('.maplibregl-ctrl-attrib')).toContainText('OpenStreetMap');

		await expect
			.poll(async () => (await servedTiles(page)).length, { timeout: 60_000 })
			.toBeGreaterThan(0);
		await expect.poll(() => baseMapIsDrawn(page), { timeout: 60_000 }).toBe(true);

		await page.evaluate(() => window.ballastellaBaseMap?.setZoom(0));
		await expect
			.poll(async () => (await servedTiles(page)).some((tile) => tile.z === 0), { timeout: 60_000 })
			.toBe(true);
		await expect.poll(() => baseMapIsDrawn(page), { timeout: 60_000 }).toBe(true);

		await jumpTo(page, [4.9, 52.37], 14);
		await expect
			.poll(async () => (await servedTiles(page)).some((tile) => tile.z === 14), {
				timeout: 60_000
			})
			.toBe(true);
		await expect.poll(() => baseMapIsDrawn(page), { timeout: 60_000 }).toBe(true);

		await jumpTo(page, [4.9, 52.37], 16);
		await expect.poll(() => baseMapIsDrawn(page), { timeout: 60_000 }).toBe(true);
		expect(
			(await missedTiles(page)).map((tile) => tile.z).filter((z) => z > 14),
			'MapLibre asked the cache for tiles deeper than the source has'
		).toEqual([]);
		expect(await zoomOf(page), 'the map did not actually reach zoom 16').toBeGreaterThan(14);
	});

	test('does not answer from a record left by a different archive', async ({ page }) => {
		await seedFile(
			page,
			baseMapTileSourcePath(ARCHIVE),
			JSON.stringify({ archive: 'https://elsewhere.test/other.pmtiles', maxZoom: 14 })
		);

		await reloadWithoutArchive(page);

		await expect(page.getByTestId('offline-availability')).toHaveAttribute(
			'data-offline',
			'unknown',
			{ timeout: 30_000 }
		);
	});
});

const MASSACHUSETTS = { lng: -72.5466223, lat: 42.11297795 };
const MISSOURI = { lng: -93.2958593, lat: 37.1828864 };
const searchField = (page: Page) => page.getByTestId('place-search-query');
const candidates = (page: Page) => page.getByTestId('place-candidate');
const searchStatus = (page: Page) => page.getByTestId('place-search-status');

async function settledStatus(page: Page): Promise<string> {
	await expect(searchStatus(page)).not.toHaveText(/^$|Looking up/);
	return (await searchStatus(page).textContent()) ?? '';
}

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
	const box = await locator.boundingBox();
	expect(box, 'the element has no box at all').not.toBeNull();
	return box as Box;
}

function expectDrawnOver(inner: Box, outer: Box): void {
	expect(inner.y, 'drawn below the map rather than over it').toBeGreaterThanOrEqual(outer.y);
	expect(inner.y + inner.height, 'reaches past the bottom of the map').toBeLessThanOrEqual(
		outer.y + outer.height
	);
	expect(inner.x).toBeGreaterThanOrEqual(outer.x);
	expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
}

const ONE_SECOND = 1_000;
let lastSubmitAt = 0;

async function findPlace(page: Page, query: string): Promise<void> {
	const since = Date.now() - lastSubmitAt;
	if (since < ONE_SECOND) await page.waitForTimeout(ONE_SECOND - since);
	await submitQuery(page, query);
}

async function submitQuery(page: Page, query: string): Promise<void> {
	await searchField(page).fill(query);
	await searchField(page).press('Enter');
	lastSubmitAt = Date.now();
}

async function outcomeFor(page: Page, query: string): Promise<string> {
	await findPlace(page, query);
	return await outcomeAbout(page, query);
}

async function outcomeAbout(page: Page, query: string): Promise<string> {
	await expect(searchStatus(page)).toContainText(query);
	return await settledStatus(page);
}

const withoutQuery = (said: string, query: string): string => said.split(query).join('…');

async function expectFramedOn(page: Page, place: { lng: number; lat: number }): Promise<void> {
	await expect
		.poll(async () => (await centre(page)).lat, { timeout: 15_000 })
		.toBeCloseTo(place.lat, 1);
	expect((await centre(page)).lng).toBeCloseTo(place.lng, 1);
}

test.describe('finding a place', () => {
	test.beforeEach(async ({ context }) => {
		lastSubmitAt = 0;
		await routeBaseMapArchive(context);
	});

	test('holds no layout open, shows the candidates matched, frames the map on the one chosen and puts the list away', async ({
		page,
		context
	}) => {
		const service = await routePlaceLookup(context);
		await openPane(page);

		expect((await centre(page)).lng).toBeCloseTo(0, 2);
		const pane = page.getByTestId('base-map-pane');
		const resting = await boxOf(pane);
		expect(resting).toEqual(await boxOf(page.getByTestId('project-map')));
		await expect(page.getByTestId('place-candidates')).toHaveCount(0);
		await expect(searchStatus(page)).toHaveText('');
		expectDrawnOver(await boxOf(searchField(page)), resting);

		await findPlace(page, AMBIGUOUS_QUERY);

		await expect(candidates(page)).toHaveCount(10);
		await expect(candidates(page).first()).toContainText('Sangamon County, Illinois');
		expect(service.queries()).toEqual([AMBIGUOUS_QUERY]);
		expect(await boxOf(pane)).toEqual(resting);
		expectDrawnOver(await boxOf(searchField(page)), resting);
		expectDrawnOver(await boxOf(candidates(page).first()), resting);

		await candidates(page).filter({ hasText: 'Hampden County' }).click();

		await expectFramedOn(page, MASSACHUSETTS);
		await expect(pane.locator('.maplibregl-marker')).toHaveCount(0);
		await expect(page.locator('[data-testid^="pane-overlay-point-"]')).toHaveCount(0);
		await expect(candidates(page)).toHaveCount(0);
		await expect(page.getByTestId('place-attribution')).toHaveCount(0);
		await expect(searchStatus(page)).toHaveText('');

		await findPlace(page, AMBIGUOUS_QUERY);
		await expect(candidates(page)).toHaveCount(10);
	});

	test('works on the alignment screen too, where the same pane is rendered', async ({
		page,
		context
	}) => {
		await routePlaceLookup(context);
		await startAlignment(page);

		await findPlace(page, AMBIGUOUS_QUERY);
		await expect(candidates(page)).toHaveCount(10);
		await candidates(page).filter({ hasText: 'Greene County' }).click();

		await expectFramedOn(page, MISSOURI);
	});

	test('issues no request at all while a query is being typed', async ({ page, context }) => {
		const service = await routePlaceLookup(context);
		await openPane(page);

		await searchField(page).pressSequentially(AMBIGUOUS_QUERY, { delay: 60 });
		await page.waitForTimeout(1_500);

		expect(service.count(), 'a request was issued while typing').toBe(0);
		await expect(candidates(page)).toHaveCount(0);

		await searchField(page).press('Enter');
		await expect(candidates(page)).toHaveCount(10);
		expect(service.count()).toBe(1);
	});

	test('announces four distinct outcomes, attributes only shown candidates, and refuses a second search inside a second', async ({
		page,
		context
	}) => {
		const attribution = page.getByTestId('place-attribution');
		const service = await routePlaceLookup(context);
		await openPane(page);

		await expect(searchStatus(page)).toHaveAttribute('aria-live', 'polite');
		await expect(searchStatus(page)).toHaveAttribute('aria-atomic', 'true');
		await expect(searchStatus(page)).not.toHaveAttribute('role', 'status');
		await expect(attribution).toHaveCount(0);

		const found = await outcomeFor(page, AMBIGUOUS_QUERY);
		expect(found).toContain('10 places match');
		await expect(attribution).toBeVisible();
		await expect(attribution).toContainText('OpenStreetMap contributors');

		service.answerWith('[]');
		const matchedNothing = await outcomeFor(page, 'Nowhere at all');
		expect(matchedNothing).toContain('spelling');
		await expect(candidates(page)).toHaveCount(0);
		await expect(attribution).toHaveCount(0);

		service.answerWith('', 503);
		const unanswered = await outcomeFor(page, 'Leiden');
		expect(unanswered).toContain('could not be looked up');

		service.answerWith('{"error":"unknown parameter"}');
		const unreadable = await outcomeFor(page, 'Utrecht');
		expect(withoutQuery(unreadable, 'Utrecht')).toBe(withoutQuery(unanswered, 'Leiden'));

		service.answerWith('', 429);
		const tooFast = await outcomeFor(page, 'Delft');
		expect(tooFast).toContain('wait a moment and search again');

		const said = [found, matchedNothing, unanswered, tooFast].map((text, index) =>
			withoutQuery(text, [AMBIGUOUS_QUERY, 'Nowhere at all', 'Leiden', 'Delft'][index]!)
		);
		expect(new Set(said).size).toBe(4);
		await expect(searchStatus(page)).toBeVisible();
		await expect(candidates(page)).toHaveCount(0);

		await service.answerFromFixture();
		const before = service.count();
		await findPlace(page, 'Boston');
		await submitQuery(page, 'Cambridge');
		const refusedHere = await outcomeAbout(page, 'Cambridge');
		expect(withoutQuery(refusedHere, 'Cambridge')).toBe(withoutQuery(tooFast, 'Delft'));
		expect(service.count() - before, 'the refused search still went out').toBe(1);
		await expect(candidates(page)).toHaveCount(0);

		await findPlace(page, 'Cambridge');
		await expect(candidates(page)).toHaveCount(10);
	});

	test('never says whose fault it is when the browser reports no connection, and stays enabled', async ({
		page,
		context
	}) => {
		const service = await routePlaceLookup(context);
		await openPane(page);

		service.answerWith('', 503);
		const connected = await outcomeFor(page, 'Leiden');
		expect(connected).toContain('usually the lookup service');

		await context.setOffline(true);

		await expect(page.getByTestId('base-map-offline')).toBeVisible();

		await expect(searchField(page)).toBeEnabled();
		await expect(searchField(page)).toBeEditable();
		await expect(page.getByTestId('place-search-submit')).toBeEnabled();

		const cut = await outcomeFor(page, 'Utrecht');
		expect(cut).not.toContain('usually the lookup service');
		expect(cut).not.toMatch(/offline|your connection|your wi-?fi|your internet/i);
		await expect(searchStatus(page)).toBeVisible();
		expect(cut).toContain('Nothing in your Workspace is affected');
	});

	test('reaches and chooses every candidate from the keyboard alone', async ({ page, context }) => {
		await routePlaceLookup(context);
		await openPane(page);

		await searchField(page).focus();
		await page.keyboard.type(AMBIGUOUS_QUERY);
		await page.keyboard.press('Enter');
		await expect(candidates(page)).toHaveCount(10);
		const total = await candidates(page).count();

		await tabThrough(page, [
			page.getByTestId('place-search-submit'),
			...Array.from({ length: total }, (_, index) => candidates(page).nth(index))
		]);

		const wanted = 2;
		for (let index = total - 1; index > wanted; index -= 1) {
			await page.keyboard.press('Shift+Tab');
		}
		await expect(candidates(page).nth(wanted)).toContainText('Greene County');
		await expect(candidates(page).nth(wanted)).toBeFocused();
		await page.keyboard.press('Enter');

		await expectFramedOn(page, MISSOURI);
	});
});
