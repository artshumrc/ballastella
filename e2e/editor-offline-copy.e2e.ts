import { expect, test, type Locator, type Page } from './support/test.js';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { seed } from './support/github-hosts.js';
import {
	communityAnnotation,
	generateId,
	installIiifHosts,
	service,
	singleCanvas
} from './support/iiif-hosts.js';
import { openLayerRow } from './support/layers.js';
import { ensureAddMapImageOpen, freshProject } from './support/map-images.js';
import { readJson } from './support/stored-file.js';

test.beforeEach(async ({ page }) => routeBaseMapArchive(page));

const FLORIDA = service('images.test', 'florida');
const FLORIDA_ID = generateId(FLORIDA);

async function start(page: Page, community = false): Promise<void> {
	await installIiifHosts(page, {
		manifestCanvases: singleCanvas,
		...(community ? { communityAnnotations: [communityAnnotation('images.test', 'florida')] } : {})
	});
	await freshProject(page);
}

const listWorkspaceFiles = (page: Page): Promise<string[]> =>
	page.evaluate(async () => {
		const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<string[]> => {
			const found: string[] = [];
			for await (const [name, entry] of handle.entries()) {
				const path = prefix === '' ? name : `${prefix}/${name}`;
				if (entry.kind === 'directory') {
					found.push(...(await walk(entry as FileSystemDirectoryHandle, path)));
				} else {
					found.push(path);
				}
			}
			return found;
		};
		try {
			return (await walk(await workspaceRoot(), ''))
				.filter((path) => !path.includes('ballastella-tmp'))
				.sort();
		} catch {
			return [];
		}
	});

async function addFromManifest(page: Page, community = false): Promise<Locator> {
	await ensureAddMapImageOpen(page);
	await page.getByTestId('remote-url').fill('https://library.test/iiif/atlas/manifest.json');
	await page.getByTestId('remote-read').click();
	await expect(page.getByTestId(community ? 'community-offer' : 'remote-add')).toBeVisible();
	await page.getByTestId('remote-add').click();
	return expectReferencedLayer(page);
}

async function addReferenced(page: Page, host: string, name = 'florida'): Promise<void> {
	await ensureAddMapImageOpen(page);
	await page.getByTestId('remote-url').fill(`${service(host, name)}/info.json`);
	await page.getByTestId('remote-read').click();
	await expect(page.getByTestId('remote-add')).toBeVisible();
	await page.getByTestId('remote-add').click();
	await expectReferencedLayer(page);
}

/**
 * Wait until a referenced Map Image is on the Project screen, and leave its Layer open.
 *
 * The library a referenced map's tiles come from — and the "Make an offline copy" offer beside it —
 * are *inside* the Layer that fetches them, so seeing either is opening the row.
 */
async function expectReferencedLayer(page: Page): Promise<Locator> {
	const row = await openLayerRow(page);
	await expect(row.getByTestId('layer-image-mode')).toHaveText('Source: External IIIF');
	await expect(row.getByTestId('referenced-image-host')).toBeVisible();
	return row;
}

async function expectOfflineCopyLayer(page: Page): Promise<Locator> {
	const row = await openLayerRow(page);
	await expect(row.getByTestId('layer-image-mode')).toHaveText('Source: Local');
	await expect(row.getByTestId('layer-image-mode')).toHaveAttribute(
		'data-image-mode',
		'offline-copy'
	);
	await expect(row.getByTestId('offline-copy-source')).toHaveText(FLORIDA);
	await expect(row.getByTestId('referenced-image-host')).toHaveCount(0);
	return row;
}

async function openMirrorDialog(page: Page): Promise<void> {
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	const row = await openLayerRow(page);
	await row.getByTestId('offline-copy-open').click();
	await expect(page.getByRole('dialog', { name: 'Make an offline copy' })).toBeVisible();
	await expect(page.getByTestId('offline-copy-status')).toHaveAttribute('data-step', 'deciding');
}

const expectCopied = (page: Page, timeout = 30_000) =>
	expect(page.getByTestId('offline-copy-done')).toContainText('offline copy in this Project', {
		timeout
	});

async function copyOffline(page: Page, timeout?: number): Promise<void> {
	await openMirrorDialog(page);
	await page.getByTestId('offline-copy-start').click();
	await expectCopied(page, timeout);
}

