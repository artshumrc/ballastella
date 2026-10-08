import { expect, test, type Locator, type Page, type Response } from './support/test.js';

const TILE_SIZE = 256;

const TILE_URL =
	/\/fixtures\/images\/floride-1657\/(\d+),(\d+),(\d+),(\d+)\/(\d+),(\d+)\/0\/default\.jpg$/;

type TileRequest = {
	scaleFactor: number;
	region: { x: number; y: number; width: number; height: number };
	status: number;
};

const parseTileResponse = (response: Response): TileRequest | undefined => {
	const parsed = TILE_URL.exec(new URL(response.url()).pathname);
	if (!parsed) return undefined;
	const [x, y, width, height, sizeWidth, sizeHeight] = parsed.slice(1).map(Number) as number[];
	return {
		scaleFactor: Math.round(Math.max(width! / sizeWidth!, height! / sizeHeight!)),
		region: { x: x!, y: y!, width: width!, height: height! },
		status: response.status()
	};
};

const reportedPixel = async (page: Page) => {
	const readout = page.getByTestId('reported-pixel');
	const [x, y] = await Promise.all([
		readout.getAttribute('data-x'),
		readout.getAttribute('data-y')
	]);

	expect(x, 'no pixel has been reported').not.toBe('');
	return { x: Number(x), y: Number(y) };
};

const mapZoom = async (page: Page) => Number(await page.getByTestId('map-zoom').innerText());

