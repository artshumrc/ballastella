import { expect, test } from './support/test.js';
import { type Locator, type Page } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IMAGE_HEIGHT, IMAGE_WIDTH, gradientPng } from './support/alignment-workspace.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	addMapImageButton,
	addMapImageIsOpen,
	ensureAddMapImageOpen
} from './support/map-images.js';
// The fake IIIF services, shared by every spec that needs one. This file used to carry
// its own copy of the host table, the `info.json` builder and the tile matcher; see the module
// header there for why three private copies of one fixture was a defect rather than a duplication.
import {
	communityAnnotation,
	generateId,
	installIiifHosts,
	routeCommunityAnnotations,
	service
} from './support/iiif-hosts.js';
import { deleteLayerRow, layerRows, openLayerRow } from './support/layers.js';

// The catalog's archive is somebody else's bucket, and **no spec may reach the internet**. This suite
// did not always need the routing, because nothing but MapLibre opened the archive and a Base Map
// that failed to load was harmless here. The Project screen now opens it too — to read the
// pyramid's depth before it can say what making the Project available offline would take — so an
// unrouted archive is both a real request and a Layer stack that waits on a style that never loads.
test.beforeEach(async ({ page }) => routeBaseMapArchive(page));

/**
 * Seam 2 for remote IIIF ingest: a URL pasted into the running app, in a real browser, against real
 * OPFS and a fixture host that behaves the way real ones do.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE FIXTURE HOSTS
 *
 * The pyramid geometry, the guards, and the parsing are asserted in `@ballastella/core` against
 * fourteen `info.json` documents captured from live services. What can only be asserted here is
 * everything about *hosts*: which requests the app makes, which it does not, and what happens when
 * a host refuses one.
 *
 * They live in `support/iiif-hosts.ts` now, shared with every other spec that needs a
 * IIIF service. The ones this file drives:
 *
 *   `library.test`  — Manifests and a Collection. CORS everywhere.
 *   `images.test`   — an image service that serves everything readably.
 *   `tiles-only.test` — **`info.json` with CORS and tiles without it.** An implementation that
 *                     probes only `info.json` passes a naive test and then ships the blank-map
 *                     failure this file exists to prevent, so the fixture host is built to catch
 *                     exactly that. `route.abort()` is what a browser does to a
 *                     cross-origin request the host does not permit: the `fetch` rejects.
 *   `sizes-only.test` — level 0 publishing no `tiles` at all, which is the one shape this app must
 *                     refuse when the map is *added*.
 *   `annotations.allmaps.org` — the community lookup, so "off means no request" is a claim about
 *                     the network rather than about a variable.
 *
 * Every host is routed, so **nothing in this file reaches the internet**. A red run means this
 * repository is wrong, not that a library is having a bad afternoon.
 */

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

/** Overwrite a file in a Project, the way a hand-edit or a half-finished write would leave it. */
/** Overwrite one file in OPFS. `''` as the directory writes at the Workspace root (ADR-0023). */
const writeFile = (page: Page, directory: string, path: string, body: string): Promise<void> =>
	page.evaluate(
		async ([directory, path, body]) => {
			const root = await workspaceRoot();
			let handle = directory === '' ? root : await root.getDirectoryHandle(directory as string);
			const segments = (path as string).split('/');
			for (const segment of segments.slice(0, -1)) {
				handle = await handle.getDirectoryHandle(segment);
			}
			const file = await handle.getFileHandle(segments[segments.length - 1] as string);
			const writable = await file.createWritable();
			await writable.write(body as string);
			await writable.close();
		},
		[directory, path, body]
	);

/**
 * Delete one file from OPFS. `''` as the directory deletes from the Workspace root (ADR-0023).
 *
 * For arranging the state a *previous* build left behind, which is the only way to test a repair:
 * this build cannot produce a map Layer without an Alignment any more, and the Projects that need
 * repairing were written before it could not.
 */
const removeFile = (page: Page, directory: string, path: string): Promise<void> =>
	page.evaluate(
		async ([directory, path]) => {
			const root = await workspaceRoot();
			let handle = directory === '' ? root : await root.getDirectoryHandle(directory as string);
			const segments = (path as string).split('/');
			for (const segment of segments.slice(0, -1)) {
				handle = await handle.getDirectoryHandle(segment);
			}
			await handle.removeEntry(segments[segments.length - 1] as string);
		},
		[directory, path]
	);

/**
 * One file out of OPFS, as text. `''` as the directory reads from the Workspace root (ADR-0023).
 *
 * The bytes rather than the parse, for the assertions whose claim is that *nothing was written*: a
 * document re-serialised to say the same thing is equal as JSON and different as a file, and
 * `updatedAt` is the field that tells them apart.
 */
const readText = (page: Page, directory: string, path: string): Promise<string> =>
	page.evaluate(
		async ([directory, path]) => {
			const root = await workspaceRoot();
			let handle = directory === '' ? root : await root.getDirectoryHandle(directory as string);
			const segments = (path as string).split('/');
			for (const segment of segments.slice(0, -1)) {
				handle = await handle.getDirectoryHandle(segment);
			}
			const file = await handle.getFileHandle(segments[segments.length - 1] as string);
			return (await file.getFile()).text();
		},
		[directory, path]
	);

/** One JSON file out of OPFS. `''` as the directory reads from the Workspace root (ADR-0023). */
const readJson = async (page: Page, directory: string, path: string): Promise<unknown> =>
	JSON.parse(await readText(page, directory, path));

/**
 * Change what `annotations.allmaps.org` answers with, after {@link installIiifHosts} has run.
 *
 * Playwright matches the most recently registered route first, so this shadows the one the fixture
 * hosts installed. It is how a second add of the same map meets a *different* offer, or none at all
 * — which is the only way to tell "the Alignment on disk was kept" apart from "the same Alignment
 * was written over itself".
 */
const nowOffering = (page: Page, annotations: unknown[] | null): Promise<void> =>
	routeCommunityAnnotations(page, annotations);

async function createProject(page: Page, name: string): Promise<void> {
	await page.getByRole('button', { name: 'New Project' }).click();
	await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill(name);
	await page
		.getByRole('dialog', { name: 'New Project' })
		.getByRole('button', { name: 'Create' })
		.click();
}

/**
 * A new Project, open, on its own Project screen.
 *
 * ⚠ **This deliberately does not open the "Add a Map Image" dialog**, and it used to. The
 * library flow is one of the three sources that dialog offers, so `lookUp` opens it — which is the
 * one gesture that needs it. Opening it here instead left a **modal** dialog up for the rest of
 * every test, inerting the Project screen behind it: every call site today happens to add a map
 * (which closes it) before touching the screen, so nothing was broken, and the next test written
 * after this helper that did not add one would have failed as an unexplained flake.
 */
async function openNewProject(page: Page, name = 'Amsterdam 1625'): Promise<void> {
	await createProject(page, name);
	await page.getByRole('link', { name }).click();
	await expect(page.getByTestId('project-screen')).toBeVisible();
}

