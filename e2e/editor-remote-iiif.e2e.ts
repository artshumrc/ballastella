import { expect, test, type Locator, type Page } from './support/test.js';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IMAGE_HEIGHT, IMAGE_WIDTH, gradientPng } from './support/alignment-workspace.js';
import { createProject } from './support/annotations.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	communityAnnotation,
	generateId,
	installIiifHosts,
	routeCommunityAnnotations,
	service
} from './support/iiif-hosts.js';
import { deleteLayerRow, layerRows, openLayerRow } from './support/layers.js';
import { addMapImageIsOpen, ensureAddMapImageOpen } from './support/map-images.js';
import { readJson, readStoredFile, readStoredFileOrNull, seedFile } from './support/stored-file.js';
import { emptyWorkspace } from './support/workspace.js';

test.beforeEach(async ({ page }) => {
	await routeBaseMapArchive(page);
	await page.goto('/');
	await emptyWorkspace(page);
	await page.reload();
});

const MANIFEST = 'https://library.test/iiif/atlas/manifest.json';
const FLORIDA = service('images.test', 'florida');
const FLORIDA_ID = generateId(FLORIDA);
const ALIGNMENT = `alignments/${FLORIDA_ID}.json`;
const PROJECT = 'amsterdam-1625/project.json';

const projectLayers = async (page: Page, file = PROJECT) =>
	JSON.parse(await readStoredFile(page, file)).layers;

async function start(page: Page, communityAnnotations?: unknown[]): Promise<void> {
	await installIiifHosts(page, { communityAnnotations });
	await openNewProject(page);
}

async function openNewProject(page: Page, name = 'Amsterdam 1625'): Promise<void> {
	await createProject(page, name);
	await page.getByRole('link', { name }).click();
	await expect(page.getByTestId('project-screen')).toBeVisible();
}

/**
 * Wait until a referenced Map Image has landed on the Project screen, and leave its Layer open.
 *
 * The library a referenced map's tiles come from is *inside* the Layer that fetches them, so seeing
 * it is opening the row. That makes this the wait as well as the assertion: the row
 * appears when the map has been added, and the host appears when the Workspace's `remote.json` for it
 * has been read.
 */
async function expectReferencedMap(page: Page, at: number | Locator = 0): Promise<Locator> {
	const row = await openLayerRow(page, at);
	await expect(row.getByTestId('referenced-image-host')).toBeVisible();
	return row;
}

async function lookUp(page: Page, url: string): Promise<void> {
	await ensureAddMapImageOpen(page);
	await page.getByTestId('remote-url').fill(url);
	await page.getByTestId('remote-read').click();
}

async function chooseFlorida(page: Page): Promise<void> {
	await lookUp(page, MANIFEST);
	await page.getByTestId('remote-canvas').nth(1).click();
	await expect(page.getByTestId('remote-add')).toBeVisible();
}

async function addChosen(page: Page): Promise<Locator> {
	await page.getByTestId('remote-add').click();
	const row = await expectReferencedMap(page);
	await expect(page.getByRole('status')).toHaveText('Saved here');
	return row;
}

async function addFlorida(page: Page, offer?: string | null): Promise<Locator> {
	await chooseFlorida(page);
	if (offer === null) await expect(page.getByTestId('community-offer')).toHaveCount(0);
	else if (offer) await expect(page.getByTestId('community-offer')).toContainText(offer);
	return addChosen(page);
}

async function deleteTheLayer(page: Page): Promise<void> {
	await page.goto('/?p=amsterdam-1625');
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	await deleteLayerRow(page);
	await expect(layerRows(page)).toHaveCount(0);
	await expect(page.getByRole('status')).toHaveText('Saved here');
}

