import { expect, test } from './support/test.js';
import { type Locator, type Page } from '@playwright/test';

import { routeBaseMapArchive } from './support/editor-deployment.js';
// The fake IIIF services, shared by every spec that needs one. The host table, the
// `info.json` builder and the tile matcher used to live here; see that module's header for why
// three private copies of one fixture was a defect rather than a duplication.
import {
	communityAnnotation,
	generateId,
	installIiifHosts,
	service,
	singleCanvas
} from './support/iiif-hosts.js';
import { openLayerRow } from './support/layers.js';
import { ensureAddMapImageOpen } from './support/map-images.js';

test.beforeEach(async ({ page }) => routeBaseMapArchive(page));

/**
 * Seam 2 for making an offline copy: "make an offline copy" driven in a real browser, against real
 * OPFS, with real fixture hosts (ADR-0007).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT ONLY THIS FILE CAN ASSERT
 *
 * The geometry, the path selection, the profile caps and the exact-resize property are asserted in
 * `@ballastella/core` — the last of those against real pixels in two engines. What can only be
 * asserted here is everything about **hosts and about what the app does afterwards**:
 *
 *   * that a level-2 copy is *one* request and a level-0 copy is one per tile;
 *   * that the rights statement and the size are on screen before anything is fetched;
 *   * that cancelling leaves nothing behind;
 *   * and, the whole point of the feature, that once a map is copied **nothing reaches the library
 *     again** — asserted by request interception, because a copy that worked and a copy that quietly
 *     kept fetching look identical on screen.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE FIXTURE HOSTS
 *
 * They live in `support/iiif-hosts.ts` now, shared with every other spec that needs a
 * IIIF service — `library.test` and the whole `HOSTS` table, with `images.test` as the level 2 case
 * and `static.test`, `capped.test`, `huge.test`, `large.test`, `slow.test` and `broken.test` as the
 * awkward ones this file drives. The table there carries what each is for.
 *
 * **The Manifest is asked for a single canvas here**, which is `singleCanvas`. Tests below click
 * "add" without choosing a canvas, so a three-canvas Manifest would silently make that mean "add
 * whichever one is first".
 *
 * Every host is routed, so **nothing in this file reaches the internet.**
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

/** One JSON file out of OPFS. `''` as the directory reads from the Workspace root (ADR-0023). */
const readJson = (page: Page, directory: string, path: string): Promise<unknown> =>
	page.evaluate(
		async ([directory, path]) => {
			const root = await workspaceRoot();
			let handle = directory === '' ? root : await root.getDirectoryHandle(directory as string);
			const segments = (path as string).split('/');
			for (const segment of segments.slice(0, -1)) {
				handle = await handle.getDirectoryHandle(segment);
			}
			const file = await handle.getFileHandle(segments[segments.length - 1] as string);
			return JSON.parse(await (await file.getFile()).text());
		},
		[directory, path]
	);

/** Overwrite one JSON file in OPFS. `''` writes at the Workspace root (ADR-0023). */
const writeJson = (page: Page, directory: string, path: string, body: unknown): Promise<void> =>
	page.evaluate(
		async ([directory, path, text]) => {
			const root = await workspaceRoot();
			let handle =
				directory === ''
					? root
					: await root.getDirectoryHandle(directory as string, { create: true });
			const segments = (path as string).split('/');
			for (const segment of segments.slice(0, -1)) {
				handle = await handle.getDirectoryHandle(segment, { create: true });
			}
			const file = await handle.getFileHandle(segments[segments.length - 1] as string, {
				create: true
			});
			const writable = await file.createWritable();
			await writable.write(text as string);
			await writable.close();
		},
		[directory, path, JSON.stringify(body)]
	);

/**
 * Give a second Project a map Layer over an image the Workspace already holds.
 *
 * Written onto the disk rather than driven through the UI because there is no affordance for it —
 * "choose a Map Image you already have" does not exist yet. What is being demonstrated is the
 * storage property ADR-0023 exists for: one pyramid, one Alignment, two Projects that both draw
 * them.
 */
async function projectOverSameImage(
	page: Page,
	directory: string,
	name: string,
	imageId: string
): Promise<void> {
	await writeJson(page, directory, 'project.json', {
		formatVersion: 1,
		name,
		updatedAt: '2026-01-02T03:04:05.000Z',
		layers: [
			{
				kind: 'map',
				id: 'l-shared',
				name: 'The same sheet, in another argument',
				visible: true,
				order: 0,
				opacity: 1,
				imageId
			}
		],
		baseMap: null
	});
}

/**
 * Every file in the whole Workspace, by path.
 *
 * The **Workspace** rather than one Project directory, and that is load-bearing since ADR-0023: a
 * pyramid lands at `images/<id>/` at the root, so a before-and-after comparison scoped to the Project
 * would see nothing either way and every "nothing was added" assertion below would pass vacuously.
 */
const listWorkspaceFiles = (page: Page): Promise<string[]> =>
	page.evaluate(async () => {
		const root = await workspaceRoot();
		const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<string[]> => {
			const found: string[] = [];
			for await (const [name, entry] of (
				handle as unknown as {
					entries(): AsyncIterable<[string, FileSystemHandle]>;
				}
			).entries()) {
				const path = prefix === '' ? name : `${prefix}/${name}`;
				if (entry.kind === 'directory') {
					found.push(...(await walk(entry as FileSystemDirectoryHandle, path)));
				} else {
					found.push(path);
				}
			}
			return found;
		};
		try {
			return (
				(await walk(root, ''))
					// A half-finished atomic write is litter rather than project data, and `ProjectStore#list`
					// hides it — including the `.crswap` a dying tab leaves beside it. Excluded here too, so a
					// before-and-after comparison is about what the copy wrote and not about write timing.
					.filter((path) => !path.includes('ballastella-tmp'))
					.sort()
			);
		} catch {
			return [];
		}
	});

async function openNewProject(page: Page, name = 'Amsterdam 1625'): Promise<void> {
	await page.getByRole('button', { name: 'New Project' }).click();
	await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill(name);
	await page
		.getByRole('dialog', { name: 'New Project' })
		.getByRole('button', { name: 'Create' })
		.click();
	await page.getByRole('link', { name }).click();
	// ⚠ **The dialog is deliberately not opened here**, and it used to be. It is a *modal*, so
	// leaving it up inerts the Project screen for the rest of the test — harmless only for as long
	// as every call site happens to add a map first, which closes it. Each of the three places that
	// wants the library source opens it for itself, one line above the URL it types.
	await expect(page.getByTestId('project-screen')).toBeVisible();
}

