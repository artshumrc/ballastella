import { expect, test as base } from './support/test.js';

import { type Page } from '@playwright/test';

import {
	baseMapArchiveFixture,
	byteRange,
	deployEditor,
	deployEditors,
	NEXT_VERSION_MARKER,
	refuseBaseMapArchive,
	routeBaseMapArchive,
	type EditorDeployment
} from './support/editor-deployment';
import { baseMapOptionsButton } from './support/base-map-options.js';
import { alignFromLayer, openLayerRow } from './support/layers';
import {
	addMapImageButton,
	expectNothingPreparing,
	pickMapImageFile
} from './support/map-images.js';
import {
	gradientPng,
	mapImage,
	expectWarpedLayerAdded,
	imagePoints,
	IMAGE_HEIGHT,
	IMAGE_WIDTH,
	makePair,
	rows,
	storedAlignment,
	warpedTiles,
	waitForStored
} from './support/alignment-workspace';
import {
	annotationLayerId,
	centreOnAmsterdam,
	chooseTool,
	readProjectFile,
	storedAnnotations,
	waitForStack,
	writeProjectFile,
	PROJECT_NAME,
	baseMap,
	clickAt
} from './support/annotations';
import { seedMapLayer } from './support/project-screen';
import { waitForStoredLayers } from './support/saved';
import { emptyWorkspace } from './support/workspace.js';

const test = base.extend<{ prefix: string; site: EditorDeployment }>({
	prefix: ['', { option: true }],
	site: async ({ prefix }, use) => {
		const site = await deployEditor(prefix);
		await use(site);
		await site.close();
	}
});

const INSTALL_MS = 30_000;
const TILES_READY_MS = 30_000;

const deployments: { name: string; prefix: string }[] = [
	{ name: 'a domain root', prefix: '' },
	{ name: 'a project subdirectory', prefix: '/teaching/ballastella' }
];

const waitForReady = (page: Page) =>
	page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

async function installAndControl(page: Page, url: string): Promise<void> {
	await page.goto(url);
	await waitForReady(page);
	await page.reload();
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
		timeout: INSTALL_MS
	});
}

async function installIntoEmptyWorkspace(page: Page, url: string): Promise<void> {
	await installAndControl(page, url);
	await emptyWorkspace(page);
	await page.reload();
}

const pageErrors = (page: Page): string[] => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`));
	return errors;
};

const registrationState = (page: Page) =>
	page.evaluate(async () => {
		const registration = await navigator.serviceWorker.getRegistration();
		return {
			scope: registration?.scope ?? null,
			active: registration?.active?.state ?? null,
			waiting: registration?.waiting?.state ?? null,
			controller: navigator.serviceWorker.controller?.scriptURL ?? null
		};
	});

const cachedUrls = (page: Page) =>
	page.evaluate(async () => {
		const found: Record<string, string[]> = {};
		for (const name of await caches.keys()) {
			const cache = await caches.open(name);
			found[name] = (await cache.keys()).map((request) => request.url).sort();
		}
		return found;
	});

const cacheNames = (page: Page) => page.evaluate(() => caches.keys());

const requestsExceptUpdateChecks = (asked: readonly string[]) =>
	asked.filter((path) => !path.endsWith('/service-worker.js'));

const expectEditorHome = (page: Page) =>
	expect(page.getByRole('heading', { name: 'Ballastella Editor' })).toBeVisible();

const expectTilesLoaded = (page: Page) =>
	expect(page.getByTestId('map-image-tiles')).toHaveAttribute('data-tiles-loaded', 'true', {
		timeout: TILES_READY_MS
	});

async function createProject(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'New Project' }).click();
	const dialog = page.getByRole('dialog', { name: 'New Project' });
	await dialog.getByLabel('Project name').fill(PROJECT_NAME);
	await dialog.getByRole('button', { name: 'Create' }).click();
}

const pickLaFloride = (page: Page) =>
	pickMapImageFile(page, {
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(IMAGE_WIDTH, IMAGE_HEIGHT)
	});

/**
 * A Project with one locally ingested Map Image, both panes live, at whatever URL the page is
 * already on.
 *
 * `support/alignment-workspace.ts`'s `start` cannot be used: it navigates to the Playwright
 * `baseURL`, and every test here is driven against a server of its own at a path of its own. The
 * steps are the same and are a user's.
 *
 * @returns the image id, which is the Alignment's file name
 */
async function startProjectWithMap(page: Page): Promise<string> {
	await createProject(page);
	await expect(addMapImageButton(page)).toBeVisible();

	await pickLaFloride(page);
	const addedRow = page.getByTestId('layer-row').first();
	await expect(addedRow).toBeVisible({ timeout: 30_000 });
	await expectNothingPreparing(page, 30_000);
	await waitForStoredLayers(page, 1);
	return (await addedRow.getAttribute('data-image-id'))!;
}

const LIBRARY = 'gallica.example.test';
const REFERENCED_ID = 'btv1b8592433v';
const SERVICE = `https://${LIBRARY}/iiif/3/${REFERENCED_ID}`;
const REFERENCED_WIDTH = 700;
const REFERENCED_HEIGHT = 500;

