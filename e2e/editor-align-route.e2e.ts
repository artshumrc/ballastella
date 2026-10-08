import { expect, test, type Page } from './support/test.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	gradientPng,
	mapImage,
	makePair,
	makePairs,
	rows,
	start,
	storedAlignment,
	storedProjectFile,
	waitForStored,
	watchWrites,
	writes,
	expectWarpedDrawn
} from './support/alignment-workspace';
import { routeBaseMapArchive } from './support/editor-deployment';
import { addMapImageButton, pickMapImageFile } from './support/map-images.js';
import { alignFromLayer } from './support/layers';
import { emptyWorkspace } from './support/workspace.js';
import { PROJECT_DIRECTORY, PROJECT_NAME, baseMap, clickAt } from './support/annotations.js';

test.beforeEach(async ({ page }) => {
	await routeBaseMapArchive(page);
});

const backLink = (page: Page) => page.getByTestId('back-to-project');
const checkToggle = (page: Page) => page.getByTestId('check-alignment-toggle');
const distortionControls = (page: Page) => page.getByTestId('distortion-controls');
const foldWarning = (page: Page) => page.getByTestId('fold-warning');

async function projectWithMap(page: Page): Promise<void> {
	await page.goto('/');
	await emptyWorkspace(page);
	await page.reload();
	await page.getByRole('button', { name: 'New Project' }).click();
	const dialog = page.getByRole('dialog', { name: 'New Project' });
	await dialog.getByLabel('Project name').fill(PROJECT_NAME);
	await dialog.getByRole('button', { name: 'Create' }).click();
	await expect(addMapImageButton(page)).toBeVisible();
	await pickMapImageFile(page, {
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(700, 500)
	});
	await expect(page.getByTestId('layer-row')).toHaveCount(1, { timeout: 30_000 });
}

const layerParam = (page: Page): string => new URL(page.url()).searchParams.get('layer') ?? '';

const recordErrors = (page: Page): string[] => {
	const thrown: string[] = [];
	page.on('pageerror', (error) => thrown.push(`${error.name}: ${error.message}`));
	return thrown;
};

const tilesLoaded = (page: Page) =>
	expect(page.getByTestId('map-image-tiles')).toHaveAttribute('data-tiles-loaded', 'true', {
		timeout: 30_000
	});

async function goBack(page: Page): Promise<void> {
	await backLink(page).click();
	await expect(addMapImageButton(page)).toBeVisible();
}

