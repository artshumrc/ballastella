import { expect, test } from './support/test.js';
import { type Page } from '@playwright/test';
import { generateAnnotation, parseAnnotation, validateAnnotation } from '@allmaps/annotation';

import {
	baseMap,
	clickAt,
	emptyWorkspace,
	mapImage,
	makePairs,
	rows,
	showPaneDetails,
	storedAlignment,
	waitForStored,
	warpedTiles
} from './support/alignment-workspace.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { ensureAddMapImageOpen } from './support/map-images.js';
import { generateId, installIiifHosts, service } from './support/iiif-hosts.js';
import { alignFromLayer, layerRows, openLayerRow } from './support/layers.js';
import { seedFile } from './support/stored-file.js';

/**
 * Ticket 07: a Map Image whose tiles are on a Library's server is aligned **in place**.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT ONLY THIS FILE CAN ASSERT
 *
 * The reader's three answers about a Library's `info.json` — level 2, level 0 with tiles, level 0
 * without — are pure functions over documents and are asserted as such, in
 * `packages/core/src/image-pane/iiif-image-pane.test.ts`. That is deliberate: it is what makes the
 * add-time refusal decidable without a browser.
 *
 * What is left is everything a browser is needed for, and it is the whole of the ticket:
 *
 *   * that the align route really builds its pane from the Library rather than from the Workspace,
 *     asserted by **where the tile requests went** and by the pane's own reported geometry;
 *   * that Control Points place on it and the warped Layer draws — asserted through the per-Layer
 *     tile cache, which counts tiles that arrived **and decoded**. A check for an absence of console
 *     errors is not acceptable here and the ticket says so: the pre-patch `@allmaps/render` failure
 *     was swallowed, and a console-only check went green over a blank map;
 *   * that **no pyramid appears in the Workspace**, asserted as an exact file list rather than a
 *     count, which is the shape ticket 06 established for "nothing was copied";
 *   * and what happens with the connection cut, on both sides of the pane existing.
 *
 * Every host is routed from `support/iiif-hosts.ts`, so **nothing in this file reaches the internet.**
 */

// The catalog's archive is somebody else's bucket and the network fence refuses it. Routed on the
// **context** rather than the page: a request that has passed through a service worker is not the
// page's own as far as Playwright is concerned, and this file cuts the network, which is exactly when
// a worker is in the path.
test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

const PROJECT_NAME = 'A Library’s Florida';

/** A Project open, with nothing in it. */
async function openNewProject(page: Page): Promise<void> {
	await page.goto('/');
	await emptyWorkspace(page);
	await page.reload();
	await createAndOpenProject(page, PROJECT_NAME);
}

/** A second Project in the same Workspace, from the hub. The Workspace is left as it is. */
async function createAndOpenProject(page: Page, name: string): Promise<void> {
	await page.getByRole('button', { name: 'New Project' }).click();
	const dialog = page.getByRole('dialog', { name: 'New Project' });
	await dialog.getByLabel('Project name').fill(name);
	await dialog.getByRole('button', { name: 'Create' }).click();
	await page.getByRole('link', { name }).click();
	await expect(page.getByTestId('project-screen')).toBeVisible();
}

/**
 * How many of the Workspace's Projects have a Layer drawing `imageId`, read off disk.
 *
 * **The precondition for anything asserting the used-by sentence**, and it is a real race rather
 * than a tidy-up: `refreshMapUsage` reads every `project.json` once per Map Image opened, so a
 * Layer still inside ADR-0017 rule 2's debounce is a Project the walk does not see — and because the
 * walk does not run again, the sentence stays wrong for the whole visit. Waiting for the bytes is
 * waiting for the thing the screen is about to read.
 */
const projectsDrawing = (page: Page, imageId: string): Promise<number> =>
	page.evaluate(async (id) => {
		const root = await workspaceRoot();
		let count = 0;
		for await (const [, handle] of root.entries()) {
			if (handle.kind !== 'directory') continue;
			try {
				const file = await (handle as FileSystemDirectoryHandle).getFileHandle('project.json');
				if ((await (await file.getFile()).text()).includes(id)) count += 1;
			} catch {
				// Not a Project directory, or its manifest is not there yet. Neither is a user of the map.
			}
		}
		return count;
	}, imageId);

/**
 * Add a referenced Map Image from a bare image-service URL.
 *
 * @returns the image id, which is `generateId(uri)` and therefore the Alignment's file name
 */
async function addReferenced(
	page: Page,
	host: string,
	name = 'florida',
	/** How many Layers the Project has once this one is in. */
	layers = 1
): Promise<string> {
	await ensureAddMapImageOpen(page);
	await page.getByTestId('remote-url').fill(`${service(host, name)}/info.json`);
	await page.getByTestId('remote-read').click();
	await expect(page.getByTestId('remote-add')).toBeVisible({ timeout: 30_000 });
	await page.getByTestId('remote-add').click();
	await expect(layerRows(page)).toHaveCount(layers, { timeout: 30_000 });
	return generateId(service(host, name));
}

