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

	test('reaches the pyramid’s info.json through the shim, and cannot reach its tiles', async ({
		page
	}) => {
		// **This test documents a defect in `@allmaps/render@1.0.0-beta.83`, and it will fail when
		// that defect is fixed.** Read the expectations at the bottom before changing anything here.
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
			return { mapId: added };
		}, imageId);

		expect(outcome.error, 'the georeferenced map was rejected').toBeUndefined();
		expect(outcome.mapId).toBeTruthy();

		// **The `info.json` arrived.** `WarpedMap` loads the image information on the main thread, so
		// our shim is called and the pyramid is found: adding the map at all would have failed
		// otherwise, and the layer has bounds to fit. That half of ADR-0011 holds.
		//
		// **The tiles cannot.** `@allmaps/render`'s WebGL2 renderer fetches every tile inside a
		// Comlink worker and passes `fetchFn` across the boundary **unproxied** —
		// `CacheableWorkerImageDataTile.fetch` wraps the abort callback beside it in
		// `Comlink.proxy()` and does not wrap this one — so `postMessage` refuses to clone it and
		// every tile fails with a `DataCloneError` logged and swallowed. A function cannot cross a
		// structured-clone boundary; there is nothing this repository can pass that would.
		//
		// So this expectation asserts the defect, deliberately, rather than leaving the slice
		// claiming an injection point that does not carry bytes. **When it starts failing, that is
		// the upstream fix landing** — delete the expectation, and assert the tiles instead.
		const dataClone = consoleErrors.filter((text) => /DataClone|could not be cloned/i.test(text));
		expect(
			dataClone.length,
			`expected @allmaps/render to fail cloning fetchFn into its tile worker; console errors were:\n${consoleErrors.join('\n')}`
		).toBeGreaterThan(0);
	});
});
