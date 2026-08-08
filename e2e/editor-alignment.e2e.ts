import { parseAnnotation, validateAnnotation } from '@allmaps/annotation';
import { expect, test } from './support/network-fence.js';
import { type Locator, type Page } from '@playwright/test';
import zlib from 'node:zlib';

import { expectWarpedDrawn } from './support/alignment-workspace';
import { routeBaseMapArchive } from './support/editor-deployment';
import { readStoredJsonOrNull } from './support/stored-file';

/**
 * SPEC's Seam 2 for the core act of the application: Control Point pairing, in the running app,
 * against the user's own ingested pyramid and a real Base Map (stories 30, 32–37).
 *
 * Everything here is asserted through the interface a scholar uses — clicks on two MapLibre
 * canvases, Escape, arrow keys, the Control Point list — because ADR-0022's contracts are all
 * about what the user can see and do, and none of them can be established from unit tests over the
 * pairing state. The two things that reach inside the page are `window.ballastellaAlignmentWrites`,
 * because the drag criterion is about a **count** of writes into OPFS and OPFS issues no requests,
 * and one OPFS read of the written file, because the criterion is that what landed on disk is a
 * valid Georeference Annotation.
 */

const crcTable = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

const crc32 = (bytes: Buffer): number => {
	let c = -1;
	for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
	return (c ^ -1) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
	const out = Buffer.alloc(data.length + 12);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
};