const layerRowFor = (page: Page, imageId: string) =>
	page.locator(`[data-testid="layer-row"][data-image-id="${imageId}"]`);

const alignLayerFor = (page: Page, imageId: string) =>
	alignFromLayer(page, layerRowFor(page, imageId));

async function seedReferencedMapImage(page: Page): Promise<void> {
	await writeProjectFile(
		page,
		`images/${REFERENCED_ID}/remote.json`,
		JSON.stringify({
			service: SERVICE,
			label: 'Carte de la Floride',
			width: REFERENCED_WIDTH,
			height: REFERENCED_HEIGHT
		}),
		''
	);
	await seedMapLayer(page, REFERENCED_ID, 'Carte de la Floride');
	await page.reload();
}

const expectReferencedHost = async (page: Page) =>
	expect(
		(await openLayerRow(page, layerRowFor(page, REFERENCED_ID))).getByTestId(
			'referenced-image-host'
		)
	).toHaveText(LIBRARY);

const focusedDescription = (page: Page) =>
	page.evaluate(() => {
		const element = document.activeElement;
		if (!element) return 'nothing';
		return `${element.tagName}#${element.id}.${element.className}[${element.getAttribute('data-testid') ?? ''}]`;
	});

async function manifest(page: Page): Promise<{ url: string; document: Record<string, string> }> {
	const url = await page.evaluate(() => {
		const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
		return link?.href ?? null;
	});
	expect(url, 'the page links to no web app manifest').not.toBeNull();
	const response = await page.request.get(url as string);
	expect(response.status(), `the manifest at ${url} was not served`).toBe(200);
	return { url: url as string, document: await response.json() };
}

const markAlive = (page: Page) =>
	page.evaluate(() => {
		(window as unknown as { ballastellaAlive?: string }).ballastellaAlive = 'the same document';
	});

const alive = (page: Page) =>
	page.evaluate(() => (window as unknown as { ballastellaAlive?: string }).ballastellaAlive);