test.describe('the alignment route', () => {
	test('is prerendered, says it is starting in the file it is served as, and has no SPA fallback', async () => {
		const build = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			'../apps/editor/build'
		);
		const prerendered = path.join(build, 'align.html');
		expect(statSync(prerendered).isFile(), 'align.html was not prerendered').toBe(true);
		const served = readFileSync(prerendered, 'utf8');
		expect(served).toContain('Align — Ballastella Editor');
		expect(served).toContain('Starting…');
		expect(served).toContain('Back to all Projects');
		const names = readdirSync(build);
		for (const name of ['200.html', '404.html']) {
			expect(names, `${name} is an SPA fallback`).not.toContain(name);
		}
		expect(readFileSync(path.join(build, 'index.html'), 'utf8')).toContain('Ballastella Editor');
	});

	test('opening it writes no Alignment and adds no Layer, and every state it can be opened in is named with a way back', async ({
		page
	}) => {
		test.setTimeout(120_000);
		const thrown = recordErrors(page);
		await projectWithMap(page);
		await expect(page.getByRole('status')).toHaveText('Saved here');

		const before = await storedProjectFile(page);
		expect(before).not.toBeNull();
		const imageId = JSON.parse(before as string).layers[0].imageId;
		expect(JSON.parse(before as string).layers).toHaveLength(1);
		const alignmentBefore = await storedAlignment(page, imageId);
		expect(alignmentBefore).not.toBeNull();

		const noWritesAfter = async (): Promise<void> => {
			await page.waitForTimeout(2000);
			expect(await writes(page), 'opening the alignment view wrote an Alignment').toEqual([]);
		};

		await watchWrites(page);
		await alignFromLayer(page);
		await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);
		const layerId = layerParam(page);
		expect(layerId).not.toBe('');
		await tilesLoaded(page);
		await expect(baseMap(page)).toBeVisible();
		await noWritesAfter();

		await page.reload();
		await watchWrites(page);
		await tilesLoaded(page);
		await expect(baseMap(page)).toBeVisible();
		await noWritesAfter();

		await goBack(page);
		await page.waitForTimeout(1000);
		expect(await storedAlignment(page, imageId)).toBe(alignmentBefore);
		expect(await storedProjectFile(page)).toBe(before);

		const backToAll = page.getByRole('link', { name: 'Back to all Projects' });
		await page.goto('/align');
		await expect(page.getByTestId('no-layer')).toHaveCount(0);
		await expect(page.getByRole('heading', { name: 'No Project chosen' })).toBeVisible();
		await expect(backToAll).toBeVisible();

		await page.goto(`/align?p=never-existed&layer=${layerId}`);
		await expect(page.getByRole('heading', { name: 'Project not found' })).toBeVisible();
		await expect(backToAll).toBeVisible();

		await page.evaluate(async () => {
			const root = await workspaceRoot();
			const project = await root.getDirectoryHandle('broken', { create: true });
			const handle = await project.getFileHandle('project.json', { create: true });
			const writable = await handle.createWritable();
			await writable.write('{ not a project');
			await writable.close();
		});
		await page.goto(`/align?p=broken&layer=${layerId}`);
		await expect(
			page.getByRole('heading', { name: 'This Project cannot be opened' })
		).toBeVisible();
		await expect(backToAll).toBeVisible();

		await page.goto(`/align?p=${PROJECT_DIRECTORY}&layer=not-a-layer-in-this-project`);
		await expect(page.getByTestId('layer-missing')).toBeVisible();
		await expect(page.getByTestId('layer-missing')).toContainText('not-a-layer-in-this-project');
		await expect(mapImage(page)).toHaveCount(0);
		await expect(baseMap(page)).toHaveCount(0);
		await goBack(page);

		await page.goto(`/align?p=${PROJECT_DIRECTORY}`);
		await expect(page.getByTestId('no-layer')).toBeVisible();
		await expect(mapImage(page)).toHaveCount(0);
		await goBack(page);

		expect(thrown, 'a bad address must not throw').toEqual([]);
	});

	test('names the three states the Workspace itself can be in', async ({ page }) => {
		const thrown = recordErrors(page);
		await page.addInitScript(() => {
			Object.defineProperty(navigator.storage, 'getDirectory', {
				configurable: true,
				value: undefined
			});
		});
		await page.goto(`/align?p=${PROJECT_DIRECTORY}&layer=anything`);
		await expect(page.getByRole('heading', { name: 'No storage for a Workspace' })).toBeVisible();
		await expect(page.getByText('not offering storage for a Workspace')).toBeVisible();
		await expect(page.getByRole('link', { name: 'Back to all Projects' })).toBeVisible();
		await expect(mapImage(page)).toHaveCount(0);

		const recovering = await page.context().newPage();
		recovering.on('pageerror', (error) => thrown.push(`${error.name}: ${error.message}`));
		await recovering.addInitScript(() => {
			Object.defineProperty(navigator.storage, 'getDirectory', {
				configurable: true,
				value: () => Promise.reject(new DOMException('No such folder', 'NotFoundError'))
			});
		});
		await recovering.goto(`/align?p=${PROJECT_DIRECTORY}&layer=anything`);
		await expect(
			recovering.getByRole('heading', { name: 'Workspace not reachable' })
		).toBeVisible();
		await expect(recovering.getByRole('button', { name: /Locate Workspace/ })).toBeVisible();
		await expect(recovering.getByRole('link', { name: 'Back to all Projects' })).toBeVisible();
		await expect(recovering.getByTestId('image-pane')).toHaveCount(0);
		await recovering.close();

		expect(thrown, 'a Workspace that is not there must not throw').toEqual([]);
	});

	test('records the write a Control Point really makes, and keeps it across a trip back to the Project and in again', async ({
		page
	}) => {
		test.setTimeout(120_000);
		const imageId = await start(page);
		await watchWrites(page);

		await makePair(page, [0.35, 0.4]);
		await waitForStored(page, imageId, 1);
		const recorded = await writes(page);
		expect(recorded.length, 'placing a Control Point recorded no write').toBeGreaterThan(0);
		expect(recorded.map((write) => write.path)).toContain(`alignments/${imageId}.json`);
		const written = await storedAlignment(page, imageId);

		await goBack(page);
		await expect(mapImage(page)).toHaveCount(0);

		await alignFromLayer(page);
		await tilesLoaded(page);
		await expect(rows(page)).toHaveCount(1);
		expect(await storedAlignment(page, imageId)).toBe(written);
	});

	test('opens the Base Map on the Control Points there already are', async ({ page }) => {
		test.setTimeout(120_000);
		const imageId = await start(page);
		const opened = await baseMapCentre(page);

		await makePair(page, [0.3, 0.3], [0.18, 0.2]);
		await makePair(page, [0.6, 0.35], [0.24, 0.24]);
		await waitForStored(page, imageId, 2);
		const placed = await baseMapCentre(page);
		expect(placed).toEqual(opened);

		await goBack(page);
		await alignFromLayer(page);
		await expect(rows(page)).toHaveCount(2);

		await expect
			.poll(async () => {
				const now = await baseMapCentre(page);
				return Math.hypot(now.lng - placed.lng, now.lat - placed.lat) > 1e-6;
			})
			.toBe(true);
		const fitted = await baseMapCentre(page);
		const points = await controlPointGeo(page);
		const west = Math.min(...points.map((point) => point.lng));
		const east = Math.max(...points.map((point) => point.lng));
		const south = Math.min(...points.map((point) => point.lat));
		const north = Math.max(...points.map((point) => point.lat));
		expect(fitted.lng).toBeGreaterThan(west - (east - west) - 1);
		expect(fitted.lng).toBeLessThan(east + (east - west) + 1);
		expect(fitted.lat).toBeGreaterThan(south - (north - south) - 1);
		expect(fitted.lat).toBeLessThan(north + (north - south) + 1);
	});
});