/** A greyscale gradient PNG, so this file needs no binary fixture. */
function gradientPng(width: number, height: number): Buffer {
	const raw = Buffer.alloc((width + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (width + 1);
		raw[row] = 0;
		for (let x = 0; x < width; x++) {
			raw[row + 1 + x] = (x * 255) / width / 2 + (y * 255) / height / 2;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE BASE MAP COMES FROM THE COMMITTED FIXTURE, NOT FROM SOMEBODY ELSE'S BUCKET (ticket 17).
//
// Every entry in `base-map/catalog.ts` points at `demo-bucket.protomaps.com`, and on 2026-08-07 that
// bucket began answering **404** for `v4.pmtiles` — with no CORS headers on the 404 and a 403 on the
// preflight, so an unrouted request is blocked by the browser rather than answered. MapLibre's source
// then never initialises and the warped layer is never added, so the symptom is
// `data-warped-status=""` — which reads exactly like the feature being broken. It went red here, and
// identically on `main`, with nothing in this repository having changed.
//
// ADR-0025 is explicit that this bucket has "no published rate limit, no uptime promise, and no
// terms of use" and that "nothing about it is suitable to rely on". Fourteen other specs already
// route it to `e2e/fixtures/base-map/amsterdam-centre.pmtiles`; these three were the outliers, and
// not by design — see `routeBaseMapArchive` for what routing does and does not still exercise.
test.beforeEach(async ({ page }) => {
	await routeBaseMapArchive(page);
});

async function emptyWorkspace(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
	});
}

async function createProject(page: Page, name: string): Promise<void> {
	await page.getByRole('button', { name: 'New Project' }).click();
	await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill(name);
	await page
		.getByRole('dialog', { name: 'New Project' })
		.getByRole('button', { name: 'Create' })
		.click();
}

/**
 * Open a Project and wait until its own page is on screen.
 *
 * The wait is load-bearing: a Project is selected client-side from `?p=` (ADR-0008), so for a
 * moment after the click the hub is still rendered — and the hub lists Projects as list items.
 */
async function openProject(page: Page, name: string): Promise<void> {
	await page.getByRole('link', { name }).click();
	await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();
}

/** How long a freshly ingested pyramid may take to decode every tile of its first view. */
const TILES_READY_MS = 30_000;

/** Bring in one Historical Map and wait for its pyramid and both panes to be ready. */
async function ingestAndOpen(page: Page): Promise<string> {
	await page.getByLabel('Add a Historical Map from a file').setInputFiles({
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(700, 500)
	});
	// The image id off the Layer the map arrived with (ADR-0023). Ticket 04 removed the Project's
	// separate list of image ids: the Layer already says which Historical Map it draws, and two
	// renderings of one fact is one of them going stale.
	const addedRow = page.getByTestId('layer-row').first();
	await expect(addedRow).toBeVisible({ timeout: 30_000 });
	const imageId = (await addedRow.getAttribute('data-image-id'))!;

	// **The workspace is a route of its own since ticket 03**, so getting to it is a navigation and no
	// longer a scroll. The id is read above, before the click: the Historical Maps list is on the
	// Project page and this leaves it.
	await page.getByTestId('align-historical-map').click();
	await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);

	await expect(page.getByTestId('image-pane')).toBeVisible();
	// **Waited for generously, and the assertion is unchanged.** What is asserted is the real signal —
	// every tile of the first view decoded — and five seconds is enough for that on an idle machine and
	// not on one running four workers that each drive a real WebGL context and the same origin's OPFS
	// (see `playwright.config.ts` on contention). Too short a wait here reads as a failure of whatever
	// the test went on to do, which is the reason `editor-layers.e2e.ts` waits 20 seconds for its stack.
	await expect(page.getByTestId('historical-map-tiles')).toHaveAttribute(
		'data-tiles-loaded',
		'true',
		{ timeout: TILES_READY_MS }
	);
	// The pairing status only renders once the Alignment has been read, so waiting for it is waiting
	// for the whole surface to be live rather than for a timeout.
	await expect(page.getByTestId('pairing-status')).toContainText('first Control Point');
	return imageId;
}

/** One Alignment write the app made, as `alignment/browser-test-handle.ts` records it. */
type AlignmentWrite = { path: string; controlPoints: number };

// Declared here as well as in the app, because the root tsconfig compiles only `e2e/` and
// `playwright.config.ts` — it never sees the editor's own declaration. The same duplication
// `ballastellaServedTiles` carries in `editor-stored-image-pane.e2e.ts`, for the same reason.
declare global {
	interface Window {
		ballastellaAlignmentWrites?: AlignmentWrite[];
		ballastellaWarped?: {
			map: { fitBounds(bounds: unknown, options?: unknown): void };
			layer: {
				getBounds(): unknown;
				/** Upstream internals, optional all the way down so a version bump fails loudly. */
				renderer?: { tileCache?: { getCachedTiles?(): unknown[] } };
			};
		};
	}
}

/**
 * How many warped tiles have arrived **and decoded**.
 *
 * `CacheableTile.isCachedTile()` is `data !== undefined`, and `data` is the ImageData the tile worker
 * produced — so this counts tiles that made it all the way through the ADR-0011 shim rather than
 * tiles that were merely asked for. It is the honest signal for "the Historical Map renders warped":
 * the failure this path used to have was an error `@allmaps/render` logged and swallowed, so a check
 * for an absence of console errors went green while the map rendered blank.
 */
const warpedTiles = async (page: Page): Promise<number> =>
	page.evaluate(async () => {
		const warped = window.ballastellaWarped;
		if (!warped) return -1;
		// Bring the warped map into view, or the renderer has no reason to ask for a tile.
		warped.map.fitBounds(warped.layer.getBounds(), { animate: false });
		await new Promise((resolve) => setTimeout(resolve, 3000));
		return (warped.layer.renderer?.tileCache?.getCachedTiles?.() ?? []).length;
	});

const historicalMap = (page: Page) => page.getByTestId('image-pane');
const baseMap = (page: Page) => page.getByTestId('base-map-pane');

/**
 * Each pane's Control Points, scoped to the container MapLibre appends them into.
 *
 * Scoped by container and not by anything else, because both panes' points use identical markup —
 * so which pane a point belongs to is exactly the question of which container it is in. An earlier
 * version scoped the Base Map's by negation against the image pane's testid, which silently matched
 * both: the image pane's container *is* the element carrying that testid, and `:has()` only looks at
 * descendants.
 */
const imagePoints = (page: Page) =>
	historicalMap(page).locator('[data-testid="pane-overlay-point-control-point"]');

const basePoints = (page: Page) =>
	baseMap(page).locator('[data-testid="pane-overlay-point-control-point"]');

const rows = (page: Page) => page.getByTestId('control-point-row');
const warpedStatus = (page: Page) => page.getByTestId('warped-status');

/** Click at a fraction across a pane, so the same helper works for both canvases. */
async function clickAt(target: Locator, fx: number, fy: number): Promise<void> {
	const box = await target.boundingBox();
	if (!box) throw new Error('the pane has no box to click in');
	await target.click({ position: { x: box.width * fx, y: box.height * fy } });
}

/**
 * Make one complete pair: a click on the Historical Map, then one on the Base Map.
 *
 * Waits for the pending state in between, which is what makes this click-then-click rather than
 * two clicks that happen to arrive in order.
 */
async function makePair(page: Page, fx: number, fy: number): Promise<void> {
	const before = await rows(page).count();
	await clickAt(historicalMap(page), fx, fy);
	await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
	await clickAt(baseMap(page), fx, fy);
	await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', '');
	await expect(rows(page)).toHaveCount(before + 1);
}

/**
 * Start counting Alignment writes from zero.
 *
 * **Call this only once the writes you are not interested in have landed**, which is what
 * `waitForStored` is for. A completed pair writes asynchronously: the Control Point row appears in
 * the page before the bytes reach OPFS, so resetting the log in that window lets the pair's own
 * write arrive afterwards and be counted as the gesture's. That was a real intermittent failure
 * here, and it failed in the most misleading possible way — as "a write happened mid-drag", which
 * is exactly the defect these tests exist to catch.
 */
const watchWrites = (page: Page) =>
	page.evaluate(() => {
		window.ballastellaAlignmentWrites = [];
	});

const writes = (page: Page) => page.evaluate(() => window.ballastellaAlignmentWrites ?? []);

/**
 * Wait until the Alignment on disk carries `count` pairs.
 *
 * A completed pair is written immediately rather than on a timer (ADR-0017 rule 1), but "immediately"
 * is still a promise: the row appears in the page before the bytes reach OPFS. Reloading inside that
 * window is a race, and one that would fail as "a pair was lost across reload" — the exact bug this
 * suite is meant to be able to detect.
 */
const waitForStored = async (page: Page, imageId: string, count: number): Promise<void> => {
	await expect
		.poll(async () => {
			const written = await storedAlignment(page, imageId);
			if (written === null) return -1;
			return (JSON.parse(written).body?.features ?? []).length;
		})
		.toBe(count);
};

/**
 * The Alignment as it sits in OPFS, or `null` when there is no such file.
 *
 * At the **Workspace** root and taking no Project directory (ADR-0023): one Alignment per Historical
 * Map, shared by every Project that draws it.
 */
const storedAlignment = (page: Page, imageId: string) =>
	page.evaluate(async (imageId) => {
		const root = await navigator.storage.getDirectory();
		try {
			const alignments = await root.getDirectoryHandle('alignments');
			const handle = await alignments.getFileHandle(`${imageId}.json`);
			return await (await handle.getFile()).text();
		} catch {
			return null;
		}
	}, imageId);

async function start(page: Page): Promise<string> {
	await page.goto('/');
	await emptyWorkspace(page);
	await page.reload();
	await createProject(page, 'Amsterdam 1625');
	await openProject(page, 'Amsterdam 1625');
	return ingestAndOpen(page);
}

test.describe('Control Point pairing', () => {
	test('clicking the Historical Map then the Base Map creates one numbered pair', async ({
		page
	}) => {
		await start(page);

		await expect(imagePoints(page)).toHaveCount(0);
		await expect(basePoints(page)).toHaveCount(0);

		await clickAt(historicalMap(page), 0.35, 0.4);

		// ADR-0022 contract 1: the pending half is visible and labelled. One point on the Historical
		// Map, marked pending, and nothing on the Base Map — a pair does not exist yet.
		await expect(imagePoints(page)).toHaveCount(1);
		await expect(imagePoints(page).first()).toHaveAttribute('data-pending', 'true');
		await expect(basePoints(page)).toHaveCount(0);
		await expect(page.getByTestId('pairing-status')).toContainText(
			'Waiting for the matching place on the Base Map'
		);

		await clickAt(baseMap(page), 0.5, 0.5);

		// One pair: a half on each pane, both numbered 1, and neither still pending.
		await expect(imagePoints(page)).toHaveCount(1);
		await expect(basePoints(page)).toHaveCount(1);
		await expect(imagePoints(page).first()).toHaveAttribute('data-ordinal', '1');
		await expect(basePoints(page).first()).toHaveAttribute('data-ordinal', '1');
		await expect(imagePoints(page).first()).toHaveAttribute('data-pending', 'false');
		await expect(imagePoints(page).first()).toHaveText('1');

		await expect(rows(page)).toHaveCount(1);
		await expect(page.getByTestId('control-point-select')).toHaveText('Point 1');
	});

	test('ordinals are visible and count up as pairs are made', async ({ page }) => {
		await start(page);

		await makePair(page, 0.3, 0.3);
		await makePair(page, 0.5, 0.4);
		await makePair(page, 0.7, 0.6);

		// The numbers are *in* the points, as text, so "look at point 7" works without hovering.
		await expect(imagePoints(page)).toHaveText(['1', '2', '3']);
		await expect(basePoints(page)).toHaveText(['1', '2', '3']);
		await expect(page.getByTestId('control-point-select')).toHaveText([
			'Point 1',
			'Point 2',
			'Point 3'
		]);
	});

	test('Escape cancels the pending half, leaving no trace in the page or on disk', async ({
		page
	}) => {
		const imageId = await start(page);
		await watchWrites(page);

		// Two complete pairs first, so the assertion is that Escape removes *the pending half* and not
		// simply that an empty Alignment stays empty.
		await makePair(page, 0.3, 0.3);
		await makePair(page, 0.6, 0.5);
		await waitForStored(page, imageId, 2);
		const afterPairs = await storedAlignment(page, imageId);
		expect(afterPairs).not.toBeNull();

		await clickAt(historicalMap(page), 0.8, 0.7);
		await expect(imagePoints(page)).toHaveCount(3);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');

		await page.keyboard.press('Escape');

		// Nothing left in the page: back to two pairs, and no pending state.
		await expect(imagePoints(page)).toHaveCount(2);
		await expect(basePoints(page)).toHaveCount(2);
		await expect(rows(page)).toHaveCount(2);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', '');

		// Nothing left on disk either. The file is byte-identical to before the mis-started pair,
		// which is stronger than "it still has two pairs": it says the pending half provoked no
		// write at all rather than a write that happened to exclude it.
		expect(await storedAlignment(page, imageId)).toBe(afterPairs);
	});

	/**
	 * A mis-started pair costs nothing — **and "nothing" is counted, not inferred**.
	 *
	 * There is an `alignments/<id>.json` here from the moment the Historical Map was added: the starter
	 * Alignment, zero Control Points, the whole sheet as the Resource Mask (ADR-0023). So the old
	 * assertion — no file at all — has nothing left to say, and byte-identity replaced it.
	 *
	 * **Byte-identity alone is weaker than what it replaced**, which is the reason for the write count
	 * beside it. "No file" could only be satisfied by no write; "the same bytes" is equally satisfied by
	 * an idempotent rewrite, and a rewrite is exactly the trace this criterion is about — in a Workspace
	 * kept in git or Dropbox it is a change to sync, whatever the bytes say. The counter restores the
	 * property the absence assertion used to carry.
	 */
	test('Escape after the first click of the very first pair writes nothing at all', async ({
		page
	}) => {
		const imageId = await start(page);
		// The starter Alignment adding the Historical Map wrote: zero Control Points, over the whole
		// sheet (ADR-0023). It is the file this test now measures *against* — before ticket 02 there
		// was no file at all here, and "no file" was the assertion.
		const starter = await storedAlignment(page, imageId);
		expect(starter).not.toBeNull();
		expect(JSON.parse(starter as string).body.features).toEqual([]);
		// Reset here rather than at the top of the test, so what is counted is the mis-started pair and
		// not the add that preceded it.
		await watchWrites(page);

		await clickAt(historicalMap(page), 0.4, 0.4);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', '');

		// **Settled first, because what is asserted is a write that must not happen.** `writeAlignment`
		// records the write *after* the commit resolves, so reading the counter the moment the pending
		// state clears is reading it before a write that is on its way — which is a green run for the
		// very defect this is here to catch. A fixed wait rather than a signal, for the same reason:
		// there is no event for "no write happened". Comfortably longer than ADR-0017's 400 ms debounce
		// and the OPFS commit behind it.
		await page.waitForTimeout(2000);

		// Not one write, and the bytes agree. The two assertions fail on different mutations, which is
		// why both are here: a write of different content fails the second, a write of the same content
		// fails only the first.
		expect(await writes(page)).toEqual([]);
		expect(await storedAlignment(page, imageId)).toBe(starter);
	});

	test('dragging a half moves the pair and writes exactly once, on pointer-up', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePair(page, 0.4, 0.4);
		// The pair's own write has to have landed before the counter is reset, or it lands inside the
		// window under test and reads as a write during the drag.
		await waitForStored(page, imageId, 1);

		const half = imagePoints(page).first();
		const before = await half.boundingBox();
		if (!before) throw new Error('the Control Point has no box to drag');

		await watchWrites(page);
		expect(await writes(page)).toEqual([]);

		// A drag in many steps. **The step count is the assertion**: a per-pointer-move
		// implementation writes once per move and passes any "did it save?" test, so what has to hold
		// is that twelve moves produce one write (ADR-0017 rule 1).
		await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
		await page.mouse.down();
		for (let step = 1; step <= 12; step += 1) {
			await page.mouse.move(
				before.x + before.width / 2 + step * 6,
				before.y + before.height / 2 + step * 3
			);
		}
		// Still mid-gesture: nothing has been committed, because the gesture has not ended.
		expect(await writes(page)).toEqual([]);

		await page.mouse.up();

		await expect.poll(async () => (await writes(page)).length).toBe(1);
		const logged = await writes(page);
		expect(logged[0]?.controlPoints).toBe(1);
		expect(logged[0]?.path).toContain('alignments/');

		// It actually moved, rather than merely having been written.
		const after = await half.boundingBox();
		expect(after).not.toBeNull();
		expect(Math.abs((after?.x ?? 0) - before.x)).toBeGreaterThan(20);
	});

	test('selecting either half highlights its partner in the other pane', async ({ page }) => {
		await start(page);
		await makePair(page, 0.3, 0.3);
		await makePair(page, 0.65, 0.6);

		// The colour a highlighted half is actually drawn in, read off the element rather than inferred
		// from a class name. **ADR-0022 contract 4 is about what the user can see** — "this is what makes
		// a set of twenty points comprehensible" — and `data-selected` is a test attribute: an earlier
		// version of this test asserted only that and `aria-pressed`, so the class that does the drawing
		// could have been dropped two lines away in `overlay-points.ts` and this stayed green.
		const background = (point: Locator) =>
			point.evaluate((element) => getComputedStyle(element).backgroundColor);

		// Clear the selection completing the second pair left behind, so what follows is about the
		// click under test rather than about which pair was made last.
		await page.getByTestId('control-point-select').nth(1).click();
		await expect(imagePoints(page).nth(0)).toHaveAttribute('data-selected', 'false');
		await expect(basePoints(page).nth(0)).toHaveAttribute('data-selected', 'false');
		const unselectedColour = await background(imagePoints(page).nth(0));

		// Select point 1 by clicking its **image** half; its **earth** half must light up too. That
		// cross-pane link is the piece no drawing library provides (ADR-0022 contract 4).
		await imagePoints(page).nth(0).click();
		await expect(imagePoints(page).nth(0)).toHaveAttribute('data-selected', 'true');
		await expect(basePoints(page).nth(0)).toHaveAttribute('data-selected', 'true');
		await expect(imagePoints(page).nth(1)).toHaveAttribute('data-selected', 'false');
		await expect(basePoints(page).nth(1)).toHaveAttribute('data-selected', 'false');
		// Announced, not merely drawn: a screen-reader user has to be told which point is current.
		await expect(imagePoints(page).nth(0)).toHaveAttribute('aria-pressed', 'true');

		// **Visibly** highlighted, on both panes: the selected class is on, and it is painting.
		await expect(imagePoints(page).nth(0)).toHaveClass(/pane-overlay-point-selected/);
		await expect(basePoints(page).nth(0)).toHaveClass(/pane-overlay-point-selected/);
		await expect(imagePoints(page).nth(1)).not.toHaveClass(/pane-overlay-point-selected/);
		const selectedColour = await background(imagePoints(page).nth(0));
		expect(selectedColour, 'a highlight nobody can see is not a highlight').not.toBe(
			unselectedColour
		);
		expect(await background(basePoints(page).nth(0))).toBe(selectedColour);
		expect(await background(imagePoints(page).nth(1))).toBe(unselectedColour);

		// And the other way round, from the Base Map half of point 2.
		await basePoints(page).nth(1).click();
		await expect(imagePoints(page).nth(1)).toHaveAttribute('data-selected', 'true');
		await expect(basePoints(page).nth(1)).toHaveAttribute('data-selected', 'true');
		await expect(imagePoints(page).nth(0)).toHaveAttribute('data-selected', 'false');
		await expect(imagePoints(page).nth(1)).toHaveClass(/pane-overlay-point-selected/);
		await expect(imagePoints(page).nth(0)).not.toHaveClass(/pane-overlay-point-selected/);
		expect(await background(imagePoints(page).nth(1))).toBe(selectedColour);
		expect(await background(imagePoints(page).nth(0))).toBe(unselectedColour);
	});

	test('deleting removes both halves, never one', async ({ page }) => {
		await start(page);
		await makePair(page, 0.3, 0.3);
		await makePair(page, 0.55, 0.45);
		await makePair(page, 0.75, 0.65);

		await expect(imagePoints(page)).toHaveCount(3);
		await expect(basePoints(page)).toHaveCount(3);

		await page.getByTestId('control-point-delete').nth(1).click();

		// Both panes lose a point. ADR-0022 contract 5: a half cannot exist in the file, so deleting
		// one has no valid meaning — the counts have to stay equal.
		await expect(imagePoints(page)).toHaveCount(2);
		await expect(basePoints(page)).toHaveCount(2);
		await expect(rows(page)).toHaveCount(2);

		// The survivors renumber contiguously, because the ordinal is the position in the file and
		// there is no second source of truth to leave a gap behind.
		await expect(imagePoints(page)).toHaveText(['1', '2']);
		await expect(basePoints(page)).toHaveText(['1', '2']);
	});

	test('every pairing action is reachable by keyboard, and the pending state is announced', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePair(page, 0.4, 0.4);
		await waitForStored(page, imageId, 1);

		// The pending prompt is in a live region, so it reaches assistive technology rather than only
		// the screen. `aria-atomic`, so it is read as a sentence and not as the words that changed.
		const status = page.getByTestId('pairing-status');
		await expect(status).toHaveAttribute('aria-live', 'polite');
		await expect(status).toHaveAttribute('aria-atomic', 'true');

		// A Control Point is a real button: focusable, named, and with its state announced.
		const half = imagePoints(page).first();
		await half.focus();
		await expect(half).toBeFocused();
		await expect(half).toHaveAttribute('aria-label', /Control Point 1, Historical Map half/);

		// Arrow keys move it, and one key-hold is one write — the keyboard's version of pointer-up.
		const before = await half.boundingBox();
		await watchWrites(page);
		await page.keyboard.press('Shift+ArrowRight');
		await expect.poll(async () => (await writes(page)).length).toBe(1);
		const after = await half.boundingBox();
		expect((after?.x ?? 0) - (before?.x ?? 0)).toBeGreaterThan(5);

		// Enter drives selection, which is the keyboard route to the cross-pane highlight. Asserted as
		// a toggle in both directions rather than as "Enter selects", because completing a pair
		// already leaves it selected — so a one-way assertion here depends on what the pair's state
		// happened to be and would pass or fail for the wrong reason.
		await page.getByTestId('control-point-select').first().focus();
		const selectedNow = await imagePoints(page).first().getAttribute('data-selected');
		const opposite = selectedNow === 'true' ? 'false' : 'true';

		await page.keyboard.press('Enter');
		await expect(imagePoints(page).first()).toHaveAttribute('data-selected', opposite);
		await expect(basePoints(page).first()).toHaveAttribute('data-selected', opposite);

		await page.keyboard.press('Enter');
		await expect(imagePoints(page).first()).toHaveAttribute(
			'data-selected',
			selectedNow ?? 'false'
		);
		await expect(basePoints(page).first()).toHaveAttribute('data-selected', selectedNow ?? 'false');

		// Delete on a focused Control Point removes the pair, both halves.
		await imagePoints(page).first().focus();
		await page.keyboard.press('Delete');
		await expect(imagePoints(page)).toHaveCount(0);
		await expect(basePoints(page)).toHaveCount(0);

		// And the pending half is cancellable by keyboard from either pane, which is contract 1's
		// "cancellable with Escape" rather than "clickable on a button".
		await clickAt(historicalMap(page), 0.5, 0.5);
		await expect(status).toHaveAttribute('data-pending', 'resource');
		await page.keyboard.press('Escape');
		await expect(status).toHaveAttribute('data-pending', '');
	});
});

