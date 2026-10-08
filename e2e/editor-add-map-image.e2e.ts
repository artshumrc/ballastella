import { expect, test, type Locator, type Page } from './support/test.js';

import {
	gradientPng,
	makePairs,
	maskPointsAttribute,
	start,
	storedAlignment,
	waitForStored
} from './support/alignment-workspace.js';
import { baseMap, chooseTool, clickAt, createProject, openLayers } from './support/annotations.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	addMapImageButton,
	addMapImageFromFile,
	addMapImageIsOpen,
	ensureAddMapImageOpen,
	openAddMapImage,
	pickMapImageFile,
	preparingCard
} from './support/map-images.js';
import { installIiifHosts, service } from './support/iiif-hosts.js';
import { deleteLayerRow, layerRows, openLayerRow } from './support/layers.js';
import { waitForStoredLayers } from './support/saved.js';
import { seedFile } from './support/stored-file.js';
import { emptyWorkspace } from './support/workspace.js';

test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

const imageFiles = (page: Page): Promise<string[]> =>
	page.evaluate(async () => {
		const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<string[]> => {
			const found: string[] = [];
			for await (const [name, entry] of handle.entries()) {
				if (entry.kind === 'file') found.push(`${prefix}${name}`);
				else found.push(...(await walk(entry as FileSystemDirectoryHandle, `${prefix}${name}/`)));
			}
			return found;
		};
		const root = await workspaceRoot();
		try {
			return (await walk(await root.getDirectoryHandle('images'), 'images/')).sort();
		} catch {
			return [];
		}
	});

async function openProject(page: Page, name: string, directory: string): Promise<void> {
	await createProject(page, name);
	await page.getByRole('link', { name }).click();
	await openLayers(page, directory);
}

async function emptyProject(page: Page): Promise<void> {
	await page.goto('/');
	await emptyWorkspace(page);
	await page.reload();
	await openProject(page, 'Amsterdam 1625', 'amsterdam-1625');
}

async function addFlorida(page: Page, width = 280, height = 200): Promise<void> {
	await addMapImageFromFile(page, {
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(width, height)
	});
	await waitForStoredLayers(page, 1, 'amsterdam-1625');
}

async function secondProject(page: Page): Promise<void> {
	await page.goto('/');
	await openProject(page, 'Boston 1775', 'boston-1775');
}