test.describe('the web app manifest and the service worker scope', () => {
	for (const { name, prefix } of deployments) {
		test.describe(`served at ${name}`, () => {
			test.use({ prefix });

			test('installs from its manifest, scoped and precached to this deployment, and runs offline', async ({
				page,
				context,
				site
			}) => {
				const errors = pageErrors(page);
				await installAndControl(page, site.url);
				const { url, document } = await manifest(page);

				expect(document['name']).toBe('Ballastella');
				expect(document['short_name']).toBe('Ballastella');
				expect(document['display']).toBe('standalone');
				expect(new URL(document['start_url'] as string, url).href).toBe(site.url);
				expect(new URL(document['scope'] as string, url).href).toBe(site.url);
				const icons = (document as unknown as { icons: { src: string; sizes: string }[] }).icons;
				expect(icons.length).toBeGreaterThan(0);
				for (const icon of icons) {
					const resolved = new URL(icon.src, url).href;
					expect(resolved.startsWith(site.url), `${icon.src} escapes ${site.url}`).toBe(true);
					const response = await page.request.get(resolved);
					expect(response.status(), `${resolved} was not served`).toBe(200);
				}
				const sizes = icons.flatMap((icon) => icon.sizes.split(/\s+/));
				expect(sizes.some((size) => size === '192x192' || size === '512x512')).toBe(true);
				const session = await page.context().newCDPSession(page);
				const appManifest = await session.send('Page.getAppManifest');
				expect(
					appManifest.errors.filter((error) => error.critical !== 0),
					'the browser rejected the manifest'
				).toEqual([]);
				expect(appManifest.url).toBe(url);

				const state = await registrationState(page);
				expect(state.scope).toBe(site.url);
				expect(state.controller).toBe(`${site.url}service-worker.js`);
				expect(state.active).toBe('activated');

				const caches = await cachedUrls(page);
				const names = Object.keys(caches).sort();
				expect(names).toHaveLength(2);
				expect(names[0]).toMatch(/^ballastella-base-map-/);
				expect(names[1]).toMatch(/^ballastella-shell-/);
				const inside = `${new URL(site.url).origin}${prefix}/`;
				const pathsOf = (name: string) =>
					(caches[name] as string[]).map((url) => {
						expect(url.startsWith(inside), `${url} is outside ${inside}`).toBe(true);
						return new URL(url).pathname.slice(prefix.length);
					});

				const shell = pathsOf(names[1] as string);
				const entryHtml = ['/', '/align', '/image-pane'];
				expect(shell.length, 'nothing was precached').toBeGreaterThan(10);
				for (const path of shell) {
					expect(
						path.startsWith('/_app/') || entryHtml.includes(path),
						`${path} is not a hashed build asset and not an entry page`
					).toBe(true);
				}
				for (const route of entryHtml) {
					expect(shell, `${route} is an entry route and must work offline`).toContain(route);
				}

				const bundled = pathsOf(names[0] as string);
				expect(bundled.length, 'Base Map display assets were not precached').toBeGreaterThan(3);
				for (const path of bundled) {
					expect(path.startsWith('/base-map/'), `${path} is not a Base Map file`).toBe(true);
					expect(path, 'a PMTiles archive shipped in the installed app').not.toMatch(/\.pmtiles$/);
				}

				for (const path of [...shell, ...bundled]) {
					expect(path, 'the staged viewer bundle must never be cached').not.toContain(
						'/viewer-bundle/'
					);
					expect(path, 'no WebAssembly module may be precached (ADR-0019, ADR-0027)').not.toMatch(
						/\.wasm$/
					);
					expect(path, 'test fixtures must never be cached').not.toContain('/fixtures/');
				}

				const startUrl = new URL(document['start_url'] as string, url).href;

				await context.setOffline(true);
				const asked = site.requests.length;

				await page.goto(startUrl);
				await expectEditorHome(page);

				await page.goto(`${site.url}align?p=nothing-here&layer=none`);
				await expect(page.getByRole('heading', { level: 1, name: /^Align(?::|$)/ })).toBeVisible();

				await page.getByRole('link', { name: 'Back to all Projects' }).click();
				await expectEditorHome(page);
				await expect(page.getByRole('button', { name: 'New Project' })).toBeVisible();

				await page.goto(`${site.url}align/?p=nothing-here&layer=none`);
				await expect(page).toHaveURL(`${site.url}align?p=nothing-here&layer=none`);
				await expect(page.getByRole('heading', { level: 1, name: /^Align(?::|$)/ })).toBeVisible();

				expect(
					requestsExceptUpdateChecks(site.requests.slice(asked)),
					'the browser reached the server while it was supposed to be offline'
				).toEqual([]);

				expect(errors, 'the app threw while running offline').toEqual([]);
			});
		});
	}
});

