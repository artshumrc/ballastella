import { expect, test, type Page } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	PROJECT_DIRECTORY,
	PROJECT_NAME,
	baseMap,
	clickAt,
	emptyWorkspace,
	gradientPng,
	historicalMap,
	makePair,
	makePairs,
	rows,
	start,
	storedAlignment,
	storedProjectFile,
	waitForStored,
	watchWrites,
	writes
} from './support/alignment-workspace';

/**
 * Ticket 03: aligning is a route of its own.
 *
 * The pairing, mask, undo and distortion behaviour the route carries is asserted where it already was
 * — `editor-alignment.e2e.ts`, `editor-alignment-refinement.e2e.ts` and `editor-undo.e2e.ts` all now
 * reach the workspace by navigating, and that they pass unchanged is the signal that the move
 * preserved behaviour. What is here is only what is *new*: the URL, the states it can be opened in,
 * the disclosure, the way back, and the keyboard.
 */

const backLink = (page: Page) => page.getByTestId('back-to-project');
const checkToggle = (page: Page) => page.getByTestId('check-alignment-toggle');
const distortionControls = (page: Page) => page.getByTestId('distortion-controls');
const foldWarning = (page: Page) => page.getByTestId('fold-warning');

/** A Project with one Historical Map, on the Project page, not yet aligned. */
async function projectWithMap(page: Page): Promise<void> {
	await page.goto('/');
	await emptyWorkspace(page);
	await page.reload();
	await page.getByRole('button', { name: 'New Project' }).click();
	const dialog = page.getByRole('dialog', { name: 'New Project' });
	await dialog.getByLabel('Project name').fill(PROJECT_NAME);
	await dialog.getByRole('button', { name: 'Create' }).click();
	await page.getByRole('link', { name: PROJECT_NAME }).click();
	await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();
	await page.getByLabel('Add a Historical Map from a file').setInputFiles({
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(700, 500)
	});
	await expect(page.getByTestId('layer-row')).toHaveCount(1, { timeout: 30_000 });
}

/** The `?layer=` of the alignment route the page is currently on. */
const layerParam = (page: Page): string => new URL(page.url()).searchParams.get('layer') ?? '';

