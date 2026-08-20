import { expect, test } from './support/test.js';
import { type Page } from '@playwright/test';
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
	mapImage,
	makePair,
	makePairs,
	rows,
	start,
	storedAlignment,
	storedProjectFile,
	waitForStored,
	watchWrites,
	writes,
	expectWarpedDrawn
} from './support/alignment-workspace';
import { routeBaseMapArchive } from './support/editor-deployment';
import { addMapImageButton, pickMapImageFile } from './support/map-images.js';
import { alignFromLayer, openLayerRow } from './support/layers';

/**
 * Ticket 03: aligning is a route of its own.
 *
 * The pairing, mask, undo and distortion behaviour the route carries is asserted where it already was
 * — `editor-alignment.e2e.ts`, `editor-alignment-refinement.e2e.ts` and `editor-undo.e2e.ts` all now
 * reach the workspace by navigating, and that they pass unchanged is the signal that the move
 * preserved behaviour. What is here is only what is *new*: the URL, the states it can be opened in,
 * the disclosure, the way back, and the keyboard.
 */

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE BASE MAP COMES FROM THE COMMITTED FIXTURE, NOT FROM SOMEBODY ELSE'S BUCKET (ticket 17).
//
// Every entry in `base-map/catalog.ts` points at `demo-bucket.protomaps.com`, and on 2026-08-07 that
// bucket began answering **404** for `v4.pmtiles` — with no CORS headers on the 404 and a 403 on the
// preflight, so an unrouted request is blocked by the browser rather than answered. MapLibre's source
// then never initialises and the warped layer is never added, so the symptom is
// `data-warped-status=""` — which reads exactly like the feature being broken. It went red here, and
// identically on `main`, with nothing in this repository having changed.
//
// ADR-0025 is explicit that this bucket has "no published rate limit, no uptime promise, and no
// terms of use" and that "nothing about it is suitable to rely on". Fourteen other specs already
// route it to `e2e/fixtures/base-map/amsterdam-centre.pmtiles`; these three were the outliers, and
// not by design — see `routeBaseMapArchive` for what routing does and does not still exercise.
test.beforeEach(async ({ page }) => {
	await routeBaseMapArchive(page);
});

const backLink = (page: Page) => page.getByTestId('back-to-project');
const checkToggle = (page: Page) => page.getByTestId('check-alignment-toggle');
const distortionControls = (page: Page) => page.getByTestId('distortion-controls');
const foldWarning = (page: Page) => page.getByTestId('fold-warning');

/** A Project with one Map Image, on the Project page, not yet aligned. */
async function projectWithMap(page: Page): Promise<void> {
	await page.goto('/');
	await emptyWorkspace(page);
	await page.reload();
	await page.getByRole('button', { name: 'New Project' }).click();
	const dialog = page.getByRole('dialog', { name: 'New Project' });
	await dialog.getByLabel('Project name').fill(PROJECT_NAME);
	await dialog.getByRole('button', { name: 'Create' }).click();
	await page.getByRole('link', { name: PROJECT_NAME }).click();
	await expect(addMapImageButton(page)).toBeVisible();
	await pickMapImageFile(page, {
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(700, 500)
	});
	await expect(page.getByTestId('layer-row')).toHaveCount(1, { timeout: 30_000 });
}

/** The `?layer=` of the alignment route the page is currently on. */
const layerParam = (page: Page): string => new URL(page.url()).searchParams.get('layer') ?? '';

/**
 * At `width`: the two panes are exactly equal, and the Control Point column is solid and docked
 * (ticket 10, SPEC stories 48 and 49).
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 * │ MEASURED FROM THE RENDERED BOXES, NEVER READ OFF A CLASS NAME.                             │
 * └───────────────────────────────────────────────────────────────────────────────────────────┘
 * "The panes are equal" is a fact about two numbers the browser computed, and the class that is
 * supposed to produce it is exactly the thing that can be wrong: `grow` and `flex-1` differ only in
 * their flex *basis*, both read as "share the row", and on this repository's own mockups the first
 * of them produced panes of 308 px and 378 px because the Base Map's heading carries two more
 * controls than the Map Image's. An assertion on the markup would have passed on that layout.
 *
 * Three widths rather than one. Two above the breakpoint, because a difference proportional to the
 * content is invisible at whichever single width the difference happens to be small at; and one
 * below it, because "overlaps neither pane **at any width**" is the criterion and the stacked layout
 * is where a horizontal-only comparison would have reported an overlap that does not exist.
 *
 * Polled rather than read once: a viewport change reflows two live map panes, and a measurement
 * taken between the resize and the layout is a measurement of the previous width.
 */
