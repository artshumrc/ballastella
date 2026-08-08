import { expect, test } from './support/test.js';
import { type Locator, type Page, type Response } from '@playwright/test';

// Seam 2 (SPEC, Testing Decisions): the running app, real MapLibre, no map abstraction.
//
// What is being defended here is that the image pane's coordinates are stable — that a pixel
// reported at full resolution is the same pixel after the view has been somewhere else. The
// projection's own arithmetic is asserted numerically in `@ballastella/core`; these tests
// assert that MapLibre agrees with it once a real pointer, a real tile grid and a real zoom
// are involved. Nothing here is a screenshot: SPEC rules out pixel comparison, and silent
// drift is precisely what a screenshot would miss.
//
// Of the tests below, the two that establish something a round trip cannot are "renders the
// fixture Historical Map and reports the pixel under the cursor" — clicking a point drawn by
// `resourceToSynthetic` and requiring the click to come back as that point's own pixel, which
// composes MapLibre's project and unproject in opposite directions — and "pans by the distance
// the pointer moved", which pins the scale against a physical distance. The zoom-stability test
// is the ticket's acceptance criterion and bounds precision; see its own comment.

/** The fixture pyramid's tile size. Guarded against the committed `info.json` in core. */
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

	if (!parsed) {
		return undefined;
	}

	const [x, y, width, height, sizeWidth, sizeHeight] = parsed.slice(1).map(Number) as [
		number,
		number,
		number,
		number,
		number,
		number
	];

	// IIIF rounds a served tile's size *up*, so region ÷ size is at most the scale factor and
	// never less than it by more than one served pixel's worth. Taking the larger of the two
	// ratios and rounding therefore recovers the scale factor exactly for any tile bigger than
	// a couple of pixels.
	const scaleFactor = Math.round(Math.max(width / sizeWidth, height / sizeHeight));

	return { scaleFactor, region: { x, y, width, height }, status: response.status() };
};

/** Reads the reported pixel to full precision, not the rounded text a human sees. */
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
	if (!box) {
		throw new Error('element is not visible');
	}
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/**
 * Waits for the pane to have every tile the current view needs.
 *
 * Not `waitForLoadState('networkidle')`: that resolves immediately once the page's own load
 * has settled, so it silently does nothing for tiles fetched later — which is exactly the kind
 * of test that passes while asserting nothing.
 */
const waitForTiles = (page: Page) =>
	expect(page.getByTestId('pane-tiles')).toHaveAttribute('data-tiles-loaded', 'true');

/** Clicks the map at an element's centre. Overlay points do not take pointer events. */
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

test('renders the fixture Historical Map and reports the pixel under the cursor', async ({
	page
}) => {
	await openPane(page);

	// The fixture's geometry is stated on the page, so a fixture swapped for a differently
	// shaped one cannot quietly keep these tests passing.
	await expect(page.getByText('1200 × 851 pixels')).toBeVisible();
	await expect(page.getByText('scale factors 1, 2, 4, 8')).toBeVisible();

	// The pane opens framing the whole image, somewhere between the coarsest level and full
	// resolution.
	const fitZoom = await mapZoom(page);
	expect(fitZoom).toBeGreaterThan(11);
	expect(fitZoom).toBeLessThanOrEqual(14);

	// Clicking each reference point must report the pixel that point claims to be at. This is
	// one of the two browser assertions that establish something a round trip cannot: the point
	// is *drawn* by `resourceToSynthetic` and MapLibre's project, and the click comes back
	// through MapLibre's unproject and `syntheticToResource` — two different directions through
	// MapLibre, not one function inverted by its own inverse. The four corners and the centre,
	// so a flipped axis or a transposed dimension cannot survive.
	//
	// A click lands on a whole screen pixel, and at this zoom one screen pixel is several image
	// pixels, so the resolution of the gesture itself is the tolerance.
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

	// The last reference point clicked is the centre.
	const centre = await reportedPixel(page);
	expect(Math.abs(centre.x - 600)).toBeLessThan(tolerance);
	expect(Math.abs(centre.y - 425.5)).toBeLessThan(tolerance);

	// Status is announced, not only rendered (ADR-0016).
	await expect(page.getByTestId('pane-status')).toHaveAttribute('aria-live', 'polite');
	await expect(page.getByTestId('pane-status')).toHaveText(/^Image pixel 600, 42[456] reported\.$/);
});