test.describe('the alignment route', () => {
	test('opens from the Project at ?p= and ?layer=, and pairs by click-then-click', async ({
		page
	}) => {
		test.setTimeout(90_000);
		await projectWithMap(page);

		// Nothing has been aligned, and the Layer is nonetheless already there: adding the Historical Map
		// is what put it in the stack (ADR-0023). So Align is a plain link whose `href` was knowable
		// before the click, which is what the URL assertions below are really measuring.
		await expect(page.getByTestId('align-historical-map')).toHaveRole('link');
		await page.getByTestId('align-historical-map').click();
		await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);

		const url = new URL(page.url());
		expect(url.pathname.replace(/\/$/, '')).toMatch(/\/align$/);
		expect(url.searchParams.get('p')).toBe(PROJECT_DIRECTORY);
		const layerId = url.searchParams.get('layer');
		expect(layerId, 'the route is keyed by Layer id').toBeTruthy();

		// **The id in the URL is a Layer's and not the image's**, which is the contract. Read out of the
		// document rather than inferred: an image id in `?layer=` would satisfy "there is a query
		// parameter" and nothing else.
		const stored = await page.evaluate(async (directory) => {
			const root = await navigator.storage.getDirectory();
			const project = await root.getDirectoryHandle(directory);
			const handle = await project.getFileHandle('project.json');
			return JSON.parse(await (await handle.getFile()).text()) as {
				layers: { id: string; kind: string; imageId: string }[];
			};
		}, PROJECT_DIRECTORY);
		expect(stored.layers).toHaveLength(1);
		expect(stored.layers[0]?.id).toBe(layerId);
		expect(stored.layers[0]?.kind).toBe('map');
		expect(stored.layers[0]?.imageId).not.toBe(layerId);

		// Both panes, side by side, and a Control Point placed across them.
		await expect(historicalMap(page)).toBeVisible();
		await expect(baseMap(page)).toBeVisible();
		await expect(page.getByTestId('historical-map-tiles')).toHaveAttribute(
			'data-tiles-loaded',
			'true',
			{ timeout: 30_000 }
		);
		await makePair(page, [0.3, 0.3]);
		await expect(rows(page)).toHaveCount(1);
	});

	/**
	 * ADR-0008: the route is prerendered and picks its subject client-side.
	 *
	 * Read off the build the suite is actually served from, because the claim is about what is
	 * deployed. A SPA fallback would make every state below reachable by accident — the router would
	 * answer any path — and it is the thing ADR-0008 rules out by name.
	 */
	test('is prerendered, with no SPA fallback in the build', async () => {
		const build = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			'../apps/editor/build'
		);
		const prerendered = path.join(build, 'align.html');
		expect(statSync(prerendered).isFile(), 'align.html was not prerendered').toBe(true);
		// Prerendered, not a shell: the route's own copy in the HTML says what the page is.
		expect(readFileSync(prerendered, 'utf8')).toContain('Align — Ballastella Editor');

		// `adapter-static`'s SPA fallback is a file at the build root named by the `fallback` option —
		// `200.html`, `404.html` and `index.html` are the spellings in circulation. `index.html` is the
		// prerendered `/`, so it is judged by its content rather than by its name: the hub's own heading
		// is in it, and a fallback shell has no route's copy in it at all.
		const names = readdirSync(build);
		for (const name of ['200.html', '404.html']) {
			expect(names, `${name} is an SPA fallback`).not.toContain(name);
		}
		expect(readFileSync(path.join(build, 'index.html'), 'utf8')).toContain('Ballastella Editor');
	});

	test('names every state it can be opened in, with a way back', async ({ page }) => {
		const thrown: string[] = [];
		page.on('pageerror', (error) => thrown.push(`${error.name}: ${error.message}`));

		await projectWithMap(page);
		await page.getByTestId('align-historical-map').click();
		await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);
		const layerId = layerParam(page);
		expect(layerId).not.toBe('');

		// 1. No `?p=` at all.
		await page.goto('/align');
		await expect(page.getByTestId('no-layer')).toHaveCount(0);
		await expect(page.getByRole('heading', { name: 'No Project chosen' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Back to all Projects' })).toBeVisible();

		// 2. A Project that is not there.
		await page.goto(`/align?p=never-existed&layer=${layerId}`);
		await expect(page.getByRole('heading', { name: 'Project not found' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Back to all Projects' })).toBeVisible();

		// 3. A Project directory that exists and cannot be opened. `project.json` is unparseable, which
		//    is a different state from missing and must not read as one.
		await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const project = await root.getDirectoryHandle('broken', { create: true });
			const handle = await project.getFileHandle('project.json', { create: true });
			const writable = await handle.createWritable();
			await writable.write('{ not a project');
			await writable.close();
		});
		await page.goto(`/align?p=broken&layer=${layerId}`);
		await expect(
			page.getByRole('heading', { name: 'This Project cannot be opened' })
		).toBeVisible();
		await expect(page.getByRole('link', { name: 'Back to all Projects' })).toBeVisible();

		// 4. A `layer` this Project has no Historical Map Layer for — the state ticket 03 adds, and the
		//    one that used to be an empty split screen.
		await page.goto(`/align?p=${PROJECT_DIRECTORY}&layer=not-a-layer-in-this-project`);
		await expect(page.getByTestId('layer-missing')).toBeVisible();
		await expect(page.getByTestId('layer-missing')).toContainText('not-a-layer-in-this-project');
		// Neither pane is on the page: this is a named state and not a workspace with nothing in it.
		await expect(historicalMap(page)).toHaveCount(0);
		await expect(baseMap(page)).toHaveCount(0);
		await backLink(page).click();
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();

		// 5. No `?layer=`, with a perfectly good Project.
		await page.goto(`/align?p=${PROJECT_DIRECTORY}`);
		await expect(page.getByTestId('no-layer')).toBeVisible();
		await expect(historicalMap(page)).toHaveCount(0);
		await backLink(page).click();
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();

		expect(thrown, 'a bad address must not throw').toEqual([]);
	});

	/**
	 * The three states the contract requires that no `?p=` or `?layer=` can produce.
	 *
	 * "Every state the layers route handles, this route handles" is the contract, and the three below
	 * are the ones that come from the *Workspace* rather than from the address — so the test above,
	 * which drives the address, cannot reach any of them. They shipped implemented and unasserted,
	 * which for two of them means the markup was never once rendered by anything.
	 */
	test('names the three states the Workspace itself can be in', async ({ page }) => {
		const thrown: string[] = [];
		page.on('pageerror', (error) => thrown.push(`${error.name}: ${error.message}`));

		// 1. **No storage at all** — the page served over plain http, where `navigator.storage` has no
		//    `getDirectory`. Removed before any of the app's scripts run, because the answer is read
		//    once by the root layout's effect and never asked again.
		await page.addInitScript(() => {
			Object.defineProperty(navigator.storage, 'getDirectory', {
				configurable: true,
				value: undefined
			});
		});
		await page.goto(`/align?p=${PROJECT_DIRECTORY}&layer=anything`);
		await expect(page.getByRole('heading', { name: 'No storage for a Workspace' })).toBeVisible();
		await expect(page.getByText('not offering storage for a Workspace')).toBeVisible();
		await expect(page.getByRole('link', { name: 'Back to all Projects' })).toBeVisible();
		// Not a blank split screen behind the message.
		await expect(historicalMap(page)).toHaveCount(0);

		// 2. **A Workspace that cannot be reached** — the folder moved, renamed, or deleted. `storage`
		//    exists and `getDirectory` is a function, so this is not state 1; it is the read failing.
		//    `WorkspaceRecovery` is what must appear, with its way out, rather than "Opening…" for ever.
		const recovering = await page.context().newPage();
		recovering.on('pageerror', (error) => thrown.push(`${error.name}: ${error.message}`));
		await recovering.addInitScript(() => {
			Object.defineProperty(navigator.storage, 'getDirectory', {
				configurable: true,
				value: () => Promise.reject(new DOMException('No such folder', 'NotFoundError'))
			});
		});
		await recovering.goto(`/align?p=${PROJECT_DIRECTORY}&layer=anything`);
		await expect(
			recovering.getByRole('heading', { name: 'Workspace not reachable' })
		).toBeVisible();
		await expect(recovering.getByRole('button', { name: /Locate Workspace/ })).toBeVisible();
		await expect(recovering.getByRole('link', { name: 'Back to all Projects' })).toBeVisible();
		await expect(recovering.getByTestId('image-pane')).toHaveCount(0);
		await recovering.close();

		expect(thrown, 'a Workspace that is not there must not throw').toEqual([]);
	});

	/**
	 * 3. **"Starting…"**, which is the state the route is in before its own JavaScript has run.
	 *
	 * Asserted against the **prerendered file** rather than in a browser, because that is the only
	 * place it lasts: `WorkspaceHost.begin()` constructs the storage synchronously, so in a live page
	 * the state is gone in the same tick it appears. What a reader on a slow connection is served is
	 * this file, and the criterion is that it says something rather than being blank — an empty
	 * `<div>` that fills in later is exactly what ADR-0008's client-side subject selection risks.
	 */
	test('says it is starting in the file it is served as', async () => {
		const build = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			'../apps/editor/build'
		);
		const served = readFileSync(path.join(build, 'align.html'), 'utf8');
		expect(served).toContain('Starting…');
		expect(served).toContain('Back to all Projects');
	});

	/**
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * OPENING THE ALIGNMENT VIEW IS NOT A WRITE
	 *
	 * ADR-0010: merely looking at a Project must not modify a byte of it. ADR-0023 makes that sharper
	 * than it sounds, because `alignments/<id>.json` belongs to the **Workspace** and is shared by
	 * every Project that draws the map, published sites included — so a route that wrote one on the
	 * way in would make opening a view a sync event in a git or Dropbox Workspace, and would push any
	 * field of a third-party Alignment document that `Alignment` does not model through
	 * `serialiseAlignment` and out of existence (SPEC story 60).
	 *
	 * A draft of this route did exactly that: the Align control resolved its Layer by routing
	 * `readAlignment` into `writeAlignment`. **Counted rather than compared**, because byte-identity
	 * cannot tell "no write" from "a rewrite of the same content", and it is the write itself that is
	 * the defect here.
	 *
	 * It also carries SPEC story 36 — one Layer per Historical Map per Project — against the gesture
	 * ticket 03 adds, which is the one gesture that could newly break it: `project.json` byte-identical
	 * across a round trip through the route says no Layer was created, renamed, or reordered by it.
	 */
	test('opening it writes no Alignment and adds no Layer', async ({ page }) => {
		test.setTimeout(120_000);
		await projectWithMap(page);
		await expect(page.getByRole('status')).toHaveText('Saved');

		// The starter Alignment and the Layer are both already on disk — adding the map wrote them
		// (ADR-0023). Everything after this point must leave them exactly as they are.
		const before = await storedProjectFile(page);
		expect(before).not.toBeNull();
		const imageId = JSON.parse(before as string).layers[0].imageId;
		expect(JSON.parse(before as string).layers).toHaveLength(1);
		const alignmentBefore = await storedAlignment(page, imageId);
		expect(alignmentBefore).not.toBeNull();

		/*
		 * **Armed once per document, and that is not a detail.** `recordAlignmentWrite` pushes into
		 * `window.ballastellaAlignmentWrites` only when the array is there, and a reload throws the
		 * array away — so a counter armed before a reload counts nothing after it, silently, and every
		 * assertion downstream of the reload passes by construction. The route is arrived at both ways
		 * here, so it is armed and read twice rather than once across the pair.
		 *
		 * A fixed wait before each read, because what is asserted is a write that must **not** happen
		 * and there is no event for one of those. `writeAlignment` records *after* its commit resolves,
		 * so reading the moment the pane draws is reading ahead of a write that is on its way.
		 */
		const noWritesAfter = async (settleMs = 2000): Promise<void> => {
			await page.waitForTimeout(settleMs);
			expect(await writes(page), 'opening the alignment view wrote an Alignment').toEqual([]);
		};

		// 1. In by the link, all the way to both panes drawn.
		await watchWrites(page);
		await page.getByTestId('align-historical-map').click();
		await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);
		await expect(page.getByTestId('historical-map-tiles')).toHaveAttribute(
			'data-tiles-loaded',
			'true',
			{ timeout: 30_000 }
		);
		await expect(baseMap(page)).toBeVisible();
		await noWritesAfter();

		// 2. And in by a reload, which is the other way a scholar arrives — a bookmark — and the one
		//    that runs the whole route from nothing rather than from a client-side navigation.
		await page.reload();
		await watchWrites(page);
		await expect(page.getByTestId('historical-map-tiles')).toHaveAttribute(
			'data-tiles-loaded',
			'true',
			{ timeout: 30_000 }
		);
		await expect(baseMap(page)).toBeVisible();
		await noWritesAfter();

		await backLink(page).click();
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();
		await page.waitForTimeout(1000);

		// The bytes agree with the counter, on both documents. `project.json` is SPEC story 36 against
		// the gesture ticket 03 adds: no Layer created, renamed, or reordered by a trip through the
		// route.
		expect(await storedAlignment(page, imageId)).toBe(alignmentBefore);
		expect(await storedProjectFile(page)).toBe(before);
	});

	test('keeps a Control Point across a trip back to the Project and in again', async ({ page }) => {
		test.setTimeout(120_000);
		const imageId = await start(page);
		await makePair(page, [0.35, 0.4]);
		await waitForStored(page, imageId, 1);
		const written = await storedAlignment(page, imageId);

		await backLink(page).click();
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();
		await expect(historicalMap(page)).toHaveCount(0);

		await page.getByTestId('align-historical-map').click();
		await expect(page.getByTestId('historical-map-tiles')).toHaveAttribute(
			'data-tiles-loaded',
			'true',
			{ timeout: 30_000 }
		);
		await expect(rows(page)).toHaveCount(1);
		// The same pair, not merely one pair: the coordinates are what the file holds.
		expect(await storedAlignment(page, imageId)).toBe(written);
	});

	/**
	 * The Base Map opens on the Alignment's own Control Points.
	 *
	 * Asserted against MapLibre's centre rather than against a screenshot, and against the *deployment
	 * default* rather than an absolute coordinate: what the catalog's initial view is belongs to a
	 * fork (ADR-0020), and a test naming a longitude would be one more thing a fork had to change.
	 */
	test('opens the Base Map on the Control Points there already are', async ({ page }) => {
		test.setTimeout(120_000);
		const imageId = await start(page);
		const opened = await baseMapCentre(page);

		// Placed well away from the middle of the pane, so "it fitted to the points" and "it did not
		// move" are different answers.
		await makePair(page, [0.3, 0.3], [0.18, 0.2]);
		await makePair(page, [0.6, 0.35], [0.24, 0.24]);
		await waitForStored(page, imageId, 2);
		const placed = await baseMapCentre(page);

		// Placing points does not move the map — the fit is on opening and nothing else, or a drag would
		// pull the earth out from under the pointer.
		expect(placed).toEqual(opened);

		await backLink(page).click();
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();
		await page.getByTestId('align-historical-map').click();
		await expect(rows(page)).toHaveCount(2);

		// Reopened, the view is on the pairs rather than on the deployment default.
		await expect
			.poll(async () => {
				const now = await baseMapCentre(page);
				return Math.hypot(now.lng - placed.lng, now.lat - placed.lat) > 1e-6;
			})
			.toBe(true);
		const fitted = await baseMapCentre(page);
		const points = await controlPointGeo(page);
		const west = Math.min(...points.map((point) => point.lng));
		const east = Math.max(...points.map((point) => point.lng));
		const south = Math.min(...points.map((point) => point.lat));
		const north = Math.max(...points.map((point) => point.lat));
		// Inside the box the Control Points make, with a pane's worth of slack in each direction: the
		// claim is "it is looking at the pairs", not a pixel-exact camera.
		expect(fitted.lng).toBeGreaterThan(west - (east - west) - 1);
		expect(fitted.lng).toBeLessThan(east + (east - west) + 1);
		expect(fitted.lat).toBeGreaterThan(south - (north - south) - 1);
		expect(fitted.lat).toBeLessThan(north + (north - south) + 1);
	});
});