test.describe('the warped Historical Map', () => {
	test('appears over the Base Map on the third pair, and not before', async ({ page }) => {
		await start(page);

		// Two pairs is one short of what `polynomial1` can be solved with (ADR-0013), and the user is
		// told what is missing rather than being shown an empty Base Map.
		await makePair(page, 0.3, 0.3);
		await makePair(page, 0.6, 0.35);
		await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', '');
		await expect(warpedStatus(page)).toContainText('1 more Control Point');
		expect(
			await page.evaluate(() => Boolean(window.ballastellaWarped)),
			'the renderer must not be asked for an under-determined solve'
		).toBe(false);

		// The third pair is the one that makes the map appear.
		await makePair(page, 0.45, 0.7);
		await expectWarpedDrawn(page);
		await expect(warpedStatus(page)).toContainText('from 3 Control Points');

		// Asserted as tiles that arrived *and decoded*, not as an absence of console errors: the
		// failure this path used to have was an error `@allmaps/render` logged and swallowed, so a
		// console-only check went green while the map rendered blank. It works because of
		// `patches/@allmaps__render@1.0.0-beta.83.patch`; `scripts/check-allmaps-patch.mjs` guards it.
		expect(
			await warpedTiles(page),
			'no warped tile reached the renderer through the ProjectStore shim'
		).toBeGreaterThan(0);
	});

	test('is withdrawn again when a pair is deleted and there are too few', async ({ page }) => {
		await start(page);
		await makePair(page, 0.3, 0.3);
		await makePair(page, 0.6, 0.35);
		await makePair(page, 0.45, 0.7);
		await expectWarpedDrawn(page);

		// Back below the minimum. The map has to come off rather than stay drawn from a solve that is
		// no longer supported by the Control Points on screen — which would be a Historical Map placed
		// by points the user has deleted.
		await page.getByTestId('control-point-delete').first().click();
		await expect(rows(page)).toHaveCount(2);
		await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', '');
		await expect(warpedStatus(page)).toContainText('1 more Control Point');
	});
});

