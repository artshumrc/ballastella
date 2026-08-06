import { expect, test, type Page } from '@playwright/test';
import zlib from 'node:zlib';

/**
 * ADR-0011's second injection point, in a real browser: `new WarpedMapLayer({ fetchFn })`.
 *
 * Ticket 06 asserted this on a bare `/warped` dev route, because no Alignment existed and the layer
 * had nothing to hold. **Ticket 07 deleted that route and this file now drives the real thing** — a
 * Historical Map ingested the ordinary way, three Control Points paired by clicking, and the warped
 * layer where it belongs, in the Base Map pane. Everything below is therefore asserted on the path a
 * scholar actually takes.
 *
 * Four things here a type check cannot establish: that `@allmaps/maplibre` resolves against the one
 * `maplibre-gl` copy in the page (two copies is a broken map rather than a version warning), that the
 * layer survives being added to a real map with a real WebGL2 context, that no request escapes to the
 * placeholder host, and — the one this file exists for — that **tiles actually arrive and decode**
 * through the ADR-0011 shim, which needs `patches/@allmaps__render@1.0.0-beta.83.patch`. See the last
 * test for why that is asserted by counting cached tiles and not by an absence of console errors.
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

const historicalMap = (page: Page) => page.getByTestId('image-pane');
const baseMap = (page: Page) => page.getByTestId('base-map-pane');
const warpedStatus = (page: Page) => page.getByTestId('warped-status');

async function clickAt(page: Page, which: 'image' | 'base', fx: number, fy: number): Promise<void> {
	const target = which === 'image' ? historicalMap(page) : baseMap(page);
	const box = await target.boundingBox();
	if (!box) throw new Error('the pane has no box to click in');
	await target.click({ position: { x: box.width * fx, y: box.height * fy } });
}

async function makePair(page: Page, fx: number, fy: number): Promise<void> {
	const before = await page.getByTestId('control-point-row').count();
	await clickAt(page, 'image', fx, fy);
	await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
	await clickAt(page, 'base', fx, fy);
	await expect(page.getByTestId('control-point-row')).toHaveCount(before + 1);
}

/**
 * A Project with one ingested Historical Map, on its own page with both panes live.
 *
 * @returns the image id the tiler minted
 */