function watchRequests(page: Page, pattern?: RegExp) {
	const library: string[] = [];
	const placeholder: string[] = [];
	const all: string[] = [];
	const listener = (request: { url(): string }) => {
		const url = request.url();
		all.push(url);
		if (url.includes('images.test')) library.push(url);
		if (url.includes('unset.invalid')) placeholder.push(url);
	};
	page.on('request', listener);
	return {
		library,
		placeholder,
		images: () => all.filter((url) => (pattern ?? /default\.(jpg|png)$/).test(url)),
		stop: () => page.off('request', listener)
	};
}

const hubPicture = (page: Page) =>
	page
		.getByTestId('map-image')
		.getByTestId('map-thumbnail-image')
		.evaluate((element) => {
			const image = element as HTMLImageElement;
			return {
				src: image.getAttribute('src') ?? '',
				loading: image.getAttribute('loading'),
				decoded: { width: image.naturalWidth, height: image.naturalHeight }
			};
		})
		.catch((error: unknown) => {
			if (error instanceof Error && error.message.includes('strict mode violation')) throw error;
			return null;
		});

async function drawTheStack(
	page: Page,
	via: 'link' | 'load',
	directory = 'amsterdam-1625'
): Promise<void> {
	if (via === 'link') await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	else await page.goto(`/?p=${directory}`);
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
}

const alignmentSource = async (page: Page): Promise<string> =>
	(
		(await readJson(page, '', `alignments/${FLORIDA_ID}.json`)) as {
			target: { source: { id: string } };
		}
	).target.source.id;

