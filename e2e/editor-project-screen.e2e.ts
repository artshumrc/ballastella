import { DEFAULT_WORKSPACE, expect, test } from './support/test.js';
import { type Page } from '@playwright/test';

import { gradientPng } from './support/alignment-workspace.js';
import { drawSwitch, openBaseMapOptions } from './support/base-map-options.js';
import {
	PROJECT_DIRECTORY,
	PROJECT_NAME,
	baseMap,
	chooseTool,
	clickAt,
	createProject,
	readProjectFile
} from './support/annotations.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { addMapImageFromFile } from './support/map-images.js';
import { alignFromLayer, openLayerRow } from './support/layers.js';
import { openProjectSettings } from './support/project-screen.js';
import { emptyWorkspace } from './support/workspace.js';

declare global {
	interface Window {
		e2eProjectWrites?: string[];
	}
}

async function freshWorkspace(page: Page): Promise<void> {
	await page.goto('./');
	await emptyWorkspace(page);
	await page.reload();
	await createProject(page);
	await expect(page.getByRole('link', { name: PROJECT_NAME })).toBeVisible();
}

async function openProject(page: Page): Promise<void> {
	await page.goto(`./?p=${PROJECT_DIRECTORY}`);
	await expect(page.getByTestId('project-name')).toHaveText(PROJECT_NAME);
	await expect(page.getByTestId('opening-view')).toHaveAttribute(
		'data-opening-view',
		/^(content|default)$/,
		{ timeout: 30_000 }
	);
}

async function addMapImage(page: Page): Promise<void> {
	await addMapImageFromFile(page, {
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(280, 200)
	});
}

const hrefs = (page: Page) =>
	page.locator('a[href]').evaluateAll((links) => links.map((link) => link.getAttribute('href')!));

const projectFile = (page: Page) => readProjectFile(page, 'project.json');

const countWrites = (page: Page) =>
	page.addInitScript(() => {
		window.e2eProjectWrites = [];
		const real = FileSystemFileHandle.prototype.createWritable;
		FileSystemFileHandle.prototype.createWritable = function (
			this: FileSystemFileHandle,
			...args: Parameters<typeof real>
		) {
			window.e2eProjectWrites?.push(this.name);
			return real.apply(this, args);
		};
	});

const projectWrites = async (page: Page): Promise<number> =>
	(await page.evaluate(() => window.e2eProjectWrites ?? [])).filter((name) =>
		name.includes('project.json')
	).length;

const saveState = (page: Page) => page.locator('[data-save-state]');

test.beforeEach(async ({ context }) => {
	await routeBaseMapArchive(context);
});

