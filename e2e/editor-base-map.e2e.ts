import { expect, test, type Page } from '@playwright/test';

import { routeBaseMapArchive } from './support/editor-deployment';

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
	getStyle(): { layers: { id: string; paint?: Record<string, unknown> }[] };
	queryRenderedFeatures(): { layer: { id: string } }[];
};

declare global {
	interface Window {
		ballastellaBaseMap?: BaseMapHandle;
	}
}

/** The Project these tests open. Identity is the directory name (ADR-0008). */
const PROJECT_DIRECTORY = 'amsterdam-1625';
const PROJECT_FILE = 'project.json';

const BASE_MAP_PAGE = './base-map/';
/** A Project is addressed by query parameter, never by a per-Project path (ADR-0008). */
const paneUrl = (directory: string = PROJECT_DIRECTORY) => `${BASE_MAP_PAGE}?p=${directory}`;

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
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
	});
}

/** Write a `project.json` straight into OPFS, bypassing the app entirely. */
async function seedProject(page: Page, contents: string): Promise<void> {
	await page.evaluate(
		async ([directory, file, json]) => {
			const root = await navigator.storage.getDirectory();
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
 * never create a Project. `/base-map/` with no `?p=` used to call
 * `getDirectoryHandle(…, { create: true })` and manufacture a phantom Project in the real
 * Workspace, which the hub then listed.
 */
async function openPane(page: Page, contents: string = projectJson()): Promise<void> {
	await page.goto(BASE_MAP_PAGE);
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
				const root = await navigator.storage.getDirectory();
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
		const root = await navigator.storage.getDirectory();
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

		// Every control is reachable: the switcher is the first tab stop, then the theme toggle, then
		// the map canvas and its zoom controls. Choosing *within* a focused `<select>` is the
		// browser's own arrow-key handling — which is exactly why ADR-0016 mandates a native
		// `<select>` here — and headless Chromium does not run its native popup, so this asserts the
		// reach and the element, and leaves the popup to the platform.
		await page.keyboard.press('Tab');
		await expect(switcher(page)).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(themeToggle(page)).toBeFocused();

		// SPEC story 98: the muted entry has to be genuinely selectable, not merely listed.
		await switcher(page).selectOption('muted');
		await expect(switcher(page)).toHaveValue('muted');
		await expect.poll(() => styleLayerIds(page), { timeout: 30_000 }).toContain('water');
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

		// Quiet, and in an announced live region rather than a tooltip (ADR-0016).
		const notice = page.getByRole('status').filter({ hasText: 'ordnance-survey-1888' });
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
		// Opening a pane must never create a Project. `/base-map/` with no `?p=` used to call
		// `getDirectoryHandle('demo-project', { create: true })` and manufacture a phantom Project
		// in the real Workspace, which the hub then listed as the user's own work.
		await page.goto(BASE_MAP_PAGE);
		await emptyWorkspace(page);
		await page.goto(BASE_MAP_PAGE);

		await expect(page.getByRole('link', { name: 'Back to all Projects' })).toBeVisible();
		expect(await workspaceEntries(page)).toEqual([]);

		// And the hub agrees: there is nothing to list.
		await page.goto('./');
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
		await expect(page.getByRole('listitem')).toHaveCount(0);
		expect(await workspaceEntries(page)).toEqual([]);
	});

	test('refuses a project.json it cannot read, and does not replace it', async ({ page }) => {
		// A trailing comma — a Dropbox conflict, a hand edit, a half-finished sync. The pane used to
		// swallow the parse failure, read it as "no Base Map chosen", and then write a whole fresh
		// document over it: `name`, `updatedAt`, and `layers` gone, in the one action that was
		// supposed to record a single field.
		const damaged = '{"formatVersion":1,"name":"Amsterdam 1625","layers":[],"baseMap":null,}';
		await page.goto(BASE_MAP_PAGE);
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
		await page.goto(BASE_MAP_PAGE);
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
		await page.goto(BASE_MAP_PAGE);
		await emptyWorkspace(page);

		await page.goto(paneUrl('never-existed'));

		await expect(page.getByRole('alert')).toContainText('never-existed');
		expect(await workspaceEntries(page)).toEqual([]);
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