/** Where the Base Map is looking, asked of MapLibre itself. */
const baseMapCentre = (page: Page): Promise<{ lng: number; lat: number }> =>
	page.evaluate(() => {
		const map = (window as { ballastellaBaseMap?: { getCenter(): { lng: number; lat: number } } })
			.ballastellaBaseMap;
		if (!map) throw new Error('there is no Base Map on the page');
		const centre = map.getCenter();
		return { lng: centre.lng, lat: centre.lat };
	});

/** The earth half of every Control Point drawn on the Base Map, out of the overlay's own dataset. */
const controlPointGeo = async (page: Page): Promise<{ lng: number; lat: number }[]> => {
	const points = baseMap(page).locator('[data-testid="pane-overlay-point-control-point"]');
	const raw = await points.evaluateAll((elements) =>
		elements.map((element) => ({
			lng: Number(element.getAttribute('data-lng')),
			lat: Number(element.getAttribute('data-lat'))
		}))
	);
	expect(raw.length, 'no Control Point is drawn on the Base Map').toBeGreaterThan(0);
	return raw;
};

test.describe('“Check this alignment”', () => {
	test('keeps the overlay, the measure and the grid out of the accessibility tree until opened', async ({
		page
	}) => {
		test.setTimeout(120_000);
		await start(page);
		await makePairs(page, 4);
		await expect(page.getByTestId('warped-status')).toHaveAttribute('data-warped-status', 'drawn');

		// Closed by default, and everything behind it is *absent* rather than hidden. Asked of the
		// accessibility tree by role and name, which is the criterion — a `getByTestId` count would go
		// green on a control that was merely missing its testid.
		await expect(checkToggle(page)).toHaveAttribute('aria-expanded', 'false');
		const overlay = page.getByRole('checkbox', {
			name: 'Colour the Historical Map by how much it is stretched'
		});
		const grid = page.getByRole('checkbox', { name: 'Draw a grid, bent by the Alignment' });
		const measure = page.getByRole('combobox', { name: 'What the colours show' });
		await expect(overlay).toHaveCount(0);
		await expect(grid).toHaveCount(0);
		await expect(measure).toHaveCount(0);
		await expect(distortionControls(page)).toHaveCount(0);

		// Opened, all three are reachable by name.
		await checkToggle(page).click();
		await expect(checkToggle(page)).toHaveAttribute('aria-expanded', 'true');
		await expect(overlay).toBeVisible();
		await expect(grid).toBeVisible();
		// The measure picker appears with the overlay, because a measure picker beside an overlay that
		// is off is a control with no effect.
		await expect(measure).toHaveCount(0);
		await overlay.check();
		await expect(measure).toBeVisible();

		// Closed again, and the colouring goes with it — otherwise the map stays coloured with no
		// control on the page that could turn it off.
		await checkToggle(page).click();
		await expect(overlay).toHaveCount(0);
		await expect(measure).toHaveCount(0);
		await checkToggle(page).click();
		await expect(overlay).not.toBeChecked();
		await expect(measure).toHaveCount(0);
	});

	test('does not reopen after a reload, and is not in project.json', async ({ page }) => {
		test.setTimeout(120_000);
		await start(page);
		await makePairs(page, 4);
		await expect(page.getByTestId('warped-status')).toHaveAttribute('data-warped-status', 'drawn');

		await checkToggle(page).click();
		await page.getByTestId('distortion-toggle').check();
		await page.getByTestId('grid-toggle').check();
		await expect(checkToggle(page)).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByRole('status')).toHaveText('Saved');

		const stored = await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const project = await root.getDirectoryHandle('amsterdam-1625');
			const handle = await project.getFileHandle('project.json');
			return await (await handle.getFile()).text();
		});
		expect(stored).not.toContain('log2sigma');
		expect(stored).not.toContain('renderGrid');
		expect(stored).not.toContain('checking');

		await page.reload();
		await expect(page.getByRole('heading', { name: 'Align', exact: true })).toBeVisible();
		await expect(checkToggle(page)).toHaveAttribute('aria-expanded', 'false');
		await expect(distortionControls(page)).toHaveCount(0);
	});

	test('does not hide the fold warning', async ({ page }) => {
		test.setTimeout(120_000);
		await start(page);
		// Two swapped pairs and a third: the "I mixed up two Control Points" mistake, which under the
		// default affine transformation reads as a mirrored Alignment.
		await makePair(page, [0.25, 0.3], [0.75, 0.3]);
		await makePair(page, [0.75, 0.3], [0.25, 0.3]);
		await makePair(page, [0.5, 0.75], [0.5, 0.75]);

		// With the disclosure closed and never opened: the fold check is a correctness warning about a
		// contradictory Control Point, not a way of drawing one.
		await expect(checkToggle(page)).toHaveAttribute('aria-expanded', 'false');
		await expect(distortionControls(page)).toHaveCount(0);
		await expect(foldWarning(page)).toBeVisible();
		await expect(foldWarning(page)).toHaveAttribute('data-fold-kind', 'mirrored');
		await expect(foldWarning(page)).toHaveAttribute('role', 'alert');
	});
});

