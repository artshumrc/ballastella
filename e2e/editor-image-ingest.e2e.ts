import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { waitForStoredLayers } from './support/saved';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	addMapImageButton,
	addMapImageFromFile,
	addMapImageIsOpen,
	expectNothingPreparing,
	openAddMapImage,
	pickMapImageFile,
	preparingCard
} from './support/map-images.js';
import { gradientPng, pngChunk } from './support/alignment-workspace.js';
import { createProject } from './support/annotations.js';
import { readJson } from './support/stored-file.js';
import { emptyWorkspace, everyByteOf } from './support/workspace.js';

test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

function pngHeaderOnly(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', ihdr),
		pngChunk('IEND', Buffer.alloc(0))
	]);
}

const storedFiles = (page: Page) => everyByteOf(page, DEFAULT_WORKSPACE);

async function recordAnnouncements(page: Page): Promise<void> {
	await page.evaluate(() => {
		const seen: string[] = [];
		(window as unknown as { announced: string[] }).announced = seen;
		new MutationObserver(() => {
			for (const region of document.querySelectorAll('[role="status"], [aria-live]')) {
				const text = region.textContent?.replace(/\s+/g, ' ').trim() ?? '';
				if (text && seen[seen.length - 1] !== text) seen.push(text);
			}
		}).observe(document.body, { childList: true, subtree: true, characterData: true });
	});
}

const announcements = (page: Page): Promise<string[]> =>
	page.evaluate(() => (window as unknown as { announced: string[] }).announced);

