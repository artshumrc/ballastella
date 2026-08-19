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
import { expect, test, type Page } from './support/test.js';
import {
	closeWorkspaceSettings,
	openWorkspaceMenu,
	openWorkspaceSettings,
	switchToWorkspace
} from './support/workspace.js';

/**
 * SPEC's Seam 2 for ticket 14: handing a Project over and reviewing one, driven through the UI
 * against real OPFS.
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
 * ⚠ **This is the "byte-identical before and after" criterion, and it is the easiest in this ticket
 * to fake.** Asserting that the Project list is unchanged would pass while an Alignment had been
 * overwritten, so this lists every path and reads every byte — the contents, not a count, not a
 * listing, and not a size.
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
 * ⚠ **It was `{"features":[]}`, and that made story 91 unassertable.** "Explore it as though it were
 * your own — pan the map, toggle Layers, read Annotations" cannot be checked against a Layer with
 * nothing in it: every assertion about reading a colleague's Annotation would have passed over an
 * empty collection. The coordinates are where the Project's own Alignment puts the sheet, so the
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

/** Open the "Open a Project someone sent me" dialog and hand it a file, without confirming. */
async function chooseBundle(
	page: Page,
	fixture: { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
	await page.getByTestId('open-bundle').click();
	await page
		.getByRole('dialog', { name: 'Open a Project someone sent me' })
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
	await expect(page.getByRole('dialog', { name: 'Open a Project someone sent me' })).toBeHidden();
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
 * `[data-transfer]` rather than `getByRole('status')`: since ticket 04 the save indicator is on the
 * navigation bar and therefore on the hub too, so the hub has one `status` role of its own and this
 * region is an `aria-live="polite"` one — this repo's settled convention wherever the two meet.
 */
const transferStatus = (page: Page) => page.locator('[data-transfer]');

test.beforeEach(async ({ page }) => {
	await page.goto('./');
	await emptyEverything(page);
	await page.reload();
	await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
});

test.describe('exporting a Project as a bundle (workspace-and-layers SPEC story 89)', () => {
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

		// Progress is announced, not merely drawn (SPEC story 96).
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

	test('keeps the Export button focusable while an export runs (SPEC story 95)', async ({
		page
	}) => {
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

test.describe('merely opening a Project leaves its files unchanged (write-on-the-map SPEC story 50)', () => {
	test('merely opening a Project with a Label leaves every Project file hash-identical', async ({
		page
	}) => {
		await routeBaseMapArchive(page);
		await seedProject(
			page,
			'amsterdam-1625',
			projectFiles({ 'annotations/warehouses.geojson': ZUIDERZEE_GEOJSON })
		);
		await page.reload();
		const before = await hashesUnder(page, '');

		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await waitForOpeningView(page);
		await waitForStack(page);
		await waitForPaintedAnnotations(page, ['label']);
		// Let the 400 ms autosave debounce and any resulting flush complete.
		await page.waitForTimeout(600);

		expect(await hashesUnder(page, '')).toEqual(before);
	});
});

test.describe('opening a bundle lands in a review copy (workspace-and-layers SPEC stories 90–92)', () => {
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

	// ⚠ **The most important criterion in this ticket, and the easiest to fake.** Every path and every
	// byte, before and after — asserting on the Project list would pass while an Alignment had been
	// overwritten.
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

	// ⚠ **The declined-write path ticket 13 left unreachable, reached.** `writeRestored`'s decline was
	// unreachable while every destination was a brand-new Workspace; a bundle reaches it, because a tar
	// has no index and nothing stops an archive from naming a path twice. The **first** entry wins, and
	// the second is reported rather than silently overwriting it — a transfer that quietly delivers
	// something other than what it was handed is the failure this format change escaped.
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
		// copy, the user's own Workspace is one the settings dialog offers to delete — and the
		// confirmation names what it weighs, which is the one place in the app a Workspace's size
		// reaches a screen. It counts the user's own four files and **not** the six the bundle brought,
		// which is what "not counted in its size" means. A size computed over the OPFS root would say
		// ten here.
		await openBundle(page, await bundleFixture(projectFiles()));
		await expect(banner(page)).toBeVisible();
		await openWorkspaceSettings(page);
		await page.getByTestId('delete-workspace').click();
		await expect(page.getByTestId('delete-workspace-size')).toContainText(
			`It holds ${Object.keys(own).length} files,`
		);
		// Nothing is deleted: what was wanted was the number.
		await page.getByRole('button', { name: 'Keep it' }).click();
		await closeWorkspaceSettings(page);

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
		await page.reload();
		await openBundle(page, await bundleFixture(projectFiles()));
		await expect(banner(page)).toBeVisible();

		// There is no Publish button inside a review copy at all.
		await expect(page.getByTestId('publish')).toHaveCount(0);
		await expect(page.getByTestId('review-workspace-note')).toBeVisible();

		await page.getByTestId('leave-review').click();
		await expect(banner(page)).toBeHidden();
		await page.getByTestId('publish').click();
		const dialog = page.getByRole('dialog', { name: /Publish/ });
		await expect(dialog).toBeVisible();
		// The dialog counts the Projects it is about to publish, and counts **one** — the user's own.
		// The reviewed Project is in another Workspace entirely and is not among them.
		await expect(dialog).toContainText('will carry');
		await expect(dialog).toContainText('1 Project');
	});

	// ⚠ **Criterion 7, and the collision this whole design exists to prevent.** The same image id in
	// both bundles with *different* Control Points, and **each Review Workspace shows its own** —
	// which the ticket asks for in those words.
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

	// Criterion 9. There is deliberately no "keep this", "copy to my Workspace", or "save a copy":
	// promotion is the Alignment collision arriving through a convenience (ADR-0024).
	test('offers nothing that copies, promotes, or merges the reviewed Project', async ({ page }) => {
		await openBundle(page, await bundleFixture(projectFiles()));
		await expect(banner(page)).toBeVisible();

		for (const forbidden of [
			/keep this/i,
			/copy to my workspace/i,
			/save a copy/i,
			/promote/i,
			/move to my workspace/i,
			/import into/i
		]) {
			await expect(page.getByRole('button', { name: forbidden })).toHaveCount(0);
		}
		// The one control that *could* have grown into it — the hub's own duplicate — copies inside
		// this Workspace and cannot reach another one, so the review copy still has it and it is still
		// harmless. What must not exist is a route out.
		await expect(page.getByTestId('open-bundle')).toHaveCount(0);
	});

	// ⚠ **Story 91 — "explore it as though it were your own" — and it had no assertion at all.** The
	// ticket names three things by name: pan the map, toggle Layers, read Annotations. Nothing in this
	// file did any of them, and the fixture's `FeatureCollection` was empty, so an assertion about
	// reading a colleague's Annotation could not have been written against it even in principle.
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

test.describe('the review banner is on every screen (workspace-and-layers SPEC story 92)', () => {
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

	test('both exits work from the keyboard alone (workspace-and-layers SPEC story 95)', async ({
		page
	}) => {
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
		await expect(
			page.getByRole('dialog', { name: 'Open a Project someone sent me' })
		).toBeVisible();
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

test.describe('the keyboard alone (SPEC story 95)', () => {
	test('opens a bundle and exports a Project with no pointer', async ({ page }) => {
		const openButton = page.getByTestId('open-bundle');
		await openButton.focus();
		await page.keyboard.press('Enter');

		const dialog = page.getByRole('dialog', { name: 'Open a Project someone sent me' });
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
	test('keeps focus somewhere real while a bundle opens, and after it has (workspace-and-layers SPEC story 95)', async ({
		page
	}) => {
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
		// The trigger is gone — there is no "open a Project someone sent me" inside a review copy — so
		// focus lands on the line that says what just happened, which is what a keyboard user needs to
		// read next.
		await expect(page.getByTestId('bundle-notice')).toBeFocused();
	});

	// Opening is the path ADR-0001 makes the only way in on Firefox, Safari and iPad, and it takes real
	// seconds over a pyramid. It said nothing at all: `openBundle` was called with no progress
	// listener, so the whole read-path apparatus reached no screen.
	test('announces what opening a bundle did (workspace-and-layers SPEC story 96)', async ({
		page
	}) => {
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
		await expect(
			page.getByRole('dialog', { name: 'Open a Project someone sent me' })
		).toBeVisible();

		await page.keyboard.press('Escape');

		await expect(page.getByRole('dialog', { name: 'Open a Project someone sent me' })).toBeHidden();
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
		const dialog = page.getByRole('dialog', { name: 'Open a Project someone sent me' });
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