test.describe('two deployments of this app on one origin', () => {
	test('do not delete each other’s offline shell', async ({ page, context }) => {
		const [first, second] = await deployEditors('/teaching/ballastella', '/research/ballastella');
		try {
			await installAndControl(page, first.url);
			await installAndControl(page, second.url);

			expect(
				await cacheNames(page),
				'a deployment’s caches were swept away by its neighbour'
			).toHaveLength(4);

			await context.setOffline(true);
			await page.goto(first.url);
			await expectEditorHome(page);
			await page.goto(second.url);
			await expectEditorHome(page);
		} finally {
			await first.close();
		}
	});
});

test.describe('the app with the network off', () => {
	test.beforeEach(({ context }) => refuseBaseMapArchive(context));

	test('a new Project explains the absent Base Map and still accepts a Map Image file', async ({
		page,
		context,
		site
	}) => {
		const errors = pageErrors(page);

		await installAndControl(page, site.url);
		await emptyWorkspace(page);
		await context.setOffline(true);
		const asked = site.requests.length;
		await createProject(page);

		const notice = page.getByTestId('base-map-offline');
		await expect(notice).toBeVisible();
		await expect(notice).toContainText('no network connection');
		await expect(notice).toContainText('Base Map');
		await expect(notice).toContainText('Map Image');

		await pickLaFloride(page);
		await expect(page.getByTestId('layer-row')).toHaveCount(1, { timeout: 30_000 });

		expect(
			requestsExceptUpdateChecks(site.requests.slice(asked)),
			'the browser reached the server during the offline session'
		).toEqual([]);
		expect(errors, 'the app threw during the offline session').toEqual([]);
	});

	test('a Project with a local Map Image is fully usable with the network off', async ({
		page,
		context,
		site
	}) => {
		const errors = pageErrors(page);
		const complaints: string[] = [];
		page.on('console', (message) => {
			if (message.text().includes('base-map/')) complaints.push(message.text());
		});

		await installAndControl(page, site.url);
		const precached = await cachedUrls(page);
		await emptyWorkspace(page);
		await page.reload();

		const imageId = await startProjectWithMap(page);

		await context.setOffline(true);
		const asked = site.requests.length;
		complaints.length = 0;

		await page.reload();
		await expect(addMapImageButton(page)).toBeVisible();

		await alignFromLayer(page);
		await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);

		await expect(page.getByTestId('image-pane')).toBeVisible();
		await expectTilesLoaded(page);
		await expect(page.getByTestId('pairing-status')).toContainText('first Control Point');

		await makePair(page, [0.3, 0.3]);
		await makePair(page, [0.6, 0.35]);
		await makePair(page, [0.45, 0.7]);
		await expect(rows(page)).toHaveCount(3);
		await expect(imagePoints(page)).toHaveText(['1', '2', '3']);

		await waitForStored(page, imageId, 3);
		const written = await storedAlignment(page, imageId);
		expect(written, 'no Alignment was written while offline').not.toBeNull();
		expect(JSON.parse(written as string).body.features).toHaveLength(3);

		await clickAt(mapImage(page), 0.8, 0.2);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
		await clickAt(baseMap(page), 0.8, 0.2);
		await waitForStored(page, imageId, 4);

		await expectWarpedLayerAdded(page);
		expect(
			await warpedTiles(page),
			'the aligned Map Image did not render over the Base Map offline'
		).toBeGreaterThan(0);

		await page.getByTestId('back-to-project').click();
		await expect(addMapImageButton(page)).toBeVisible();
		await expect(page.getByTestId('layer-sidebar')).toBeVisible();
		await page.getByTestId('add-annotation-layer').click();
		await waitForStack(page);
		await centreOnAmsterdam(page);
		const layerId = await annotationLayerId(page);

		await openLayerRow(page, 0);
		await chooseTool(page, 'point');
		await clickAt(baseMap(page), 0.5, 0.5);
		await expect.poll(async () => (await storedAnnotations(page, layerId)).features.length).toBe(1);
		const drawn = await storedAnnotations(page, layerId);
		expect(drawn.features[0]?.geometry?.type, 'the Annotation reached the disk offline').toBe(
			'Point'
		);

		expect(
			requestsExceptUpdateChecks(site.requests.slice(asked)),
			'the browser reached the server during the offline session'
		).toEqual([]);
		const fromCacheOffline = (path: string) =>
			page.evaluate(
				(url) =>
					fetch(url).then(
						(response) => response.status,
						() => 0
					),
				new URL(path, site.url).href
			);
		expect(
			await fromCacheOffline('base-map/fonts/Noto Sans Regular/0-255.pbf'),
			'a glyph range was not served from the cache offline'
		).toBe(200);
		expect(
			await fromCacheOffline('base-map/sprites/light.json'),
			'a sprite sheet was not served from the cache offline'
		).toBe(200);
		expect(complaints, 'a Base Map file was not served from the cache').toEqual([]);
		expect(errors, 'the app threw during the offline session').toEqual([]);

		expect(await cachedUrls(page), 'the working session added something to a cache').toEqual(
			precached
		);
	});
});

