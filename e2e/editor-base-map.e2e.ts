import { expect, test } from './support/test.js';
import { type Page } from '@playwright/test';

import { unavailableNotice } from './support/base-map-notice.js';
import {
	baseMapTileDirectory,
	baseMapTileSourcePath,
	cachedBaseMapTiles,
	refuseBaseMapArchive,
	routeBaseMapArchive,
	routePartialBaseMapArchive
} from './support/editor-deployment';

// SPEC Seam 2: the running app in a real browser, with real MapLibre and real OPFS. There is
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
		/** Cached Base Map tiles the protocol handler answered **with bytes** (ticket 11). */
		ballastellaServedBaseMapTiles?: { z: number; x: number; y: number; bytes: number }[];
		/** Cached Base Map tiles requested and answered empty (ticket 11). */
		ballastellaMissedBaseMapTiles?: { z: number; x: number; y: number }[];
	}
}

/** The Project these tests open. Identity is the directory name (ADR-0008). */
const PROJECT_DIRECTORY = 'amsterdam-1625';
const PROJECT_FILE = 'project.json';

/**
 * **`/base-map/` is gone** (ticket 04). The Base Map pane a scholar meets is the Project screen, so
 * every test here now drives `/?p=<dir>` — the route a Base Map is actually chosen from. Rewired
 * rather than deleted: a route that no longer exists is not a licence to drop the behaviour it
 * covered, and everything below (Range requests, the catalog, the author's default, the refusals)
 * is behaviour of the pane and not of the page it used to sit on.
 */
const HUB = './';
/** A Project is addressed by query parameter, never by a per-Project path (ADR-0008). */
const paneUrl = (directory: string = PROJECT_DIRECTORY) => `${HUB}?p=${directory}`;

/** A Project's manifest as ticket 02 writes it, with anything the test needs overridden. */
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
	{ value: 'streets', text: 'Streets — needs network' },
	{ value: 'physical', text: 'Physical geography — needs network' },
	{ value: 'muted', text: 'Muted, high contrast — needs network' },
	{ value: 'streets-worldwide', text: 'Streets, worldwide — needs network' }
];

// By role, not by label: MapLibre gives the canvas the accessible name "Base Map" too, which is
// right for the pane and would make a name-only lookup ambiguous.
const switcher = (page: Page) => page.getByRole('combobox', { name: 'Base Map' });
const themeToggle = (page: Page) => page.getByRole('button', { name: /switch to .* theme/i });

