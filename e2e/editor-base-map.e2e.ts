import { expect, test, type Page } from '@playwright/test';

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

/** Ticket 02 owns Project creation; until then the pane opens this well-known directory. */
const PROJECT_DIRECTORY = 'demo-project';
const PROJECT_FILE = 'project.json';

const BASE_MAP_PAGE = './base-map/';

/** The deployment catalog, as an author reads it in the switcher. */
const CATALOG_OPTIONS = [
	{ value: 'streets', text: 'Streets' },
	{ value: 'physical', text: 'Physical geography' },
	{ value: 'muted', text: 'Muted, high contrast' },
	{ value: 'streets-worldwide', text: 'Streets, worldwide — needs network' }
];

// By role, not by label: MapLibre gives the canvas the accessible name "Base Map" too, which is
// right for the pane and would make a name-only lookup ambiguous.
const switcher = (page: Page) => page.getByRole('combobox', { name: 'Base Map' });
const themeToggle = (page: Page) => page.getByRole('button', { name: /switch to .* theme/i });

async function openPane(page: Page): Promise<void> {
	await page.goto(BASE_MAP_PAGE);
	await waitForLoadedMap(page);
}

async function waitForLoadedMap(page: Page): Promise<void> {
	await page.waitForFunction(() => window.ballastellaBaseMap?.loaded() === true, undefined, {
		timeout: 45_000
	});
}

/** Write a `project.json` before the app reads it, then reopen the pane onto it. */
async function seedProject(page: Page, document: Record<string, unknown>): Promise<void> {
	await page.goto(BASE_MAP_PAGE);
	await page.evaluate(
		async ([directory, file, contents]) => {
			const root = await navigator.storage.getDirectory();
			const project = await root.getDirectoryHandle(directory, { create: true });
			const handle = await project.getFileHandle(file, { create: true });
			const writable = await handle.createWritable();
			await writable.write(contents);
			await writable.close();
		},
		[PROJECT_DIRECTORY, PROJECT_FILE, JSON.stringify(document)] as const
	);
	await page.reload();
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

		await seedProject(page, {
			formatVersion: 1,
			name: 'From another deployment',
			layers: [],
			baseMap: 'ordnance-survey-1888'
		});

		// A map, not a blank pane and not an error.
		await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
		await expect(switcher(page)).toHaveValue('streets');
		await expect.poll(() => styleLayerIds(page), { timeout: 30_000 }).toContain('water');

		// Quiet, and in an announced live region rather than a tooltip (ADR-0016).
		const notice = page.getByRole('status');
		await expect(notice).toContainText('ordnance-survey-1888');
		await expect(notice).toContainText('Streets');

		expect(crashes).toEqual([]);
	});
});

test.describe('the theme', () => {
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
