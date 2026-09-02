import { expect, test } from './support/test.js';
import { type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { openLayerRow } from './support/layers.js';

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
 * Seam 2: a Project opens framed on what it has placed on the earth (ADR-0026).
 *
 * **What is asserted here and what is asserted in Node.** The *arithmetic* — which box, out of which
 * documents, with which fallback — is `packages/core/src/project/opening-view.test.ts`, numerically and
 * with no browser. What cannot be asserted there is that the number reaches MapLibre: that the pane is
 * actually moved, that it is moved **once**, that the cap really does stop a single pin at z16, and that
 * merely opening a Project writes nothing. So every assertion below reads the real map's own centre and
 * zoom through `window.ballastellaBaseMap`, which is the handle `e2e/editor-base-map.e2e.ts` already
 * uses and the only honest account of where the map is looking.
 *
 * The Projects are **seeded straight into OPFS** rather than built through the interface, except where
 * the interface is the thing under test. Framing on Boston, on a Resource Mask, and on two sides of the
 * Pacific each needs a Project whose content is somewhere definite, and there is no route through the
 * editor that puts a Map Image in Boston in less than half a minute.
 */

/** The deployment default, which is what a Project with nothing on the earth must open on. */
const DEPLOYMENT_VIEW = { lng: 0, lat: 20, zoom: 1 };

/** The subset of MapLibre's `Map` these tests ask questions of. All real `maplibre-gl` methods. */
type BaseMapHandle = {
	loaded(): boolean;
	getCenter(): { lng: number; lat: number };
	getZoom(): number;
	jumpTo(options: { center: [number, number]; zoom: number }): void;
	getBounds(): {
		contains(lngLat: [number, number]): boolean;
		toArray(): [[number, number], [number, number]];
	};
};

/**
 * The window as this file reads it, applied as a cast at each `page.evaluate` boundary.
 *
 * A local type rather than a `declare global`, for the reason `e2e/support/annotations.ts` records:
 * `editor-base-map.e2e.ts` already augments `Window.ballastellaBaseMap` with the subset *it* needs, and
 * TypeScript requires every declaration of one property to be identical. Two files each declaring the
 * shape they use is the shape that cannot be made to agree; a cast per call site can.
 */
type MapWindow = {
	ballastellaBaseMap?: BaseMapHandle;
	/** Every OPFS file opened for writing since the spy was installed — see {@link watchWrites}. */
	ballastellaOpfsWrites?: string[];
	/** Every `localStorage`/`sessionStorage` mutation since then. Same spy, same reason. */
	ballastellaWebStorageWrites?: string[];
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures
//
// The geography is chosen so that every wrong answer is a *different* answer. Boston is four thousand
// miles from the deployment default, so "it framed on the content" cannot be satisfied by not moving;
// the Control Points sit in one corner of the sheet, so the mask's box and the points' box have
// different centres as well as different sizes; and the Pacific pair is 98° apart one way and 262° the
// other.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const IMAGE_ID = 'aaa';
const IMAGE_WIDTH = 1000;
const IMAGE_HEIGHT = 800;

/**
 * Control Points covering the **top-left corner** of the sheet only, and what the sheet therefore
 * spans once the whole of it is transformed.
 *
 * Both boxes are written out because both are plausible and the criterion is that one of them is used:
 * fitting to the points understates the sheet by two thirds and puts its centre a hundredth of a degree
 * away, which on screen is a map that looks perfectly reasonable and is wrong.
 */
const SHEET_CONTROL_POINTS = [
	{ resource: [100, 100], geo: [-71.1, 42.38] },
	{ resource: [400, 100], geo: [-71.06, 42.38] },
	{ resource: [400, 300], geo: [-71.06, 42.36] },
	{ resource: [100, 300], geo: [-71.1, 42.36] }
] as const;

/** What the four Control Points alone span, and the centre a fit to them would land on. */
const CONTROL_POINT_BOX = { west: -71.1, south: 42.36, east: -71.06, north: 42.38 };
const CONTROL_POINT_CENTRE = { lng: -71.08, lat: 42.37 };

/**
 * What the whole sheet spans through those points, and the centre a fit to *it* lands on.
 *
 * 300 image pixels span 0.04° of longitude and 200 span 0.02° of latitude, so the sheet reaches
 * 100 px west and 600 px east of the points, and 100 px north and 500 px south of them.
 */
const SHEET_BOX = { west: -71.113333, south: 42.31, east: -70.98, north: 42.39 };
const SHEET_CENTRE = { lng: -71.046667, lat: 42.35 };

/** Three pins around Boston, and the box they span. */
const BOSTON_PINS: readonly (readonly [number, number])[] = [
	[-71.0912, 42.3601],
	[-71.0656, 42.3554],
	[-71.0402, 42.3522]
];
const BOSTON_CENTRE = { lng: -71.0657, lat: 42.35615 };

/** One pin, so the box has zero area and only the zoom cap keeps the map off four roof tiles. */
const LONE_PIN: readonly [number, number] = [-71.0656, 42.3554];

/** Tokyo and San Francisco: 98° apart across the Pacific, 262° the other way round. */
const PACIFIC_PINS: readonly (readonly [number, number])[] = [
	[139.7671, 35.6812],
	[-122.4194, 37.7749]
];
/** The centre of the *short* box. The long way round centres near 8.7°E, off the coast of Africa. */
const PACIFIC_CENTRE_LNG = -171.32615;

/** The Project these tests open. Its identity is its directory name (ADR-0008). */
const PROJECT_DIRECTORY = 'boston-harbour';

const asJson = (value: unknown): string => `${JSON.stringify(value, null, '\t')}\n`;

/** A Georeference Annotation over the fixture sheet, as `serialiseAlignment` writes one. */
const alignmentJson = (): string =>
	asJson({
		type: 'Annotation',
		'@context': [
			'http://iiif.io/api/extension/georef/1/context.json',
			'http://iiif.io/api/presentation/3/context.json'
		],
		motivation: 'georeferencing',
		target: {
			type: 'SpecificResource',
			source: {
				id: `https://unset.invalid/${IMAGE_ID}`,
				type: 'ImageService3',
				height: IMAGE_HEIGHT,
				width: IMAGE_WIDTH
			},
			selector: {
				type: 'SvgSelector',
				// The whole sheet, which is what a Resource Mask defaults to (ADR-0013).
				value:
					`<svg width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}">` +
					`<polygon points="0,0 ${IMAGE_WIDTH},0 ${IMAGE_WIDTH},${IMAGE_HEIGHT} 0,${IMAGE_HEIGHT}" />` +
					`</svg>`
			}
		},
		body: {
			type: 'FeatureCollection',
			transformation: { type: 'polynomial', options: { order: 1 } },
			features: SHEET_CONTROL_POINTS.map((point) => ({
				type: 'Feature',
				properties: { resourceCoords: point.resource },
				geometry: { type: 'Point', coordinates: point.geo }
			}))
		}
	});

const pinFeature = (index: number, coordinates: readonly [number, number]) => ({
	type: 'Feature',
	id: `1111111${index}-1111-4111-8111-111111111111`,
	geometry: { type: 'Point', coordinates },
	properties: { title: `Pin ${index}` }
});

const featureCollection = (pins: readonly (readonly [number, number])[]) =>
	asJson({ type: 'FeatureCollection', features: pins.map((at, index) => pinFeature(index, at)) });

type LayerSpec = { kind: 'map' | 'annotation'; id: string; visible?: boolean };

/**
 * A whole Workspace as files, **Workspace-relative** (ADR-0023).
 *
 * The rooting is the load-bearing part of this fixture and not an incidental. A Map Image's
 * Alignment is `alignments/<image-id>.json` at the *Workspace* root, shared by every Project, while a
 * Project's `project.json` and its Annotation Layers are inside its own directory. A fixture that
 * seeded the Alignment under the Project would be seeding a file the app no longer looks for — the
 * map Layer would read as unaligned, the fit would fall through to the deployment default, and the
 * Resource Mask criterion would pass vacuously on a Project with nothing in it.
 *
 * No pyramid is written. A Map Image with no tiles still has a *place* — the Alignment is what
 * says where — and the opening view is computed from the Alignment alone, never from the renderer.
 */
function workspaceFiles(options: {
	layers: readonly LayerSpec[];
	pins?: readonly (readonly [number, number])[];
	/** Write no Alignment for the map Layer, which is a Map Image nobody has aligned. */
	unaligned?: boolean;
}): Record<string, string> {
	const files: Record<string, string> = {
		[`${PROJECT_DIRECTORY}/project.json`]: asJson({
			formatVersion: 1,
			name: 'Boston Harbour',
			updatedAt: '2026-01-02T03:04:05.000Z',
			layers: options.layers.map((layer, order) =>
				layer.kind === 'map'
					? {
							kind: 'map',
							id: layer.id,
							name: 'The sheet',
							visible: layer.visible ?? true,
							order,
							opacity: 1,
							imageId: IMAGE_ID
						}
					: {
							kind: 'annotation',
							id: layer.id,
							name: 'Pins',
							visible: layer.visible ?? true,
							order,
							geojsonRef: `annotations/${layer.id}.geojson`,
							defaultStyle: {}
						}
			),
			baseMap: null
		})
	};
	for (const layer of options.layers) {
		if (layer.kind === 'map') {
			// ⚠ **The pyramid's own `info.json`, which the framing does not need and the Workspace does.**
			// A Layer whose Map Image has no `info.json` is a Workspace `assertReferencesPresent` refuses
			// (ADR-0023), and the Project screen reports it — correctly — as “A Map Image stopped
			// drawing”. That notice is a box above the map, and a shorter map is a different opening
			// view: the sheet would not fit corner to corner, which is what this spec measures. Its
			// tiles are deliberately still absent — a 404 for a tile *cell* is not reported
			// (`store-image-fetch.ts`), because a complete pyramid answers some on every load.
			files[`images/${IMAGE_ID}/info.json`] = asJson({
				'@context': 'http://iiif.io/api/image/3/context.json',
				id: `https://unset.invalid/${IMAGE_ID}`,
				type: 'ImageService3',
				protocol: 'http://iiif.io/api/image',
				profile: 'level0',
				width: IMAGE_WIDTH,
				height: IMAGE_HEIGHT,
				tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4] }]
			});
		}
		if (layer.kind === 'map' && !options.unaligned) {
			// The Workspace root, with no Project in front of it — see the note above.
			// alignment-write-is-the-fixture: the Workspace this spec opens; the opening view is computed from an Alignment already on disk
			files[`alignments/${IMAGE_ID}.json`] = alignmentJson();
		}
		if (layer.kind === 'annotation') {
			files[`${PROJECT_DIRECTORY}/annotations/${layer.id}.geojson`] = featureCollection(
				options.pins ?? BOSTON_PINS
			);
		}
	}
	return files;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Driving

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