/**
 * The Layer drawing one Map Image, found by the image it draws rather than by its position.
 *
 * A new map Layer goes to the *top* of the stack, so index 0 names one row before a second map is
 * added and another after it — `support/layers.ts` records two failures in eleven runs from exactly
 * that. Every test below that has two maps on screen addresses them this way.
 */
const layerFor = (page: Page, imageId: string) =>
	page.locator(`[data-testid="layer-row"][data-image-id="${imageId}"]`);

/** Every file under `images/<imageId>/`, sorted. The exact-list shape ticket 06 established. */
const imageFiles = (page: Page, imageId: string): Promise<string[]> =>
	page.evaluate(async (id) => {
		const root = await workspaceRoot();
		const walk = async (
			directory: FileSystemDirectoryHandle,
			prefix: string
		): Promise<string[]> => {
			const found: string[] = [];
			for await (const [name, handle] of directory.entries()) {
				if (handle.kind === 'directory') {
					found.push(...(await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`)));
				} else {
					found.push(`${prefix}${name}`);
				}
			}
			return found;
		};
		try {
			const images = await root.getDirectoryHandle('images');
			const one = await images.getDirectoryHandle(id);
			return (await walk(one, '')).sort();
		} catch {
			return [];
		}
	}, imageId);

/**
 * A tile the Library served **1:1** — the finest level of the pyramid, and the whole of "deep zoom".
 *
 * A IIIF tile request is `{x},{y},{w},{h}/{sw},{sh}/0/default.jpg`. When the output size equals the
 * region size no reduction was asked for, which is scale factor 1 and no other. Matching on the
 * output size alone does not say that: at scale factor 2 a 512-pixel region is *also* delivered as
 * `256,256`, so a pane that never left its overview satisfies it.
 */
const atFullResolution = (url: string): boolean => {
	const parts = /\/(\d+),(\d+),(\d+),(\d+)\/(\d+),(\d+)\/0\/default\.(jpg|png)$/.exec(url);
	return parts !== null && parts[3] === parts[5] && parts[4] === parts[6];
};

/** Wait until the alignment route's pane is live and every tile of the first view has decoded. */
async function waitForPane(page: Page): Promise<void> {
	await expect(page.getByTestId('image-pane')).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId('map-image-tiles')).toHaveAttribute('data-tiles-loaded', 'true', {
		timeout: 60_000
	});
	await expect(page.getByTestId('pairing-status')).toContainText('first Control Point');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// A LIBRARY'S SHEET, ALIGNED WITHOUT BEING COPIED

for (const [what, host] of [
	['a level 2 service', 'images.test'],
	// A level 0 service serves exactly the tiles it declares and nothing else — no `full/max`, no
	// arbitrary regions. **It must be alignable identically**, because that is the commonest shape a
	// statically cut pyramid on a plain web server has, and the pane never asks for anything but tiles.
	['a level 0 service that publishes tiles', 'static.test']
] as const) {
	test(`aligns ${what} in place, drawing it warped from the library`, async ({ page }) => {
		test.slow();
		await installIiifHosts(page);
		await openNewProject(page);

		// Every tile request, by host, so "the pane read the Library" is a claim about the network
		// rather than about a variable. And nothing may reach the ADR-0004 placeholder host: that is
		// what a referenced map drawn as though its pyramid were here would ask for, and before this
		// ticket it is exactly what the pane asked for.
		const tileRequests: string[] = [];
		const placeholderRequests: string[] = [];
		page.on('request', (request) => {
			const url = request.url();
			if (url.includes(host) && /default\.(jpg|png)$/.test(url)) tileRequests.push(url);
			if (url.includes('unset.invalid')) placeholderRequests.push(url);
		});

		const imageId = await addReferenced(page, host);
		await alignFromLayer(page);
		await waitForPane(page);

		// The pane is reading the Library's sheet: its declared geometry, not the Workspace's. Read off
		// the pane's own summary, which is the only way to say *which* pyramid is on screen.
		await showPaneDetails(page);
		const pyramid = page.getByTestId('map-image-pyramid');
		await expect(pyramid).toHaveAttribute('data-image-id', imageId);
		await expect(pyramid).toHaveAttribute('data-width', '700');
		await expect(pyramid).toHaveAttribute('data-height', '500');

		// Deep zoom: the finest level exists and is asked for. Before this ticket every one of these
		// requests went to `unset.invalid` and was answered out of a store with no such pyramid.
		//
		// **A tile served 1:1 is what "the finest level" means**, and that is what `atFullResolution`
		// asks: region width equals output width. The first cut of this matched `/1,0/0/default` as an
		// alternative, which cannot occur — a IIIF size is `{w},{h}` and a region is four numbers, so
		// `1,0` is neither — and `/256,256/` alone, which a *coarser* level also produces the moment a
		// 512-pixel region is asked for at scale factor 2. Both would have gone green over a pane that
		// never left its overview.
		await page.getByTestId('image-pane').hover();
		await page.mouse.wheel(0, -1_000);
		await expect
			.poll(() => tileRequests.filter(atFullResolution).length, { timeout: 30_000 })
			.toBeGreaterThan(0);
		expect(placeholderRequests).toEqual([]);

		// Control Points place on it, by clicking, exactly as they do on a Workspace-held map.
		await makePairs(page, 3);
		await expect(rows(page)).toHaveCount(3);
		await waitForStored(page, imageId, 3);

		// And it draws warped.
		await expect(page.getByTestId('warped-status')).toHaveAttribute('data-warped-status', 'drawn', {
			timeout: 60_000
		});

		// ⚠ **`data-warped-status="drawn"` is not the assertion, and this is why.** It says the
		// renderer accepted a document, not that any of the map arrived. Before this ticket the align
		// route built that document from the ADR-0004 placeholder even for a referenced map, so
		// `@allmaps/maplibre` asked the ADR-0011 shim for a pyramid the Workspace does not contain —
		// and because the shim answers internally, **there is no request on the wire to catch it**, so
		// `placeholderRequests` above stays empty either way. The status went `drawn`, the map was
		// blank, and nothing anywhere said so. Counting tiles that arrived *and decoded* is the only
		// signal that separates the two.
		await expect
			.poll(() => warpedTiles(page), { timeout: 120_000, intervals: [2000] })
			.toBeGreaterThan(0);
		// **And they came from the Library**, which is the other half: a tile count alone would also be
		// satisfied by tiles served out of the Workspace, which is what an offline copy is.
		//
		// ⚠ **This is the assertion that earns that claim, and it is the file list.** A second
		// `expect(tileRequests.length).toBeGreaterThan(0)` stood here and claimed it; it could not go
		// red — the poll above had already asserted a *filtered subset* of the same array non-empty —
		// and `tileRequests` cannot tell a warped tile from an unwarped one anyway, because both are
		// requests to the same host. What distinguishes the two is that there is no pyramid here to
		// have served them from: an exact list rather than a count, so a stray tile is a named file.
		expect(await imageFiles(page, imageId)).toEqual(['remote.json']);
	});
}

test('writes an Alignment addressed at the library, which round-trips unchanged', async ({
	page
}) => {
	test.slow();
	await installIiifHosts(page);
	await openNewProject(page);
	const imageId = await addReferenced(page, 'images.test');
	await alignFromLayer(page);
	await waitForPane(page);
	await makePairs(page, 3);
	await waitForStored(page, imageId, 3);

	const written = await storedAlignment(page, imageId);
	expect(written).not.toBeNull();
	const document = JSON.parse(written as string);

	// SPEC story 60 and ADR-0007: this is what makes the file resolvable by Allmaps, and what makes
	// the warped Layer render at all — `@allmaps/maplibre` fetches tiles from this id. The placeholder
	// here would be a standard-shaped document nothing in the world can resolve.
	expect(document.target.source.id).toBe(service('images.test', 'florida'));
	expect(JSON.stringify(document)).not.toContain('unset.invalid');

	// ─────────────────────────────────────────────────────────────────────────────────────
	// **UPSTREAM SAYS SO, ABOUT THE BYTES THE RUNNING APP WROTE**, which is the shape
	// `editor-alignment.e2e.ts` established for the local case. The validator and the parser run here
	// in Node, on the file that landed in OPFS — not on serialiser output built in-process.
	expect(
		() => validateAnnotation(document),
		'upstream refused the file the app wrote'
	).not.toThrow();

	const parsed = parseAnnotation(document);
	expect(parsed).toHaveLength(1);
	// The address survives the parse, which is the part that matters for a referenced map: this is
	// the id `@allmaps/maplibre` fetches tiles from, and Allmaps' own resolver looks up.
	expect(parsed[0]?.resource.id).toBe(service('images.test', 'florida'));
	expect(parsed[0]?.gcps).toHaveLength(3);
	expect(parsed[0]?.resource.width).toBe(700);

	// And back out again unchanged. Re-generated by the library rather than by this app's serialiser,
	// so "unchanged" is a claim about the interchange format rather than about our determinism.
	const regenerated = generateAnnotation(parsed) as {
		items?: { target?: { source?: { id?: string } } }[];
	};
	expect(regenerated.items?.[0]?.target?.source?.id).toBe(service('images.test', 'florida'));
	expect(JSON.stringify(regenerated)).not.toContain('unset.invalid');
});

test('refuses a service that publishes no tiles when the map is added, naming the host', async ({
	page
}) => {
	await installIiifHosts(page);
	await openNewProject(page);

	// ADR-0007's principle, extended from CORS to the pane itself: the refusal is decided when the
	// resource is added and never when Align is clicked. A user must never be given a Layer with an
	// Align button that leads to a screen which cannot work.
	await ensureAddMapImageOpen(page);
	await page.getByTestId('remote-url').fill(`${service('sizes-only.test', 'plain')}/info.json`);
	await page.getByTestId('remote-read').click();

	const error = page.getByTestId('remote-error');
	await expect(error).toBeVisible({ timeout: 30_000 });
	// The host, so a scholar can say which server this is about, and the reason.
	await expect(error).toContainText('sizes-only.test');
	await expect(error).toContainText('publishes no tiles');
	await expect(error).toContainText('does not support tiles or custom regions and sizes');
	// A remedy that exists at this moment: the map has not been added, so nothing about it can be
	// copied yet.
	await expect(error).toContainText('add it from a file');
	// **Not** the diagnosis for a document of the wrong shape. This is the message the app gave before
	// ticket 07, and it sends the user hunting for a IIIF link on a page that already gave them the
	// right URL — see `remote-resource.ts` for why one `IIIF.parse` call produces both faults.
	await expect(error).not.toContainText('not a IIIF Manifest');

	// **No Layer, and nothing on disk.** The unguarded direction: a refusal that still added the map
	// would leave the Align button in place, which is the failure this criterion is about.
	await expect(page.getByTestId('remote-add')).toHaveCount(0);
	await expect(layerRows(page)).toHaveCount(0);
	expect(await imageFiles(page, generateId(service('sizes-only.test', 'plain')))).toEqual([]);
});

test('still refuses a host whose info.json is readable and whose tiles are not', async ({
	page
}) => {
	// Ticket 06's behaviour, asserted here so this ticket cannot regress it: extending the add-time
	// probe to *build the pane* must not displace the CORS half of the same probe.
	await installIiifHosts(page);
	await openNewProject(page);

	await ensureAddMapImageOpen(page);
	await page.getByTestId('remote-url').fill(`${service('tiles-only.test', 'locked')}/info.json`);
	await page.getByTestId('remote-read').click();

	const error = page.getByTestId('remote-error');
	await expect(error).toBeVisible({ timeout: 30_000 });
	await expect(error).toContainText('tiles-only.test');
	await expect(layerRows(page)).toHaveCount(0);
});

test('says on the Layer, in text, that this map needs the network', async ({ page }) => {
	await installIiifHosts(page);
	await openNewProject(page);
	await addReferenced(page, 'images.test');

	// **Text in the accessibility tree, not a colour** — the same treatment ticket 05 gave the
	// not-aligned state. Asserted by reading the accessible text rather than the `data-` attribute,
	// because the attribute is for tests and the sentence is for the user; a version that kept the
	// attribute and dropped the words would pass an attribute assertion.
	// Inside the open card since the Layers revision, so the card is opened rather than the badge
	// waited for on a collapsed row — where it is not in the DOM at all.
	const badge = (await openLayerRow(page, layerRows(page).first())).getByTestId('layer-image-mode');
	await expect(badge).toBeVisible();
	await expect(badge).toHaveText(/needs the network/i);
	await expect(badge).toHaveAttribute('data-image-mode', 'referenced');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// WITH THE CONNECTION CUT
//
// `context.setOffline` is the emulation, and it feeds `navigator.onLine` and the `offline` event —
// which is the app's one online signal, owned by `InstalledApp`. No second listener was added for
// this (ticket 07's out-of-scope list), so what these two tests exercise is that signal.

test('refuses to open the alignment view offline, and names the host', async ({
	page,
	context
}) => {
	test.slow();
	await installIiifHosts(page);
	await openNewProject(page);
	await addReferenced(page, 'images.test');

	// ⚠ **The route is visited once online first, and that is not a workaround for the app.**
	// `/align/` is a code-split SvelteKit route, so the very first navigation to it fetches a JS chunk
	// from *this* deployment — and `setOffline` blocks localhost too. Without this, the failure is a
	// 500 from the dev server before any of this app's code runs, and the test says nothing about the
	// pane at all. (In the real offline case the service worker serves that chunk, which is
	// `editor-pwa.e2e.ts`'s subject rather than this file's.) Going back and returning is what makes
	// the second navigation a client-side one, which is the situation this test is about.
	await alignFromLayer(page);
	await waitForPane(page);
	await page.getByTestId('back-to-project').click();
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();

	// Cut *before* the view is opened. `info.json` is on the Library's server, so there is nothing to
	// build a pane from — and `remote.json` carries width and height but not the tileset, so
	// synthesising one would be guesswork drawn as fact.
	await context.setOffline(true);
	await alignFromLayer(page);

	const failure = page.getByTestId('map-image-failure');
	await expect(failure).toBeVisible({ timeout: 30_000 });
	await expect(failure).toContainText('images.test');
	await expect(failure).toContainText('no connection');
	// No pane, so nothing invites a click that would go nowhere.
	await expect(page.getByTestId('image-pane')).toHaveCount(0);

	// And it opens by itself when the connection comes back — no reload, which is the difference
	// between reading the signal and reading it once.
	await context.setOffline(false);
	await waitForPane(page);
});

test('keeps working offline once the pane exists, and says whose sheet has gone', async ({
	page,
	context
}) => {
	test.slow();
	await installIiifHosts(page);
	await openNewProject(page);
	const imageId = await addReferenced(page, 'images.test');
	await alignFromLayer(page);
	await waitForPane(page);

	// One pair placed while the sheet is still arriving, so the "before and after" is comparable.
	await makePairs(page, 1);
	await waitForStored(page, imageId, 1);

	await context.setOffline(true);

	const notice = page.getByTestId('map-image-offline');
	await expect(notice).toBeVisible({ timeout: 30_000 });
	await expect(notice).toHaveAttribute('data-offline-host', 'images.test');
	await expect(notice).toContainText('images.test');

	// **The pane is still there and Control Points still place.** Blocking would discard an alignment
	// legitimately in progress — the coordinate space is the `info.json`'s and stays valid whether or
	// not any bytes arrive, so a click is the same image pixel either way.
	await expect(mapImage(page)).toBeVisible();
	await clickAt(mapImage(page), 0.35, 0.4);
	await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
	await clickAt(baseMap(page), 0.35, 0.4);
	await expect(rows(page)).toHaveCount(2);
	// And it reached disk, which is what makes "still working" mean the work is kept.
	await waitForStored(page, imageId, 2);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// AND THEN COPIED

test('an offline copy of a map aligned in place keeps every Control Point', async ({ page }) => {
	test.slow();
	await installIiifHosts(page);
	await openNewProject(page);
	const imageId = await addReferenced(page, 'images.test');
	await alignFromLayer(page);
	await waitForPane(page);
	await makePairs(page, 3);
	await waitForStored(page, imageId, 3);

	const before = JSON.parse((await storedAlignment(page, imageId)) as string);
	expect(before.target.source.id).toBe(service('images.test', 'florida'));
	const points = before.body.features.map(
		(feature: { properties: { resourceCoords: number[] } }) => feature.properties.resourceCoords
	);
	expect(points).toHaveLength(3);

	// Back through the route's own link rather than a hand-built URL: the Project's directory name is
	// derived from its title, and guessing the slug is a test that fails for a reason unrelated to
	// anything it is asserting.
	await page.getByTestId('back-to-project').click();
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	const row = await openLayerRow(page);
	await row.getByTestId('offline-copy-open').click();
	await expect(page.getByRole('dialog', { name: 'Make an offline copy' })).toBeVisible();
	// The dialog opens before its plan is ready — see `editor-offline-copy.e2e.ts` for what racing
	// that costs. `data-step` is the dialog's own account of where it is.
	await expect(page.getByTestId('offline-copy-status')).toHaveAttribute('data-step', 'deciding');
	await page.getByTestId('offline-copy-start').click();
	await expect(page.getByTestId('offline-copy-done')).toBeVisible({ timeout: 120_000 });

	// The copy re-serialises the Alignment through `serialiseAlignment(parseAlignment(...))`, which
	// rewrites `resource.id` back to the placeholder — correct, because the tiles are here now.
	await expect
		.poll(
			async () => {
				const written = await storedAlignment(page, imageId);
				return written === null ? '' : JSON.parse(written).target.source.id;
			},
			{ timeout: 60_000 }
		)
		.toContain('unset.invalid');

	// **Every Control Point survives that rewrite**, which is the half worth asserting: the rewrite
	// goes through this build's model, and a Control Point lost there is lost silently.
	const after = JSON.parse((await storedAlignment(page, imageId)) as string);
	expect(
		after.body.features.map(
			(feature: { properties: { resourceCoords: number[] } }) => feature.properties.resourceCoords
		)
	).toEqual(points);

	// And now the pyramid really is here, which is what an offline copy means.
	const files = await imageFiles(page, imageId);
	expect(files).toContain('remote.json');
	expect(files).toContain('info.json');
	expect(files.filter((name) => name.endsWith('default.jpg')).length).toBeGreaterThan(0);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// AN ALIGNMENT THAT CHANGED SOMEWHERE ELSE
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ ADR-0023's MITIGATION **IS** THE VISIBILITY, SO THE VISIBILITY IS WHAT HAS TO BE ASSERTED. │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// ADR-0023 makes an Alignment the Workspace's, shared by every Project that draws the map, and
// accepts that a Workspace kept in git or Dropbox can receive a colleague's edit between this
// session's read and its write. It asks for **visibility, not prevention** — and visibility is a
// screen, so nothing under `packages/core` and nothing on `EditorSession` can stand in for it.
//
// The first cut of this ticket asserted `opened.alignmentChangedElsewhere?.imageId` in a unit test:
// a **session field**, which is precisely the proxy SPEC's Testing Decisions rule out — "assert on
// file contents and on rendered UI, never on internal call sequences, private state". Every one of
// the four deletions below left the whole suite green: the alert, both handlers, the assignment that
// lets `reload()` find the pyramid, and the `reload()` call itself, which is a real data-loss path —
// without it the screen keeps drawing the Control Points the user has just given up and the next
// drag writes them back.
//
// The Workspace here holds a **referenced** map because this file's subject is a referenced map, and
// the concurrent-edit path is the one place ticket 07's own writer runs with `basedOn` set.

/**
 * A colleague's Alignment, arriving through a synced Workspace while this session has it open.
 *
 * **Their document is this session's own with one Control Point taken out**, which makes it parse,
 * differ in bytes, and be distinguishable on screen by a count rather than by a coordinate readout.
 *
 * Written straight into the Workspace, because that is what the situation *is*: another process's
 * write. A gesture in this application cannot produce one, which is the whole reason this needs a
 * fixture.
 *
 * **Through `support/stored-file.ts`'s `seedFile`, and the spelling matters twice.** The fence knows
 * that name, so this write is *seen* by `check-alignment-writers.mjs` and has to say why it is a
 * fixture — the first cut assembled the same path out of `getDirectoryHandle('alignments')` and a
 * bare `` `${id}.json` ``, which no pattern matches, so it was a new unfenced writer of
 * `alignments/<id>.json` added in the very change that recounts the fence's honesty statement. And
 * `seedFile` writes atomically, so the next read cannot catch this half-written.
 *
 * @returns their document, byte for byte, so a restore can be compared against it
 */
async function aColleagueChanges(page: Page, imageId: string): Promise<string> {
	const mine = JSON.parse((await storedAlignment(page, imageId)) as string);
	const theirs = JSON.stringify({
		...mine,
		body: { ...mine.body, features: mine.body.features.slice(0, 2) }
	});
	// alignment-write-is-the-fixture: another process's Alignment landing through a synced Workspace, which is the situation under test and which no gesture in this app can produce
	await seedFile(page, `alignments/${imageId}.json`, theirs);
	return theirs;
}

/** Three pairs placed here, two of theirs on disk, and the fourth pair is what collides. */
async function reachTheCollision(page: Page, imageId: string): Promise<string> {
	await makePairs(page, 3);
	await waitForStored(page, imageId, 3);
	const theirs = await aColleagueChanges(page, imageId);

	// The next gesture end is the write that goes over their version. **It is not blocked** — losing
	// the edit in front of the user to protect one they cannot see is the worse trade and is not what
	// ADR-0023 asks for — so the pair really lands, here and on disk.
	await makePairs(page, 4);
	await expect(rows(page)).toHaveCount(4);
	await waitForStored(page, imageId, 4);
	return theirs;
}

const changedElsewhere = (page: Page) => page.getByTestId('alignment-changed-elsewhere');

test('says when somebody else changed this Alignment, and puts their version back', async ({
	page
}) => {
	test.slow();
	await installIiifHosts(page);
	await openNewProject(page);
	const imageId = await addReferenced(page, 'images.test');
	await alignFromLayer(page);
	await waitForPane(page);

	const theirs = await reachTheCollision(page, imageId);

	// **The alert is on the screen**, which is the deliverable. `role="alert"` because it is the one
	// thing here the user cannot find out any other way: nothing moved, nothing failed, and the save
	// indicator says "Saved" — and `alert` is the role that announces on insertion, which matters when
	// the region and its first text arrive together.
	await expect(changedElsewhere(page)).toBeVisible({ timeout: 30_000 });
	await expect(changedElsewhere(page)).toHaveAttribute('role', 'alert');
	await expect(changedElsewhere(page)).toContainText('Somebody else changed');
	await expect(changedElsewhere(page)).toContainText('one Alignment');

	await page.getByTestId('restore-changed-elsewhere').click();

	// Their document is on disk, byte for byte — routed through `writeAlignmentBytes`, so it is not
	// re-serialised through this build's model and does not lose whatever this build does not model.
	await expect.poll(() => storedAlignment(page, imageId), { timeout: 30_000 }).toBe(theirs);

	// ⚠ **And the screen re-read it.** This is the assertion the whole `livePane`/`reload()` path
	// exists for: without it the pane keeps drawing the four Control Points the user has just chosen
	// to give up, and the very next drag writes them back over the version they asked to restore.
	await expect(rows(page)).toHaveCount(2);
	await expect(changedElsewhere(page)).toHaveCount(0);

	// Focus does not fall to `<body>` when the alert removes itself, and the line it lands on says
	// which of the two answers was given — CONTRIBUTING's focus-management criterion, and WCAG 2.4.3.
	const outcome = page.getByTestId('changed-elsewhere-outcome');
	await expect(outcome).toBeFocused();
	await expect(outcome).toContainText('Their version');

	// The restore reset the baseline too, so the next ordinary save is not itself reported as a second
	// concurrent change — a warning raised by the user's own act of accepting the first one.
	await makePairs(page, 3);
	await waitForStored(page, imageId, 3);
	await expect(changedElsewhere(page)).toHaveCount(0);
});

test('keeps this session’s version when that is what the user chooses', async ({ page }) => {
	test.slow();
	await installIiifHosts(page);
	await openNewProject(page);
	const imageId = await addReferenced(page, 'images.test');
	await alignFromLayer(page);
	await waitForPane(page);
	await reachTheCollision(page, imageId);
	await expect(changedElsewhere(page)).toBeVisible({ timeout: 30_000 });

	await page.getByTestId('dismiss-changed-elsewhere').click();

	// **Dismiss reads nothing back**, which is the half that separates it from the button beside it:
	// the four pairs are still on screen and still on disk, and only the warning has gone.
	await expect(changedElsewhere(page)).toHaveCount(0);
	await expect(rows(page)).toHaveCount(4);
	const kept = JSON.parse((await storedAlignment(page, imageId)) as string);
	expect(kept.body.features).toHaveLength(4);

	const outcome = page.getByTestId('changed-elsewhere-outcome');
	await expect(outcome).toBeFocused();
	await expect(outcome).toContainText('Your version has been kept');
});

test('warns only on the Map Image the warning is about', async ({ page }) => {
	test.slow();
	await installIiifHosts(page);
	await openNewProject(page);
	const florida = await addReferenced(page, 'images.test', 'florida');
	await alignFromLayer(page, layerFor(page, florida));
	await waitForPane(page);
	await reachTheCollision(page, florida);
	await expect(changedElsewhere(page)).toBeVisible({ timeout: 30_000 });

	// A second Map Image, aligned in the same session with the warning still standing. The button
	// in that alert writes **one map's file**, so showing it over another map's Control Points would
	// offer to put back a document that has nothing to do with what is on screen.
	await page.getByTestId('back-to-project').click();
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	const georgia = await addReferenced(page, 'images.test', 'georgia', 2);
	await alignFromLayer(page, layerFor(page, georgia));
	await waitForPane(page);
	await expect(changedElsewhere(page)).toHaveCount(0);

	// And it is still standing for the map it *is* about — so "scoped" is a claim about which map,
	// rather than the warning happening to be cleared by any navigation at all.
	await page.getByTestId('back-to-project').click();
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	await alignFromLayer(page, layerFor(page, florida));
	await expect(changedElsewhere(page)).toBeVisible({ timeout: 30_000 });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHO ELSE THIS ALIGNMENT BELONGS TO, AND WHAT THE SCREEN SAYS OUT LOUD

test('names the Projects that draw this Map Image while it is being aligned', async ({ page }) => {
	test.slow();
	await installIiifHosts(page);
	await openNewProject(page);
	await addReferenced(page, 'images.test');
	await alignFromLayer(page);
	await waitForPane(page);

	// SPEC story 56. ADR-0023 shares one Alignment between every Project that draws the map, so this
	// is the scope of every gesture on this screen — and it belongs here rather than only on the hub,
	// which is two navigations from the drag that moves all of them.
	const usedBy = page.getByTestId('alignment-used-by');
	await expect(usedBy).toBeVisible({ timeout: 30_000 });
	await expect(usedBy).toHaveAttribute('data-used-by-count', '1');
	// Read as text rather than off the attribute: the attribute is for tests and the sentence is for
	// the user, and a version that kept the count and dropped the words would pass an attribute check.
	await expect(usedBy).toContainText(PROJECT_NAME);
	await expect(usedBy).toContainText('shared by every Project that draws this Map Image');
});

/**
 * Two Map Images with **different** answers, so the sentence has to be about the one on screen.
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 * │ THE ID SCOPING WAS A COMMENT IN TWO PLACES AND AN ASSERTION IN NONE.                       │
 * └───────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * `mapUsage` carries the image id it was asked about and the screen compares it before showing
 * anything, both so that one map's Projects are never named against another's. With one map in one
 * Project, every version of that code says the same thing — including a version that keeps no id at
 * all. So the second map is drawn by a *second* Project, and then the two sentences differ: one
 * Project against two, singular against the plural that warns the edit moves all of them.
 *
 * This is also the only place the ≥2 branch is exercised on a real screen. `used-by.test.ts` pins
 * every branch of the string; what this adds is that the string is built from the right map's answer.
 */
test('names a different set of Projects for a different map on the same screen', async ({
	page
}) => {
	test.slow();
	await installIiifHosts(page);
	await openNewProject(page);
	const florida = await addReferenced(page, 'images.test', 'florida');
	const georgia = await addReferenced(page, 'images.test', 'georgia', 2);

	// A second Project drawing only the second map. The image id is `generateId(uri)`, the same for
	// everybody, so adding the same service here is the same Map Image — which is the whole of
	// ADR-0023 and the reason this sentence exists.
	// `goto` rather than a link, and it is doing work: a real navigation runs `pagehide`, which is
	// ADR-0017 rule 3's flush, so the Layer just added is on disk rather than inside its debounce.
	await page.goto('/');
	await createAndOpenProject(page, 'A Second Reading');
	await addReferenced(page, 'images.test', 'georgia');

	await page.goto('/');
	// **Waited for on disk**, because that is what the align screen reads. See {@link projectsDrawing}.
	await expect.poll(() => projectsDrawing(page, georgia), { timeout: 30_000 }).toBe(2);
	await expect.poll(() => projectsDrawing(page, florida), { timeout: 30_000 }).toBe(1);

	await page.getByRole('link', { name: PROJECT_NAME }).click();
	await expect(page.getByTestId('project-screen')).toBeVisible();

	const usedBy = page.getByTestId('alignment-used-by');

	await alignFromLayer(page, layerFor(page, florida));
	await waitForPane(page);
	await expect(usedBy).toHaveAttribute('data-used-by-count', '1', { timeout: 30_000 });
	await expect(usedBy).toContainText(PROJECT_NAME);
	await expect(usedBy).not.toContainText('A Second Reading');

	await page.getByTestId('back-to-project').click();
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	await alignFromLayer(page, layerFor(page, georgia));
	await waitForPane(page);

	// The other map, the other answer — and the sentence that says what refining it here costs.
	await expect(usedBy).toHaveAttribute('data-used-by-count', '2', { timeout: 30_000 });
	await expect(usedBy).toContainText(PROJECT_NAME);
	await expect(usedBy).toContainText('A Second Reading');
	await expect(usedBy).toContainText('Refining it moves all of them');
});

test('says what this screen is doing, in regions a screen reader is told about', async ({
	page
}) => {
	await installIiifHosts(page);
	await openNewProject(page);
	await addReferenced(page, 'images.test');
	await alignFromLayer(page);
	await waitForPane(page);

	// SPEC story 112, and the reason it needs asserting *here*: both panes are WebGL canvases, which
	// announce their accessible name and nothing about what happens in them. Every claim below is
	// about the accessibility tree rather than about a `data-testid`, which is what the rest of this
	// file reads.
	await expect(page.getByTestId('pairing-status')).toHaveAttribute('aria-live', 'polite');
	await expect(page.getByTestId('warped-status')).toHaveAttribute('aria-live', 'polite');
	await expect(page.getByTestId('alignment-opening-view')).toHaveAttribute('aria-live', 'polite');
	await expect(page.getByTestId('alignment-used-by')).toHaveAttribute('aria-live', 'polite');
	await expect(page.getByTestId('changed-elsewhere-outcome')).toHaveAttribute(
		'aria-live',
		'polite'
	);

	// ⚠ **The offline region exists before there is anything offline about it**, and that is the
	// point. A live region inserted at the same moment as its first text is not reliably announced —
	// this repository has settled it twice, in `ReviewBanner.svelte` and `UpdatePrompt.svelte` — so
	// the region has to be here, empty, while the connection is fine. Asserted with the network up,
	// because that is the state in which the earlier version of this had no region at all.
	const region = page.getByTestId('map-image-offline-region');
	await expect(region).toHaveAttribute('aria-live', 'polite');
	await expect(region).toBeEmpty();
	await expect(page.getByTestId('map-image-offline')).toHaveCount(0);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE TWO GUARDS AROUND THE CONNECTION SIGNAL
//
// `MapImagePane` reads the app's one online signal in two effects, and both are shaped by a
// guard whose absence is invisible: the pane still works, it merely rebuilds itself when it should
// not. The existing offline specs go offline and never come back, so neither guard was exercised at
// all. These two do the returning half.

test('a connection that blips does not discard the alignment in progress', async ({
	page,
	context
}) => {
	test.slow();
	await installIiifHosts(page);
	await openNewProject(page);
	const imageId = await addReferenced(page, 'images.test');
	await alignFromLayer(page);
	await waitForPane(page);

	// **A half-placed Control Point is the sharpest instrument there is for this.** A pending half is
	// UI state only (ADR-0022 contract 2) — it is deliberately not written to disk — so it is the one
	// thing on this screen that a rebuilt pane cannot restore. Two placed pairs would survive a
	// rebuild, because they would be re-read from the file, and the test would go green over the very
	// thing it is for.
	await clickAt(mapImage(page), 0.3, 0.35);
	await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');

	await context.setOffline(true);
	await expect(page.getByTestId('map-image-offline')).toBeVisible({ timeout: 30_000 });
	await context.setOffline(false);
	await expect(page.getByTestId('map-image-offline')).toHaveCount(0, { timeout: 30_000 });

	// ⚠ The pane must **not** have re-read its pyramid. It never stopped being valid: the coordinate
	// space is the `info.json`'s, not the tiles', so nothing about it changed when the sheet stopped
	// arriving. Re-reading it re-frames the Base Map and rebuilds the pairing from disk, which throws
	// this half away under the user's hands — one flap of a hotel wifi, one lost gesture.
	await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
	await expect(page.getByTestId('image-pane')).toBeVisible();

	// And the half is still live, not merely still labelled: its other half completes the pair.
	await clickAt(baseMap(page), 0.3, 0.35);
	await expect(rows(page)).toHaveCount(1);
	await waitForStored(page, imageId, 1);
});

test('opening the alignment view reads the library’s info.json once', async ({ page }) => {
	test.slow();
	await installIiifHosts(page);
	await openNewProject(page);
	await addReferenced(page, 'images.test');

	// Counted from here, so the add's own probe is not in the total: what is being measured is what
	// opening the pane costs.
	const infoReads: string[] = [];
	page.on('request', (request) => {
		if (/images\.test\/.*\/info\.json$/.test(request.url())) infoReads.push(request.url());
	});

	await alignFromLayer(page);
	await waitForPane(page);

	// The reopen effect watches the **transition** to online rather than the value. Acting on
	// `online === true` alone fires on mount — when it is ordinarily true and no pane exists yet — and
	// costs every referenced map in the application a second read of its `info.json`, from somebody
	// else's server, before the first one has returned.
	//
	// ⚠ **This is a poll and it passes on its first qualifying sample; `intervals` sets retry delays,
	// not a settle window.** It catches the regression it is for, and the reason is specific rather
	// than lucky: a duplicate caused by the mount-time firing is already in flight before
	// `waitForPane` returns, so the count is 2 at the first sample and a poll for 1 never goes green
	// again. What it would *not* catch is a duplicate arriving later than the first sample, and there
	// is no mechanism in this component that could produce one — the reopen effect fires on a
	// connection transition, and there is none in this test.
	await expect
		.poll(() => infoReads.length, { timeout: 10_000, intervals: [1000, 1000, 1000] })
		.toBe(1);
});