test.describe('adding a Map Image', () => {
	test('offers all three sources at once in a modal that Escape closes, and the empty Project names its button', async ({
		page
	}) => {
		await emptyProject(page);

		const button = addMapImageButton(page);
		await expect(button).toBeVisible();
		await expect(button).toHaveText('Map Image');
		await expect(button).toHaveAccessibleName('Add a Map Image');
		const label = (await button.textContent())!.trim();
		await expect(page.getByTestId('no-layers')).toContainText(label);
		await expect(page.getByTestId('no-map-images')).toContainText(label);

		const dialog = await openAddMapImage(page);
		expect(
			await dialog.evaluate((element) => element.matches(':modal')),
			'the Add a Map Image dialog was not opened with showModal()'
		).toBe(true);
		await expect(dialog.getByLabel('Add a Map Image from a file')).toBeEnabled();
		await expect(dialog.getByTestId('remote-url')).toBeEditable();
		await expect(dialog.getByTestId('no-workspace-maps')).toContainText(
			'This Workspace holds no Map Images yet'
		);

		await page.keyboard.press('Escape');
		await expect.poll(() => addMapImageIsOpen(page)).toBe(false);
		await expect(button).toBeFocused();
	});

	test('lists the Workspace’s other maps with their sizes once it has looked, leaves out the ones this Project has, and reaches every control by keyboard', async ({
		page
	}) => {
		await emptyProject(page);
		await addFlorida(page);

		let dialog = await openAddMapImage(page);
		await expect(dialog.getByTestId('workspace-map')).toHaveCount(0);
		await expect(dialog.getByTestId('no-workspace-maps')).toContainText('already in this Project');
		await page.getByTestId('close-add-map-image').click();

		await secondProject(page);
		await page.evaluate(() => {
			const seen = { saw: false };
			(window as unknown as { __loadingSeen: typeof seen }).__loadingSeen = seen;
			const look = () => {
				if (document.querySelector('[data-testid="workspace-maps-loading"]')) seen.saw = true;
			};
			new MutationObserver(look).observe(document.body, { subtree: true, childList: true });
			look();
		});

		dialog = await openAddMapImage(page);
		const offered = dialog.getByTestId('workspace-map');
		await expect(offered).toHaveCount(1);
		expect(
			await page.evaluate(
				() => (window as unknown as { __loadingSeen: { saw: boolean } }).__loadingSeen.saw
			),
			'the picker never said it was looking through the Workspace'
		).toBe(true);
		await expect(offered).toContainText('la-floride.png');
		await expect(offered).toContainText(/\d+(\.\d+)?\s?(B|kB|MB|GB)/);
		await expect(offered).toContainText(/\d+ files/);

		const wanted = await page.evaluate(() => {
			const dialog = document.querySelector('dialog[open]')!;
			return [...dialog.querySelectorAll('a[href], button, input, select, textarea')]
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
		expect(wanted.length).toBeGreaterThan(4);
		const reached = new Set<string>();
		for (let step = 0; step < wanted.length * 3 + 10; step++) {
			await page.keyboard.press('Tab');
			const seen = await page.evaluate(
				() => document.activeElement?.getAttribute('data-e2e-control') ?? null
			);
			if (seen !== null) reached.add(seen);
			if (reached.size === wanted.length) break;
		}
		expect([...wanted].filter((id) => !reached.has(id))).toEqual([]);
	});

	test('adds an aligned Workspace map to another Project, drawing it and copying nothing', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePairs(page, 3);
		await waitForStored(page, imageId, 3);
		const alignedBytes = await storedAlignment(page, imageId);
		const before = await imageFiles(page);
		expect(before.length).toBeGreaterThan(0);

		await secondProject(page);
		await (await openAddMapImage(page)).getByTestId('workspace-map').click();

		await expect(layerRows(page)).toHaveCount(1);
		await expect(layerRows(page).first()).toHaveAttribute('data-image-id', imageId);
		await expect((await openLayerRow(page)).getByTestId('layer-not-aligned')).toHaveCount(0);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1', {
			timeout: 30_000
		});
		expect(await imageFiles(page)).toEqual(before);
		expect(await storedAlignment(page, imageId)).toBe(alignedBytes);
	});

	test('offers a pyramid whose Alignment never landed, and adding it writes one', async ({
		page
	}) => {
		await emptyProject(page);
		await addFlorida(page);
		const imageId = (await layerRows(page).first().getAttribute('data-image-id'))!;

		await deleteLayerRow(page);
		await waitForStoredLayers(page, 0, 'amsterdam-1625');
		await page.evaluate(async (name) => {
			await (await (await workspaceRoot()).getDirectoryHandle('alignments')).removeEntry(name);
		}, `${imageId}.json`);

		await page.reload();
		await openLayers(page, 'amsterdam-1625');
		await expect(page.getByTestId('no-map-images')).toBeVisible();

		const offered = (await openAddMapImage(page)).getByTestId('workspace-map');
		await expect(offered).toHaveCount(1);
		await offered.click();

		await expect(layerRows(page)).toHaveCount(1);
		await waitForStoredLayers(page, 1, 'amsterdam-1625');
		const written = await storedAlignment(page, imageId);
		expect(written).not.toBeNull();
		expect(JSON.parse(written!).body.features).toEqual([]);
		expect(maskPointsAttribute(written!)).toBe('0,0 280,0 280,200 0,200');
	});
});