test.describe('a working session that reaches other people’s servers', () => {
	test('reads a referenced Map Image and a Base Map that needs the network, and caches neither', async ({
		page,
		context,
		site
	}) => {
		const errors = pageErrors(page);

		const here = new URL(site.url).origin;
		const archive = await baseMapArchiveFixture();
		let libraryRequests = 0;
		let remoteArchiveRequests = 0;

		await context.route(
			(url) =>
				url.origin !== here && (url.hostname === LIBRARY || url.pathname.endsWith('.pmtiles')),
			async (route) => {
				const url = new URL(route.request().url());
				const cors = { 'access-control-allow-origin': '*' };

				if (url.pathname.endsWith('.pmtiles')) {
					remoteArchiveRequests += 1;
					const served = byteRange(
						archive,
						route.request().headers()['range'],
						'application/octet-stream'
					);
					return route.fulfill({
						status: served.status,
						headers: { ...served.headers, ...cors },
						body: served.body
					});
				}

				libraryRequests += 1;
				if (url.pathname.endsWith('/info.json')) {
					return route.fulfill({
						status: 200,
						contentType: 'application/json',
						headers: cors,
						body: JSON.stringify({
							'@context': 'http://iiif.io/api/image/3/context.json',
							id: SERVICE,
							type: 'ImageService3',
							protocol: 'http://iiif.io/api/image',
							profile: 'level2',
							width: REFERENCED_WIDTH,
							height: REFERENCED_HEIGHT,
							tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4] }]
						})
					});
				}
				const tile = /\/\d+,\d+,\d+,\d+\/(\d+),(\d+)\/0\/default\.(jpg|png)$/.exec(url.pathname);
				if (!tile) return route.fulfill({ status: 404, headers: cors, body: 'no such tile' });
				return route.fulfill({
					status: 200,
					contentType: 'image/png',
					headers: cors,
					body: gradientPng(Number(tile[1]), Number(tile[2]))
				});
			}
		);

		await installAndControl(page, site.url);
		const precached = await cachedUrls(page);
		await emptyWorkspace(page);
		await page.reload();

		const imageId = await startProjectWithMap(page);
		const project = new URL(page.url()).searchParams.get('p');
		expect(project, 'a Project is addressed by ?p= (ADR-0008)').not.toBeNull();

		await seedReferencedMapImage(page);
		await expectReferencedHost(page);

		await alignLayerFor(page, REFERENCED_ID);
		await expectTilesLoaded(page);
		await expect.poll(() => libraryRequests, { timeout: TILES_READY_MS }).toBeGreaterThan(1);

		await page.goto(`${site.url}?p=${project}`);
		await alignLayerFor(page, imageId);
		await expectTilesLoaded(page);
		await makePair(page, [0.4, 0.4]);
		await waitForStored(page, imageId, 1);

		await page.goto(`${site.url}?p=${project}`);
		await expect(baseMapOptionsButton(page)).toBeVisible();
		await expect.poll(() => remoteArchiveRequests, { timeout: TILES_READY_MS }).toBeGreaterThan(0);

		expect(await cachedUrls(page), 'the session added something to a cache').toEqual(precached);
		expect(errors, 'the app threw during the session').toEqual([]);
	});
});