/**
 * Wait until a referenced Map Image has landed on the Project screen, and leave its Layer open.
 *
 * The library a referenced map's tiles come from is *inside* the Layer that fetches them, so seeing
 * it is opening the row. That makes this the wait as well as the assertion: the row
 * appears when the map has been added, and the host appears when the Workspace's `remote.json` for it
 * has been read.
 *
 * @returns the row, so the caller can go on asking about that Layer and no other
 */
async function expectReferencedMap(page: Page, at: number | Locator = 0): Promise<Locator> {
	const row = await openLayerRow(page, at);
	await expect(row.getByTestId('referenced-image-host')).toBeVisible();
	return row;
}

/**
 * Paste a URL and look it up, from the dialog that offers the library as one of three sources.
 *
 * The dialog is opened first if a successful add has closed it: adding a map takes the panel off the
 * screen, so a spec that adds one and then looks up another address has to come back in.
 */
async function lookUp(page: Page, url: string): Promise<void> {
	await ensureAddMapImageOpen(page);
	await page.getByTestId('remote-url').fill(url);
	await page.getByTestId('remote-read').click();
}

test.describe('adding a Map Image from a IIIF URL', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await emptyWorkspace(page);
		await page.reload();
	});

	test('accepts a Manifest, a Collection, and a bare image service, and browses each', async ({
		page
	}) => {
		await installIiifHosts(page);
		await openNewProject(page);

		// A Manifest — three canvases, each pickable.
		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await expect(page.getByTestId('remote-label')).toHaveText(
			'A Sea Atlas of the Western Approaches'
		);
		await expect(page.getByTestId('remote-canvas')).toHaveCount(3);
		await expect(page.getByTestId('remote-canvas').nth(1)).toHaveText(/Chart of the Florida coast/);

		// Metadata, rights, and attribution while choosing.
		await expect(page.getByTestId('remote-rights')).toContainText(
			'creativecommons.org/licenses/by/4.0'
		);
		await expect(page.getByTestId('remote-attribution')).toContainText(
			'Provided by the Example Library'
		);
		await page.getByText('Catalogue details (2)').click();
		await expect(page.getByText('MS Atlas 44')).toBeVisible();

		// A Collection: one URL from a library is enough.
		await page.getByTestId('remote-reset').click();
		await lookUp(page, 'https://library.test/iiif/collection');
		await expect(page.getByTestId('remote-label')).toHaveText('Sea atlases');
		await expect(page.getByTestId('remote-item')).toHaveCount(1);
		await page.getByTestId('remote-item').click();
		await expect(page.getByTestId('remote-canvas')).toHaveCount(3);

		// A bare image service: nothing to choose, so it is selected outright.
		await page.getByTestId('remote-reset').click();
		await lookUp(page, `${service('images.test', 'florida')}/info.json`);
		await expect(page.getByTestId('remote-add')).toBeVisible();
		await expect(page.getByTestId('remote-status')).toContainText('700 by 500 pixels');
	});

	test('names the host when its tiles are not readable cross-origin — and the tile probe is what catches it', async ({
		page
	}) => {
		// The failure ADR-0007 exists to prevent. `tiles-only.test` serves its
		// `info.json` with CORS and aborts its tiles, so an implementation that probed only the
		// description would pass every other test in this file and ship a blank map.
		await installIiifHosts(page);
		await openNewProject(page);

		const requested: string[] = [];
		page.on('request', (request) => requested.push(request.url()));

		await lookUp(page, 'https://library.test/iiif/locked/manifest.json');

		const error = page.getByTestId('remote-error');
		await expect(error).toBeVisible();
		await expect(error).toContainText('tiles-only.test');
		await expect(error).toContainText('completely blank');
		// Nothing was added, and nothing was written.
		await expect(page.getByTestId('remote-add')).toHaveCount(0);
		// No Layer at all, which is the assertion that stays honest now that a referenced map's host is
		// behind its row's disclosure: `referenced-image-host` would be absent from a Project that had
		// gained the map and simply not been opened.
		await expect(layerRows(page)).toHaveCount(0);

		// **The mutation guard.** The refusal has to have come from a *tile* request, not from the
		// description: the description succeeded, so a probe that stopped there would have accepted the
		// resource. Both requests are here, and the tile one is what failed.
		const toHost = requested.filter((url) => url.includes('tiles-only.test'));
		expect(toHost.some((url) => url.endsWith('/info.json'))).toBe(true);
		expect(toHost.some((url) => /\/0\/default\.jpg$/.test(url))).toBe(true);
	});

	test('gives a referenced image the id Allmaps keys it on, and a Layer that says so', async ({
		page
	}) => {
		await installIiifHosts(page);
		await openNewProject(page);

		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('remote-add')).toBeVisible();
		await page.getByTestId('remote-add').click();

		await expect((await expectReferencedMap(page)).getByTestId('referenced-image-host')).toHaveText(
			'images.test'
		);

		// `generateId(uri)` — computed here with `node:crypto`, independently of the app.
		const imageId = generateId(service('images.test', 'florida'));
		expect(imageId).toMatch(/^[0-9a-f]{16}$/);

		// At the Workspace root: a referenced Map Image belongs to the Workspace like any other, so
		// adding the same remote resource from a second Project reaches the record already here (ADR-0023).
		const record = (await readJson(page, '', `images/${imageId}/remote.json`)) as Record<
			string,
			unknown
		>;
		expect(record.service).toBe(service('images.test', 'florida'));
		expect(record.source).toBe('https://library.test/iiif/atlas/manifest.json');
		expect(record.label).toBe('Chart of the Florida coast');
		expect(record.partOf).toBe('https://library.test/iiif/atlas/manifest.json');
		expect(record.canvas).toBe('https://library.test/iiif/atlas/canvas/2');
		// ADR-0007 wants rights and attribution again at the moment an offline copy is made, long after
		// the Manifest has been navigated away from — so they are recorded now.
		expect(record.rights).toBe('http://creativecommons.org/licenses/by/4.0/');
		expect(record.attribution).toBe('Provided by the Example Library');
		// The service's declared square tile side, in hand only at this moment and previously discarded.
		// With the dimensions it is what names the picture the hub shows beside this map (ADR-0030); the
		// scale factor it implies cannot be recovered from anything else in the Workspace.
		expect(record.tileSize).toBe(256);

		const project = (await readJson(page, 'amsterdam-1625', 'project.json')) as {
			layers: { kind: string; name: string; imageId: string }[];
		};
		expect(project.layers).toHaveLength(1);
		expect(project.layers[0]).toMatchObject({
			kind: 'map',
			name: 'Chart of the Florida coast',
			imageId
		});

		// **No pyramid was written, and that is the whole record of it** (ADR-0023). A referenced image has
		// no `info.json` of ours; `remote.json` sitting there without one is what says the tiles are on a
		// Library's server, so nothing in `project.json` claims it and nothing could disagree.
		await expect(readJson(page, '', `images/${imageId}/info.json`)).rejects.toThrow();
		// And the badge on the Layer says so, read off those files rather than off the document.
		await expect(page.getByTestId('layer-sidebar')).toBeVisible();
		await expect(page.getByTestId('layer-image-mode')).toHaveAttribute(
			'data-image-mode',
			'referenced'
		);
	});

	/**
	 * A defect review found, and the round trip that proves it is closed.
	 *
	 * A referenced map added **without** a community Alignment used to write `images/<id>/remote.json`
	 * and the Layer, and nothing else — while `layerReferences` requires `alignments/<id>.json` for
	 * every map Layer. So this build exported a zip it then refused to import, by name, and the only
	 * way to see it was to add a map and not align it. ADR-0023's starter Alignment closes it.
	 *
	 * Driven all the way round — export, an empty Workspace, import — rather than by asserting the file
	 * exists, because the file existing is what the *previous* test in this file already asserts on the
	 * community path. What was broken is the pair of them agreeing.
	 */
	test('a map added without an Alignment exports to a bundle this build opens back', async ({
		page
	}) => {
		await installIiifHosts(page);
		await openNewProject(page);

		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('remote-add')).toBeVisible();
		// No community Alignment was offered — the fixture API answers with none unless asked to — so
		// this is the unaligned case rather than one that happens to have three Control Points.
		await expect(page.getByTestId('community-offer')).toHaveCount(0);
		await page.getByTestId('remote-add').click();
		await expectReferencedMap(page);
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const imageId = generateId(service('images.test', 'florida'));
		const alignment = (await readJson(page, '', `alignments/${imageId}.json`)) as {
			body: { features: unknown[] };
			target: { source: { id: string }; selector: { value: string } };
		};
		// The starter Alignment: no Control Points, the whole sheet, and the Library's service as its
		// `resource.id` — the same address the community one carries, for the same reason (ADR-0007).
		expect(alignment.body.features).toEqual([]);
		expect(alignment.target.selector.value).toBe(
			`<svg width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}"><polygon points="0,0 ${IMAGE_WIDTH},0 ${IMAGE_WIDTH},${IMAGE_HEIGHT} 0,${IMAGE_HEIGHT}" /></svg>`
		);
		expect(alignment.target.source.id).toBe(service('images.test', 'florida'));

		// Export it, from the hub.
		await page.goto('/');
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: /^Export/ }).click();
		const saved = await download;
		expect(saved.suggestedFilename()).toBe('amsterdam-1625.project.tar');
		// Read back and handed to the input by name: `download.path()` is a temporary file with a random
		// basename, and the reader names the review copy after the name it is given.
		const bundle = await readFile(await saved.path());

		// A Workspace with nothing in it, so opening the bundle cannot be satisfied by what is already
		// there — and the bundle lands in a Review Workspace of its own regardless (ADR-0024), which is
		// why nothing is asserted about this one afterwards.
		await emptyWorkspace(page);
		await page.reload();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);

		await page.getByTestId('open-bundle').click();
		await page
			.getByRole('dialog', { name: 'Review a Project' })
			.getByLabel('Project bundle')
			.setInputFiles({
				name: 'amsterdam-1625.project.tar',
				mimeType: 'application/x-tar',
				buffer: bundle
			});
		await page.getByTestId('confirm-open-bundle').click();

		// **Accepted, not refused.** The refusal this closes says the bundle "is missing
		// “alignments/<id>.json”, which the Layer … needs to be drawn", so its absence is the assertion.
		await expect(page.getByTestId('review-banner')).toBeVisible();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		await expect(page.getByTestId('bundle-error')).toHaveCount(0);
		const imported = (await readJson(page, 'amsterdam-1625', 'project.json')) as {
			layers: { kind: string; imageId: string }[];
		};
		expect(imported.layers).toEqual([expect.objectContaining({ kind: 'map', imageId })]);
		expect(
			((await readJson(page, '', `alignments/${imageId}.json`)) as { body: { features: [] } }).body
				.features
		).toEqual([]);
	});

	/**
	 * Adding a Map Image the Project already draws is a no-op on the stack — not a duplicate row, and
	 * not a refusal.
	 *
	 * The referenced path is where this can be driven at all: `generateId(uri)` is deterministic, so
	 * the second add lands on the same image id, where a local file's random id (ADR-0015) makes two
	 * adds legitimately two Map Images.
	 *
	 * Byte identity on `project.json`, so "unchanged" covers the Layer's id, its position, its name,
	 * **and** `updatedAt` — a re-add that rewrote the document to say the same thing would pass a count
	 * and fail this.
	 */
	test('adding the same referenced map again leaves the stack byte-identical', async ({ page }) => {
		await installIiifHosts(page);
		await openNewProject(page);

		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await page.getByTestId('remote-add').click();
		await expectReferencedMap(page);
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const before = await readText(page, 'amsterdam-1625', 'project.json');
		expect(JSON.parse(before).layers).toHaveLength(1);
		// The user renames it, so a Layer that came back rebuilt rather than untouched is visible.
		await expect(page.getByTestId('layer-sidebar')).toBeVisible();
		await expect(page.getByTestId('layer-sidebar')).toBeVisible();
		// Renaming starts at the pencil in an open card since the Layers revision.
		const renaming = await openLayerRow(page);
		await renaming.getByTestId('layer-rename').click();
		await renaming.getByTestId('layer-name').fill('The Florida coast, as drawn in 1657');
		await renaming.getByTestId('layer-name').blur();
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		const renamed = await readText(page, 'amsterdam-1625', 'project.json');

		// Back to the Project, and add the very same canvas again.
		await page.goto('/?p=amsterdam-1625');
		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('remote-add')).toBeVisible();
		await page.getByTestId('remote-add').click();
		await expectReferencedMap(page);

		// One Layer, the same one, with the name the user gave it — and not one byte written.
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
		// A fixed wait, because what is being asserted is a write that must **not** happen: reading the
		// file the moment the add returns would go green against an implementation whose write was still
		// in flight. Long enough for ADR-0017's sub-second debounce and the write behind it.
		await page.waitForTimeout(2000);
		expect(await readText(page, 'amsterdam-1625', 'project.json')).toBe(renamed);
	});

	/**
	 * "Remove the Layer, add the same map again, and it comes back — which today it silently does not."
	 *
	 * The demonstrable half of the deleted tombstone, and the *other* side of it.
	 * `ProjectFile.removedMapLayers` recorded the image ids whose Layer the user had removed
	 * and was consulted on every Alignment write; a re-add had to remember to lift it, and anything
	 * that forgot made a deletion permanent through the affordance built to reverse it. With the record
	 * gone there is nothing to lift and nothing to forget.
	 *
	 * **Across a reload**, because that is where a record in the file — rather than in memory — would
	 * still have been waiting.
	 */
	test('a deleted map Layer comes back when the same map is added again', async ({ page }) => {
		await installIiifHosts(page);
		await openNewProject(page);

		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await page.getByTestId('remote-add').click();
		await expectReferencedMap(page);
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		const imageId = generateId(service('images.test', 'florida'));

		await page.goto('/?p=amsterdam-1625');
		await expect(page.getByTestId('layer-sidebar')).toBeVisible();
		// Delete is inside the open card since the Layers revision.
		await deleteLayerRow(page);
		await expect(page.getByTestId('layer-row')).toHaveCount(0);
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		expect(
			((await readJson(page, 'amsterdam-1625', 'project.json')) as { layers: unknown[] }).layers
		).toEqual([]);

		// A reload, so nothing the running page was holding can be what makes this work.
		await page.goto('/?p=amsterdam-1625');
		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('remote-add')).toBeVisible();
		await page.getByTestId('remote-add').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const back = (await readJson(page, 'amsterdam-1625', 'project.json')) as {
			layers: { kind: string; imageId: string; name: string }[];
		};
		expect(back.layers).toEqual([
			expect.objectContaining({ kind: 'map', imageId, name: 'Chart of the Florida coast' })
		]);
	});

	/**
	 * The other half of "it comes back", and the one that has teeth: it comes back **over the
	 * Alignment that is already there**.
	 *
	 * The test above re-adds over a starter Alignment with no Control Points in it, so an
	 * implementation that blew the file away and wrote a fresh starter would be byte-invisible — that
	 * test cannot fail on this. And the byte-identity test before it never reaches the write at all:
	 * the Layer is still in the stack, so the add is a no-op on `project.json` and the question of
	 * what happens to `alignments/<id>.json` is not asked.
	 *
	 * This is the scenario that reaches it. A Library map is aligned; its Layer is deleted; the same
	 * map is added again — which, because `generateId(uri)` is deterministic, lands on the same image
	 * id and therefore on the same Alignment. Without the guard in `#writeInitialAlignment`, the add
	 * writes a starter over three Control Points and the deletion of a *Layer* silently destroys an
	 * *Alignment* the Workspace shares with every other Project.
	 *
	 * The Control Points come from a community import rather than from clicks on the panes, because
	 * what has to be on disk is a real Alignment file with real Control Points in it, and the import
	 * is a real user gesture that writes exactly that. The offer is then withdrawn before the re-add,
	 * so the only thing that could rewrite the file is the starter — which is the write under test.
	 */
	test('re-adding a map after deleting its Layer keeps the Alignment already on it', async ({
		page
	}) => {
		await installIiifHosts(page, {
			communityAnnotations: [communityAnnotation('images.test', 'florida')]
		});
		await openNewProject(page);
		const imageId = generateId(service('images.test', 'florida'));

		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('community-offer')).toContainText('3 control points');
		await page.getByTestId('remote-add').click();
		await expectReferencedMap(page);
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		// Three Control Points, on disk, in the Workspace — the afternoon the guard exists to protect.
		const aligned = await readText(page, '', `alignments/${imageId}.json`);
		expect(JSON.parse(aligned).body.features).toHaveLength(3);

		await page.goto('/?p=amsterdam-1625');
		await expect(page.getByTestId('layer-sidebar')).toBeVisible();
		// Delete is inside the open card since the Layers revision.
		await deleteLayerRow(page);
		await expect(page.getByTestId('layer-row')).toHaveCount(0);
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		// Deleting a Layer never deletes a Map Image or its Alignment (ADR-0023). Stated here
		// because everything below is about what the *re-add* does to a file that is still there.
		expect(await readText(page, '', `alignments/${imageId}.json`)).toBe(aligned);

		// The offer is withdrawn, so the re-add is the plain one and the starter is the only thing that
		// could write this file. Left in place, a second import of the same annotation would rewrite it
		// to the same bytes and this test could not tell the two implementations apart.
		await nowOffering(page, null);

		await page.goto('/?p=amsterdam-1625');
		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('remote-add')).toBeVisible();
		await expect(page.getByTestId('community-offer')).toHaveCount(0);
		await page.getByTestId('remote-add').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		// A fixed wait, because the claim is about a write that must **not** happen: reading the moment
		// the add returns would go green against an implementation whose starter was still in flight.
		// Long enough for ADR-0017's sub-second debounce and the write behind it.
		await page.waitForTimeout(2000);
		expect(await readText(page, '', `alignments/${imageId}.json`)).toBe(aligned);
	});

	/**
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE ALIGNMENT IS THE WORKSPACE'S, SO OVERWRITING IT IS NEVER A LOCAL DECISION
	 *
	 * ADR-0023 moved `alignments/<image-id>.json` out of the Project and into the Workspace: one
	 * Alignment per Map Image, shared by every Project that draws it. That turns a write here
	 * into an edit of Projects the user is not looking at, and it turns the community-import path into
	 * a way to destroy an afternoon's work from a screen that never mentions the Project losing it —
	 * align a Library map in one Project, add the same map to another months later, accept whatever
	 * Allmaps happens to offer, and the first Project's Control Points are gone with no message.
	 *
	 * So the offer wins only when there is nothing to lose. Here there is: the Alignment on disk has
	 * three Control Points somebody placed, so it is kept, and the user is told — because they did ask
	 * for the import, and a silent no-op is its own way of being wrong.
	 *
	 * The two readings differ in every Control Point and in the Resource Mask, so which one is on disk
	 * at the end is a visible fact rather than an inference.
	 */
	test('adding a map another Project has aligned keeps that Alignment, and says so', async ({
		page
	}) => {
		await installIiifHosts(page, {
			communityAnnotations: [communityAnnotation('images.test', 'florida')]
		});
		const imageId = generateId(service('images.test', 'florida'));

		// The first Project takes the community Alignment. Three Control Points, in the Workspace.
		await openNewProject(page, 'Amsterdam 1625');
		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('community-offer')).toContainText('3 control points');
		await page.getByTestId('remote-add').click();
		await expectReferencedMap(page);
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const alignedInAmsterdam = await readText(page, '', `alignments/${imageId}.json`);
		expect(JSON.parse(alignedInAmsterdam).target.selector.value).toContain('10,10 690,10');

		// A colleague's different reading of the same sheet is what Allmaps offers from now on.
		await nowOffering(page, [communityAnnotation('images.test', 'florida', 'refined')]);

		// A second Project, and the same Map Image added to it.
		await page.goto('/');
		await openNewProject(page, 'Boston 1775');
		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('community-offer')).toContainText('3 control points');
		await page.getByTestId('remote-add').click();
		await expectReferencedMap(page);
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		// The Layer was added — the map is in this Project's stack, drawing the Alignment that exists.
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
		expect(
			((await readJson(page, 'boston-1775', 'project.json')) as { layers: { imageId: string }[] })
				.layers
		).toEqual([expect.objectContaining({ kind: 'map', imageId })]);

		// **And the user is told**, in terms that name the reason rather than only the outcome: a
		// Map Image has one Alignment, shared, so importing over it would have discarded work.
		const notice = page.getByTestId('remote-notice');
		await expect(notice).toContainText('was not written');
		await expect(notice).toContainText('one Alignment shared by every Project');

		// A fixed wait, because the claim is about a write that must **not** happen.
		await page.waitForTimeout(2000);
		// Amsterdam's Control Points, byte for byte. Not the refined reading, and not a starter.
		expect(await readText(page, '', `alignments/${imageId}.json`)).toBe(alignedInAmsterdam);
	});

	/**
	 * The same rule from the other side: an Alignment nobody has touched holds no work, so the import
	 * the user asked for happens rather than being refused over a file with nothing in it.
	 *
	 * Without this the protection above becomes its own bug — a colleague who added the map to their
	 * Project and never placed a point would make every later community import in the Workspace a
	 * no-op with an explanation, and the whole "import existing alignment" affordance would quietly
	 * stop working the moment two Projects touched one map.
	 *
	 * The test is byte-identity with the starter this build writes, not `controlPoints.length === 0`:
	 * the Resource Mask is editable without placing a single Control Point, and a count would read a
	 * cropped sheet as untouched and throw the crop away.
	 */
	test('imports the community Alignment over a starter nobody has touched', async ({ page }) => {
		await installIiifHosts(page);
		const imageId = generateId(service('images.test', 'florida'));

		// The first Project adds the map with no offer at all, so all that lands is the starter.
		await openNewProject(page, 'Amsterdam 1625');
		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('community-offer')).toHaveCount(0);
		await page.getByTestId('remote-add').click();
		await expectReferencedMap(page);
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		expect(
			((await readJson(page, '', `alignments/${imageId}.json`)) as { body: { features: [] } }).body
				.features
		).toEqual([]);

		await nowOffering(page, [communityAnnotation('images.test', 'florida')]);

		await page.goto('/');
		await openNewProject(page, 'Boston 1775');
		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('community-offer')).toContainText('3 control points');
		await page.getByTestId('remote-add').click();
		await expectReferencedMap(page);
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		// Imported, and nothing said: there was nothing to keep and nothing to explain.
		await expect
			.poll(
				async () =>
					(
						(await readJson(page, '', `alignments/${imageId}.json`)) as {
							body: { features: unknown[] };
						}
					).body.features.length
			)
			.toBe(3);
		// The screen's notice region is always there and says nothing, which is the honest shape of
		// "nothing was kept over": an element that is *absent* would also be satisfied by a region that
		// had stopped rendering at all.
		await expect(page.getByTestId('remote-notice')).toHaveText('');
	});

	/**
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE PROJECTS THE PREVIOUS BUILD BROKE, AND THE GESTURE THAT MENDS THEM
	 *
	 * Before ADR-0023's starter Alignment, adding a referenced Map Image without a community
	 * offer wrote no `alignments/<id>.json` at all. The Layer referenced a file that did not exist,
	 * `assertReferencesPresent` refused the Project by name, and it could be neither exported nor
	 * published — permanently, because nothing later wrote the missing file either.
	 *
	 * Nothing repairs such a Project when it is *opened*: ADR-0010 forbids writing when merely opening
	 * one, and the ADR says so again about migrations. What repairs it is the obvious gesture — adding
	 * the map again — and that only works because the Alignment is settled **before** `#addMapLayer`
	 * returns early on "this Project already draws that map". Move it after and this goes red while
	 * every other test in the file stays green, which is exactly how it shipped covering new adds only.
	 *
	 * The assertion is the export, not the file, because being un-exportable is the whole of the
	 * symptom: a download that arrives is `assertReferencesPresent` no longer refusing.
	 */
	test('re-adding a map repairs a Project whose Alignment went missing', async ({ page }) => {
		await installIiifHosts(page);
		await openNewProject(page);
		const imageId = generateId(service('images.test', 'florida'));

		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await page.getByTestId('remote-add').click();
		await expectReferencedMap(page);
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		// The state an earlier build left behind: a map Layer whose Alignment is not there.
		await removeFile(page, '', `alignments/${imageId}.json`);
		await expect(readText(page, '', `alignments/${imageId}.json`)).rejects.toThrow();

		// The user does the obvious thing and adds the map again.
		await page.goto('/?p=amsterdam-1625');
		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('remote-add')).toBeVisible();
		await page.getByTestId('remote-add').click();
		await expectReferencedMap(page);

		// The starter is back, and the stack is exactly as it was: one Layer, not two.
		await expect
			.poll(async () =>
				readText(page, '', `alignments/${imageId}.json`).then(
					(text) => JSON.parse(text).body.features.length,
					() => -1
				)
			)
			.toBe(0);
		await expect(page.getByTestId('layer-row')).toHaveCount(1);

		// And the Project exports again, which is the thing the user could not do.
		await page.goto('/');
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: /^Export/ }).click();
		expect((await download).suggestedFilename()).toBe('amsterdam-1625.project.tar');
	});

	test('offers the community alignments it found, and importing one produces a working Alignment', async ({
		page
	}) => {
		// The annotation the fixture API answers with has three Control Points, which is what
		// `polynomial1` needs — so "working" means renderable, not merely parseable.
		await installIiifHosts(page, {
			communityAnnotations: [
				communityAnnotation('images.test', 'florida'),
				communityAnnotation('images.test', 'chesapeake')
			]
		});
		await openNewProject(page);

		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();

		// One of the two annotations is for a different image, so only one is offered — matched on the
		// identifier, which is what the API keyed it on.
		const offer = page.getByTestId('community-offer');
		await expect(offer).toContainText('Import existing alignment — 1 found.');
		await expect(offer).toContainText('3 control points');
		await expect(page.getByTestId('remote-status')).toContainText(
			'Import existing alignment — 1 found.'
		);

		await page.getByTestId('remote-add').click();
		await expectReferencedMap(page);

		const imageId = generateId(service('images.test', 'florida'));
		const alignment = (await readJson(page, '', `alignments/${imageId}.json`)) as {
			target: { source: { id: string }; selector: { value: string } };
			body: { features: unknown[]; transformation: { type: string; options: { order: number } } };
		};

		// The Control Points and the Resource Mask came across, so this is an Alignment somebody could
		// work from rather than an empty one with the right shape.
		expect(alignment.body.features).toHaveLength(3);
		expect(alignment.body.transformation).toEqual({ type: 'polynomial', options: { order: 1 } });
		expect(alignment.target.selector.value).toContain('10,10 690,10 690,490 10,490');

		// **And it names the remote service, not the ADR-0004 placeholder.** For a referenced image
		// that is what makes the file resolvable by Allmaps (ADR-0007) *and* what makes the warped Layer
		// render at all — `@allmaps/maplibre` fetches tiles from this `id`.
		expect(alignment.target.source.id).toBe(service('images.test', 'florida'));
		expect(JSON.stringify(alignment)).not.toContain('unset.invalid');
	});

	test('discloses the lookup, and makes no request to the Allmaps API when it is off', async ({
		page
	}) => {
		// ADR-0015. Asserted three ways, because the interesting claim is an *absence* and an absence is
		// the easiest thing in the world to assert vacuously.
		await installIiifHosts(page, {
			communityAnnotations: [communityAnnotation('images.test', 'florida')]
		});
		await openNewProject(page);

		const allmapsRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('annotations.allmaps.org')) allmapsRequests.push(request.url());
		});

		// The setting is at the point of use, inside the dialog the library source lives in — so
		// reaching it is the same gesture as reaching the URL field, and this is the one test in this
		// suite that asks about it before looking anything up.
		await ensureAddMapImageOpen(page);

		// On by default, and it says so at the point of use.
		const toggle = page.getByTestId('community-lookup-toggle');
		await expect(toggle).toBeChecked();
		await expect(page.getByText(/Check annotations\.allmaps\.org/)).toBeVisible();

		await toggle.uncheck();
		await expect(page.getByText(/Not checking Allmaps/)).toBeVisible();

		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('remote-add')).toBeVisible();

		// 1. Playwright saw no request to the host.
		expect(allmapsRequests).toEqual([]);
		// 2. The app's own record of every URL the remote path asked for has the image host in it and
		//    not the Allmaps host — so this is not "no requests happened at all".
		const hosts = await page.evaluate(() => window.ballastellaRemoteRequests?.hosts ?? []);
		expect(hosts).toContain('images.test');
		expect(hosts).not.toContain('annotations.allmaps.org');
		// 3. And the user is told the check did not happen, rather than being told nothing was found.
		await expect(page.getByTestId('community-off')).toBeVisible();

		// Switched back on, the request is made — which is what makes the assertion above mean
		// something rather than describing a lookup that never works. The same canvas, so the only
		// thing that changed between the two selections is the setting.
		await toggle.check();
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('community-offer')).toBeVisible();
		expect(allmapsRequests.length).toBeGreaterThan(0);
	});

	test('refuses a viewer page answered with 200, naming it for what it is', async ({ page }) => {
		await installIiifHosts(page);
		await openNewProject(page);

		await lookUp(page, 'https://library.test/maps/1657');

		const error = page.getByTestId('remote-error');
		await expect(error).toContainText('sent a web page rather than a IIIF description');
		await expect(error).toContainText('library.test');
	});

	test('copies a plain image file into the Workspace and tiles it here', async ({ page }) => {
		// The third thing this one box accepts, and the only one that is not a reference: a single
		// image file has no request that returns part of it, so it cannot be drawn from where it is.
		// The address is recognised from what the host *sent* — an image `content-type` — rather than
		// from how it is spelled, which is why the fixture serves it from a path with no extension in
		// one of the two lookups below.
		await installIiifHosts(page);
		// Registered after the fixture hosts so it shadows their handler for this path (Playwright
		// consults the most recently registered route first).
		await page.route('https://images.test/plain/**', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'image/png',
				headers: { 'access-control-allow-origin': '*' },
				body: gradientPng(IMAGE_WIDTH, IMAGE_HEIGHT)
			})
		);
		await openNewProject(page);

		await lookUp(page, 'https://images.test/plain/la-floride.png');

		// The dialog closes on the download, as it does when a file is picked: what happens next is the
		// tiler's, and it reports on the new Layer's own card.
		await expect.poll(() => addMapImageIsOpen(page)).toBe(false);
		await expect(layerRows(page)).toHaveCount(1);

		const row = await openLayerRow(page, 0);
		// **Not referenced.** The tiles are files of this Workspace, so no Library is named on the row —
		// which is the whole difference between this source and the one above it.
		await expect(row.getByTestId('referenced-image-host')).toHaveCount(0);

		// A pyramid of ours, written under the Workspace root (ADR-0023), with the sheet's real size.
		const images = await page.evaluate(async () => {
			const root = await workspaceRoot();
			const directory = await root.getDirectoryHandle('images');
			const ids: string[] = [];
			for await (const name of directory.keys()) ids.push(name);
			return ids;
		});
		expect(images).toHaveLength(1);
		const info = (await readJson(page, '', `images/${images[0]}/info.json`)) as {
			width: number;
			height: number;
		};
		expect(info.width).toBe(IMAGE_WIDTH);
		expect(info.height).toBe(IMAGE_HEIGHT);

		// The Map Image is named after the file the address would have saved as, which for an address
		// with nothing to save as falls back to what the host said it sent.
		const manifest = (await readJson(page, '', `images/${images[0]}/manifest.json`)) as {
			label: { none: string[] };
		};
		expect(manifest.label.none[0]).toBe('la-floride.png');
	});

	test('is reachable and operable by keyboard alone', async ({ page }) => {
		// Driven entirely from the keyboard, **including the step that reaches it**: the library source
		// is inside a dialog, so "reachable" starts one gesture earlier. Reaching it with `click()`
		// while the test's name claimed otherwise made the first half of this claim untrue and
		// unasserted at the same time.
		await installIiifHosts(page);
		await openNewProject(page);

		await addMapImageButton(page).focus();
		await page.keyboard.press('Enter');
		await expect.poll(() => addMapImageIsOpen(page)).toBe(true);

		await page
			.getByLabel('IIIF Manifest, Collection, image service, or image file address')
			.focus();
		await page.keyboard.type('https://library.test/iiif/atlas/manifest.json');
		await page.keyboard.press('Enter');

		await expect(page.getByTestId('remote-canvas')).toHaveCount(3);

		const second = page.getByTestId('remote-canvas').nth(1);
		await second.focus();
		await expect(second).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('remote-add')).toBeVisible();

		const add = page.getByTestId('remote-add');
		await add.focus();
		await page.keyboard.press('Enter');
		await expectReferencedMap(page);
	});
});

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE EDITOR DOES NOT READ A MAP IMAGE AS A DOCUMENT
 *
 * The editor has no unwarped reading affordance, so nothing here opens a referenced map in
 * triiiceratops or asserts ADR-0018's Svelte-component import through the custom-element registry.
 *
 * **The unwarped view is not dropped, only moved**: the published viewer keeps it, and
 * `viewer-reader.e2e.ts`'s "a Map Image read unwarped" block is where it is asserted. That block
 * does **not** carry an equivalent of the custom-element assertion — see the amendment note on
 * ADR-0018, which records the gap rather than implying it was moved.
 *
 * What this block still holds is the *warped* half: a referenced Layer drawn from the remote host's
 * tiles, by both routes in.
 */