test.describe('the dialog itself (ADR-0016)', () => {
	test('is never handed to a caller while the panel inside it is still working', async ({
		page
	}) => {
		await installIiifHosts(page);
		await emptyProject(page);

		const address = `${service('images.test', 'florida')}/info.json`;
		await page.route(address, async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 3_000));
			await route.fallback();
		});

		await openAddMapImage(page);
		await page.getByTestId('remote-url').fill(address);
		await page.getByTestId('remote-read').click();
		await expect(page.getByTestId('remote-read')).toBeDisabled();
		expect(await addMapImageIsOpen(page)).toBe(true);
		const began = Date.now();
		await ensureAddMapImageOpen(page);
		const ensured = Date.now() - began;

		expect(ensured, 'the dialog was handed back while its panel was still working').toBeGreaterThan(
			1_500
		);
		await expect(page.getByTestId('remote-add')).toBeVisible({ timeout: 30_000 });
	});

	test('Escape that closes it does not abandon a part-drawn shape behind it', async ({ page }) => {
		await emptyProject(page);
		await page.getByTestId('add-annotation-layer').click();
		await expect(layerRows(page)).toHaveCount(1);
		await openLayerRow(page);

		await chooseTool(page, 'polygon');
		await clickAt(baseMap(page), 0.4, 0.4);
		await clickAt(baseMap(page), 0.6, 0.4);
		const drawingStatus = page.getByTestId('annotation-status');
		await expect(drawingStatus).toHaveAttribute('data-drawing', 'true');

		await openAddMapImage(page);
		await page.keyboard.press('Escape');
		await expect.poll(() => addMapImageIsOpen(page)).toBe(false);
		await expect(drawingStatus).toHaveAttribute('data-drawing', 'true');

		await page.keyboard.press('Escape');
		await expect(drawingStatus).toHaveAttribute('data-drawing', 'false');
	});
});

const candidate = (within: Page | Locator, label: string) =>
	within.getByTestId('workspace-map-row').filter({ hasText: label });

const decoded = (
	within: Page | Locator,
	label: string
): Promise<{ width: number; height: number }> =>
	candidate(within, label)
		.getByTestId('map-thumbnail-image')
		.evaluate((element) => ({
			width: (element as HTMLImageElement).naturalWidth,
			height: (element as HTMLImageElement).naturalHeight
		}))
		.catch(() => ({ width: 0, height: 0 }));

