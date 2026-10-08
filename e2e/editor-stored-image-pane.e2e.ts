import { expect, test, type Page } from './support/test.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	addMapImageButton,
	expectNothingPreparing,
	pickMapImageFile
} from './support/map-images.js';
import { alignFromLayer } from './support/layers';
import { showPaneDetails, gradientPng } from './support/alignment-workspace.js';
import { createProject } from './support/annotations.js';
import { readJson, writeStoredFiles } from './support/stored-file.js';
import { emptyWorkspace } from './support/workspace.js';

test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

type ServedTile = {
	paneId: string;
	scaleFactor: number;
	column: number;
	row: number;
	url: string;
	placement: { width: number; height: number };
};

declare global {
	interface Window {
		ballastellaServedTiles?: ServedTile[];
	}
}

const clearServedTiles = (page: Page) =>
	page.evaluate(() => void (window.ballastellaServedTiles = []));

const servedTiles = (page: Page): Promise<ServedTile[]> =>
	page.evaluate(() => window.ballastellaServedTiles ?? []);

const listedImageIds = async (page: Page): Promise<string[]> =>
	(
		await page
			.getByTestId('layer-row')
			.evaluateAll((rows) =>
				rows.map((row) => (row as HTMLElement).dataset.imageId ?? '').filter(Boolean)
			)
	).sort();

async function ingest(page: Page, width: number, height: number, name: string): Promise<string> {
	const before = await listedImageIds(page);
	await pickMapImageFile(page, {
		name,
		mimeType: 'image/png',
		buffer: gradientPng(width, height)
	});
	await expect(page.getByTestId('layer-row')).toHaveCount(before.length + 1, { timeout: 30_000 });
	await expectNothingPreparing(page, 30_000);
	const added = (await listedImageIds(page)).filter((id) => !before.includes(id));
	expect(added, `expected exactly one new Map Image after ingesting ${name}`).toHaveLength(1);
	return added[0]!;
}

async function openPane(page: Page, imageId?: string): Promise<void> {
	const row =
		imageId === undefined
			? page.getByTestId('layer-row').first()
			: page.locator(`[data-testid="layer-row"][data-image-id="${imageId}"]`);
	await alignFromLayer(page, row);
	await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);
}

async function backToProject(page: Page): Promise<void> {
	await page.getByTestId('back-to-project').click();
	await expect(addMapImageButton(page)).toBeVisible();
}

const waitForTiles = (page: Page, timeout?: number) =>
	expect(page.getByTestId('map-image-tiles')).toHaveAttribute(
		'data-tiles-loaded',
		'true',
		timeout === undefined ? undefined : { timeout }
	);

const pyramidReadout = (page: Page) => page.getByTestId('map-image-pyramid');
const mapZoom = async (page: Page) => Number(await page.getByTestId('map-image-zoom').innerText());

function recordRequests(page: Page): string[] {
	const requested: string[] = [];
	page.on('request', (request) => requested.push(request.url()));
	return requested;
}

async function start(page: Page): Promise<string[]> {
	const requested = recordRequests(page);
	await page.addInitScript(() => void (window.ballastellaServedTiles = []));
	await page.goto('/');
	await emptyWorkspace(page);
	await page.reload();
	await createProject(page, 'Amsterdam 1625');
	await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
	await expect(addMapImageButton(page)).toBeVisible();
	return requested;
}

const wheel = async (page: Page, deltaY: number) => {
	for (let step = 0; step < 6; step++) await page.mouse.wheel(0, deltaY);
};