const baseMapCentre = (page: Page): Promise<{ lng: number; lat: number }> =>
	page.evaluate(() => {
		const map = (window as { ballastellaBaseMap?: { getCenter(): { lng: number; lat: number } } })
			.ballastellaBaseMap;
		if (!map) throw new Error('there is no Base Map on the page');
		const centre = map.getCenter();
		return { lng: centre.lng, lat: centre.lat };
	});

const controlPointGeo = async (page: Page): Promise<{ lng: number; lat: number }[]> => {
	const points = baseMap(page).locator('[data-testid="pane-overlay-point-control-point"]');
	const raw = await points.evaluateAll((elements) =>
		elements.map((element) => ({
			lng: Number(element.getAttribute('data-lng')),
			lat: Number(element.getAttribute('data-lat'))
		}))
	);
	expect(raw.length, 'no Control Point is drawn on the Base Map').toBeGreaterThan(0);
	return raw;
};

test.describe('“Check this alignment”', () => {
	test('keeps its controls out of the accessibility tree until opened, out of project.json, closed after a reload, and every control reachable by Tab', async ({
		page
	}) => {
		test.setTimeout(120_000);
		await start(page);
		await makePairs(page, 4);
		await expectWarpedDrawn(page);

		await expect(checkToggle(page)).toHaveAttribute('aria-expanded', 'false');
		const overlay = page.getByRole('checkbox', {
			name: 'Colour the Map Image by how much it is stretched'
		});
		const grid = page.getByRole('checkbox', { name: 'Draw a grid, bent by the Alignment' });
		const measure = page.getByRole('combobox', { name: 'What the colours show' });
		for (const hidden of [overlay, grid, measure, distortionControls(page)]) {
			await expect(hidden).toHaveCount(0);
		}

		await checkToggle(page).click();
		await expect(checkToggle(page)).toHaveAttribute('aria-expanded', 'true');
		await expect(overlay).toBeVisible();
		await expect(grid).toBeVisible();
		await expect(measure).toHaveCount(0);
		await overlay.check();
		await expect(measure).toBeVisible();

		await checkToggle(page).click();
		await expect(overlay).toHaveCount(0);
		await expect(measure).toHaveCount(0);
		await checkToggle(page).click();
		await expect(overlay).not.toBeChecked();
		await expect(measure).toHaveCount(0);

		await page.getByTestId('distortion-toggle').check();
		await page.getByTestId('grid-toggle').check();
		await expect(checkToggle(page)).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByRole('status')).toHaveText('Saved here');
		const stored = await storedProjectFile(page);
		for (const word of ['log2sigma', 'renderGrid', 'checking']) expect(stored).not.toContain(word);

		await page.reload();
		await expect(page.getByRole('heading', { name: /^Align(?::|$)/ })).toBeVisible();
		await expect(checkToggle(page)).toHaveAttribute('aria-expanded', 'false');
		await expect(distortionControls(page)).toHaveCount(0);

		await expectWarpedDrawn(page);
		await checkToggle(page).click();
		await expect(distortionControls(page)).toBeVisible();
		const wanted = await page.evaluate(() => {
			const focusable = [
				...document.querySelectorAll<HTMLElement>(
					'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
				)
			].filter((element) =>
				element.checkVisibility({ visibilityProperty: true, opacityProperty: true })
			);
			focusable.forEach((element, index) => element.setAttribute('data-tab-probe', String(index)));
			return focusable.map((element, index) => ({
				probe: String(index),
				what: `${element.tagName}[${element.getAttribute('data-testid') ?? ''}] ${
					element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? ''
				}`
			}));
		});
		expect(wanted.length, 'there is nothing on this page to walk').toBeGreaterThan(10);
		const backProbe = await backLink(page).getAttribute('data-tab-probe');
		expect(backProbe, 'the way back is not focusable at all').not.toBeNull();

		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		const seen = new Set<string>();
		for (let step = 0; step < wanted.length * 3 && seen.size < wanted.length; step += 1) {
			await page.keyboard.press('Tab');
			const probe = await page.evaluate(
				() => (document.activeElement as HTMLElement | null)?.getAttribute('data-tab-probe') ?? null
			);
			if (probe !== null) seen.add(probe);
		}
		const unreached = wanted.filter((one) => !seen.has(one.probe)).map((one) => one.what);
		expect(unreached, 'these controls cannot be reached by Tab').toEqual([]);
		expect(seen.has(backProbe as string), 'the way back is not reachable by Tab').toBe(true);

		await backLink(page).focus();
		await page.keyboard.press('Enter');
		await expect(addMapImageButton(page)).toBeVisible();
		expect(new URL(page.url()).searchParams.get('p')).toBe(PROJECT_DIRECTORY);
	});

	test('does not hide the fold warning', async ({ page }) => {
		test.setTimeout(120_000);
		await start(page);
		await makePair(page, [0.25, 0.3], [0.75, 0.3]);
		await makePair(page, [0.75, 0.3], [0.25, 0.3]);
		await makePair(page, [0.5, 0.75], [0.5, 0.75]);

		await expect(checkToggle(page)).toHaveAttribute('aria-expanded', 'false');
		await expect(distortionControls(page)).toHaveCount(0);
		await expect(foldWarning(page)).toBeVisible();
		await expect(foldWarning(page)).toHaveAttribute('data-fold-kind', 'mirrored');
		await expect(foldWarning(page)).toHaveAttribute('role', 'alert');
	});
});

test('cancels a pending Control Point with Escape from the keyboard', async ({ page }) => {
	test.setTimeout(90_000);
	await start(page);
	await clickAt(mapImage(page), 0.4, 0.4);
	await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
	await backLink(page).focus();
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', '');
	await expect(rows(page)).toHaveCount(0);
});
