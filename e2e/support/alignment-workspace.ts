// Shared driving for the Alignment surface: get a Project open with one ingested Map Image,
// make Control Point pairs, and read what landed in OPFS.
//
// Extracted here because ticket 08's refinement suite needs exactly the ground ticket 07's pairing
// suite stands on — a real pyramid, both panes live, and the Alignment file on disk — and a second
// copy of a hundred lines of PNG encoder and OPFS reader is a second thing to keep true.
// `editor-alignment.e2e.ts` still carries its own; it was written first, and rewriting a green suite
// to import from here would be churn in a file another slice is also touching.

import { expect, type Locator, type Page } from './test.js';
import zlib from 'node:zlib';

import { addMapImageButton, pickMapImageFile } from './map-images.js';
import { openLayerRow } from './layers';
import { readStoredFileOrNull } from './stored-file';
import { restoreWorkspace, snapshotWorkspace } from './workspace-snapshot.js';

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

/** A greyscale gradient PNG, so these tests need no binary fixture. */
export function gradientPng(width: number, height: number): Buffer {
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

/** The pyramid every test here aligns: wide enough that a mask edit is visibly a change. */
export const IMAGE_WIDTH = 700;
export const IMAGE_HEIGHT = 500;

/**
 * How long the pyramid may take to decode every tile of its first view.
 *
 * Halved from thirty seconds when the pyramid stopped being built per test: nine tiles read from
 * OPFS and decoded is a fraction of the work encoding them was, and a budget sized for the old cost
 * is a budget that turns a hang into a two-minute hang. Still generous rather than tight, because
 * the contention argument in `playwright.config.ts` is unchanged — four workers, each a real WebGL
 * context against one origin's OPFS, on a machine that is not the run's alone.
 */
const TILES_READY_MS = 15_000;

export const PROJECT_NAME = 'Amsterdam 1625';
export const PROJECT_DIRECTORY = 'amsterdam-1625';

/** One Alignment write the app made, as `alignment/browser-test-handle.ts` records it. */
type AlignmentWrite = { path: string; controlPoints: number };

/**
 * What the Playwright suite is allowed to reach inside the page for.
 *
 * Declared here as well as in the app, because the root tsconfig compiles only `e2e/` and never sees
 * the editor's own declaration — the same duplication `ballastellaServedTiles` carries.
 */
declare global {
	interface Window {
		ballastellaAlignmentWrites?: AlignmentWrite[];
	}
}

/**
 * The warped layer, as much of it as this suite reaches for.
 *
 * **Not a `declare global`, deliberately.** `editor-alignment.e2e.ts` and `editor-warped-fetch.e2e.ts`
 * already declare `window.ballastellaWarped` with the narrower shape each of them needs, and a second
 * global declaration of the same property has to match theirs exactly or the program will not
 * compile. Widening theirs would be churn in two green files for the sake of a type; the cast at the
 * one place this shape is used costs less and touches nothing.
 *
 * Typed loosely and optionally all the way down, on purpose: these are upstream's internals, they are
 * pre-1.0, and a version bump that moves them should fail as a `-1` in an assertion rather than as a
 * compile error in a file that cannot see upstream's types.
 */
interface WarpedHandle {
	map: { fitBounds(bounds: unknown, options?: unknown): void };
	layer: {
		getBounds(): unknown;
		getMapIds?(): string[];
		getMapOptions?(mapId: string): Record<string, unknown> | undefined;
		getWarpedMap?(mapId: string): {
			trianglePointsDistortion?: number[];
			options?: Record<string, unknown>;
		};
		getMapsBbox?(mapIds: string[]): number[] | undefined;
		getMapsConvexHull?(mapIds: string[]): number[][] | undefined;
		renderer?: { tileCache?: { getCachedTiles?(): unknown[] } };
	};
}

export async function emptyWorkspace(page: Page): Promise<void> {
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
 * Make the Workspace this module's tests stand on, through the interface, from nothing.
 *
 * **The recorded path.** This is what `start` used to be and what it still is on the first run
 * against a new build; `workspace-snapshot.ts` keeps what it produced and replays the bytes after
 * that. It is written as its own function so the thing being recorded stays a real, readable user
 * journey rather than something inferred from a cache format.
 */
async function ingestThroughTheInterface(
	page: Page
): Promise<{ imageId: string; layerId: string }> {
	await page.reload();

	await page.getByRole('button', { name: 'New Project' }).click();
	const dialog = page.getByRole('dialog', { name: 'New Project' });
	await dialog.getByLabel('Project name').fill(PROJECT_NAME);
	await dialog.getByRole('button', { name: 'Create' }).click();

	// The wait is load-bearing: a Project is selected client-side from `?p=` (ADR-0008), so for a
	// moment after the click the hub is still rendered — and the hub lists Projects as list items.
	await page.getByRole('link', { name: PROJECT_NAME }).click();
	await expect(addMapImageButton(page)).toBeVisible();

	await pickMapImageFile(page, {
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(IMAGE_WIDTH, IMAGE_HEIGHT)
	});
	// **Read off the Layer, which is where a Map Image now appears** (ticket 04). It used to be
	// read out of a list of image ids on the Project page; that list is gone, because the Layer the map
	// arrives with (ADR-0023) already says which image it draws and one of the two had to be a
	// duplicate of the other.
	const row = page.getByTestId('layer-row').first();
	await expect(row).toBeVisible({ timeout: 30_000 });
	// The preparing card and the finished row are both in the `<ol>` while an ingest runs, so a
	// capture taken on the row alone can catch a pyramid that is still being written.
	await expect(page.getByTestId('preparing-layer')).toHaveCount(0, { timeout: 30_000 });

	const imageId = (await row.getAttribute('data-image-id')) ?? '';
	const layerId = (await row.getAttribute('data-layer-id')) ?? '';
	expect(imageId).not.toBe('');
	expect(layerId).not.toBe('');
	return { imageId, layerId };
}

/**
 * A Project open, one Map Image on disk, both panes live.
 *
 * The Map Image is **seeded rather than ingested** — see `workspace-snapshot.ts` for what that
 * means and what it deliberately does not cover. A test whose subject is the ingest itself must
 * drive `pickMapImageFile` instead.
 *
 * @returns the image id, which is the Alignment's file name
 */
export async function start(page: Page): Promise<string> {
	await page.goto('/');
	await emptyWorkspace(page);

	const snapshot = await snapshotWorkspace(page, 'alignment', ingestThroughTheInterface);
	await restoreWorkspace(page, snapshot.files);

	// **Navigated to rather than clicked through.** `openAlignment` is still the way to reach this
	// surface when *arriving* is the subject — `editor-align-route.e2e.ts` asserts the link, the URL
	// and the heading — but for the sixty-odd tests that merely need to be here, four interactions
	// and two client-side navigations are the second-largest cost in this helper now that the ingest
	// is gone. The route is a contract with its own tests; using it is not going behind the app's
	// back.
	await page.goto(`/align/?p=${PROJECT_DIRECTORY}&layer=${snapshot.layerId}`);
	await expect(page.getByRole('heading', { name: 'Align', exact: true })).toBeVisible();
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
	return snapshot.imageId;
}

/**
 * Press Align on the Project page and land on the alignment route (ticket 03).
 *
 * The URL is asserted rather than only the heading, because "the route is
 * `/align/?p=<project>&layer=<layer-id>`" is the ticket's contract and a helper that waited on a
 * heading alone would keep passing if the button started rendering the panes in place again.
 *
 * The Layer's row is opened first, because since ticket 05 the Align link is inside it — a Map
 * Image Layer opens to show whether it is aligned and the button that aligns it.
 */
export async function openAlignment(page: Page, at = 0): Promise<void> {
	const row = await openLayerRow(page, at);
	await row.getByTestId('align-map-image').click();
	await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);
	await expect(page.getByRole('heading', { name: 'Align', exact: true })).toBeVisible();
}

/** After a reload, the same wait `start` ends on. */
export async function waitForSurface(page: Page): Promise<void> {
	await expect(page.getByRole('heading', { name: 'Align', exact: true })).toBeVisible();
	await expect(page.getByTestId('image-pane')).toBeVisible();
	// **Waited for generously, and the assertion is unchanged.** What is asserted is the real signal —
	// every tile of the first view decoded — and five seconds is enough for that on an idle machine and
	// not on one running four workers that each drive a real WebGL context and the same origin's OPFS
	// (see `playwright.config.ts` on contention). Too short a wait here reads as a failure of whatever
	// the test went on to do, which is the reason `editor-layers.e2e.ts` waits 20 seconds for its stack.
	await expect(page.getByTestId('map-image-tiles')).toHaveAttribute('data-tiles-loaded', 'true', {
		timeout: TILES_READY_MS
	});
}

/**
 * Open the Map Image pane's "Image details" readout — the pyramid, the zoom and the pointer.
 *
 * **Closed by default on the page, so a test that reads it has to ask.** The readout is a diagnostic,
 * and on the alignment screen it was four rows of numbers charging permanent rent under the sheet;
 * it is behind a `<button aria-expanded>` disclosure now. The readout is *conditionally rendered*
 * rather than CSS-hidden, so this is not a nicety: `innerText()` returns `''` for a hidden element
 * and `getByTestId` finds nothing at all for an absent one, and either way a suite that skipped this
 * would fail with a message about the pyramid rather than about the disclosure.
 *
 * Idempotent, and cheap enough to call after every navigation: the state lives on the component, so a
 * route change closes it again while switching Map Images deliberately does not.
 */
export async function showPaneDetails(page: Page): Promise<void> {
	const toggle = page.getByTestId('map-image-details-toggle');
	await expect(toggle).toBeVisible();
	if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
	await expect(page.getByTestId('map-image-pyramid')).toBeVisible();
}

export const mapImage = (page: Page) => page.getByTestId('image-pane');
export const baseMap = (page: Page) => page.getByTestId('base-map-pane');
export const rows = (page: Page) => page.getByTestId('control-point-row');
export const warpedStatus = (page: Page) => page.getByTestId('warped-status');

/**
 * The Map Image is drawn warped over the Base Map.
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 * │ ONE PLACE, BECAUSE THIS ASSERTION IS MADE TWENTY TIMES AND ITS FAILURE NAMES NOTHING.      │
 * └───────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * `data-warped-status=""` is the shape every failure of this takes, and it means only "the render
 * did not happen". It does not say whether the transformation was refused, the tiles never arrived,
 * or the Base Map underneath was never there — so whatever is learned about it is learned once, here.
 *
 * **What it taught in ticket 17:** on 2026-08-07 `demo-bucket.protomaps.com` began answering 404 for
 * `v4.pmtiles`, which every entry in `base-map/catalog.ts` points at. `editor-alignment`,
 * `editor-alignment-refinement` and `editor-align-route` did not route that archive, so they fetched
 * it for real — and the 404 carries no CORS headers, so the browser blocked the request rather than
 * delivering an error the app could handle. MapLibre's source never initialised, the warped layer was
 * never added, and three tests went red with `data-warped-status=""` while nothing in this repository
 * had changed. All three now route it to the committed fixture; see {@link routeBaseMapArchive}.
 *
 * Three things worth keeping, because two of them were wrong turnings that cost time:
 *
 * - **A longer timeout was tried first and did not help.** At 30 s the same three failed the same
 *   way, which is what ruled out contention. The wait is the configured default; raising it would
 *   only have made a third party's outage take longer to report.
 * - **"No Base Map means no warped render" was the obvious explanation and it is wrong.** These
 *   specs pass with an archive of all zeros and with the route answering 404. This assertion does
 *   **not** depend on the Base Map having any tiles — only on its source initialising. Do not read a
 *   green `expectWarpedDrawn` as evidence that the Base Map drew.
 * - **The symptom is indistinguishable from a broken feature**, which is why four implementers read
 *   this family as flakiness. If this assertion fails, check whether the archive request was
 *   *answered at all* before suspecting the warped path.
 */
export const expectWarpedDrawn = async (page: Page): Promise<void> => {
	await expectWarpedLayerAdded(page);
	await expectBaseMapDrawn(page);
};

/**
 * The warped layer was added — and **that alone**, which is all `data-warped-status` ever meant.
 *
 * Split out of {@link expectWarpedDrawn} rather than left as its only content, because there is
 * exactly one place where it is the honest claim: `editor-pwa.e2e.ts`'s offline session, where the
 * Base Map archive is refused on purpose and the whole point is that the scholar's own work draws
 * with nothing underneath it. Everywhere else, "the Map Image is drawn over the geography"
 * means the geography drew too, and that is what {@link expectWarpedDrawn} now says.
 *
 * Named for what it proves, so a call site cannot claim more than it is asking for. Ticket 17
 * measured how far apart the two are: this passes with an archive of all zeros and with the route
 * answering 404.
 */
export const expectWarpedLayerAdded = (page: Page) =>
	expect(warpedStatus(page)).toHaveAttribute('data-warped-status', 'drawn');

/**
 * The Base Map underneath has geometry on screen — not merely a source that initialised.
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS THE HALF `expectWarpedDrawn` DID NOT ASSERT, AND TICKET 17 MEASURED THE GAP.       │
 * └───────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * `data-warped-status="drawn"` passes with an archive of **all zeros** and with the route answering
 * **404** — measured, both. What those specs need is for the archive request to be *answered* so
 * MapLibre's source initialises and the warped layer is added; the Base Map's own content never came
 * into it. So twenty assertions that read as "the Map Image is drawn over the geography" were
 * making no claim at all about the geography.
 *
 * `queryRenderedFeatures` filtered to the Base Map's **own source** is what makes the claim real,
 * which is the pattern CONTRIBUTING already states: an offline test once proved the Base Map drew by
 * querying the whole map, and the Project's own Annotation Layer satisfied it. Filtering by source
 * rather than by layer id is deliberate — `@protomaps/basemaps` owns those ids and renames them
 * across versions, while the source is `baseMapStyle`'s own and changing it is a change to this
 * repository.
 *
 * ⚠ **It is a claim about tiles parsed and put on screen, not about pixels.** A style that painted
 * every layer transparent would still satisfy it. That is the next weakness rather than this one,
 * and no test currently depends on the difference.
 */
export const expectBaseMapDrawn = async (page: Page): Promise<void> => {
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const map = (
						window as unknown as {
							ballastellaBaseMap?: {
								queryRenderedFeatures(): { source?: string }[];
							};
						}
					).ballastellaBaseMap;
					if (map === undefined) return -1;
					// `protomaps` is `BASE_MAP_SOURCE_ID` in `packages/core/src/base-map/style.ts`. Named
					// literally because the workspace tsconfig covers only `e2e/`, the same boundary that
					// makes `support/editor-deployment.ts` re-declare the cached-tile path.
					return map.queryRenderedFeatures().filter((feature) => feature.source === 'protomaps')
						.length;
				}),
			{
				timeout: BASE_MAP_DRAWN_MS,
				message:
					'the Base Map rendered no geometry of its own — the archive was answered but nothing ' +
					'was parsed out of it, or the map is looking somewhere the fixture has no tiles'
			}
		)
		.toBeGreaterThan(0);
};