test.describe('adding a Map Image from a IIIF URL', () => {
	test('accepts a Manifest, a Collection, and a bare image service, and browses each', async ({
		page
	}) => {
		await start(page);

		await lookUp(page, MANIFEST);
		await expect(page.getByTestId('remote-label')).toHaveText(
			'A Sea Atlas of the Western Approaches'
		);
		await expect(page.getByTestId('remote-canvas')).toHaveCount(3);
		await expect(page.getByTestId('remote-canvas').nth(1)).toHaveText(/Chart of the Florida coast/);
		await expect(page.getByTestId('remote-rights')).toContainText(
			'creativecommons.org/licenses/by/4.0'
		);
		await expect(page.getByTestId('remote-attribution')).toContainText(
			'Provided by the Example Library'
		);
		await page.getByText('Catalogue details (2)').click();
		await expect(page.getByText('MS Atlas 44')).toBeVisible();

		await page.getByTestId('remote-reset').click();
		await lookUp(page, 'https://library.test/iiif/collection');
		await expect(page.getByTestId('remote-label')).toHaveText('Sea atlases');
		await expect(page.getByTestId('remote-item')).toHaveCount(1);
		await page.getByTestId('remote-item').click();
		await expect(page.getByTestId('remote-canvas')).toHaveCount(3);

		await page.getByTestId('remote-reset').click();
		await lookUp(page, `${FLORIDA}/info.json`);
		await expect(page.getByTestId('remote-add')).toBeVisible();
		await expect(page.getByTestId('remote-status')).toContainText('700 by 500 pixels');
	});

	test('names the host whose tiles are not readable cross-origin, and a viewer page answered with 200', async ({
		page
	}) => {
		await start(page);
		const requested: string[] = [];
		page.on('request', (request) => requested.push(request.url()));

		await lookUp(page, 'https://library.test/iiif/locked/manifest.json');

		const error = page.getByTestId('remote-error');
		await expect(error).toContainText('tiles-only.test');
		await expect(error).toContainText('completely blank');
		await expect(page.getByTestId('remote-add')).toHaveCount(0);
		await expect(layerRows(page)).toHaveCount(0);
		const toHost = requested.filter((url) => url.includes('tiles-only.test'));
		expect(toHost.some((url) => url.endsWith('/info.json'))).toBe(true);
		expect(toHost.some((url) => /\/0\/default\.jpg$/.test(url))).toBe(true);

		await page.getByTestId('remote-reset').click();
		await lookUp(page, 'https://library.test/maps/1657');
		await expect(error).toContainText('sent a web page rather than a IIIF description');
		await expect(error).toContainText('library.test');
	});

	test('gives a referenced image the id Allmaps keys it on, and adding it again leaves the stack byte-identical', async ({
		page
	}) => {
		await start(page);
		const row = await addFlorida(page);
		await expect(row.getByTestId('referenced-image-host')).toHaveText('images.test');

		expect(FLORIDA_ID).toMatch(/^[0-9a-f]{16}$/);
		expect(await readJson(page, '', `images/${FLORIDA_ID}/remote.json`)).toMatchObject({
			service: FLORIDA,
			source: MANIFEST,
			label: 'Chart of the Florida coast',
			partOf: MANIFEST,
			canvas: 'https://library.test/iiif/atlas/canvas/2',
			rights: 'http://creativecommons.org/licenses/by/4.0/',
			attribution: 'Provided by the Example Library',
			tileSize: 256
		});
		const layers = await projectLayers(page);
		expect(layers).toHaveLength(1);
		expect(layers[0]).toMatchObject({
			kind: 'map',
			name: 'Chart of the Florida coast',
			imageId: FLORIDA_ID
		});
		expect(await readStoredFileOrNull(page, `images/${FLORIDA_ID}/info.json`)).toBeNull();
		await expect(page.getByTestId('layer-sidebar')).toBeVisible();
		await expect(page.getByTestId('layer-image-mode')).toHaveAttribute(
			'data-image-mode',
			'referenced'
		);

		await row.getByTestId('layer-rename').click();
		await row.getByTestId('layer-name').fill('The Florida coast, as drawn in 1657');
		await row.getByTestId('layer-name').blur();
		await expect(page.getByRole('status')).toHaveText('Saved here');
		const renamed = await readStoredFile(page, PROJECT);

		await page.goto('/?p=amsterdam-1625');
		await addFlorida(page);

		await expect(layerRows(page)).toHaveCount(1);
		await page.waitForTimeout(2000);
		expect(await readStoredFile(page, PROJECT)).toBe(renamed);
	});

	test('imports the community alignment it found, and re-adding the map after deleting its Layer brings the Layer back with that Alignment', async ({
		page
	}) => {
		await start(page, [
			communityAnnotation('images.test', 'florida'),
			communityAnnotation('images.test', 'chesapeake')
		]);
		await chooseFlorida(page);
		const offer = page.getByTestId('community-offer');
		await expect(offer).toContainText('Import existing alignment — 1 found.');
		await expect(offer).toContainText('3 control points');
		await expect(page.getByTestId('remote-status')).toContainText(
			'Import existing alignment — 1 found.'
		);
		await addChosen(page);

		const aligned = await readStoredFile(page, ALIGNMENT);
		const alignment = JSON.parse(aligned);
		expect(alignment.body.features).toHaveLength(3);
		expect(alignment.body.transformation).toEqual({ type: 'polynomial', options: { order: 1 } });
		expect(alignment.target.selector.value).toContain('10,10 690,10 690,490 10,490');
		expect(alignment.target.source.id).toBe(FLORIDA);
		expect(aligned).not.toContain('unset.invalid');

		await deleteTheLayer(page);
		expect(await projectLayers(page)).toEqual([]);
		expect(await readStoredFile(page, ALIGNMENT)).toBe(aligned);

		await routeCommunityAnnotations(page, null);
		await page.goto('/?p=amsterdam-1625');
		await addFlorida(page, null);

		await expect(layerRows(page)).toHaveCount(1);
		expect(await projectLayers(page)).toEqual([
			expect.objectContaining({
				kind: 'map',
				imageId: FLORIDA_ID,
				name: 'Chart of the Florida coast'
			})
		]);
		await page.waitForTimeout(2000);
		expect(await readStoredFile(page, ALIGNMENT)).toBe(aligned);
	});

	test('adding a map another Project has aligned keeps that Alignment, and says so', async ({
		page
	}) => {
		await start(page, [communityAnnotation('images.test', 'florida')]);
		await addFlorida(page, '3 control points');
		const alignedInAmsterdam = await readStoredFile(page, ALIGNMENT);
		expect(JSON.parse(alignedInAmsterdam).target.selector.value).toContain('10,10 690,10');

		await routeCommunityAnnotations(page, [
			communityAnnotation('images.test', 'florida', 'refined')
		]);
		await page.goto('/');
		await openNewProject(page, 'Boston 1775');
		await addFlorida(page, '3 control points');

		await expect(layerRows(page)).toHaveCount(1);
		expect(await projectLayers(page, 'boston-1775/project.json')).toEqual([
			expect.objectContaining({ kind: 'map', imageId: FLORIDA_ID })
		]);
		const notice = page.getByTestId('remote-notice');
		await expect(notice).toContainText('was not written');
		await expect(notice).toContainText('one Alignment shared by every Project');

		await page.waitForTimeout(2000);
		expect(await readStoredFile(page, ALIGNMENT)).toBe(alignedInAmsterdam);
	});

	test('imports the community Alignment over a starter nobody has touched', async ({ page }) => {
		await start(page);
		await addFlorida(page, null);
		expect(JSON.parse(await readStoredFile(page, ALIGNMENT)).body.features).toEqual([]);

		await routeCommunityAnnotations(page, [communityAnnotation('images.test', 'florida')]);
		await page.goto('/');
		await openNewProject(page, 'Boston 1775');
		await addFlorida(page, '3 control points');

		await expect
			.poll(async () => JSON.parse(await readStoredFile(page, ALIGNMENT)).body.features.length)
			.toBe(3);
		await expect(page.getByTestId('remote-notice')).toHaveText('');
	});

	test('re-adding a map repairs a Project whose Alignment went missing', async ({ page }) => {
		await start(page);
		await addFlorida(page);

		await page.evaluate(async (name) => {
			await (await (await workspaceRoot()).getDirectoryHandle('alignments')).removeEntry(name);
		}, `${FLORIDA_ID}.json`);
		expect(await readStoredFileOrNull(page, ALIGNMENT)).toBeNull();

		await page.goto('/?p=amsterdam-1625');
		await addFlorida(page);

		await expect
			.poll(async () => {
				const text = await readStoredFileOrNull(page, ALIGNMENT);
				return text === null ? -1 : JSON.parse(text).body.features.length;
			})
			.toBe(0);
		await expect(layerRows(page)).toHaveCount(1);

		await page.goto('/');
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		await page.getByRole('button', { name: 'Edit Amsterdam 1625' }).click();
		const download = page.waitForEvent('download');
		await page
			.getByRole('dialog', { name: 'Edit Project' })
			.getByRole('button', { name: 'Export Project' })
			.click();
		expect((await download).suggestedFilename()).toBe('amsterdam-1625.project.tar');
	});

	test('discloses the lookup, and makes no request to the Allmaps API when it is off', async ({
		page
	}) => {
		await start(page, [communityAnnotation('images.test', 'florida')]);
		const allmapsRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('annotations.allmaps.org')) allmapsRequests.push(request.url());
		});

		await ensureAddMapImageOpen(page);
		const toggle = page.getByTestId('community-lookup-toggle');
		await expect(toggle).toBeChecked();
		await expect(page.getByText(/Check annotations\.allmaps\.org/)).toBeVisible();

		await toggle.uncheck();
		await expect(page.getByText(/Not checking Allmaps/)).toBeVisible();

		await lookUp(page, MANIFEST);
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('remote-add')).toBeVisible();

		expect(allmapsRequests).toEqual([]);
		const hosts = await page.evaluate(() => window.ballastellaRemoteRequests?.hosts ?? []);
		expect(hosts).toContain('images.test');
		expect(hosts).not.toContain('annotations.allmaps.org');
		await expect(page.getByTestId('community-off')).toBeVisible();

		await toggle.check();
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('community-offer')).toBeVisible();
		expect(allmapsRequests.length).toBeGreaterThan(0);
	});

	test('copies a plain image file into the Workspace and tiles it here', async ({ page }) => {
		await start(page);
		await page.route('https://images.test/plain/**', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'image/png',
				headers: { 'access-control-allow-origin': '*' },
				body: gradientPng(IMAGE_WIDTH, IMAGE_HEIGHT)
			})
		);

		await lookUp(page, 'https://images.test/plain/la-floride.png');

		await expect.poll(() => addMapImageIsOpen(page)).toBe(false);
		await expect(layerRows(page)).toHaveCount(1);
		await expect((await openLayerRow(page)).getByTestId('referenced-image-host')).toHaveCount(0);

		const images = await page.evaluate(async () => {
			const ids: string[] = [];
			for await (const name of (await (await workspaceRoot()).getDirectoryHandle('images')).keys())
				ids.push(name);
			return ids;
		});
		expect(images).toHaveLength(1);
		expect(await readJson(page, '', `images/${images[0]}/info.json`)).toMatchObject({
			width: IMAGE_WIDTH,
			height: IMAGE_HEIGHT
		});
		const manifest = (await readJson(page, '', `images/${images[0]}/manifest.json`)) as {
			label: { none: string[] };
		};
		expect(manifest.label.none[0]).toBe('la-floride.png');
	});
});

