import { parseAnnotation, validateAnnotation } from '@allmaps/annotation';
import { openBaseMapOptions, drawSwitch } from './support/base-map-options.js';
import { expect, test } from './support/test.js';
import { type Locator, type Page } from '@playwright/test';
import zlib from 'node:zlib';

import { expectWarpedDrawn } from './support/alignment-workspace';
import { routeBaseMapArchive } from './support/editor-deployment';
import { addMapImageButton, pickMapImageFile } from './support/map-images.js';
import { alignFromLayer } from './support/layers';
import { leaderIsDrawn, leaderLayer, leaderPoints } from './support/leader.js';
import { readStoredJsonOrNull } from './support/stored-file';

/**
 * Seam 2 for the core act of the application: Control Point pairing, in the running app,
 * against the user's own ingested pyramid and a real Base Map.
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
// THE BASE MAP COMES FROM THE COMMITTED FIXTURE, NOT FROM SOMEBODY ELSE'S BUCKET.
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
		// The whole of browser storage, which is **every named Workspace** rather than one — so no
		// test can see another's, whichever Workspace it was in.
		//
		// ⚠ **The Workspace the app is holding open is emptied, not removed.** `DirectoryHandleStore`
		// caches its root handle once it resolves (ADR-0008), and that handle is now a *named
		// subdirectory* rather than the OPFS root, which cannot vanish. Deleting the directory out from
		// under a running app therefore latches it "unreachable" until a reload — a state about the
		// harness rather than about the product, and one that used to be unreachable because emptying
		// the root left the root itself in place. Emptying it is exactly what this always meant.
		const root = await navigator.storage.getDirectory();
		const open = await workspaceRoot();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(
			names
				.filter((name) => name !== open.name)
				.map((name) => root.removeEntry(name, { recursive: true }))
		);
		const inside: string[] = [];
		for await (const name of open.keys()) inside.push(name);
		await Promise.all(inside.map((name) => open.removeEntry(name, { recursive: true })));
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
	await expect(addMapImageButton(page)).toBeVisible();
}

/** How long a freshly ingested pyramid may take to decode every tile of its first view. */
const TILES_READY_MS = 30_000;

/** Bring in one Map Image and wait for its pyramid and both panes to be ready. */
async function ingestAndOpen(page: Page): Promise<string> {
	await pickMapImageFile(page, {
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(700, 500)
	});
	// The image id off the Layer the map arrived with (ADR-0023). There is no separate list of image
	// ids on the Project: the Layer already says which Map Image it draws, and two renderings of one
	// fact is one of them going stale.
	const addedRow = page.getByTestId('layer-row').first();
	await expect(addedRow).toBeVisible({ timeout: 30_000 });
	const imageId = (await addedRow.getAttribute('data-image-id'))!;

	// **The workspace is a route of its own**, so getting to it is a navigation rather than a scroll,
	// and the link that goes there is inside the Layer's own row. The id is read above, before the
	// click: the Map Images list is on the Project page and this leaves it.
	await alignFromLayer(page, addedRow);
	await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);

	await expect(page.getByTestId('image-pane')).toBeVisible();
	// **Waited for generously, and the assertion is unchanged.** What is asserted is the real signal —
	// every tile of the first view decoded — and five seconds is enough for that on an idle machine and
	// not on one running four workers that each drive a real WebGL context and the same origin's OPFS
	// (see `playwright.config.ts` on contention). Too short a wait here reads as a failure of whatever
	// the test went on to do, which is the reason `editor-layers.e2e.ts` waits 20 seconds for its stack.
	await expect(page.getByTestId('map-image-tiles')).toHaveAttribute('data-tiles-loaded', 'true', {
		timeout: TILES_READY_MS
	});
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
				getOpacity(): number;
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
 * tiles that were merely asked for. It is the honest signal for "the Map Image renders warped":
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