test.describe('making an offline copy', () => {
	test('is offered per image on a referenced Layer, and says what the library said about rights first', async ({
		page
	}) => {
		await start(page);
		const offeredRow = await addFromManifest(page);

		await expect(page.getByTestId('layer-sidebar')).toBeVisible();
		await expect(offeredRow.getByTestId('offline-copy-open')).toHaveCount(1);
		await expect(page.getByTestId('offline-copy-open')).toHaveCount(1);

		const requests = watchRequests(page);
		await openMirrorDialog(page);

		const rights = page.getByTestId('offline-copy-rights');
		await expect(rights).toContainText('creativecommons.org/licenses/by/4.0');
		await expect(rights).toContainText('Provided by the Example Library');
		await expect(rights.locator('a')).toHaveCount(0);
		expect(requests.images()).toEqual([]);
	});

	test('warns explicitly about the ~1 GB hosting limit and still lets the copy proceed', async ({
		page
	}) => {
		await start(page);
		await page.evaluate(async () => {
			const handle = await (await workspaceRoot()).getFileHandle('ballast.bin', { create: true });
			const writable = await handle.createWritable();
			await writable.truncate(700_000_000);
			await writable.close();
		});
		await addReferenced(page, 'large.test', 'enormous');
		await openMirrorDialog(page);

		const warning = page.getByTestId('offline-copy-hosting-warning');
		await expect(warning).toBeVisible();
		await expect(warning).toContainText('1.0 GB');
		await expect(warning).toContainText('GitHub Pages');
		await expect(warning).toContainText('You can still make the copy');
		await expect(page.getByTestId('offline-copy-start')).toBeEnabled();
	});

	test('refuses a copy of a source above the decode cap, before it fetches anything', async ({
		page
	}) => {
		await start(page);
		await addReferenced(page, 'huge.test', 'enormous');

		const requests = watchRequests(page);
		await openMirrorDialog(page);

		const refusal = page.getByTestId('offline-copy-refusal');
		await expect(refusal).toBeVisible();
		await expect(refusal).toContainText('1440 megapixels');
		await expect(refusal).toContainText('outside the browser');
		await expect(refusal).toContainText('still works, read from huge.test');
		for (const word of ['SharedArrayBuffer', 'COOP', 'COEP', 'streaming tiler']) {
			await expect(refusal, word).not.toContainText(word);
		}

		await expect(page.getByTestId('offline-copy-start')).toBeDisabled();
		expect(requests.images()).toEqual([]);
	});

	test('sizes the copy against the Workspace, fetches a level-2 source whole, and leaves a pyramid indistinguishable from a local one', async ({
		page
	}) => {
		await start(page);
		await addReferenced(page, 'images.test');
		const requests = watchRequests(page, /images\.test.*default\.(jpg|png)$/);
		await openMirrorDialog(page);

		const size = page.getByTestId('offline-copy-size');
		await expect(size).toContainText('245 kB');
		await expect(size).toContainText('this Workspace already holds');
		await expect(size).toContainText('files');
		await expect(page.getByTestId('offline-copy-hosting-warning')).toHaveCount(0);
		await expect(page.getByTestId('offline-copy-note')).toHaveCount(0);
		await page.getByTestId('offline-copy-start').click();
		await expectCopied(page);

		expect(requests.images()).toEqual([`${FLORIDA}/full/max/0/default.jpg`]);

		expect(FLORIDA_ID).toMatch(/^[0-9a-f]{16}$/);
		const files = await listWorkspaceFiles(page);
		const tiles = files.filter((path) => path.endsWith('/default.jpg'));
		expect(tiles).toHaveLength(9);
		for (const path of tiles) expect(path.startsWith(`images/${FLORIDA_ID}/`)).toBe(true);
		expect(files).toEqual(
			expect.arrayContaining(
				['info.json', 'manifest.json', 'remote.json'].map((name) => `images/${FLORIDA_ID}/${name}`)
			)
		);
		expect(tiles).toContain(`images/${FLORIDA_ID}/0,0,256,256/256,256/0/default.jpg`);
		expect(tiles).toContain(`images/${FLORIDA_ID}/512,256,188,244/188,244/0/default.jpg`);

		const info = (await readJson(page, '', `images/${FLORIDA_ID}/info.json`)) as Record<
			string,
			unknown
		>;
		expect(info).toMatchObject({
			id: `https://unset.invalid/${FLORIDA_ID}`,
			profile: 'level0',
			tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4] }]
		});
		expect(JSON.stringify(info)).not.toContain('images.test');

		const project = (await readJson(page, 'amsterdam-1625', 'project.json')) as {
			layers: unknown[];
		};
		expect(project.layers).toHaveLength(1);
		expect(project.layers[0]).toMatchObject({ kind: 'map', imageId: FLORIDA_ID });
		await expect(page.getByTestId('layer-sidebar')).toBeVisible();
		await expectOfflineCopyLayer(page);
	});

	for (const { title, host, name, note, ownTiles } of [
		{
			title:
				'copies a level-0 source from its own tiles, having warned that it means many requests',
			host: 'static.test',
			name: 'pyramid',
			note: ['static.test', '6 separate requests', 'somebody else'],
			ownTiles: true
		},
		{
			title: 'respects a declared maxWidth rather than making a request the service has said no to',
			host: 'capped.test',
			name: 'capped',
			note: ['400'],
			ownTiles: false
		}
	]) {
		test(title, async ({ page }) => {
			await start(page);
			await addReferenced(page, host, name);
			const requests = watchRequests(page, new RegExp(`${host}.*default\\.(jpg|png)$`));

			await openMirrorDialog(page);
			for (const text of note)
				await expect(page.getByTestId('offline-copy-note')).toContainText(text);
			await page.getByTestId('offline-copy-start').click();
			await expectCopied(page);

			const images = requests.images();
			expect(images).toHaveLength(6);
			expect(images.some((url) => url.includes('/full/'))).toBe(false);
			if (ownTiles) {
				for (const url of images) expect(url).toMatch(/\/(\d+),(\d+),(\d+),(\d+)\/\3,\4\/0\//);
			}
		});
	}

	test('reports progress, and announces it to assistive technology', async ({ page }) => {
		await start(page);
		await addReferenced(page, 'slow.test', 'slow');
		await openMirrorDialog(page);
		await page.getByTestId('offline-copy-start').click();

		const progress = page.getByTestId('offline-copy-progress');
		await expect(progress).toBeVisible();
		await expect(progress).toContainText('slow.test');
		await expect(progress).toContainText(/fetched \d+ of 48 tiles/);
		await expect(page.locator('[aria-live="polite"]', { has: progress })).toHaveAttribute(
			'aria-atomic',
			'true'
		);
		await expect(page.getByRole('progressbar', { name: /Making an offline copy/ })).toBeVisible();

		await expect(progress).toContainText(/tile \d+ of \d+/, { timeout: 60_000 });
		await expectCopied(page, 60_000);
	});

	test('leaves no partial pyramid when the copy is cancelled, and the Layer keeps working', async ({
		page
	}) => {
		await start(page);
		await addReferenced(page, 'slow.test', 'slow');
		const before = await listWorkspaceFiles(page);

		await openMirrorDialog(page);
		await page.getByTestId('offline-copy-start').click();
		await expect(page.getByTestId('offline-copy-progress')).toContainText(/fetched [1-9]\d* of 48/);

		await page.getByTestId('offline-copy-cancel').click();
		await expect(page.getByTestId('offline-copy-error')).toContainText('cancelled');
		expect(await listWorkspaceFiles(page)).toEqual(before);

		await page.getByTestId('offline-copy-dismiss').click();
		await expect(readJson(page, '', `images/${FLORIDA_ID}/info.json`)).rejects.toThrow();
		await expect(
			(await expectReferencedLayer(page)).getByTestId('offline-copy-source')
		).toHaveCount(0);
	});

	test('leaves the Layer referenced and working when the copy fails', async ({ page }) => {
		await start(page);
		await addReferenced(page, 'broken.test', 'broken');
		const before = await listWorkspaceFiles(page);

		await openMirrorDialog(page);
		await page.getByTestId('offline-copy-start').click();

		const error = page.getByTestId('offline-copy-error');
		await expect(error).toContainText('broken.test');
		await expect(error).toContainText('500');
		await expect(error).toContainText('still works');
		expect(await listWorkspaceFiles(page)).toEqual(before);

		await page.getByTestId('offline-copy-dismiss').click();
		await expect(
			readJson(page, '', `images/${generateId(service('broken.test', 'broken'))}/info.json`)
		).rejects.toThrow();
		await expect(page.getByTestId('offline-copy-open')).toBeVisible();
	});

	test('is reachable and operable by keyboard alone', async ({ page }) => {
		await start(page);
		await addReferenced(page, 'images.test');
		await expect(page.getByTestId('layer-sidebar')).toBeVisible();

		const button = page.getByTestId('offline-copy-open');
		await button.focus();
		await expect(button).toBeFocused();
		await page.keyboard.press('Enter');

		const dialog = page.getByRole('dialog', { name: 'Make an offline copy' });
		await expect(dialog).toBeVisible();
		await expect(page.getByTestId('offline-copy-size')).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(button).toBeFocused();

		await page.keyboard.press('Enter');
		await expect(page.getByTestId('offline-copy-start')).toBeEnabled();
		await page.getByTestId('offline-copy-start').focus();
		await page.keyboard.press('Enter');
		await expectCopied(page);
	});

	test('moves the keyboard onto Cancel when the copy starts, and back when it ends', async ({
		page
	}) => {
		await start(page);
		await addReferenced(page, 'slow.test', 'slow');
		await openMirrorDialog(page);

		await page.getByTestId('offline-copy-start').focus();
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('offline-copy-cancel')).toBeFocused();

		await page.keyboard.press('Enter');
		await expect(page.getByTestId('offline-copy-error')).toContainText('cancelled');
		await expect(page.getByTestId('offline-copy-start')).toBeFocused();
	});
});

