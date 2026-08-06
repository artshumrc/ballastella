import { expect, test, type Locator, type Page } from '@playwright/test';
import zlib from 'node:zlib';

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

/** Bring in one Historical Map and wait for its pyramid and both panes to be ready. */
async function ingestAndOpen(page: Page): Promise<string> {
	await page.getByLabel('Add a Historical Map from a file').setInputFiles({
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(700, 500)
	});
	await expect(page.getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
	const imageId = (await page.getByRole('listitem').first().innerText()).trim();

	await expect(page.getByTestId('image-pane')).toBeVisible();
	await expect(page.getByTestId('historical-map-tiles')).toHaveAttribute(
		'data-tiles-loaded',
		'true'
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
	}
}

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
const waitForStored = async (
	page: Page,
	directory: string,
	imageId: string,
	count: number
): Promise<void> => {
	await expect
		.poll(async () => {
			const written = await storedAlignment(page, directory, imageId);
			if (written === null) return -1;
			return (JSON.parse(written).body?.features ?? []).length;
		})
		.toBe(count);
};

/** The Alignment as it sits in OPFS, or `null` when there is no such file. */
const storedAlignment = (page: Page, directory: string, imageId: string) =>
	page.evaluate(
		async ([directory, imageId]) => {
			const root = await navigator.storage.getDirectory();
			try {
				const project = await root.getDirectoryHandle(directory as string);
				const alignments = await project.getDirectoryHandle('alignments');
				const handle = await alignments.getFileHandle(`${imageId}.json`);
				return await (await handle.getFile()).text();
			} catch {
				return null;
			}
		},
		[directory, imageId] as const
	);

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
		await waitForStored(page, 'amsterdam-1625', imageId, 2);
		const afterPairs = await storedAlignment(page, 'amsterdam-1625', imageId);
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
		expect(await storedAlignment(page, 'amsterdam-1625', imageId)).toBe(afterPairs);
	});

	test('Escape after the first click of the very first pair writes no Alignment at all', async ({
		page
	}) => {
		const imageId = await start(page);

		await clickAt(historicalMap(page), 0.4, 0.4);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', '');

		// **No file, not an empty one.** A mis-started pair must cost nothing, and an
		// `alignments/<id>.json` carrying zero pairs would be a trace on disk — and, in a Workspace
		// kept in git or Dropbox, a change to sync.
		expect(await storedAlignment(page, 'amsterdam-1625', imageId)).toBeNull();
	});

	test('dragging a half moves the pair and writes exactly once, on pointer-up', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePair(page, 0.4, 0.4);
		// The pair's own write has to have landed before the counter is reset, or it lands inside the
		// window under test and reads as a write during the drag.
		await waitForStored(page, 'amsterdam-1625', imageId, 1);

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

		// Clear the selection completing the second pair left behind, so what follows is about the
		// click under test rather than about which pair was made last.
		await page.getByTestId('control-point-select').nth(1).click();
		await expect(imagePoints(page).nth(0)).toHaveAttribute('data-selected', 'false');
		await expect(basePoints(page).nth(0)).toHaveAttribute('data-selected', 'false');

		// Select point 1 by clicking its **image** half; its **earth** half must light up too. That
		// cross-pane link is the piece no drawing library provides (ADR-0022 contract 4).
		await imagePoints(page).nth(0).click();
		await expect(imagePoints(page).nth(0)).toHaveAttribute('data-selected', 'true');
		await expect(basePoints(page).nth(0)).toHaveAttribute('data-selected', 'true');
		await expect(imagePoints(page).nth(1)).toHaveAttribute('data-selected', 'false');
		await expect(basePoints(page).nth(1)).toHaveAttribute('data-selected', 'false');
		// Announced, not merely drawn: a screen-reader user has to be told which point is current.
		await expect(imagePoints(page).nth(0)).toHaveAttribute('aria-pressed', 'true');

		// And the other way round, from the Base Map half of point 2.
		await basePoints(page).nth(1).click();
		await expect(imagePoints(page).nth(1)).toHaveAttribute('data-selected', 'true');
		await expect(basePoints(page).nth(1)).toHaveAttribute('data-selected', 'true');
		await expect(imagePoints(page).nth(0)).toHaveAttribute('data-selected', 'false');
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
		await waitForStored(page, 'amsterdam-1625', imageId, 1);

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

test.describe('the Alignment on disk', () => {
	test('is a valid Georeference Annotation naming the image and the transformation', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePair(page, 0.3, 0.3);
		await makePair(page, 0.55, 0.45);
		await makePair(page, 0.75, 0.65);
		await waitForStored(page, 'amsterdam-1625', imageId, 3);

		const written = await storedAlignment(page, 'amsterdam-1625', imageId);
		expect(written, 'no Alignment was written').not.toBeNull();
		const document = JSON.parse(written as string);

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
		await waitForStored(page, 'amsterdam-1625', imageId, 3);
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
		const document = JSON.parse((await storedAlignment(page, 'amsterdam-1625', imageId)) as string);
		expect(document.body.features).toHaveLength(3);
		// Every written feature has both halves, which is the invariant a half-pair would break.
		for (const feature of document.body.features) {
			expect(feature.properties.resourceCoords).toHaveLength(2);
			expect(feature.geometry.coordinates).toHaveLength(2);
		}

		expect(consoleErrors, 'autosave must skip an incomplete pair, not throw on it').toEqual([]);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
	});

	test('restores every pair and its ordinal across a reload', async ({ page }) => {
		const imageId = await start(page);
		await makePair(page, 0.3, 0.3);
		await makePair(page, 0.55, 0.45);
		await makePair(page, 0.75, 0.65);

		const coordinatesBefore = await page.getByTestId('control-point-row').allInnerTexts();
		await waitForStored(page, 'amsterdam-1625', imageId, 3);

		await page.reload();
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();
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
	});

	test('surfaces an Alignment that is there and cannot be read, rather than silently emptying it', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePair(page, 0.3, 0.3);
		await waitForStored(page, 'amsterdam-1625', imageId, 1);

		// Corrupt the file behind the app's back, the way a bad sync or a half-finished write would.
		await page.evaluate(
			async ([directory, id]) => {
				const root = await navigator.storage.getDirectory();
				const project = await root.getDirectoryHandle(directory as string);
				const alignments = await project.getDirectoryHandle('alignments');
				const handle = await alignments.getFileHandle(`${id}.json`);
				const writable = await handle.createWritable();
				await writable.write('{ not an annotation');
				await writable.close();
			},
			['amsterdam-1625', imageId] as const
		);

		await page.reload();

		// Said, not swallowed. Falling back to an empty Alignment would show no Control Points and
		// then overwrite the real ones on the next save, which is the largest loss this slice could
		// inflict.
		await expect(page.getByTestId('alignment-failure')).toBeVisible();
		await expect(page.getByTestId('alignment-failure')).toContainText(imageId);
		await expect(rows(page)).toHaveCount(0);
	});
});