test.describe('what offline cannot fix, and what it must not break', () => {
	test.beforeEach(({ context }) => routeBaseMapArchive(context));

	test('a referenced Map Image says so and breaks nothing, and the worker never serves the ProjectStore', async ({
		page,
		context,
		site
	}) => {
		const errors = pageErrors(page);
		const storeFile = `${site.url}amsterdam-1625/project.json`;

		await installIntoEmptyWorkspace(page, site.url);
		const imageId = await startProjectWithMap(page);

		const status = await page.evaluate((url) => fetch(url).then((r) => r.status), storeFile);
		expect(status, 'something answered a store path over HTTP').toBe(404);

		await seedReferencedMapImage(page);
		await expectReferencedHost(page);
		await expect(page.getByTestId('referenced-offline')).toBeHidden();

		await context.setOffline(true);

		const notice = page.getByTestId('referenced-offline');
		await expect(notice).toBeVisible();
		await expect(notice).toContainText(LIBRARY);
		await expect(notice).toHaveAttribute('role', 'alert');

		const offline = await page.evaluate(
			(url) =>
				fetch(url).then(
					() => 'answered',
					() => 'refused'
				),
			storeFile
		);
		expect(offline, 'the worker answered a store path from a cache').toBe('refused');
		expect(JSON.parse(await readProjectFile(page, 'project.json')).name).toBe(PROJECT_NAME);

		await page.reload();
		await expect(addMapImageButton(page)).toBeVisible();
		await expectReferencedHost(page);
		await alignLayerFor(page, imageId);
		await expectTilesLoaded(page);
		await makePair(page, [0.35, 0.35]);
		await waitForStored(page, imageId, 1);
		expect(errors, 'an unreachable referenced host must not throw').toEqual([]);
	});
});

