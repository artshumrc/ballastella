import { expect, test } from './support/test.js';
import { type Page } from '@playwright/test';
import zlib from 'node:zlib';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	addHistoricalMapButton,
	expectNothingPreparing,
	pickHistoricalMapFile
} from './support/historical-maps.js';
import { alignFromLayer } from './support/layers';
import { showPaneDetails } from './support/alignment-workspace.js';

// Every spec in this suite is behind the default-deny network fence in `support/network-fence.ts`,
// and this deployment's Base Map catalog points every entry at an archive on somebody else's host.
// So the archive is served from the committed fixture, in one place, for the whole file.
//
// **`context` rather than `page`**: a request that has passed through a service worker is not the
// page's own as far as Playwright is concerned, and `page.route` never sees it (measured in
// `editor-pwa.e2e.ts`, which says so at its own interception). Routing the context has no downside
// for a spec with no worker, and is the spelling that keeps working when one appears.
test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

/**
 * SPEC's Seam 2 for the injection layer: the user's own Historical Map, deep-zoomed in the
 * running app, with every byte coming out of real OPFS (SPEC story 31, and story 8's mechanism).
 *
 * **This suite is the only place the no-network claim can be made.** The routing rule itself is
 * asserted numerically in `@ballastella/core`, against a pyramid the tiler wrote; what only a
 * browser can establish is the negative — that nothing leaks out to `unset.invalid` and nothing
 * falls back to ticket 03's static-asset fixture — and that MapLibre, whose tile loading is the
 * thing being injected into, is satisfied by what the shim hands it.
 *
 * It also has to reach inside the page for one thing. Up to ticket 05 "tiles at every scale
 * factor load, ragged edges included" was asserted on Playwright's `response` event, because the
 * fixture pyramid was served over HTTP. A pyramid read from OPFS issues **no request at all**, so
 * that criterion now has no network to be asserted on; `window.ballastellaServedTiles` is the
 * app's own log of what it drew, on the same terms as ticket 04's `ballastellaBaseMap`.
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
 * A greyscale PNG with a diagonal gradient, built here so no binary fixture is needed and the
 * dimensions can be chosen. Neither dimension is a multiple of 256, so both the right and the
 * bottom margin are ragged at every level — which is the geometry this slice has to get right.
 */
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

/** The app's own log of tiles it drew. See `apps/editor/src/lib/image-pane/browser-test-handle.ts`. */
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