/**
 * Make the Workspace report at least `bytes`, without writing them.
 *
 * `workspaceSize` answers from `ProjectStore#size`, which is `getFile().size` on an OPFS handle —
 * so a file extended with `truncate` counts in full while costing nothing to produce. The
 * alternative is transferring and storing hundreds of megabytes to assert a warning about a number,
 * which is the sort of test that gets deleted for being slow rather than kept for being true.
 */
async function seedWorkspaceBytes(page: Page, bytes: number): Promise<void> {
	await page.evaluate(async (size) => {
		// **The Workspace, not the OPFS root.** The cliff is a Workspace total, and the root merely
		// *holds* Workspaces — ballast written there is counted by nothing, and the warning this seeds
		// for never appears.
		const root = await workspaceRoot();
		const handle = await root.getFileHandle('ballast.bin', { create: true });
		const writable = await handle.createWritable();
		await writable.truncate(size);
		await writable.close();
	}, bytes);
}

/** Add one referenced Map Image from a bare image service URL. */
async function addReferenced(page: Page, host: string, name = 'florida'): Promise<void> {
	await ensureAddMapImageOpen(page);
	await page.getByTestId('remote-url').fill(`${service(host, name)}/info.json`);
	await page.getByTestId('remote-read').click();
	await expect(page.getByTestId('remote-add')).toBeVisible();
	await page.getByTestId('remote-add').click();
	await expectReferencedLayer(page);
}

/**
 * Wait until a referenced Map Image is on the Project screen, and leave its Layer open.
 *
 * The library a referenced map's tiles come from — and the "Make an offline copy" offer beside it —
 * are *inside* the Layer that fetches them, so seeing either is opening the row.
 *
 * @returns the row, so a caller can go on asking about that Layer and no other
 */
async function expectReferencedLayer(page: Page, at: number | Locator = 0): Promise<Locator> {
	const row = await openLayerRow(page, at);
	await expect(row.getByTestId('layer-image-mode')).toHaveText('Source: External IIIF');
	await expect(row.getByTestId('referenced-image-host')).toBeVisible();
	return row;
}

/** The same, for a map whose tiles are now in the Workspace: the source URI in place of a host. */
async function expectOfflineCopyLayer(page: Page, at: number | Locator = 0): Promise<Locator> {
	const row = await openLayerRow(page, at);
	await expect(row.getByTestId('layer-image-mode')).toHaveText('Source: Local');
	await expect(row.getByTestId('offline-copy-source')).toBeVisible();
	return row;
}

/**
 * Open the offline-copy dialog for the only referenced map on the page, and wait until it has
 * finished filling itself in.
 *
 * **The second wait is not belt-and-braces.** The dialog opens in the frame the button is pressed —
 * deliberately, so the gesture is answered — while `prepare` is still re-reading the service's
 * `info.json`, and until that resolves there is no plan: `offline-copy-start` is disabled, the size and the
 * notes are not on the page, and `job.start()` returns `false` without doing anything. Every test
 * below that reaches for a control or asserts the *absence* of a note was therefore racing one HTTP
 * request. It surfaced as the keyboard test failing 2 runs in 9: focus went to a disabled button,
 * Enter did nothing, and Cancel was never rendered to receive it.
 *
 * `data-step` is the dialog's own account of which step it is on, so this waits for the state the
 * test needs rather than for a duration. `'deciding'` is reached whether the plan is a refusal or a
 * costing, which is why it is the wait rather than "the Copy button is enabled" — the refusal tests
 * need a settled dialog with that button still disabled.
 */
async function openMirrorDialog(page: Page): Promise<void> {
	// "Make an offline copy" lives on the Layer card, which is on the Project screen itself — so
	// arriving is already being there, and there is no navigation left for this to do. The card is the
	// Layer's *open* row, so the row is opened on the way in.
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	const row = await openLayerRow(page);
	await row.getByTestId('offline-copy-open').click();
	await expect(page.getByRole('dialog', { name: 'Make an offline copy' })).toBeVisible();
	await expect(page.getByTestId('offline-copy-status')).toHaveAttribute('data-step', 'deciding');
}

/**
 * Watch for requests to the library and to the ADR-0004 placeholder host, until `stop`.
 *
 * A helper rather than two inline listeners because the interesting assertion is made twice — once
 * before the copy and once after — and the two must be measured the same way for the comparison to be
 * worth anything.
 */
function watchRequests(page: Page): {
	library: string[];
	placeholder: string[];
	stop: () => void;
} {
	const library: string[] = [];
	const placeholder: string[] = [];
	const listener = (request: { url(): string }) => {
		const url = request.url();
		if (url.includes('images.test')) library.push(url);
		if (url.includes('unset.invalid')) placeholder.push(url);
	};
	page.on('request', listener);
	return { library, placeholder, stop: () => page.off('request', listener) };
}

/**
 * The hub's picture of the one Map Image in the Workspace, or `null` while there is no `<img>`.
 *
 * `src` verbatim rather than reduced to a scheme, so the caller can say *which* source it came from —
 * which is the whole subject of this file. `naturalWidth`/`naturalHeight` rather than a bounding box:
 * the element is laid out at its attribute dimensions whether or not any bytes arrived, so its box
 * says nothing about whether the picture is there (ADR-0030).
 */
const hubPicture = (
	page: Page
): Promise<{
	src: string;
	loading: string | null;
	decoded: { width: number; height: number };
} | null> =>
	page
		.getByTestId('map-image')
		.getByTestId('map-thumbnail-image')
		.evaluate((element) => {
			const image = element as HTMLImageElement;
			return {
				src: image.getAttribute('src') ?? '',
				loading: image.getAttribute('loading'),
				decoded: { width: image.naturalWidth, height: image.naturalHeight }
			};
		})
		// ⚠ Absence only. A strict-mode violation — two cards, which is a duplicated Map Image and a real
		// defect — must not be reported as "no picture arrived": that reads as a feature failure when the
		// truth is an ambiguous locator, and the poll would spend its whole timeout on the wrong
		// diagnosis.
		.catch((error: unknown) => {
			if (error instanceof Error && error.message.includes('strict mode violation')) throw error;
			return null;
		});