test.describe('the route from the keyboard', () => {
	/**
	 * SPEC story 111 and ticket 03's last criterion: every control is reachable by Tab, and the way
	 * back is among them.
	 *
	 * Walked rather than asserted one control at a time, because "reachable" is a property of the tab
	 * order and not of any single element — a control with `tabindex="-1"`, or one inside a container
	 * the browser skips, is exactly what a per-element `focus()` would miss.
	 */
	test('reaches every control by Tab, including the way back', async ({ page }) => {
		test.setTimeout(120_000);
		await start(page);
		await makePairs(page, 3);
		await expect(page.getByTestId('warped-status')).toHaveAttribute('data-warped-status', 'drawn');
		// Opened, so the disclosure's own controls are in the walk too.
		await checkToggle(page).click();
		await expect(distortionControls(page)).toBeVisible();

		// Every visible focusable control the route renders, stamped so the walk below can name the ones
		// it never reached. Identity rather than a count: two controls whose accessible names happen to
		// match would otherwise let one of them be unreachable and the total still add up.
		const wanted = await page.evaluate(() => {
			const focusable = [
				...document.querySelectorAll<HTMLElement>(
					'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
				)
			].filter((element) =>
				element.checkVisibility({ visibilityProperty: true, opacityProperty: true })
			);
			focusable.forEach((element, index) => element.setAttribute('data-tab-probe', String(index)));
			return focusable.map((element, index) => ({
				probe: String(index),
				what: `${element.tagName}[${element.getAttribute('data-testid') ?? ''}] ${
					element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? ''
				}`
			}));
		});
		expect(wanted.length, 'there is nothing on this page to walk').toBeGreaterThan(10);
		const backProbe = await backLink(page).getAttribute('data-tab-probe');
		expect(backProbe, 'the way back is not focusable at all').not.toBeNull();

		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		const seen = new Set<string>();

		// Bounded, so a focus trap fails as a failure rather than as a hang.
		for (let step = 0; step < wanted.length * 3 && seen.size < wanted.length; step += 1) {
			await page.keyboard.press('Tab');
			const probe = await page.evaluate(
				() => (document.activeElement as HTMLElement | null)?.getAttribute('data-tab-probe') ?? null
			);
			if (probe !== null) seen.add(probe);
		}

		const unreached = wanted.filter((one) => !seen.has(one.probe)).map((one) => one.what);
		expect(unreached, 'these controls cannot be reached by Tab').toEqual([]);
		expect(seen.has(backProbe as string), 'the way back is not reachable by Tab').toBe(true);

		// And it works when it is reached: activating it by keyboard lands on the Project.
		await backLink(page).focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();
		expect(new URL(page.url()).searchParams.get('p')).toBe(PROJECT_DIRECTORY);
	});

	/** SPEC story 112: what this screen does, in text, before either canvas. */
	test('says what the two panes are for, as text rather than as a tooltip', async ({ page }) => {
		await start(page);
		const explainer = page.getByTestId('align-explainer');
		await expect(explainer).toBeVisible();
		await expect(explainer).toContainText('Click a feature on the Historical Map');
		await expect(explainer).not.toHaveAttribute('title', /.+/);

		// The transformation guidance is text in the accessibility tree, bound to the control by
		// `aria-describedby` — never a `title` and never CSS-generated (ADR-0016).
		const guidance = page.getByTestId('transformation-guidance');
		await expect(guidance).toBeVisible();
		await expect(guidance).not.toHaveText('');
		const picker = page.getByTestId('transformation-select');
		expect(await picker.getAttribute('aria-describedby')).toBe('transformation-guidance');
		expect(await picker.getAttribute('title')).toBeNull();
		expect(
			await guidance.evaluate((element) => {
				const read = (pseudo: string) =>
					globalThis.getComputedStyle(element, pseudo).getPropertyValue('content');
				return { before: read('::before'), after: read('::after') };
			}),
			'the guidance must not be CSS-generated content'
		).toEqual({ before: 'none', after: 'none' });
		// And it is the guidance for the type that is actually selected.
		await expect(guidance).toHaveText('Most printed and scanned maps');
	});

	/** Escape still cancels a pending half, on the route as it did in the pane. */
	test('cancels a pending Control Point with Escape', async ({ page }) => {
		test.setTimeout(90_000);
		await start(page);
		await clickAt(historicalMap(page), 0.4, 0.4);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
		await backLink(page).focus();
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', '');
		await expect(rows(page)).toHaveCount(0);
	});
});