test.describe('the Alignment on disk', () => {
	test('is a valid Georeference Annotation naming the image and the transformation', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePair(page, 0.3, 0.3);
		await makePair(page, 0.55, 0.45);
		await makePair(page, 0.75, 0.65);
		await waitForStored(page, imageId, 3);

		const written = await storedAlignment(page, imageId);
		expect(written, 'no Alignment was written').not.toBeNull();
		const document = JSON.parse(written as string);

		// ─────────────────────────────────────────────────────────────────────────────────────
		// **UPSTREAM SAYS SO, ABOUT THE BYTES THE RUNNING APP WROTE.**
		//
		// The criterion is "`alignments/<image-id>.json` is a valid Georeference Annotation, parseable
		// by `@allmaps/annotation`" — and this test used to answer it by checking eight fields by hand.
		// Eight hand-written fields are eight of the dozens `Annotation1Schema` validates, and the two
		// upstream regexes that have already bitten this slice — the `polygon points` number pattern and
		// `<svg width="\d+">` — are not among them. Every other test that asks upstream operates on
		// serialiser output built in-process; nothing asked it about what landed in OPFS.
		//
		// So the validator and the parser run here, in Node, on the file the app wrote. The field
		// assertions below stay, because they say *which* Alignment this is rather than that it is one.
		expect(
			() => validateAnnotation(document),
			'upstream refused the file the app wrote'
		).not.toThrow();
		const parsed = parseAnnotation(document);
		expect(parsed).toHaveLength(1);
		// And it parses into the Alignment that was made, not merely into something.
		expect(parsed[0]?.gcps).toHaveLength(3);
		expect(parsed[0]?.resourceMask).toHaveLength(4);
		expect(parsed[0]?.resource.width).toBe(700);
		expect(parsed[0]?.transformation).toStrictEqual({ type: 'polynomial', options: { order: 1 } });

		expect(document.type).toBe('Annotation');
		expect(document.motivation).toBe('georeferencing');
		expect(document['@context']).toContain('http://iiif.io/api/extension/georef/1/context.json');
		expect(document.body.features).toHaveLength(3);

		// The image is named by the ADR-0004 placeholder, which is the routing key the ADR-0011
		// injection layer resolves — the same string the pyramid's own `info.json` declares.
		expect(document.target.source.id).toBe(`https://unset.invalid/${imageId}`);
		expect(document.target.source.width).toBe(700);
		expect(document.target.source.height).toBe(500);

		// The Resource Mask defaults to the whole image and is not editable here (ADR-0013, ticket 08).
		expect(document.target.selector.value).toContain('points="0,0 700,0 700,500 0,500"');

		// First-order polynomial, with the order explicit. **Never `straight`**, which is not
		// round-trippable, and never the bare alias, which leaves the order to be inferred — see
		// `georeference-annotation.ts` for why the literal name `polynomial1` cannot be written.
		expect(document.body.transformation).toEqual({ type: 'polynomial', options: { order: 1 } });
		expect(written).not.toContain('straight');
	});

	test('excludes an incomplete pair while one is pending, and does not throw', async ({ page }) => {
		const consoleErrors: string[] = [];
		page.on('pageerror', (error) => consoleErrors.push(`${error.name}: ${error.message}`));

		const imageId = await start(page);
		await makePair(page, 0.3, 0.3);
		await makePair(page, 0.55, 0.45);
		await makePair(page, 0.75, 0.65);

		// A half-made pair, and then a write provoked by something else — a drag of an existing point.
		// This is the case ADR-0022 warns about: autosave fires constantly, so a naive serialiser
		// would fail on the first click of every pair.
		await waitForStored(page, imageId, 3);
		await clickAt(historicalMap(page), 0.85, 0.2);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
		await expect(imagePoints(page)).toHaveCount(4);

		await watchWrites(page);
		const half = imagePoints(page).first();
		const box = await half.boundingBox();
		if (!box) throw new Error('the Control Point has no box to drag');
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10);
		await page.mouse.up();
		await expect.poll(async () => (await writes(page)).length).toBe(1);

		// Three pairs written, not four and not an error: the pending half was skipped.
		expect((await writes(page))[0]?.controlPoints).toBe(3);
		const document = JSON.parse((await storedAlignment(page, imageId)) as string);
		expect(document.body.features).toHaveLength(3);
		// Every written feature has both halves, which is the invariant a half-pair would break.
		for (const feature of document.body.features) {
			expect(feature.properties.resourceCoords).toHaveLength(2);
			expect(feature.geometry.coordinates).toHaveLength(2);
		}

		expect(consoleErrors, 'autosave must skip an incomplete pair, not throw on it').toEqual([]);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
	});

	test('restores every pair, its ordinal, and the warped render across a reload', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePair(page, 0.3, 0.3);
		await makePair(page, 0.55, 0.45);
		await makePair(page, 0.75, 0.65);

		const coordinatesBefore = await page.getByTestId('control-point-row').allInnerTexts();
		await waitForStored(page, imageId, 3);

		// A reload of the alignment route itself: the route is addressed by `?p=` and `?layer=`, so it
		// comes back on the same Historical Map without going through the Project page (ticket 03).
		await page.reload();
		await expect(page.getByRole('heading', { name: 'Align', exact: true })).toBeVisible();
		await expect(page.getByTestId('image-pane')).toBeVisible();

		// The pairs come back, on both panes, with the same numbers in the same order.
		await expect(rows(page)).toHaveCount(3);
		await expect(imagePoints(page)).toHaveText(['1', '2', '3']);
		await expect(basePoints(page)).toHaveText(['1', '2', '3']);
		await expect(page.getByTestId('control-point-select')).toHaveText([
			'Point 1',
			'Point 2',
			'Point 3'
		]);

		// And the coordinates are the ones that were stored, not merely three points in some order.
		// Ordinals are the position in the file, so this is what "stable across reload" means.
		expect(await page.getByTestId('control-point-row').allInnerTexts()).toEqual(coordinatesBefore);

		// **And the warped render comes back too**, which is the other half of the criterion. Nothing
		// about the warped layer is persisted — it is rebuilt from the Alignment that was read off
		// disk — so this is what says the whole path survives a reload rather than only the Control
		// Points that feed it.
		await expectWarpedDrawn(page);
		expect(
			await warpedTiles(page),
			'the Historical Map did not render warped after a reload'
		).toBeGreaterThan(0);
	});

	test('surfaces an Alignment that is there and cannot be read, rather than silently emptying it', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePair(page, 0.3, 0.3);
		await waitForStored(page, imageId, 1);

		// Corrupt the file behind the app's back, the way a bad sync or a half-finished write would.
		await page.evaluate(async (id) => {
			const root = await navigator.storage.getDirectory();
			// At the Workspace root (ADR-0023).
			const alignments = await root.getDirectoryHandle('alignments');
			const handle = await alignments.getFileHandle(`${id}.json`);
			const writable = await handle.createWritable();
			await writable.write('{ not an annotation');
			await writable.close();
		}, imageId);

		await page.reload();

		// Said, not swallowed. Falling back to an empty Alignment would show no Control Points and
		// then overwrite the real ones on the next save, which is the largest loss this slice could
		// inflict.
		await expect(page.getByTestId('alignment-failure')).toBeVisible();
		await expect(page.getByTestId('alignment-failure')).toContainText(imageId);
		await expect(rows(page)).toHaveCount(0);
	});
});