test.describe('an update, and who decides when', () => {
	test.beforeEach(({ context }) => routeBaseMapArchive(context));

	async function syncAndCheck(page: Page, site: EditorDeployment): Promise<void> {
		site.deployNewVersion();
		await page.evaluate(async () => {
			const registration = await navigator.serviceWorker.getRegistration();
			await registration?.update();
		});
	}

	async function discoverUpdate(page: Page, site: EditorDeployment): Promise<void> {
		await syncAndCheck(page, site);
		await page.waitForFunction(
			async () => (await navigator.serviceWorker.getRegistration())?.waiting !== null,
			undefined,
			{ timeout: INSTALL_MS }
		);
	}

	test('the prompt appears, nothing reloads, and the alignment in progress is untouched', async ({
		page,
		site
	}) => {
		const errors = pageErrors(page);

		await installIntoEmptyWorkspace(page, site.url);
		await startProjectWithMap(page);
		await alignFromLayer(page);
		await expectTilesLoaded(page);
		await makePair(page, [0.3, 0.3]);
		await makePair(page, [0.6, 0.35]);
		await clickAt(mapImage(page), 0.75, 0.6);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');

		await markAlive(page);
		const controllerBefore = (await registrationState(page)).controller;
		const focusBefore = await focusedDescription(page);

		await discoverUpdate(page, site);

		await expect(page.getByTestId('update-prompt')).toBeVisible();
		await expect(page.getByTestId('update-prompt')).toContainText('new version');
		const region = page.getByTestId('update-region');
		await expect(region).toHaveAttribute('aria-live', 'polite');
		await expect(region).toHaveAttribute('aria-atomic', 'true');

		expect(await alive(page), 'the page reloaded itself when an update arrived').toBe(
			'the same document'
		);
		await expect(rows(page)).toHaveCount(2);
		await expect(imagePoints(page)).toHaveCount(3);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
		expect(await focusedDescription(page), 'the update prompt took focus').toBe(focusBefore);
		const state = await registrationState(page);
		expect(state.waiting).toBe('installed');
		expect(state.active).toBe('activated');
		expect(state.controller).toBe(controllerBefore);
		expect(errors, 'the app threw while an update was announced').toEqual([]);
	});

	test('the prompt is dismissed by keyboard, does not come back, and leaves the old version serving', async ({
		page,
		site
	}) => {
		await installAndControl(page, site.url);
		const before = (await cacheNames(page)).sort();
		expect(before).toHaveLength(2);

		await discoverUpdate(page, site);
		const prompt = page.getByTestId('update-prompt');
		await expect(prompt).toBeVisible();

		const dismiss = page.getByTestId('update-dismiss');
		const reload = page.getByTestId('update-reload');
		await expect(dismiss).toHaveAccessibleName('Not now');
		await expect(reload).toHaveAccessibleName('Reload now');
		await expect(prompt).toHaveAccessibleName(/new version of Ballastella is ready/);

		await reload.focus();
		await expect(reload).toBeFocused();
		await dismiss.focus();
		await expect(dismiss).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(prompt).toBeHidden();

		await page.evaluate(async () => {
			const registration = await navigator.serviceWorker.getRegistration();
			await registration?.update();
		});
		await page.waitForTimeout(500);
		await expect(prompt).toBeHidden();

		await page.reload();
		await expectEditorHome(page);
		expect(
			await page.locator(`meta[name="${NEXT_VERSION_MARKER}"]`).count(),
			'the new version took over without being asked'
		).toBe(0);

		const after = (await cacheNames(page)).sort();
		expect(after).toHaveLength(4);
		for (const name of before)
			expect(after, `${name} was deleted under the old worker`).toContain(name);
		const shell = await cachedUrls(page);
		expect(shell[before[0] as string]?.length, 'the old build’s cache was emptied').toBeGreaterThan(
			0
		);
		const state = await registrationState(page);
		expect(state.waiting, 'a plain reload must not activate a waiting worker').toBe('installed');
	});

	test('taking the update is what applies it, and only when asked', async ({ page, site }) => {
		await installAndControl(page, site.url);
		await discoverUpdate(page, site);

		await page.getByTestId('update-reload').click();

		await expect(page.locator(`meta[name="${NEXT_VERSION_MARKER}"]`)).toHaveCount(1, {
			timeout: INSTALL_MS
		});
		await expectEditorHome(page);
		await expect(page.getByTestId('update-prompt')).toBeHidden();

		await expect.poll(() => cacheNames(page), { timeout: INSTALL_MS }).toHaveLength(2);
	});

	test('a version deployed to a page that no worker controls is still announced', async ({
		page,
		site
	}) => {
		await page.goto(site.url);
		await waitForReady(page);
		expect(
			await page.evaluate(() => navigator.serviceWorker.controller === null),
			'this page is already controlled, so it is not the case under test'
		).toBe(true);

		await syncAndCheck(page, site);

		await expect(page.getByTestId('update-prompt')).toBeVisible({ timeout: INSTALL_MS });
		await expect(page.getByTestId('update-prompt')).toContainText('new version');

		await page.getByTestId('update-reload').click();
		await expect(page.locator(`meta[name="${NEXT_VERSION_MARKER}"]`)).toHaveCount(1, {
			timeout: INSTALL_MS
		});
		await expectEditorHome(page);
	});

	test('an update the deployment cannot answer for is refused, and the offline shell survives', async ({
		page,
		site
	}) => {
		await installAndControl(page, site.url);
		await discoverUpdate(page, site);
		await expect(page.getByTestId('update-prompt')).toBeVisible();

		await markAlive(page);

		await site.stopServing();
		await page.getByTestId('update-reload').click();

		await expect(page.getByTestId('update-unreachable')).toBeVisible();
		await expect(page.getByTestId('update-prompt')).toBeVisible();
		expect(
			await alive(page),
			'the page was reloaded into a deployment that could not answer it'
		).toBe('the same document');

		await page.reload();
		await expectEditorHome(page);
		await expect(page.getByRole('button', { name: 'New Project' })).toBeVisible();
	});
});