const centreOf = async (locator: Locator) => {
	const box = await locator.boundingBox();
	if (!box) throw new Error('element is not visible');
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const waitForTiles = (page: Page) =>
	expect(page.getByTestId('pane-tiles')).toHaveAttribute('data-tiles-loaded', 'true');

const clickCentreOf = async (page: Page, locator: Locator) => {
	const { x, y } = await centreOf(locator);
	await page.mouse.click(x, y);
};

const openPane = async (page: Page) => {
	await page.goto('./image-pane');
	await expect(page.getByRole('heading', { level: 1, name: 'Image pane' })).toBeVisible();
	await expect(page.getByTestId('pane-ready')).toBeVisible();
	await waitForTiles(page);
	return page.getByTestId('image-pane');
};

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test('renders the fixture Map Image with zoom at the bottom-left, and reports the pixel under the cursor', async ({
	page
}) => {
	await openPane(page);

	const pane = page.getByTestId('image-pane');
	const bottomLeft = pane.locator('.maplibregl-ctrl-bottom-left');
	await expect(bottomLeft.locator('button.maplibregl-ctrl-zoom-in')).toBeVisible();
	await expect(bottomLeft.locator('button.maplibregl-ctrl-zoom-out')).toBeVisible();
	await expect(pane.locator('button.maplibregl-ctrl-compass')).toHaveCount(0);
	await expect(pane.locator('.maplibregl-ctrl-top-right .maplibregl-ctrl')).toHaveCount(0);

	await expect(page.getByText('1200 × 851 pixels')).toBeVisible();
	await expect(page.getByText('scale factors 1, 2, 4, 8')).toBeVisible();

	const fitZoom = await mapZoom(page);
	expect(fitZoom).toBeGreaterThan(11);
	expect(fitZoom).toBeLessThanOrEqual(14);
	const tolerance = 1.5 * 2 ** (14 - fitZoom);
	const referencePoints = page.getByTestId('pane-overlay-point-reference');

	await expect(referencePoints).toHaveCount(5);

	for (let index = 0; index < 5; index++) {
		const drawn = referencePoints.nth(index);
		const claimed = {
			x: Number(await drawn.getAttribute('data-resource-x')),
			y: Number(await drawn.getAttribute('data-resource-y'))
		};
		await clickCentreOf(page, drawn);
		const reported = await reportedPixel(page);
		expect(Math.abs(reported.x - claimed.x), `reference point ${index} x`).toBeLessThan(tolerance);
		expect(Math.abs(reported.y - claimed.y), `reference point ${index} y`).toBeLessThan(tolerance);
	}

	const centre = await reportedPixel(page);
	expect(Math.abs(centre.x - 600)).toBeLessThan(tolerance);
	expect(Math.abs(centre.y - 425.5)).toBeLessThan(tolerance);

	await expect(page.getByTestId('pane-status')).toHaveAttribute('aria-live', 'polite');
	await expect(page.getByTestId('pane-status')).toHaveText(/^Image pixel 600, 42[456] reported\.$/);
});

test('loads tiles at every scale factor, ragged edges included, with nothing failing', async ({
	page
}) => {
	const tiles: TileRequest[] = [];
	page.on('response', (response) => {
		const tile = parseTileResponse(response);
		if (tile) tiles.push(tile);
	});

	await openPane(page);

	await clickCentreOf(page, page.getByTestId('pane-overlay-point-reference').nth(3));

	for (let step = 0; step < 8 && (await mapZoom(page)) > 11; step++) {
		await button(page, 'Zoom out one level').click();
		await waitForTiles(page);
	}

	expect(await mapZoom(page)).toBe(11);

	for (const zoom of [12, 13, 14]) {
		await button(page, 'Zoom in one level').click();
		await waitForTiles(page);
		expect(await mapZoom(page)).toBe(zoom);
	}

	await button(page, 'Zoom to full resolution').click();
	await waitForTiles(page);
	expect(await mapZoom(page)).toBe(14);
	expect(tiles.filter((tile) => tile.status !== 200)).toEqual([]);

	for (const scaleFactor of [1, 2, 4, 8]) {
		const atLevel = tiles.filter((tile) => tile.scaleFactor === scaleFactor && tile.status === 200);
		const cell = TILE_SIZE * scaleFactor;
		expect(atLevel.length, `no tiles loaded at scale factor ${scaleFactor}`).toBeGreaterThan(0);

		expect(
			atLevel.some((tile) => tile.region.width < cell),
			`no ragged right-margin tile at scale factor ${scaleFactor}`
		).toBe(true);
		expect(
			atLevel.some((tile) => tile.region.height < cell),
			`no ragged bottom-margin tile at scale factor ${scaleFactor}`
		).toBe(true);
	}
});

test('at full resolution, keeps a reported pixel across a fit, and pans by pointer and by keyboard', async ({
	page
}) => {
	const pane = await openPane(page);

	await button(page, 'Fit whole map').focus();
	await expect(button(page, 'Fit whole map')).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(button(page, 'Zoom to full resolution')).toBeFocused();
	await page.keyboard.press('Enter');
	expect(await mapZoom(page)).toBe(14);

	const centre = await centreOf(pane);
	await page.mouse.click(centre.x + 137, centre.y - 89);
	const placed = await reportedPixel(page);
	await button(page, 'Fit whole map').click();
	expect(await mapZoom(page)).toBeLessThan(14);
	await waitForTiles(page);
	await button(page, 'Zoom to full resolution').click();
	expect(await mapZoom(page)).toBe(14);
	const drawn = await centreOf(page.getByTestId('pane-overlay-point-reported'));
	expect(Math.abs(drawn.x - centre.x)).toBeLessThan(2);
	expect(Math.abs(drawn.y - centre.y)).toBeLessThan(2);
	await page.mouse.click(centre.x, centre.y);
	const again = await reportedPixel(page);
	expect(Math.abs(again.x - placed.x)).toBeLessThan(1.5);
	expect(Math.abs(again.y - placed.y)).toBeLessThan(1.5);

	const reportCentre = async () => {
		await button(page, 'Report the pixel at the centre of the view').click();
		return reportedPixel(page);
	};
	let before = await reportCentre();
	await page.mouse.move(centre.x, centre.y);
	await page.mouse.down();
	await page.mouse.move(centre.x - 120, centre.y + 80, { steps: 12 });
	await page.waitForTimeout(300);
	await page.mouse.up();
	let after = await reportCentre();
	expect(Math.abs(after.x - before.x - 120)).toBeLessThan(2);
	expect(Math.abs(after.y - before.y + 80)).toBeLessThan(2);

	before = after;
	const canvas = page.locator('canvas.maplibregl-canvas');
	await expect(canvas).toHaveAttribute('tabindex', '0');
	await canvas.focus();
	await page.keyboard.press('ArrowRight');
	await page.waitForTimeout(600);
	after = await reportCentre();
	expect(after.x).toBeGreaterThan(before.x);
	expect(Math.abs(after.y - before.y)).toBeLessThan(1);
});
