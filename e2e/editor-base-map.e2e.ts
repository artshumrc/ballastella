import { expect, test } from './support/test.js';
import { type Locator, type Page } from '@playwright/test';

import { start as startAlignment } from './support/alignment-workspace.js';
import { unavailableNotice } from './support/base-map-notice.js';
import {
	baseMapTileDirectory,
	baseMapTileSourcePath,
	cachedBaseMapTiles,
	refuseBaseMapArchive,
	routeBaseMapArchive,
	routePartialBaseMapArchive
} from './support/editor-deployment';
import { AMBIGUOUS_QUERY, routePlaceLookup } from './support/places.js';

// Seam 2: the running app in a real browser, with real MapLibre and real OPFS. There is
// deliberately no map-abstraction layer to test against — inventing one purely to enable testing
// is the premature boundary ADR-0019 argues against, and it would test a fake instead of the
// thing that ships. So these tests drive the real map and read the real `project.json`.

/** The subset of MapLibre's `Map` these tests ask questions of. See `browser-test-handle.ts`. */
type BaseMapHandle = {
	loaded(): boolean;
	isStyleLoaded(): boolean;
	getCenter(): { lng: number; lat: number };
	getZoom(): number;
	setZoom(zoom: number): void;
	jumpTo(options: { center: [number, number]; zoom: number }): void;
	getStyle(): { layers: { id: string; paint?: Record<string, unknown> }[] };
	queryRenderedFeatures(): { layer: { id: string } }[];
};

declare global {
	interface Window {
		ballastellaBaseMap?: BaseMapHandle;
		/** Cached Base Map tiles the protocol handler answered **with bytes**. */
		ballastellaServedBaseMapTiles?: { z: number; x: number; y: number; bytes: number }[];
		/** Cached Base Map tiles requested and answered empty. */
		ballastellaMissedBaseMapTiles?: { z: number; x: number; y: number }[];
	}
}

/** The Project these tests open. Identity is the directory name (ADR-0008). */
const PROJECT_DIRECTORY = 'amsterdam-1625';
const PROJECT_FILE = 'project.json';

/**
 * **`/base-map/` is gone**. The Base Map pane a scholar meets is the Project screen, so
 * every test here now drives `/?p=<dir>` — the route a Base Map is actually chosen from. Rewired
 * rather than deleted: a route that no longer exists is not a licence to drop the behaviour it
 * covered, and everything below (Range requests, the catalog, the author's default, the refusals)
 * is behaviour of the pane and not of the page it used to sit on.
 */
const HUB = './';
/** A Project is addressed by query parameter, never by a per-Project path (ADR-0008). */
const paneUrl = (directory: string = PROJECT_DIRECTORY) => `${HUB}?p=${directory}`;

/** A Project's manifest as the app writes it, with anything the test needs overridden. */
const projectJson = (fields: Record<string, unknown> = {}) =>
	JSON.stringify({
		formatVersion: 1,
		name: 'Amsterdam 1625',
		updatedAt: '2026-01-01T00:00:00.000Z',
		layers: [],
		baseMap: null,
		...fields
	});

/** The deployment catalog, as an author reads it in the switcher. */
const CATALOG_OPTIONS = [
	{ value: 'streets', text: 'Streets' },
	{ value: 'physical', text: 'Physical geography' },
	{ value: 'muted', text: 'Muted, high contrast' },
	{ value: 'streets-worldwide', text: 'Streets, worldwide' }
];

// By role, not by label: MapLibre gives the canvas the accessible name "Base Map" too, which is
// right for the pane and would make a name-only lookup ambiguous.
const switcher = (page: Page) => page.getByRole('combobox', { name: 'Base Map' });
const themeToggle = (page: Page) => page.getByRole('button', { name: /switch to .* theme/i });

/** Tab from the current control until `target` has focus, without pretending a canvas is not focusable. */
async function tabUntilFocused(page: Page, target: Locator, what: string): Promise<void> {
	for (let press = 0; press < 20; press += 1) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press('Tab');
	}
	throw new Error(`“${what}” could not be reached with the keyboard`);
}

async function waitForLoadedMap(page: Page): Promise<void> {
	await page.waitForFunction(() => window.ballastellaBaseMap?.loaded() === true, undefined, {
		timeout: 45_000
	});
}