/**
 * How long the Base Map may take to have geometry on screen.
 *
 * Longer than the default assertion budget for the same reason `openLayers` in
 * `editor-layers.e2e.ts` is: what is being waited for is a PMTiles header, a directory, a tile
 * fetch, a gzip decode and a WebGL paint, on a machine running four of these at once.
 */
const BASE_MAP_DRAWN_MS = 30_000;

export const imagePoints = (page: Page) =>
	mapImage(page).locator('[data-testid="pane-overlay-point-control-point"]');

export const maskVertices = (page: Page) =>
	mapImage(page).locator('[data-testid="pane-overlay-point-mask-vertex"]');

export const maskEdges = (page: Page) =>
	mapImage(page).locator('[data-testid="pane-overlay-point-mask-edge"]');

/** Click at a fraction across a pane, so the same helper works for both canvases. */
export async function clickAt(target: Locator, fx: number, fy: number): Promise<void> {
	const box = await target.boundingBox();
	if (!box) throw new Error('the pane has no box to click in');
	await target.click({ position: { x: box.width * fx, y: box.height * fy } });
}

/**
 * Make one complete pair: a click on the Map Image, then one on the Base Map.
 *
 * Waits for the pending state in between, which is what makes this click-then-click rather than two
 * clicks that happen to arrive in order. The two panes take separate fractions so that a *mirrored*
 * pair set can be built as easily as a well-behaved one.
 */