test.describe('adding a Map Image from a file', () => {
	const requested: string[] = [];

	test.beforeEach(async ({ page }) => {
		requested.length = 0;
		page.on('request', (request) => requested.push(request.url()));
		await page.goto('/');
		await emptyWorkspace(page);
		await page.reload();
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(addMapImageButton(page)).toBeVisible();
	});

	const expectNothingAdded = async (page: Page) => {
		await expect(page.getByText('This Project has no Map Images yet.')).toBeVisible();
		expect(Object.keys(await storedFiles(page))).toEqual(['amsterdam-1625/project.json']);
	};

	test('turns a picked file into a pyramid in the Project, with progress announced, that is there on reopening', async ({
		page
	}) => {
		await expect(page.getByText('This Project has no Map Images yet.')).toBeVisible();

		await recordAnnouncements(page);

		await pickMapImageFile(page, {
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(700, 500)
		});

		await expect(page.getByTestId('layer-row')).toHaveCount(1, { timeout: 30_000 });
		await expect(page.getByText('This Project has no Map Images yet.')).toBeHidden();

		const said = await announcements(page);
		expect(said.some((text) => /Reading la-floride\.png/.test(text))).toBe(true);
		expect(said.filter((text) => /tile \d+ of 9/.test(text)).length).toBeGreaterThan(1);

		await expect(page.getByRole('progressbar')).toHaveCount(0);

		const imageId = (await page.getByTestId('layer-row').first().getAttribute('data-image-id'))!;
		expect(imageId).toMatch(/^[0-9a-f]{16}$/);
		const files = await storedFiles(page);
		const tiles = Object.keys(files).filter((path) => path.endsWith('/0/default.jpg'));
		expect(files[`images/${imageId}/info.json`]).toBeTruthy();
		expect(files[`images/${imageId}/manifest.json`]).toBeTruthy();
		expect(Object.keys(files).filter((path) => path.startsWith('amsterdam-1625/'))).toEqual([
			'amsterdam-1625/project.json'
		]);

		expect(JSON.parse(files[`images/${imageId}/info.json`]!)).toMatchObject({
			id: `https://unset.invalid/${imageId}`,
			profile: 'level0',
			width: 700,
			height: 500,
			tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4] }]
		});

		expect(tiles.sort()).toEqual(
			[
				'0,0,256,256/256,256',
				'256,0,256,256/256,256',
				'512,0,188,256/188,256',
				'0,256,256,244/256,244',
				'256,256,256,244/256,244',
				'512,256,188,244/188,244',
				'0,0,512,500/256,250',
				'512,0,188,500/94,250',
				'0,0,700,500/175,125'
			]
				.map((cell) => `images/${imageId}/${cell}/0/default.jpg`)
				.sort()
		);

		expect(requested.filter((url) => /\.wasm$/i.test(url))).toEqual([]);

		await waitForStoredLayers(page, 1);
		await page.reload();
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
	});

	test('refuses a non-image, and a scan above the decode ceiling by its size, adding nothing', async ({
		page
	}) => {
		const alert = page.getByRole('alert');

		await pickMapImageFile(page, {
			name: 'notes.txt',
			mimeType: 'text/plain',
			buffer: Buffer.from('this is not a map')
		});
		await expect(alert).toContainText('could not be read as an image');
		await expectNothingAdded(page);

		await pickMapImageFile(page, {
			name: 'archival-master.png',
			mimeType: 'image/png',
			buffer: pngHeaderOnly(30_000, 20_000)
		});
		await expect(alert).toContainText('600 megapixels');
		await expect(alert).toContainText('528 megapixel');
		await expect(alert).toContainText('IIIF pyramid outside the browser');
		await expect(alert, 'the refusal blames the file instead of its size').not.toContainText(
			'could not be read as an image'
		);
		for (const word of ['COOP', 'COEP', 'Cross-Origin', 'cross-origin', 'SharedArrayBuffer']) {
			await expect(alert, word).not.toContainText(word);
		}
		await expectNothingAdded(page);
		expect(requested.filter((url) => /\.wasm$/i.test(url))).toEqual([]);

		await pickMapImageFile(page, {
			name: 'archival-master.png',
			mimeType: 'image/png',
			buffer: pngHeaderOnly(20_000, 15_000)
		});
		await expect(alert, 'a 300 megapixel scan is still refused for its size').toContainText(
			'could not be read as an image'
		);
		await expect(alert, 'the size check refused a file the browser would decode').not.toContainText(
			'megapixels'
		);
	});

	test('the Layer appears first, reports its own preparation on its card, and refuses a second file meanwhile', async ({
		page
	}) => {
		await recordAnnouncements(page);
		await pickMapImageFile(page, {
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(2600, 2600)
		});

		const stack = page.getByRole('list', { name: 'Layers, top first' });
		const card = stack.getByTestId('preparing-layer');
		await expect(card).toBeVisible();
		await expect(card.getByTestId('preparing-layer-name')).toHaveText('la-floride.png');
		await expect(card.getByTestId('preparing-layer-status')).toContainText(/tile \d+ of 171/);
		await expect(card.getByRole('progressbar')).toBeVisible();
		await expect(
			card.getByRole('button', { name: 'Cancel preparing la-floride.png' })
		).toBeVisible();
		await expect(page.getByRole('status')).toHaveCount(1);

		const dialog = await openAddMapImage(page);
		const input = dialog.getByLabel('Add a Map Image from a file');
		await expect(input).toBeDisabled();
		await expect(dialog.getByTestId('ingest-busy')).toContainText('la-floride.png');
		await input.setInputFiles({
			name: 'second.png',
			mimeType: 'image/png',
			buffer: gradientPng(300, 200)
		});
		await expect.poll(() => addMapImageIsOpen(page)).toBe(false);
		const refusal = page.getByRole('alert');
		await expect(refusal).toContainText('“second.png” was not added');
		await expect(refusal).toContainText('“la-floride.png” is still being prepared');

		await expect
			.poll(
				async () =>
					(await announcements(page)).filter((text) => /tile \d+ of 171/.test(text)).length
			)
			.toBeGreaterThan(1);
		expect(await readJson(page, 'amsterdam-1625', 'project.json')).toMatchObject({ layers: [] });

		await expect(page.getByTestId('layer-row')).toHaveCount(1, { timeout: 120_000 });
		await expectNothingPreparing(page);
		await expect(page.getByTestId('layer-row').first().getByTestId('layer-name-text')).toHaveText(
			'la-floride.png'
		);
	});

	test('picking the same file twice in a row starts two preparations', async ({ page }) => {
		const file = {
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(280, 200)
		};
		await addMapImageFromFile(page, file);

		const dialog = await openAddMapImage(page);
		await expect(dialog.getByTestId('add-from-file')).toHaveValue('');
		await page.keyboard.press('Escape');

		await addMapImageFromFile(page, file, { layers: 2 });

		const ids = await page
			.getByTestId('layer-row')
			.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-image-id')));
		expect(ids).toHaveLength(2);
		expect(ids[0]).not.toBe(ids[1]);
		const files = await storedFiles(page);
		for (const id of ids) expect(files[`images/${id}/info.json`]).toBeTruthy();
	});

	test('a user can stop an ingest, and nothing is left behind', async ({ page }) => {
		await pickMapImageFile(page, {
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(2600, 2600)
		});

		const cancel = preparingCard(page).getByRole('button', {
			name: 'Cancel preparing la-floride.png'
		});
		await expect(cancel).toBeEnabled();
		await cancel.click();

		await expectNothingPreparing(page, 30_000);
		await expect(page.getByRole('progressbar')).toHaveCount(0);
		await expect(page.getByRole('alert')).toHaveCount(0);
		await expect(page.getByTestId('layer-row')).toHaveCount(0);
		await expectNothingAdded(page);
		expect(await readJson(page, 'amsterdam-1625', 'project.json')).toMatchObject({ layers: [] });
	});
});