/** Write files straight into OPFS at the paths given, which are Workspace-relative (ADR-0023). */
async function seed(page: Page, files: Record<string, string>): Promise<void> {
	await page.evaluate(async (entries: [string, string][]) => {
		const root = await workspaceRoot();
		for (const [relative, text] of entries) {
			let handle = root;
			const segments = relative.split('/');
			for (const segment of segments.slice(0, -1)) {
				handle = await handle.getDirectoryHandle(segment, { create: true });
			}
			const file = await handle.getFileHandle(segments.at(-1) as string, { create: true });
			const writable = await file.createWritable();
			await writable.write(text);
			await writable.close();
		}
	}, Object.entries(files));
}

/**
 * Seed a Project and open the Project screen on it, waiting until the opening view has settled.
 *
 * The wait is on `data-opening-view`, which the page sets to `content` or `default` when the one-shot
 * read behind the fit has finished. Sampling the map before that would be reading the map's
 * *constructed* position, which is the deployment default — the very thing several of these tests are
 * distinguishing the content fit from.
 */
async function open(page: Page, files: Record<string, string>): Promise<void> {
	await page.goto('/');
	await emptyWorkspace(page);
	await seed(page, files);
	await page.goto(`/?p=${PROJECT_DIRECTORY}`);
	await settled(page);
}