/**
 * Open the Layers pane and wait until the one map Layer is drawn and carrying tiles.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE WAY IN IS A PARAMETER, WHICH IS NOT A CONVENIENCE
 *
 * **Two independent defects in this pane once made each of the two routes to it work for exactly one
 * of the two cases below.** Neither was caused by making an offline copy; both were found by trying to
 * measure the same thing twice, and both are fixed — but the parameter stays, because the reason the
 * defects survived so long is that every test used one route or the other and never both.
 *
 *   `'link'` — a client-side navigation. **Left the stack undrawn once the Project page had a local
 *     Map Image on it**: the pane being left removed its map and then asked it for a layer, and the
 *     exception abandoned the mount of the pane being navigated to. Its regression test is
 *     `editor-layers.e2e.ts`, "draws the stack when the pane is reached by the link from the Project
 *     page", which needs a local Map Image and so belongs there rather than here.
 *
 *   `'load'` — a fresh page load. **A `'referenced'` Layer drew nothing**: the stack was built before
 *     `remote.json` had been read, so the Layer was handed `service: ''` and asked the injection shim
 *     for a pyramid the Project does not contain, and the remote service was not part of what the pane
 *     rebuilds the stack for. Its regression test is `editor-remote-iiif.e2e.ts`, which now draws a
 *     referenced Layer through **both** routes.
 *
 * The headline before-and-after below now runs **both** halves through `'link'`. It used to measure the
 * referenced Layer through the link and the copied one through a load, because each was the only route
 * that worked for that case — and that left the central before-and-after comparison with a confound in
 * it, since the two halves differed by more than the copy. They no longer have to, and `'load'` is
 * covered on its own by the reload test below, which is the fresh-load claim in its proper place.
 */
async function drawTheStack(
	page: Page,
	via: 'link' | 'load',
	directory = 'amsterdam-1625'
): Promise<void> {
	// `via: 'link'` used to mean "follow the Project page's Layers link". There is no such page any
	// more: the Layer stack is the Project, so arriving is already being there and the two
	// paths differ only in whether the screen was loaded fresh.
	if (via === 'link') await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	else await page.goto(`/?p=${directory}`);
	await expect(page.getByRole('heading', { name: 'Layers in this Project' })).toBeVisible();

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

	// Bytes fetched *and* decoded. `fitBounds` first, exactly as the other warped tests do: the renderer
	// has no reason to ask for a tile for a Layer that is not on screen, and the fixture's Control Points
	// put this one off the coast of Florida.
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
}