export async function makePair(
	page: Page,
	image: readonly [number, number],
	base: readonly [number, number] = image
): Promise<void> {
	const before = await rows(page).count();
	await clickAt(mapImage(page), image[0], image[1]);
	await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
	await clickAt(baseMap(page), base[0], base[1]);
	await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', '');
	await expect(rows(page)).toHaveCount(before + 1);
}

/** `count` well-behaved pairs, spread across both panes so the solve is not degenerate. */
export async function makePairs(page: Page, count: number): Promise<void> {
	// A deliberately irregular scatter, and all of it well inside both panes: evenly spaced points on
	// a line are collinear, which is a solve the higher-order polynomials refuse — and MapLibre's
	// navigation control sits in the bottom-left corner of each pane with its attribution along the
	// bottom-right, so a click near either is a click on a control rather than on the earth.
	const spots: readonly (readonly [number, number])[] = [
		[0.2, 0.25],
		[0.7, 0.22],
		[0.48, 0.7],
		[0.32, 0.55],
		[0.8, 0.52],
		[0.18, 0.72],
		[0.58, 0.4],
		[0.42, 0.16],
		[0.66, 0.62],
		[0.3, 0.38],
		[0.54, 0.54],
		[0.24, 0.62]
	];
	for (let index = await rows(page).count(); index < count; index += 1) {
		const spot = spots[index % spots.length];
		if (!spot) throw new Error('ran out of places to click');
		await makePair(page, spot);
	}
}