test.describe('the Project screen', () => {
	test('is a Base Map with the Layer stack beside it, the map the larger share, and every control reachable by keyboard', async ({
		page
	}) => {
		await freshWorkspace(page);
		await openProject(page);
		await addMapImage(page);
		await page.getByTestId('add-annotation-layer').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(2);

		const sidebar = page.getByTestId('layer-sidebar');
		const map = page.getByTestId('project-map');
		await expect(sidebar).toBeVisible();
		await expect(map).toBeVisible();
		await expect(sidebar.getByRole('list', { name: 'Layers, top first' })).toHaveCount(1);
		await expect(map.locator('canvas.maplibregl-canvas')).toBeVisible();
		const sidebarBox = (await sidebar.boundingBox())!;
		const mapBox = (await map.boundingBox())!;
		expect(mapBox.height).toBeGreaterThan(sidebarBox.width);
		expect(mapBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width - 1);
		expect(mapBox.width).toBeGreaterThan(sidebarBox.width);

		await openLayerRow(page, 0);
		const wanted = await page.evaluate(() => {
			const inside = document.querySelector('[data-testid="project-screen"]')!;
			return [...inside.querySelectorAll('a[href], button, input, select, textarea')]
				.filter((element) => {
					const control = element as HTMLElement & { disabled?: boolean };
					if (control.disabled) return false;
					const box = control.getBoundingClientRect();
					return box.width > 0 && box.height > 0;
				})
				.map((element, index) => {
					element.setAttribute('data-e2e-control', String(index));
					return String(index);
				});
		});
		expect(wanted.length).toBeGreaterThan(10);

		await page.evaluate(() => document.body.focus());
		const reached = new Set<string>();
		for (let step = 0; step < wanted.length * 3 + 20; step++) {
			await page.keyboard.press('Tab');
			const seen = await page.evaluate(
				() => document.activeElement?.getAttribute('data-e2e-control') ?? null
			);
			if (seen !== null) reached.add(seen);
			if (reached.size === wanted.length) break;
		}
		expect([...wanted].filter((id) => !reached.has(id))).toEqual([]);
	});

	test('keeps the add-Layer buttons on screen under a stack taller than the rail', async ({
		page
	}) => {
		await freshWorkspace(page);
		await openProject(page);

		const rows = page.getByTestId('layer-row');
		for (let count = 1; count <= 12; count += 1) {
			await page.getByTestId('add-annotation-layer').click();
			await expect(rows).toHaveCount(count);
		}

		const scrolling = await page.getByTestId('layer-sidebar').evaluate((rail) => ({
			rail: rail.scrollHeight > rail.clientHeight + 1,
			children: [...rail.children].filter((child) => child.scrollHeight > child.clientHeight + 1)
				.length
		}));
		expect(scrolling).toEqual({ rail: false, children: 1 });
		const viewport = page.viewportSize()!;
		for (const testid of ['add-map-image', 'add-annotation-layer']) {
			const box = (await page.getByTestId(testid).boundingBox())!;
			expect(box.y).toBeGreaterThanOrEqual(0);
			expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
		}
	});
});