async function waitForLoadedMap(page: Page): Promise<void> {
	await page.waitForFunction(() => window.ballastellaBaseMap?.loaded() === true, undefined, {
		timeout: 45_000
	});
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

	test('renders, and pans and zooms from the keyboard', async ({ page }) => {
		await openPane(page);

		const canvas = page.locator('canvas.maplibregl-canvas');
		await expect(canvas).toBeVisible();

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

	test('offers the deployment catalog through a native select, marking what needs network', async ({
		page
	}) => {
		await openPane(page);

		const select = switcher(page);
		await expect(select).toHaveJSProperty('tagName', 'SELECT');

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

		// Every control is reachable, in the order the bar puts them. **The Workspace switcher is the
		// first tab stop since ticket 12** — it was a label and is now a button — then the theme
		// toggle, then the Base Map switcher: ticket 04 moved the theme onto the app's navigation bar,
		// which is above the Project and therefore before it in the document. Choosing *within* a
		// focused `<select>` is the browser's own arrow-key handling — which is exactly why ADR-0016
		// mandates a native `<select>` here — and headless Chromium does not run its native popup, so
		// this asserts the reach and the element, and leaves the popup to the platform.
		await page.keyboard.press('Tab');
		await expect(page.getByTestId('workspace-switcher')).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(themeToggle(page)).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(switcher(page)).toBeFocused();

		// SPEC story 98: the muted entry has to be genuinely selectable, not merely listed.
		await switcher(page).selectOption('muted');
		await expect(switcher(page)).toHaveValue('muted');
		await expect.poll(() => styleLayerIds(page), { timeout: 30_000 }).toContain('water');
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// AN ARCHIVE THAT DOES NOT ANSWER, SAID OUT LOUD (ticket 20, SPEC stories 111–112)
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

		// Visible text and not a tooltip (SPEC story 111, ADR-0016: daisyUI renders tooltips through
		// CSS `::before`, so they are neither announced nor dismissable).
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
		// than the silence ticket 20 was written to end. `routePartialBaseMapArchive`'s header says
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

	test('is written to project.json as an id, with no URL anywhere in the file', async ({
		page
	}) => {
		await openPane(page);

		await switcher(page).selectOption('physical');

		await expect.poll(() => readProjectFile(page)).toContain('physical');
		const contents = await readProjectFile(page);
		expect(JSON.parse(contents ?? '{}').baseMap).toBe('physical');
		// ADR-0020: an id, never an address. A URL here is what makes a Project unportable, and the
		// failure mode is a plausible-looking *wrong* map rather than an error.
		expect(contents).not.toMatch(/https?:|pmtiles/);
	});

	test('is restored when the Project is reopened', async ({ page }) => {
		await openPane(page);
		await switcher(page).selectOption('muted');
		await expect.poll(() => readProjectFile(page)).toContain('muted');

		await page.reload();
		await waitForLoadedMap(page);

		await expect(switcher(page)).toHaveValue('muted');
	});

	test('falls back to the deployment default when the id is unrecognised, and says so', async ({
		page
	}) => {
		const crashes: Error[] = [];
		page.on('pageerror', (error) => crashes.push(error));

		await openPane(
			page,
			projectJson({ name: 'From another deployment', baseMap: 'ordnance-survey-1888' })
		);

		// A map, not a blank pane and not an error.
		await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
		await expect(switcher(page)).toHaveValue('streets');
		await expect.poll(() => styleLayerIds(page), { timeout: 30_000 }).toContain('water');

		// Quiet, and in an announced live region rather than a tooltip (ADR-0016). Addressed by test id
		// rather than by `role="status"`: the save indicator is the app's one `status` role since
		// ticket 04 put it on the navigation bar, so this region is `aria-live="polite"`.
		const notice = page.getByTestId('base-map-notice');
		await expect(notice).toContainText('ordnance-survey-1888');
		await expect(notice).toContainText('Streets');

		expect(crashes).toEqual([]);
	});

	test('leaves an unrecognised id in project.json, so moving the Project back restores it', async ({
		page
	}) => {
		// ADR-0020's portability claim, which is the whole reason `project.json` records an id and
		// not an address: this deployment cannot serve `ordnance-survey-1888`, so it shows its own
		// default — but the author's choice is *their* data and must survive being shown something
		// else. Overwriting it with the local default is one line away and would silently destroy
		// the author's intent the first time a Project were opened on the wrong deployment.
		await openPane(page, projectJson({ baseMap: 'ordnance-survey-1888' }));

		await expect(switcher(page)).toHaveValue('streets');
		expect(JSON.parse((await readProjectFile(page)) ?? '{}').baseMap).toBe('ordnance-survey-1888');

		// And it is still there after the pane has been open long enough to have written.
		await page.reload();
		await waitForLoadedMap(page);
		expect(JSON.parse((await readProjectFile(page)) ?? '{}').baseMap).toBe('ordnance-survey-1888');
	});

	test('stamps updatedAt, because one write path owns the whole document', async ({ page }) => {
		// The Base Map choice goes through the same `Workspace.writeProject` as every other
		// mutation, so it keeps the document's own bookkeeping. A second writer for this one field
		// wrote `baseMap` and nothing else: the hub's "last saved" then went stale, and a stale
		// in-memory document elsewhere in the app could serialise the choice straight back out.
		await openPane(page);

		await switcher(page).selectOption('physical');
		await expect.poll(() => readProjectFile(page)).toContain('physical');

		const written = JSON.parse((await readProjectFile(page)) ?? '{}');
		expect(written.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
		expect(Date.parse(written.updatedAt)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'));
		// And nothing else was lost on the way.
		expect(written.name).toBe('Amsterdam 1625');
		expect(written.formatVersion).toBe(1);
		expect(written.layers).toEqual([]);
	});

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
// Making a Project available offline (ADR-0025, ticket 11)
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
 * Named here because the cache directory is keyed on it (ticket 12) and a test that asserts on the
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
 * Every cached tile path in the Workspace, sorted. The behaviour *is* the files (SPEC, Seam 1).
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
			// Tiles only: the provenance record lives in the same keyed directory since ticket 12, and
			// counting it as a tile would make "23 tiles for a city centre" quietly 24.
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

/** Open the Project screen and wait for its map. Ticket 04 made `?p=` the screen itself. */
async function openProjectScreen(page: Page, directory: string = PROJECT_DIRECTORY): Promise<void> {
	await page.goto(paneUrl(directory));
	await waitForLoadedMap(page);
}

/** Fetch the tiles this Project's extent needs, through the dialog, exactly as a user would. */
async function makeAvailableOffline(page: Page): Promise<void> {
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
 * The epic's tracker names the tile counts and byte totals for a realistic Project extent as one of
 * two claims resting on documentation rather than measurement, and forbids a ticket committing to
 * them unverified. Ticket 11 measured them — and then wrote them into a comment, a ticket, and the
 * tracker, where nothing could tell if they went stale. `grep` for the figures found only prose.
 *
 * So they are asserted here instead, against the real fixture: the point is not that the number is
 * interesting, it is that the decision resting on it cannot be quietly undone. Three decisions rest on this table — the
 * 500-tile refusal threshold, the per-tile estimate, and the choice to store decompressed MVT — and
 * each is asserted against the measurement rather than beside it.
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

	test('shows a tile count and a byte estimate before fetching anything', async ({ page }) => {
		await openProjectScreen(page);

		const archiveTiles: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('.pmtiles')) archiveTiles.push(request.url());
		});

		await page.getByTestId('make-offline').click();
		await expect(page.getByTestId('offline-status')).toHaveAttribute('data-step', 'deciding');

		// The numbers, in visible text, before the button that spends them exists in an enabled state.
		const size = page.getByTestId('offline-budget-size');
		await expect(size).toContainText(/^\d+ tiles, about [0-9.]+ MB, /);
		await expect(size).toContainText('every zoom level from 0 to 14');
		await expect(page.getByTestId('offline-budget-present')).toContainText('Not available offline');

		// And nothing has been written. The plan is a plan.
		expect(await cachedTilePaths(page)).toEqual([]);
	});

	test('writes a tile file for every zoom from 0 to the source maximum', async ({ page }) => {
		await openProjectScreen(page);
		await makeAvailableOffline(page);

		const paths = await cachedTilePaths(page);
		expect(paths.length).toBe(23);
		// **Every** zoom, because omitting the low ones makes zooming out go blank (SPEC story 6).
		// The zoom is the segment after the archive key: `base-map/tiles/<key>/<z>/…`.
		const zooms = [...new Set(paths.map((path) => Number(path.split('/')[3])))].sort(
			(a, b) => a - b
		);
		expect(zooms).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
		expect(paths).toContain(`${TILES}0/0/0.mvt`);
		expect(paths).toContain(`${TILES}14/8414/5383.mvt`);

		await expect(page.getByTestId('offline-availability')).toHaveAttribute('data-offline', 'yes');
	});

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
		// hold tiles from two pyramids. Since ticket 12 they are in **different directories**, keyed by
		// archive — but a record inside this archive's own directory naming another archive can still
		// arrive by hand, and it is not evidence about this one. The screen goes back to saying it
		// cannot check rather than claiming a depth it has no warrant for.
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

	test('refuses an extent past the threshold with the numbers, and writes nothing', async ({
		page
	}) => {
		// A Project whose Annotations span most of a continent. The count is thousands, which is what
		// ADR-0007's courtesy is about: this fetches from somebody else's server.
		await seedProjectWithWork(page, [
			[-18, -35],
			[52, -35],
			[52, 38],
			[-18, 38],
			[-18, -35]
		]);
		await openProjectScreen(page);

		await page.getByTestId('make-offline').click();
		await expect(page.getByTestId('offline-status')).toHaveAttribute('data-step', 'deciding');

		const refusal = page.getByTestId('offline-refusal');
		await expect(refusal).toContainText('500 tiles');
		await expect(refusal).toContainText('Nothing has been fetched');
		await expect(page.getByTestId('offline-start')).toBeDisabled();

		expect(await cachedTilePaths(page)).toEqual([]);
	});

	test('reports a second Project in the same area as available offline without fetching', async ({
		page
	}) => {
		await openProjectScreen(page);
		await makeAvailableOffline(page);
		const after = await cachedTilePaths(page);

		// A second Project, a few streets inside the first one's extent.
		await page.evaluate(
			async ([json, geojson]) => {
				const root = await workspaceRoot();
				const project = await root.getDirectoryHandle('boston-1775', { create: true });
				const handle = await project.getFileHandle('project.json', { create: true });
				let writable = await handle.createWritable();
				await writable.write(json);
				await writable.close();
				const folder = await project.getDirectoryHandle('annotations', { create: true });
				const notes = await folder.getFileHandle('notes.geojson', { create: true });
				writable = await notes.createWritable();
				await writable.write(geojson);
				await writable.close();
			},
			[
				projectWithWork().project,
				JSON.stringify({
					type: 'FeatureCollection',
					features: [
						{
							type: 'Feature',
							id: 'b1',
							properties: { 'ballastella:id': 'b1' },
							geometry: {
								type: 'Polygon',
								coordinates: [
									[
										[4.885, 52.365],
										[4.9, 52.365],
										[4.9, 52.375],
										[4.885, 52.375],
										[4.885, 52.365]
									]
								]
							}
						}
					]
				})
			] as const
		);

		await openProjectScreen(page, 'boston-1775');

		await expect(page.getByTestId('offline-availability')).toHaveAttribute('data-offline', 'yes');
		// The cache is Workspace-level, so the second Project cost nothing at all (ADR-0023).
		expect(await cachedTilePaths(page)).toEqual(after);
	});

	test('reports a Project whose extent has grown beyond the cache as not available offline', async ({
		page
	}) => {
		await openProjectScreen(page);
		await makeAvailableOffline(page);
		await expect(page.getByTestId('offline-availability')).toHaveAttribute('data-offline', 'yes');

		// The scholar's work spreads east, past what was cached.
		await seedProjectWithWork(page, [
			[4.88, 52.36],
			[5.05, 52.36],
			[5.05, 52.38],
			[4.88, 52.38],
			[4.88, 52.36]
		]);
		await page.reload();
		await waitForLoadedMap(page);

		await expect(page.getByTestId('offline-availability')).toHaveAttribute('data-offline', 'no');
		await expect(page.getByTestId('offline-availability')).toContainText('Not available offline');
	});

	test('fetches only the tiles not already present when it is run again', async ({ page }) => {
		await openProjectScreen(page);
		await makeAvailableOffline(page);
		const first = await cachedTilePaths(page);
		expect(first.length).toBe(23);

		await page.getByTestId('make-offline').click();
		await expect(page.getByTestId('offline-status')).toHaveAttribute('data-step', 'deciding');
		// Nothing left to fetch, said in the button and in the sentence beside it.
		await expect(page.getByTestId('offline-start')).toContainText('Fetch 0 tiles');
		await expect(page.getByTestId('offline-start')).toBeDisabled();
		await expect(page.getByTestId('offline-budget-present')).toContainText('Available offline');

		expect(await cachedTilePaths(page)).toEqual(first);
	});

	test('is cleared from the hub, and the Projects then report themselves not available offline', async ({
		page
	}) => {
		await openProjectScreen(page);
		await makeAvailableOffline(page);

		await page.goto(HUB);
		const summary = page.getByTestId('base-map-cache');
		await expect(summary).toContainText('23 tiles');
		await expect(summary).toContainText(/[0-9.]+ MB/);

		await page.getByTestId('clear-base-map-cache').click();
		await page.getByRole('button', { name: 'Remove the offline Base Map' }).last().click();
		await expect(page.getByTestId('base-map-cache-status')).toContainText('Removed 23');

		expect(await cachedTilePaths(page)).toEqual([]);

		await openProjectScreen(page);
		await expect(page.getByTestId('offline-availability')).toHaveAttribute('data-offline', 'no');
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