test.describe('a referenced Map Image, drawn from the library that holds it', () => {
	for (const via of ['link', 'load'] as const) {
		test(`draws a referenced Layer warped, from tiles the remote host served (reached by ${via})`, async ({
			page
		}) => {
			test.slow();
			await start(page, [communityAnnotation('images.test', 'florida')]);
			await addFlorida(page, '3 control points');

			const tileRequests: string[] = [];
			const placeholderRequests: string[] = [];
			page.on('request', (request) => {
				const url = request.url();
				if (/images\.test.*default\.(jpg|png)$/.test(url)) tileRequests.push(url);
				if (url.includes('unset.invalid')) placeholderRequests.push(url);
			});

			if (via === 'link') await expect(page.getByTestId('layer-sidebar')).toBeVisible();
			else await page.goto('/?p=amsterdam-1625');
			await expect(page.getByRole('heading', { name: 'Layers in this Project' })).toBeVisible();

			await expect
				.poll(
					() =>
						page.evaluate(() => {
							const handle = window.ballastellaLayerStack;
							return handle ? Object.keys(handle.warped).length : -1;
						}),
					{ timeout: 30_000 }
				)
				.toBe(1);

			await expect
				.poll(
					() =>
						page.evaluate(async () => {
							const handle = window.ballastellaLayerStack;
							const layer = Object.values(handle?.warped ?? {})[0];
							if (!handle || !layer) return 0;
							handle.map.fitBounds(layer.getBounds(), { animate: false });
							await new Promise((resolve) => setTimeout(resolve, 1500));
							return layer.renderer?.tileCache?.getCachedTiles?.()?.length ?? 0;
						}),
					{ timeout: 60_000, intervals: [2000] }
				)
				.toBeGreaterThan(0);

			expect(tileRequests.length).toBeGreaterThan(0);
			expect(placeholderRequests).toEqual([]);
		});
	}

	test('says so when the record of where a referenced map lives cannot be read', async ({
		page
	}) => {
		await start(page);
		const rowOf = (id: string) => page.locator(`[data-testid="layer-row"][data-image-id="${id}"]`);

		for (const name of ['florida', 'approaches']) {
			await lookUp(page, `${service('images.test', name)}/info.json`);
			await expect(page.getByTestId('remote-add')).toBeVisible();
			await page.getByTestId('remote-add').click();
			await expectReferencedMap(page, rowOf(generateId(service('images.test', name))));
		}
		await expect(page.getByRole('status')).toHaveText('Saved here');

		const broken = generateId(service('images.test', 'approaches'));
		await seedFile(page, `images/${broken}/remote.json`, '{"label":"corrupt"}');

		await page.goto('/?p=amsterdam-1625');

		const readableRow = await expectReferencedMap(page, rowOf(FLORIDA_ID));
		await expect(readableRow.getByTestId('referenced-image-label')).toHaveCount(1);
		const brokenRow = await openLayerRow(page, rowOf(broken));
		await expect(brokenRow.getByTestId('referenced-image-label')).toHaveCount(0);

		const alert = page.getByRole('alert').filter({ hasText: broken });
		await expect(alert).toContainText('names no image service');
		await expect(alert).toContainText('nowhere to fetch its tiles from');
	});

	test('offers no unwarped view, and loads no OpenSeadragon to give one', async ({
		page,
		baseURL
	}) => {
		const origin = new URL(baseURL ?? 'http://localhost').origin;
		const responded: string[] = [];
		page.on('response', (response) => {
			const url = response.url();
			if (url.startsWith(origin) && /\.(js|css)(\?|$)/.test(url)) responded.push(url);
		});

		await start(page);
		await lookUp(page, `${FLORIDA}/info.json`);
		await page.getByTestId('remote-add').click();
		const referencedRow = await expectReferencedMap(page);
		await expect(referencedRow.getByTestId('referenced-image-host')).toHaveText('images.test');

		await expect(referencedRow.getByTestId('view-unwarped')).toHaveCount(0);
		await expect(page.getByTestId('view-unwarped')).toHaveCount(0);
		await expect(page.getByTestId('unwarped-view')).toHaveCount(0);
		await expect(page.getByRole('button', { name: /unwarped/i })).toHaveCount(0);

		const registered = await page.evaluate(() =>
			['triiiceratops-viewer', 'triiiceratops-element'].map(
				(name) => customElements.get(name) !== undefined
			)
		);
		expect(registered).toEqual([false, false]);

		const loadedHere = await page.evaluate(() =>
			[
				...document.querySelectorAll<HTMLLinkElement | HTMLScriptElement>(
					'link[rel="modulepreload"][href], link[rel="stylesheet"][href], script[type="module"][src]'
				)
			].map((element) => (element instanceof HTMLLinkElement ? element.href : element.src))
		);

		const routes = await editorRouteDocuments();
		expect(routes.length, 'route documents discovered in the editor build').toBeGreaterThanOrEqual(
			3
		);

		const declared: string[] = [...loadedHere];
		for (const route of routes) {
			const url = `${origin}/${route}`;
			const document = await page.request.get(url);
			expect(document.ok(), `fetching ${url}`).toBe(true);
			declared.push(...assetReferences(await document.text(), url));
		}

		const inspected = [...new Set([...declared, ...responded])].filter((url) =>
			url.startsWith(origin)
		);
		expect(inspected.length, 'scripts and stylesheets inspected').toBeGreaterThan(0);
		const carrying: string[] = [];
		for (const url of inspected) {
			const body = await page.request.get(url);
			expect(body.ok(), `re-fetching ${url}`).toBe(true);
			if (/triiiceratops|openseadragon/i.test(await body.text())) carrying.push(url);
		}
		expect(carrying, 'editor assets carrying triiiceratops or OpenSeadragon').toEqual([]);
	});
});

async function editorRouteDocuments(): Promise<string[]> {
	const build = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/editor/build');
	const entries = await readdir(build, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
		.map((entry) => entry.name)
		.sort();
}

function assetReferences(html: string, documentUrl: string): string[] {
	const links = [...html.matchAll(/<link\b[^>]*>/g)]
		.filter((tag) => /\brel="(modulepreload|stylesheet)"/.test(tag[0]))
		.flatMap((tag) => /\bhref="([^"]+)"/.exec(tag[0])?.[1] ?? []);
	const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map((tag) => tag[1]);
	return [...links, ...scripts].map((reference) => new URL(reference, documentUrl).href);
}

declare global {
	interface Window {
		ballastellaRemoteRequests?: { urls: string[]; hosts: string[] };
	}
}