test('loads tiles at every scale factor, ragged edges included, with nothing failing', async ({
	page
}) => {
	const tiles: TileRequest[] = [];
	page.on('response', (response) => {
		const tile = parseTileResponse(response);
		if (tile) {
			tiles.push(tile);
		}
	});

	await openPane(page);

	// Aim at the bottom-right corner of the image, so that when the view is deeper than the
	// container is large, the ragged tiles at the right and bottom margins are the ones on
	// screen. Clicking the corner reference point while the whole image is framed is how that
	// corner gets named, with no coordinate arithmetic in the test.
	await clickCentreOf(page, page.getByTestId('pane-overlay-point-reference').nth(3));

	// Walk out to the coarsest level and back in to full resolution one level at a time, so
	// that MapLibre asks for every zoom level the pyramid offers rather than only the one the
	// opening view happens to need.
	for (let step = 0; step < 8 && (await mapZoom(page)) > 11; step++) {
		await button(page, 'Zoom out one level').click();
		await waitForTiles(page);
	}

	// The coarsest level of the pyramid is the floor: one map zoom below its tile zoom of 12.
	expect(await mapZoom(page)).toBe(11);

	for (const zoom of [12, 13, 14]) {
		await button(page, 'Zoom in one level').click();
		await waitForTiles(page);
		expect(await mapZoom(page)).toBe(zoom);
	}

	// …and finally with the bottom-right corner in the middle of the view, so the full-resolution
	// level's own ragged tiles are asked for too.
	await button(page, 'Zoom to full resolution').click();
	await waitForTiles(page);
	expect(await mapZoom(page)).toBe(14);

	// Nothing 404s. Because the pane only asks for tiles `@ballastella/core` says exist, a
	// failed tile request means the reader and the committed pyramid have diverged.
	expect(tiles.filter((tile) => tile.status !== 200)).toEqual([]);

	for (const scaleFactor of [1, 2, 4, 8]) {
		const atLevel = tiles.filter((tile) => tile.scaleFactor === scaleFactor && tile.status === 200);
		const cell = TILE_SIZE * scaleFactor;

		expect(atLevel.length, `no tiles loaded at scale factor ${scaleFactor}`).toBeGreaterThan(0);

		// The ragged margins: a tile narrower than a full cell is against the right edge of the
		// image, and one shorter than a full cell is against the bottom.
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

test('pans by the distance the pointer moved, in image pixels', async ({ page }) => {
	const pane = await openPane(page);

	await button(page, 'Zoom to full resolution').click();
	expect(await mapZoom(page)).toBe(14);

	await button(page, 'Report the pixel at the centre of the view').click();
	const before = await reportedPixel(page);

	// **This is the browser test that carries real weight.** It pins the projection's scale in
	// screen pixels against an external quantity — the distance a physical pointer travelled —
	// which is something no round-trip through the projection can establish about itself.
	//
	// At full resolution one image pixel covers one map pixel, so dragging 120 map pixels west
	// must move the view exactly 120 image pixels east. A wrong window size, a wrong
	// `mapZoomFromTileZoom`, or a `WINDOW_TILE_ZOOM` changed without changing anything else all
	// show up here as a scale factor on the drag, and nowhere else in the browser suite.
	const centre = await centreOf(pane);
	await page.mouse.move(centre.x, centre.y);
	await page.mouse.down();
	await page.mouse.move(centre.x - 120, centre.y + 80, { steps: 12 });
	// Long enough that MapLibre's drag inertia does not carry the view past the gesture.
	await page.waitForTimeout(300);
	await page.mouse.up();

	await button(page, 'Report the pixel at the centre of the view').click();
	const after = await reportedPixel(page);

	expect(Math.abs(after.x - before.x - 120)).toBeLessThan(2);
	expect(Math.abs(after.y - before.y + 80)).toBeLessThan(2);
});

test('reports the same pixel after zooming fully out and back in', async ({ page }) => {
	const pane = await openPane(page);

	// The acceptance criterion "a point placed at maximum zoom, after zooming fully out and back
	// in, reports the same pixel coordinate". Worth being honest about how much it proves.
	//
	// The point-at-the-centre assertion below is close to a tautology: "Zoom to full resolution"
	// calls `jumpTo({ center: resourceToSynthetic(placed) })`, so the point is at the container
	// centre because `jumpTo` put it there, and splicing MapLibre in does not break that because
	// MapLibre's transform is itself a bijection. What it does catch is an overlay point whose
	// placement and the map's centring disagree — a real class of bug, just a narrow one.
	//
	// The click at the end is the part with teeth: the pixel goes out through
	// `resourceToSynthetic`, the view is genuinely thrown away and rebuilt at another zoom, and
	// the pixel comes back through a real pointer, MapLibre's unproject at a different map
	// centre, and `syntheticToResource`. It is still a round trip, so it bounds precision rather
	// than establishing placement — for placement see the tile-origin test in
	// `@ballastella/core`, and for scale see "pans by the distance the pointer moved" above.
	await button(page, 'Zoom to full resolution').click();
	expect(await mapZoom(page)).toBe(14);

	const centre = await centreOf(pane);
	await page.mouse.click(centre.x + 137, centre.y - 89);
	const placed = await reportedPixel(page);

	await button(page, 'Fit whole map').click();
	expect(await mapZoom(page)).toBeLessThan(14);
	await waitForTiles(page);

	await button(page, 'Zoom to full resolution').click();
	expect(await mapZoom(page)).toBe(14);

	// The overlay point for the placed pixel is now drawn at the centre of the view — it has not
	// moved on the image, so it must not have moved relative to its own coordinates.
	const drawn = await centreOf(page.getByTestId('pane-overlay-point-reported'));
	expect(Math.abs(drawn.x - centre.x)).toBeLessThan(2);
	expect(Math.abs(drawn.y - centre.y)).toBeLessThan(2);

	// And clicking it again reports the same pixel.
	await page.mouse.click(centre.x, centre.y);
	const again = await reportedPixel(page);

	expect(Math.abs(again.x - placed.x)).toBeLessThan(1.5);
	expect(Math.abs(again.y - placed.y)).toBeLessThan(1.5);
});

test('is operable from the keyboard', async ({ page }) => {
	await openPane(page);

	// Every control is a real button and reachable by tabbing.
	await page.getByRole('button', { name: 'Fit whole map' }).focus();
	await expect(page.getByRole('button', { name: 'Fit whole map' })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(page.getByRole('button', { name: 'Zoom to full resolution' })).toBeFocused();

	await page.keyboard.press('Enter');
	expect(await mapZoom(page)).toBe(14);

	// The pixel readout does not need a pointer either.
	await page.getByRole('button', { name: 'Report the pixel at the centre of the view' }).click();
	const before = await reportedPixel(page);

	// The map itself takes focus and pans on the arrow keys.
	const canvas = page.locator('canvas.maplibregl-canvas');
	await expect(canvas).toHaveAttribute('tabindex', '0');
	await canvas.focus();
	await page.keyboard.press('ArrowRight');
	await page.waitForTimeout(600);

	await page.getByRole('button', { name: 'Report the pixel at the centre of the view' }).click();
	const after = await reportedPixel(page);

	expect(after.x).toBeGreaterThan(before.x);
	expect(Math.abs(after.y - before.y)).toBeLessThan(1);
});