async function expectEqualPanesAndDockedColumn(page: Page, width: number): Promise<void> {
	await page.setViewportSize({ width, height: 900 });

	const sheet = page.locator('section[aria-labelledby="map-image-pane-heading"]');
	const earth = page.locator('section[aria-labelledby="base-map-pane-heading"]');
	const column = page.getByTestId('alignment-sidebar');

	const measure = async (): Promise<{ sheet: number; earth: number }> => {
		const [a, b] = await Promise.all([sheet.boundingBox(), earth.boundingBox()]);
		return { sheet: a?.width ?? -1, earth: b?.width ?? -1 };
	};

	// Half a device pixel, which is the most a browser's own sub-pixel rounding can put between two
	// boxes that were told to split a row. Anything a reader could see is far larger than this.
	await expect
		.poll(
			async () => {
				const { sheet: one, earth: two } = await measure();
				return Math.abs(one - two);
			},
			{ message: `the two panes are not the same width at ${width} px` }
		)
		.toBeLessThanOrEqual(0.5);

	const widths = await measure();
	expect(widths.sheet, `both panes collapsed at ${width} px`).toBeGreaterThan(200);

	if (width >= 1024) {
		const [sheetFrame, earthFrame] = await Promise.all([
			sheet.getByTestId('image-pane').boundingBox(),
			page.getByTestId('base-map-pane').boundingBox()
		]);
		expect(sheetFrame).not.toBeNull();
		expect(earthFrame).not.toBeNull();
		expect(
			Math.abs(sheetFrame!.y - earthFrame!.y),
			`the Map Image and Base Map panes are not top-aligned at ${width} px`
		).toBeLessThanOrEqual(0.5);
	}

	// ─── The column is solid, and it is in the flow rather than over it ──────────────────────────
	const paint = await column.evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			background: style.backgroundColor,
			opacity: style.opacity,
			position: style.position
		};
	});
	expect(paint.position, 'the Control Point column is floating rather than docked').toBe('static');
	expect(paint.opacity, 'the Control Point column is translucent').toBe('1');
	expect(paint.background, 'the Control Point column has no surface of its own').not.toBe(
		'rgba(0, 0, 0, 0)'
	);
	// An alpha channel is spelled `rgba(…, 0.5)` or `oklch(… / 0.5)`; a colour with neither is opaque.
	expect(
		/\/\s*0?\.\d/.test(paint.background) || /rgba\([^)]*,\s*0?\.\d+\s*\)/.test(paint.background),
		`the Control Point column's background is translucent: ${paint.background}`
	).toBe(false);

	// ─── And it overlaps neither pane ────────────────────────────────────────────────────────────
	//
	// A full rect intersection against **both** panes rather than a horizontal comparison, because the
	// criterion is "overlaps neither pane at any width" and the column is beside the panes only above
	// `lg`. Below the breakpoint it stacks underneath them, horizontally coincident and vertically
	// clear — so `column.x >= earth.right` is false there while nothing overlaps anything. Two boxes
	// intersect only when they overlap on *both* axes, which is the claim at every width.
	const [sheetBox, earthBox, columnBox] = await Promise.all([
		sheet.boundingBox(),
		earth.boundingBox(),
		column.boundingBox()
	]);
	expect(sheetBox).not.toBeNull();
	expect(earthBox).not.toBeNull();
	expect(columnBox).not.toBeNull();
	// Half a device pixel of tolerance, the same allowance the width comparison makes: two boxes that
	// share an edge are adjacent, not overlapping, and sub-pixel rounding can put them a hair apart.
	const overlaps = (box: { x: number; y: number; width: number; height: number }): boolean =>
		columnBox!.x < box.x + box.width - 0.5 &&
		box.x < columnBox!.x + columnBox!.width - 0.5 &&
		columnBox!.y < box.y + box.height - 0.5 &&
		box.y < columnBox!.y + columnBox!.height - 0.5;
	expect(
		overlaps(sheetBox!),
		`the Control Point column overlaps the Map Image pane at ${width} px`
	).toBe(false);
	expect(
		overlaps(earthBox!),
		`the Control Point column overlaps the Base Map pane at ${width} px`
	).toBe(false);

	// Geometry is not the whole claim: what a click lands on is. A point well inside the Base Map
	// pane must reach the pane, which is what says nothing is drawn over the canvas a scholar is
	// aiming at to sub-pixel accuracy.
	//
	// Aimed at the middle of the pane's *visible* band rather than of the whole box:
	// `document.elementFromPoint` takes viewport coordinates and answers `null` for anything below the
	// fold, and below `lg` the stacked panes run past the bottom of a 900 px viewport.
	const top = Math.max(earthBox!.y, 0);
	const bottom = Math.min(earthBox!.y + earthBox!.height, 900);
	expect(bottom, `the Base Map pane is entirely below the fold at ${width} px`).toBeGreaterThan(
		top
	);
	const hit = await page.evaluate(
		({ x, y }) => {
			const element = document.elementFromPoint(x, y);
			return element !== null && element.closest('[data-testid="alignment-sidebar"]') === null;
		},
		{ x: earthBox!.x + earthBox!.width - 4, y: (top + bottom) / 2 }
	);
	expect(hit, `something is drawn over the Base Map pane at ${width} px`).toBe(true);
}