test.describe('a copied Map Image, once it is copied', () => {
	test('renders warped from one pyramid that two Projects both draw, with no request to the library at all', async ({
		page
	}) => {
		test.slow();
		await start(page, true);
		await addFromManifest(page, true);

		expect(await alignmentSource(page)).toBe(FLORIDA);
		const beforeCopy = watchRequests(page);
		await drawTheStack(page, 'link');
		expect(beforeCopy.library.length).toBeGreaterThan(0);
		beforeCopy.stop();

		await page.goto('/?p=amsterdam-1625');
		await expectReferencedLayer(page);
		await copyOffline(page, 60_000);

		const copiedAlignment = (await readJson(page, '', `alignments/${FLORIDA_ID}.json`)) as {
			body: { features: unknown[] };
		};
		expect(await alignmentSource(page)).toBe(`https://unset.invalid/${FLORIDA_ID}`);
		expect(copiedAlignment.body.features).toHaveLength(3);
		const afterCopy = watchRequests(page);
		await drawTheStack(page, 'link');
		expect(afterCopy.library).toEqual([]);
		expect(afterCopy.placeholder).toEqual([]);
		afterCopy.stop();

		await seed(page, {
			'boston-1775/project.json': JSON.stringify({
				formatVersion: 1,
				name: 'A second argument',
				updatedAt: '2026-01-02T03:04:05.000Z',
				layers: [
					{
						kind: 'map',
						id: 'l-shared',
						name: 'The same sheet, in another argument',
						visible: true,
						order: 0,
						opacity: 1,
						imageId: FLORIDA_ID
					}
				],
				baseMap: null
			})
		});
		await page.reload();

		const files = await listWorkspaceFiles(page);
		expect(files.filter((path) => path.endsWith(`images/${FLORIDA_ID}/info.json`))).toEqual([
			`images/${FLORIDA_ID}/info.json`
		]);
		expect(files.filter((path) => path.startsWith('alignments/'))).toEqual([
			`alignments/${FLORIDA_ID}.json`
		]);
		expect(files.filter((path) => path.startsWith('boston-1775/'))).toEqual([
			'boston-1775/project.json'
		]);

		for (const directory of ['amsterdam-1625', 'boston-1775'] as const) {
			const watched = watchRequests(page);
			await drawTheStack(page, 'load', directory);
			expect(watched.library, `${directory} went back to the library`).toEqual([]);
			watched.stop();
			await expect((await openLayerRow(page)).getByTestId('layer-image-mode')).toHaveAttribute(
				'data-image-mode',
				'offline-copy'
			);
		}
	});

	test('shows the hub’s picture of it from the Workspace instead of from the library', async ({
		page
	}) => {
		await start(page);
		await addReferenced(page, 'images.test');
		const beforeCopy = watchRequests(page);
		await page.getByTestId('all-projects').click();
		await expect(page.getByTestId('map-image')).toHaveCount(1);
		await page.getByTestId('map-thumbnail-image').scrollIntoViewIfNeeded();
		await expect
			.poll(() => hubPicture(page), { timeout: 20_000 })
			.toEqual({
				src: expect.stringMatching(/^https:\/\/images\.test\//),
				loading: 'lazy',
				decoded: { width: 175, height: 125 }
			});
		expect(beforeCopy.library.length).toBeGreaterThan(0);
		beforeCopy.stop();

		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expectReferencedLayer(page);
		await copyOffline(page, 60_000);

		const afterCopy = watchRequests(page);
		await page.getByTestId('all-projects').click();
		await expect(page.getByTestId('map-image')).toHaveCount(1);
		await expect
			.poll(() => hubPicture(page), { timeout: 20_000 })
			.toEqual({
				src: expect.stringMatching(/^blob:/),
				loading: null,
				decoded: { width: 175, height: 125 }
			});
		expect(afterCopy.library).toEqual([]);
		expect(afterCopy.placeholder).toEqual([]);
		afterCopy.stop();

		expect(await readJson(page, '', `images/${FLORIDA_ID}/remote.json`)).toMatchObject({
			service: FLORIDA
		});
	});

	test('survives a reload with the network switched off, drawing from the Project', async ({
		page
	}) => {
		test.slow();
		await page.addInitScript(() => {
			window.ballastellaServedTiles = [];
		});
		await start(page);
		await addReferenced(page, 'images.test');

		expect(await page.evaluate(() => window.ballastellaServedTiles ?? [])).toEqual([]);
		await copyOffline(page);
		await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

		const requests = watchRequests(page);
		await page.context().setOffline(true);
		try {
			await page.reload();
			const copiedRow = await expectOfflineCopyLayer(page);
			await expect(page.getByTestId('layer-row')).toHaveCount(1);

			await copiedRow.getByTestId('align-map-image').click();
			await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);
			await expect
				.poll(() => page.evaluate(() => (window.ballastellaServedTiles ?? []).length), {
					timeout: 30_000
				})
				.toBeGreaterThan(0);
			const served = await page.evaluate(() => window.ballastellaServedTiles ?? []);
			for (const tile of served) {
				expect(tile.url.startsWith(`https://unset.invalid/${FLORIDA_ID}/`)).toBe(true);
				expect([1, 2, 4]).toContain(tile.scaleFactor);
			}
			expect(requests.library).toEqual([]);
		} finally {
			await page.context().setOffline(false);
		}
	});
});
