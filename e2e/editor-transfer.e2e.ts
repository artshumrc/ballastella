import { packTar, type TarEntry } from 'modern-tar';
import { readFile } from 'node:fs/promises';

import {
	hashesUnder,
	type StackWindow,
	waitForOpeningView,
	waitForPaintedAnnotations,
	waitForStack
} from './support/annotations.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { layerRows, openLayerRow } from './support/layers.js';
import { openProjectSettings } from './support/project-screen.js';
import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';
import {
	closeWorkspaceSettings,
	createWorkspace,
	expectWorkspaceNamed,
	openPublishFromTheDoor,
	openWorkspaceMenu,
	openWorkspaceSettings,
	seedRemoteRelationship,
	switchToWorkspace
} from './support/workspace.js';

/**
 * Seam 2 for transfer: handing a Project over and reviewing one, driven through the UI against real
 * OPFS.
 *
 * The bundle format itself, the round trip's fidelity, and every rejection are asserted at Seam 1 in
 * `@ballastella/core`. What only a browser can show is here — that a real download arrives with the
 * right name and contents; that a bundle chosen through a file input lands in a **separate**
 * Workspace; that the user's own Workspace is byte-for-byte what it was; that the banner is on every
 * screen and its two exits work from the keyboard; and that two review copies of the same sheet never
 * see each other's Alignment.
 *
 * The fixture archives are built here in Node rather than exported by the app, so opening is tested
 * against bundles the app did not make — which is the only kind it will ever receive.
 */

/** Every named Workspace in the OPFS root, sorted. */
async function workspaceNames(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const [name, handle] of root.entries()) {
			if (handle.kind === 'directory') names.push(name);
		}
		return names.sort();
	});
}

/**
 * Empty the origin's OPFS, so no test can see another's Projects or another's review copies.
 *
 * ⚠ **The Workspace the app is holding open is emptied, not removed.** `DirectoryHandleStore` caches
 * its root handle once it resolves (ADR-0008), and that handle is a *named subdirectory* rather than
 * the OPFS root; deleting the directory out from under a running app latches it "unreachable" until
 * a reload, which is a state about the harness rather than about the product.
 */