test.describe('the alignment route', () => {
	test('opens from the Project at ?p= and ?layer=, and pairs by click-then-click', async ({
		page
	}) => {
		test.setTimeout(90_000);
		await projectWithMap(page);

		// Nothing has been aligned, and the Layer is nonetheless already there: adding the Map Image
		// is what put it in the stack (ADR-0023). So Align is a plain link whose `href` was knowable
		// before the click, which is what the URL assertions below are really measuring.
		// Opened first, because Align is inside the Layer it aligns (ticket 05).
		const row = await openLayerRow(page);
		await expect(row.getByTestId('align-map-image')).toHaveRole('link');
		await row.getByTestId('align-map-image').click();
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
			const root = await workspaceRoot();
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
		await expect(mapImage(page)).toBeVisible();
		await expect(baseMap(page)).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Map Image: la-floride.png' })).toBeVisible();
		await expect(page.getByTestId('map-image-tiles')).toHaveAttribute('data-tiles-loaded', 'true', {
			timeout: 30_000
		});
		await expect(
			mapImage(page).getByRole('button', { name: 'Zoom out one level', exact: true })
		).toHaveCount(0);
		await expect(
			mapImage(page).getByRole('button', { name: 'Zoom in one level', exact: true })
		).toHaveCount(0);
		await expect(mapImage(page).locator('button.maplibregl-ctrl-zoom-in')).toBeVisible();
		await expect(mapImage(page).locator('button.maplibregl-ctrl-zoom-out')).toBeVisible();
		await makePair(page, [0.3, 0.3]);
		await expect(rows(page)).toHaveCount(1);

		// ─── The shell (ticket 10, SPEC stories 47 and 51) ───────────────────────────────────────
		//
		// The route wears the application's own bar rather than a header strip of its own: where you
		// are, the way back, and — because they are on every screen — the save indicator and undo.
		const bar = page.getByTestId('navigation-bar');
		await expect(bar.getByTestId('page-heading')).toHaveText(/^Align:/);
		await expect(bar.getByTestId('back-to-project')).toHaveText('Amsterdam 1625');
		await expect(bar.getByTestId('save-slot')).toBeVisible();
		await expect(bar.getByTestId('undo-slot')).toBeAttached();

		await expectEqualPanesAndDockedColumn(page, 768);
		await expectEqualPanesAndDockedColumn(page, 1120);
		await expectEqualPanesAndDockedColumn(page, 1440);

		await makePair(page, [0.6, 0.3]);
		await makePair(page, [0.3, 0.6]);
		await expect(page.getByTestId('overlay-opacity-controls')).toBeVisible();
		await expectEqualPanesAndDockedColumn(page, 1440);

		const done = page.getByTestId('alignment-done');
		await expect(done).toBeVisible();
		await expect(done).toHaveRole('link');
		await done.click();
		await expect(page).toHaveURL(new RegExp(`\\?p=${PROJECT_DIRECTORY}$`));
		await expect(addMapImageButton(page)).toBeVisible();
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
		await alignFromLayer(page);
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
			const root = await workspaceRoot();
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

		// 4. A `layer` this Project has no Map Image Layer for — the state ticket 03 adds, and the
		//    one that used to be an empty split screen.
		await page.goto(`/align?p=${PROJECT_DIRECTORY}&layer=not-a-layer-in-this-project`);
		await expect(page.getByTestId('layer-missing')).toBeVisible();
		await expect(page.getByTestId('layer-missing')).toContainText('not-a-layer-in-this-project');
		// Neither pane is on the page: this is a named state and not a workspace with nothing in it.
		await expect(mapImage(page)).toHaveCount(0);
		await expect(baseMap(page)).toHaveCount(0);
		await backLink(page).click();
		await expect(addMapImageButton(page)).toBeVisible();

		// 5. No `?layer=`, with a perfectly good Project.
		await page.goto(`/align?p=${PROJECT_DIRECTORY}`);
		await expect(page.getByTestId('no-layer')).toBeVisible();
		await expect(mapImage(page)).toHaveCount(0);
		await backLink(page).click();
		await expect(addMapImageButton(page)).toBeVisible();

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
		await expect(mapImage(page)).toHaveCount(0);

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
	 * It also carries SPEC story 36 — one Layer per Map Image per Project — against the gesture
	 * ticket 03 adds, which is the one gesture that could newly break it: `project.json` byte-identical
	 * across a round trip through the route says no Layer was created, renamed, or reordered by it.
	 */
	test('opening it writes no Alignment and adds no Layer', async ({ page }) => {
		test.setTimeout(120_000);
		await projectWithMap(page);
		await expect(page.getByRole('status')).toHaveText('Saved locally');

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
		await alignFromLayer(page);
		await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);
		await expect(page.getByTestId('map-image-tiles')).toHaveAttribute('data-tiles-loaded', 'true', {
			timeout: 30_000
		});
		await expect(baseMap(page)).toBeVisible();
		await noWritesAfter();

		// 2. And in by a reload, which is the other way a scholar arrives — a bookmark — and the one
		//    that runs the whole route from nothing rather than from a client-side navigation.
		await page.reload();
		await watchWrites(page);
		await expect(page.getByTestId('map-image-tiles')).toHaveAttribute('data-tiles-loaded', 'true', {
			timeout: 30_000
		});
		await expect(baseMap(page)).toBeVisible();
		await noWritesAfter();

		await backLink(page).click();
		await expect(addMapImageButton(page)).toBeVisible();
		await page.waitForTimeout(1000);

		// The bytes agree with the counter, on both documents. `project.json` is SPEC story 36 against
		// the gesture ticket 03 adds: no Layer created, renamed, or reordered by a trip through the
		// route.
		expect(await storedAlignment(page, imageId)).toBe(alignmentBefore);
		expect(await storedProjectFile(page)).toBe(before);
	});

	/**
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE POSITIVE CONTROL FOR THE TEST ABOVE (ticket 18)
	 *
	 * The test above proves a write did not happen by reading an array that `recordAlignmentWrite`
	 * pushes into. **On its own that is vacuous**, and in exactly the way this epic keeps producing:
	 * delete the instrumentation, or arm it after the reload that throws it away, and the array is
	 * empty for reasons that have nothing to do with the route. An assertion that something is absent
	 * needs a companion showing the same apparatus reporting it present.
	 *
	 * So this places one Control Point and asserts the counter is non-empty, through the same
	 * `watchWrites` / `writes` pair, in the same route, on the same document. Together the two say
	 * "the counter works, and it stayed empty when the route was only opened".
	 */
	test('the write counter reports a write when one really happens', async ({ page }) => {
		test.setTimeout(120_000);
		const imageId = await start(page);
		await watchWrites(page);

		await makePair(page, [0.35, 0.4]);
		await waitForStored(page, imageId, 1);

		const recorded = await writes(page);
		expect(recorded.length, 'placing a Control Point recorded no write').toBeGreaterThan(0);
		expect(recorded.map((write) => write.path)).toContain(`alignments/${imageId}.json`);
	});

	test('keeps a Control Point across a trip back to the Project and in again', async ({ page }) => {
		test.setTimeout(120_000);
		const imageId = await start(page);
		await makePair(page, [0.35, 0.4]);
		await waitForStored(page, imageId, 1);
		const written = await storedAlignment(page, imageId);

		await backLink(page).click();
		await expect(addMapImageButton(page)).toBeVisible();
		await expect(mapImage(page)).toHaveCount(0);

		await alignFromLayer(page);
		await expect(page.getByTestId('map-image-tiles')).toHaveAttribute('data-tiles-loaded', 'true', {
			timeout: 30_000
		});
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
		await expect(addMapImageButton(page)).toBeVisible();
		await alignFromLayer(page);
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
		await expectWarpedDrawn(page);

		// Closed by default, and everything behind it is *absent* rather than hidden. Asked of the
		// accessibility tree by role and name, which is the criterion — a `getByTestId` count would go
		// green on a control that was merely missing its testid.
		await expect(checkToggle(page)).toHaveAttribute('aria-expanded', 'false');
		const overlay = page.getByRole('checkbox', {
			name: 'Colour the Map Image by how much it is stretched'
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
		await expectWarpedDrawn(page);

		await checkToggle(page).click();
		await page.getByTestId('distortion-toggle').check();
		await page.getByTestId('grid-toggle').check();
		await expect(checkToggle(page)).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const stored = await page.evaluate(async () => {
			const root = await workspaceRoot();
			const project = await root.getDirectoryHandle('amsterdam-1625');
			const handle = await project.getFileHandle('project.json');
			return await (await handle.getFile()).text();
		});
		expect(stored).not.toContain('log2sigma');
		expect(stored).not.toContain('renderGrid');
		expect(stored).not.toContain('checking');

		await page.reload();
		await expect(page.getByRole('heading', { name: /^Align(?::|$)/ })).toBeVisible();
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
		await expectWarpedDrawn(page);
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
		await expect(addMapImageButton(page)).toBeVisible();
		expect(new URL(page.url()).searchParams.get('p')).toBe(PROJECT_DIRECTORY);
	});

	/**
	 * SPEC stories 62, 63 and 69: the column is ordered by what a scholar is doing.
	 *
	 * The prompt answers "what do I click next" and is read after every half-pair, so it is first. The
	 * Control Points are what the screen is *for*, so they come before how the map is stretched and
	 * before the disclosure that checks it. *Done* is pinned last and stays one large link.
	 *
	 * **Asserted as document order rather than as pixel positions**, because below `lg` this column is
	 * a footer under the panes and above it a rail beside them, and the reading order is the claim in
	 * both. The three-width geometry assertions above measure the boxes; this measures the sequence.
	 *
	 * **The alerts sit above the Control Points**, which is why this drives the column into a state
	 * that raises the fold warning and asserts its place in the sequence: below `lg` the column is a
	 * footer, so a fifty-point Alignment between the maps and a warning would put the warning off the
	 * bottom of a phone. Story 63 asks for the points before the stretch controls, not before the
	 * warnings.
	 */
	test('puts the prompt first, then the Control Points, then the stretch, then Done', async ({
		page
	}) => {
		test.setTimeout(120_000);
		await start(page);
		// Two swapped pairs and a third: the "I mixed up two Control Points" mistake, which under the
		// default affine transformation reads as a mirrored Alignment and raises the fold warning.
		await makePair(page, [0.25, 0.3], [0.75, 0.3]);
		await makePair(page, [0.75, 0.3], [0.25, 0.3]);
		await makePair(page, [0.5, 0.75], [0.5, 0.75]);
		await expect(rows(page)).toHaveCount(3);
		await expect(foldWarning(page)).toBeVisible();

		const wanted = [
			'pairing-status',
			'align-explainer-toggle',
			'fold-warning',
			'control-point-list',
			'transformation-picker',
			'check-alignment-toggle',
			'alignment-done'
		];
		const order = await page
			.getByTestId('alignment-sidebar')
			.evaluate(
				(column, ids) =>
					[...column.querySelectorAll('[data-testid]')]
						.map((element) => element.getAttribute('data-testid') ?? '')
						.filter((id) => ids.includes(id)),
				wanted
			);
		expect(order).toEqual(wanted);

		// Last in the column and nothing after it, which is the half "pinned to the bottom" that a
		// class name cannot promise.
		expect(
			await page
				.getByTestId('alignment-sidebar')
				.evaluate((column) => column.lastElementChild?.getAttribute('data-testid'))
		).toBe('alignment-done');
	});

	/**
	 * SPEC story 112: what this screen does, in text.
	 *
	 * **Behind "How this works" in the sidebar now.** It was standing prose above the panes, which is
	 * the height the maps needed. What story 112 asks for is asserted unchanged — visible text rather
	 * than a `title` — and the trade is stated rather than hidden: the sentence now follows the two
	 * canvases in the reading order instead of introducing them.
	 */
	test('says what the two panes are for, as text rather than as a tooltip', async ({ page }) => {
		await start(page);
		const toggle = page.getByTestId('align-explainer-toggle');
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');
		// Nothing is standing on the page taking height from the maps until it is asked for.
		await expect(page.getByTestId('align-explainer')).toHaveCount(0);
		await toggle.click();
		const explainer = page.getByTestId('align-explainer');
		await expect(explainer).toBeVisible();
		await expect(explainer).toContainText('Click a feature on the Map Image');
		await expect(explainer).not.toHaveAttribute('title', /.+/);

		// **The two notes about consequences are in here with it** (SPEC stories 62, 67). Both are
		// prose about what a choice costs rather than help for making it, so they sit behind the same
		// disclosure as the rest of the explanation instead of standing in the transformation group.
		// `transformation-picker.dom.test.ts` asserts the other half: that neither renders in that
		// group.
		await expect(explainer.getByTestId('transformation-simple-note')).toContainText(
			'Simple cannot turn the Map Image over'
		);
		await expect(explainer.getByTestId('transformation-advanced-note')).toContainText(
			'spectacular distortion at the edges'
		);

		// The whole disclosure is a tooltip-free channel, notes included: no `title` anywhere in the
		// subtree and no daisyUI `tooltip` class, which renders through CSS and is not announced
		// (ADR-0016).
		await expect(explainer.locator('[title]')).toHaveCount(0);
		await expect(explainer.locator('[class*="tooltip"]')).toHaveCount(0);

		// The transformation guidance is text in the accessibility tree, bound to the control by
		// `aria-describedby` — never a `title` and never CSS-generated (ADR-0016).
		const guidance = page.getByTestId('transformation-guidance');
		await expect(guidance).toBeVisible();
		await expect(guidance).not.toHaveText('');
		const picker = page.getByTestId('transformation-select');
		expect(await picker.getAttribute('aria-describedby')).toBe('transformation-guidance');
		expect(await picker.getAttribute('title')).toBeNull();
		// The guidance and both demoted notes are real text nodes, not `::before` content.
		for (const id of [
			'transformation-guidance',
			'transformation-simple-note',
			'transformation-advanced-note'
		]) {
			expect(
				await page.getByTestId(id).evaluate((element) => {
					const read = (pseudo: string) =>
						globalThis.getComputedStyle(element, pseudo).getPropertyValue('content');
					return { before: read('::before'), after: read('::after') };
				}),
				`${id} must not be CSS-generated content`
			).toEqual({ before: 'none', after: 'none' });
		}
		// And it is the guidance for the type that is actually selected.
		await expect(guidance).toHaveText('Most printed and scanned maps');
	});

	/** Escape still cancels a pending half, on the route as it did in the pane. */
	test('cancels a pending Control Point with Escape', async ({ page }) => {
		test.setTimeout(90_000);
		await start(page);
		await clickAt(mapImage(page), 0.4, 0.4);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
		await backLink(page).focus();
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', '');
		await expect(rows(page)).toHaveCount(0);
	});
});
