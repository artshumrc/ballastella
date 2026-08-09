import { expect, test } from './support/test.js';
import { type Page } from '@playwright/test';
import { generateAnnotation, parseAnnotation, validateAnnotation } from '@allmaps/annotation';

import {
	baseMap,
	clickAt,
	emptyWorkspace,
	historicalMap,
	makePairs,
	rows,
	storedAlignment,
	waitForStored,
	warpedTiles
} from './support/alignment-workspace.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { ensureAddHistoricalMapOpen } from './support/historical-maps.js';
import { generateId, installIiifHosts, service } from './support/iiif-hosts.js';
import { alignFromLayer, layerRows, openLayerRow } from './support/layers.js';

/**
 * Ticket 07: a Historical Map whose tiles are on a Library's server is aligned **in place**.
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
	await page.getByRole('button', { name: 'New Project' }).click();
	const dialog = page.getByRole('dialog', { name: 'New Project' });
	await dialog.getByLabel('Project name').fill(PROJECT_NAME);
	await dialog.getByRole('button', { name: 'Create' }).click();
	await page.getByRole('link', { name: PROJECT_NAME }).click();
	await expect(page.getByTestId('project-screen')).toBeVisible();
}

/**
 * Add a referenced Historical Map from a bare image-service URL.
 *
 * @returns the image id, which is `generateId(uri)` and therefore the Alignment's file name
 */
async function addReferenced(page: Page, host: string, name = 'florida'): Promise<string> {
	await ensureAddHistoricalMapOpen(page);
	await page.getByTestId('remote-url').fill(`${service(host, name)}/info.json`);
	await page.getByTestId('remote-read').click();
	await expect(page.getByTestId('remote-add')).toBeVisible({ timeout: 30_000 });
	await page.getByTestId('remote-add').click();
	await expect(layerRows(page)).toHaveCount(1, { timeout: 30_000 });
	return generateId(service(host, name));
}

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

/** Wait until the alignment route's pane is live and every tile of the first view has decoded. */
async function waitForPane(page: Page): Promise<void> {
	await expect(page.getByTestId('image-pane')).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId('historical-map-tiles')).toHaveAttribute(
		'data-tiles-loaded',
		'true',
		{ timeout: 60_000 }
	);
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
		const pyramid = page.getByTestId('historical-map-pyramid');
		await expect(pyramid).toHaveAttribute('data-image-id', imageId);
		await expect(pyramid).toHaveAttribute('data-width', '700');
		await expect(pyramid).toHaveAttribute('data-height', '500');

		// Deep zoom: the finest level exists and is asked for. Before this ticket every one of these
		// requests went to `unset.invalid` and was answered out of a store with no such pyramid.
		await page.getByRole('button', { name: 'Zoom to full resolution' }).click();
		await expect
			.poll(() => tileRequests.filter((url) => /\/1,0\/0\/default|\/256,256\//.test(url)).length, {
				timeout: 30_000
			})
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
		// And they came from the Library, which is the other half: a count alone would also be
		// satisfied by tiles served out of the Workspace, which is what an offline copy would be.
		expect(tileRequests.length).toBeGreaterThan(0);

		// **Nothing was copied.** An exact list rather than a count, so a stray tile is a named file.
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
	await ensureAddHistoricalMapOpen(page);
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

	await ensureAddHistoricalMapOpen(page);
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
	const badge = layerRows(page).first().getByTestId('layer-image-mode');
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

	const failure = page.getByTestId('historical-map-failure');
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

	const notice = page.getByTestId('historical-map-offline');
	await expect(notice).toBeVisible({ timeout: 30_000 });
	await expect(notice).toHaveAttribute('data-offline-host', 'images.test');
	await expect(notice).toContainText('images.test');

	// **The pane is still there and Control Points still place.** Blocking would discard an alignment
	// legitimately in progress — the coordinate space is the `info.json`'s and stays valid whether or
	// not any bytes arrive, so a click is the same image pixel either way.
	await expect(historicalMap(page)).toBeVisible();
	await clickAt(historicalMap(page), 0.35, 0.4);
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