test.describe('making an offline copy', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await emptyWorkspace(page);
		await page.reload();
	});

	test('is offered per image on a referenced Layer, and says what the library said about rights first', async ({
		page
	}) => {
		// ADR-0007: the decision must not be made implicitly by a button labelled only "Download". So
		// the rights statement and the required statement are in front of the user before anything is
		// fetched — read from `remote.json`, which holds them for exactly this moment, long after the
		// Manifest was navigated away from.
		await installIiifHosts(page, { manifestCanvases: singleCanvas });
		await openNewProject(page);

		await ensureAddMapImageOpen(page);
		await page.getByTestId('remote-url').fill('https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-read').click();
		await expect(page.getByTestId('remote-add')).toBeVisible();
		await page.getByTestId('remote-add').click();
		const offeredRow = await expectReferencedLayer(page);

		// On the Layer card, and only there — one Layer, one offer (ADR-0007, ADR-0025).
		await expect(page.getByTestId('layer-sidebar')).toBeVisible();
		await expect(offeredRow.getByTestId('offline-copy-open')).toHaveCount(1);
		// And nowhere else on the screen, which is what "only there" means.
		await expect(page.getByTestId('offline-copy-open')).toHaveCount(1);

		const requestsBefore: string[] = [];
		page.on('request', (request) => requestsBefore.push(request.url()));

		await openMirrorDialog(page);

		const rights = page.getByTestId('offline-copy-rights');
		await expect(rights).toContainText('creativecommons.org/licenses/by/4.0');
		await expect(rights).toContainText('Provided by the Example Library');

		// The rights URI is text and **not** a link. A Manifest declaring `"rights": "javascript:…"`
		// would otherwise have become a clickable one, because Svelte escapes interpolation but does not
		// sanitise `href`.
		await expect(rights.locator('a')).toHaveCount(0);

		// And nothing has been fetched from the library except the one `info.json` the plan needs.
		const tileRequests = requestsBefore.filter((url) => /default\.(jpg|png)$/.test(url));
		expect(tileRequests).toEqual([]);
	});

	test('shows the size of the copy against what the Workspace already holds', async ({ page }) => {
		await installIiifHosts(page, { manifestCanvases: singleCanvas });
		await openNewProject(page);
		await addReferenced(page, 'images.test');
		await openMirrorDialog(page);

		const size = page.getByTestId('offline-copy-size');
		// 700 × 500 at the measured 0.7 bytes per pixel is about 245 kB, and the Workspace holds a
		// `project.json` and one `remote.json`.
		await expect(size).toContainText('245 kB');
		await expect(size).toContainText('this Workspace already holds');
		await expect(size).toContainText('files');
		// Well under the cliff, so nothing is said about it.
		await expect(page.getByTestId('offline-copy-hosting-warning')).toHaveCount(0);
	});

	test('warns explicitly about the ~1 GB hosting limit and still lets the copy proceed', async ({
		page
	}) => {
		// ADR-0008's cliff, and it is information rather than a gate: the scholar may never share this
		// Workspace to a free static host at all.
		//
		// **The Workspace is seeded rather than the image made enormous, and that is ADR-0027's
		// doing.** A copy is estimated at 0.7 bytes per pixel, so the largest one the 528-megapixel
		// decode cap now admits is about 370 MB — no single offline copy can cross a gigabyte on its
		// own any more. The cliff is a Workspace total and always was, so the honest way to reach it is
		// a Workspace that already holds most of it plus a copy the browser would really decode.
		await installIiifHosts(page, { manifestCanvases: singleCanvas });
		await openNewProject(page);
		await seedWorkspaceBytes(page, 700_000_000);
		await addReferenced(page, 'large.test', 'enormous');
		await openMirrorDialog(page);

		const warning = page.getByTestId('offline-copy-hosting-warning');
		await expect(warning).toBeVisible();
		await expect(warning).toContainText('1.0 GB');
		await expect(warning).toContainText('GitHub Pages');
		await expect(warning).toContainText('You can still make the copy');

		// Not a gate.
		await expect(page.getByTestId('offline-copy-start')).toBeEnabled();
	});

	test('refuses a copy of a source above the decode cap, before it fetches anything', async ({
		page
	}) => {
		// **A refusal where there used to be a warning** (ADR-0027). `huge.test` declares 1.4
		// gigapixels. The note this replaces told the user the copy "needs the streaming tiler" and
		// then let them start it — thousands of requests to somebody else's server, ending at a wall.
		// There is no streaming tiler to need and nowhere for either path to escape to: an offline copy
		// has to exist as one full-resolution image before it can be cut into tiles.
		await installIiifHosts(page, { manifestCanvases: singleCanvas });
		await openNewProject(page);
		await addReferenced(page, 'huge.test', 'enormous');

		const requested: string[] = [];
		page.on('request', (request) => requested.push(request.url()));
		await openMirrorDialog(page);

		const refusal = page.getByTestId('offline-copy-refusal');
		await expect(refusal).toBeVisible();
		await expect(refusal).toContainText('1440 megapixels');
		await expect(refusal).toContainText('outside the browser');
		await expect(refusal).toContainText('still works, read from huge.test');
		// The words that may no longer reach a user, and the promise that may no longer be made.
		for (const word of ['SharedArrayBuffer', 'COOP', 'COEP', 'streaming tiler']) {
			await expect(refusal, word).not.toContainText(word);
		}

		// A gate, and it is closed before a byte is asked for. That is the whole value of refusing in
		// the plan rather than in the tiler.
		await expect(page.getByTestId('offline-copy-start')).toBeDisabled();
		expect(requested.filter((url) => /default\.(jpg|png)$/.test(url))).toEqual([]);
	});

	test('copies a level-2 source with a single full-image request and then tiles locally', async ({
		page
	}) => {
		await installIiifHosts(page, { manifestCanvases: singleCanvas });
		await openNewProject(page);
		await addReferenced(page, 'images.test');

		const imageRequests: string[] = [];
		page.on('request', (request) => {
			if (/images\.test.*default\.(jpg|png)$/.test(request.url()))
				imageRequests.push(request.url());
		});

		await openMirrorDialog(page);
		// One request, and nothing about many of them.
		await expect(page.getByTestId('offline-copy-note')).toHaveCount(0);
		await page.getByTestId('offline-copy-start').click();

		await expect(page.getByTestId('offline-copy-done')).toContainText(
			'offline copy in this Project',
			{
				timeout: 30_000
			}
		);

		// **Exactly one image request to the library, and it is for the whole image.** This is what
		// "the local-image path reused exactly" costs a level-2 host.
		expect(imageRequests).toHaveLength(1);
		expect(imageRequests[0]).toBe(`${service('images.test', 'florida')}/full/max/0/default.jpg`);
	});

	test('copies a level-0 source from its own tiles, having warned that it means many requests', async ({
		page
	}) => {
		// ADR-0007's expensive case, and the warning is a politeness obligation rather than a performance
		// note: `static.test` serves only what it has pre-cut, so the copy is one request per tile.
		await installIiifHosts(page, { manifestCanvases: singleCanvas });
		await openNewProject(page);
		await addReferenced(page, 'static.test', 'pyramid');

		await openMirrorDialog(page);
		const note = page.getByTestId('offline-copy-note');
		await expect(note).toBeVisible();
		await expect(note).toContainText('static.test');
		// 700 × 500 at 256-pixel tiles is 3 columns by 2 rows.
		await expect(note).toContainText('6 separate requests');
		await expect(note).toContainText('somebody else');

		const imageRequests: string[] = [];
		page.on('request', (request) => {
			if (/static\.test.*default\.(jpg|png)$/.test(request.url()))
				imageRequests.push(request.url());
		});

		await page.getByTestId('offline-copy-start').click();
		await expect(page.getByTestId('offline-copy-done')).toContainText(
			'offline copy in this Project',
			{
				timeout: 30_000
			}
		);

		// Six requests, every one at full resolution — a 1:1 crop, which is the only geometry a
		// stranger's server is trusted for.
		expect(imageRequests).toHaveLength(6);
		for (const url of imageRequests) expect(url).toMatch(/\/(\d+),(\d+),(\d+),(\d+)\/\3,\4\/0\//);
		// And it never asked for the whole image, which this host does not have.
		expect(imageRequests.some((url) => url.includes('/full/'))).toBe(false);
	});

	test('respects a declared maxWidth rather than making a request the service has said no to', async ({
		page
	}) => {
		// Two of the fourteen real services surveyed are in this shape — Cambridge with
		// `maxWidth` 2000 over a 4880×6174 image, and Micrio with a `maxArea` under the image's. Upstream's
		// own `getImageUrl` throws rather than build the URL, which is the 400 a real server would send.
		await installIiifHosts(page, { manifestCanvases: singleCanvas });
		await openNewProject(page);
		await addReferenced(page, 'capped.test', 'capped');

		const imageRequests: string[] = [];
		page.on('request', (request) => {
			if (/capped\.test.*default\.(jpg|png)$/.test(request.url()))
				imageRequests.push(request.url());
		});

		await openMirrorDialog(page);
		await expect(page.getByTestId('offline-copy-note')).toContainText('400');
		await page.getByTestId('offline-copy-start').click();
		await expect(page.getByTestId('offline-copy-done')).toContainText(
			'offline copy in this Project',
			{
				timeout: 30_000
			}
		);

		expect(imageRequests).toHaveLength(6);
		expect(imageRequests.some((url) => url.includes('/full/'))).toBe(false);
	});

	test('leaves a pyramid indistinguishable from a locally ingested one, under the id Allmaps keys it on', async ({
		page
	}) => {
		await installIiifHosts(page, { manifestCanvases: singleCanvas });
		await openNewProject(page);
		await addReferenced(page, 'images.test');
		await openMirrorDialog(page);
		await page.getByTestId('offline-copy-start').click();
		await expect(page.getByTestId('offline-copy-done')).toContainText(
			'offline copy in this Project',
			{
				timeout: 30_000
			}
		);

		// The image id is unchanged by the copy and is still `generateId(uri)`, computed here with
		// `node:crypto`. Every Alignment in this Project names it, and it is the key
		// `annotations.allmaps.org` holds the community's work under, so a copy that minted a new one
		// would break both while looking like it had worked.
		const imageId = generateId(service('images.test', 'florida'));
		expect(imageId).toMatch(/^[0-9a-f]{16}$/);

		const files = await listWorkspaceFiles(page);
		const tiles = files.filter((path) => path.endsWith('/default.jpg'));
		// 700 × 500: 6 tiles at scale factor 1, 2 at 2, and 1 at 4.
		expect(tiles).toHaveLength(9);
		for (const path of tiles) expect(path.startsWith(`images/${imageId}/`)).toBe(true);
		expect(files).toContain(`images/${imageId}/info.json`);
		expect(files).toContain(`images/${imageId}/manifest.json`);
		// The record of where it came from is still there — making an offline copy must not orphan the copy.
		expect(files).toContain(`images/${imageId}/remote.json`);

		// Every tile path is a IIIF `region/size/rotation/quality.format`, exactly as a local ingest
		// writes them, and the geometry is the app's own 256-pixel square tiles rather than the service's.
		expect(tiles).toContain(`images/${imageId}/0,0,256,256/256,256/0/default.jpg`);
		expect(tiles).toContain(`images/${imageId}/512,256,188,244/188,244/0/default.jpg`);

		// ADR-0004: the pyramid carries the deliberately unusable placeholder, never the library's URI —
		// which is what lets the injection shim route it and what makes a code path that forgets to
		// override it fail loudly rather than quietly fetch somebody else's tiles.
		const info = (await readJson(page, '', `images/${imageId}/info.json`)) as Record<
			string,
			unknown
		>;
		expect(info.id).toBe(`https://unset.invalid/${imageId}`);
		expect(info.profile).toBe('level0');
		expect(info.tiles).toEqual([{ width: 256, height: 256, scaleFactors: [1, 2, 4] }]);
		expect(JSON.stringify(info)).not.toContain('images.test');

		// **`project.json` was not touched by the copy at all** (ADR-0023). There is no `imageMode` to
		// flip: the pyramid landing beside `remote.json` *is* the record that the tiles are here, so every
		// Project drawing this map sees it at once rather than only the one that happened to be open — and
		// the half-committed state the old third write could leave cannot occur.
		const project = (await readJson(page, 'amsterdam-1625', 'project.json')) as {
			layers: { kind: string; imageId: string }[];
		};
		expect(project.layers).toHaveLength(1);
		expect(project.layers[0]).toMatchObject({ kind: 'map', imageId });
		// Read off the files instead, which is where the answer lives — on the Layer, on the Project
		// screen, with no navigation in between.
		await expect(page.getByTestId('layer-sidebar')).toBeVisible();
		await expect(page.getByTestId('layer-image-mode')).toHaveAttribute(
			'data-image-mode',
			'offline-copy'
		);

		// And the source URI is still on screen, so the copy can be cited.
		const copiedRow = await expectOfflineCopyLayer(page);
		await expect(copiedRow.getByTestId('offline-copy-source')).toHaveText(
			service('images.test', 'florida')
		);
		// It is not referenced any more, said of the *open* row: a page-wide count would be 0 for a Layer
		// nobody had opened, which is the same green for the opposite reason.
		await expect(copiedRow.getByTestId('referenced-image-host')).toHaveCount(0);
	});

	test('reports progress, and announces it to assistive technology', async ({ page }) => {
		// The level-0 path on `slow.test` is 48 tiles at 120 ms each, so the progress region is on screen
		// long enough to read — which is the point of it.
		await installIiifHosts(page, { manifestCanvases: singleCanvas });
		await openNewProject(page);
		await addReferenced(page, 'slow.test', 'slow');
		await openMirrorDialog(page);
		await page.getByTestId('offline-copy-start').click();

		const progress = page.getByTestId('offline-copy-progress');
		await expect(progress).toBeVisible();
		// The numbers a screen-reader user is told are the same numbers the bar carries.
		await expect(progress).toContainText('slow.test');
		await expect(progress).toContainText(/fetched \d+ of 48 tiles/);

		// In a live region, announced rather than merely drawn.
		const live = page.locator('[aria-live="polite"]', { has: progress });
		await expect(live).toHaveAttribute('aria-atomic', 'true');

		const bar = page.getByRole('progressbar', { name: /Making an offline copy/ });
		await expect(bar).toBeVisible();

		// It gets to tiling, and the sentence changes with it.
		await expect(progress).toContainText(/tile \d+ of \d+/, { timeout: 60_000 });
		await expect(page.getByTestId('offline-copy-done')).toContainText(
			'offline copy in this Project',
			{
				timeout: 60_000
			}
		);
	});

	test('leaves no partial pyramid when the copy is cancelled, and the Layer keeps working', async ({
		page
	}) => {
		// A partial pyramid renders with holes, which reads as corruption rather than as a cancelled job.
		await installIiifHosts(page, { manifestCanvases: singleCanvas });
		await openNewProject(page);
		await addReferenced(page, 'slow.test', 'slow');

		const before = await listWorkspaceFiles(page);

		await openMirrorDialog(page);
		await page.getByTestId('offline-copy-start').click();
		await expect(page.getByTestId('offline-copy-progress')).toContainText(/fetched [1-9]\d* of 48/);

		await page.getByTestId('offline-copy-cancel').click();
		await expect(page.getByTestId('offline-copy-error')).toContainText('cancelled');

		// Nothing was added at all: not a tile, not an `info.json`.
		expect(await listWorkspaceFiles(page)).toEqual(before);

		await page.getByTestId('offline-copy-dismiss').click();

		// The map is still referenced, and it is still there. Said by the files — no `info.json` beside its
		// `remote.json` — because that is the only thing that says it (ADR-0023) — and by the Layer card,
		// which is where the badge and the offer both live.
		await expect(
			readJson(page, '', `images/${generateId(service('images.test', 'florida'))}/info.json`)
		).rejects.toThrow();
		await expect(
			(await expectReferencedLayer(page)).getByTestId('offline-copy-source')
		).toHaveCount(0);
	});

	test('leaves the Layer referenced and working when the copy fails', async ({ page }) => {
		await installIiifHosts(page, { manifestCanvases: singleCanvas });
		await openNewProject(page);
		await addReferenced(page, 'broken.test', 'broken');

		const before = await listWorkspaceFiles(page);

		await openMirrorDialog(page);
		await page.getByTestId('offline-copy-start').click();

		const error = page.getByTestId('offline-copy-error');
		await expect(error).toContainText('broken.test');
		await expect(error).toContainText('500');
		await expect(error).toContainText('still works');

		expect(await listWorkspaceFiles(page)).toEqual(before);

		await page.getByTestId('offline-copy-dismiss').click();
		// Still referenced, said by the absence of a pyramid rather than by a field (ADR-0023).
		await expect(
			readJson(page, '', `images/${generateId(service('broken.test', 'broken'))}/info.json`)
		).rejects.toThrow();
		await expect(page.getByTestId('offline-copy-open')).toBeVisible();
	});

	test('is reachable and operable by keyboard alone', async ({ page }) => {
		// `<dialog>` + `showModal()` brings Escape and the focus trap with it (ADR-0016), and the button
		// that opened it gets focus back.
		await installIiifHosts(page, { manifestCanvases: singleCanvas });
		await openNewProject(page);
		await addReferenced(page, 'images.test');
		await expect(page.getByTestId('layer-sidebar')).toBeVisible();

		const button = page.getByTestId('offline-copy-open');
		await button.focus();
		await expect(button).toBeFocused();
		await page.keyboard.press('Enter');

		const dialog = page.getByRole('dialog', { name: 'Make an offline copy' });
		await expect(dialog).toBeVisible();
		await expect(page.getByTestId('offline-copy-size')).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(button).toBeFocused();

		// And it can be driven the whole way from the keyboard.
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('offline-copy-start')).toBeEnabled();
		await page.getByTestId('offline-copy-start').focus();
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('offline-copy-done')).toContainText(
			'offline copy in this Project',
			{
				timeout: 30_000
			}
		);
	});

	test('moves the keyboard onto Cancel when the copy starts, and back when it ends', async ({
		page
	}) => {
		// **The button that was pressed is destroyed by pressing it**: `start` sets the step to
		// `'copying'`, which swaps the dialog's actions for Cancel. Nothing moved focus, so a keyboard
		// user spent a multi-minute copy on `document.body` — inside a modal focus trap, with the one
		// control that could stop the job sitting unfocused. CONTRIBUTING makes focus management a
		// criterion of the change that adds the UI rather than a pass at the end.
		//
		// `slow.test` is 48 tiles at 120 ms each, which is what makes the *middle* of the job
		// observable rather than only its end.
		await installIiifHosts(page, { manifestCanvases: singleCanvas });
		await openNewProject(page);
		await addReferenced(page, 'slow.test', 'slow');
		await openMirrorDialog(page);

		await page.getByTestId('offline-copy-start').focus();
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('offline-copy-cancel')).toBeFocused();

		// So the way out of the copy is reachable by pressing the key again, rather than by Tabbing back
		// in from the top of the document.
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('offline-copy-error')).toContainText('cancelled');
		// And the keyboard is left on the control that would start it again, not on the body.
		await expect(page.getByTestId('offline-copy-start')).toBeFocused();
	});
});

