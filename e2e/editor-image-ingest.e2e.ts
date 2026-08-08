import { expect, test, type Page } from '@playwright/test';
import zlib from 'node:zlib';

import { waitForStoredLayers } from './support/saved';

/**
 * SPEC's Seam 2 for the tiler: a file picked in the running app, in a real browser, against real
 * OPFS (SPEC stories 21, 22, 23).
 *
 * The tile geometry is asserted in `@ballastella/core`, against both tilers and against the
 * committed fixture pyramid. What can only be asserted here is the rest of it: that a file picker
 * reaches the tiler at all, that progress is announced while it runs, that the pyramid lands in
 * the user's Workspace as files, and that `wasm-vips` is not fetched by an ingest that does not
 * need it — which is the ADR-0019 boundary, and the one thing tree-shaking cannot be trusted with.
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

/**
 * A greyscale PNG of `width` × `height` with a diagonal gradient.
 *
 * Built here rather than committed, so this file needs no binary fixture and the dimensions can be
 * chosen to produce a pyramid small enough to finish quickly and deep enough to have more than one
 * level. 700 × 500 gives scale factors 1, 2 and 4 and nine tiles.
 */
function gradientPng(width: number, height: number): Buffer {
	const raw = Buffer.alloc((width + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (width + 1);
		raw[row] = 0; // filter: none
		for (let x = 0; x < width; x++) {
			raw[row + 1 + x] = (x * 255) / width / 2 + (y * 255) / height / 2;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 0; // greyscale
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

/**
 * A PNG with a real signature and IHDR and no image data at all.
 *
 * The routing decision is made from the header (`readImageHeader`) precisely so that a scan above
 * the decode ceiling is never handed to a decoder, so a header is all a test of that decision
 * needs — and it is all it can afford: 20000 × 15000 of actual pixels is 300 MB in this process
 * before it is even sent.
 */
function pngHeaderOnly(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 0; // greyscale
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IEND', Buffer.alloc(0))
	]);
}

/** Empty the origin's OPFS, so no test can see another's Projects. */
async function emptyWorkspace(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
	});
}

/**
 * Every file under one Workspace directory, recursively, with its byte length.
 *
 * `''` walks the whole Workspace. Since ADR-0023 a pyramid lands at `images/<id>/` at the root rather
 * than inside the Project, so a helper scoped to the Project directory would see nothing an ingest wrote
 * and every assertion below it would pass vacuously.
 */
async function filesIn(page: Page, directory: string): Promise<Record<string, number>> {
	return page.evaluate(async (directory) => {
		const files: Record<string, number> = {};
		const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
			for await (const [name, entry] of handle.entries()) {
				if (entry.kind === 'file') {
					files[`${prefix}${name}`] = (await (entry as FileSystemFileHandle).getFile()).size;
				} else {
					await walk(entry as FileSystemDirectoryHandle, `${prefix}${name}/`);
				}
			}
		};
		const root = await navigator.storage.getDirectory();
		await walk(directory === '' ? root : await root.getDirectoryHandle(directory), '');
		return files;
	}, directory);
}

/** One JSON file out of OPFS. `''` as the directory reads from the Workspace root (ADR-0023). */
const readJson = (page: Page, directory: string, path: string): Promise<unknown> =>
	page.evaluate(
		async ([directory, path]) => {
			const root = await navigator.storage.getDirectory();
			let handle = directory === '' ? root : await root.getDirectoryHandle(directory as string);
			const segments = (path as string).split('/');
			for (const segment of segments.slice(0, -1)) {
				handle = await handle.getDirectoryHandle(segment);
			}
			const file = await handle.getFileHandle(segments[segments.length - 1] as string);
			return JSON.parse(await (await file.getFile()).text());
		},
		[directory, path]
	);

/** Records what the live region says, so the announcements can be asserted after the fact. */
async function recordAnnouncements(page: Page): Promise<void> {
	await page.evaluate(() => {
		const seen: string[] = [];
		(window as unknown as { announced: string[] }).announced = seen;
		new MutationObserver(() => {
			for (const region of document.querySelectorAll('[role="status"], [aria-live]')) {
				const text = region.textContent?.replace(/\s+/g, ' ').trim() ?? '';
				if (text && seen[seen.length - 1] !== text) seen.push(text);
			}
		}).observe(document.body, { childList: true, subtree: true, characterData: true });
	});
}

const announcements = (page: Page): Promise<string[]> =>
	page.evaluate(() => (window as unknown as { announced: string[] }).announced);

async function createProject(page: Page, name: string): Promise<void> {
	await page.getByRole('button', { name: 'New Project' }).click();
	await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill(name);
	await page
		.getByRole('dialog', { name: 'New Project' })
		.getByRole('button', { name: 'Create' })
		.click();
}