/** Empty the origin's OPFS, so no test can see another's Projects. */
async function emptyWorkspace(page: Page): Promise<void> {
	await page.evaluate(async () => {
		// The whole of browser storage, which is **every named Workspace** rather than one — so no test
		// can see another's, whichever Workspace it was in.
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

/** Write a `project.json` straight into OPFS, bypassing the app entirely. */
async function seedProject(page: Page, contents: string): Promise<void> {
	await page.evaluate(
		async ([directory, file, json]) => {
			const root = await workspaceRoot();
			const project = await root.getDirectoryHandle(directory, { create: true });
			const handle = await project.getFileHandle(file, { create: true });
			const writable = await handle.createWritable();
			await writable.write(json);
			await writable.close();
		},
		[PROJECT_DIRECTORY, PROJECT_FILE, contents] as const
	);
}

/**
 * A Project on disk, and the pane opened onto it.
 *
 * The Project is seeded rather than created through the pane on purpose: opening a pane must
 * never create a Project. The deleted `/base-map/` with no `?p=` used to call
 * `getDirectoryHandle(…, { create: true })` and manufacture a phantom Project in the real
 * Workspace, which the hub then listed.
 */
async function openPane(page: Page, contents: string = projectJson()): Promise<void> {
	await page.goto(HUB);
	await emptyWorkspace(page);
	await seedProject(page, contents);
	await page.goto(paneUrl());
	await waitForLoadedMap(page);
}

/** The Project's `project.json` exactly as it sits on disk, or `null` if there is none. */
async function readProjectFile(page: Page): Promise<string | null> {
	return page.evaluate(
		async ([directory, file]) => {
			try {
				const root = await workspaceRoot();
				const project = await root.getDirectoryHandle(directory);
				const handle = await project.getFileHandle(file);
				return await (await handle.getFile()).text();
			} catch {
				return null;
			}
		},
		[PROJECT_DIRECTORY, PROJECT_FILE] as const
	);
}

/** Every top-level name in the Workspace, so "the pane created nothing" is provable. */
async function workspaceEntries(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const root = await workspaceRoot();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		return names.sort();
	});
}

const renderedLayerIds = (page: Page) =>
	page.evaluate(() => {
		const map = window.ballastellaBaseMap;
		if (map === undefined) return [];
		return [...new Set(map.queryRenderedFeatures().map((feature) => feature.layer.id))];
	});

const styleLayerIds = (page: Page) =>
	page.evaluate(() => window.ballastellaBaseMap?.getStyle().layers.map((layer) => layer.id) ?? []);

const backgroundColour = (page: Page) =>
	page.evaluate(() =>
		JSON.stringify(
			window.ballastellaBaseMap?.getStyle().layers.find((layer) => layer.id === 'background')
				?.paint ?? null
		)
	);

test.describe('the Base Map pane', () => {
	test.beforeEach(async ({ context }) => {
		await routeBaseMapArchive(context);
	});

	test('renders with zoom at the bottom-left, and pans and zooms from the keyboard', async ({
		page
	}) => {
		await openPane(page);

		const canvas = page.locator('canvas.maplibregl-canvas');
		await expect(canvas).toBeVisible();

		// Zoom is at the bottom-left in every map pane, asserted against the rendered control rather
		// than the call that placed it: MapLibre creates all four corner containers whatever is put in
		// them, so the claim is which corner holds the buttons.
		const pane = page.getByTestId('base-map-pane');
		const bottomLeft = pane.locator('.maplibregl-ctrl-bottom-left');
		await expect(bottomLeft.locator('button.maplibregl-ctrl-zoom-in')).toBeVisible();
		await expect(bottomLeft.locator('button.maplibregl-ctrl-zoom-out')).toBeVisible();
		await expect(pane.locator('.maplibregl-ctrl-top-right .maplibregl-ctrl')).toHaveCount(0);

		// The map controls share the floating top-left row, which leaves no page-chrome bar between the
		// navigation and the map. Zoom therefore remains on the bottom of the left edge.
		const search = await page.getByTestId('base-map-place-search').boundingBox();
		const baseMapSwitcher = await switcher(page).boundingBox();
		const fit = await page.getByTestId('fit-to-project').boundingBox();
		const zoom = await bottomLeft.boundingBox();
		const navigation = await page.getByTestId('navigation-bar').boundingBox();
		const project = await page.getByTestId('project-screen').boundingBox();
		// The navigation bar's existing bottom border separates it from the Project workspace; an idle
		// announcement must not reserve another line between them.
		expect(project!.y - (navigation!.y + navigation!.height)).toBeLessThanOrEqual(1);
		expect(
			Math.abs(search!.y + search!.height / 2 - (baseMapSwitcher!.y + baseMapSwitcher!.height / 2))
		).toBeLessThan(2);
		expect(Math.abs(search!.y + search!.height / 2 - (fit!.y + fit!.height / 2))).toBeLessThan(2);
		expect(search!.y + search!.height).toBeLessThan(zoom!.y);

		const start = await page.evaluate(() => ({
			center: window.ballastellaBaseMap?.getCenter(),
			zoom: window.ballastellaBaseMap?.getZoom()
		}));

		// MapLibre gives the canvas a tabindex and handles arrow-key panning and +/- zooming, so
		// this is both the pan/zoom assertion and the keyboard-reach one.
		await canvas.focus();
		await page.keyboard.press('ArrowRight');
		await expect
			.poll(() => page.evaluate(() => window.ballastellaBaseMap?.getCenter().lng ?? 0))
			.toBeGreaterThan(start.center?.lng ?? 0);

		await page.keyboard.press('Equal');
		await expect
			.poll(() => page.evaluate(() => window.ballastellaBaseMap?.getZoom() ?? 0))
			.toBeGreaterThan(start.zoom ?? 0);
	});

	test('opens on the catalog’s initial view, which is what a Project with no work falls back to', async ({
		page
	}) => {
		// ADR-0026's last fallback, asserted where the catalog itself is asserted. The seeded Project has
		// an empty `layers`, so there is nothing on the earth to frame on and the deployment's own
		// initial view is what a scholar meets — a brand-new Project opens somewhere deliberate rather
		// than at 0°, 0°. `e2e/editor-opening-view.e2e.ts` owns the other end of the chain.
		await openPane(page);

		const at = await page.evaluate(() => ({
			lng: window.ballastellaBaseMap!.getCenter().lng,
			lat: window.ballastellaBaseMap!.getCenter().lat,
			zoom: window.ballastellaBaseMap!.getZoom()
		}));
		// Central Amsterdam at zoom 13, inside the bundled extract's bounds. Read out of the catalog by
		// the app; written out here, because a fit that quietly replaced it would still be *a* view.
		expect(at.lng).toBeCloseTo(4.9041, 4);
		expect(at.lat).toBeCloseTo(52.3676, 4);
		expect(at.zoom).toBeCloseTo(13, 4);
	});

	test('pans by dragging and zooms by wheel', async ({ page }) => {
		await openPane(page);

		const box = await page.locator('canvas.maplibregl-canvas').boundingBox();
		if (box === null) throw new Error('the Base Map canvas has no box, so it is not laid out');
		const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

		const before = await page.evaluate(() => ({
			lat: window.ballastellaBaseMap?.getCenter().lat ?? 0,
			zoom: window.ballastellaBaseMap?.getZoom() ?? 0
		}));

		await page.mouse.move(middle.x, middle.y);
		await page.mouse.down();
		await page.mouse.move(middle.x, middle.y - 120, { steps: 12 });
		await page.mouse.up();
		// Dragging the map upwards drags the ground with it, so the viewport moves south and the
		// centre latitude falls. Asserting the sign, not just the movement, is what catches an
		// inverted pane.
		await expect
			.poll(() => page.evaluate(() => window.ballastellaBaseMap?.getCenter().lat ?? 0))
			.toBeLessThan(before.lat);

		await page.mouse.wheel(0, -400);
		await expect
			.poll(() => page.evaluate(() => window.ballastellaBaseMap?.getZoom() ?? 0))
			.toBeGreaterThan(before.zoom);
	});

	test('reads a single static pmtiles archive over Range requests, with no tile server', async ({
		page
	}) => {
		const archiveRequests: { url: string; range: string | undefined }[] = [];
		page.on('request', (request) => {
			if (!request.url().includes('.pmtiles')) return;
			archiveRequests.push({ url: request.url(), range: request.headers()['range'] });
		});

		await openPane(page);

		expect(archiveRequests.length).toBeGreaterThan(0);
		// Every request is a byte range against one ordinary file. No `/{z}/{x}/{y}` endpoint exists
		// anywhere in this path, which is what makes the Base Map work offline and keyless.
		for (const request of archiveRequests) {
			expect(request.url).toMatch(/\.pmtiles$/);
			expect(request.range).toMatch(/^bytes=\d+-\d+$/);
		}
	});

	test('offers content-distinct variants that share one archive', async ({ page }) => {
		const archiveUrls = new Set<string>();
		page.on('request', (request) => {
			const url = request.url();
			if (url.includes('.pmtiles')) archiveUrls.add(url);
		});

		await openPane(page);

		// Streets: the built environment is on screen.
		await expect
			.poll(async () => (await renderedLayerIds(page)).some((id) => id.startsWith('roads_')), {
				timeout: 30_000
			})
			.toBe(true);

		await switcher(page).selectOption('physical');

		// Physical geography: it is gone, and water and terrain are what is left.
		await expect
			.poll(async () => (await renderedLayerIds(page)).some((id) => id.startsWith('roads_')), {
				timeout: 30_000
			})
			.toBe(false);
		await expect.poll(() => styleLayerIds(page)).toContain('water');

		// The whole zero-extra-data claim, asserted by request interception rather than by eye:
		// switching variants issued no request to a second archive.
		expect([...archiveUrls]).toHaveLength(1);
	});

	test('offers the deployment catalog through a native select without network disclaimers', async ({
		page
	}) => {
		await openPane(page);

		const select = switcher(page);
		await expect(select).toHaveJSProperty('tagName', 'SELECT');
		const box = await select.boundingBox();
		if (box === null) throw new Error('the Base Map selector is not laid out');
		// The widest label is well below this threshold; a full-width selector used to be 20rem.
		expect(box.width).toBeLessThan(250);

		const options = await select.locator('option').evaluateAll((elements) =>
			elements.map((element) => ({
				value: (element as HTMLOptionElement).value,
				text: (element as HTMLOptionElement).textContent?.trim() ?? ''
			}))
		);
		expect(options).toEqual(CATALOG_OPTIONS);
	});

	test('puts the switcher within keyboard reach, and the muted Base Map renders', async ({
		page
	}) => {
		await openPane(page);

		// The floating controls follow the persistent chrome in document order. MapLibre's focusable
		// canvas is rightly between them, so traverse it instead of treating it as an omission. Choosing
		// *within* a focused `<select>` is the browser's own arrow-key handling — which is exactly why
		// ADR-0016 mandates a native `<select>` here — and headless Chromium does not run its native
		// popup, so this asserts the reach and the element, and leaves the popup to the platform.
		//
		// The bar is an eyebrow above a main row, and the tab order is that reading order: the eyebrow
		// first — which Workspace you are in, and whether your work is kept — and then the main row,
		// left to right, which is where you are, the app's own name, and what you can do here.
		//
		// So the wordmark is reached *after* the breadcrumb rather than before it, and the theme
		// control last of all: both sit in the main row, and each is asserted where it is painted. A
		// keyboard order that disagreed with the row a sighted scholar reads would be the defect.
		//
		// The wordmark is `hidden md:flex`, so below `md` it leaves the tab order along with the space
		// the breadcrumbs need — this spec runs wide, where it is present.
		await page.keyboard.press('Tab');
		await expect(page.getByTestId('workspace-switcher')).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(page.getByTestId('all-projects')).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(page.getByTestId('edit-project-name')).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(page.getByTestId('app-wordmark')).toBeFocused();
		// Connecting comes before publishing in the row and in the order, which is the order the two
		// things happen in: a Workspace has to have somewhere to go before Publish has anywhere to send
		// it (ADR-0032).
		await page.keyboard.press('Tab');
		await expect(page.getByTestId('connect-to-github')).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(page.getByTestId('publish')).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(themeToggle(page)).toBeFocused();
		await tabUntilFocused(page, page.getByTestId('place-search-query'), 'place search');
		await page.keyboard.press('Tab');
		await expect(page.getByTestId('place-search-submit')).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(switcher(page)).toBeFocused();

		// The muted entry has to be genuinely selectable, not merely listed.
		await switcher(page).selectOption('muted');
		await expect(switcher(page)).toHaveValue('muted');
		await expect.poll(() => styleLayerIds(page), { timeout: 30_000 }).toContain('water');
		await page.keyboard.press('Tab');
		await expect(page.getByTestId('fit-to-project')).toBeFocused();
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// AN ARCHIVE THAT DOES NOT ANSWER, SAID OUT LOUD
//
// On 2026-08-07 `demo-bucket.protomaps.com` — the host every entry in this deployment's catalog
// read before the repoint to the source.coop mirror — began refusing the archive, and the
// application's entire response was a pane with
// nothing in it. ADR-0025 had predicted the outage ("no published rate limit, no uptime promise")
// and said nothing about what the scholar sees, which turned out to be the part that mattered: a
// grey rectangle is also what a broken tool looks like, and what a Project that failed to draw
// looks like, and there was no way to tell the three apart.
//
// **The refusal is the fixture here, not an accident of the network.** `refuseBaseMapArchive`
// aborts the archive deliberately, so this test asserts the same thing on a machine with a working
// connection and on one without, and on the day the bucket comes back.
// ═════════════════════════════════════════════════════════════════════════════════════════════
test.describe('a Base Map archive that does not answer', () => {
	test('says so in visible text, names the host, and says the Workspace is unaffected', async ({
		page,
		context
	}) => {
		const crashes: Error[] = [];
		page.on('pageerror', (error) => crashes.push(error));
		await refuseBaseMapArchive(context);

		await page.goto(HUB);
		await emptyWorkspace(page);
		await seedProject(page, projectJson());
		await page.goto(paneUrl());

		// **Not `waitForLoadedMap`.** `Map#loaded()` is about the style, and the style loads whether or
		// not the archive answered — which is precisely why this failure was invisible. What is waited
		// for is the notice itself.
		const notice = page.getByTestId('base-map-unavailable');
		await expect(notice).toBeVisible({ timeout: 45_000 });

		// Visible text and not a tooltip (ADR-0016: daisyUI renders tooltips through CSS `::before`, so
		// they are neither announced nor dismissable).
		//
		// **The whole sentence, and the same sentence the viewer is held to.** Both applications render
		// `baseMapUnavailableNotice` from `@ballastella/core` precisely so that one outage is not
		// described two ways at the same scholar — and until this line that contract had no test on
		// this side: four `toContainText` fragments stood here, and replacing `{unavailableNotice}` in
		// `ProjectScreen.svelte` with an inlined sentence carrying those four phrases left the whole
		// repository green. This is the side that would drift, because it is the side with three other
		// notices around it to be tempted into rewording.
		//
		// “Streets” because this Project seeds no author default and the catalog's `defaultId` is that
		// entry; `support/base-map-notice.ts` says why the expectation is a function.
		await expect(notice.locator('p')).toHaveText(unavailableNotice('Streets', ARCHIVE_HOST));

		// Announced, not merely drawn. `role="alert"` rather than a live region, because this element
		// is *inserted* when its text first exists and an `aria-live` region is announced on a text
		// change — see the note at its site.
		await expect(notice).toHaveAttribute('role', 'alert');

		// And the rest of the screen still works: the failure is a notice, not a broken page.
		await expect(switcher(page)).toBeVisible();
		expect(crashes.map((error) => error.message)).toEqual([]);
	});

	test('is taken down when the archive starts answering again', async ({ page, context }) => {
		// **The other half of the pane's report, which had no test at all on this side.** `BaseMapPane`
		// sends `'drawing'` as well as `'unavailable'`, and deleting that handler outright left the
		// whole repository green: the two tests around this one are a notice raised and never
		// withdrawn, and a notice never raised.
		//
		// The failure it is for is the archive that answers its header and then refuses tile ranges — a
		// bucket rate-limiting mid-session. Tile data goes through an uncached `getBytes`, so when the
		// limit lifts and the map moves, tiles arrive and the Base Map draws. Without `'drawing'` the
		// alert would sit over a plainly working map for the rest of the session, which is a worse lie
		// than the silence the notice exists to end. `routePartialBaseMapArchive`'s header says
		// which archive failures can come back this way and which cannot.
		//
		// The pan is inside the poll deliberately: MapLibre has no reason to re-ask for a tile it has
		// already given up on, so one nudge is a bet on a single round of requests landing. Its twin in
		// `viewer-reader.e2e.ts` measured that bet losing about one run in six.
		const archive = await routePartialBaseMapArchive(context);
		await openPane(page);

		const notice = page.getByTestId('base-map-unavailable');
		await expect(notice).toBeVisible({ timeout: 45_000 });
		expect(archive.tileRangesAsked()).toBeGreaterThan(0);

		archive.serve();
		let step = 0;
		await expect
			.poll(
				async () => {
					await page.evaluate(
						(zoom: number) =>
							window.ballastellaBaseMap?.jumpTo({ center: [4.9041, 52.3676], zoom }),
						12 + (step++ % 2)
					);
					await page.waitForTimeout(500);
					return baseMapIsDrawn(page);
				},
				{ timeout: 60_000 }
			)
			.toBe(true);

		// Panned here too, for the reason its twin in `viewer-reader.e2e.ts` sets out: `'drawing'` is
		// `sourcedata` with `isSourceLoaded`, and a source counts as loaded only once every tile it
		// holds has settled — so geography can be on screen while a tile refused earlier still sits in
		// the cache as errored, and the notice correctly stays up until the map moves again.
		await expect
			.poll(
				async () => {
					await page.evaluate(
						(zoom: number) =>
							window.ballastellaBaseMap?.jumpTo({ center: [4.9041, 52.3676], zoom }),
						12 + (step++ % 2)
					);
					await page.waitForTimeout(500);
					return notice.count();
				},
				{ timeout: 60_000 }
			)
			.toBe(0);
	});

	test('is withdrawn when the author switches to a Base Map it has not asked yet', async ({
		page,
		context
	}) => {
		// The other half of the pair, and the half the viewer already drove: `ProjectScreen` clears what
		// it knows when the chosen entry changes, because a switch asks a fresh question and the answer
		// to the old one is not an answer to it. The notice carries the **new** entry's label —
		// `unavailableNotice` composes it from whichever entry is resolved — so an unreset flag does not
		// merely linger, it accuses a Base Map that has not failed. Deleting that effect left the whole
		// repository green until this test.
		//
		// `hang()` is what makes it decidable: after the switch the tile ranges are neither answered nor
		// refused, so nothing but the reset can clear the flag. A fixture that answered would clear it
		// by drawing, and one that refused would replace the notice with a true one — green either way,
		// which is why it went untested.
		const archive = await routePartialBaseMapArchive(context);
		await openPane(page);

		const notice = page.getByTestId('base-map-unavailable');
		await expect(notice).toBeVisible({ timeout: 45_000 });
		await expect(notice).toContainText('Streets');

		archive.hang();
		await switcher(page).selectOption('muted');

		// Nothing is said about “Muted, high contrast” until it has answered for itself.
		await expect(notice).toHaveCount(0);
		await page.waitForTimeout(3_000);
		await expect(notice).toHaveCount(0);
		await expect(switcher(page)).toHaveValue('muted');
		await page.unrouteAll({ behavior: 'ignoreErrors' });
	});

	test('is not shown when the archive answers', async ({ page, context }) => {
		// The other direction, and the one that stops this notice becoming permanent furniture. A
		// warning that is always on screen is a warning nobody reads, and it would be indistinguishable
		// from a genuine outage on the day there is one.
		await routeBaseMapArchive(context);
		await openPane(page);

		await expect.poll(() => styleLayerIds(page), { timeout: 30_000 }).toContain('water');
		await expect(page.getByTestId('base-map-unavailable')).toHaveCount(0);
	});
});

test.describe('the author’s default', () => {
	test.beforeEach(async ({ context }) => {
		await routeBaseMapArchive(context);
	});

	// ⚠ **The document half of the author's default is asserted at Seam 1.** ADR-0020 makes a Base Map
	// an *id*, never a URL, which makes every one of those claims a question about a document rather
	// than about a map, and each is a Vitest test in `packages/core/src/base-map/`:
	//
	//   - "is written to project.json as an id, with no URL anywhere in the file"
	//        → `project.test.ts` › "records the author choice as an id, and nothing that could be an
	//          address"
	//   - "is restored when the Project is reopened"
	//        → `project.test.ts` › "reads back what it wrote" and "reopens a Project onto the Base Map
	//          the author chose"
	//   - "falls back to the deployment default when the id is unrecognised, and says so"
	//        → `resolve.test.ts` › "falls back to the deployment default for an unknown id, without
	//          throwing" and `baseMapFallbackNotice` › "names both the missing Base Map and the one
	//          shown instead"
	//   - "leaves an unrecognised id in project.json, so moving the Project back restores it"
	//        → `project.test.ts` › "keeps an unrecognised id in the document, so moving the Project
	//          back restores it"
	//   - "stamps updatedAt, because one write path owns the whole document"
	//        → `project.test.ts` › "stamps updatedAt when the choice is saved, because one write path
	//          owns the document"
	//
	// What stays here is the *writing* rather than the *written*: the save state below is the app's
	// only signal that the choice reached the disk (ADR-0017 rule 5), and the quota failure it is
	// asserted under is injected at a browser API a fake would not have.

	test('shows the save state, and says so when the choice could not be written', async ({
		page
	}) => {
		// ADR-0017 rule 5: there is no Save button, so this indicator is the user's only signal.
		// The write used to be fire-and-forget — `void store?.write(id)`, no await, no catch, and no
		// indicator on this route at all — so a quota failure switched the map, said nothing, and
		// silently reverted when the Project was reopened.
		await openPane(page);
		const indicator = page.locator('[data-save-state]');
		await expect(indicator).toHaveAttribute('data-save-state', 'saved');

		// Chromium reports OPFS quota exhaustion from `close()`. Patched after seeding, so the
		// failure is injected at the browser API and the app cannot tell it is being lied to.
		await page.evaluate(() => {
			FileSystemWritableFileStream.prototype.close = () =>
				Promise.reject(new DOMException('Quota exceeded', 'QuotaExceededError'));
		});

		await switcher(page).selectOption('physical');

		await expect(indicator).toHaveAttribute('data-save-state', 'unsaved');
		await expect(indicator).toHaveText('Unsaved changes');
		// And the file really is unchanged, rather than half-written.
		expect(JSON.parse((await readProjectFile(page)) ?? '{}').baseMap).toBeNull();
	});
});

test.describe('the Project the pane opens', () => {
	test('creates nothing when no Project is named', async ({ page }) => {
		// Opening a pane must never create a Project. The deleted `/base-map/` with no `?p=` used to
		// call `getDirectoryHandle('demo-project', { create: true })` and manufacture a phantom
		// Project in the real Workspace, which the hub then listed as the user's own work. With one
		// route for both screens the unnamed case *is* the hub, and the claim is unchanged: arriving
		// with no `?p=` writes nothing.
		await page.goto(HUB);
		await emptyWorkspace(page);
		await page.goto(HUB);

		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
		// No pane, because no Project was named — and therefore no Base Map to choose.
		await expect(switcher(page)).toHaveCount(0);
		await expect(page.getByRole('listitem')).toHaveCount(0);
		expect(await workspaceEntries(page)).toEqual([]);
	});

	test('refuses a project.json it cannot read, and does not replace it', async ({ page }) => {
		// A trailing comma — a Dropbox conflict, a hand edit, a half-finished sync. The pane used to
		// swallow the parse failure, read it as "no Base Map chosen", and then write a whole fresh
		// document over it: `name`, `updatedAt`, and `layers` gone, in the one action that was
		// supposed to record a single field.
		const damaged = '{"formatVersion":1,"name":"Amsterdam 1625","layers":[],"baseMap":null,}';
		await page.goto(HUB);
		await emptyWorkspace(page);
		await seedProject(page, damaged);

		await page.goto(paneUrl());

		const alert = page.getByRole('alert');
		await expect(alert).toContainText('could not be read');
		// No switcher, because there is no document to record a choice in.
		await expect(switcher(page)).toHaveCount(0);
		expect(await readProjectFile(page)).toBe(damaged);
	});

	test('refuses a Project from a newer version and leaves it untouched', async ({ page }) => {
		// ADR-0010's refusal, which the old pane defeated: it rewrote a `formatVersion: 2` document
		// wholesale, which is exactly the silent destruction the refusal exists to prevent — and its
		// message promises "It has been left untouched."
		const fromTheFuture =
			'{"formatVersion":2,"name":"Tomorrow","layers":[{"kind":"something-new"}],"baseMap":"physical"}';
		await page.goto(HUB);
		await emptyWorkspace(page);
		await seedProject(page, fromTheFuture);

		await page.goto(paneUrl());

		const alert = page.getByRole('alert');
		await expect(alert).toContainText('newer version of Ballastella');
		await expect(alert).toContainText('left untouched');
		await expect(switcher(page)).toHaveCount(0);
		expect(await readProjectFile(page)).toBe(fromTheFuture);
	});

	test('says so when the Project named does not exist, rather than creating it', async ({
		page
	}) => {
		await page.goto(HUB);
		await emptyWorkspace(page);

		await page.goto(paneUrl('never-existed'));

		await expect(page.getByRole('alert')).toContainText('never-existed');
		expect(await workspaceEntries(page)).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Making a Project available offline (ADR-0025)
//
// **What makes these tests non-vacuous.** The failure ADR-0025 warns about is bytes served and
// nothing drawn — a compression mistake produces exactly that, with no error anywhere — so an
// assertion that the map "has a source", or that no console error appeared, would pass in the
// broken case. Every drawing claim below therefore rests on two things at once:
// `window.ballastellaServedBaseMapTiles`, which the protocol handler appends to only for a tile it
// answered **with bytes**, and `queryRenderedFeatures()`, which is MapLibre reporting geometry it
// parsed out of those bytes and put on screen. Neither alone is enough; the pair is.
//
// **And the network the feature removes is genuinely cut.** The archive route is switched to
// `abort()` before the offline half, so a pmtiles range request cannot succeed. Anything drawn after
// that came out of the Workspace.

/** The canal belt, inside the Amsterdam fixture's own extent so the archive really has these tiles. */
const CANAL_BELT_BOX = { west: 4.88, south: 52.36, east: 4.92, north: 52.38 };

/**
 * The archive every entry in this deployment's catalog points at (ADR-0020).
 *
 * Named here because the cache directory is keyed on it and a test that asserts on the
 * *files* has to know where they are. `scripts/check-base-map-catalog.mjs` exempts `*.e2e.ts` for
 * exactly this class of assertion — the switcher test below already names entry ids for the same
 * reason — and never exempts a support module, so the harness stays fork-safe.
 */
const ARCHIVE = 'https://data.source.coop/protomaps/openstreetmap/v4.pmtiles';

/**
 * The host that archive is fetched from — what an outage notice names at a scholar.
 *
 * Derived rather than written a second time, so a repoint of the catalog is one edit here instead
 * of two that can disagree.
 */
const ARCHIVE_HOST = new URL(ARCHIVE).host;

/** Where this deployment's cached tiles sit in a Workspace, with its trailing `/`. */
const TILES = baseMapTileDirectory(ARCHIVE);

/** The same box as a closed ring, for the Annotation that gives a seeded Project its extent. */
const CANAL_BELT_RING = [
	[4.88, 52.36],
	[4.92, 52.36],
	[4.92, 52.38],
	[4.88, 52.38],
	[4.88, 52.36]
];

/** A Project holding one Annotation Layer, so it has an extent to be made available offline. */
const projectWithWork = (ring = CANAL_BELT_RING) => ({
	project: projectJson({
		layers: [
			{
				kind: 'annotation',
				id: 'notes',
				name: 'Notes',
				visible: true,
				order: 0,
				geojsonRef: 'annotations/notes.geojson',
				defaultStyle: {}
			}
		]
	}),
	annotations: JSON.stringify({
		type: 'FeatureCollection',
		features: [
			{
				type: 'Feature',
				id: 'a1',
				properties: { 'ballastella:id': 'a1', title: 'The canal belt' },
				geometry: { type: 'Polygon', coordinates: [ring] }
			}
		]
	})
});

/** Seed a Project directory with its `project.json` and one Annotation file. */
async function seedProjectWithWork(page: Page, ring = CANAL_BELT_RING): Promise<void> {
	const seeded = projectWithWork(ring);
	await seedProject(page, seeded.project);
	await page.evaluate(
		async ([directory, geojson]) => {
			const root = await workspaceRoot();
			const project = await root.getDirectoryHandle(directory, { create: true });
			const folder = await project.getDirectoryHandle('annotations', { create: true });
			const handle = await folder.getFileHandle('notes.geojson', { create: true });
			const writable = await handle.createWritable();
			await writable.write(geojson);
			await writable.close();
		},
		[PROJECT_DIRECTORY, seeded.annotations] as const
	);
}

/**
 * Every cached tile path in the Workspace, sorted. The behaviour *is* the files (Seam 1).
 *
 * ⚠ **This is also what holds the harness's copy of `baseMapArchiveKey` to the application's.**
 * `support/editor-deployment.ts` re-derives that key because the suite's tsconfig covers `e2e/`
 * alone and cannot import from the packages, and a duplicated derivation with nothing comparing it
 * drifts. Nothing compares them directly; what compares them is this walk, which looks under the
 * *harness's* directory for tiles the *app* wrote — so "writes a tile file for every zoom" below goes
 * red the moment the two disagree. The other direction is `viewer-reader.e2e.ts`'s offline test,
 * where the harness writes the files and the app reads them.
 */
async function cachedTilePaths(page: Page): Promise<string[]> {
	return page.evaluate(async (prefix) => {
		const walk = async (
			directory: FileSystemDirectoryHandle,
			prefix: string
		): Promise<string[]> => {
			const found: string[] = [];
			for await (const [name, handle] of directory.entries()) {
				const path = `${prefix}${name}`;
				if (handle.kind === 'directory') {
					found.push(...(await walk(handle as FileSystemDirectoryHandle, `${path}/`)));
				} else {
					found.push(path);
				}
			}
			return found;
		};
		const root = await workspaceRoot();
		try {
			let directory = root;
			for (const segment of prefix.split('/').filter(Boolean)) {
				directory = await directory.getDirectoryHandle(segment);
			}
			// Tiles only: the provenance record lives in the same keyed directory, and counting it as a tile
			// would make "23 tiles for a city centre" quietly 24.
			return (await walk(directory, prefix)).filter((path) => path.endsWith('.mvt')).sort();
		} catch {
			return [];
		}
	}, TILES);
}

/** One file's text out of the Workspace, or `''` when it is not there. */
async function workspaceFile(page: Page, path: string): Promise<string> {
	return page.evaluate(async (wanted) => {
		const parts = wanted.split('/');
		const name = parts.pop()!;
		let directory = await workspaceRoot();
		try {
			for (const part of parts) directory = await directory.getDirectoryHandle(part);
			return await (await (await directory.getFileHandle(name)).getFile()).text();
		} catch {
			return '';
		}
	}, path);
}

/** Tiles the protocol handler answered **with bytes**, in order. Not a count of requests. */
const servedTiles = (page: Page) => page.evaluate(() => window.ballastellaServedBaseMapTiles ?? []);

/** Tiles MapLibre asked the cache for and did not get. The only trace an empty tile leaves. */
const missedTiles = (page: Page) => page.evaluate(() => window.ballastellaMissedBaseMapTiles ?? []);

/**
 * Whether the **Base Map's own geography** is on screen — not merely "something is".
 *
 * ⚠ `renderedLayerIds` queries the whole map, and the Project seeded below has an Annotation Layer
 * drawing a polygon over the same MapLibre instance — so `renderedLayerIds(page) !== []` is a claim
 * about *anything at all* being on screen, which is not the claim ADR-0025 needs. The failure it
 * names is bytes served and the reference map blank, with no error anywhere.
 *
 * **Measured, not assumed.** The mutation is `openArchiveTiles` filling the cache with the archive's
 * *gzipped* bytes — the compression mistake itself. Under it the whole-map form went red here too
 * (the annotation stack does not rebuild when the Base Map source parses nothing), so these four
 * assertions were weak rather than vacuous. Its twin in `viewer-reader.e2e.ts` was genuinely vacuous:
 * with the site's tiles gzipped, the Reader's two Layers kept `queryRenderedFeatures()` non-empty and
 * that test passed with a blank map. Both now name a Base Map layer. `roads_` and `water` are
 * Protomaps prefixes and belong to no Layer this app produces (`ballastella-layer-…`), so neither can
 * be satisfied by the user's own work.
 */
const baseMapIsDrawn = async (page: Page): Promise<boolean> =>
	(await renderedLayerIds(page)).some((id) => id.startsWith('roads_') || id.startsWith('water'));

/** Open the Project screen and wait for its map. `?p=` addresses the screen itself. */
async function openProjectScreen(page: Page, directory: string = PROJECT_DIRECTORY): Promise<void> {
	await page.goto(paneUrl(directory));
	await waitForLoadedMap(page);
}

/** Fetch the tiles this Project's extent needs, through the dialog, exactly as a user would. */
async function makeAvailableOffline(page: Page): Promise<void> {
	await page.getByTestId('edit-project-name').click();
	await page.getByTestId('make-offline').click();
	await expect(page.getByTestId('offline-status')).toHaveAttribute('data-step', 'deciding');
	await page.getByTestId('offline-start').click();
	await expect(page.getByTestId('offline-done')).toContainText('Fetched', { timeout: 120_000 });
}

/**
 * The measurement ADR-0025's numbers rest on, re-taken from the archive every run.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A TEST AND NOT A COMMENT
 *
 * The tile counts and byte totals for a realistic Project extent are the one part of ADR-0025 that
 * rests on measurement rather than on reasoning, and a measurement written into prose goes stale
 * with nothing able to tell: `grep` for the figures finds only sentences.
 *
 * So they are asserted here instead, against the real fixture: the point is not that the number is
 * interesting, it is that the decision resting on it cannot be quietly undone. Three decisions rest
 * on this table — the 500-tile refusal threshold, the per-tile estimate, and the choice to store
 * decompressed MVT — and each is asserted against the measurement rather than beside it.
 *
 * No browser is involved: the body is Node, and it reads the same fixture the suite serves.
 */
test.describe('what ADR-0025’s numbers were measured against', () => {
	test('a city-centre Project at every zoom is tens of tiles and a few megabytes', async () => {
		const measured = await cachedBaseMapTiles(ARCHIVE, CANAL_BELT_BOX, 14);

		// The row ADR-0025's "a city centre is tens of tiles" is asserted from. Exact, because an extent
		// this size has an exact answer and a range would hide a change in the enumeration.
		expect(measured.tilesInExtent).toBe(23);
		expect(measured.tilesPresent).toBe(23);
		expect(measured.decompressedBytes).toBe(3_485_916);
		expect(measured.gzippedBytes).toBe(2_478_805);

		// **Tens of tiles, not thousands** — the claim the whole opt-in rests on being reasonable, and
		// the reason a 500-tile refusal threshold refuses a country without refusing a Project.
		expect(measured.tilesInExtent).toBeLessThan(100);

		// The constants that quote these figures are asserted against them in
		// `packages/core/src/base-map/tile-cache.test.ts`, which is where they live. The two halves are
		// tied by the literals: change the fixture and this goes red; change a constant and that does.
	});

	test('the whole fixture extent weighs what the compression decision says it does', async () => {
		const measured = await cachedBaseMapTiles(ARCHIVE);

		expect(measured.archiveBytes).toBe(4_137_622);
		expect(measured.tilesInExtent).toBe(43);
		expect(measured.decompressedBytes).toBe(5_818_431);
		expect(measured.gzippedBytes).toBe(4_136_082);

		// **The measured cost of storing decompressed MVT**, which is what `tile-cache.ts` quotes as the
		// price of making the silent-blank-map failure impossible rather than merely avoided.
		const overhead = measured.decompressedBytes / measured.gzippedBytes - 1;
		expect(overhead).toBeGreaterThan(0.4);
		expect(overhead).toBeLessThan(0.42);
	});
});

test.describe('making a Project available offline', () => {
	test.beforeEach(async ({ context, page }) => {
		await routeBaseMapArchive(context);
		await page.goto(HUB);
		await emptyWorkspace(page);
		await seedProjectWithWork(page);
	});

	// ⚠ **The arithmetic and the record-keeping are asserted at Seam 1.** "How many tiles does this
	// extent need", "what do they weigh", "which of them are already files" and "what is refused" are
	// questions about a list and a store, and driving them through a browser proved nothing a
	// `MemoryProjectStore` cannot. Each is a Vitest test in
	// `packages/core/src/base-map/offline-cache.test.ts`:
	//
	//   - "shows a tile count and a byte estimate before fetching anything"
	//        → "costs the Workspace nothing to ask, because the plan is only a plan", with the sentence
	//          itself in "what the user is told before agreeing" › "states the count, the estimate, and
	//          the zoom range"
	//   - "writes a tile file for every zoom from 0 to the source maximum"
	//        → "writes a tile file for every zoom from 0 to the source maximum"
	//   - "refuses an extent past the threshold with the numbers, and writes nothing"
	//        → "an extent past the threshold" › "is refused with the numbers, and nothing is fetched"
	//   - "reports a second Project in the same area as available offline without fetching"
	//        → "reports a second Project in the same area as available offline, having fetched nothing"
	//   - "reports a Project whose extent has grown beyond the cache as not available offline"
	//        → "reports a Project whose extent has outgrown the cache as not available offline"
	//   - "fetches only the tiles not already present when it is run again"
	//        → "fetches only tiles not already present when it is run again"
	//
	// What stays below needs the browser for a reason it cannot be given one seam down: the map really
	// drawing from the cache with the network cut, the attribution surviving it, the recorded depth
	// answering with no connection at all, and the hub's clear acting on the real files.

	test('still answers “is this Project available offline?” with the archive unreachable', async ({
		page,
		context
	}) => {
		// ⚠ The question needs the *source's* deepest zoom — "every zoom from 0 to the source's maximum"
		// — and reading that off the archive is a live PMTiles header fetch. So with no connection the
		// screen said the answer could not be checked, which is the one state the feature exists to
		// remove. The depth is now recorded beside the tiles when they are fetched, from the header the
		// archive itself gave, so the answer survives the network going away.
		await openProjectScreen(page);
		await makeAvailableOffline(page);
		await expect(page.getByTestId('offline-availability')).toHaveAttribute('data-offline', 'yes');
		expect(await workspaceFile(page, baseMapTileSourcePath(ARCHIVE))).toContain('"maxZoom":14');

		await context.route(/\.pmtiles$/, (route) => route.abort());
		await page.reload();
		await waitForLoadedMap(page);

		// Still `yes`, not `unknown`. And it says which, because the recorded depth is a snapshot.
		const availability = page.getByTestId('offline-availability');
		await expect(availability).toHaveAttribute('data-offline', 'yes', { timeout: 30_000 });
		await expect(availability).toContainText('Available offline: all 23 Base Map tiles');
		await expect(availability).toContainText('because there is no connection');
	});

	test('does not answer from a record left by a different archive', async ({ page, context }) => {
		// ADR-0020 lets a catalog entry be repointed with no change anywhere else, so one Workspace can
		// hold tiles from two pyramids. They are in **different directories**, keyed by archive — but a
		// record inside this archive's own directory naming another archive can still arrive by hand, and
		// it is not evidence about this one. The screen goes back to saying it cannot check rather than
		// claiming a depth it has no warrant for.
		await openProjectScreen(page);
		await makeAvailableOffline(page);

		await page.evaluate(async (path) => {
			const segments = path.split('/');
			const name = segments.pop()!;
			let directory = await workspaceRoot();
			for (const segment of segments) {
				directory = await directory.getDirectoryHandle(segment, { create: true });
			}
			const handle = await directory.getFileHandle(name, { create: true });
			const writable = await handle.createWritable();
			await writable.write(
				JSON.stringify({ archive: 'https://elsewhere.test/other.pmtiles', maxZoom: 14 })
			);
			await writable.close();
		}, baseMapTileSourcePath(ARCHIVE));

		await context.route(/\.pmtiles$/, (route) => route.abort());
		await page.reload();
		await waitForLoadedMap(page);

		await expect(page.getByTestId('offline-availability')).toHaveAttribute(
			'data-offline',
			'unknown',
			{ timeout: 30_000 }
		);
	});

	test('draws the Base Map across the extent with the archive unreachable, at the lowest zoom and the highest', async ({
		page,
		context
	}) => {
		await openProjectScreen(page);
		await makeAvailableOffline(page);

		// The network this feature exists to remove, removed. Any pmtiles range request from here on
		// fails, so anything drawn below came out of `base-map/tiles/`.
		await context.route(/\.pmtiles$/, (route) => route.abort());
		const refused: string[] = [];
		page.on('requestfailed', (request) => {
			if (request.url().includes('.pmtiles')) refused.push(request.url());
		});

		await page.reload();
		await waitForLoadedMap(page);
		await expect(page.getByTestId('offline-availability')).toHaveAttribute(
			'data-cache-serving',
			'yes'
		);

		// **Bytes served *and* the Base Map's own geography drawn**, and the second half is
		// {@link baseMapIsDrawn} rather than "something rendered". The compression mistake ADR-0025 names
		// serves bytes and draws nothing, and this Project has an Annotation on the same map, so
		// "something rendered" is a claim about the wrong thing. Fill the cache with gzipped bytes and
		// this goes red — see {@link baseMapIsDrawn} for the mutation and what it showed.
		await expect
			.poll(async () => (await servedTiles(page)).length, { timeout: 60_000 })
			.toBeGreaterThan(0);
		await expect.poll(() => baseMapIsDrawn(page), { timeout: 60_000 }).toBe(true);

		// Zoomed all the way out — the case that goes blank if zoom 0 is skipped.
		await page.evaluate(() => window.ballastellaBaseMap?.setZoom(0));
		await expect
			.poll(async () => (await servedTiles(page)).some((tile) => tile.z === 0), { timeout: 60_000 })
			.toBe(true);
		await expect.poll(() => baseMapIsDrawn(page), { timeout: 60_000 }).toBe(true);

		// And at the source's deepest zoom.
		await page.evaluate(() => {
			window.ballastellaBaseMap?.jumpTo({ center: [4.9, 52.37], zoom: 14 });
		});
		await expect
			.poll(async () => (await servedTiles(page)).some((tile) => tile.z === 14), {
				timeout: 60_000
			})
			.toBe(true);
		await expect.poll(() => baseMapIsDrawn(page), { timeout: 60_000 }).toBe(true);

		// ── Past the source's deepest zoom, which is what the cached source's `maxzoom` is for ──
		//
		// A scholar keeps zooming. The archive stops at 14; the cache therefore stops at 14; and what
		// has to happen is that MapLibre *overzooms* the z14 tiles rather than asking for z15 and z16.
		// Without `maxzoom` on the source it asks anyway, every one of those comes back as an empty
		// tile, and the map goes blank at exactly the zoom the user was told works offline — silently,
		// because an empty tile is not an error.
		//
		// **Asserted as "nothing deeper than 14 was ever asked for", not as "something drew"**: the
		// deeper request is the mechanism, and a rendered-features check alone stays green when the
		// blank tiles have not arrived yet. Dropping `maxzoom` left every other assertion in this test
		// passing, which is how this one came to be written.
		await page.evaluate(() => {
			window.ballastellaBaseMap?.jumpTo({ center: [4.9, 52.37], zoom: 16 });
		});
		await expect.poll(() => baseMapIsDrawn(page), { timeout: 60_000 }).toBe(true);
		expect(
			(await missedTiles(page)).map((tile) => tile.z).filter((z) => z > 14),
			'MapLibre asked the cache for tiles deeper than the source has'
		).toEqual([]);
		expect(
			await page.evaluate(() => window.ballastellaBaseMap?.getZoom() ?? 0),
			'the map did not actually reach zoom 16'
		).toBeGreaterThan(14);

		// The archive really was unreachable throughout, so nothing above was drawn over the network.
		expect(await servedTiles(page)).not.toEqual([]);
		void refused;
	});

	test('keeps the OpenStreetMap attribution with the cache serving and the archive unreachable', async ({
		page,
		context
	}) => {
		await openProjectScreen(page);
		await makeAvailableOffline(page);
		await context.route(/\.pmtiles$/, (route) => route.abort());
		await page.reload();
		await waitForLoadedMap(page);

		// ODbL does not lapse because no request left the machine.
		await expect(page.locator('.maplibregl-ctrl-attrib')).toContainText('OpenStreetMap');
	});

	test('is not listed on the hub, while the Project remains available offline', async ({
		page
	}) => {
		await openProjectScreen(page);
		await makeAvailableOffline(page);

		// ⚠ **This walk is what holds the harness's copy of `baseMapArchiveKey` to the application's** —
		// see {@link cachedTilePaths}. It is asserted non-empty here rather than only emptied below,
		// because `toEqual([])` is satisfied by a directory the app never wrote to. The fence checks
		// that the application wrote the expected tile files.
		expect(await cachedTilePaths(page)).toHaveLength(23);

		await page.goto(HUB);
		await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Map Images' })).toBeVisible();
		await expect(page.getByText('Offline Base Map')).toHaveCount(0);
		await expect(page.getByTestId('clear-base-map-cache')).toHaveCount(0);

		expect(await cachedTilePaths(page)).toHaveLength(23);

		await openProjectScreen(page);
		await expect(page.getByTestId('offline-availability')).toHaveAttribute('data-offline', 'yes');
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// FINDING A PLACE AND GOING TO IT (ADR-0029)
//
// The pane is shared, so this is one component on two screens, and both are driven here rather than
// one being assumed from the other.
//
// **Two of these assertions pass vacuously if written naively**, and each says at its site what it
// was mutated with:
//
//   - "typing issues zero requests" is asserted by *counting requests while typing*. A test that
//     only checked the candidate list was empty would pass against a debounced implementation, which
//     is precisely the violation.
//   - "the two empty-handed outcomes say different things" is asserted by comparing the two
//     sentences. Both outcomes end in no candidates, so a test that checked either list was empty
//     would pass whichever one was produced.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Where the fixture's candidates are, read off the committed response rather than invented. */
const MASSACHUSETTS = { lng: -72.5466223, lat: 42.11297795 };
const MISSOURI = { lng: -93.2958593, lat: 37.1828864 };

const searchField = (page: Page) => page.getByTestId('place-search-query');
const candidates = (page: Page) => page.getByTestId('place-candidate');
const searchStatus = (page: Page) => page.getByTestId('place-search-status');

/**
 * What the status line says **once the lookup it is about has settled**.
 *
 * ⚠ **Every read of that node has to go through here.** While a lookup is in flight the same node
 * says `Looking up “<query>”…` — visible, and carrying the query — so a bare `toContainText(query)`
 * or a `textContent()` can be satisfied by the progress line and never see an outcome at all. That
 * is not a hypothetical: it is what let the two-sentences test below pass a mutation.
 */
async function settledStatus(page: Page): Promise<string> {
	await expect(searchStatus(page)).not.toHaveText(/^$|Looking up/);
	return (await searchStatus(page).textContent()) ?? '';
}

type Box = { x: number; y: number; width: number; height: number };

/** One element's box, or a failure rather than a `null` that would compare equal to another. */
async function boxOf(locator: Locator): Promise<Box> {
	const box = await locator.boundingBox();
	expect(box, 'the element has no box at all').not.toBeNull();
	return box as Box;
}

/** `inner` is drawn over `outer` rather than taking room of its own beside it. */
function expectDrawnOver(inner: Box, outer: Box): void {
	expect(inner.y, 'drawn below the map rather than over it').toBeGreaterThanOrEqual(outer.y);
	expect(inner.y + inner.height, 'reaches past the bottom of the map').toBeLessThanOrEqual(
		outer.y + outer.height
	);
	expect(inner.x).toBeGreaterThanOrEqual(outer.x);
	expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
}

/**
 * The gap the lookup's own limiter refuses inside, stated here rather than imported.
 *
 * A test taking its number from the constant the application paces itself by would go on passing if
 * that constant were changed to a minute — which is the same reason `ANNOTATION_COLOR` spells its hex
 * out in `support/annotations.ts`. One second is the service's published limit.
 */
const ONE_SECOND = 1_000;

/** When the last query in this test went out, so `findPlace` can leave the limiter satisfied. */
let lastSubmitAt = 0;

/**
 * Submit a query, with no pointer anywhere in it.
 *
 * ⚠ **Waits out the limiter first.** Two searches inside one second are refused without a request now
 * (ADR-0029), so a test doing two lookups back to back would be measuring the limiter rather than
 * whatever it meant to. The test that *is* about the limiter submits without this — see it below.
 */
async function findPlace(page: Page, query: string): Promise<void> {
	const since = Date.now() - lastSubmitAt;
	if (since < ONE_SECOND) await page.waitForTimeout(ONE_SECOND - since);
	await submitQuery(page, query);
}

/**
 * Submit, whatever the limiter would say about it. Only the limiter's own test wants this.
 *
 * The stamp is taken **after** the press, which is what makes the wait in `findPlace` enough: the
 * request goes out during it, so a second measured from here is never shorter than the second the
 * page is measuring.
 */
async function submitQuery(page: Page, query: string): Promise<void> {
	await searchField(page).fill(query);
	await searchField(page).press('Enter');
	lastSubmitAt = Date.now();
}

/** Submit `query` and read what the status line settles on for it. */
async function outcomeFor(page: Page, query: string): Promise<string> {
	await findPlace(page, query);
	return await outcomeAbout(page, query);
}

/**
 * What the status line settles on for a query already submitted — the limiter's test, and only it.
 *
 * ⚠ **Composed with {@link settledStatus} rather than reading the node itself**, which is the fence
 * that helper's header states. It adds the one condition of its own: the sentence has to be about
 * **this** query, because a lookup that has not started yet leaves the previous outcome on screen and
 * every sentence in the table names its own search. Waiting for the query first admits the in-flight
 * `Looking up “…”…` line, and `settledStatus` then waits that out — so what comes back is this
 * query's outcome and never the progress line.
 */
async function outcomeAbout(page: Page, query: string): Promise<string> {
	await expect(searchStatus(page)).toContainText(query);
	return await settledStatus(page);
}

/**
 * One sentence with the search taken out of it, so two outcomes about different queries compare.
 *
 * Every row names its own query, and two rows that must say the *same thing* — a `429` and this
 * application's own refusal, a body that could not be read and a service that did not answer — can
 * only be compared once that difference is removed.
 */
const withoutQuery = (said: string, query: string): string => said.split(query).join('…');

/** Where the map is now. */
const centre = (page: Page) =>
	page.evaluate(() => ({
		lng: window.ballastellaBaseMap?.getCenter().lng ?? 0,
		lat: window.ballastellaBaseMap?.getCenter().lat ?? 0
	}));

/** The map is framed on `place`, within a fraction of a degree of its box's own centre. */
async function expectFramedOn(page: Page, place: { lng: number; lat: number }): Promise<void> {
	await expect
		.poll(async () => (await centre(page)).lat, { timeout: 15_000 })
		.toBeCloseTo(place.lat, 1);
	expect((await centre(page)).lng).toBeCloseTo(place.lng, 1);
}

test.describe('finding a place', () => {
	test.beforeEach(async ({ context }) => {
		// Each test gets its own page and therefore its own limiter, so nothing is owed from the last.
		lastSubmitAt = 0;
		await routeBaseMapArchive(context);
	});

	test('shows the candidates a query matched, and frames the map on the one chosen', async ({
		page,
		context
	}) => {
		const service = await routePlaceLookup(context);
		await openPane(page);

		// Amsterdam, where this deployment's catalog opens — so the move below is unmistakable.
		expect((await centre(page)).lng).toBeCloseTo(4.9041, 2);

		await findPlace(page, AMBIGUOUS_QUERY);

		// Ten real candidates from one captured response. **They are shown, not taken**: a Pin in the
		// wrong Springfield is indistinguishable from a Pin in the right one, so the top hit is never
		// chosen on the scholar's behalf.
		await expect(candidates(page)).toHaveCount(10);
		await expect(candidates(page).first()).toContainText('Sangamon County, Illinois');
		expect(service.queries()).toEqual([AMBIGUOUS_QUERY]);

		await candidates(page).filter({ hasText: 'Hampden County' }).click();

		await expectFramedOn(page, MASSACHUSETTS);
		// **No marker.** The framing is the answer; a marker at the found point would be a thing on
		// screen with no meaning, indistinguishable at a glance from an Annotation the scholar made.
		//
		// ⚠ Asserted on **every marker on the pane**, not only on the overlay-point kinds this app
		// draws: a bare `new Marker()` dropped at the found point is the mutation, and a locator
		// keyed to `data-testid` would not see one.
		await expect(page.locator('[data-testid="base-map-pane"] .maplibregl-marker')).toHaveCount(0);
		await expect(page.locator('[data-testid^="pane-overlay-point-"]')).toHaveCount(0);
	});

	test('works on the alignment screen too, where the same pane is rendered', async ({
		page,
		context
	}) => {
		// **Asserted here rather than assumed from the shared component.** Excluding either screen
		// would mean actively suppressing the feature on a screen that renders the same pane, and a
		// scholar hunting the modern half of a Control Point wants this at least as much as an
		// annotator does.
		await routePlaceLookup(context);
		await startAlignment(page);

		await findPlace(page, AMBIGUOUS_QUERY);
		await expect(candidates(page)).toHaveCount(10);
		await candidates(page).filter({ hasText: 'Greene County' }).click();

		await expectFramedOn(page, MISSOURI);
	});

	test('issues no request at all while a query is being typed', async ({ page, context }) => {
		// ⚠ **Counted, not inferred from an empty list.** Mutation: an `oninput` on the field calling
		// the same submit as the form. The candidate list then fills while typing, and every
		// list-shaped assertion in this file stays green — this one goes red on the first keystroke,
		// which is the whole reason it counts.
		const service = await routePlaceLookup(context);
		await openPane(page);

		await searchField(page).pressSequentially(AMBIGUOUS_QUERY, { delay: 60 });
		// Long enough that a debounce of any plausible length would have fired.
		await page.waitForTimeout(1_500);

		expect(service.count(), 'a request was issued while typing').toBe(0);
		await expect(candidates(page)).toHaveCount(0);

		// And the submit does issue exactly one, so the zero above is not a broken field.
		await searchField(page).press('Enter');
		await expect(candidates(page)).toHaveCount(10);
		expect(service.count()).toBe(1);
	});

	test('says something different for a query that matched nothing and a service that did not answer', async ({
		page,
		context
	}) => {
		// ⚠ **The two sentences are compared.** Mutation: make `placeLookupNotice` return the same
		// string for `none` and `unanswered`. Both outcomes end in no candidates, so a test asserting
		// an empty list passes whichever one was produced — and the failure it lets through is being
		// told to check a spelling when the request never left the building.
		const service = await routePlaceLookup(context);
		await openPane(page);

		//
		// ⚠ **Both reads go through `settledStatus`**, which is what makes the comparison mean
		// anything: the in-flight `Looking up “Nowhere at all”…` is visible in this same node and
		// carries the query, so reading it directly satisfies "visible" and "names the query" and can
		// capture the progress line as one of the two sentences — under which the mutation above
		// survives green.
		service.answerWith('[]');
		await findPlace(page, 'Nowhere at all');
		const matchedNothing = await settledStatus(page);
		await expect(searchStatus(page)).toBeVisible();
		expect(matchedNothing).toContain('Nowhere at all');

		// The same query, so the only thing that differs is what the service did.
		service.answerWith('', 503);
		await findPlace(page, 'Nowhere at all');
		await expect.poll(() => settledStatus(page)).not.toBe(matchedNothing);

		await expect(searchStatus(page)).toBeVisible();
		await expect(candidates(page)).toHaveCount(0);
	});

	test('says all four things, each driven by the condition that causes it', async ({
		page,
		context
	}) => {
		// ⚠ **Every sentence here is composed in `@ballastella/core`**, and the strings asserted below
		// are that function's own words. Mutation: change the wording of any row in `placeLookupNotice`
		// and this test goes red — which is what "the sentence is shared rather than duplicated in the
		// component" means, and the only way to find out that it has been re-typed into the template.
		const service = await routePlaceLookup(context);
		await openPane(page);

		const found = await outcomeFor(page, AMBIGUOUS_QUERY);
		expect(found).toContain('10 places match');

		service.answerWith('[]');
		const matchedNothing = await outcomeFor(page, 'Nowhere at all');
		expect(matchedNothing).toContain('spelling');

		service.answerWith('', 503);
		const unanswered = await outcomeFor(page, 'Leiden');
		expect(unanswered).toContain('could not be looked up');

		// A fork pointed at something that is not a geocoder, which the module cannot read: it folds
		// into *did not answer* rather than becoming a fifth message about response schemas, because
		// that sentence reaches the instance operator and not the person reading it (ADR-0029).
		service.answerWith('{"error":"unknown parameter"}');
		const unreadable = await outcomeFor(page, 'Utrecht');
		expect(withoutQuery(unreadable, 'Utrecht')).toBe(withoutQuery(unanswered, 'Leiden'));

		service.answerWith('', 429);
		const tooFast = await outcomeFor(page, 'Delft');
		expect(tooFast).toContain('wait a moment and search again');

		// Four rows, four sentences, with the query taken out so what is compared is the wording. Both
		// empty-handed outcomes end in no candidates, so nothing about the *list* can tell them apart.
		const said = [found, matchedNothing, unanswered, tooFast].map((text, index) =>
			withoutQuery(text, [AMBIGUOUS_QUERY, 'Nowhere at all', 'Leiden', 'Delft'][index]!)
		);
		expect(new Set(said).size).toBe(4);
		await expect(searchStatus(page)).toBeVisible();
		await expect(candidates(page)).toHaveCount(0);
	});

	test('refuses a second search inside a second, and says what a 429 says', async ({
		page,
		context
	}) => {
		// The client-side refusal and the server's own `429` are one outcome and one sentence: the
		// remedy is identical and which side counted is not a fact a scholar can act on (ADR-0029).
		const service = await routePlaceLookup(context);
		await openPane(page);

		service.answerWith('', 429);
		const refusedByService = await outcomeFor(page, 'Delft');

		// Now the limiter's own refusal, with the fixture answering again so that nothing but the pace
		// decides the outcome. ⚠ **No `findPlace` here**: that helper waits the limiter out, and this is
		// the one test that must not.
		await service.answerFromFixture();
		const before = service.count();
		// The first is paced, so it is the one that goes out; the second follows it immediately, which
		// is the gesture — a scholar pressing Enter twice, or an autocomplete somebody has built.
		await findPlace(page, 'Boston');
		await submitQuery(page, 'Cambridge');
		const refusedHere = await outcomeAbout(page, 'Cambridge');

		expect(withoutQuery(refusedHere, 'Cambridge')).toBe(withoutQuery(refusedByService, 'Delft'));
		// ⚠ **The request count, not the sentence.** A limiter that asked the service and then reported
		// *too fast* would satisfy every assertion about the text above, and would be exactly the
		// violation the limiter exists to prevent — the service's policy is about requests.
		expect(service.count() - before, 'the refused search still went out').toBe(1);
		await expect(candidates(page)).toHaveCount(0);

		// And it is a moment's pause rather than a dead field: the same query works a second later.
		await findPlace(page, 'Cambridge');
		await expect(candidates(page)).toHaveCount(10);
	});

	test('never says whose fault it is when the browser reports no connection, and stays enabled', async ({
		page,
		context
	}) => {
		// `navigator.onLine` reports a link rather than reachability and is false-positive in both
		// directions, so it may take a claim away and may never add one.
		const service = await routePlaceLookup(context);
		await openPane(page);

		service.answerWith('', 503);
		const connected = await outcomeFor(page, 'Leiden');
		expect(connected).toContain('usually the lookup service');

		await context.setOffline(true);

		// ⚠ **Wait for the signal to have landed before asserting on it.** `setOffline` resolves before
		// the renderer has dispatched `offline` and `installedApp.online` has flipped, and `toBeEnabled`
		// polls until true — so against a `disabled={!installedApp.online}` mutation the first poll can
		// succeed on the state from *before* the connection was cut, and the test passes for a reason
		// nothing here asserts. This alert is rendered by that same signal, so it standing on screen is
		// the proof that the flip has happened.
		await expect(page.getByTestId('base-map-offline')).toBeVisible();

		// **Nothing is disabled**, asserted *before* the search rather than after it. Greying a control
		// out is itself a claim about the connection, and this is the one control in an offline-capable
		// editor that cannot work — it says so by failing and explaining rather than by refusing to be
		// typed in. ⚠ Asserted first because a search is not a substitute for the assertion: a disabled
		// field or button makes the lookup below fail to run at all, which reads as a broken test rather
		// than as the claim it is.
		await expect(searchField(page)).toBeEnabled();
		await expect(searchField(page)).toBeEditable();
		await expect(page.getByTestId('place-search-submit')).toBeEnabled();

		const cut = await outcomeFor(page, 'Utrecht');

		// ⚠ **Asserted on the string.** The clause blaming a server in another country is gone, and
		// nothing has taken its place: telling somebody their wifi is off on the strength of this signal
		// is making a claim it cannot support.
		expect(cut).not.toContain('usually the lookup service');
		expect(cut).not.toMatch(/offline|your connection|your wi-?fi|your internet/i);
		// What survives is the part that is true either way — it is still visible, and still says the
		// scholar's work is untouched.
		await expect(searchStatus(page)).toBeVisible();
		expect(cut).toContain('Nothing in your Workspace is affected');
	});

	test('reaches and chooses every candidate from the keyboard alone', async ({ page, context }) => {
		// A list of results is precisely the control that ships mouse-only, so there is no `click`
		// anywhere in this test.
		await routePlaceLookup(context);
		await openPane(page);

		await searchField(page).focus();
		await page.keyboard.type(AMBIGUOUS_QUERY);
		await page.keyboard.press('Enter');
		await expect(candidates(page)).toHaveCount(10);
		const total = await candidates(page).count();

		// Field → the submit button → the candidates, in the order they are read out.
		await page.keyboard.press('Tab');
		await expect(page.getByTestId('place-search-submit')).toBeFocused();
		for (let index = 0; index < total; index += 1) {
			await page.keyboard.press('Tab');
			await expect(candidates(page).nth(index)).toBeFocused();
		}

		// Back up to the third and take it, which is the disambiguation the fixture exists for. From
		// the last candidate, so the walk is the list's own length rather than a number written down.
		const wanted = 2;
		for (let index = total - 1; index > wanted; index -= 1) {
			await page.keyboard.press('Shift+Tab');
		}
		await expect(candidates(page).nth(wanted)).toContainText('Greene County');
		await expect(candidates(page).nth(wanted)).toBeFocused();
		await page.keyboard.press('Enter');

		await expectFramedOn(page, MISSOURI);
	});

	test('announces the outcome in a live region rather than only drawing it', async ({
		page,
		context
	}) => {
		await routePlaceLookup(context);
		await openPane(page);

		// `aria-live` with `aria-atomic`, and specifically not `role="status"` — the save indicator
		// owns that role on this screen, and a second one would make it ambiguous for a screen reader
		// exactly as it does for `getByRole`.
		await expect(searchStatus(page)).toHaveAttribute('aria-live', 'polite');
		await expect(searchStatus(page)).toHaveAttribute('aria-atomic', 'true');
		await expect(searchStatus(page)).not.toHaveAttribute('role', 'status');

		await findPlace(page, AMBIGUOUS_QUERY);

		await expect(searchStatus(page)).toContainText('10 places match');
		await expect(searchStatus(page)).toContainText(AMBIGUOUS_QUERY);
	});

	test('shows the lookup’s own attribution while its candidates are, and not otherwise', async ({
		page,
		context
	}) => {
		const attribution = page.getByTestId('place-attribution');
		const service = await routePlaceLookup(context);
		await openPane(page);

		// Not permanent chrome: nothing of the service's is on screen before it has answered.
		await expect(attribution).toHaveCount(0);

		await findPlace(page, AMBIGUOUS_QUERY);
		await expect(attribution).toBeVisible();
		// Visible text, and the lookup's own credit — not the Base Map catalog's, which says nothing
		// about where these candidates came from (ADR-0029).
		await expect(attribution).toContainText('OpenStreetMap contributors');

		// And gone with the candidates it credits: a search that matches nothing puts no data of the
		// service's on screen, so there is nothing left for the credit to be about.
		service.answerWith('[]');
		await findPlace(page, 'Nowhere at all');
		await expect(candidates(page)).toHaveCount(0);
		await expect(attribution).toHaveCount(0);
	});

	test('holds no layout open when nobody is searching', async ({ page, context }) => {
		// A two-pane authoring screen keeps its room for the work.
		//
		// ⚠ **The surface is measured against the pane, not against itself.** Mutation: drop `absolute`
		// from the wrapper in `PlaceSearch.svelte`. Comparing the map's own box before and after a
		// search survives that — the field is inside an `overflow-hidden` parent, so a surface that
		// takes flow overflows the pane instead of shrinking the canvas, and the canvas box never
		// moves. What does move is where the field sits: out of flow it is drawn *over* the map, and
		// in flow it is pushed below the pane entirely.
		await routePlaceLookup(context);
		await openPane(page);

		const pane = page.getByTestId('base-map-pane');
		const room = await boxOf(page.getByTestId('project-map'));
		const resting = await boxOf(pane);

		// The pane still has the whole of the room the screen gave it.
		expect(resting).toEqual(room);
		await expect(page.getByTestId('place-candidates')).toHaveCount(0);
		await expect(searchStatus(page)).toHaveText('');
		expectDrawnOver(await boxOf(searchField(page)), resting);

		await findPlace(page, AMBIGUOUS_QUERY);
		await expect(candidates(page)).toHaveCount(10);

		// And with ten candidates and a credit on screen, the pane is the size it was and all of it
		// is still over the map.
		expect(await boxOf(pane)).toEqual(resting);
		expectDrawnOver(await boxOf(searchField(page)), resting);
		expectDrawnOver(await boxOf(candidates(page).first()), resting);
	});

	test('puts the candidate list away once a candidate has been chosen', async ({
		page,
		context
	}) => {
		// **Mutation:** drop the `outcome = null` from `choose` in `PlaceSearch.svelte`. Every other
		// assertion in this file stays green — none of them looks at the list after a candidate has
		// been taken.
		await routePlaceLookup(context);
		await openPane(page);

		await findPlace(page, AMBIGUOUS_QUERY);
		await expect(candidates(page)).toHaveCount(10);
		await candidates(page).filter({ hasText: 'Hampden County' }).click();

		await expectFramedOn(page, MASSACHUSETTS);
		await expect(candidates(page)).toHaveCount(0);
		// The credit goes with the data it credits, and the sentence with the list it instructs.
		await expect(page.getByTestId('place-attribution')).toHaveCount(0);
		await expect(searchStatus(page)).toHaveText('');

		// Searching again still works, so the list was put away rather than broken.
		await findPlace(page, AMBIGUOUS_QUERY);
		await expect(candidates(page)).toHaveCount(10);
	});
});

test.describe('the theme', () => {
	test.beforeEach(async ({ context }) => {
		await routeBaseMapArchive(context);
	});

	test('changes the Base Map flavor in the same action as the interface', async ({ page }) => {
		await openPane(page);

		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		const light = await backgroundColour(page);

		await themeToggle(page).click();

		// One action, one signal, both surfaces: a dark interface never frames a bright white map.
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await expect.poll(() => backgroundColour(page), { timeout: 30_000 }).not.toBe(light);
	});
});