test.describe('a Map Image read from the Project', () => {
	test('deep-zooms the user’s own pyramid with nothing fetched, reports the pixel under the pointer, and surfaces a pyramid it refuses', async ({
		page
	}) => {
		const requested = await start(page);

		const imageId = await ingest(page, 700, 500, 'la-floride.png');
		await openPane(page);
		await waitForTiles(page);
		await showPaneDetails(page);

		await expect(pyramidReadout(page)).toHaveAttribute('data-image-id', imageId);
		await expect(pyramidReadout(page)).toContainText('700 × 500 pixels');
		await expect(pyramidReadout(page)).toContainText('scale factors 1, 2, 4');
		await expect(page.getByTestId('map-image-tiles')).toHaveAttribute('aria-live', 'polite');

		const pane = page.getByTestId('image-pane');
		await pane.scrollIntoViewIfNeeded();
		const box = await pane.boundingBox();
		if (!box) throw new Error('the pane is not visible');
		await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2 - 20);
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await expect(page.getByTestId('map-image-pointer')).not.toHaveText('—');
		const [x, y] = (await page.getByTestId('map-image-pointer').innerText())
			.split(',')
			.map((part) => Number(part.trim()));
		expect(x).toBeGreaterThanOrEqual(0);
		expect(x).toBeLessThanOrEqual(700);
		expect(y).toBeGreaterThanOrEqual(0);
		expect(y).toBeLessThanOrEqual(500);

		await pane.hover();
		await wheel(page, 1_000);
		await waitForTiles(page);

		expect(await mapZoom(page)).toBe(11);

		for (const scaleFactor of [4, 2, 1]) {
			await wheel(page, -1_000);
			await expect
				.poll(async () => (await servedTiles(page)).some((t) => t.scaleFactor === scaleFactor), {
					message: `no tile at scale factor ${scaleFactor} was served while zooming in`,
					timeout: 15_000
				})
				.toBe(true);
		}
		await waitForTiles(page);

		const tiles = await servedTiles(page);

		expect([...new Set(tiles.map((tile) => tile.scaleFactor))].sort((a, b) => a - b)).toEqual([
			1, 2, 4
		]);
		for (const scaleFactor of [1, 2, 4]) {
			const atLevel = tiles.filter((tile) => tile.scaleFactor === scaleFactor);
			expect(
				atLevel.some((tile) => tile.placement.width < 256),
				`no ragged right-margin tile at scale factor ${scaleFactor}`
			).toBe(true);
			expect(
				atLevel.some((tile) => tile.placement.height < 256),
				`no ragged bottom-margin tile at scale factor ${scaleFactor}`
			).toBe(true);
		}

		expect(
			tiles.filter((tile) => !tile.url.startsWith(`https://unset.invalid/${imageId}/`))
		).toEqual([]);

		expect(requested.filter((url) => url.includes('unset.invalid'))).toEqual([]);
		expect(requested.filter((url) => url.includes('/fixtures/'))).toEqual([]);

		const infoPath = `images/${imageId}/info.json`;
		const info = (await readJson(page, '', infoPath)) as Record<string, unknown>;
		info.tiles = [{ width: 256, height: 256, scaleFactors: [2, 4] }];
		await writeStoredFiles(page, { [infoPath]: JSON.stringify(info) });
		await page.reload();

		const failure = page.getByTestId('map-image-failure');
		await expect(failure).toBeVisible();
		await expect(failure).toHaveAttribute('role', 'alert');
		await expect(failure).toContainText('scale factor 1');
		await expect(page.getByTestId('image-pane')).toHaveCount(0);
	});

	test('renders the correct pyramid for each of two Map Images, with fractional ragged-edge placements', async ({
		page
	}) => {
		test.setTimeout(120_000);
		const requested = await start(page);

		const wide = await ingest(page, 700, 500, 'wide.png');
		const tall = await ingest(page, 300, 1300, 'tall.png');
		expect(wide).not.toBe(tall);

		await openPane(page);
		await waitForTiles(page);
		await showPaneDetails(page);
		await expect(pyramidReadout(page)).toHaveAttribute(
			'data-image-id',
			new RegExp(`${wide}|${tall}`)
		);

		const pyramids = {
			[wide]: { size: { width: 700, height: 500 }, levels: 3 },
			[tall]: { size: { width: 300, height: 1300 }, levels: 4 }
		};
		const showAndCheck = async (imageId: string) => {
			const { size, levels } = pyramids[imageId]!;
			await clearServedTiles(page);
			await backToProject(page);
			await openPane(page, imageId);
			await waitForTiles(page, 30_000);
			await showPaneDetails(page);
			await expect(pyramidReadout(page)).toHaveAttribute('data-image-id', imageId);
			await expect(pyramidReadout(page)).toHaveAttribute('data-width', String(size.width));
			await expect(pyramidReadout(page)).toHaveAttribute('data-height', String(size.height));
			await expect(pyramidReadout(page)).toContainText(
				`scale factors ${Array.from({ length: levels }, (_, index) => 2 ** index).join(', ')}`
			);

			const drawn = await servedTiles(page);
			expect(drawn.length, `no tiles were drawn for ${imageId}`).toBeGreaterThan(0);
			expect(
				drawn.filter((tile) => !tile.url.startsWith(`https://unset.invalid/${imageId}/`)),
				'the pane drew the other image’s tiles'
			).toEqual([]);
		};

		const first = (await pyramidReadout(page).getAttribute('data-image-id')) ?? '';
		for (const imageId of [first === wide ? tall : wide, first, tall]) await showAndCheck(imageId);
		expect(requested.filter((url) => url.includes('unset.invalid'))).toEqual([]);

		await page.getByTestId('image-pane').hover();
		await wheel(page, 1_000);
		await waitForTiles(page, 30_000);
		await expect
			.poll(async () => (await servedTiles(page)).some((tile) => tile.scaleFactor === 8), {
				message: 'the coarsest level was never served, so no fractional placement was produced',
				timeout: 15_000
			})
			.toBe(true);
		const placements = (await servedTiles(page))
			.filter((tile) => tile.scaleFactor === 8)
			.map((tile) => tile.placement);
		expect(placements).toContainEqual({ width: 37.5, height: 162.5 });
	});
});

test('refuses a placeholder request that escapes the injection layer, by name', async ({
	page
}) => {
	const requested = recordRequests(page);
	await page.goto('/');

	await page.waitForFunction(() => Symbol.for('ballastella.imageServiceGuard') in fetch);

	const refusal = await page.evaluate(async () => {
		try {
			await fetch('https://unset.invalid/abc123/0,0,256,256/256,256/0/default.jpg');
			return 'the request was not refused';
		} catch (cause) {
			return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
		}
	});

	expect(refusal).toContain('MissingImageServiceOverrideError');
	expect(refusal).toContain('Image#uri');
	expect(refusal).toContain('ADR-0011');
	expect(requested.filter((url) => url.includes('unset.invalid'))).toEqual([]);
});