test.describe('adding a Historical Map from a file', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await emptyWorkspace(page);
		await page.reload();
	});

	test('turns a picked file into a pyramid in the Project, with progress announced', async ({
		page
	}) => {
		const requested: string[] = [];
		page.on('request', (request) => requested.push(request.url()));

		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();
		await expect(page.getByText('This Project has no Historical Maps yet.')).toBeVisible();

		await recordAnnouncements(page);

		// The picker is reached by its label, which is what a screen-reader user and a keyboard user
		// both have to go on (ADR-0016).
		await page.getByLabel('Add a Historical Map from a file').setInputFiles({
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(700, 500)
		});

		// 700 × 500 at 256-pixel tiles: 3 × 2 at scale factor 1, 2 × 1 at 2, and 1 at 4.
		const expectedTiles = 9;
		await expect(page.getByTestId('layer-row')).toHaveCount(1, { timeout: 30_000 });
		await expect(page.getByText('This Project has no Historical Maps yet.')).toBeHidden();

		// SPEC story 23: the tool said what it was doing, in a live region, with real numbers.
		// (`announcements` sees every live region on the page, so the save indicator's own "Saved" is
		// in here too — hence the assertions are on what was said, not on the last entry.)
		const said = await announcements(page);
		expect(said.some((text) => /Reading la-floride\.png/.test(text))).toBe(true);
		expect(said.filter((text) => /tile \d+ of 9/.test(text)).length).toBeGreaterThan(1);

		// And it stopped saying it. A progress bar left on the page after the job is the other half
		// of story 23: a scholar cannot tell a finished ingest from a stuck one.
		await expect(page.getByRole('progressbar')).toHaveCount(0);

		const imageId = (await page.getByTestId('layer-row').first().getAttribute('data-image-id'))!;
		expect(imageId).toMatch(/^[0-9a-f]{16}$/);

		// The whole Workspace, because the pyramid is the Workspace's (ADR-0023).
		const files = await filesIn(page, '');
		const tiles = Object.keys(files).filter((path) => path.endsWith('/0/default.jpg'));
		expect(tiles).toHaveLength(expectedTiles);
		expect(files[`images/${imageId}/info.json`]).toBeGreaterThan(0);
		expect(files[`images/${imageId}/manifest.json`]).toBeGreaterThan(0);
		// **And no bytes inside the Project directory** beyond the document it already had. A pyramid is
		// prepared once and shared, so a copy landing inside whichever Project happened to be open is the
		// failure ADR-0023 exists to end. `project.json` itself is untouched: the Layer arrives when the map
		// is aligned, and a write with nothing behind it would stamp a fresh `updatedAt` (ADR-0010).
		expect(Object.keys(files).filter((path) => path.startsWith('amsterdam-1625/'))).toEqual([
			'amsterdam-1625/project.json'
		]);

		const info = (await readJson(page, '', `images/${imageId}/info.json`)) as Record<
			string,
			unknown
		>;
		expect(info.id).toBe(`https://unset.invalid/${imageId}`);
		expect(info.profile).toBe('level0');
		expect(info.width).toBe(700);
		expect(info.height).toBe(500);
		expect(info.tiles).toEqual([{ width: 256, height: 256, scaleFactors: [1, 2, 4] }]);

		// Every tile the pyramid declares is at the path IIIF says it is.
		expect(tiles.sort()).toEqual(
			[
				`images/${imageId}/0,0,256,256/256,256/0/default.jpg`,
				`images/${imageId}/256,0,256,256/256,256/0/default.jpg`,
				`images/${imageId}/512,0,188,256/188,256/0/default.jpg`,
				`images/${imageId}/0,256,256,244/256,244/0/default.jpg`,
				`images/${imageId}/256,256,256,244/256,244/0/default.jpg`,
				`images/${imageId}/512,256,188,244/188,244/0/default.jpg`,
				`images/${imageId}/0,0,512,500/256,250/0/default.jpg`,
				`images/${imageId}/512,0,188,500/94,250/0/default.jpg`,
				`images/${imageId}/0,0,700,500/175,125/0/default.jpg`
			].sort()
		);

		// ADR-0019: libvips is fetched when the streaming path is taken, and this ingest did not take
		// it. Asserted on the network rather than on the bundle, because a `modulepreload` the entry
		// chunk happens to carry would not show up in a grep for the package name.
		expect(requested.filter((url) => /vips/i.test(url))).toEqual([]);
	});

	test('says what is wrong, and adds nothing, when the file is not an image', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();

		await page.getByLabel('Add a Historical Map from a file').setInputFiles({
			name: 'notes.txt',
			mimeType: 'text/plain',
			buffer: Buffer.from('this is not a map')
		});

		await expect(page.getByRole('alert')).toContainText('could not be read as an image');
		await expect(page.getByText('This Project has no Historical Maps yet.')).toBeVisible();

		// The whole Workspace: an ingest that failed must leave no pyramid at the root either.
		expect(Object.keys(await filesIn(page, ''))).toEqual(['amsterdam-1625/project.json']);
	});

	test('a user can stop an ingest, and nothing is left behind', async ({ page }) => {
		// `ingestImageFile` has taken an `AbortSignal` and cleaned up after itself since it was
		// written, and `ingest.ts` said the job "can be cancelled" — but nothing in the app supplied a
		// signal, so a scholar who picked the wrong four-thousand-tile scan had no way out of it. The
		// unit tests covered the mechanism and could not see that it was unreachable.
		//
		// 2600 × 2600 is 171 tiles: long enough that the button is on screen to be clicked, short
		// enough not to dominate the suite.
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();

		await page.getByLabel('Add a Historical Map from a file').setInputFiles({
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(2600, 2600)
		});

		// Named for what it cancels rather than just "Cancel", which tells a screen-reader user
		// nothing when it is one of several buttons on the page (ADR-0016, story 96).
		const cancel = page.getByRole('button', { name: 'Cancel preparing la-floride.png' });
		await expect(cancel).toBeVisible();
		await expect(cancel).toBeEnabled();
		await cancel.click();

		// The job ends, and it ends without an error: the user asked for this.
		await expect(page.getByRole('progressbar')).toHaveCount(0, { timeout: 30_000 });
		await expect(page.getByRole('alert')).toHaveCount(0);

		// And the Project is as it was. The tiles already written are removed, which matters because
		// a Workspace is a folder in git or Dropbox (ADR-0008) and litter in it is the user's problem.
		await expect(page.getByText('This Project has no Historical Maps yet.')).toBeVisible();
		expect(Object.keys(await filesIn(page, ''))).toEqual(['amsterdam-1625/project.json']);
	});

	test('refuses a scan above the decode ceiling by naming the deployment, not the file', async ({
		page
	}) => {
		// **The refusal a scholar on GitHub Pages actually meets, asserted on the shipped path.**
		//
		// `apps/editor` always supplies a streaming tiler, so the "this build has no streaming tiler"
		// refusal that `@ballastella/core` unit-tests is unreachable here. What happens instead is
		// that the tiler exists and cannot run: npm publishes only the threaded `wasm-vips`, which
		// needs a cross-origin isolated document, and no static host sends COOP/COEP — which is
		// exactly the state this preview server is in, so no header stubbing is needed to reach it.
		//
		// It used to arrive wrapped in "This file could not be read as an image … a TIFF or JPEG 2000
		// archival master needs to be converted first", about a perfectly valid PNG. SPEC's *On the
		// audience* makes that a defect: the error must name what is wrong and what to do.
		const requested: string[] = [];
		page.on('request', (request) => requested.push(request.url()));

		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();

		// 20000 × 15000 is 300 megapixels, above the 268 megapixel routing threshold.
		await page.getByLabel('Add a Historical Map from a file').setInputFiles({
			name: 'archival-master.png',
			mimeType: 'image/png',
			buffer: pngHeaderOnly(20_000, 15_000)
		});

		const alert = page.getByRole('alert');
		await expect(alert).toContainText('300 megapixels');
		await expect(alert).toContainText('Cross-Origin-Embedder-Policy');
		await expect(alert).toContainText('convert it to a IIIF pyramid outside the browser');
		await expect(alert, 'the refusal blames the file instead of the deployment').not.toContainText(
			'could not be read as an image'
		);

		// Nothing added, and nothing fetched: the decision is made from the header, so neither a
		// decoder nor 5 MB of WebAssembly is ever reached.
		await expect(page.getByText('This Project has no Historical Maps yet.')).toBeVisible();
		expect(Object.keys(await filesIn(page, ''))).toEqual(['amsterdam-1625/project.json']);
		expect(requested.filter((url) => /vips/i.test(url))).toEqual([]);
	});

	test('shows an image that was already in the Project when it is opened', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await page.getByLabel('Add a Historical Map from a file').setInputFiles({
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(700, 500)
		});
		await expect(page.getByTestId('layer-row')).toHaveCount(1, { timeout: 30_000 });
		// **The row being on screen is not the thing this test reloads onto** (ticket 17). `project.json`
		// is written on autosave's 400 ms debounce (ADR-0017 rule 2), and a reload takes the Workspace
		// as it is on disk — so reloading here on the strength of the row alone was a race with the
		// write, and it lost in 1 of the 10 runs measured on 2026-08-07 (`toHaveCount(1) … Received: 0`,
		// which reads exactly like the Project not having remembered it). Waiting for the file is not a
		// weaker claim than this test makes; it is the claim, since "already in the Project" means in
		// the document.
		await waitForStoredLayers(page, 1);

		// Reopening reads it back from the store rather than remembering it.
		await page.reload();
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
	});
});