test.describe('a referenced Map Image, drawn from the library that holds it', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await emptyWorkspace(page);
		await page.reload();
	});

	/**
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * BOTH WAYS IN TO THE LAYERS PANE, BECAUSE THEY WERE NOT EQUIVALENT
	 *
	 * A fresh load of `/layers?p=…` **drew this Layer blank**, while the client-side navigation from the
	 * Project page drew it correctly. On a load the pane builds the stack as soon as it has each Layer's
	 * Alignment, and `remote.json` — the only record of where a referenced image's tiles are — is read
	 * after that: the Layer was handed `service: ''`, which is the ADR-0004 placeholder document, and
	 * asked the injection shim for a pyramid the Project does not contain. The record arriving a moment
	 * later changed nothing, because the remote service was not part of what the pane rebuilds the stack
	 * for.
	 *
	 * Only this test's `'load'` half can see that, and only `editor-layers.e2e.ts`'s link-route test can
	 * see the defect that went the other way round — so both files now cover both routes. Left with one
	 * route each, either defect could come back unnoticed.
	 */
	for (const via of ['link', 'load'] as const) {
		test(`draws a referenced Layer warped, from tiles the remote host served (reached by ${via})`, async ({
			page
		}) => {
			test.slow();
			// The other half of "a referenced image produces a Layer with `imageMode: 'referenced'` **and
			// renders from the remote host**". The Layer part is asserted above, on `project.json`; this is
			// the rendering, asserted the way `editor-offline-copy.e2e.ts` asserts it — on the warped
			// Layer's own tile cache — because the failure this path has is an error `@allmaps/render`
			// logs and swallows, so a check for an absence of console errors goes green over a blank map.
			//
			// It is also the assertion that catches the specific mistake this path is most able to make:
			// handing the renderer an Alignment whose `resource.id` is the ADR-0004 placeholder. That
			// document parses, solves, and reports a map id — and then asks the injection layer for a
			// pyramid the Project does not contain, and draws nothing.
			await installIiifHosts(page, {
				communityAnnotations: [communityAnnotation('images.test', 'florida')]
			});
			await openNewProject(page);

			await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
			await page.getByTestId('remote-canvas').nth(1).click();
			await expect(page.getByTestId('community-offer')).toBeVisible();
			await page.getByTestId('remote-add').click();
			await expectReferencedMap(page);
			// The record of where the tiles are has reached the Workspace before the pane is opened, so the
			// `'load'` half is about the pane's own ordering rather than about a write that had not happened.
			await expect(page.getByRole('status')).toHaveText('Saved locally');

			const tileRequests: string[] = [];
			page.on('request', (request) => {
				if (/images\.test.*default\.(jpg|png)$/.test(request.url()))
					tileRequests.push(request.url());
			});
			// And nothing may go to the placeholder host: that is what a referenced image drawn as though it
			// were a local copy would ask for.
			const placeholderRequests: string[] = [];
			page.on('request', (request) => {
				if (request.url().includes('unset.invalid')) placeholderRequests.push(request.url());
			});

			// `via: 'link'` used to mean "follow the Project page's Layers link". There is no such page
			// any more: the Layer stack is the Project, so arriving is already being there and the two
			// paths differ only in whether the screen was loaded fresh.
			if (via === 'link') await expect(page.getByTestId('layer-sidebar')).toBeVisible();
			else await page.goto('/?p=amsterdam-1625');
			await expect(page.getByRole('heading', { name: 'Layers in this Project' })).toBeVisible();

			// The Layer is on the map, not refused.
			await expect
				.poll(
					() =>
						page.evaluate(() => {
							const handle = window.ballastellaLayerStack;
							if (!handle) return -1;
							return Object.keys(handle.warped).length;
						}),
					{ timeout: 30_000 }
				)
				.toBe(1);

			// It carried bytes, and they came from the library. `fitBounds` first, exactly as
			// `editor-layers.e2e.ts` does: the renderer has no reason to ask for a tile for a Layer that is
			// not on screen, and the fixture's Control Points put this one off the coast of Florida.
			await expect
				.poll(
					() =>
						page.evaluate(async () => {
							const handle = window.ballastellaLayerStack;
							const layer = Object.values(handle?.warped ?? {})[0];
							if (!handle || !layer) return 0;
							handle.map.fitBounds(layer.getBounds(), { animate: false });
							await new Promise((resolve) => setTimeout(resolve, 1500));
							return layer.renderer?.tileCache?.getCachedTiles?.()?.length ?? 0;
						}),
					{ timeout: 60_000, intervals: [2000] }
				)
				.toBeGreaterThan(0);

			expect(tileRequests.length).toBeGreaterThan(0);
			expect(placeholderRequests).toEqual([]);
		});
	}

	test('says so when the record of where a referenced map lives cannot be read', async ({
		page
	}) => {
		// `remote.json` is the only thing that says where a referenced Map Image's tiles are, and a
		// Project whose copy of it has been hand-edited or half-written is a Layer nothing can draw. The
		// failure this guards is the quiet one: skipping the record, and leaving the scholar with a Layer
		// that draws nothing and no sentence anywhere. Opening the Project must not fail either — the
		// other Map Images are fine — so the readable ones are listed and the broken one is named.
		//
		// Two maps, because one is not the same test: the reason is shown beside the Layer stack, so a
		// Project whose *only* referenced record is unreadable currently says nothing at all. That gap
		// is recorded against `apps/editor/src/lib/project/ProjectScreen.svelte` rather than asserted
		// here.
		await installIiifHosts(page);
		await openNewProject(page);

		for (const name of ['florida', 'approaches']) {
			await lookUp(page, `${service('images.test', name)}/info.json`);
			await expect(page.getByTestId('remote-add')).toBeVisible();
			await page.getByTestId('remote-add').click();
			// ⚠ **By image id, never by position, once this Project has more than one Layer.** A new
			// map Layer goes to the *top* of the stack, so between the add and the re-render index 0
			// names the row that was already there — and `openLayerRow` is idempotent, so it reads
			// `aria-expanded="true"` off the *old* row, clicks nothing, and hands back a locator that
			// then resolves to the new, still-closed one. Measured on the second pass of this loop: 2
			// failures in 11 runs, always "referenced-image-host … element(s) not found", with the page
			// snapshot showing row 2 open and row 1 closed. An index is not a subject when the list can
			// grow at the front.
			await expectReferencedMap(
				page,
				page.locator(
					`[data-testid="layer-row"][data-image-id="${generateId(service('images.test', name))}"]`
				)
			);
		}
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const broken = generateId(service('images.test', 'approaches'));
		await writeFile(page, '', `images/${broken}/remote.json`, '{"label":"corrupt"}');

		await page.goto('/?p=amsterdam-1625');

		// The readable one still names its library, so one broken record has not taken the Project down
		// with it — and the broken one's row opens to *nothing* about a library rather than to an error.
		// Asked of each row in turn, because only one Layer is open at a time: a count over the whole
		// page would be 1 whichever of the two was open, including neither.
		const readable = generateId(service('images.test', 'florida'));
		const readableRow = await expectReferencedMap(
			page,
			page.locator(`[data-testid="layer-row"][data-image-id="${readable}"]`)
		);
		await expect(readableRow.getByTestId('referenced-image-label')).toHaveCount(1);
		const brokenRow = await openLayerRow(
			page,
			page.locator(`[data-testid="layer-row"][data-image-id="${broken}"]`)
		);
		await expect(brokenRow.getByTestId('referenced-image-label')).toHaveCount(0);

		const alert = page.getByRole('alert').filter({ hasText: broken });
		await expect(alert).toContainText('names no image service');
		await expect(alert).toContainText('nowhere to fetch its tiles from');
	});

	test('offers no unwarped view, and loads no OpenSeadragon to give one', async ({
		page,
		baseURL
	}) => {
		// This replaces the two tests named in this block's header rather than merely deleting them. A
		// claim of the form "X is gone" is the easiest kind to pass vacuously —
		// "no control named X" is true of a page that failed to render at all — so this asserts the
		// *absence* only on a page where the affordance's own preconditions are met: a referenced
		// Map Image, added from a library, with its Layer row open and naming its host. That row
		// is exactly where "View unwarped" used to be.
		//
		// The bundle half is what catches a regression no `data-testid` could: an import that comes
		// back without a control to click.
		//
		// **It reads the bytes, not the URLs.** The first cut of this test collected request URLs and
		// matched `/triiiceratops|openseadragon/` on them, which passes whatever the code does — these
		// specs run against `vite preview` over a production build, where every chunk is named by a
		// content hash and no package name survives into a URL. That is exactly the vacuous shape this
		// suite keeps shipping, so what is asserted instead is the *content* of this route's assets.
		//
		// **Where the list comes from matters, and response events alone were not good enough.** The
		// second cut collected `page.on('response')` URLs. Measured against a probe that put
		// triiiceratops back in the bundle: it failed on the first attempt and **passed on the retry**,
		// because a chunk served from the browser's cache on the second run raised no response event
		// this test saw. A check that reports the truth once and then reports green is worse than no
		// check. So the list is taken from what the documents *declare* — SvelteKit's static build
		// emits a `modulepreload` link for every chunk of a route, and a `stylesheet` link for every
		// sheet — and the observed responses are unioned in on top to catch anything imported later.
		// The declared half cannot be cached away, because it is read out of the served HTML.
		//
		// **Every route, not this one.** The third cut read only the live DOM of `/`, and the editor is
		// a three-document static build: `index.html`, `align.html` and `image-pane.html` ship 13, 14
		// and 12 modulepreload links respectively, overlapping but not identical. Measured with a probe
		// that imported triiiceratops into `routes/align/+page.svelte` alone: the offending chunk is
		// `nodes/3.*`, which `align.html` declares and `index.html` does not mention at all — so that
		// version stayed green while a plain `grep -rilE "openseadragon" apps/editor/build` caught it,
		// narrower than the check it replaced. The documents are **discovered** from the
		// build rather than listed here, so a fourth route cannot join the app and quietly escape this.
		//
		// `openseadragon` is a **known-good positive**: before the removal it matched
		// `_app/immutable/chunks/BjdhZAMi.js`, which the Project route loaded, and it survives
		// minification — it is in the viewer's chunk today. A marker absent from every build would make
		// this check unfalsifiable; this one was present until the commit that removed it.
		const origin = new URL(baseURL ?? 'http://localhost').origin;
		const responded: string[] = [];
		page.on('response', (response) => {
			const url = response.url();
			if (url.startsWith(origin) && /\.(js|css)(\?|$)/.test(url)) responded.push(url);
		});

		await installIiifHosts(page);
		await openNewProject(page);

		await lookUp(page, `${service('images.test', 'florida')}/info.json`);
		await page.getByTestId('remote-add').click();
		const referencedRow = await expectReferencedMap(page);
		// The precondition: this is the row that used to carry the control, and it is populated.
		await expect(referencedRow.getByTestId('referenced-image-host')).toHaveText('images.test');

		await expect(referencedRow.getByTestId('view-unwarped')).toHaveCount(0);
		await expect(page.getByTestId('view-unwarped')).toHaveCount(0);
		await expect(page.getByTestId('unwarped-view')).toHaveCount(0);
		await expect(page.getByRole('button', { name: /unwarped/i })).toHaveCount(0);

		// ADR-0018's decision now scopes to the viewer, so neither triiiceratops export is in this app.
		const registered = await page.evaluate(() =>
			['triiiceratops-viewer', 'triiiceratops-element'].map(
				(name) => customElements.get(name) !== undefined
			)
		);
		expect(registered).toEqual([false, false]);

		// The live DOM of the route this test drove, so the assets below are known to be ones a real
		// session loads and not only ones a document mentions.
		const loadedHere = await page.evaluate(() =>
			[
				...document.querySelectorAll<HTMLLinkElement | HTMLScriptElement>(
					'link[rel="modulepreload"][href], link[rel="stylesheet"][href], script[type="module"][src]'
				)
			].map((element) => (element instanceof HTMLLinkElement ? element.href : element.src))
		);

		const routes = await editorRouteDocuments();
		// Fewer than the three this build has means discovery broke, and a discovery that found nothing
		// would make every assertion below vacuous.
		expect(routes.length, 'route documents discovered in the editor build').toBeGreaterThanOrEqual(
			3
		);

		const declared: string[] = [...loadedHere];
		for (const route of routes) {
			const url = `${origin}/${route}`;
			const document = await page.request.get(url);
			expect(document.ok(), `fetching ${url}`).toBe(true);
			declared.push(...assetReferences(await document.text(), url));
		}

		const inspected = [...new Set([...declared, ...responded])].filter((url) =>
			url.startsWith(origin)
		);
		// **Nothing inspected is a failure, not a pass**, and this guard is on `inspected` rather than
		// on `declared` deliberately: the loop below runs over `inspected`, so an origin that stopped
		// matching would empty it, skip every iteration, and leave `carrying` an empty array that
		// satisfies the final assertion. Measured, not reasoned about — with the filter pointed at a
		// host nothing serves, the earlier guard on `declared` was **still satisfied and the test
		// passed**. A guard on a list the loop does not read is not a guard.
		expect(inspected.length, 'scripts and stylesheets inspected').toBeGreaterThan(0);

		const carrying: string[] = [];
		for (const url of inspected) {
			const body = await page.request.get(url);
			expect(body.ok(), `re-fetching ${url}`).toBe(true);
			if (/triiiceratops|openseadragon/i.test(await body.text())) carrying.push(url);
		}
		expect(carrying, 'editor assets carrying triiiceratops or OpenSeadragon').toEqual([]);
	});
});