async function settled(page: Page): Promise<void> {
	await expect(page.getByTestId('opening-view')).toHaveAttribute(
		'data-opening-view',
		/^(content|default)$/,
		{ timeout: 30_000 }
	);
	await page.waitForFunction(
		() => (window as unknown as MapWindow).ballastellaBaseMap?.loaded() === true,
		undefined,
		{ timeout: 45_000 }
	);
}

/** Where the real map is looking, right now. */
const viewport = (page: Page) =>
	page.evaluate(() => {
		const map = (window as unknown as MapWindow).ballastellaBaseMap!;
		return { lng: map.getCenter().lng, lat: map.getCenter().lat, zoom: map.getZoom() };
	});

/** Whether every one of `corners` is inside the map's current viewport. */
const showing = (page: Page, corners: readonly (readonly [number, number])[]) =>
	page.evaluate((points) => {
		const map = (window as unknown as MapWindow).ballastellaBaseMap!;
		return (points as [number, number][]).every((point) => map.getBounds().contains(point));
	}, corners);

/** Put the map somewhere definite, so that "it did not move" is a claim about a known place. */
async function parkAt(page: Page, lng: number, lat: number, zoom: number): Promise<void> {
	await page.evaluate(
		(at) =>
			(window as unknown as MapWindow).ballastellaBaseMap!.jumpTo({
				center: [at.lng, at.lat],
				zoom: at.zoom
			}),
		{ lng, lat, zoom }
	);
}