const mapImage = (page: Page) => page.getByTestId('image-pane');
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
	mapImage(page).locator('[data-testid="pane-overlay-point-control-point"]');

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
 * Make one complete pair: a click on the Map Image, then one on the Base Map.
 *
 * Waits for the pending state in between, which is what makes this click-then-click rather than
 * two clicks that happen to arrive in order.
 */
async function makePair(page: Page, fx: number, fy: number): Promise<void> {
	const before = await rows(page).count();
	await clickAt(mapImage(page), fx, fy);
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
 * At the **Workspace** root and taking no Project directory (ADR-0023): one Alignment per Map
 * Image, shared by every Project that draws it.
 */
const storedAlignment = (page: Page, imageId: string) =>
	page.evaluate(async (imageId) => {
		const root = await workspaceRoot();
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
	test('clicking the Map Image then the Base Map creates one numbered pair', async ({ page }) => {
		await start(page);

		await expect(imagePoints(page)).toHaveCount(0);
		await expect(basePoints(page)).toHaveCount(0);

		await clickAt(mapImage(page), 0.35, 0.4);

		// ADR-0022 contract 1: the pending half is visible and labelled. One point on the Map
		// Image, marked pending, and nothing on the Base Map — a pair does not exist yet.
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

		// ─── And the row wears it too ────────────────────────────────────────────────────────────
		//
		// Three surfaces, one number: the half on the sheet, the half on the earth, and the row. The
		// list is where the ordinals are unambiguously readable — the numbers drawn on the panes are
		// small and on a dense Alignment they overlap — so a row that disagreed with its marker would
		// be the one surface a scholar trusts telling them the wrong thing.
		const rowOrdinals = page.getByTestId('control-point-row-ordinal');
		await expect(rowOrdinals).toHaveText(['1', '2', '3']);
		// Compared against what the panes are actually drawing rather than against a literal, so this
		// cannot go green with the panes renumbered and the list left behind.
		expect(await rowOrdinals.allInnerTexts()).toEqual(await imagePoints(page).allInnerTexts());
		expect(await rowOrdinals.allInnerTexts()).toEqual(await basePoints(page).allInnerTexts());

		// Tabular figures, which is the marker's own `font-variant-numeric`: a column of ordinals that
		// shifts as it gains a digit is a column that cannot be scanned.
		expect(
			await rowOrdinals.first().evaluate((element) => getComputedStyle(element).fontVariantNumeric)
		).toContain('tabular-nums');

		// ─── And the control that destroys one names which one, to a screen reader ──────────────────
		//
		// The row's ordinal is drawn text and the delete control is a glyph, so the *only* thing that
		// says which pair this button destroys is its accessible name — reached here as a role and a
		// name rather than as a `data-testid`, which is what makes this an assertion about the
		// accessibility tree. Never a `title`: ADR-0016's icon amendment, because a `title` is not
		// reliably announced and cannot be dismissed.
		const destroyPointTwo = page.getByRole('button', { name: 'Delete Control Point 2' });
		await expect(destroyPointTwo).toHaveCount(1);
		await expect(destroyPointTwo).not.toHaveAttribute('title', /.+/);

		// Deleting the first pair renumbers the rest on every surface at once, because the ordinal is
		// the pair's position and nothing on disk holds it (ADR-0002).
		await page.getByTestId('control-point-delete').first().click();
		await expect(rowOrdinals).toHaveText(['1', '2']);
		await expect(imagePoints(page)).toHaveText(['1', '2']);
		await expect(basePoints(page)).toHaveText(['1', '2']);
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

		await clickAt(mapImage(page), 0.8, 0.7);
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
	 * There is an `alignments/<id>.json` here from the moment the Map Image was added: the starter
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
		// The starter Alignment adding the Map Image wrote: zero Control Points, over the whole
		// sheet (ADR-0023). It is the file this test measures *against* — a starter Alignment always
		// exists here, so "no file at all" is not the assertion.
		const starter = await storedAlignment(page, imageId);
		expect(starter).not.toBeNull();
		expect(JSON.parse(starter as string).body.features).toEqual([]);
		// Reset here rather than at the top of the test, so what is counted is the mis-started pair and
		// not the add that preceded it.
		await watchWrites(page);

		await clickAt(mapImage(page), 0.4, 0.4);
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

	test('dragging a half or editing its coordinates moves the pair', async ({ page }) => {
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

		const row = rows(page).first();
		await row.getByTestId('control-point-coordinates').click();
		const editor = row.getByTestId('control-point-coordinate-editor');
		await expect(editor).toBeVisible();
		await editor.getByLabel('Map Image x coordinate').fill('123.5');
		await editor.getByLabel('Map Image y coordinate').fill('234.25');
		await editor.getByLabel('Longitude').fill('-71.1234');
		await editor.getByLabel('Latitude').fill('42.5');
		await editor.getByRole('button', { name: 'Save' }).click();
		await expect(editor).toHaveCount(0);

		await expect
			.poll(async () => {
				const written = await storedAlignment(page, imageId);
				if (written === null) return null;
				const feature = JSON.parse(written).body.features[0];
				return {
					resource: feature.properties.resourceCoords,
					geo: feature.geometry.coordinates
				};
			})
			.toStrictEqual({ resource: [123.5, 234.25], geo: [-71.1234, 42.5] });

		await row.getByTestId('control-point-coordinates').click();
		await editor.getByLabel('Latitude').fill('91');
		await editor.getByRole('button', { name: 'Save' }).click();
		await expect(editor).toContainText('Latitude must be between -90 and 90.');
		await editor.getByRole('button', { name: 'Cancel' }).click();
	});

	test('selecting either half highlights its partner in the other pane', async ({ page }) => {
		const imageId = await start(page);
		await makePair(page, 0.3, 0.3);
		await makePair(page, 0.65, 0.6);

		// The colour a highlighted half is actually drawn in, read off the element rather than inferred
		// from a class name. **ADR-0022 contract 4 is about what the user can see** — "this is what makes
		// a set of twenty points comprehensible" — and `data-selected` is a test attribute: an earlier
		// version of this test asserted only that and `aria-pressed`, so the class that does the drawing
		// could have been dropped two lines away in `overlay-points.ts` and this stayed green.
		//
		// Read as the `fill` of the needle's own paths, because that is what carries the colour: the
		// mark is an `<svg>` from `core/src/render/needle.ts` — the same drawing the Base Map's Pins are
		// rasterised from — inside a transparent button, so the element's own `background-color` is
		// `rgba(0, 0, 0, 0)` whether the pair is selected or not.
		const background = (point: Locator) =>
			point.evaluate((element) => {
				const body = element.querySelector('.needle-body');
				if (body === null) throw new Error('the Control Point is not drawing a needle');
				return getComputedStyle(body).fill;
			});

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

		// ── AND ONE LEADER JOINS THAT PAIR TO ITS ROW ────────────────────────────────────────
		//
		// Folded in beside the highlight rather than given a test of its own, because the two are one
		// subject and the Seam 2 budget is spent (`scripts/check-seam-2-size.mjs`). It is also the
		// clearest place to state what the leader deliberately does **not** do: there is no line
		// between the panes for any pair, selected or not. The highlight asserted above is what joins
		// them (ADR-0022 contract 4), and eleven lines across two canvases is noise.
		//
		// **The line leaves from the Base Map half**, which is the pane adjacent to the docked column
		// — a line from the sheet's half would have to cross the Base Map pane to reach the column,
		// and nothing may be drawn over a pane that is being clicked to sub-pixel accuracy.
		//
		// ⚠ **Asserted against `map.project()` of the coordinate in the Alignment on disk**, never
		// against the leader's own box or the mark's — the defect shape recorded in
		// `apps/editor/src/routes/layout.css`. The mutation check is to offset the projection by a
		// constant and watch this go red.
		await waitForStored(page, imageId, 2);
		const written = JSON.parse((await storedAlignment(page, imageId)) as string);
		const geo = written.body.features[1].geometry.coordinates as [number, number];

		const drawn = await leaderPoints(page);
		expect(drawn, 'no leader was drawn for the selected Control Point').not.toBeNull();
		expect(drawn, 'more than one line was drawn for one selection').toHaveLength(3);
		const [atRow, stub, atMark] = drawn as { x: number; y: number }[];

		const pane = (await baseMap(page).boundingBox())!;
		const projected = await page.evaluate(
			(coordinate) =>
				(
					window as unknown as {
						ballastellaBaseMap: { project(at: [number, number]): { x: number; y: number } };
					}
				).ballastellaBaseMap.project(coordinate as [number, number]),
			geo
		);
		const target = { x: pane.x + projected.x, y: pane.y + projected.y };
		// The line stops 12 px short of the needle's foot — `TIP_BOX` in `AlignmentWorkspace.svelte`, the
		// square handed to the leader around the coordinate — and two pixels clear of that, along its
		// own direction, which is what the stub is read for. The stub sets the direction; the file sets
		// the place.
		const run = Math.hypot(
			target.x - (stub as { x: number }).x,
			target.y - (stub as { y: number }).y
		);
		const wanted = {
			x: target.x - ((target.x - (stub as { x: number }).x) * 14) / run,
			y: target.y - ((target.y - (stub as { y: number }).y) * 14) / run
		};
		expect(
			Math.hypot((atMark as { x: number }).x - wanted.x, (atMark as { y: number }).y - wanted.y),
			'the leader’s canvas end is not where map.project() puts the coordinate on disk'
		).toBeLessThan(2);

		// Its row's near edge is the **left** one here, because the docked column is to the right of
		// the panes — the mirror of the Project screen, from one rule stated as "the edge facing the
		// mark" rather than as a side.
		const rowBox = (await rows(page).nth(1).boundingBox())!;
		expect((atRow as { x: number }).x).toBeCloseTo(rowBox.x, 0);
		expect((atRow as { y: number }).y).toBeCloseTo(rowBox.y + rowBox.height / 2, 0);
		expect((stub as { x: number }).x, 'the line left the row on the far side').toBeLessThan(
			rowBox.x
		);

		// ── AND IT FOLLOWS THE CAMERA, IN THE FRAME THE CAMERA MOVED IN ─────────────────────
		//
		// ⚠ **The camera is moved *after* the pair was selected, and the line is read one animation
		// frame later without leaving the page.** Everything asserted above is drawn by `LeaderLine`'s
		// selection effect, so without this the one wire from this screen's camera to the leader — the
		// `watch` prop `AlignmentWorkspace` hands it — could be dropped and this test would stay green
		// while a scholar panning mid-refinement watched the line point at where the Control Point used
		// to be. The frame rather than a poll, for the reason `viewer-reader` records at the same
		// assertion: a stale line is put right a moment later by signals that are not the camera, so
		// only a frame-accurate read distinguishes following the map from catching up with it.
		const followed = await page.evaluate((coordinate) => {
			const map = (
				window as unknown as {
					ballastellaBaseMap: {
						panBy(offset: [number, number], options: { duration: number }): void;
						project(at: [number, number]): { x: number; y: number };
					};
				}
			).ballastellaBaseMap;
			map.panBy([70, -50], { duration: 0 });
			return new Promise<{
				points: string | null;
				origin: { x: number; y: number };
				projected: { x: number; y: number };
			}>((resolve) =>
				requestAnimationFrame(() => {
					const svg = document.querySelector('[data-testid="leader-line"]') as SVGSVGElement;
					const box = svg.getBoundingClientRect();
					resolve({
						points: svg.querySelector('polyline')!.getAttribute('points'),
						origin: { x: box.x, y: box.y },
						projected: map.project(coordinate as [number, number])
					});
				})
			);
		}, geo);
		expect(followed.points, 'the leader was taken down by a pan rather than moved').not.toBeNull();
		// The same conversion `leaderPoints` does, done here because the read had to happen in the page.
		const movedPoints = followed.points!.split(' ').map((pair) => {
			const [x, y] = pair.split(',').map(Number);
			return { x: followed.origin.x + (x as number), y: followed.origin.y + (y as number) };
		});
		const movedStub = movedPoints[1]!;
		const movedTarget = { x: pane.x + followed.projected.x, y: pane.y + followed.projected.y };
		const movedRun = Math.hypot(movedTarget.x - movedStub.x, movedTarget.y - movedStub.y);
		expect(
			Math.hypot(
				movedPoints[2]!.x - (movedTarget.x - ((movedTarget.x - movedStub.x) * 14) / movedRun),
				movedPoints[2]!.y - (movedTarget.y - ((movedTarget.y - movedStub.y) * 14) / movedRun)
			),
			'the leader stayed where the camera left it, so it is not following the map'
		).toBeLessThan(2);

		// Decoration only: nothing about which pair is current may depend on seeing it.
		await expect(leaderLayer(page)).toHaveAttribute('aria-hidden', 'true');

		// And deselecting takes it away, which is the other half of "exactly one thing is selected".
		await page.getByTestId('control-point-select').nth(1).click();
		await expect(basePoints(page).nth(1)).toHaveAttribute('data-selected', 'false');
		await expect.poll(() => leaderIsDrawn(page)).toBe('no');
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
		await expect(half).toHaveAttribute('aria-label', /Control Point 1, Map Image half/);

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
		await clickAt(mapImage(page), 0.5, 0.5);
		await expect(status).toHaveAttribute('data-pending', 'resource');
		await page.keyboard.press('Escape');
		await expect(status).toHaveAttribute('data-pending', '');
	});
});

test.describe('the warped Map Image', () => {
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

	/**
	 * ⚠ **The defect this covers: a solved Alignment covered the earth it was solved against.**
	 *
	 * The third Control Point drew the sheet over the Base Map at full opacity, so the fourth had to be
	 * placed on geography the author could no longer see — the screen stopped being usable at exactly
	 * the moment it started working.
	 *
	 * Asserted on the renderer's own `opacity` option and not on the label beside the slider, because a
	 * percentage that never reaches the layer is precisely the failure: the control is only worth
	 * anything if the drawing changes.
	 */
	test('is drawn translucent, and the slider reaches the renderer', async ({ page }) => {
		await start(page);
		await makePair(page, 0.3, 0.3);
		await makePair(page, 0.6, 0.35);
		await makePair(page, 0.45, 0.7);
		await expectWarpedDrawn(page);

		const layerOpacity = () =>
			page.evaluate(() => window.ballastellaWarped?.layer.getOpacity() ?? -1);

		// Translucent from the first frame it is drawn on, not after a gesture.
		const slider = page.getByTestId('overlay-opacity');
		await expect(slider).toHaveValue('50');
		await expect.poll(layerOpacity).toBeCloseTo(0.5, 5);

		// And `0` uncovers the earth completely while leaving the renderer in place — the map is still
		// drawn and still described, which is what keeps the distortion measure available.
		await slider.fill('0');
		await expect.poll(layerOpacity).toBeCloseTo(0, 5);
		await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', 'drawn');

		await slider.fill('100');
		await expect.poll(layerOpacity).toBeCloseTo(1, 5);
	});

	test('is withdrawn again when a pair is deleted and there are too few', async ({ page }) => {
		await start(page);
		await makePair(page, 0.3, 0.3);
		await makePair(page, 0.6, 0.35);
		await makePair(page, 0.45, 0.7);
		await expectWarpedDrawn(page);

		// Back below the minimum. The map has to come off rather than stay drawn from a solve that is
		// no longer supported by the Control Points on screen — which would be a Map Image placed
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

		// The Resource Mask defaults to the whole image and is not editable here (ADR-0013).
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
		await clickAt(mapImage(page), 0.85, 0.2);
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
		// comes back on the same Map Image without going through the Project page.
		await page.reload();
		await expect(page.getByRole('heading', { name: /^Align(?::|$)/ })).toBeVisible();
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
			'the Map Image did not render warped after a reload'
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
			const root = await workspaceRoot();
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
 * Choosing how the Base Map is drawn from the pane you are aligning onto.
 *
 * **This is a reachability test, and that is the point of it.** The controls' *behaviour* is already
 * covered — `editor-base-map.e2e.ts` drives them thoroughly — but every one of those tests arrives
 * by `page.goto('./base-map/?p=…')`, and so does every test of the Layers pane. A control that no
 * test ever has to *find* can stop being findable without a single assertion going red, which is
 * exactly what happened once: an author aligning a sheet had no way to change the Base Map but a
 * URL typed by hand or a button labelled with a Layer count.
 *
 * The detail an author needs *under a sheet* is not the detail they share with — roads help place
 * a street plan and get in the way of a coastline, and it is while aligning that you find out
 * which. So this test never navigates. It reaches the switches the way a scholar does, from the
 * workspace where the wrong Base Map is discovered, and that is the assertion.
 */
test.describe('drawing the Base Map while aligning', () => {
	/**
	 * The Project's recorded Base Map appearance, out of OPFS.
	 *
	 * Polled rather than read once: `chooseBaseMapAppearance` writes asynchronously, so the switch
	 * shows its new state before the bytes land — and reading in that window would fail as "the
	 * choice was not recorded", which is the opposite of what happened.
	 *
	 * **And through `readStoredJsonOrNull`, which retries, because the app writes atomically** — a temp
	 * file, then `move()` over the destination (ADR-0017 rule 4). A read landing inside *that* window
	 * does not return stale bytes, it raises. This helper was a fourth hand-rolled copy of a read that
	 * three others documented that hazard at length for, and it was the copy that omitted the retry: it
	 * was the last remaining failure in the ten consecutive runs measured on `main`, with
	 * `NotReadableError: The requested file could not be read`.
	 */
	const storedAppearance = async (page: Page): Promise<unknown> =>
		(
			await readStoredJsonOrNull<{ baseMapAppearance?: unknown }>(
				page,
				'amsterdam-1625/project.json'
			)
		)?.baseMapAppearance ?? null;

	/**
	 * Switching the streets off, deliberately: it is the change an author aligning a coastline makes,
	 * and it is a departure from the default, so a control that did nothing would be visible.
	 *
	 * The `routeBaseMapArchive` hook at the top of this file supplies the archive bytes, so no test
	 * here depends on a third party's bucket.
	 */
	const WITHOUT_STREETS = { streets: false, relief: false, muted: false };

	test('operating one records it in the Project and leaves the pane live', async ({ page }) => {
		await start(page);

		await openBaseMapOptions(page);
		await drawSwitch(page, 'Streets').click();

		// The choice is the Project's (ADR-0020), written through the same
		// `chooseBaseMapAppearance` the Project screen calls — one piece of state, not a third copy.
		await expect.poll(() => storedAppearance(page)).toEqual(WITHOUT_STREETS);

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
		await openBaseMapOptions(page);
		await drawSwitch(page, 'Streets').click();
		await expect.poll(() => storedAppearance(page)).toEqual(WITHOUT_STREETS);

		await page.reload();

		// Reopened from `project.json` rather than from anything held in the page, which is what makes
		// it the author's setting rather than one that lasts as long as the tab.
		await openBaseMapOptions(page);
		await expect(drawSwitch(page, 'Streets')).not.toBeChecked();
	});
});