export const watchWrites = (page: Page) =>
	page.evaluate(() => {
		window.ballastellaAlignmentWrites = [];
	});

export const writes = (page: Page) => page.evaluate(() => window.ballastellaAlignmentWrites ?? []);

/**
 * The Alignment as it sits in OPFS, or `null` when there is no such file.
 *
 * **Retried, because the app writes atomically** — a temp file, then `move()` over the destination
 * (ADR-0017 rule 4) — and a read that lands inside that window throws rather than returning stale
 * bytes: `getFileHandle` with a `NotFoundError` while the destination is momentarily gone, or
 * `getFile()` as it is replaced. Swallowing that as `null` is worse than the crash it avoids, and in
 * both directions: `expect(written).not.toContain(…)` on a `null` fails with a matcher error (which is
 * how it surfaced), and `expect.poll(read).not.toBe(before)` *passes* on a `null` — a byte-identity
 * assertion satisfied by a file that could not be read.
 *
 * This is a fix to the read and not to any assertion: the bytes on disk are still what is compared, so
 * a write that never happens still fails, and a file that is genuinely absent still reads as absent.
 * Only a read that collided with an atomic replace is forgiven, and only for as long as one can last.
 *
 * The loop itself is `support/stored-file.ts`, which is where it lives for every helper that needs
 * it — this reasoning had been copied into three of them and omitted from a fourth (ticket 17).
 */
