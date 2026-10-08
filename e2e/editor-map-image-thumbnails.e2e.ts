import { expect, test, type Page } from './support/test.js';

import { openNewProject } from './support/annotations.js';
import { gradientPng } from './support/alignment-workspace.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { addMapImageFromFile } from './support/map-images.js';
import { installIiifHosts, service } from './support/iiif-hosts.js';
import { seedFile } from './support/stored-file.js';
import { emptyWorkspace } from './support/workspace.js';

test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

const card = (page: Page, label: string) =>
	page.getByTestId('map-image').filter({ hasText: label });

const decoded = (page: Page, label: string): Promise<{ width: number; height: number }> =>
	card(page, label)
		.getByTestId('map-thumbnail-image')
		.evaluate((element) => ({
			width: (element as HTMLImageElement).naturalWidth,
			height: (element as HTMLImageElement).naturalHeight
		}))
		.catch(() => ({ width: 0, height: 0 }));

test('a Map Image added from a file shows a picture that has actually decoded', async ({
	page
}) => {
	await page.goto('./');
	await emptyWorkspace(page);
	await page.reload();

	await openNewProject(page, 'La Floride');

	await addMapImageFromFile(page, {
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(700, 500)
	});

	await page.getByTestId('all-projects').click();
	await expect(page.getByTestId('map-image')).toHaveCount(1);

	await expect
		.poll(() => decoded(page, 'la-floride.png'), { timeout: 20_000 })
		.toEqual({ width: 175, height: 125 });

	const picture = card(page, 'la-floride.png').getByTestId('map-thumbnail-image');
	await expect(picture).toHaveAttribute('alt', '');
	expect(await picture.getAttribute('loading')).toBeNull();
	expect(
		await picture.evaluate((element) => ({
			objectFit: getComputedStyle(element).objectFit,
			tabIndex: (element as HTMLImageElement).tabIndex
		}))
	).toEqual({ objectFit: 'contain', tabIndex: -1 });

	expect(
		await picture.evaluate((element) => ({
			box: [element.parentElement!.clientWidth, element.parentElement!.clientHeight],
			picture: element.clientWidth
		}))
	).toEqual({ box: [96, 96], picture: 96 });
});

test('a referenced Map Image draws from its Library; one with no tile side, or no coarsest tile, keeps the glyph', async ({
	page
}) => {
	await installIiifHosts(page);
	await page.goto('./');
	await emptyWorkspace(page);
	await seedFile(
		page,
		'images/no-tiles/info.json',
		JSON.stringify({
			'@context': 'http://iiif.io/api/image/3/context.json',
			id: 'https://unset.invalid/no-tiles',
			type: 'ImageService3',
			protocol: 'http://iiif.io/api/image',
			profile: 'level0',
			width: 700,
			height: 500,
			tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4] }]
		})
	);
	await seedFile(
		page,
		'images/no-tiles/manifest.json',
		JSON.stringify({ label: { none: ['Carte sans tuiles'] } })
	);
	await seedFile(
		page,
		'images/remote-one/remote.json',
		JSON.stringify({
			service: service('images.test', 'florida'),
			label: 'Chart of the Florida coast',
			width: 700,
			height: 500,
			tileSize: 256
		})
	);
	await seedFile(
		page,
		'images/remote-two/remote.json',
		JSON.stringify({
			service: 'https://iiif.bnf.example/iiif/3/btv1b',
			label: 'Plan de Paris',
			width: 4000,
			height: 3000
		})
	);
	await page.reload();

	const paris = card(page, 'Plan de Paris');
	await expect(paris).toHaveCount(1);
	await expect(paris.getByTestId('map-thumbnail-glyph')).toBeVisible();
	await expect(paris.getByTestId('map-thumbnail-image')).toHaveCount(0);

	const florida = card(page, 'Chart of the Florida coast');
	await florida.scrollIntoViewIfNeeded();
	await expect
		.poll(() => decoded(page, 'Chart of the Florida coast'), { timeout: 20_000 })
		.toEqual({ width: 175, height: 125 });
	await expect(florida.getByTestId('map-thumbnail-image')).toHaveAttribute('loading', 'lazy');

	const untiled = card(page, 'Carte sans tuiles');
	await expect(untiled).toHaveCount(1);
	await page.waitForTimeout(1_500);
	await expect(untiled.getByTestId('map-thumbnail-glyph')).toBeVisible();
	await expect(untiled.getByTestId('map-thumbnail-image')).toHaveCount(0);
});