async function emptyEverything(page: Page): Promise<void> {
	await page.evaluate(async () => {
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
	// The app remembers which Workspace it was in across a reload, and a spec that ended inside a
	// review copy would otherwise start the next one there — pointing `workspaceRoot()` at a Workspace
	// that has just been deleted.
	await page.evaluate(() => {
		localStorage.removeItem('ballastella.workspace');
		localStorage.removeItem('ballastella.own-workspace');
		// And which *folder* was the user's own, which is the third of the three and the one whose
		// absence would send this suite's "back to my Workspace" through a picker.
		localStorage.removeItem('ballastella.own-folder');
	});
}

/**
 * Every path and every byte of one named Workspace.
 *
 * ⚠ **This is the "byte-identical before and after" claim, and it is the easiest one here to fake.**
 * Asserting that the Project list is unchanged would pass while an Alignment had been overwritten, so
 * this lists every path and reads every byte — the contents, not a count, not a listing, and not a
 * size.
 */
async function everyByteOf(page: Page, workspace: string): Promise<Record<string, string>> {
	return page.evaluate(async (workspace) => {
		const files: Record<string, string> = {};
		const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
			for await (const [name, entry] of handle.entries()) {
				if (entry.kind === 'file') {
					files[`${prefix}${name}`] = await (
						await (entry as FileSystemFileHandle).getFile()
					).text();
				} else {
					await walk(entry as FileSystemDirectoryHandle, `${prefix}${name}/`);
				}
			}
		};
		const root = await navigator.storage.getDirectory();
		await walk(await root.getDirectoryHandle(workspace), '');
		return files;
	}, workspace);
}

/**
 * Write a Project straight into the open Workspace, bypassing the app.
 *
 * The shared material goes to the Workspace root and the Project's own files inside `directory`,
 * which is ADR-0023's split — so a seeded Workspace is one the application could really have
 * produced.
 */
async function seedProject(
	page: Page,
	directory: string,
	files: Record<string, string>
): Promise<void> {
	await page.evaluate(
		async ([directory, files]) => {
			const shared = (path: string) => path.startsWith('images/') || path.startsWith('alignments/');
			const root = await workspaceRoot();
			for (const [path, text] of Object.entries(files as Record<string, string>)) {
				const segments = path.split('/');
				let handle = shared(path)
					? root
					: await root.getDirectoryHandle(directory as string, { create: true });
				for (const segment of segments.slice(0, -1)) {
					handle = await handle.getDirectoryHandle(segment, { create: true });
				}
				const file = await handle.getFileHandle(segments[segments.length - 1], { create: true });
				const writable = await file.createWritable();
				await writable.write(text);
				await writable.close();
			}
		},
		[directory, files] as [string, Record<string, string>]
	);
}

const IMAGE_WIDTH = 4096;
const IMAGE_HEIGHT = 3072;

/**
 * The Annotation Layer's `FeatureCollection`, with something actually in it.
 *
 * ⚠ **An empty `{"features":[]}` makes the reading claim unassertable.** "Explore it as though it
 * were your own — pan the map, toggle Layers, read Annotations" cannot be checked against a Layer
 * with nothing in it: every assertion about reading a colleague's Annotation would pass over an empty
 * collection. The coordinates are where the Project's own Alignment puts the sheet, so the
 * Annotation is on screen when the Project opens on its own content (ADR-0026).
 */
const WAREHOUSES_GEOJSON = JSON.stringify({
	type: 'FeatureCollection',
	features: [
		{
			type: 'Feature',
			// An explicit id: `parseAnnotations` mints one otherwise and the test could not address it.
			id: '11111111-1111-4111-8111-111111111111',
			geometry: { type: 'Point', coordinates: [4.9, 52.3676] },
			properties: {
				title: 'The west quay',
				description: 'Bonded warehouses, still standing in 1625.',
				'marker-size': 'large',
				'marker-color': '#cc0000'
			}
		}
	]
});

/** A Label as another GeoJSON tool writes it: a Point with simplestyle properties. */
const ZUIDERZEE_GEOJSON = JSON.stringify({
	type: 'FeatureCollection',
	features: [
		{
			type: 'Feature',
			id: 'label',
			geometry: { type: 'Point', coordinates: [4.9, 52.3676] },
			properties: {
				'marker-symbol': 'label',
				title: 'Zuiderzee',
				'marker-color': '#ffffff',
				fill: '#1976d2',
				'fill-opacity': 0.8,
				'marker-size': 'large'
			}
		}
	]
});

/** Where a sheet lands on the earth, as the box its four Control Points describe. */
type SheetBox = { west: number; east: number; south: number; north: number };

const AMSTERDAM: SheetBox = { west: 4.88, east: 4.92, south: 52.36, north: 52.375 };
const BOSTON: SheetBox = { west: -71.07, east: -71.04, south: 42.34, north: 42.37 };

/**
 * A real Georeference Annotation over the fixture sheet, placing it on `at`.
 *
 * Used where the assertion is about **what a Review Workspace draws** rather than about bytes.
 * `{"type":"Annotation","controlPoints":"student A"}` is enough to tell two files apart on disk and
 * not enough to place a sheet anywhere, so a test built on it can only ever compare bytes — which is
 * what `project-bundle.test.ts` already does, in Node, without a browser.
 */
const alignmentJson = (at: SheetBox): string =>
	`${JSON.stringify(
		{
			type: 'Annotation',
			'@context': [
				'http://iiif.io/api/extension/georef/1/context.json',
				'http://iiif.io/api/presentation/3/context.json'
			],
			motivation: 'georeferencing',
			target: {
				type: 'SpecificResource',
				source: {
					id: 'https://unset.invalid/amsterdam-1625',
					type: 'ImageService3',
					height: IMAGE_HEIGHT,
					width: IMAGE_WIDTH
				},
				selector: {
					type: 'SvgSelector',
					value:
						`<svg width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}">` +
						`<polygon points="0,0 ${IMAGE_WIDTH},0 ${IMAGE_WIDTH},${IMAGE_HEIGHT} 0,${IMAGE_HEIGHT}" />` +
						`</svg>`
				}
			},
			body: {
				type: 'FeatureCollection',
				transformation: { type: 'polynomial', options: { order: 1 } },
				features: (
					[
						[
							[0, 0],
							[at.west, at.north]
						],
						[
							[IMAGE_WIDTH, 0],
							[at.east, at.north]
						],
						[
							[IMAGE_WIDTH, IMAGE_HEIGHT],
							[at.east, at.south]
						],
						[
							[0, IMAGE_HEIGHT],
							[at.west, at.south]
						]
					] as [[number, number], [number, number]][]
				).map(([resourceCoords, coordinates]) => ({
					type: 'Feature',
					properties: { resourceCoords },
					geometry: { type: 'Point', coordinates }
				}))
			}
		},
		null,
		'\t'
	)}\n`;

/**
 * A Project that has been handed on twice: published on somebody's site, then sent as a bundle.
 *
 * Written as the file spells it, because that is how a real imported Project arrives — the editor
 * reads this history rather than being told one.
 */
const IMPORT_PROVENANCE = [
	{
		kind: 'github',
		owner: 'ada',
		repository: 'atlas',
		branch: 'main',
		directory: 'amsterdam-1625',
		commit: '9f2c1de4b7a80315c6e5d2f9a1b8c7d6e5f40312',
		observedAt: '2026-08-01T10:00:00.000Z',
		evidence: 'inherited'
	},
	{
		kind: 'project-bundle',
		filename: 'amsterdam-1625.project.tar',
		projectName: 'Amsterdam 1625',
		observedAt: '2026-08-22T09:30:00.000Z',
		evidence: 'observed'
	}
];

const projectJson = (overrides: Record<string, unknown> = {}) =>
	`${JSON.stringify(
		{
			formatVersion: 1,
			name: 'Amsterdam 1625',
			updatedAt: '2025-03-04T11:22:33.000Z',
			layers: [
				{
					id: 'l1',
					kind: 'annotation',
					name: 'Warehouses',
					visible: true,
					order: 0,
					geojsonRef: 'annotations/warehouses.geojson',
					defaultStyle: {}
				},
				// A map Layer, because since ADR-0023 an export gathers the Workspace Map Images a
				// Project's **Layers reference**. Without this the bundle would legitimately hold no
				// `images/`, and every assertion below about a self-contained archive would be vacuous.
				{
					id: 'l2',
					kind: 'map',
					name: 'The 1625 plan',
					visible: true,
					order: 1,
					opacity: 1,
					imageId: 'amsterdam-1625'
				}
			],
			baseMap: null,
			...overrides
		},
		null,
		'\t'
	)}\n`;

/**
 * A Project's whole archive, so "every file" means more than `project.json`.
 *
 * These are archive paths and ADR-0023 changed none of them: `images/` and `alignments/` are the
 * Workspace's and sit at its root, while `project.json` and `annotations/` stay inside the Project
 * directory. {@link seedProject} is where that split is applied.
 */
const projectFiles = (overrides: Record<string, string> = {}): Record<string, string> => ({
	'project.json': projectJson(),
	'annotations/warehouses.geojson': WAREHOUSES_GEOJSON,
	// alignment-write-is-the-fixture: the Workspace this spec exports and opens, laid down before the app starts
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'stands in for a tile',
	...overrides
});

async function buildBundle(files: Record<string, string>): Promise<Buffer> {
	const encode = (text: string) => new TextEncoder().encode(text);
	const entries: TarEntry[] = Object.entries(files).map(([name, text]) => ({
		header: { name, size: encode(text).length, type: 'file' },
		body: encode(text)
	}));
	return Buffer.from(await packTar(entries));
}

const bundleFixture = async (
	files: Record<string, string>,
	name = 'amsterdam-1625.project.tar'
): Promise<{ name: string; mimeType: string; buffer: Buffer }> => ({
	name,
	mimeType: 'application/x-tar',
	buffer: await buildBundle(files)
});

/** Open the "Review a Project" dialog and hand it a file, without confirming. */
async function chooseBundle(
	page: Page,
	fixture: { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
	await page.getByTestId('open-bundle').click();
	await page
		.getByRole('dialog', { name: 'Review a Project' })
		.getByLabel('Project bundle')
		.setInputFiles(fixture);
}

/** Choose a bundle and press the button, and wait for the review copy to be on screen. */
async function openBundle(
	page: Page,
	fixture: { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
	await chooseBundle(page, fixture);
	await page.getByTestId('confirm-open-bundle').click();
	// ⚠ **The gesture is not over until the dialog has gone.** Opening a bundle *switches Workspaces*,
	// and the banner appears part-way through that — before the dialog closes and before focus has been
	// put back. A test that went on to focus something the moment the banner appeared was acting on a
	// page still finishing the interaction, and had that focus taken off it a frame later. Waiting here
	// rather than in each caller: every one of them wants "the bundle is open", not "the banner exists".
	await expect(page.getByRole('dialog', { name: 'Review a Project' })).toBeHidden();
}

const banner = (page: Page) => page.getByTestId('review-banner');

/** The centre of the box a sheet's Control Points describe. */
const centreOf = (at: SheetBox): [number, number] => [
	(at.west + at.east) / 2,
	(at.south + at.north) / 2
];

/** The subset of MapLibre's `Map` this file asks questions of. Real `maplibre-gl` methods. */
type MapWindow = {
	ballastellaBaseMap?: { getBounds(): { contains(at: [number, number]): boolean } };
};

/** Whether the real map, right now, is looking at `at`. */
const showing = (page: Page, at: [number, number]): Promise<boolean> =>
	page.evaluate((point) => {
		const map = (window as unknown as MapWindow).ballastellaBaseMap;
		return map ? map.getBounds().contains(point as [number, number]) : false;
	}, at);

/**
 * Assert the Project opened on `at` and **not** on `other`.
 *
 * Bounds rather than an exact centre: the opening view fits a box with padding and a zoom cap
 * (ADR-0026), so pinning six decimal places would be asserting the arithmetic, which
 * `opening-view.test.ts` already does numerically and without a browser. The negative half is the
 * one that carries the claim — an Alignment that had leaked from the other Review Workspace would
 * put this map on the wrong continent, and only asserting the positive would pass on a map showing
 * both.
 */
async function expectOpenedOn(page: Page, at: SheetBox, other: SheetBox): Promise<void> {
	await expect.poll(() => showing(page, centreOf(at)), { timeout: 20_000 }).toBe(true);
	expect(await showing(page, centreOf(other))).toBe(false);
}

/**
 * The transfer announcement.
 *
 * `[data-transfer]` rather than `getByRole('status')`: the save indicator is on the navigation bar
 * and therefore on the hub too, so the hub has one `status` role of its own and this region is an
 * `aria-live="polite"` one — this repo's settled convention wherever the two meet.
 */
const transferStatus = (page: Page) => page.locator('[data-transfer]');

test.beforeEach(async ({ page }) => {
	await page.goto('./');
	await emptyEverything(page);
	await page.reload();
	await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
});

test.describe('exporting a Project as a bundle', () => {
	test('downloads a tar named for the folder, rooted at the Project, and announces it', async ({
		page
	}) => {
		await seedProject(page, 'amsterdam-1625', projectFiles());
		await page.reload();

		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: /^Export/ }).click();
		const saved = await download;

		expect(saved.suggestedFilename()).toBe('amsterdam-1625.project.tar');
		const { unpackTar } = await import('modern-tar');
		const entries = await unpackTar(new Uint8Array(await readFile(await saved.path())), {
			strict: true
		});
		// Rooted at the Project directory: no `amsterdam-1625/` prefix on anything.
		expect(entries.map((entry) => entry.header.name).sort()).toEqual(
			Object.keys(projectFiles()).sort()
		);
		expect(
			new TextDecoder().decode(entries.find((entry) => entry.header.name === 'project.json')!.data!)
		).toBe(projectJson());

		// Progress is announced, not merely drawn.
		await expect(transferStatus(page)).toHaveText(/Exported Amsterdam 1625: 5 files\./);
	});

	// A bundle carries the Project it names and the shared material *that Project's Layers reference*,
	// and not the Workspace's other maps. That is the whole difference between a handoff and a backup,
	// so it is asserted at the seam where a real Workspace holds both.
	test('leaves the Workspace’s other Map Images out of it', async ({ page }) => {
		await seedProject(page, 'amsterdam-1625', projectFiles());
		await seedProject(page, 'the-canal-ring', {
			'project.json': projectJson({ name: 'The Canal Ring', layers: [] }),
			'images/blaeu-1649/info.json': '{"width":2048,"height":2048}',
			// alignment-write-is-the-fixture: the other map's Alignment, seeded so that leaving it out of the bundle is assertable
			'alignments/blaeu-1649.json': '{"type":"Annotation","id":"blaeu-1649"}'
		});
		await page.reload();

		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Export Amsterdam 1625' }).click();
		const { unpackTar } = await import('modern-tar');
		const entries = await unpackTar(new Uint8Array(await readFile(await (await download).path())), {
			strict: true
		});

		const names = entries.map((entry) => entry.header.name);
		expect(names.sort()).toEqual(Object.keys(projectFiles()).sort());
		expect(names).not.toContain('images/blaeu-1649/info.json');
		expect(names).not.toContain('alignments/blaeu-1649.json');
	});

	test('keeps the Export button focusable while an export runs', async ({ page }) => {
		// `disabled` takes a pressed button out of the tab order, so focus fell to `<body>` for the
		// length of the export and was never restored — leaving a keyboard user to tab in from the top
		// of the page after every one.
		await seedProject(page, 'amsterdam-1625', projectFiles());
		await page.reload();

		const download = page.waitForEvent('download');
		const exportButton = page.getByRole('button', { name: /^Export/ });
		await exportButton.focus();
		await page.keyboard.press('Enter');
		await download;

		await expect(transferStatus(page)).toHaveText(/Exported/);
		await expect(exportButton).toBeFocused();
	});

	test('exports a Project this build refuses to open (ADR-0010)', async ({ page }) => {
		// The Project a user most needs out of a browser they cannot see into is the one that will not
		// open, so Export is deliberately not disabled for it.
		await seedProject(page, 'from-the-future', {
			'project.json': '{"formatVersion":99,"name":"Tomorrow","layers":[]}'
		});
		await page.reload();
		await expect(page.getByText('Made with a newer version of Ballastella.')).toBeVisible();

		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: /^Export/ }).click();
		const { unpackTar } = await import('modern-tar');
		const entries = await unpackTar(new Uint8Array(await readFile(await (await download).path())), {
			strict: true
		});

		expect(
			new TextDecoder().decode(entries.find((entry) => entry.header.name === 'project.json')!.data!)
		).toBe('{"formatVersion":99,"name":"Tomorrow","layers":[]}');
	});

	test('says so when an export fails, rather than blanking the status line', async ({ page }) => {
		await seedProject(page, 'amsterdam-1625', projectFiles());
		await page.reload();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();

		// Delete it underneath the open hub, the way a second tab would.
		await page.evaluate(async () => {
			const root = await workspaceRoot();
			await root.removeEntry('amsterdam-1625', { recursive: true });
		});
		await page.getByRole('button', { name: /^Export/ }).click();

		const alert = page.getByRole('alert');
		await expect(alert).toBeVisible();
		await expect(alert).toContainText('project.json');
	});
});

test.describe('merely opening a Project leaves its files unchanged', () => {
	/**
	 * ⚠ **The Import Provenance assertions are folded in here, and the fold is the argument.**
	 *
	 * "Read-only" is two claims: that a reader can see the history, and that seeing it writes nothing.
	 * The second is exactly what this test already measures over every file in the Workspace, so the
	 * history is seeded into the same Project rather than into a spec of its own — and the metadata
	 * permutations behind it are proved at Seam 1 in `project-import-provenance.test.ts`, which is where
	 * that kind of claim belongs.
	 *
	 * The Project is seeded with a history rather than imported through the UI because Import has no UI
	 * yet. What is asserted here is the surface that does exist — the Project screen showing a transfer
	 * history it will not let anyone edit.
	 */
	test('merely opening a Project with a Label leaves every Project file hash-identical', async ({
		page
	}) => {
		await routeBaseMapArchive(page);
		await seedProject(
			page,
			'amsterdam-1625',
			projectFiles({
				'annotations/warehouses.geojson': ZUIDERZEE_GEOJSON,
				'project.json': projectJson({ importProvenance: IMPORT_PROVENANCE })
			})
		);
		await page.reload();
		const before = await hashesUnder(page, '');

		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await waitForOpeningView(page);
		await waitForStack(page);
		await waitForPaintedAnnotations(page, ['label']);

		const settings = await openProjectSettings(page);
		const history = settings.getByTestId('import-provenance');
		await expect(history).toContainText('read-only record of the transfers');
		// Not attribution, said in the words the section itself uses.
		await expect(history).toContainText('does not say who made the work');

		const entries = history.getByTestId('provenance-entry');
		await expect(entries).toHaveCount(2);
		// The carried entry first, and identified as carried rather than as something checked here.
		await expect(entries.nth(0)).toHaveAttribute('data-provenance-evidence', 'inherited');
		await expect(entries.nth(0)).toContainText('ada/atlas');
		await expect(entries.nth(0)).toContainText('9f2c1de4b7a80315c6e5d2f9a1b8c7d6e5f40312');
		await expect(entries.nth(0)).toContainText('not checked here');
		await expect(entries.nth(1)).toHaveAttribute('data-provenance-evidence', 'observed');
		await expect(entries.nth(1)).toContainText('amsterdam-1625.project.tar');
		await expect(entries.nth(1)).toContainText('Seen by Ballastella');
		// Read-only on the screen as well as on disk: the history offers nothing to change it with,
		// where the name beside it is a field.
		await expect(history.getByRole('textbox')).toHaveCount(0);
		await expect(history.getByRole('button')).toHaveCount(0);
		await expect(settings.getByTestId('project-name-input')).toBeVisible();

		// Let the 400 ms autosave debounce and any resulting flush complete.
		await page.waitForTimeout(600);

		expect(await hashesUnder(page, '')).toEqual(before);
	});
});

test.describe('opening a bundle lands in a review copy', () => {
	test('creates a separate Workspace holding exactly that one Project', async ({ page }) => {
		await openBundle(page, await bundleFixture(projectFiles()));

		// A **different** Workspace, beside the user's own rather than inside it.
		await expect(banner(page)).toBeVisible();
		expect(await workspaceNames(page)).toEqual(['My Workspace', 'amsterdam-1625']);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		expect(await everyByteOf(page, 'amsterdam-1625')).toEqual({
			'review.json': expect.any(String),
			'amsterdam-1625/project.json': projectJson(),
			'amsterdam-1625/annotations/warehouses.geojson': WAREHOUSES_GEOJSON,
			// alignment-write-is-the-fixture: the Alignment a bundle fixture carries, and the one seeded on disk that opening it must not touch
			'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
			'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
			'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'stands in for a tile'
		});
	});

	test('opens a bundled Label in the review copy with its words and colours drawn', async ({
		page
	}) => {
		await routeBaseMapArchive(page);
		await openBundle(
			page,
			await bundleFixture(projectFiles({ 'annotations/warehouses.geojson': ZUIDERZEE_GEOJSON }))
		);
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await waitForPaintedAnnotations(page, ['label']);

		const drawn = await page.evaluate(() =>
			(
				(window as unknown as StackWindow).ballastellaLayerStack?.map.queryRenderedFeatures() ?? []
			).map((feature) => ({ layer: feature.layer.id, properties: feature.properties }))
		);

		expect(drawn).toContainEqual(
			expect.objectContaining({
				layer: 'ballastella-layer-l1-label',
				properties: expect.objectContaining({
					'ballastella:id': 'label',
					title: 'Zuiderzee',
					'marker-color': '#ffffff',
					fill: '#1976d2',
					'fill-opacity': 0.8
				})
			})
		);
	});

	// ⚠ **The most important claim here, and the easiest to fake.** Every path and every byte, before
	// and after — asserting on the Project list would pass while an Alignment had been overwritten.
	test('leaves the user’s own Workspace byte-identical, through opening and discarding', async ({
		page
	}) => {
		await seedProject(page, 'my-own-amsterdam', {
			...projectFiles({ 'project.json': projectJson({ name: 'My own Amsterdam' }) }),
			// The **same image id** as the bundle's, with different bytes. This is the collision the
			// whole design exists to prevent: nothing in the bundle may reach this Alignment.
			// alignment-write-is-the-fixture: the Alignment a bundle fixture carries, and the one seeded on disk that opening it must not touch
			'alignments/amsterdam-1625.json': '{"type":"Annotation","controlPoints":"mine, an afternoon"}'
		});
		await page.reload();
		const before = await everyByteOf(page, 'My Workspace');
		expect(Object.keys(before).length).toBeGreaterThan(0);

		await openBundle(
			page,
			await bundleFixture(
				projectFiles({
					// alignment-write-is-the-fixture: the Alignment a bundle fixture carries, and the one seeded on disk that opening it must not touch
					'alignments/amsterdam-1625.json': '{"type":"Annotation","controlPoints":"theirs"}'
				})
			)
		);
		await expect(banner(page)).toBeVisible();
		// Read while the review copy is open, which is when an overwrite would have happened.
		expect(await everyByteOf(page, 'My Workspace')).toEqual(before);

		await page.getByTestId('discard-review').click();
		await page.getByTestId('confirm-discard-review').click();
		await expect(banner(page)).toBeHidden();

		expect(await everyByteOf(page, 'My Workspace')).toEqual(before);
		expect(await workspaceNames(page)).toEqual(['My Workspace']);
	});

	test('names what was opened, and the file that was picked names the Workspace', async ({
		page
	}) => {
		await openBundle(page, await bundleFixture(projectFiles(), 'assignment 3.project.tar'));

		await expect(banner(page)).toContainText('Amsterdam 1625');
		expect(await workspaceNames(page)).toEqual(['My Workspace', 'assignment 3']);
		// And the reader's own sentence reaches a screen, naming the review copy it made. It is the
		// same sentence that carries a declined entry, so a page that dropped it would drop that too.
		await expect(page.getByTestId('bundle-notice')).toContainText('assignment 3');
	});

	// ⚠ **The declined-write path, reached.** `writeRestored`'s decline is unreachable while every
	// destination is a brand-new Workspace; a bundle reaches it, because a tar has no index and nothing
	// stops an archive from naming a path twice. The **first** entry wins, and the second is reported
	// rather than silently overwriting it — a transfer that quietly delivers something other than what
	// it was handed is the failure this format escaped.
	test('says so when a bundle names one Alignment twice, and keeps the first', async ({ page }) => {
		const encode = (text: string) => new TextEncoder().encode(text);
		const files = projectFiles();
		const archive = await packTar([
			...Object.entries(files).map(([name, text]) => ({
				header: { name, size: encode(text).length, type: 'file' as const },
				body: encode(text)
			})),
			{
				header: {
					name: 'alignments/amsterdam-1625.json',
					size: encode('{"second":true}').length,
					type: 'file' as const
				},
				body: encode('{"second":true}')
			}
		]);

		await openBundle(page, {
			name: 'amsterdam-1625.project.tar',
			mimeType: 'application/x-tar',
			buffer: Buffer.from(archive)
		});

		await expect(banner(page)).toBeVisible();
		await expect(page.getByTestId('bundle-notice')).toContainText('alignments/amsterdam-1625.json');
		expect((await everyByteOf(page, 'amsterdam-1625'))['alignments/amsterdam-1625.json']).toBe(
			'{"type":"Annotation","id":"amsterdam-1625"}'
		);
	});

	// Criterion 10's three halves. The containment is structural — a review copy is a different
	// directory in the OPFS root — rather than a filter anybody has to remember.
	test('is absent from the user’s own Project list, backup, and size', async ({ page }) => {
		// Four files, counted, because the third clause below reads a **number** off the screen.
		const own = {
			'project.json': projectJson({ name: 'My own Amsterdam', layers: [] }),
			'annotations/quays.geojson': WAREHOUSES_GEOJSON,
			'images/blaeu-1649/info.json': '{"width":2048,"height":2048}',
			// alignment-write-is-the-fixture: the other map's Alignment, seeded so the Workspace has something to weigh
			'alignments/blaeu-1649.json': '{"type":"Annotation","id":"blaeu-1649"}'
		};
		await seedProject(page, 'my-own-amsterdam', own);
		await page.reload();

		// ⚠ **The third clause, and it was asserted only in this test's title.** From inside the review
		// copy, the user's own Workspace is one the roster offers to delete — and the confirmation
		// names what it weighs, which is the one place in the app a Workspace's size reaches a screen.
		// It counts the user's own four files and **not** the six the bundle brought, which is what
		// "not counted in its size" means. A size computed over the OPFS root would say ten here.
		await openBundle(page, await bundleFixture(projectFiles()));
		await expect(banner(page)).toBeVisible();
		await openWorkspaceMenu(page);
		await page.getByTestId('delete-workspace').click();
		await expect(page.getByTestId('delete-workspace-size')).toContainText(
			`It holds ${Object.keys(own).length} files,`
		);
		// Nothing is deleted: what was wanted was the number.
		await page.getByRole('button', { name: 'Keep it' }).click();

		// Back to the user's own Workspace: the reviewed Project is not in its list.
		await page.getByTestId('leave-review').click();
		await expect(banner(page)).toBeHidden();
		await expect(page.getByRole('link', { name: 'My own Amsterdam' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);

		// And not in a backup of it, nor in what that backup weighs.
		const download = page.waitForEvent('download');
		await openWorkspaceSettings(page);
		await page.getByTestId('back-up-workspace').click();
		const saved = await download;
		const { unpackTar } = await import('modern-tar');
		const entries = await unpackTar(new Uint8Array(await readFile(await saved.path())), {
			strict: true
		});
		const names = entries.map((entry) => entry.header.name);
		expect(names).toContain('My Workspace/my-own-amsterdam/project.json');
		expect(names.filter((name) => name.includes('review.json'))).toEqual([]);
		// ⚠ **This used to filter the entry *paths* for "Amsterdam 1625", a string that only ever
		// appears in `project.json`'s **contents**.** No edit anywhere could make it red. What it was
		// reaching for is asserted two ways instead: every entry is rooted at the user's own Workspace,
		// and no entry's *bytes* carry a word of the reviewed Project.
		expect(names.filter((name) => !name.startsWith('My Workspace/'))).toEqual([]);
		const decoder = new TextDecoder();
		expect(
			entries
				.filter(
					(entry) =>
						entry.data !== undefined && decoder.decode(entry.data).includes('Amsterdam 1625')
				)
				.map((entry) => entry.header.name)
		).toEqual([]);
	});

	test('publishing while a review copy exists publishes only the user’s own Workspace', async ({
		page
	}) => {
		await seedProject(page, 'my-own-amsterdam', {
			'project.json': projectJson({ name: 'My own Amsterdam', layers: [] })
		});
		// Publishing is a landing of the door, and the door lands there only for a Workspace that has
		// somewhere to publish to (ADR-0041) — so the relationship is seeded rather than the dialog
		// being reached over a Workspace bound to nothing. No credential goes with it: the plan this
		// asserts is a walk of the Workspace, and nothing is asked of GitHub without one.
		await seedRemoteRelationship(page, { owner: 'ada', repository: 'atlas' });
		await page.reload();
		await openBundle(page, await bundleFixture(projectFiles()));
		await expect(banner(page)).toBeVisible();

		// There is no way to a publish inside a review copy at all: the door itself is absent.
		await expect(page.getByTestId('connect-to-github')).toHaveCount(0);
		await expect(page.getByTestId('review-workspace-note')).toBeVisible();

		await page.getByTestId('leave-review').click();
		await expect(banner(page)).toBeHidden();
		await openPublishFromTheDoor(page);
		const dialog = page.getByRole('dialog', { name: /Publish/ });
		await expect(dialog).toBeVisible();
		// The dialog counts the Projects it is about to publish, and counts **one** — the user's own.
		// The reviewed Project is in another Workspace entirely and is not among them.
		await expect(dialog).toContainText('will carry');
		await expect(dialog).toContainText('1 Project');
	});

	// ⚠ **The collision this whole design exists to prevent.** The same image id in both bundles with
	// *different* Control Points, and **each Review Workspace shows its own**.
	//
	// The first cut of this asserted disk bytes, which is what `project-bundle.test.ts` already proves
	// in Node with no browser: two files with different contents stayed different. That is not the
	// claim. The claim is that a scholar switching between two students' submissions sees each
	// student's placement of the sheet, so the two Alignments here are **real Georeference
	// Annotations that put the same sheet in different places on the earth** — Amsterdam and Boston —
	// and what is read is the map's own centre, once the Project has opened on its own content
	// (ADR-0026). An Alignment that had leaked across would put the map on the wrong continent.
	test('two review copies show their own Alignment of the same sheet', async ({ page }) => {
		await routeBaseMapArchive(page);
		// The map Layer alone. An Annotation over Amsterdam in both submissions would put the opening
		// view halfway across the Atlantic for the Boston one, and the question here is where the
		// *sheet* was placed.
		const sheetOnly = projectJson({
			layers: [
				{
					id: 'l2',
					kind: 'map',
					name: 'The 1625 plan',
					visible: true,
					order: 0,
					opacity: 1,
					imageId: 'amsterdam-1625'
				}
			]
		});
		const submission = async (student: string, at: SheetBox) => {
			await openBundle(
				page,
				await bundleFixture(
					{
						'project.json': sheetOnly,
						// alignment-write-is-the-fixture: the Alignment a bundle fixture carries, packed into a tar here; nothing writes one through the app
						'alignments/amsterdam-1625.json': alignmentJson(at),
						'images/amsterdam-1625/info.json': `{"width":${IMAGE_WIDTH},"height":${IMAGE_HEIGHT}}`
					},
					`${student}.project.tar`
				)
			);
			await expect(banner(page)).toBeVisible();
		};

		await submission('student A', AMSTERDAM);
		await page.getByTestId('leave-review').click();
		await expect(banner(page)).toBeHidden();
		await submission('student B', BOSTON);

		expect(await workspaceNames(page)).toEqual(['My Workspace', 'student A', 'student B']);

		// Student B's, which is the one that is open. A Project opens framed on what it has placed on
		// the earth (ADR-0026), so where the map is looking *is* this Workspace's Alignment — read off
		// MapLibre rather than off disk.
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expectOpenedOn(page, BOSTON, AMSTERDAM);

		// And student A's, one gesture away, which is what a teacher marking thirty needs.
		await page.goto('./');
		await switchToWorkspace(page, 'student A');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expectOpenedOn(page, AMSTERDAM, BOSTON);

		// The switcher says which is which, so a user knows what they are stepping into.
		await openWorkspaceMenu(page);
		await expect(
			page.getByTestId('switch-workspace').filter({ hasText: 'student B' })
		).toContainText('review copy');
	});

	// Criterion 9, as ADR-0037 leaves it. There is still no "keep this", no "save a copy" and no
	// "promote": promotion is the Alignment collision arriving through a convenience, and Import is
	// not one — it is a deliberate copy into a named Workspace, with fresh Map Image identities, and
	// it says so before it is confirmed.
	test('offers nothing that promotes or merges the reviewed Project', async ({ page }) => {
		await openBundle(page, await bundleFixture(projectFiles()));
		await expect(banner(page)).toBeVisible();

		for (const forbidden of [
			/keep this/i,
			/copy to my workspace/i,
			/save a copy/i,
			/promote/i,
			/move to my workspace/i
		]) {
			await expect(page.getByRole('button', { name: forbidden })).toHaveCount(0);
		}
		// The one control that *could* have grown into it — the hub's own duplicate — copies inside
		// this Workspace and cannot reach another one, so the review copy still has it and it is still
		// harmless. What must not exist is a route out.
		await expect(page.getByTestId('open-bundle')).toHaveCount(0);
	});

	// ⚠ **"Explore it as though it were your own", named as three things: pan the map, toggle Layers,
	// read Annotations.** All three are driven here, against a fixture whose `FeatureCollection` has
	// something in it — an empty one cannot carry an assertion about reading a colleague's Annotation
	// even in principle.
	test('is explored as though it were the reader’s own: panned, toggled, and read', async ({
		page
	}) => {
		await routeBaseMapArchive(page);
		await openBundle(page, await bundleFixture(projectFiles()));
		await expect(banner(page)).toBeVisible();
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();

		// **Read the Annotations.** Somebody else's scholarship, on somebody else's Layer, opened and
		// read in the ordinary way — which is the whole of what a review copy is for.
		const notes = layerRows(page).filter({ hasText: 'Warehouses' });
		await openLayerRow(page, notes);
		await expect(page.getByTestId('annotation-row-name')).toHaveText('The west quay');
		await page.getByTestId('annotation-row').click();
		// Read as text, which is how a review copy is read: no field is opened to see it. The title is
		// the Inspector header's, which is the one place the panel names its Annotation.
		await expect(page.getByTestId('annotation-inspector-name')).toHaveText('The west quay');
		await expect(page.getByTestId('annotation-description-text')).toContainText(
			'Bonded warehouses, still standing in 1625.'
		);

		// **Toggle a Layer.** MapLibre's own account of what is drawn, so this is the map rather than
		// the checkbox reporting on itself.
		const drawn = (): Promise<string[]> =>
			page.evaluate(
				() =>
					(
						window as unknown as { ballastellaLayerStack?: { map: { getLayersOrder(): string[] } } }
					).ballastellaLayerStack?.map
						.getLayersOrder()
						.filter((id) => id.startsWith('ballastella-layer-')) ?? []
			);
		await expect.poll(drawn).not.toEqual([]);
		const before = await drawn();
		await notes.getByTestId('layer-visible').uncheck();
		await expect.poll(drawn).not.toEqual(before);
		await notes.getByTestId('layer-visible').check();
		await expect.poll(drawn).toEqual(before);

		// **Pan the map**, with a real pointer drag, and land somewhere else. Nothing about a review
		// copy is read-only (ADR-0024), and the map is the first thing a reader touches.
		//
		// ⚠ **Not from the middle of the pane.** The Project opens framed on its own content, which here
		// is one Pin, so the middle of the pane is exactly where that Pin is — and the row clicked above
		// selected it, which puts its draggable vertex handle there. A drag begun on the handle moves the
		// Annotation rather than the map, which is what a vertex handle is for. A quarter of the way up
		// is empty geography, and panning is what is being asserted.
		const pane = page.getByTestId('base-map-pane');
		const box = await pane.boundingBox();
		if (!box) throw new Error('the map pane has no box to drag');
		const from: [number, number] = [box.x + box.width / 2, box.y + box.height / 4];
		const here = (): Promise<[number, number]> =>
			page.evaluate(() => {
				const map = (
					window as unknown as {
						ballastellaBaseMap?: { getCenter(): { lng: number; lat: number } };
					}
				).ballastellaBaseMap;
				return [map?.getCenter().lng ?? 0, map?.getCenter().lat ?? 0] as [number, number];
			});
		const start = await here();
		await page.mouse.move(from[0], from[1]);
		await page.mouse.down();
		for (let step = 1; step <= 6; step += 1) {
			await page.mouse.move(from[0] - (200 * step) / 6, from[1]);
		}
		await page.mouse.up();
		await expect.poll(async () => (await here())[0] > start[0]).toBe(true);

		// And none of it reached the user's own Workspace, which is the property all three are safe by.
		expect(await workspaceNames(page)).toEqual(['My Workspace', 'amsterdam-1625']);
	});

	test('a review copy is editable, which is deliberate', async ({ page }) => {
		// A teacher demonstrating a fix is a real use (ADR-0024). Nothing is ever written back to the
		// bundle file, which is a property of there being no writer for it at all.
		await openBundle(page, await bundleFixture(projectFiles()));
		await expect(banner(page)).toBeVisible();

		await page.getByRole('button', { name: 'Rename Amsterdam 1625' }).click();
		const dialog = page.getByRole('dialog', { name: 'Rename Project' });
		await dialog.getByLabel('New name').fill('Amsterdam 1625, marked');
		await dialog.getByRole('button', { name: 'Rename' }).click();

		await expect(page.getByRole('link', { name: 'Amsterdam 1625, marked' })).toBeVisible();
	});
});

test.describe('the review banner is on every screen', () => {
	test.beforeEach(async ({ page }) => {
		await openBundle(page, await bundleFixture(projectFiles()));
		await expect(banner(page)).toBeVisible();
	});

	test('on the hub, on the Project screen, and on the alignment route', async ({ page }) => {
		// The alignment route draws a Base Map, and no test in this suite may reach the network — a
		// recorded decision, and the reason `demo-bucket.protomaps.com` turning 404 must not be able to
		// turn this suite red for a reason that has nothing to do with the banner.
		await routeBaseMapArchive(page);
		// The hub.
		await expect(banner(page)).toContainText('Amsterdam 1625');

		// The Project screen — one of the two screens a user forgets where they are on.
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(banner(page)).toBeVisible();
		await expect(banner(page)).toContainText('Amsterdam 1625');

		// And the alignment route, which is the other one.
		//
		// ⚠ **`layer=`, not `image=`.** The route is keyed by Layer id; `?image=` matches nothing and
		// lands on the "no Layer" alert, so this asserted the banner over a *different screen* from the
		// one it names. `l2` is the map Layer in `projectJson` above.
		await page.goto('./align/?p=amsterdam-1625&layer=l2');
		await expect(page.getByTestId('no-layer')).toHaveCount(0);
		await expect(banner(page)).toBeVisible();
		await expect(banner(page)).toContainText('Amsterdam 1625');
	});

	test('survives a reload, because the mark is on the Workspace and not in this tab', async ({
		page
	}) => {
		// A banner kept only in memory would vanish on a reload, and the user would be inside a
		// throwaway Workspace with nothing on screen saying so — which is exactly the "mode you can
		// forget you are in" ADR-0024 rules out.
		await page.reload();

		await expect(banner(page)).toBeVisible();
		await expect(banner(page)).toContainText('Amsterdam 1625');
	});

	test('is reachable as a landmark, with both exits as real buttons', async ({ page }) => {
		const region = page.getByRole('region', { name: 'Review copy' });
		await expect(region).toBeVisible();
		await expect(region.getByRole('button', { name: 'Back to my Workspace' })).toBeVisible();
		await expect(region.getByRole('button', { name: 'Discard this review copy' })).toBeVisible();
	});

	test('both exits work from the keyboard alone', async ({ page }) => {
		const back = page.getByTestId('leave-review');
		await back.focus();
		await expect(back).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(banner(page)).toBeHidden();

		// And the other one, on a second review copy.
		await openBundle(page, await bundleFixture(projectFiles()));
		await expect(banner(page)).toBeVisible();
		const discard = page.getByTestId('discard-review');
		await discard.focus();
		await expect(discard).toBeFocused();
		await page.keyboard.press('Enter');
		const dialog = page.getByRole('dialog', { name: 'Discard this review copy' });
		await expect(dialog).toBeVisible();
		const confirm = page.getByTestId('confirm-discard-review');
		await confirm.focus();
		await page.keyboard.press('Enter');

		// The announcement before the listing, for the reason spelled out at "discarding removes the
		// Workspace and every file in it" below: the banner goes when the *leave* half lands, which is
		// before the directory has been removed, so `toBeHidden()` is not a point at which OPFS may be
		// read. This spec had the same race and did not get the same fix.
		await expect(page.getByTestId('review-announcement')).toContainText('Discarded');
		await expect(banner(page)).toBeHidden();
		// Only the discarded one went; the one that was merely left is still there.
		expect(await workspaceNames(page)).toEqual(['My Workspace', 'amsterdam-1625']);
	});

	// `showModal()` is mandated rather than merely available (ADR-0016), and Escape is the property
	// that distinguishes it from the checkbox-hack modals daisyUI still documents.
	test('the discard confirmation is a real modal, dismissible with Escape', async ({ page }) => {
		await page.getByTestId('discard-review').click();
		const dialog = page.getByRole('dialog', { name: 'Discard this review copy' });
		await expect(dialog).toBeVisible();
		expect(
			await dialog.evaluate((element) => (element as HTMLDialogElement).matches(':modal'))
		).toBe(true);
		await expect(page.getByTestId('discard-review-consequence')).toBeVisible();

		await page.keyboard.press('Escape');

		await expect(dialog).toBeHidden();
		// Nothing was discarded, which is what a confirmation is for.
		await expect(banner(page)).toBeVisible();
		expect(await workspaceNames(page)).toEqual(['My Workspace', 'amsterdam-1625']);
	});

	test('discarding removes the Workspace and every file in it', async ({ page }) => {
		await page.getByTestId('discard-review').click();
		await page.getByTestId('confirm-discard-review').click();

		// ⚠ **The announcement first, and the order is the assertion's correctness rather than its
		// style.** Discarding is leave-then-delete — `deleteWorkspace` refuses the open Workspace — so
		// the banner goes as soon as the *leave* half lands, which is before the directory has been
		// removed. Waiting on `toBeHidden()` and then listing OPFS therefore read the root in the gap
		// between the two halves, and saw the review copy still there; measured, as a retry, on a run
		// where every other assertion passed. The announcement is set only after `discardReview()` has
		// resolved, so it is the first thing on screen that means "the whole of it is done".
		await expect(page.getByTestId('review-announcement')).toContainText('Discarded');
		await expect(banner(page)).toBeHidden();
		expect(await workspaceNames(page)).toEqual(['My Workspace']);
	});

	// ⚠ **Watched rather than sampled, because the window is internal to one awaited call.**
	// `discardReview` is leave-then-delete, and the switcher is drawn from `storage.workspaces` on
	// every screen. Between the two halves the review copy is no longer open — so a click on its item
	// no longer short-circuits — and its directory is being removed, so the click ran
	// `getDirectoryHandle({ create: true })` against a `removeEntry` on the same directory. No
	// `expect` afterwards can see that window: by the time the announcement lands it has closed. A
	// `MutationObserver` recording the pair "is it still offered / is the banner still up" turns it
	// into a fact about the order the two fields change in, which is the thing that was wrong.
	test('takes the doomed Workspace off the switcher before it starts, not after it ends', async ({
		page
	}) => {
		await page.evaluate(() => {
			const sample = () => ({
				// The switcher's popover is in the document at all times — `MenuPopover` renders it and
				// the top layer hides it — so this reads the live listing without opening a menu, which
				// a click on the banner would close again anyway.
				offered: [...document.querySelectorAll('[data-testid="switch-workspace"]')].some(
					(item) => (item as HTMLElement).dataset.workspace === 'amsterdam-1625'
				),
				reviewing: document.querySelector('[data-testid="review-banner"]') !== null
			});
			const samples = [sample()];
			(window as unknown as { e2eSwitcherSamples?: typeof samples }).e2eSwitcherSamples = samples;
			new MutationObserver(() => samples.push(sample())).observe(document.body, {
				subtree: true,
				childList: true,
				characterData: true
			});
		});

		await page.getByTestId('discard-review').click();
		await page.getByTestId('confirm-discard-review').click();
		await expect(page.getByTestId('review-announcement')).toContainText('Discarded');

		const samples = await page.evaluate(
			() =>
				(window as unknown as { e2eSwitcherSamples?: { offered: boolean; reviewing: boolean }[] })
					.e2eSwitcherSamples ?? []
		);
		// Offered while it was open, which is deliberate: a teacher moves between review copies, so they
		// stay on the switcher rather than being filtered out of it (ADR-0024).
		expect(samples.some((seen) => seen.offered && seen.reviewing)).toBe(true);
		// And gone from it while the banner was still up — that is, withdrawn at the *start* of the
		// discard. Without that, the first state in which it is not offered is one where the leave has
		// already happened, which is the window this is about.
		expect(samples.some((seen) => !seen.offered && seen.reviewing)).toBe(true);
	});

	test('a review copy is not backed up', async ({ page }) => {
		await openWorkspaceSettings(page);

		await expect(page.getByTestId('no-backup-in-review')).toBeVisible();
		await expect(page.getByTestId('back-up-workspace')).toHaveCount(0);
	});
});

test.describe('a bundle that is refused, with nothing created', () => {
	/** Seeded so a rejection has something it could damage, and provably does not. */
	const mine = projectFiles({ 'project.json': projectJson({ name: 'My own Amsterdam' }) });

	test.beforeEach(async ({ page }) => {
		await seedProject(page, 'boston-1775', mine);
		await page.reload();
	});

	// ⚠ **One test, and it survives because of what it is asking rather than what it asserts.**
	// Every way a bundle can be malformed — not a tar, truncated, no `project.json`, a `formatVersion`
	// from the future, a missing `geojsonRef`, an image directory with no `info.json`, an entry that
	// climbs out, and no room to hold it — is a claim about parsing bytes and about the sentence the
	// parser produces, and all eight are asserted against real archive bytes in
	// `packages/core/src/transfer/project-bundle.test.ts`, in Node, in milliseconds.
	//
	// What no Seam 1 test can reach is the **wiring**: that a file picked through the real input is
	// handed to that parser at all, that the refusal it raises reaches a screen instead of a console,
	// that the dialog stays open so the message is not a flash the user can miss, and that no Review
	// Workspace is left behind on real OPFS. So exactly one malformed bundle is driven the whole way.
	test('a malformed bundle picked through the file input is refused on screen', async ({
		page
	}) => {
		const before = await everyByteOf(page, 'My Workspace');
		// Not {@link openBundle}: that one waits for the dialog to close, and a refused bundle is
		// precisely the case where it must **not** — the message stays in front of the user.
		await chooseBundle(page, {
			name: 'holiday.jpg',
			mimeType: 'application/x-tar',
			buffer: Buffer.from('not a tar')
		});
		await page.getByTestId('confirm-open-bundle').click();

		const alert = page.getByTestId('bundle-error');
		await expect(alert).toContainText('could not be read as a Ballastella Project bundle');
		await expect(alert).toContainText('Nothing has been opened.');
		await expect(page.getByRole('dialog', { name: 'Review a Project' })).toBeVisible();
		// No review copy was left behind, and the user's own Workspace is exactly as it was.
		expect(await workspaceNames(page)).toEqual(['My Workspace']);
		expect(await everyByteOf(page, 'My Workspace')).toEqual(before);
	});
});

test.describe('bundled content is untrusted (ADR-0009)', () => {
	test('an XSS payload in an annotation description arrives inert', async ({ page }) => {
		// What opening a bundle owes is to treat the file as bytes — never parsing, interpreting, or
		// inserting it — so the payload reaches storage unchanged and nothing in the path executes it.
		const payload =
			'{"type":"FeatureCollection","features":[{"type":"Feature","properties":' +
			'{"description":"<img src=x onerror=\\"window.__xss=1\\"><script>window.__xss=1</script>"},' +
			'"geometry":null}]}';
		const failures: string[] = [];
		page.on('pageerror', (error) => failures.push(error.message));
		page.on('dialog', (dialog) => failures.push(`dialog: ${dialog.message()}`));

		await openBundle(
			page,
			await bundleFixture(projectFiles({ 'annotations/warehouses.geojson': payload }))
		);
		await expect(banner(page)).toBeVisible();

		const stored = await everyByteOf(page, 'amsterdam-1625');
		expect(stored['amsterdam-1625/annotations/warehouses.geojson']).toBe(payload);
		expect(failures).toEqual([]);
		expect(
			await page.evaluate(() => ({
				injected: document.querySelector('img[src="x"]') !== null,
				ran: '__xss' in window
			}))
		).toEqual({ injected: false, ran: false });
	});
});

test.describe('the keyboard alone', () => {
	test('opens a bundle and exports a Project with no pointer', async ({ page }) => {
		const openButton = page.getByTestId('open-bundle');
		await openButton.focus();
		await page.keyboard.press('Enter');

		const dialog = page.getByRole('dialog', { name: 'Review a Project' });
		await expect(dialog).toBeVisible();
		// The file input itself has to be reachable; `setInputFiles` is how a test supplies a file, but
		// focusing it first is the assertion that a keyboard user can get to it.
		const chooser = dialog.getByLabel('Project bundle');
		await chooser.focus();
		await expect(chooser).toBeFocused();
		await chooser.setInputFiles(await bundleFixture(projectFiles()));

		const confirm = page.getByTestId('confirm-open-bundle');
		await confirm.focus();
		await page.keyboard.press('Enter');
		await expect(banner(page)).toBeVisible();

		const download = page.waitForEvent('download');
		const exportButton = page.getByRole('button', { name: /^Export/ });
		await exportButton.focus();
		await expect(exportButton).toBeFocused();
		await page.keyboard.press('Enter');
		expect((await download).suggestedFilename()).toBe('amsterdam-1625.project.tar');
	});

	// ⚠ **Two defects in one flow, both of which leave a keyboard user on `<body>`.**
	//
	// The confirm button was `disabled={bundleBusy || …}`, and a `disabled` button is removed from the
	// tab order the moment it is pressed — the identical defect the Export button above is shaped by,
	// written again three hundred lines later. And on success the dialog closes onto a trigger that
	// `{#if review === null}` has already unmounted, so `ModalDialog`'s focus restoration called
	// `focus()` on a detached node, which is a silent no-op.
	test('keeps focus somewhere real while a bundle opens, and after it has', async ({ page }) => {
		const confirm = page.getByTestId('confirm-open-bundle');
		await chooseBundle(page, await bundleFixture(projectFiles()));
		await confirm.focus();
		await expect(confirm).toBeFocused();

		// ⚠ **Watched rather than sampled, because the window is milliseconds and the damage is
		// permanent.** Polling `toBeDisabled()` during the read would be a race the test loses on a fast
		// machine and the *user* still loses on a slow one — a bundle with a pyramid in it takes tens of
		// seconds. A `MutationObserver` on the one attribute catches the flip however briefly it lasts,
		// which makes "the button that was pressed never leaves the tab order" an assertion about the
		// markup contract rather than about how quickly this fixture happens to open.
		await confirm.evaluate((button) => {
			(window as unknown as { e2eWentDisabled?: boolean }).e2eWentDisabled = (
				button as HTMLButtonElement
			).disabled;
			new MutationObserver(() => {
				if ((button as HTMLButtonElement).disabled) {
					(window as unknown as { e2eWentDisabled?: boolean }).e2eWentDisabled = true;
				}
			}).observe(button, { attributes: true, attributeFilter: ['disabled'] });
		});
		await page.keyboard.press('Enter');

		await expect(banner(page)).toBeVisible();
		expect(
			await page.evaluate(
				() => (window as unknown as { e2eWentDisabled?: boolean }).e2eWentDisabled ?? false
			)
		).toBe(false);
		// The trigger is gone — there is no "Review a Project…" inside a review copy — so
		// focus lands on the line that says what just happened, which is what a keyboard user needs to
		// read next.
		await expect(page.getByTestId('bundle-notice')).toBeFocused();
	});

	// Opening is the path ADR-0001 makes the only way in on Firefox, Safari and iPad, and it takes real
	// seconds over a pyramid. It said nothing at all: `openBundle` was called with no progress
	// listener, so the whole read-path apparatus reached no screen.
	test('announces what opening a bundle did', async ({ page }) => {
		await openBundle(page, await bundleFixture(projectFiles()));

		await expect(banner(page)).toBeVisible();
		await expect(transferStatus(page)).toHaveText(/Opened Amsterdam 1625: 5 files\./);
		await expect(transferStatus(page)).toHaveAttribute('data-transfer', 'open');
	});

	test('Escape closes the dialog and focus returns to the button that opened it', async ({
		page
	}) => {
		const trigger = page.getByTestId('open-bundle');
		await trigger.click();
		await expect(page.getByRole('dialog', { name: 'Review a Project' })).toBeVisible();

		await page.keyboard.press('Escape');

		await expect(page.getByRole('dialog', { name: 'Review a Project' })).toBeHidden();
		await expect(trigger).toBeFocused();
	});

	// ⚠ **Closing restores focus once, and the second run is what this is about.** `ModalDialog`
	// restored synchronously at `close()` — which it must, or a keystroke lands on a button inside a
	// dialog that is no longer shown — and then again from the queued `close` event, where it took
	// focus back to the trigger *unconditionally*. That is the same theft the synchronous restore was
	// written to stop, one task wide instead of one frame, and nothing that ran in that task could
	// keep the focus it had been given.
	//
	// One task is not something a Playwright `expect` can step into, so the page steps into it: a
	// `MutationObserver` on the dialog's own `open` attribute fires as a microtask after `close()`
	// removes it and before the `close` event is dispatched, which is exactly the window. Whatever it
	// focuses there must still be focused afterwards.
	test('closing restores focus once, and does not take it back from whatever moved it', async ({
		page
	}) => {
		await page.getByTestId('open-bundle').click();
		const dialog = page.getByRole('dialog', { name: 'Review a Project' });
		await expect(dialog).toBeVisible();

		await dialog.evaluate((element) => {
			const elsewhere = [...document.querySelectorAll('button')].find(
				(button) => button.textContent?.trim() === 'New Project'
			);
			new MutationObserver(() => {
				if (!(element as HTMLDialogElement).open) elsewhere?.focus();
			}).observe(element, { attributes: true, attributeFilter: ['open'] });
		});
		await dialog.getByRole('button', { name: 'Cancel' }).click();

		await expect(dialog).toBeHidden();
		await expect(page.getByRole('button', { name: 'New Project' })).toBeFocused();
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// IMPORT: THE INVERSE OF EXPORT (ADR-0037)
//
// The engine is exhausted at Seam 1 and without a browser: fresh Map Image identities, repeated
// references, Alignment rewrites, name and directory allocation against every namespace, the
// publication reset, provenance inheritance, the atomic transaction and its quota and collision
// refusals are `project-import-source.test.ts`, `-remapping`, `-allocation`, `-provenance` and
// `-transaction`.
//
// What no seam below can falsify is that the *application* performs the operation it offers: that
// three actions on one screen mean three different things to the Workspace on disk; that the
// Workspace named in the offer is the one written to and no other is created; that a Project which
// arrives under an allocated name is reachable and ordinary afterwards; and that a refusal leaves
// every byte of real OPFS as it was. Four tests, folded as far as they go.

test.describe('Importing a Project into the Workspace that is open', () => {
	/**
	 * A Project already called what the bundle is called, so the allocated name has to differ.
	 *
	 * Its Map Image is the bundle's identity too, which is the collision that matters most: under
	 * ADR-0023 one Workspace holds one Alignment per Map Image, so an Import that reused the incoming
	 * identity would overwrite the Alignment this Project is drawn by. It is seeded with bytes a
	 * rewrite would be visible in rather than with a plausible-looking file.
	 */
	const MINE = projectFiles({
		'project.json': projectJson({ name: 'Amsterdam 1625', layers: [] }),
		// alignment-write-is-the-fixture: the author's own Alignment of the sheet the bundle also holds, seeded so a reused Map Image identity would be visible as an overwrite
		'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"mine, not the bundle’s"}'
	});

	/**
	 * A bundle that has been published and handed on, so the reset and the inheritance are visible.
	 *
	 * ⚠ **A real Georeference Annotation, where the Review fixtures above make do with a stub.** An
	 * Import rewrites the incoming Alignment onto its fresh Map Image identity, and a rewrite goes
	 * through the domain parser (ADR-0023) — so a placeholder that is enough to tell two files apart
	 * on disk is refused here, correctly, as not being an Alignment at all.
	 */
	const IMPORTABLE = {
		// alignment-write-is-the-fixture: the Alignment a bundle fixture carries, packed into a tar here; an Import rewrites it onto a fresh identity through the one writer
		'alignments/amsterdam-1625.json': alignmentJson(AMSTERDAM)
	};

	const HANDED_ON = projectFiles({
		...IMPORTABLE,
		'project.json': projectJson({
			canonicalUrl: 'https://ada.github.io/atlas/amsterdam-1625/',
			onFrontPage: true,
			importProvenance: IMPORT_PROVENANCE
		})
	});

	/** The Import offer's file input, addressed through its own dialog. */
	const importDialog = (page: Page) => page.getByRole('dialog', { name: 'Import a Project' });

	/** Open the Import offer and hand it a file, without confirming. */
	async function chooseToImport(
		page: Page,
		fixture: { name: string; mimeType: string; buffer: Buffer }
	): Promise<void> {
		await page.getByTestId('import-project').click();
		await importDialog(page).getByLabel('Project bundle').setInputFiles(fixture);
	}

	/** Every path under `directory` in the open Workspace, with its text. */
	async function filesUnder(page: Page, directory: string): Promise<Record<string, string>> {
		const all = await everyByteOf(page, 'My Workspace');
		return Object.fromEntries(
			Object.entries(all)
				.filter(([path]) => path.startsWith(`${directory}/`))
				.map(([path, text]) => [path.slice(directory.length + 1), text])
		);
	}

	test.beforeEach(async ({ page }) => {
		await seedProject(page, 'boston-1775', MINE);
		await page.reload();
		await expect(page.getByTestId('projects-count')).toHaveText('1 Project');
	});

	// ⚠ **The claim is the destination, and every part of it is about this one Workspace.** The bundle
	// path answers the same file with a *second* Workspace, so "no other Workspace was created" is not
	// a formality here: it is the one assertion that tells the two operations apart on disk.
	test('copies the Project into the Workspace that stays open, under a name of its own', async ({
		page
	}) => {
		const before = await everyByteOf(page, 'My Workspace');

		await page.getByTestId('import-project').click();
		// Said before a file is chosen, because that is when the author decides which offer they are in.
		await expect(page.getByTestId('import-destination')).toHaveText('Import into My Workspace');
		await importDialog(page)
			.getByLabel('Project bundle')
			.setInputFiles(await bundleFixture(HANDED_ON));
		await page.getByTestId('confirm-import').click();

		// The allocated display name and the Workspace, and focus on the sentence carrying them: the
		// name is not the one the file promised, so a keyboard user put back on the trigger would have
		// to guess which Project in the list had just arrived.
		const notice = page.getByTestId('import-notice');
		await expect(notice).toHaveText(/Imported Amsterdam 1625 \(imported\) into My Workspace\./);
		await expect(notice).toBeFocused();
		await expect(importDialog(page)).toBeHidden();

		// No second Workspace, and no switch. This is the whole difference from Review.
		expect(await workspaceNames(page)).toEqual(['My Workspace']);
		await expect(banner(page)).toHaveCount(0);
		await expect(page.getByTestId('projects-count')).toHaveText('2 Projects');
		await expect(
			page.getByRole('heading', { level: 3, name: 'Amsterdam 1625 (imported)' })
		).toBeVisible();

		// Every byte the author already had, unchanged — the seeded Alignment above most of all, which
		// a reused Map Image identity would have overwritten with the bundle's.
		const after = await everyByteOf(page, 'My Workspace');
		for (const [path, text] of Object.entries(before)) expect(after[path]).toBe(text);

		// The imported Project is a detached local copy: off the front page, with no publication
		// address, carrying the two transfers it has been through and claiming only the second.
		const directory = Object.keys(after).find(
			(path) => path.endsWith('/project.json') && !path.startsWith('boston-1775/')
		);
		expect(directory).toBeDefined();
		const imported = JSON.parse(after[directory as string]) as {
			name: string;
			canonicalUrl?: string;
			onFrontPage?: boolean;
			importProvenance: { kind: string; evidence: string }[];
			layers: { kind: string; imageId?: string }[];
		};
		expect(imported.name).toBe('Amsterdam 1625 (imported)');
		expect(imported.canonicalUrl).toBeUndefined();
		expect(imported.onFrontPage).toBe(false);
		expect(imported.importProvenance.map((entry) => [entry.kind, entry.evidence])).toEqual([
			['github', 'inherited'],
			['project-bundle', 'inherited'],
			['project-bundle', 'observed']
		]);

		// A fresh Map Image identity, so the author's Alignment of their own sheet is untouched and the
		// imported Project draws a pyramid of its own.
		const drawn = imported.layers.find((layer) => layer.kind === 'map')?.imageId;
		expect(drawn).toBeDefined();
		expect(drawn).not.toBe('amsterdam-1625');
		// The pyramid arrives whole and re-stamped: the sheet's own dimensions kept, and its service
		// identity reset to the placeholder for the fresh Map Image rather than left naming the source.
		const pyramid = JSON.parse(after[`images/${drawn}/info.json`]) as {
			width: number;
			height: number;
			id?: string;
		};
		expect([pyramid.width, pyramid.height]).toEqual([4096, 3072]);
		expect(pyramid.id).toContain(drawn as string);
		expect(pyramid.id).not.toContain('amsterdam-1625');
		expect(after[`alignments/${drawn}.json`]).toContain('georeferencing');

		// Ordinary editable work: renamed with the hub's own control, which no review copy offers and
		// which writes to the Project this Import created.
		const card = page.getByRole('heading', { level: 3, name: 'Amsterdam 1625 (imported)' });
		await page.getByRole('button', { name: 'Rename Amsterdam 1625 (imported)' }).click();
		const renameDialog = page.getByRole('dialog', { name: 'Rename Project' });
		await renameDialog.getByRole('textbox').fill('Amsterdam, mine now');
		await renameDialog.getByRole('button', { name: 'Rename', exact: true }).click();
		await expect(
			page.getByRole('heading', { level: 3, name: 'Amsterdam, mine now' })
		).toBeVisible();
		await expect(card).toHaveCount(0);
		await expect
			.poll(
				async () =>
					(await filesUnder(page, directory!.replace('/project.json', '')))['project.json']
			)
			.toContain('Amsterdam, mine now');
	});

	// ⚠ **Three actions, and the offer each one opens says which.** All three take a Project someone
	// sent: the only thing between "keep this" and "look at it and throw it away" is what the screen
	// says before a file is chosen, so this asserts the labels *and* that inspecting an offer and
	// backing out of it is free.
	test('distinguishes Import, Review, and New Project, and backing out of the offer changes nothing', async ({
		page
	}) => {
		const before = await everyByteOf(page, 'My Workspace');
		for (const name of [
			'Import a Project…',
			'Review a Project…',
			'Review from GitHub…',
			'New Project'
		]) {
			await expect(page.getByRole('button', { name })).toBeVisible();
		}

		// Reached and opened from the keyboard alone, rather than `click()`ed: a control taken out of
		// the tab order passes a pointer test while being unreachable in the app (WCAG 2.4.3).
		const trigger = page.getByTestId('import-project');
		await trigger.focus();
		await page.keyboard.press('Enter');
		await expect(importDialog(page)).toBeVisible();
		// The Review offer names the other destination, so the two cannot be read as one operation.
		await expect(page.getByTestId('import-consequence')).toContainText(
			'copied into this Workspace'
		);

		// Escape, with a file already chosen: nothing has been downloaded, nothing written, and focus is
		// back where the gesture started.
		await importDialog(page)
			.getByLabel('Project bundle')
			.setInputFiles(await bundleFixture(HANDED_ON));
		await page.keyboard.press('Escape');
		await expect(importDialog(page)).toBeHidden();
		await expect(trigger).toBeFocused();
		expect(await everyByteOf(page, 'My Workspace')).toEqual(before);

		// And Cancel, which is the same promise through the other control.
		await chooseToImport(page, await bundleFixture(HANDED_ON));
		await importDialog(page).getByRole('button', { name: 'Cancel' }).click();
		await expect(importDialog(page)).toBeHidden();
		await expect(trigger).toBeFocused();
		expect(await everyByteOf(page, 'My Workspace')).toEqual(before);
		expect(await workspaceNames(page)).toEqual(['My Workspace']);
		await expect(page.getByTestId('projects-count')).toHaveText('1 Project');

		// ⚠ **The third action, from the keyboard, because it is the one that creates rather than
		// copies**. It sits in the same row as the two above and is the control an
		// author reaches for by mistake, so "these three are told apart" is only true if all three can
		// be operated the same way.
		const fresh = page.getByRole('button', { name: 'New Project' });
		await fresh.focus();
		await page.keyboard.press('Enter');
		const creating = page.getByRole('dialog', { name: 'New Project' });
		await expect(creating).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(creating).toBeHidden();
		await expect(fresh).toBeFocused();
		await expect(page.getByTestId('projects-count')).toHaveText('1 Project');

		await page.keyboard.press('Enter');
		await expect(creating).toBeVisible();
		await creating.getByLabel('Project name').fill('Boston 1776');
		const confirmNew = creating.getByRole('button', { name: 'Create Project' });
		await confirmNew.focus();
		await page.keyboard.press('Enter');
		await expect(creating).toBeHidden();
		await expect(page.getByRole('link', { name: 'Boston 1776' })).toBeVisible();
		await expect(page.getByTestId('projects-count')).toHaveText('2 Projects');
		// Creating a Project leaves the author on the hub, so the trigger is still there and is where
		// focus belongs — nothing was copied, so there is no arrival to be sent to.
		await expect(fresh).toBeFocused();
	});

	// Every way a source can be refused is asserted against real archive bytes at Seam 1. What only a
	// browser can show is the wiring: that a file picked through the real input reaches that reader,
	// that the refusal arrives as an alert instead of a console line, that the dialog stays open so the
	// sentence is not a flash, and — the claim the whole refusal turns on — that a Workspace which was
	// *going to be written to* is byte-identical afterwards.
	test('a refused bundle leaves every path in the Workspace exactly as it was', async ({
		page
	}) => {
		const before = await everyByteOf(page, 'My Workspace');

		await chooseToImport(page, {
			name: 'holiday.jpg',
			mimeType: 'application/x-tar',
			buffer: Buffer.from('not a tar')
		});
		await page.getByTestId('confirm-import').click();
		const alert = page.getByTestId('import-error');
		await expect(alert).toContainText('Nothing has been added to your Workspace.');
		await expect(importDialog(page)).toBeVisible();

		// ADR-0010's other refusal, through the same input, because it is the one a colleague really
		// sends: a Project written by next year's build.
		await importDialog(page)
			.getByLabel('Project bundle')
			.setInputFiles(
				await bundleFixture(projectFiles({ 'project.json': projectJson({ formatVersion: 99 }) }))
			);
		await page.getByTestId('confirm-import').click();
		await expect(alert).toContainText('newer version of Ballastella');
		await expect(importDialog(page)).toBeVisible();

		await importDialog(page).getByRole('button', { name: 'Cancel' }).click();
		expect(await everyByteOf(page, 'My Workspace')).toEqual(before);
		expect(await workspaceNames(page)).toEqual(['My Workspace']);
		await expect(page.getByTestId('projects-count')).toHaveText('1 Project');
	});

	// ⚠ **A pyramid is thousands of files over real minutes, and this is the path ADR-0001 makes the
	// only way in on Firefox, Safari and iPad.** One announcement at the end would be a still screen
	// for the whole wait, which is where a scholar concludes the tool has hung — so the region is
	// watched rather than sampled, and what it must show is *movement*. No percentage: a closure knows
	// its file count and nothing here invents a denominator it does not have.
	test('announces file-by-file progress, and says it is done only once the Project is', async ({
		page
	}) => {
		const tiles = Object.fromEntries(
			Array.from({ length: 60 }, (_, index) => [
				`images/amsterdam-1625/0,0,256,256/256,256/${index}/default.jpg`,
				`stands in for tile ${index}`
			])
		);

		// Collected from the live region itself, so a run that was too fast for a poll still proves the
		// intermediate counts were rendered — which is what a screen reader would have read out.
		await transferStatus(page).evaluate((region) => {
			const seen: string[] = [];
			(window as unknown as { e2eProgress?: string[] }).e2eProgress = seen;
			new MutationObserver(() => {
				const text = region.textContent?.trim() ?? '';
				if (text && seen[seen.length - 1] !== text) seen.push(text);
			}).observe(region, { childList: true, characterData: true, subtree: true });
		});

		await chooseToImport(page, await bundleFixture(projectFiles({ ...IMPORTABLE, ...tiles })));
		await page.getByTestId('confirm-import').click();
		await expect(page.getByTestId('import-notice')).toBeVisible();

		await expect(transferStatus(page)).toHaveAttribute('data-transfer', 'import');
		await expect(transferStatus(page)).toHaveText(
			/^Imported amsterdam-1625\.project\.tar: 64 files\.$/
		);
		const seen = await page.evaluate(
			() => (window as unknown as { e2eProgress?: string[] }).e2eProgress ?? []
		);
		const moving = seen.filter((text) => /^Importing .* of 64 files\.$/.test(text));
		expect(moving.length).toBeGreaterThan(1);
		expect(new Set(moving).size).toBeGreaterThan(1);

		// ⚠ **The success sentence is not allowed to run ahead of the bytes.** It is announced after the
		// transaction commits, so by the time it is on screen every file the closure named is durable
		// and the marker that made them provisional is gone.
		const after = await everyByteOf(page, 'My Workspace');
		const directory = Object.keys(after)
			.filter((path) => path.endsWith('/project.json') && !path.startsWith('boston-1775/'))
			.map((path) => path.slice(0, -'/project.json'.length))[0];
		const imported = await filesUnder(page, directory);
		expect(Object.keys(imported).sort()).toEqual([
			'annotations/warehouses.geojson',
			'project.json'
		]);
		const drawn = (
			JSON.parse(imported['project.json']) as { layers: { kind: string; imageId?: string }[] }
		).layers.find((layer) => layer.kind === 'map')?.imageId;
		expect(Object.keys(after).filter((path) => path.startsWith(`images/${drawn}/`))).toHaveLength(
			61
		);
		expect(after['import.json']).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// AN IMPORT THAT DID NOT FINISH
//
// An Import writes its provisional files straight to their final Workspace paths and makes them
// provisional by naming them in one durable marker: while that marker is unresolved the Workspace is
// unavailable, and startup recovery resolves it before anything asks the Workspace a question. Every
// decision that recovery makes — swept, finished, or refused — is asserted per durable boundary and
// without a browser in `packages/core/src/transfer/project-import-recovery.test.ts`.
//
// What only a browser can show is that the *application* is gated on it: the Project list is an
// effect over `?p=` that runs the moment the layout mounts, the Map Image list and the Workspace's
// size are walks of the same real OPFS, and a Backup is a third. So this is one test with three
// restarts in it rather than three tests — the subject is a single workflow, "what the next visit
// does with an outstanding marker", and the three markers are the three answers it can have.

test.describe('Importing the review copy back into the Workspace review began from', () => {
	/**
	 * The author's own work, seeded with an Alignment a reused Map Image identity would overwrite.
	 *
	 * The same fixture the direct Import uses, for the same reason: under ADR-0023 a Workspace holds
	 * one Alignment per Map Image, so a review Import that carried the incoming identity across would
	 * silently replace the sheet this Project is drawn by.
	 */
	const MINE = projectFiles({
		'project.json': projectJson({ name: 'Amsterdam 1625', layers: [] }),
		// alignment-write-is-the-fixture: the author's own Alignment of the sheet the review copy also holds, seeded so a reused Map Image identity would be visible as an overwrite
		'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"mine, not the review copy’s"}'
	});

	/** A bundle carrying a real Georeference Annotation, which an Import rewrites onto a fresh id. */
	const REVIEWABLE = projectFiles({
		// alignment-write-is-the-fixture: the Alignment a bundle fixture carries, packed into a tar here; a review Import rewrites it onto a fresh identity through the one writer
		'alignments/amsterdam-1625.json': alignmentJson(AMSTERDAM)
	});

	const importDialog = (page: Page) =>
		page.getByRole('dialog', { name: `Import into “${DEFAULT_WORKSPACE}”` });

	test.beforeEach(async ({ page }) => {
		// A successful Import opens the Project it made, which is the Project screen and therefore the
		// Base Map — served from the committed fixture, behind this suite's network fence.
		await routeBaseMapArchive(page);
		await seedProject(page, 'boston-1775', MINE);
		await page.reload();
		await expect(page.getByTestId('projects-count')).toHaveText('1 Project');
	});

	// ⚠ **The claim is the *destination*, and the wandering in the middle is what makes it a claim at
	// all.** The reviewer opens a bundle from their own Workspace, leaves it for a second Workspace,
	// comes back, edits what they were sent, and then Imports. A destination resolved when the button
	// is pressed would land the copy in "Somewhere else"; the one written into the mark before the
	// first Project byte landed still says which Workspace review began from.
	test('copies the reviewed state as edited into the recorded Workspace, then discards the copy', async ({
		page
	}) => {
		const before = await everyByteOf(page, DEFAULT_WORKSPACE);
		await openBundle(page, await bundleFixture(REVIEWABLE));
		await expect(banner(page)).toBeVisible();

		// A review copy is editable on purpose, and what an Import keeps is what is on screen.
		await page.getByRole('button', { name: 'Rename Amsterdam 1625' }).click();
		const renaming = page.getByRole('dialog', { name: 'Rename Project' });
		await renaming.getByLabel('New name').fill('Amsterdam 1625, marked');
		await renaming.getByRole('button', { name: 'Rename' }).click();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625, marked' })).toBeVisible();

		// Away and back, which is what the banner's first exit is for and what a later switch must not
		// redirect. The offer still names the Workspace review began from.
		await createWorkspace(page, 'Somewhere else');
		await switchToWorkspace(page, 'amsterdam-1625');
		await expect(banner(page)).toBeVisible();
		const offer = page.getByTestId('import-review');
		await expect(offer).toHaveText(`Import into “${DEFAULT_WORKSPACE}”`);

		// Both consequences, before the confirmation: what is copied, and when the copy goes.
		await offer.click();
		await expect(importDialog(page).getByTestId('import-review-state')).toContainText(
			'as it is now'
		);
		await expect(importDialog(page).getByTestId('import-review-consequence')).toContainText(
			'discarded once the copy has succeeded'
		);
		// Backing out is free: reading what the offer says costs nothing, which is what makes saying
		// both consequences before the confirmation worth doing at all.
		await importDialog(page).getByRole('button', { name: 'Cancel' }).click();
		await expect(importDialog(page)).toBeHidden();
		await expect(banner(page)).toBeVisible();
		expect(await workspaceNames(page)).toEqual([
			DEFAULT_WORKSPACE,
			'Somewhere else',
			'amsterdam-1625'
		]);

		// ⚠ **From the keyboard alone from here, and the button is watched while it runs.** The
		// confirmation closes onto this button *before* the copy begins, so a `disabled` one would be
		// removed from the tab order at the moment focus was handed back to it — dropping a keyboard
		// user onto `<body>` for the length of a copy that runs in minutes over a pyramid.
		// Watched with a `MutationObserver` rather than polled, because the flip is permanent damage
		// however briefly the attribute lasts on this fixture.
		await offer.focus();
		await offer.evaluate((button) => {
			(window as unknown as { e2eWentDisabled?: boolean }).e2eWentDisabled = (
				button as HTMLButtonElement
			).disabled;
			new MutationObserver(() => {
				if ((button as HTMLButtonElement).disabled) {
					(window as unknown as { e2eWentDisabled?: boolean }).e2eWentDisabled = true;
				}
			}).observe(button, { attributes: true, attributeFilter: ['disabled'] });
		});
		await page.keyboard.press('Enter');
		const confirm = page.getByTestId('confirm-import-review');
		await confirm.focus();
		// Collected from the region itself: the confirmation is closed by the time the transfer starts,
		// so the banner's own line is the only thing saying the wait is going somewhere, and
		// a run too fast to poll still proves the counts a screen reader would have read out.
		await page.getByTestId('review-import-progress').evaluate((region) => {
			const seen: string[] = [];
			(window as unknown as { e2eCopying?: string[] }).e2eCopying = seen;
			new MutationObserver(() => {
				const text = region.textContent?.trim() ?? '';
				if (text && seen[seen.length - 1] !== text) seen.push(text);
			}).observe(region, { childList: true, characterData: true, subtree: true });
		});
		await page.keyboard.press('Enter');

		// Back in the recorded Workspace with the imported Project open — not in "Somewhere else", and
		// not on the hub.
		await expect(banner(page)).toBeHidden();
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
		const said = page.getByTestId('review-announcement');
		await expect(said).toContainText(
			`Imported “Amsterdam 1625, marked” into “${DEFAULT_WORKSPACE}”`
		);
		// ⚠ **Focus is on the result, and it is the only thing left that could hold it.** Every control
		// in the banner went with the review copy, the dialog's own restoration target with them, so
		// without this a reviewer who has been waiting on a copy lands on `<body>` — at the top of a
		// Workspace they have not seen since they left it.
		await expect(said).toBeFocused();
		await expect(said).toBeVisible();
		expect(
			await page.evaluate(
				() => (window as unknown as { e2eWentDisabled?: boolean }).e2eWentDisabled ?? false
			)
		).toBe(false);
		const copying = (
			await page.evaluate(() => (window as unknown as { e2eCopying?: string[] }).e2eCopying ?? [])
		).filter((text) => /^Copying .* of 5 files\.$/.test(text));
		expect(copying.length).toBeGreaterThan(1);
		expect(new Set(copying).size).toBeGreaterThan(1);
		// Opened rather than merely listed: the address names the Project that arrived and
		// the Project screen is what is on it.
		await expect.poll(() => new URL(page.url()).searchParams.get('p')).not.toBeNull();
		await expect(page.getByTestId('edit-project-name')).toBeVisible();
		// And only then is the review copy gone.
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE, 'Somewhere else']);

		const after = await everyByteOf(page, DEFAULT_WORKSPACE);
		// Every byte the author already had, the seeded Alignment above most of all.
		for (const [path, text] of Object.entries(before)) expect(after[path]).toBe(text);

		const directory = Object.keys(after).find(
			(path) => path.endsWith('/project.json') && !path.startsWith('boston-1775/')
		);
		expect(directory).toBeDefined();
		const imported = JSON.parse(after[directory as string]) as {
			name: string;
			onFrontPage?: boolean;
			importProvenance: { kind: string; evidence: string; projectName?: string }[];
			layers: { kind: string; imageId?: string }[];
		};
		// The reviewer's own edit, not the name the bundle carried.
		expect(imported.name).toBe('Amsterdam 1625, marked');
		expect(imported.onFrontPage).toBe(false);
		expect(imported.importProvenance).toEqual([
			{
				kind: 'review',
				projectName: 'Amsterdam 1625',
				observedAt: expect.any(String),
				evidence: 'observed'
			}
		]);
		// A fresh Map Image identity and its Alignment rewritten onto it, exactly as every other
		// Import — which is what leaves the author's own sheet above untouched.
		const drawn = imported.layers.find((layer) => layer.kind === 'map')?.imageId;
		expect(drawn).toBeDefined();
		expect(drawn).not.toBe('amsterdam-1625');
		expect(after[`alignments/${drawn}.json`]).toContain('georeferencing');
	});

	// The half of a refusal that matters most: it must not be the thing that loses the afternoon. The
	// recorded Workspace is deleted behind the app's back — a second tab, or the user in another
	// window — so the destination is gone by the time the button is pressed.
	test('refuses a destination that is gone, leaving the review copy open and byte-identical', async ({
		page
	}) => {
		await openBundle(page, await bundleFixture(REVIEWABLE));
		await expect(banner(page)).toBeVisible();
		const before = await everyByteOf(page, 'amsterdam-1625');

		await page.evaluate(async (name) => {
			await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true });
		}, DEFAULT_WORKSPACE);

		const offer = page.getByTestId('import-review');
		await offer.click();
		await page.getByTestId('confirm-import-review').click();

		// ⚠ **An alert, and not the polite line the successful outcomes use**. It is
		// text that first exists at the moment it is needed, which a polite region does not reliably
		// announce — and it names the Workspace it could not reach and says the review copy is whole,
		// which is the domain language a reviewer can act on.
		const refusal = page.getByTestId('review-import-problem');
		await expect(refusal).toContainText(`“${DEFAULT_WORKSPACE}”`);
		await expect(refusal).toContainText('not there any more');
		await expect(refusal).toContainText('this review copy is still here');
		await expect(page.getByRole('alert').filter({ has: refusal })).toBeVisible();
		// And focus is back on the offer, which is where the retry is and what the way out is beside.
		await expect(offer).toBeFocused();
		// Still inside it, still holding every byte, and still able to leave normally.
		await expect(banner(page)).toBeVisible();
		await expectWorkspaceNamed(page, 'amsterdam-1625');
		expect(await everyByteOf(page, 'amsterdam-1625')).toEqual(before);
		// And nothing was created to import into: a Workspace made to receive a copy is a Workspace
		// the author never made, and the review copy would have been deleted into it.
		expect(await workspaceNames(page)).toEqual(['amsterdam-1625']);
	});

	// The other side of the same offer. Every review copy made before ADR-0037 records no origin, and
	// there is nothing to infer one from — the Workspace that is open is this throwaway one. So the
	// offer is absent, a sentence says why, and the copy is otherwise an ordinary review copy.
	test('offers no Import over a review copy that records no Workspace, and says why', async ({
		page
	}) => {
		await openBundle(page, await bundleFixture(REVIEWABLE));
		await expect(banner(page)).toBeVisible();

		// The mark as an older build wrote one: everything else about it, and no origin.
		await page.evaluate(async (name) => {
			const root = await navigator.storage.getDirectory();
			const workspace = await root.getDirectoryHandle(name);
			const file = await workspace.getFileHandle('review.json');
			const mark = JSON.parse(await (await file.getFile()).text()) as Record<string, unknown>;
			delete mark['origin'];
			const writable = await file.createWritable();
			await writable.write(JSON.stringify(mark));
			await writable.close();
		}, 'amsterdam-1625');
		await page.reload();

		await expect(banner(page)).toBeVisible();
		await expect(page.getByTestId('import-review')).toHaveCount(0);
		await expect(page.getByTestId('review-import-unavailable')).toContainText(
			'does not record which of your Workspaces it was opened from'
		);
		// Reviewable and discardable as it always was — only Import is refused.
		await expect(page.getByTestId('leave-review')).toBeVisible();
		await page.getByTestId('discard-review').click();
		await page.getByTestId('confirm-discard-review').click();
		await expect(page.getByTestId('review-announcement')).toContainText('Discarded');
	});
});

test.describe('an Import that did not finish', () => {
	/** The Workspace the author already had, which a swept Import must leave exactly as it is. */
	const OWN = {
		'project.json': projectJson({ name: 'My own Amsterdam', layers: [] }),
		'annotations/quays.geojson': WAREHOUSES_GEOJSON,
		'images/blaeu-1649/info.json': '{"width":2048,"height":2048}',
		// alignment-write-is-the-fixture: the author's own Alignment, seeded so a sweep that touched it would be visible
		'alignments/blaeu-1649.json': '{"type":"Annotation","id":"blaeu-1649"}'
	};

	/**
	 * The closure an interrupted Import had written, at the fresh paths it had allocated.
	 *
	 * Project-relative, as {@link seedProject} takes them: the shared material goes to the Workspace
	 * root and the rest inside the directory, which is ADR-0023's split and therefore the layout a
	 * real Import would have left.
	 */
	const PROVISIONAL: Record<string, string> = {
		'project.json': projectJson({ name: 'Boston 1775', layers: [] }),
		'annotations/wharves.geojson': WAREHOUSES_GEOJSON,
		'images/img-imported/info.json': '{"width":1024,"height":1024}',
		// alignment-write-is-the-fixture: the incoming Alignment as an interrupted Import had already written it, at the fresh identity it allocated
		'alignments/img-imported.json': '{"type":"Annotation","id":"img-imported"}'
	};

	/** The same closure as the marker names it: Workspace-rooted, sorted, and authoritative. */
	const PROVISIONAL_PATHS = [
		'alignments/img-imported.json',
		'boston-1775/annotations/wharves.geojson',
		'boston-1775/project.json',
		'images/img-imported/info.json'
	];

	/** Write a marker naming {@link PROVISIONAL}, or any other bytes, at the Workspace root. */
	const plantMarker = (page: Page, marker: string) =>
		page.evaluate(async (marker) => {
			const handle = await (await workspaceRoot()).getFileHandle('import.json', { create: true });
			const writable = await handle.createWritable();
			await writable.write(marker);
			await writable.close();
		}, marker);

	const markerFor = (state: 'writing' | 'committed') =>
		JSON.stringify({
			formatVersion: 1,
			transaction: 'e2e-import',
			state,
			project: 'boston-1775/project.json',
			paths: PROVISIONAL_PATHS,
			startedAt: '2026-08-22T10:00:00.000Z'
		});

	const plantProvisional = (page: Page) => seedProject(page, 'boston-1775', PROVISIONAL);

	test('is swept, finished, or keeps the Workspace shut — before anything can list it', async ({
		page
	}) => {
		await seedProject(page, 'my-own-amsterdam', OWN);

		// ── A transaction that was still writing. Nothing about it is durable, so all of it goes.
		await plantProvisional(page);
		await plantMarker(page, markerFor('writing'));
		await page.reload();

		await expect(page.getByRole('link', { name: 'My own Amsterdam' })).toBeVisible();
		// Never listed, rather than listed and then removed: the Workspace does not open until the
		// marker is resolved, so there is no frame in which the half-arrived Project could appear.
		await expect(page.getByRole('link', { name: 'Boston 1775' })).toHaveCount(0);
		// Nor its Map Image, which is the reader the shared pool makes easiest to forget: `images/` holds
		// the author's own maps beside the Import's, one directory along.
		await expect(page.getByTestId('map-image')).toHaveCount(1);
		// Nor is any of it in a Backup — a second walk of the same Workspace.
		const download = page.waitForEvent('download');
		await openWorkspaceSettings(page);
		await page.getByTestId('back-up-workspace').click();
		const { unpackTar } = await import('modern-tar');
		const entries = await unpackTar(new Uint8Array(await readFile(await (await download).path())), {
			strict: true
		});
		expect(entries.map((entry) => entry.header.name).sort()).toEqual(
			[
				// The archive's own directory entry for the Workspace it is rooted at.
				`${DEFAULT_WORKSPACE}/`,
				...Object.keys(OWN).map((path) =>
					path.startsWith('images/') || path.startsWith('alignments/')
						? `${DEFAULT_WORKSPACE}/${path}`
						: `${DEFAULT_WORKSPACE}/my-own-amsterdam/${path}`
				)
			].sort()
		);
		await closeWorkspaceSettings(page);
		// The marker went last and took the whole inventory with it, so the disk is the pre-Import
		// Workspace exactly.
		expect(await everyByteOf(page, DEFAULT_WORKSPACE)).toEqual(
			Object.fromEntries(
				Object.entries(OWN).map(([path, text]) => [
					path.startsWith('images/') || path.startsWith('alignments/')
						? path
						: `my-own-amsterdam/${path}`,
					text
				])
			)
		);

		// And the Workspace weighs the author's own four files and not a byte of the Import's. This is
		// the one place a Workspace's size reaches a screen, and it is offered only for a Workspace the
		// user is *not* in — so reaching it means standing somewhere else and looking back at this one.
		await createWorkspace(page, 'Elsewhere');
		await openWorkspaceMenu(page);
		await page.getByRole('button', { name: `Delete ${DEFAULT_WORKSPACE}` }).click();
		await expect(page.getByTestId('delete-workspace-size')).toContainText(
			`It holds ${Object.keys(OWN).length} files,`
		);
		await page.getByRole('button', { name: 'Keep it' }).click();
		await switchToWorkspace(page, DEFAULT_WORKSPACE);

		// ── A transaction that had committed. Every final path is durable and nothing may be rolled
		// back, so all that is left is removing the marker that shuts the Workspace.
		await plantProvisional(page);
		await plantMarker(page, markerFor('committed'));
		await page.reload();

		await expect(page.getByRole('link', { name: 'Boston 1775' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'My own Amsterdam' })).toBeVisible();
		await expect(page.getByTestId('map-image')).toHaveCount(2);
		expect(Object.keys(await everyByteOf(page, DEFAULT_WORKSPACE))).not.toContain('import.json');

		// ── A marker that will not parse. Which of the two above it meant cannot be told, and guessing
		// wrong is either a Project silently deleted or a Workspace opened over half of one.
		await plantMarker(page, 'half a jso');
		await page.reload();

		await expect(page.getByTestId('unrecovered-import')).toBeVisible();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Boston 1775' })).toHaveCount(0);
		// Nor is there a reader to reach: publishing and backing up are two more walks of this
		// Workspace, and both are absent rather than present and refused — the arrangement a review copy
		// already has. Publishing goes with the door it is behind.
		await expect(page.getByTestId('connect-to-github')).toHaveCount(0);
		await openWorkspaceSettings(page);
		await expect(page.getByTestId('no-backup-unrecovered')).toBeVisible();
		await expect(page.getByTestId('back-up-workspace')).toHaveCount(0);
		await closeWorkspaceSettings(page);
		// Staging internals are not the author's to read, and the marker is left where it is — which is
		// the durable evidence the next startup retries from.
		await expect(page.getByTestId('unrecovered-import')).not.toContainText('import.json');
		expect(await everyByteOf(page, DEFAULT_WORKSPACE)).toMatchObject({
			'import.json': 'half a jso'
		});
	});
});