export const storedAlignment = (page: Page, imageId: string): Promise<string | null> =>
	readStoredFileOrNull(page, `alignments/${imageId}.json`);

/** `project.json` as it sits in OPFS, or `null`. Retried — see {@link storedAlignment}. */
export const storedProjectFile = (
	page: Page,
	directory = PROJECT_DIRECTORY
): Promise<string | null> => readStoredFileOrNull(page, `${directory}/project.json`);

/**
 * Wait until the Alignment on disk carries `count` pairs.
 *
 * A completed pair is written immediately rather than on a timer (ADR-0017 rule 1), but "immediately"
 * is still a promise: the row appears in the page before the bytes reach OPFS. Reloading inside that
 * window is a race, and one that would fail as "a pair was lost across reload".
 */
export const waitForStored = async (page: Page, imageId: string, count: number): Promise<void> => {
	await expect
		.poll(async () => {
			const written = await storedAlignment(page, imageId);
			if (written === null) return -1;
			return (JSON.parse(written).body?.features ?? []).length;
		})
		.toBe(count);
};

/**
 * How long {@link warpedTiles} will wait for a tile to arrive and decode.
 *
 * Generous, and it costs nothing when the tiles are there: the poll returns on the first non-zero
 * answer. The same budget `editor-layers.e2e.ts` allows its own copy of this wait.
 */
const WARPED_TILE_WAIT_MS = 30_000;