test.describe('a copied Map Image, once it is copied', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await emptyWorkspace(page);
		await page.reload();
	});

	test('renders warped through the injection shim with no request to the library at all', async ({
		page
	}) => {
		test.slow();
		// **The assertion this whole file exists for**, and the only proof that the copy is being used: a
		// copied map that quietly kept fetching from the library looks identical on screen to one that
		// does not. So it is asserted by request interception, and positively — the warped Layer's own
		// tile cache has to have bytes in it — because a blank warped map is exactly what an error
		// `@allmaps/render` logs and swallows looks like.
		//
		// **The same Layer, the same pane, and the same instrument are measured twice: before the copy and
		// after it.** An assertion that a list of intercepted requests is empty is the easiest thing in
		// this repository to pass vacuously — a listener attached too late, a Layer that never drew, a
		// pattern that matches nothing — and the before-and-after is what makes it mean something. It is
		// also the shape that catches the mistake this file is most able to make, since a Layer drawn
		// from the library and one drawn from the folder are indistinguishable on screen.
		await installIiifHosts(page, {
			manifestCanvases: singleCanvas,
			communityAnnotations: [communityAnnotation('images.test', 'florida')]
		});
		await openNewProject(page);

		// A community Alignment, so the Layer has three Control Points and can actually be drawn.
		await ensureAddMapImageOpen(page);
		await page.getByTestId('remote-url').fill('https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-read').click();
		await expect(page.getByTestId('community-offer')).toBeVisible();
		await page.getByTestId('remote-add').click();
		await expectReferencedLayer(page);

		const imageId = generateId(service('images.test', 'florida'));

		// Before the copy the Alignment names the library, which is what makes a referenced Layer render
		// at all — so the rewrite below is a change and not a no-op.
		const referencedAlignment = (await readJson(page, '', `alignments/${imageId}.json`)) as {
			target: { source: { id: string } };
		};
		expect(referencedAlignment.target.source.id).toBe(service('images.test', 'florida'));

		// ── The control. Drawn *referenced*, this Layer really does fetch from the library, and the
		// listener really does see it. Without this half, "no requests after the copy" could be a listener
		// that never fires, a pattern that matches nothing, or a Layer that never drew.
		const beforeCopy = watchRequests(page);
		await drawTheStack(page, 'link');
		expect(beforeCopy.library.length).toBeGreaterThan(0);
		beforeCopy.stop();

		await page.goto('/?p=amsterdam-1625');
		await expectReferencedLayer(page);

		await openMirrorDialog(page);
		await page.getByTestId('offline-copy-start').click();
		await expect(page.getByTestId('offline-copy-done')).toContainText(
			'offline copy in this Project',
			{
				timeout: 60_000
			}
		);

		// The Alignment now names the ADR-0004 placeholder. Left naming the library it would keep sending
		// `@allmaps/maplibre` there for tiles that are in this folder — the copy would work, the map would
		// draw, and making an offline copy would have bought nothing.
		const copiedAlignment = (await readJson(page, '', `alignments/${imageId}.json`)) as {
			target: { source: { id: string } };
			body: { features: unknown[] };
		};
		expect(copiedAlignment.target.source.id).toBe(`https://unset.invalid/${imageId}`);
		// And the Control Points survived the rewrite, which is the thing that would be worst to lose.
		expect(copiedAlignment.body.features).toHaveLength(3);

		// ── And the claim. The same pane, the same Layer, the same instrument, **and the same route in**:
		// the only difference between this measurement and the control above is the copy.
		const afterCopy = watchRequests(page);
		await drawTheStack(page, 'link');

		expect(afterCopy.library).toEqual([]);
		// Nothing escaped to the placeholder host either: that is what a local copy drawn *without* the
		// shim would ask for, and it is a DNS failure rather than a picture.
		expect(afterCopy.placeholder).toEqual([]);
		afterCopy.stop();
	});

	test('shows the hub’s picture of it from the Workspace instead of from the library', async ({
		page
	}) => {
		// **No code makes this happen**: the copy writes a pyramid into the image directory and leaves
		// the `remote.json`, so `tileLocation` starts answering `'in-workspace'` for that map and
		// ADR-0030's resolver follows it. What is asserted here is that it really did.
		//
		// ⚠ **"A picture is shown" is true before and after the copy and proves nothing.** The picture is
		// deliberately *identical* — same box, same fit, same 175 × 125 decoded from a 700 × 500 sheet on
		// 256-pixel tiles — so the two halves below are distinguished only by where the bytes came from:
		// a URL on the library's own host against an object URL over bytes read out of the Workspace, and
		// a request to the library against none at all. Measured twice with the same instrument, for the
		// reason the warped assertion above is: an empty list of intercepted requests is the easiest thing
		// in this repository to pass vacuously.
		await installIiifHosts(page, { manifestCanvases: singleCanvas });
		await openNewProject(page);
		await addReferenced(page, 'images.test');
		const imageId = generateId(service('images.test', 'florida'));

		// ── The control. Referenced, the picture is a plain URL on the library's server, fetched by the
		// element itself and lazily, and the listener really does see the request.
		const beforeCopy = watchRequests(page);
		await page.getByTestId('all-projects').click();
		await expect(page.getByTestId('map-image')).toHaveCount(1);
		// The picture is `loading="lazy"` while it comes from the library, so a card below the fold would
		// never fire its request and the poll would sit on a decoded 0 × 0 until it timed out.
		await page.getByTestId('map-thumbnail-image').scrollIntoViewIfNeeded();
		await expect
			.poll(() => hubPicture(page), { timeout: 20_000 })
			.toEqual({
				src: expect.stringMatching(/^https:\/\/images\.test\//),
				loading: 'lazy',
				decoded: { width: 175, height: 125 }
			});
		expect(beforeCopy.library.length).toBeGreaterThan(0);
		beforeCopy.stop();

		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expectReferencedLayer(page);
		await openMirrorDialog(page);
		await page.getByTestId('offline-copy-start').click();
		await expect(page.getByTestId('offline-copy-done')).toContainText(
			'offline copy in this Project',
			{ timeout: 60_000 }
		);
		// Nothing to dismiss: the dialog closes itself on success, and this notice is on the Project
		// screen behind it — so the way back to the hub is not blocked by a modal.

		// ── And the claim, on the same hub with the same instrument: the picture is now an object URL
		// over bytes read out of the Workspace, and nothing was asked of the library to draw it.
		const afterCopy = watchRequests(page);
		await page.getByTestId('all-projects').click();
		await expect(page.getByTestId('map-image')).toHaveCount(1);
		// `blob:` is the assertion this turns on. `loading` is gone with it — ADR-0030's deliberate
		// asymmetry, and the one *observable* difference between the two code paths — and the decoded size
		// is unchanged, which is the continuity a scholar is promised: only the network dependency went.
		await expect
			.poll(() => hubPicture(page), { timeout: 20_000 })
			.toEqual({
				src: expect.stringMatching(/^blob:/),
				loading: null,
				decoded: { width: 175, height: 125 }
			});
		expect(afterCopy.library).toEqual([]);
		// Nor did it escape to the ADR-0004 placeholder the pyramid is addressed at: that is what a
		// picture built without the ADR-0011 shim would ask for, and it is a DNS failure rather than a
		// tile.
		expect(afterCopy.placeholder).toEqual([]);
		afterCopy.stop();

		// And the citation survived the copy. `remote.json` is what the map is cited from (ADR-0007), and
		// the flip above is a *reading* of the two files rather than a rewrite of them — a copy that
		// deleted it would show the same picture and lose the provenance.
		expect(await readJson(page, '', `images/${imageId}/remote.json`)).toMatchObject({
			service: service('images.test', 'florida')
		});
	});

	test('survives a reload with the network switched off, drawing from the Project', async ({
		page
	}) => {
		test.slow();
		// The state on disk is the product (ADR-0001), so the interesting question is what a fresh page load
		// makes of it: `imageMode` in `project.json`, the pyramid in the folder, and the record of where it
		// came from all have to line up with nothing in memory helping.
		//
		// **And the load happens with `context.setOffline(true)`, which is what makes "works offline" a
		// claim about the network rather than about a list of intercepted requests.** Every other test in
		// this file leaves the fixture hosts routed throughout, so "the library was not asked" rests on the
		// listener seeing nothing — true, and weaker than it sounds, because a routed host answers whether
		// or not there is a network. Here there is none: the app itself has to come back from its service
		// worker (ADR-0012) and the copy has to be read out of OPFS, which is the whole of what a scholar
		// in a reading room has.
		//
		// **This is the decisive form of "the copy is being used", and it is decisive because the image
		// pane's tiles are unobservable from the network.** A pyramid read out of OPFS issues no request at
		// all, so `window.ballastellaServedTiles` sits on the success path of the tile protocol.
		// Every entry in it is a tile the store answered, addressed at the ADR-0004 placeholder — so a
		// non-empty list *is* the injection shim resolving the copy, and it cannot be satisfied by a
		// canvas that rendered nothing or by a map that fell back to the library.
		await page.addInitScript(() => {
			window.ballastellaServedTiles = [];
		});
		await installIiifHosts(page, { manifestCanvases: singleCanvas });
		await openNewProject(page);
		await addReferenced(page, 'images.test');

		// Nothing was served out of the Project before the copy, because there was nothing in it. This is
		// the control for the assertion below.
		expect(await page.evaluate(() => window.ballastellaServedTiles ?? [])).toEqual([]);

		await openMirrorDialog(page);
		await page.getByTestId('offline-copy-start').click();
		await expect(page.getByTestId('offline-copy-done')).toContainText(
			'offline copy in this Project',
			{
				timeout: 30_000
			}
		);

		// A worker does not claim the page that installed it, so control is waited for rather than assumed
		// — `ready` is the promise that means the *next* navigation will be controlled, and without it the
		// reload below would be answered by the preview server or by nothing at all. This is
		// `editor-pwa.e2e.ts`'s `waitForReady`, inline because that file's helpers belong to its own
		// deployments.
		await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

		const libraryRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('images.test')) libraryRequests.push(request.url());
		});

		await page.context().setOffline(true);
		try {
			await page.reload();
			const copiedRow = await expectOfflineCopyLayer(page);
			await expect(copiedRow.getByTestId('referenced-image-host')).toHaveCount(0);
			// It is one of the Project's own Map Images now — one Layer, drawing local tiles — and
			// the source URI is still on it. The Layer stack *is* that list.
			await expect(page.getByTestId('layer-row')).toHaveCount(1);
			await expect(page.getByTestId('layer-image-mode')).toHaveAttribute(
				'data-image-mode',
				'offline-copy'
			);
			await expect(copiedRow.getByTestId('offline-copy-source')).toHaveText(
				service('images.test', 'florida')
			);

			// The pane drew the copy, tile by tile, out of the Project — with no network at all. The pane
			// is `/align/`, and reaching it offline is part of what that asserts.
			const imageId = generateId(service('images.test', 'florida'));
			await copiedRow.getByTestId('align-map-image').click();
			await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);
			await expect
				.poll(() => page.evaluate(() => (window.ballastellaServedTiles ?? []).length), {
					timeout: 30_000
				})
				.toBeGreaterThan(0);
			const served = await page.evaluate(() => window.ballastellaServedTiles ?? []);
			for (const tile of served)
				expect(tile.url.startsWith(`https://unset.invalid/${imageId}/`)).toBe(true);
			// And every one of them is a tile of a pyramid this app cut: 256-pixel square geometry, contiguous
			// scale factors from 1.
			expect(new Set(served.map((tile) => tile.scaleFactor)).size).toBeGreaterThan(0);
			for (const tile of served) expect([1, 2, 4]).toContain(tile.scaleFactor);

			expect(libraryRequests).toEqual([]);
		} finally {
			// Restored whatever happened, so a failure in here cannot leave the context offline for the
			// teardown or for a retry.
			await page.context().setOffline(false);
		}
	});

	// ADR-0023 replaced the "finish the offline copy" repair path with the absence of the state it
	// repaired, and this is that absence asserted rather than assumed. The old test drove a
	// half-committed copy — pyramid on disk, `project.json` still saying `'referenced'`, Alignment still
	// naming the library — and pressed a button to reconcile them. With one derived answer per map there
	// is nothing to reconcile: the copy *is* the record, so it lands for every Project at once.
	//
	// What is asserted instead is the behaviour that made the repair unnecessary: **two Projects hold a
	// map Layer for the same image, both render, and there is one pyramid on disk.**
	test('a copied map is one pyramid that two Projects both draw', async ({ page }) => {
		test.slow();
		// A community Alignment, so the map is really placed and a warped Layer can be drawn from it.
		await installIiifHosts(page, {
			manifestCanvases: singleCanvas,
			communityAnnotations: [communityAnnotation('images.test', 'florida')]
		});
		await openNewProject(page);
		await ensureAddMapImageOpen(page);
		await page.getByTestId('remote-url').fill('https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-read').click();
		await expect(page.getByTestId('community-offer')).toBeVisible();
		await page.getByTestId('remote-add').click();
		await expectReferencedLayer(page);

		await openMirrorDialog(page);
		await page.getByTestId('offline-copy-start').click();
		await expect(page.getByTestId('offline-copy-done')).toContainText(
			'offline copy in this Project',
			{
				timeout: 30_000
			}
		);

		const imageId = generateId(service('images.test', 'florida'));

		// The Alignment names this Workspace's own tiles now, not the library — the one document write a
		// copy still makes, and the one without which `@allmaps/maplibre` would keep fetching from the
		// library for tiles that are in the folder.
		const alignment = (await readJson(page, '', `alignments/${imageId}.json`)) as {
			target: { source: { id: string } };
		};
		expect(alignment.target.source.id).toBe(`https://unset.invalid/${imageId}`);

		// A second Project over the same image, with its own Layer id and its own name for it.
		await projectOverSameImage(page, 'boston-1775', 'A second argument', imageId);
		await page.reload();

		// One pyramid, one Alignment, at the Workspace root — and nothing inside either Project directory
		// except its own document.
		const files = await listWorkspaceFiles(page);
		expect(files.filter((path) => path.endsWith(`images/${imageId}/info.json`))).toEqual([
			`images/${imageId}/info.json`
		]);
		expect(files.filter((path) => path.startsWith('alignments/'))).toEqual([
			`alignments/${imageId}.json`
		]);
		expect(files.filter((path) => path.startsWith('boston-1775/'))).toEqual([
			'boston-1775/project.json'
		]);

		// And **both** Projects draw it, from those same bytes, with no request to the library. Measured on
		// the warped Layer's own tile cache — bytes fetched *and* decoded — because the failure this path has
		// is an error `@allmaps/render` logs and swallows, so a blank map would otherwise go green. Same
		// instrument as every other warped assertion in this file: `drawTheStack`.
		for (const directory of ['amsterdam-1625', 'boston-1775'] as const) {
			const watched = watchRequests(page);
			await drawTheStack(page, 'load', directory);
			expect(watched.library, `${directory} went back to the library`).toEqual([]);
			// The badge is read off the files, so both Projects agree that the tiles are here — which is the
			// disagreement the deleted `imageMode` used to produce for every Project but the open one.
			//
			// Inside the open card since the Layers revision, so each Project's card is opened in turn.
			await expect((await openLayerRow(page)).getByTestId('layer-image-mode')).toHaveAttribute(
				'data-image-mode',
				'offline-copy'
			);
		}
	});
});

// Nothing is declared here. `ballastellaLayerStack` and `ballastellaRemoteRequests` are both already
// declared — in `editor-layers.e2e.ts` and `editor-remote-iiif.e2e.ts` — and the whole of `e2e/` is one
// TypeScript program, so a second declaration of either would be a merge conflict rather than a
// convenience.