test.describe('adding a map this Workspace already holds', () => {
	test('shows a decoded picture of it, makes one Layer from two clicks, says so afterwards, and clears that on the next open', async ({
		page
	}) => {
		await emptyProject(page);
		await addFlorida(page, 700, 500);
		await secondProject(page);

		const notice = page.getByTestId('remote-notice');
		await expect(notice).toHaveText('');

		const dialog = await ensureAddMapImageOpen(page);
		await expect(dialog.getByTestId('workspace-map')).toHaveCount(1);
		await expect
			.poll(() => decoded(page, 'la-floride.png'), { timeout: 20_000 })
			.toEqual({ width: 175, height: 125 });
		const picture = candidate(page, 'la-floride.png').getByTestId('map-thumbnail-image');
		await expect(picture).toHaveAttribute('alt', '');
		expect(
			await picture.evaluate((element) => ({
				objectFit: getComputedStyle(element).objectFit,
				tabIndex: (element as HTMLImageElement).tabIndex,
				box: [element.parentElement!.clientWidth, element.parentElement!.clientHeight],
				picture: element.clientWidth
			}))
		).toEqual({ objectFit: 'contain', tabIndex: -1, box: [48, 48], picture: 48 });
		await expect(candidate(page, 'la-floride.png').locator('button img')).toHaveCount(0);

		await page.evaluate(() => {
			const button = document.querySelector<HTMLButtonElement>('[data-testid="workspace-map"]')!;
			button.click();
			button.click();
		});
		await expect(layerRows(page)).toHaveCount(1);
		await expect.poll(() => addMapImageIsOpen(page)).toBe(false);
		await waitForStoredLayers(page, 1, 'boston-1775');
		await expect(layerRows(page)).toHaveCount(1);
		await expect(notice).toContainText('la-floride.png');
		await expect(notice).toContainText('Nothing was copied');

		await openAddMapImage(page);
		await expect(notice).toHaveText('');
		await page.getByTestId('close-add-map-image').click();
		await expect(notice).toHaveText('');
	});

	test('adds one that entered this Workspace after the Project was opened', async ({ page }) => {
		await emptyProject(page);
		await expect(page.getByTestId('no-map-images')).toBeVisible();

		await seedFile(
			page,
			'images/florida-from-another-tab/remote.json',
			JSON.stringify({
				service: 'https://images.test/iiif/florida',
				label: 'Chart of the Florida coast',
				partOf: '',
				canvas: '',
				rights: '',
				attribution: '',
				width: 800,
				height: 600
			})
		);

		const offered = (await openAddMapImage(page)).getByTestId('workspace-map');
		await expect(offered).toHaveCount(1);
		await expect(offered).toContainText('Chart of the Florida coast');
		await offered.click();

		await expect(layerRows(page)).toHaveCount(1);
		await waitForStoredLayers(page, 1, 'amsterdam-1625');
		await expect(page.getByTestId('add-from-workspace-error')).toHaveCount(0);

		const written = await storedAlignment(page, 'florida-from-another-tab');
		expect(written).not.toBeNull();
		expect(maskPointsAttribute(written!)).toBe('0,0 800,0 800,600 0,600');
		expect(JSON.parse(written!).target.source.id).toContain('images.test');
	});

	test('refuses one whose record cannot be read, in words, with the dialog still open', async ({
		page
	}) => {
		await emptyProject(page);
		await seedFile(page, 'images/damaged-record/remote.json', '{ not json at all');

		const dialog = await openAddMapImage(page);
		const offered = dialog.getByTestId('workspace-map');
		await expect(offered).toHaveCount(1);
		await offered.click();

		const refusal = dialog.getByTestId('add-from-workspace-error');
		await expect(refusal).toBeVisible();
		await expect(refusal).toContainText('images/damaged-record/');
		expect(await addMapImageIsOpen(page)).toBe(true);
		await expect(layerRows(page)).toHaveCount(0);
		expect(await storedAlignment(page, 'damaged-record')).toBeNull();
	});

	test('shows the glyph and no broken image for a candidate whose picture cannot be resolved', async ({
		page
	}) => {
		await emptyProject(page);
		await seedFile(
			page,
			'images/no-geometry/info.json',
			JSON.stringify({
				'@context': 'http://iiif.io/api/image/3/context.json',
				id: 'https://unset.invalid/no-geometry',
				type: 'ImageService3',
				protocol: 'http://iiif.io/api/image',
				profile: 'level0',
				width: 700,
				height: 500
			})
		);
		await seedFile(
			page,
			'images/no-geometry/manifest.json',
			JSON.stringify({ label: { none: ['Carte sans mesures'] } })
		);

		const row = candidate(await ensureAddMapImageOpen(page), 'Carte sans mesures');
		await expect(row).toHaveCount(1);
		const glyph = row.getByTestId('map-thumbnail-glyph');
		await expect(glyph).toBeVisible();
		await expect(row.getByTestId('map-thumbnail-image')).toHaveCount(0);
		expect(await glyph.evaluate((element) => [element.clientWidth, element.clientHeight])).toEqual([
			48, 48
		]);
	});
});

test('does not say the Project has no Layers over a Layer that is being prepared', async ({
	page
}) => {
	await emptyProject(page);
	await pickMapImageFile(page, {
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(2600, 2600)
	});

	await expect(preparingCard(page)).toBeVisible();
	await expect(page.getByTestId('no-layers')).toHaveCount(0);
	await expect(page.getByTestId('no-map-images')).toHaveCount(0);

	await page.getByRole('button', { name: 'Cancel preparing la-floride.png' }).click();
	await expect(page.getByTestId('no-layers')).toBeVisible();
});