test('carries the navigation bar, one theme picker and one status region from hub to Project to alignment and back, linking to no retired page', async ({
	page,
	context
}) => {
	const bar = page.getByTestId('navigation-bar');
	const gone = /(^|\/)(layers|base-map|image-pane)(\/|$|\?)/;
	const assertChrome = async (where: string) => {
		await expect(bar, `no navigation bar on ${where}`).toHaveCount(1);
		for (const testid of ['workspace-identity', 'theme-toggle', 'undo-slot', 'save-slot']) {
			await expect(bar.getByTestId(testid), `${testid} on ${where}`).toHaveCount(1);
		}
		await expect(bar.getByTestId('base-map-options')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Theme', exact: true })).toHaveCount(1);
		await expect(page.getByRole('status')).toHaveCount(1);
		expect(
			(await hrefs(page)).filter((href) => gone.test(href)),
			where
		).toEqual([]);
	};

	await freshWorkspace(page);
	await assertChrome('the hub');
	await expect(page.getByRole('status').locator('[data-save-state]')).toBeVisible();
	await expect(bar.getByTestId('page-chrome')).toHaveCount(0);
	await expect(bar.getByTestId('workspace-identity')).toContainText(DEFAULT_WORKSPACE);

	await openProject(page);
	await addMapImage(page);
	await assertChrome('the Project screen');
	await expect(bar.getByTestId('project-name')).toHaveText(PROJECT_NAME);
	await expect(bar.getByTestId('edit-project-name')).toHaveAccessibleName('Edit Project name');
	await expect(bar.getByTestId('all-projects')).toHaveText('Projects');

	await context.setOffline(true);
	const notice = page.getByTestId('base-map-offline');
	await expect(notice).toBeVisible();
	await expect(notice).toHaveAttribute('role', 'alert');
	await expect(page.getByRole('status')).toHaveCount(1);
	await context.setOffline(false);

	const row = page.getByTestId('layer-row').first();
	await expect(row).toHaveAttribute('data-layer-kind', 'map');
	await alignFromLayer(page, row);
	await expect(page).toHaveURL(/\/align\/?\?p=amsterdam-1625&layer=[^&]+/);
	await expect(page.getByRole('heading', { name: /^Align:/ })).toBeVisible();
	await assertChrome('the alignment route');
	const chrome = bar.getByTestId('page-chrome');
	await expect(chrome.getByTestId('page-heading')).toHaveText(/^Align:/);
	await expect(chrome.getByTestId('back-to-project')).toHaveText(PROJECT_NAME);
	await expect(page.locator('h1')).toHaveCount(1);

	await chrome.getByTestId('back-to-project').click();
	await expect(page).toHaveURL(/\?p=amsterdam-1625$/);
	await expect(page.getByTestId('project-screen')).toBeVisible();
	await expect(bar.getByTestId('project-name')).toHaveText(PROJECT_NAME);
	await expect(page.getByTestId('layer-row')).toHaveCount(1);

	await page.goto('./align/?p=amsterdam-1625&layer=none');
	await expect(page.getByRole('button', { name: 'Theme', exact: true })).toHaveCount(1);
});

test('retires /layers/ and /base-map/ as pages, and keeps /image-pane/ rendering the fixture pane', async ({
	page
}) => {
	for (const path of ['./layers', './layers/', './base-map', './base-map/index.html']) {
		const response = await page.goto(path);
		expect(response?.status(), `${path} still answers a page`).toBe(404);
	}
	const response = await page.goto('./image-pane/');
	expect(response?.status()).toBe(200);
	await expect(page.getByTestId('image-pane')).toBeVisible({ timeout: 30_000 });
});

test.describe('the theme', () => {
	const backgroundPaint = (page: Page) =>
		page.evaluate(() =>
			JSON.stringify(
				(
					window as unknown as {
						ballastellaBaseMap?: {
							getStyle(): { layers: { id: string; paint?: unknown }[] };
						};
					}
				).ballastellaBaseMap
					?.getStyle()
					.layers.find((layer) => layer.id === 'background')?.paint ?? null
			)
		);
	const baseColour = (page: Page) =>
		page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue('--color-base-100')
		);
	const html = (page: Page) => page.locator('html');

	async function selectTheme(page: Page, next: string): Promise<void> {
		await page.getByRole('button', { name: 'Theme', exact: true }).click();
		await page.getByTestId(`theme-option-${next}`).click();
	}

	test('changes the interface and the Base Map flavour in one action, and survives a reload', async ({
		page
	}) => {
		await freshWorkspace(page);
		await openProject(page);
		await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
		await expect.poll(() => backgroundPaint(page), { timeout: 30_000 }).not.toBe('null');
		await expect(html(page)).toHaveAttribute('data-theme', 'carto-light');
		const light = await backgroundPaint(page);
		const cartoBase = await baseColour(page);

		await selectTheme(page, 'synthwave');

		await expect(html(page)).toHaveAttribute('data-theme', 'synthwave');
		await expect.poll(() => backgroundPaint(page), { timeout: 30_000 }).not.toBe(light);
		await expect.poll(() => baseColour(page)).not.toBe(cartoBase);

		await page.reload();
		await expect(html(page)).toHaveAttribute('data-theme', 'synthwave');
		await page.goto('./');
		await expect(html(page)).toHaveAttribute('data-theme', 'synthwave');
	});

	test('follows the operating system live until an explicit choice stops it', async ({ page }) => {
		const prefersDark = () =>
			page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
		await page.emulateMedia({ colorScheme: 'light' });
		await freshWorkspace(page);
		await expect(html(page)).toHaveAttribute('data-theme', 'carto-light');
		await page.emulateMedia({ colorScheme: 'dark' });
		await expect(html(page)).toHaveAttribute('data-theme', 'carto-dark');
		await page.emulateMedia({ colorScheme: 'light' });
		await expect(html(page)).toHaveAttribute('data-theme', 'carto-light');

		await selectTheme(page, 'synthwave');
		await expect(html(page)).toHaveAttribute('data-theme', 'synthwave');
		await page.emulateMedia({ colorScheme: 'dark' });
		await expect.poll(prefersDark).toBe(true);
		await page.emulateMedia({ colorScheme: 'light' });
		await expect.poll(prefersDark).toBe(false);
		await page.waitForTimeout(500);
		await expect(html(page)).toHaveAttribute('data-theme', 'synthwave');
	});
});