/**
 * How many warped tiles have arrived **and decoded**.
 *
 * `CacheableTile.isCachedTile()` is `data !== undefined`, and `data` is the ImageData the tile worker
 * produced — so this counts tiles that made it all the way through the ADR-0011 shim rather than
 * tiles that were merely asked for. It is the honest signal for "the Map Image renders warped":
 * the failure this path used to have was an error `@allmaps/render` logged and swallowed, so a check
 * for an absence of console errors went green while the map rendered blank.
 *
 * **Polled, not slept for, and the assertion is unchanged.** Every caller asks whether the count is
 * above zero, and a cached tile is a real barrier: it is bytes that arrived *and* decoded through the
 * ADR-0011 shim, so it cannot be true before the thing being awaited has happened. The poll returns on
 * the first non-zero answer and a renderer that draws nothing still spends the whole budget and still
 * answers 0. A fixed three seconds was enough on an idle machine and not on a loaded one; a longer
 * fixed sleep would be the same defect, slower.
 */
export const warpedTiles = async (page: Page): Promise<number> =>
	page.evaluate(async (ceiling) => {
		const warped = (window as { ballastellaWarped?: WarpedHandle }).ballastellaWarped;
		if (!warped) return -1;
		// Bring the warped map into view, or the renderer has no reason to ask for a tile.
		warped.map.fitBounds(warped.layer.getBounds(), { animate: false });
		const cached = () => (warped.layer.renderer?.tileCache?.getCachedTiles?.() ?? []).length;
		for (let waited = 0; waited < ceiling && cached() === 0; waited += 200) {
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		return cached();
	}, WARPED_TILE_WAIT_MS);

/** What the renderer thinks it has been asked to draw. `null` when there is no warped map. */
export const drawnMap = (page: Page) =>
	page.evaluate(() => {
		const layer = (window as { ballastellaWarped?: WarpedHandle }).ballastellaWarped?.layer;
		const mapId = layer?.getMapIds?.()[0];
		if (!layer || mapId === undefined) return null;
		const warpedMap = layer.getWarpedMap?.(mapId);
		const options = layer.getMapOptions?.(mapId) ?? {};
		const distortion = warpedMap?.trianglePointsDistortion ?? [];
		return {
			mapId,
			transformationType: options.transformationType as string | undefined,
			distortionMeasure: options.distortionMeasure as string | undefined,
			distortionMeasures: (options.distortionMeasures ?? []) as string[],
			renderGrid: options.renderGrid as boolean | undefined,
			applyMask: options.applyMask as boolean | undefined,
			distortionColor00: options.distortionColor00 as string | undefined,
			distortionColor01: options.distortionColor01 as string | undefined,
			distortionColor3: options.distortionColor3 as string | undefined,
			renderGridColor: options.renderGridColor as string | undefined,
			resourceMask: (options.resourceMask ?? []) as number[][],
			// The Control Points the renderer is solving from, in its own vocabulary. Read because
			// "a moved Control Point reaches the drawn map without rebuilding it" is a claim about what
			// the renderer was told, and the renderer's account of that is the only honest one.
			gcps: (options.gcps ?? []) as { resource: number[]; geo: number[] }[],
			// How far from zero the *displayed* measure is at the triangulated points. Zero everywhere
			// means nothing is being colourised, whatever the options claim.
			worstDistortion: distortion.reduce(
				(worst: number, value: number) => Math.max(worst, Math.abs(value)),
				0
			),
			bbox: layer.getMapsBbox?.([mapId]) ?? null,
			// The convex hull and **not** the bounding box, for "the mask narrows what is drawn": cutting
			// a corner off a rectangle leaves the bounding box exactly where it was, because the three
			// remaining corners still hold every extreme. The hull is the measure that actually moves.
			convexHull: layer.getMapsConvexHull?.([mapId]) ?? null
		};
	});

/** The area of a ring of `[x, y]` points, by the shoelace formula. */
export function ringArea(ring: number[][] | null | undefined): number {
	if (!ring || ring.length < 3) return 0;
	let twice = 0;
	for (let index = 0; index < ring.length; index += 1) {
		const a = ring[index] as number[];
		const b = ring[(index + 1) % ring.length] as number[];
		twice += (a[0] as number) * (b[1] as number) - (b[0] as number) * (a[1] as number);
	}
	return Math.abs(twice) / 2;
}

/** The `points="…"` attribute of the Resource Mask in a written Alignment. */
export const maskPointsAttribute = (written: string): string => {
	const value = JSON.parse(written).target?.selector?.value as string | undefined;
	return /points="([^"]*)"/.exec(value ?? '')?.[1] ?? '';
};