const PARKED = { lng: 2.3522, lat: 48.8566, zoom: 11 };

/** Assert the map is exactly where {@link parkAt} left it. */
async function stillParked(page: Page, after: string): Promise<void> {
	const at = await viewport(page);
	expect(at.lng, `the map moved in longitude ${after}`).toBeCloseTo(PARKED.lng, 6);
	expect(at.lat, `the map moved in latitude ${after}`).toBeCloseTo(PARKED.lat, 6);
	expect(at.zoom, `the map changed zoom ${after}`).toBeCloseTo(PARKED.zoom, 6);
}

const rows = (page: Page) => page.getByTestId('layer-row');

async function clickAt(target: Locator, fx: number, fy: number): Promise<void> {
	const box = await target.boundingBox();
	if (!box) throw new Error('the pane has no box to click in');
	await target.click({ position: { x: box.width * fx, y: box.height * fy } });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

test.describe('a Project opens on its own content', () => {
	test('frames on the city its Annotations are in, not on the deployment default', async ({
		page
	}) => {
		await open(page, workspaceFiles({ layers: [{ kind: 'annotation', id: 'l-pins' }] }));

		const at = await viewport(page);
		expect(at.lng).toBeCloseTo(BOSTON_CENTRE.lng, 3);
		expect(at.lat).toBeCloseTo(BOSTON_CENTRE.lat, 3);
		// Said twice on purpose: a fit that produced *some* box near Boston would satisfy the centre,
		// and a fit that never ran would leave the map in Amsterdam. Both are worth ruling out.
		expect(Math.abs(at.lng - DEPLOYMENT_VIEW.lng)).toBeGreaterThan(50);
		expect(await showing(page, BOSTON_PINS)).toBe(true);
	});

	test('frames an aligned Map Image on its Resource Mask, not on its Control Points', async ({
		page
	}) => {
		await open(page, workspaceFiles({ layers: [{ kind: 'map', id: 'l-map' }] }));

		const at = await viewport(page);
		// The two candidate boxes have different centres by construction — the Control Points cover one
		// corner of the sheet — so this single assertion tells them apart. Fitting to the points would
		// put the centre at (-71.08, 42.37).
		expect(at.lng).toBeCloseTo(SHEET_CENTRE.lng, 3);
		expect(at.lat).toBeCloseTo(SHEET_CENTRE.lat, 3);
		expect(Math.abs(at.lng - CONTROL_POINT_CENTRE.lng)).toBeGreaterThan(0.005);

		// And the whole sheet is on screen, corner to corner. A fit to the Control Points shows about a
		// third of it: the sheet's west edge is half the point span beyond the westmost point.
		expect(
			await showing(page, [
				[SHEET_BOX.west, SHEET_BOX.south],
				[SHEET_BOX.east, SHEET_BOX.north]
			])
		).toBe(true);
		expect(SHEET_BOX.west).toBeLessThan(CONTROL_POINT_BOX.west);
	});

	test('stops at the zoom cap for a Project whose only content is one pin', async ({ page }) => {
		await open(
			page,
			workspaceFiles({ layers: [{ kind: 'annotation', id: 'l-pins' }], pins: [LONE_PIN] })
		);

		const at = await viewport(page);
		expect(at.lng).toBeCloseTo(LONE_PIN[0], 4);
		expect(at.lat).toBeCloseTo(LONE_PIN[1], 4);
		// A zero-area box fitted without a cap goes to the map's own maximum, which is 22 — four roof
		// tiles, and no way for a reader to tell what they are looking at.
		expect(at.zoom).toBeLessThanOrEqual(16);
		expect(at.zoom).toBeCloseTo(16, 4);
	});

	test('frames on content the author has hidden, rather than on the default', async ({ page }) => {
		await open(
			page,
			workspaceFiles({ layers: [{ kind: 'annotation', id: 'l-pins', visible: false }] })
		);

		// Nothing is drawn — the Layer is off — and the map is still looking at the work. Someone who
		// hid every Layer to study the Base Map underneath did not ask to be sent to Amsterdam.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '0');
		const at = await viewport(page);
		expect(at.lng).toBeCloseTo(BOSTON_CENTRE.lng, 3);
		expect(at.lat).toBeCloseTo(BOSTON_CENTRE.lat, 3);
	});

	test('prefers what is visible when only some of the work is hidden', async ({ page }) => {
		await open(page, {
			...workspaceFiles({
				layers: [
					{ kind: 'annotation', id: 'l-pins' },
					{ kind: 'map', id: 'l-map', visible: false }
				]
			})
		});

		// Boston's pins are visible and the Map Image is not, so the box is the pins' alone. Both are
		// in Boston, so this is asserted on the *size* of what is shown: the sheet's corners are outside
		// a box fitted to three pins a mile apart.
		expect(await showing(page, BOSTON_PINS)).toBe(true);
		expect(await showing(page, [[SHEET_BOX.west, SHEET_BOX.south]])).toBe(false);
	});

	test('takes the short way round the antimeridian', async ({ page }) => {
		await open(
			page,
			workspaceFiles({ layers: [{ kind: 'annotation', id: 'l-pins' }], pins: PACIFIC_PINS })
		);

		const at = await viewport(page);
		// Normalised, because a box that crosses the antimeridian is expressed with an `east` beyond 180
		// and the centre comes back the same way. The long way round centres near 8.7°E — a whole-planet
		// view with the work at both edges, which is the answer `Math.min`/`Math.max` gives.
		const lng = ((((at.lng + 180) % 360) + 360) % 360) - 180;
		expect(lng).toBeCloseTo(PACIFIC_CENTRE_LNG, 2);

		// And what is on screen is a stretch of the Pacific rim rather than the world. Measured off the
		// map's own bounds and unwrapped by hand, because MapLibre normalises the corners of a box that
		// crosses the antimeridian back into ±180 and its `contains` then answers about the long way.
		const [[west], [east]] = await page.evaluate(() =>
			(window as unknown as MapWindow).ballastellaBaseMap!.getBounds().toArray()
		);
		expect(east >= west ? east - west : east + 360 - west).toBeLessThan(180);
	});
});

test.describe('the fit happens once, on open', () => {
	test('a toggled Layer, a renamed Layer, and a new Annotation all leave the viewport alone', async ({
		page
	}) => {
		await open(
			page,
			workspaceFiles({
				layers: [
					{ kind: 'annotation', id: 'l-pins' },
					{ kind: 'map', id: 'l-map' }
				]
			})
		);

		// Somewhere the content is not, so that any refit at all is visible as a move.
		await parkAt(page, PARKED.lng, PARKED.lat, PARKED.zoom);
		await stillParked(page, 'before anything was edited');

		// 1. Hiding a Layer. The stack changes, the fallback chain's first branch changes with it, and a
		//    reactive bounds would recompute and jump.
		await rows(page).nth(1).getByTestId('layer-visible').uncheck();
		await expect(page.getByRole('status')).toHaveText('Saved here');
		await stillParked(page, 'after a Layer was hidden');

		// 2. And showing it again.
		await rows(page).nth(1).getByTestId('layer-visible').check();
		await expect(page.getByRole('status')).toHaveText('Saved here');
		await stillParked(page, 'after a Layer was shown again');

		// 3. Renaming. Nothing about the geography changes, which is exactly why a refit here would be
		//    the most baffling of the four.
		// Renaming starts at the pencil in an open card since the Layers revision; the field is not on
		// the collapsed row any more.
		const renaming = await openLayerRow(page, rows(page).nth(0));
		await renaming.getByTestId('layer-rename').click();
		await renaming.getByTestId('layer-name').fill('The pins, renamed');
		await expect(page.getByRole('status')).toHaveText('Saved here');
		await stillParked(page, 'after a Layer was renamed');

		// 4. Opening a Layer, which is what reveals the drawing tools — and is itself a change to the
		//    sidebar that must not move the map.
		await openLayerRow(page, 0);
		await stillParked(page, 'after a Layer was opened');

		// 5. Drawing an Annotation. The Project's content genuinely grows, and the map must still not
		//    move: a scholar placing a pin is looking at the place they are placing it.
		// Two presses: drawing is behind "New Annotation" now, and selecting is the resting behaviour.
		await page.getByTestId('annotation-new').click();
		await page.getByTestId('annotation-tool-point').click();
		await clickAt(page.getByTestId('base-map-pane'), 0.5, 0.5);
		await expect(page.getByRole('status')).toHaveText('Saved here');
		await stillParked(page, 'after an Annotation was drawn');
	});

	test('“Frame project” re-frames on demand, and says so', async ({ page }) => {
		await open(page, workspaceFiles({ layers: [{ kind: 'annotation', id: 'l-pins' }] }));
		await parkAt(page, PARKED.lng, PARKED.lat, PARKED.zoom);

		// Visible text, not an icon with a tooltip.
		await page.getByRole('button', { name: 'Frame project' }).click();

		// Polled, because reframing re-reads every Layer's documents — the button answers for the whole
		// Project, hidden Layers and all, which is what the automatic fit answers for.
		await expect
			.poll(async () => (await viewport(page)).lng, { timeout: 15_000 })
			.toBeCloseTo(BOSTON_CENTRE.lng, 3);
		expect((await viewport(page)).lat).toBeCloseTo(BOSTON_CENTRE.lat, 3);

		// And again from the same place, because the box has not changed and the user means it twice.
		await parkAt(page, PARKED.lng, PARKED.lat, PARKED.zoom);
		await page.getByRole('button', { name: 'Frame project' }).click();
		await expect.poll(async () => (await viewport(page)).lat).toBeCloseTo(BOSTON_CENTRE.lat, 3);

		await expect(page.getByTestId('opening-view')).toContainText('Framed on this Project');
	});
});

test.describe('the alignment view', () => {
	/**
	 * Reopening a half-finished Alignment lands where the work was left, and nothing after that moves
	 * the map (ADR-0026).
	 *
	 * Both halves in one test because the expensive part is shared: this drives the whole real route —
	 * create a Project, ingest a pyramid, place three pairs — and doing that twice would add half a
	 * minute to a suite already at its contention ceiling (`playwright.config.ts`).
	 *
	 * The Control Points' extent rather than the Resource Mask's, and that is the difference from the
	 * Project screen: with three points placed, the mask is the whole sheet flung across a continent by
	 * a barely-determined solve, and the points are the couple of streets the user was working on.
	 */
});

test.describe('opening a Project', () => {
	test('writes nothing at all', async ({ page }) => {
		// ADR-0010: looking at last year's work must not modify a byte of it. The opening view is the
		// obvious place to break that, because "remember where we put the map" is one field away.
		//
		// **A spy on the write itself, not only on the bytes.** `ProjectStore#write` is not reachable from
		// outside the page — the app builds its own `OpfsProjectStore` — so this patches the primitive
		// every one of its writes goes through, `FileSystemFileHandle#createWritable`, which is also what
		// the atomic temp-file replace uses. Hashes alone would pass a byte-identical rewrite, which is
		// still a modified file to git, to Dropbox, and to `updatedAt`.
		//
		// **And `localStorage`, which the contract names in the same breath and which OPFS says nothing
		// about.** "Remember where we put the map" is one `setItem` away and would leave every file on
		// disk untouched, so the two spies together are what the sentence actually claims.
		await page.goto('/');
		await emptyWorkspace(page);
		await seed(page, workspaceFiles({ layers: [{ kind: 'annotation', id: 'l-pins' }] }));
		const before = await hashesUnder(page);

		await watchWrites(page);
		await page.goto(`/?p=${PROJECT_DIRECTORY}`);
		await settled(page);
		// Framed, so the assertion is about a Project that really did compute and apply an opening view.
		expect((await viewport(page)).lng).toBeCloseTo(BOSTON_CENTRE.lng, 3);

		expect(
			await page.evaluate(() => (window as unknown as MapWindow).ballastellaOpfsWrites ?? [])
		).toEqual([]);
		expect(
			await page.evaluate(() => (window as unknown as MapWindow).ballastellaWebStorageWrites ?? [])
		).toEqual([]);
		expect(await page.evaluate(() => ({ ...window.localStorage }))).toEqual({});
		expect(await hashesUnder(page)).toEqual(before);
	});
});

/**
 * Record every OPFS file opened for writing from now on.
 *
 * Installed through `addInitScript` so that it is in place before the app's first line runs — a spy
 * added afterwards would miss exactly the write that happens during boot.
 */
async function watchWrites(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const names: string[] = [];
		(window as unknown as { ballastellaOpfsWrites?: string[] }).ballastellaOpfsWrites = names;
		const proto = FileSystemFileHandle.prototype;
		const original = proto.createWritable;
		proto.createWritable = function (
			this: FileSystemFileHandle,
			options?: FileSystemCreateWritableOptions
		) {
			names.push(this.name);
			return original.call(this, options);
		};

		// `Storage.prototype`, so `localStorage` and `sessionStorage` are both covered by one patch and
		// neither can be the place a remembered viewport quietly lands.
		const web: string[] = [];
		(window as unknown as { ballastellaWebStorageWrites?: string[] }).ballastellaWebStorageWrites =
			web;
		const storage = Storage.prototype;
		const setItem = storage.setItem;
		storage.setItem = function (this: Storage, key: string, value: string) {
			web.push(`set ${key}`);
			return setItem.call(this, key, value);
		};
		const removeItem = storage.removeItem;
		storage.removeItem = function (this: Storage, key: string) {
			web.push(`remove ${key}`);
			return removeItem.call(this, key);
		};
		const clear = storage.clear;
		storage.clear = function (this: Storage) {
			web.push('clear');
			return clear.call(this);
		};
	});
}

/**
 * Every file in the **whole Workspace**, as a sha256 per path. The bytes are the assertion.
 *
 * The Workspace and not the Project, because a Map Image's Alignment and its pyramid live at the
 * Workspace root now (ADR-0023): a fit that touched an Alignment would leave a Project directory
 * byte-identical, and hashing only that would say nothing about the file it had written.
 */
async function hashesUnder(page: Page): Promise<string[]> {
	const files = await page.evaluate(async () => {
		const out: [string, number[]][] = [];
		const root = await workspaceRoot();
		const walk = async (handle: FileSystemDirectoryHandle, at: string): Promise<void> => {
			for await (const [name, entry] of handle.entries()) {
				const path = at === '' ? name : `${at}/${name}`;
				if (entry.kind === 'directory') {
					await walk(entry as FileSystemDirectoryHandle, path);
				} else {
					const bytes = await (await (entry as FileSystemFileHandle).getFile()).arrayBuffer();
					out.push([path, [...new Uint8Array(bytes)]]);
				}
			}
		};
		await walk(root, '');
		return out.sort(([a], [b]) => a.localeCompare(b));
	});
	return files.map(
		([path, bytes]) => `${path} ${createHash('sha256').update(Buffer.from(bytes)).digest('hex')}`
	);
}