/** Empty the origin's OPFS, so no test can see another's Projects. */
async function emptyWorkspace(page: Page): Promise<void> {
	await page.evaluate(async () => {
		// The whole of browser storage, which since ticket 12 is **every named Workspace** rather than
		// one — so no test can see another's, whichever Workspace it was in.
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

/**
 * Collect the app's log of tiles it drew, from the first line of script the page runs.
 *
 * **Installed before navigation, not after the pane appears, and that is the whole point.**
 * MapLibre caches tiles by URL, so a tile it has already fetched is never fetched again — and a
 * log started after the pane had opened therefore missed every tile of the opening view *and*
 * every later visit to those levels. The symptom was scale factor 2 intermittently absent, which
 * read exactly like the pane failing to load a level.
 */
const collectServedTiles = (page: Page) =>
	page.addInitScript(() => {
		window.ballastellaServedTiles = [];
	});

/** Forget the tiles drawn so far, so what follows can be attributed to what follows. */
const clearServedTiles = (page: Page) =>
	page.evaluate(() => {
		window.ballastellaServedTiles = [];
	});

const servedTiles = (page: Page): Promise<ServedTile[]> =>
	page.evaluate(() => window.ballastellaServedTiles ?? []);

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
 * The wait is load-bearing rather than tidiness: a Project is selected client-side from `?p=`
 * (ADR-0008), so for a moment after the click the hub is still rendered — and the hub lists
 * Projects as list items, which is the same role the Historical Maps are counted by below.
 */
async function openProject(page: Page, name: string): Promise<void> {
	await page.getByRole('link', { name }).click();
	await expect(addHistoricalMapButton(page)).toBeVisible();
}

/**
 * Every Historical Map this Project draws, by image id.
 *
 * Read off the Layer rows since ticket 04: a Historical Map arrives with its Layer (ADR-0023), and
 * the separate list of image ids on the Project page is gone.
 */
const listedImageIds = async (page: Page): Promise<string[]> =>
	(
		await page
			.getByTestId('layer-row')
			.evaluateAll((rows) =>
				rows.map((row) => (row as HTMLElement).dataset.imageId ?? '').filter(Boolean)
			)
	).sort();

/**
 * Ingest one image, wait for its pyramid to be complete, and return **its** image id.
 *
 * The id is found by difference rather than by position. Historical Maps are listed in the order
 * `ProjectStore.list` returns them, which is sorted by path and therefore by id — an id minted by
 * `generateRandomId()`, so the map just added is in a random place in the list. Taking the last
 * entry passed roughly half the time, which is the worst possible kind of test.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * **THE LAYER ROW IS A TRANSIENT SIGNAL, NOT A SETTLED ONE** (ticket 17, and the fourth copy of
 * the same defect).
 *
 * `EditorSession.ingestImage` publishes the Layer — and therefore this row — from `#addMapLayer`,
 * and then keeps running: it lists the Workspace's pyramids and only then clears `ingest`, which
 * is what re-enables the file input. Returning at the row left this helper's caller inside that
 * window, and the *second* call then picked a file on a still-disabled input.
 * `setInputFiles` performs no enabled check — it dispatches `change` on a disabled input
 * regardless (measured on @playwright/test 1.62.1) — so the app saw the pick, and before this
 * ticket dropped it in silence. `toHaveCount(2)` then waited its whole 30 s against a DOM that had
 * settled at one row and was never going to move.
 *
 * **Measured, 2026-08-08: 6 of 30 first attempts, 20%, in isolation on a quiet machine** — every
 * one of them on the *second* ingest, every one `Received: 1` after 30 s, while a healthy run of
 * the whole test is ~6 s. That gap is what rules out load: this is not slow work, it is work that
 * never started. A probe correlated it 8 times out of 8 — input disabled at the second pick ⇒ one
 * row forever; input enabled ⇒ two rows.
 *
 * `editor-pwa.e2e.ts`'s `startProjectWithMap` was given exactly this fix by ticket 17 and says the
 * same thing at its own wait. This is the copy that did not get it.
 */
async function ingest(page: Page, width: number, height: number, name: string): Promise<string> {
	const before = await listedImageIds(page);
	await pickHistoricalMapFile(page, {
		name,
		mimeType: 'image/png',
		buffer: gradientPng(width, height)
	});
	await expect(page.getByTestId('layer-row')).toHaveCount(before.length + 1, { timeout: 30_000 });
	// And then the settled state: the preparing card leaves the stack when `session.ingest` is
	// cleared, which is the last thing the ingest does. Until then this Historical Map is on screen
	// but the gesture that adds the next one has nowhere to land — since ticket 06 it is refused in
	// words rather than dropped, and this wait is what keeps the refusal off a test that means to add
	// two maps.
	await expectNothingPreparing(page, 30_000);
	const added = (await listedImageIds(page)).filter((id) => !before.includes(id));
	expect(added, `expected exactly one new Historical Map after ingesting ${name}`).toHaveLength(1);
	return added[0]!;
}

/**
 * Press Align **on a Layer** and land on the pane, which is `/align/?p=…&layer=…`.
 *
 * Ticket 04 moved Align onto the Layer that needs it and deleted the Project page's separate list of
 * image ids with its per-map selector buttons — there is one door per Historical Map now, and it is
 * on the Historical Map. Naming the image is therefore choosing a row rather than pressing a
 * selector and then a shared button; with no name given, the first Layer in the stack is taken.
 */
async function openPane(page: Page, imageId?: string): Promise<void> {
	const row =
		imageId === undefined
			? page.getByTestId('layer-row').first()
			: page.locator(`[data-testid="layer-row"][data-image-id="${imageId}"]`);
	// Opened first: since ticket 05 the Align link is inside the Layer's row rather than beside it.
	await alignFromLayer(page, row);
	await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);
}

/** Back to the Project, where the Layers — and their Historical Maps — are. */
async function backToProject(page: Page): Promise<void> {
	await page.getByTestId('back-to-project').click();
	await expect(addHistoricalMapButton(page)).toBeVisible();
}

/**
 * Wait for the pane to have settled.
 *
 * `timeout` is overridable because every tile here is an OPFS read and the suite runs ten workers
 * each driving a real WebGL map against real OPFS — the contention the tracker already records. A
 * pyramid with more levels than the usual fixture's takes longer to settle, and the default 5 s is
 * a measurement of the machine rather than of the pane.
 */
const waitForTiles = (page: Page, timeout?: number) =>
	expect(page.getByTestId('historical-map-tiles')).toHaveAttribute(
		'data-tiles-loaded',
		'true',
		timeout === undefined ? undefined : { timeout }
	);

const pyramidReadout = (page: Page) => page.getByTestId('historical-map-pyramid');

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

const mapZoom = async (page: Page) =>
	Number(await page.getByTestId('historical-map-zoom').innerText());

/**
 * Every request the page made, so the two negatives can be asserted. Attached before the first
 * navigation, because a fallback to the fixture would happen while the pane is mounting.
 */
function recordRequests(page: Page): string[] {
	const requested: string[] = [];
	page.on('request', (request) => requested.push(request.url()));
	return requested;
}

test.describe('a Historical Map read from the Project', () => {
	test('deep-zooms the user’s own pyramid with nothing fetched from the network', async ({
		page
	}) => {
		const requested = recordRequests(page);
		await collectServedTiles(page);

		await page.goto('/');
		await emptyWorkspace(page);
		await page.reload();
		await createProject(page, 'Amsterdam 1625');
		await openProject(page, 'Amsterdam 1625');

		const imageId = await ingest(page, 700, 500, 'la-floride.png');
		await openPane(page);
		await waitForTiles(page);
		// The readout this test is about is behind the pane's "Image details" disclosure, and it is
		// rendered only when open — see `showPaneDetails`.
		await showPaneDetails(page);

		// The pyramid on screen is the one that was just written, stated as text so a pane showing
		// some other image cannot pass.
		await expect(pyramidReadout(page)).toHaveAttribute('data-image-id', imageId);
		await expect(pyramidReadout(page)).toContainText('700 × 500 pixels');
		await expect(pyramidReadout(page)).toContainText('scale factors 1, 2, 4');
		await expect(page.getByTestId('image-pane')).toBeVisible();

		// Walk out to the coarsest level and back in one level at a time, requiring each level of
		// the pyramid to have been served before moving on.
		//
		// **Waiting for the level, and logging tiles from page load, is what makes this
		// deterministic.** Two earlier versions were not, and both failed the same way — scale factor
		// 2 absent about one run in ten, which reads exactly like the pane failing to load a level.
		// The cause was not the walk but the log: MapLibre never fetches a tile twice, so starting
		// the log after the pane had opened permanently lost the levels the opening view had already
		// visited. `collectServedTiles` is therefore installed before navigation. Waiting on
		// `data-tiles-loaded` per step was a second, smaller race: the attribute is `true` from the
		// previous settle until MapLibre's `zoom` event clears it.
		await button(page, 'Fit whole map').click();
		await waitForTiles(page);
		for (let step = 0; step < 6; step++) {
			await button(page, 'Zoom out one level').click();
		}
		await waitForTiles(page);

		// A 700 × 500 image fits one 256-pixel tile at scale factor 4, so the pyramid's tile zooms
		// are 12, 13 and 14. MapLibre asks a 256-pixel raster source for tile zoom `map zoom + 1`,
		// which pairs map zoom 11 with scale factor 4, 12 with 2, and 13 with 1.
		expect(await mapZoom(page)).toBe(11);

		for (const [zoom, scaleFactor] of [
			[11, 4],
			[12, 2],
			[13, 1]
		] as const) {
			while ((await mapZoom(page)) < zoom) {
				await button(page, 'Zoom in one level').click();
			}
			await expect
				.poll(async () => (await servedTiles(page)).some((t) => t.scaleFactor === scaleFactor), {
					message: `no tile at scale factor ${scaleFactor} was served by map zoom ${zoom}`,
					// Past the default 5 s, because every tile here is an OPFS read and the suite runs
					// ten workers each driving a real WebGL map against real OPFS — the contention the
					// tracker already records against it. A level that is genuinely never requested
					// still fails, just later.
					timeout: 15_000
				})
				.toBe(true);
		}
		await waitForTiles(page);

		const tiles = await servedTiles(page);

		// Every level, and a ragged tile at the right and the bottom margin of each.
		//
		// This is a claim about *which tiles were served*, and deliberately nothing more: `placement`
		// here is read out of the app's own log of what `pane.tileAt` returned, so it cannot say
		// anything about where the pixels landed. Whether a ragged tile is *drawn* at its placement is
		// asserted on canvas pixels in `packages/core`'s `pad-tile-to-cell.browser.test.ts` — a
		// distinction that mattered: the drawing code could be changed to use the served size instead
		// and this log would be identical.
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

		// Every tile drawn belongs to this image and was addressed on the placeholder host, which
		// is the only address the store answers on (ADR-0011).
		expect(
			tiles.filter((tile) => !tile.url.startsWith(`https://unset.invalid/${imageId}/`))
		).toEqual([]);

		// **The hard fail.** Not one request left the page for the placeholder host: the tiles were
		// read from OPFS, and a forgotten override anywhere on this path would show up right here.
		expect(requested.filter((url) => url.includes('unset.invalid'))).toEqual([]);

		// And no static-asset fallback: ticket 03's fixture is still committed, and this pane must
		// never be quietly showing it.
		expect(requested.filter((url) => url.includes('/fixtures/'))).toEqual([]);
	});

	test('renders the correct pyramid for each of two Historical Maps in one Project', async ({
		page
	}) => {
		// **A budget, not a race** (ticket 17). This is the only test in the suite that ingests two
		// whole pyramids, and each ingest is a real tiling of a real PNG; on the 10 baseline runs of
		// 2026-08-07 it exhausted the then-default 30 s in 1 of 10 and reported it as
		// `toHaveCount(2) … Received: 1`, which reads exactly like a Layer that never arrived. It is
		// not — the second ingest was still running. Stated here rather than raised at the assertion
		// so the number is attached to the reason.
		test.setTimeout(120_000);
		const requested = recordRequests(page);
		await collectServedTiles(page);

		await page.goto('/');
		await emptyWorkspace(page);
		await page.reload();
		await createProject(page, 'Amsterdam 1625');
		await openProject(page, 'Amsterdam 1625');

		// Deliberately different *shapes*, not merely different sizes: 700 × 500 fits a single tile
		// at scale factor 4 and 300 × 1300 needs one more halving, so the two pyramids have a
		// different number of levels. A pane repointed at the wrong image would keep the first
		// one's zoom range, and the readout below is where that shows.
		const wide = await ingest(page, 700, 500, 'wide.png');
		const tall = await ingest(page, 300, 1300, 'tall.png');
		expect(wide).not.toBe(tall);

		// The first Layer in the stack, and it is one of these two. *Which* one is not asserted on
		// purpose: Layer order follows the order the maps were added and the ids are random, so
		// pinning it here would be pinning `generateRandomId`.
		await openPane(page);
		await waitForTiles(page);
		await showPaneDetails(page);
		await expect(pyramidReadout(page)).toHaveAttribute(
			'data-image-id',
			new RegExp(`${wide}|${tall}`)
		);

		/**
		 * Pick a Historical Map and require the pane to be showing *that whole pyramid* — its
		 * dimensions, its number of levels, and tiles addressed under its own image id.
		 *
		 * The tile check is the one with teeth. A pane repointed rather than rebuilt would keep the
		 * previous source, and MapLibre's tile cache is keyed by URL under a source that had not
		 * changed — so the first pyramid's tiles would be redrawn under the second map's
		 * coordinates, which is a coordinate claim about the wrong image and looks like nothing at
		 * all.
		 */
		const showAndCheck = async (
			imageId: string,
			size: { width: number; height: number },
			levels: number
		) => {
			await clearServedTiles(page);
			// Choosing between this Project's Historical Maps is choosing a Layer, and aligning one is a
			// route, so the switch is a round trip rather than a click. What is being defended is
			// unchanged and is if anything harder to fake: the pane is *rebuilt* on the way back, so a
			// source that had been repointed rather than replaced has nowhere to hide.
			await backToProject(page);
			await openPane(page, imageId);
			await waitForTiles(page);
			// Reopened deliberately: the disclosure's state is the component's, and this round trip
			// destroys the pane. Switching Historical Maps *without* leaving the route does not close it,
			// which is the case the pane's own comment settles.
			await showPaneDetails(page);
			await expect(pyramidReadout(page)).toHaveAttribute('data-image-id', imageId);
			// On the attributes, which are exact: "scale factors 1, 2, 4" is a substring of
			// "scale factors 1, 2, 4, 8", so text alone would not tell the two pyramids apart.
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

		// Away from whichever is showing, then back to it, so both steps are a real switch. Clicking
		// the map that is already on screen draws nothing, correctly — and would fail the tile check
		// below for a reason that has nothing to do with what it is defending.
		const pyramids = {
			[wide]: { size: { width: 700, height: 500 }, levels: 3 },
			[tall]: { size: { width: 300, height: 1300 }, levels: 4 }
		};
		const first = (await pyramidReadout(page).getAttribute('data-image-id')) ?? '';
		const second = first === wide ? tall : wide;

		for (const imageId of [second, first]) {
			const { size, levels } = pyramids[imageId]!;
			await showAndCheck(imageId, size, levels);
		}

		expect(requested.filter((url) => url.includes('unset.invalid'))).toEqual([]);
	});

	test('hands the ragged-edge drawing a fractional placement, on a real pyramid', async ({
		page
	}) => {
		// **The case that had never run.** `placement` is `region / scaleFactor`, so it is fractional
		// only where a ragged region does not divide by its own scale factor — and 700 × 500, the
		// fixture every other test here uses, has nine tiles whose every region divides exactly. So
		// the arithmetic that exists for the fractional case was reached by no assertion anywhere,
		// while the pixel test in `packages/core` had no evidence the app ever produces one.
		//
		// 300 × 1300 does: its scale-factor-8 tile covers the whole image, is served at 38 × 163 and
		// covers 37.5 × 162.5 of its cell. That is the number `padTileToCell` is asserted against.
		await collectServedTiles(page);
		await page.goto('/');
		await emptyWorkspace(page);
		await page.reload();
		await createProject(page, 'Amsterdam 1625');
		await openProject(page, 'Amsterdam 1625');

		await ingest(page, 300, 1300, 'tall.png');
		await openPane(page);
		// Four levels rather than the usual fixture's three, so the opening view settles more slowly:
		// the default 5 s timed out about one run in ten under the suite's own contention.
		await waitForTiles(page, 30_000);
		await showPaneDetails(page);
		await expect(pyramidReadout(page)).toContainText('scale factors 1, 2, 4, 8');

		// Out to the coarsest level, the same way the first test in this file gets there: fitting the
		// whole map is not far enough out on its own.
		await button(page, 'Fit whole map').click();
		await waitForTiles(page, 30_000);
		for (let step = 0; step < 6; step++) {
			await button(page, 'Zoom out one level').click();
		}
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

	test('is operable from the keyboard, and reports the pixel under the pointer', async ({
		page
	}) => {
		await page.goto('/');
		await emptyWorkspace(page);
		await page.reload();
		await createProject(page, 'Amsterdam 1625');
		await openProject(page, 'Amsterdam 1625');
		await ingest(page, 700, 500, 'la-floride.png');
		await openPane(page);
		await waitForTiles(page);
		// The zoom readout and the pointer readout are both inside the disclosure.
		await showPaneDetails(page);

		// Every control is a real button and reachable by tabbing (ADR-0016, stories 95 and 96).
		await button(page, 'Fit whole map').focus();
		await expect(button(page, 'Fit whole map')).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(button(page, 'Zoom to full resolution')).toBeFocused();
		await page.keyboard.press('Enter');
		await waitForTiles(page);

		// One image pixel per map pixel at full resolution. A 700 × 500 image at 256-pixel tiles
		// fits one tile at scale factor 4, so its synthetic window is 1024 image pixels wide, and
		// MapLibre's 512-pixel world puts that at zoom 12 + log2(1024 / 512) = 13. The identity is
		// the same one the fixture pane asserts at 14 for a 2048-pixel window; the zoom differs
		// because the pyramid does, which is exactly why it is derived rather than hard-coded in
		// the app.
		expect(await mapZoom(page)).toBe(13);
		await expect(pyramidReadout(page)).toContainText('of 13 at full resolution');

		// The pane answers in image pixels, not in the synthetic geography behind it.
		//
		// Scrolled into view first, and deliberately: `page.mouse` moves the real pointer in
		// viewport coordinates and does no scrolling of its own, and the pane sits below the fold on
		// a Project page. Without this the pointer lands outside the map and the readout stays at
		// "—", which looks exactly like the pane not reporting.
		const pane = page.getByTestId('image-pane');
		await pane.scrollIntoViewIfNeeded();
		const box = await pane.boundingBox();
		if (!box) throw new Error('the pane is not visible');
		// Two moves: MapLibre reports on `mousemove`, and a single jump from wherever the pointer
		// happened to be is one event that the map may receive before it has settled.
		await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2 - 20);
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await expect(page.getByTestId('historical-map-pointer')).not.toHaveText('—');
		const [x, y] = (await page.getByTestId('historical-map-pointer').innerText())
			.split(',')
			.map((part) => Number(part.trim()));
		expect(x).toBeGreaterThanOrEqual(0);
		expect(x).toBeLessThanOrEqual(700);
		expect(y).toBeGreaterThanOrEqual(0);
		expect(y).toBeLessThanOrEqual(500);

		// The status region says whether the view is settled, and says it out loud (story 96).
		await expect(page.getByTestId('historical-map-tiles')).toHaveAttribute('aria-live', 'polite');
	});

	test('surfaces a pyramid it refuses to draw, instead of a blank map', async ({ page }) => {
		await page.goto('/');
		await emptyWorkspace(page);
		await page.reload();
		await createProject(page, 'Amsterdam 1625');
		await openProject(page, 'Amsterdam 1625');
		const imageId = await ingest(page, 700, 500, 'la-floride.png');
		await openPane(page);
		await waitForTiles(page);

		// Overwrite the pyramid's `info.json` with one whose finest level is scale factor 2. It is
		// legal IIIF and it renders *plausibly* — blank at the zoom the pane calls full resolution,
		// with nothing anywhere to say why — which is why `createImagePane` refuses it. What this
		// test defends is that the refusal reaches the screen: story 31 is worthless if the answer
		// to a bad pyramid is an empty rectangle.
		await page.evaluate(
			async ([imageId]) => {
				const root = await workspaceRoot();
				// The pyramid is the Workspace's, shared by every Project (ADR-0023).
				const images = await root.getDirectoryHandle('images');
				const directory = await images.getDirectoryHandle(imageId as string);
				const handle = await directory.getFileHandle('info.json');
				const info = JSON.parse(await (await handle.getFile()).text());
				info.tiles = [{ width: 256, height: 256, scaleFactors: [2, 4] }];
				const writable = await handle.createWritable();
				await writable.write(JSON.stringify(info));
				await writable.close();
			},
			[imageId]
		);

		await page.reload();

		const failure = page.getByTestId('historical-map-failure');
		await expect(failure).toBeVisible();
		// Announced, and it names what is wrong rather than that something went wrong.
		await expect(failure).toHaveAttribute('role', 'alert');
		await expect(failure).toContainText('scale factor 1');
		await expect(page.getByTestId('image-pane')).toHaveCount(0);
	});

	test('refuses a placeholder request that escapes the injection layer, by name', async ({
		page
	}) => {
		const requested = recordRequests(page);
		await page.goto('/');

		// Wait for the guard to be installed rather than for the page to have loaded. It goes on in
		// an effect after hydration — a module body also runs during prerendering, where there is no
		// page to guard — so `goto` resolving is not enough, and asserting too early measured the
		// race instead of the guard. The marker is a registry symbol precisely so it can be asked
		// for from outside the bundle.
		await page.waitForFunction(() => Symbol.for('ballastella.imageServiceGuard') in fetch);

		// The app installs ADR-0004's guard over the global `fetch`, so a consumer added later that
		// forgets to route its tiles gets a message naming the override rather than
		// "TypeError: Failed to fetch" from a DNS failure — which is what the browser gives it for
		// free, and which diagnoses nothing.
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
		// Refused before it was made, so nothing was ever sent to the reserved host.
		expect(requested.filter((url) => url.includes('unset.invalid'))).toEqual([]);
	});
});