/**
 * Every route document the editor's static build produced, as paths to fetch from its own origin.
 *
 * **Discovered rather than listed**, because the thing this guards is a route somebody adds later.
 * `apps/editor/build` is what `vite preview` serves in `playwright.config.ts`, so these are the
 * documents actually on the wire — the reading is off disk only to enumerate them, and every one is
 * then fetched over HTTP and asserted `ok()`, which is what catches a name that has moved.
 */
async function editorRouteDocuments(): Promise<string[]> {
	const build = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/editor/build');
	const entries = await readdir(build, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
		.map((entry) => entry.name)
		.sort();
}

/**
 * Every script and stylesheet an HTML document references, resolved against the document's own URL.
 *
 * Read out of the markup rather than by mounting it, so a route this test never navigates to is
 * covered on the same terms as the one it drove. Matched attribute-order-independently: SvelteKit
 * emits `href` before `rel` on its preload links, and a pattern that assumed otherwise would find
 * nothing and report it as an app with no scripts.
 */
function assetReferences(html: string, documentUrl: string): string[] {
	const links = [...html.matchAll(/<link\b[^>]*>/g)]
		.filter((tag) => /\brel="(modulepreload|stylesheet)"/.test(tag[0]))
		.flatMap((tag) => /\bhref="([^"]+)"/.exec(tag[0])?.[1] ?? []);
	const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map((tag) => tag[1]);
	return [...links, ...scripts].map((reference) => new URL(reference, documentUrl).href);
}

// Declared here as well as in the app, because the root tsconfig compiles only `e2e/` and
// `playwright.config.ts` — it never sees the editor's own declarations.
//
// `ballastellaLayerStack` is deliberately **not** redeclared: `editor-layers.e2e.ts` already declares
// it, the two files are in one TypeScript program, and a second declaration of the same global with a
// narrower shape is a merge conflict rather than a convenience.
declare global {
	interface Window {
		ballastellaRemoteRequests?: { urls: string[]; hosts: string[] };
	}
}