/**
 * Choosing the Base Map from the pane you are aligning onto.
 *
 * **This is a reachability test, and that is the point of it.** The switcher's *behaviour* was
 * already covered — `editor-base-map.e2e.ts` drives it thoroughly — but every one of those tests
 * arrives by `page.goto('./base-map/?p=…')`, and so does every test of the Layers pane. A control
 * that no test ever has to *find* can stop being findable without a single assertion going red,
 * which is exactly what happened: the deployment default is a regional extract (ADR-0020), an
 * author aligning a sheet from anywhere else zoomed in and watched the Base Map go blank, and the
 * only way to change it was a URL typed by hand or a button labelled with a Layer count.
 *
 * So this test never navigates. It reaches the switcher the way a scholar does — from the
 * workspace where the wrong Base Map is discovered — and that is the assertion.
 */
test.describe('choosing the Base Map while aligning', () => {
	const switcher = (page: Page) => page.getByRole('combobox', { name: 'Base Map' });

	/**
	 * The Project's recorded Base Map, out of OPFS.
	 *
	 * Polled rather than read once: `chooseBaseMap` writes asynchronously, so the `<select>` shows
	 * the new value before the bytes land — and reading in that window would fail as "the choice was
	 * not recorded", which is the opposite of what happened.
	 *
	 * **And through `readStoredJsonOrNull`, which retries, because the app writes atomically** — a temp
	 * file, then `move()` over the destination (ADR-0017 rule 4). A read landing inside *that* window
	 * does not return stale bytes, it raises. This helper was a fourth hand-rolled copy of a read that
	 * three others documented that hazard at length for, and it was the copy that omitted the retry: it
	 * was the last remaining failure in the ten runs measured for ticket 17, with
	 * `NotReadableError: The requested file could not be read`.
	 */
	const storedBaseMap = async (page: Page): Promise<unknown> =>
		(await readStoredJsonOrNull<{ baseMap?: unknown }>(page, 'amsterdam-1625/project.json'))
			?.baseMap ?? null;

	/**
	 * A bundled entry, deliberately — **not** the worldwide one this whole investigation was about.
	 *
	 * `streets-worldwide` reads Protomaps' demo bucket over the network, and no test in this suite
	 * selects it for that reason (`editor-base-map.e2e.ts` names it only in the expected option
	 * list). What is under test here is that the control is reachable and that operating it records
	 * the author's choice; making that depend on a third party's bucket would buy nothing and cost
	 * a flake on every reading-room wifi this suite is ever run on.
	 *
	 * ⚠ **That reasoning was right and this constant did not achieve it** (ticket 17). All four
	 * catalog entries share one `REMOTE_ARCHIVE`, so choosing a "bundled" one still fetched the demo
	 * bucket — and when that bucket started answering 404 this spec went red along with the two other
	 * unrouted ones. The `routeBaseMapArchive` hook at the top of this file is what actually delivers
	 * what this comment intended; the constant now only keeps the option list honest.
	 */
	const OFFLINE_ENTRY = 'physical';

	test('the switcher is on the alignment workspace, with no navigation', async ({ page }) => {
		await start(page);

		// Present beside the pane, on the page the author is already on. `getByRole` rather than a
		// testid, because "can a user find and operate this" is the question and the accessible name
		// is what answers it.
		await expect(switcher(page)).toBeVisible();
	});

	test('choosing one records it as the Project default and leaves the pane live', async ({
		page
	}) => {
		await start(page);

		await switcher(page).selectOption(OFFLINE_ENTRY);

		// The choice is the author's default for the Project (ADR-0020), written through the same
		// `chooseBaseMap` every other switcher calls — so it is one piece of state, not a third copy.
		await expect.poll(() => storedBaseMap(page)).toBe(OFFLINE_ENTRY);

		// And the pane in front of the author is still a live map afterwards. `setStyle` tears down
		// every layer this workspace put on it (see `BaseMapPane`), so a repaint that left the pane
		// broken would be the same defect wearing a different face.
		await expect(baseMap(page)).toBeVisible();
		await page.waitForFunction(
			() => window.ballastellaBaseMap?.isStyleLoaded() === true,
			undefined,
			{
				timeout: 30_000
			}
		);
	});

	test('the choice survives a reload, and the workspace opens on it', async ({ page }) => {
		await start(page);
		await switcher(page).selectOption(OFFLINE_ENTRY);
		await expect.poll(() => storedBaseMap(page)).toBe(OFFLINE_ENTRY);

		await page.reload();

		// Reopened from `project.json` rather than from anything held in the page, which is what makes
		// it the author's default rather than a setting that lasts as long as the tab.
		await expect(switcher(page)).toHaveValue(OFFLINE_ENTRY);
	});
});