async function projectWithImage(page: Page): Promise<string> {
	await page.goto('/');
	await emptyWorkspace(page);
	await page.reload();
	await createProject(page, 'Amsterdam 1625');
	await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
	await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();

	await page.getByLabel('Add a Historical Map from a file').setInputFiles({
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(700, 500)
	});
	await expect(page.getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
	const imageId = (await page.getByRole('listitem').first().innerText()).trim();

	await expect(historicalMap(page)).toBeVisible();
	await expect(page.getByTestId('pairing-status')).toContainText('first Control Point');
	return imageId;
}

declare global {
	interface Window {
		ballastellaWarped?: {
			map: {
				fitBounds(bounds: unknown, options?: unknown): void;
			};
			layer: {
				getBounds(): unknown;
				/**
				 * Reached into so a tile can be asserted to have *arrived and decoded*, rather than
				 * merely to have been requested — `isCachedTile()` is `data !== undefined`. Optional
				 * all the way down because it is upstream's internals, not a contract: if a version
				 * bump moves it, the assertion must fail loudly rather than silently read `undefined`.
				 */
				renderer?: { tileCache?: { getCachedTiles?(): unknown[] } };
			};
		};
	}
}

test.describe('warped rendering reads through the ProjectStore', () => {
	test('adds no warped layer below the minimum Control Point count, and asks the network for nothing', async ({
		page
	}) => {
		const requested: string[] = [];
		page.on('request', (request) => requested.push(request.url()));
		const consoleErrors: string[] = [];
		page.on('console', (message) => {
			if (message.type() === 'error') consoleErrors.push(message.text());
		});

		await projectWithImage(page);

		// Two pairs: one short of what `polynomial1` can be solved with (ADR-0013).
		await makePair(page, 0.3, 0.3);
		await makePair(page, 0.6, 0.5);

		// The renderer is never asked for an under-determined solve, and the user is told what is
		// missing rather than being shown an empty Base Map.
		await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', '');
		await expect(warpedStatus(page)).toContainText(
			'1 more Control Point and the Historical Map will be drawn'
		);
		await expect(page.evaluate(() => Boolean(window.ballastellaWarped))).resolves.toBe(false);

		// Nothing has gone looking for tiles at the placeholder host.
		expect(requested.filter((url) => url.includes('unset.invalid'))).toEqual([]);
		expect(consoleErrors.filter((text) => /unset\.invalid|DataClone/i.test(text))).toEqual([]);
	});

	test('accepts the Alignment and reports bounds once there are three pairs, with nothing fetched from the network', async ({
		page
	}) => {
		const requested: string[] = [];
		page.on('request', (request) => requested.push(request.url()));

		await projectWithImage(page);
		await makePair(page, 0.3, 0.3);
		await makePair(page, 0.6, 0.35);
		await makePair(page, 0.45, 0.7);

		// The layer took the Alignment. That means `info.json` was fetched **through our shim** on the
		// main thread — `WarpedMap` loads the image information there — so that half of ADR-0011 holds
		// against a locally stored pyramid with no URL.
		await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', 'drawn');
		await expect(warpedStatus(page)).toContainText('from 3 Control Points');

		// MapLibre gave the layer an id and the layer has bounds, which it only does once `onAdd` has
		// run against the map's own WebGL2 context — the point at which two MapLibre copies, or a
		// worker the bundler could not see, would have failed instead.
		const bounds = await page.evaluate(() => window.ballastellaWarped?.layer.getBounds() ?? null);
		expect(bounds, 'the warped layer reported no bounds').not.toBeNull();

		// Still nothing to the placeholder host: every byte came out of OPFS.
		expect(requested.filter((url) => url.includes('unset.invalid'))).toEqual([]);
	});

	test('reaches the pyramid’s info.json AND its tiles through the shim', async ({ page }) => {
		// This test used to assert the opposite of its own name. `@allmaps/render@1.0.0-beta.83` passes
		// `fetchFn` into its Comlink tile worker unproxied — the abort callback beside it *is*
		// `Comlink.proxy()`-wrapped — so every tile failed with a `DataCloneError` that upstream logs
		// and swallows, and the symptom was a blank warped map with nothing surfaced.
		//
		// `patches/@allmaps__render@1.0.0-beta.83.patch` fixes it, and the obvious one-line fix does
		// **not**: the worker's `fetchUrl` does `await fetchFn(...)` and expects a `Response`, which is
		// not structured-cloneable, so proxying the function merely trades the `DataCloneError` for
		// `TypeError("Unserializable return value")` — still swallowed, still blank. Measured
		// independently while this ticket was in flight, against a faithful copy of upstream's worker,
		// and the two accounts agree. The patch instead runs the custom fetch on the main thread, where
		// the closure lives, and hands the worker a `blob:` URL so the decode stays off the main thread.
		// `scripts/check-allmaps-patch.mjs` fails the build if it stops applying, because this failure
		// mode is silent.
		const consoleErrors: string[] = [];
		page.on('console', (message) => {
			if (message.type() === 'error') consoleErrors.push(message.text());
		});
		page.on('pageerror', (error) => consoleErrors.push(`${error.name}: ${error.message}`));

		await projectWithImage(page);
		await makePair(page, 0.3, 0.3);
		await makePair(page, 0.6, 0.35);
		await makePair(page, 0.45, 0.7);
		await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', 'drawn');

		// Bring the warped map into view so tiles are actually asked for, then let the renderer work.
		const cachedTiles = await page.evaluate(async () => {
			const warped = window.ballastellaWarped;
			if (!warped) throw new Error('the warped layer was not exposed');
			warped.map.fitBounds(warped.layer.getBounds(), { animate: false });
			await new Promise((resolve) => setTimeout(resolve, 4000));

			// A *cached* tile is one whose bytes arrived and decoded — `CacheableTile.isCachedTile()`
			// is `data !== undefined`, and `data` is the ImageData the worker produced. So this counts
			// tiles that made it all the way through the shim, not tiles that were merely requested.
			return (warped.layer.renderer?.tileCache?.getCachedTiles?.() ?? []).length;
		});

		// **The `info.json` arrives** — the Alignment was accepted and the layer has bounds, asserted
		// in the previous test. That half of ADR-0011 held even before the patch.
		//
		// **And so do the tiles**, which is the half that needed the patch and the half ADR-0011's
		// whole injection story rests on. Asserted as cached tiles rather than as an absence of errors,
		// because the pre-patch failure was precisely an error that upstream swallowed: a suite that
		// only checked the console went green while the map rendered blank.
		expect(
			cachedTiles,
			'no tile reached the renderer through the ProjectStore shim — if `scripts/check-allmaps-patch.mjs` ' +
				'is passing, look for an upstream change to how fetchFn crosses into the tile worker'
		).toBeGreaterThan(0);

		const dataClone = consoleErrors.filter((text) => /DataClone|could not be cloned/i.test(text));
		expect(dataClone, 'fetchFn failed to cross into the tile worker').toEqual([]);
		expect(consoleErrors.filter((text) => text.includes('unset.invalid'))).toEqual([]);
	});
});
