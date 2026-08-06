import { expect, test, type Page } from '@playwright/test';
import zlib from 'node:zlib';

/**
 * ADR-0011's second injection point, in a real browser: `new WarpedMapLayer({ fetchFn })`.
 *
 * Nothing is warped here and nothing is meant to be — there is no Alignment in the app until
 * ticket 07. What this asserts is the wiring, and it asserts three things that a type check
 * cannot: that `@allmaps/maplibre` resolves against the one `maplibre-gl` copy in the page
 * (two copies is a broken map rather than a version warning), that the layer survives being
 * added to a real map with a real WebGL2 context, and that it sends nothing to the placeholder
 * host on its own.
 *
 * See `editor-warped-fetch.e2e.ts`'s last test for the limit of what this can establish, and the
 * ticket comment on `@allmaps/render`'s worker boundary for why that limit matters to ticket 07.
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

async function createProject(page: Page, name: string): Promise<void> {
	await page.getByRole('button', { name: 'New Project' }).click();
	await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill(name);
	await page
		.getByRole('dialog', { name: 'New Project' })
		.getByRole('button', { name: 'Create' })
		.click();
}

async function emptyWorkspace(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
	});
}

declare global {
	interface Window {
		ballastellaWarped?: {
			map: {
				fitBounds(bounds: unknown, options?: unknown): void;
				once(event: string, handler: () => void): void;
			};
			layer: {
				addGeoreferencedMap(map: unknown): string | Error;
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
	test('adds a WarpedMapLayer built with the Project’s fetchFn, and asks the network for nothing', async ({
		page
	}) => {
		const requested: string[] = [];
		page.on('request', (request) => requested.push(request.url()));
		const consoleErrors: string[] = [];
		page.on('console', (message) => {
			if (message.type() === 'error') consoleErrors.push(message.text());
		});

		await page.goto('/');
		await emptyWorkspace(page);
		await page.reload();
		await createProject(page, 'Amsterdam 1625');

		await page.goto('./warped/?p=amsterdam-1625');
		await expect(page.getByRole('heading', { level: 1, name: 'Warped rendering' })).toBeVisible();

		const status = page.getByTestId('warped-status');
		await expect(status).toContainText('Warped map layer added');
		await expect(status).toContainText('amsterdam-1625');
		// MapLibre gave the layer an id, which it only does once `onAdd` has run against the map's
		// own WebGL2 context — the point at which two MapLibre copies, or a worker the bundler
		// could not see, would have failed instead.
		await expect(status).not.toHaveAttribute('data-layer-id', '');

		// The layer holds no maps, so it must not have gone looking for tiles.
		expect(requested.filter((url) => url.includes('unset.invalid'))).toEqual([]);
		expect(consoleErrors.filter((text) => /unset\.invalid|DataClone/i.test(text))).toEqual([]);
	});

	test('reaches the pyramid’s info.json AND its tiles through the shim', async ({ page }) => {
		// This test used to assert the opposite of its own name: `@allmaps/render@1.0.0-beta.83`
		// passes `fetchFn` into its Comlink tile worker unproxied — the abort callback beside it *is*
		// `Comlink.proxy()`-wrapped — so every tile failed with a `DataCloneError` that upstream logs
		// and swallows, and the symptom was a blank warped map with nothing surfaced.
		//
		// `patches/@allmaps__render@1.0.0-beta.83.patch` fixes it. Note that the obvious one-line fix
		// does NOT work: the worker's `fetchUrl` does `await fetchFn(...)` and expects a `Response`,
		// and a Response is not structured-cloneable, so proxying the function merely trades the
		// DataCloneError for TypeError("Unserializable return value"). The patch instead runs the
		// custom fetch on the main thread — where the closure lives — and hands the worker a `blob:`
		// URL, keeping the decode off the main thread. `scripts/check-allmaps-patch.mjs` fails the
		// build if that patch stops applying, because this failure mode is silent.
		//
		// It is in this slice rather than in ticket 07 because it is about the injection layer, not
		// about warped rendering: the question is whether the `fetchFn` ADR-0011 chose as the
		// injection point for `@allmaps/maplibre` actually delivers bytes. Answering it needs a
		// georeferenced map, which the app cannot make until Alignments exist, so the suite supplies
		// one through the dev route's test handle.
		const consoleErrors: string[] = [];
		page.on('console', (message) => {
			if (message.type() === 'error') consoleErrors.push(message.text());
		});
		page.on('pageerror', (error) => consoleErrors.push(`${error.name}: ${error.message}`));

		await page.goto('/');
		await emptyWorkspace(page);
		await page.reload();
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();

		// A pyramid in the Project, made the ordinary way, so what follows is asserted against real
		// stored tiles rather than a fixture.
		await page.getByLabel('Add a Historical Map from a file').setInputFiles({
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(700, 500)
		});
		await expect(page.getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
		const imageId = (await page.getByRole('listitem').first().innerText()).trim();

		await page.goto('./warped/?p=amsterdam-1625');
		await expect(page.getByTestId('warped-status')).toContainText('Warped map layer added');

		const outcome = await page.evaluate(async (imageId) => {
			const warped = window.ballastellaWarped;
			if (!warped) return { error: 'the warped layer was not exposed' };

			// A four-point georeferenced map over the whole image, placed somewhere in Amsterdam. The
			// numbers are arbitrary: what is being exercised is the fetch path, not the transform.
			const added = warped.layer.addGeoreferencedMap({
				type: 'GeoreferencedMap',
				resource: {
					id: `https://unset.invalid/${imageId}`,
					type: 'ImageService3',
					width: 700,
					height: 500
				},
				gcps: [
					{ resource: [0, 0], geo: [4.88, 52.38] },
					{ resource: [700, 0], geo: [4.92, 52.38] },
					{ resource: [700, 500], geo: [4.92, 52.36] },
					{ resource: [0, 500], geo: [4.88, 52.36] }
				],
				resourceMask: [
					[0, 0],
					[700, 0],
					[700, 500],
					[0, 500]
				]
			});

			if (added instanceof Error) return { error: `${added.name}: ${added.message}` };

			// Bring it into view so tiles are actually asked for, then let the renderer work.
			warped.map.fitBounds(warped.layer.getBounds(), { animate: false });
			await new Promise((resolve) => setTimeout(resolve, 4000));

			// A *cached* tile is one whose bytes arrived and decoded — `CacheableTile.isCachedTile()`
			// is `data !== undefined`, and `data` is the ImageData the worker produced. So this counts
			// tiles that made it all the way through the shim, not tiles that were merely requested.
			const cached = warped.layer.renderer?.tileCache?.getCachedTiles?.() ?? [];
			return { mapId: added, cachedTiles: cached.length };
		}, imageId);

		expect(outcome.error, 'the georeferenced map was rejected').toBeUndefined();
		expect(outcome.mapId).toBeTruthy();

		// **The `info.json` arrives.** `WarpedMap` loads the image information on the main thread, so
		// our shim is called and the pyramid is found: adding the map at all would have failed
		// otherwise, and the layer has bounds to fit.
		//
		// **And so do the tiles**, which is the half that needed the patch and the half ADR-0011's
		// whole injection story rests on. Asserted as cached tiles rather than as an absence of
		// errors, because the pre-patch failure was precisely an error that upstream swallowed: a
		// suite that only checked the console went green while the map rendered blank.
		expect(
			outcome.cachedTiles,
			'no tile reached the renderer through the ProjectStore shim — if `scripts/check-allmaps-patch.mjs` ' +
				'is passing, look for an upstream change to how fetchFn crosses into the tile worker'
		).toBeGreaterThan(0);

		const dataClone = consoleErrors.filter((text) => /DataClone|could not be cloned/i.test(text));
		expect(dataClone, 'fetchFn failed to cross into the tile worker').toEqual([]);
		expect(consoleErrors.filter((text) => text.includes('unset.invalid'))).toEqual([]);
	});
});