test('a save that failed says why, in a region a screen reader is given', async ({ page }) => {
	await freshWorkspace(page);
	await openProject(page);
	await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');

	await page.evaluate(() => {
		FileSystemWritableFileStream.prototype.close = () =>
			Promise.reject(new DOMException('Quota exceeded', 'QuotaExceededError'));
	});
	await openBaseMapOptions(page);
	await drawSwitch(page, 'Streets').click();

	await expect(saveState(page)).toHaveAttribute('data-save-state', 'unsaved');
	const reason = page.getByTestId('save-error');
	await expect(reason).toBeVisible();
	await expect(reason).not.toBeEmpty();
	await expect(reason).toHaveAttribute('role', 'alert');
});

test.describe('Project settings', () => {
	test('opens as a modal dialog that Escape closes, giving focus back without abandoning a part-drawn shape', async ({
		page
	}) => {
		await freshWorkspace(page);
		await openProject(page);
		await page.getByTestId('add-annotation-layer').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
		await openLayerRow(page);

		await chooseTool(page, 'polygon');
		await clickAt(baseMap(page), 0.4, 0.4);
		await clickAt(baseMap(page), 0.6, 0.4);
		const drawingStatus = page.getByTestId('annotation-status');
		await expect(drawingStatus).toHaveAttribute('data-drawing', 'true');

		const edit = page.getByTestId('edit-project-name');
		await edit.click();
		const dialog = page.getByRole('dialog', { name: 'Project settings' });
		await expect(dialog).toBeVisible();
		expect(
			await dialog.evaluate((element) => element.matches(':modal')),
			'the settings dialog was not opened with showModal()'
		).toBe(true);
		await expect(dialog.getByTestId('project-updated-at')).not.toBeEmpty();
		await expect(dialog.getByLabel('Project name')).toHaveValue(PROJECT_NAME);

		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(edit).toBeFocused();
		await expect(drawingStatus).toHaveAttribute('data-drawing', 'true');

		await page.keyboard.press('Escape');
		await expect(drawingStatus).toHaveAttribute('data-drawing', 'false');
	});

	test('writes nothing for focusing the name field, and coalesces typing into one write when the edit ends', async ({
		page
	}) => {
		await countWrites(page);
		await freshWorkspace(page);
		await openProject(page);
		await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');

		const before = await projectFile(page);
		const writesBefore = await projectWrites(page);
		const dialog = await openProjectSettings(page);
		const field = dialog.getByLabel('Project name');
		await field.focus();
		await expect(field).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(field).not.toBeFocused();
		await field.click();
		await dialog.getByRole('heading', { name: 'Project settings' }).click();
		await expect(field).not.toBeFocused();

		await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
		await page.waitForTimeout(700);
		expect(await projectFile(page)).toBe(before);
		expect(await projectWrites(page), 'looking at the name field wrote project.json').toBe(
			writesBefore
		);

		await field.fill('');
		await field.pressSequentially('Amsterdam 1626', { delay: 20 });
		await field.blur();

		await expect(saveState(page)).toHaveAttribute('data-save-state', 'saved');
		await page.waitForTimeout(700);
		expect(JSON.parse(await projectFile(page)).name).toBe('Amsterdam 1626');
		const writes = (await projectWrites(page)) - writesBefore;
		expect(writes, `one rename wrote project.json ${writes} times`).toBeLessThanOrEqual(2);
		expect(writes).toBeGreaterThan(0);
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1626');
	});
});
