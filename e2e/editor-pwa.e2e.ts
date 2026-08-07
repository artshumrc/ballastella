import { expect, test, type Page } from '@playwright/test';

import {
	baseMapArchiveFixture,
	byteRange,
	deployEditor,
	deployEditors,
	NEXT_VERSION_MARKER,
	type EditorDeployment
} from './support/editor-deployment';
import {
	clickAt,
	emptyWorkspace,
	gradientPng,
	historicalMap,
	baseMap,
	imagePoints,
	IMAGE_HEIGHT,
	IMAGE_WIDTH,
	makePair,
	PROJECT_NAME,
	rows,
	storedAlignment,
	warpedStatus,
	warpedTiles,
	waitForStored
} from './support/alignment-workspace';
import {
	annotationLayerId,
	baseMap as annotationBaseMap,
	centreOnAmsterdam,
	chooseTool,
	readProjectFile,
	storedAnnotations,
	waitForStack,
	writeProjectFile
} from './support/annotations';
import { seedMapLayer } from './support/project-screen';

/**
 * SPEC's Seam 2 for the PWA slice (stories 6, 8, 9; ADR-0012).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS ASSERTED, AND WHY IT IS ASSERTED THIS WAY
 *
 * "The service worker registered" is a much weaker claim than "the site works with the network
 * off", and this slice is only worth anything if the second one is what is checked. So:
 *
 *   * **Offline is Playwright's real offline.** `context.setOffline(true)` cuts the browser off from
 *     the network; the server is still listening, and every assertion after that line is about what
 *     a browser can do with nothing but what it has already cached. `deployment.requests` is read
 *     afterwards to confirm the isolation was real rather than assumed.
 *   * **The working session is a working session.** The offline test opens a Project with a local
 *     pyramid, makes Control Points, and reads the Georeference Annotation **out of OPFS** to check
 *     the pairs landed. Loading offline while silently failing to save is precisely the failure a
 *     scholar in an archive would find hours later, so the write is what is asserted rather than the
 *     page rendering.
 *   * **Both deployments.** ADR-0006 says one build serves a domain root and a project
 *     subdirectory, and a service worker's scope and a manifest's `start_url` are exactly the values
 *     that hardcode `/`. Every claim here that could differ between the two is driven at both, from
 *     the same bytes with no reconfiguration — which is why these tests bring their own server
 *     rather than using `vite preview`.
 *   * **The cache's contents, not the cache's existence.** ADR-0012's four fences are all of the
 *     form "this must not be cached", and the only honest way to check that is to look inside every
 *     cache the origin has after a full session.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE THREE ENTRY ROUTES
 *
 * A whole class of navigation bug in this epic was invisible because tests used the link route or
 * the direct-load route and never both. An installed app adds a third: it opens at the manifest's
 * `start_url`. All three are driven below — `startUrl` is resolved from the manifest the browser
 * fetched rather than assumed to be the root.
 */

/** How long a service worker gets to install and precache the shell. */
const INSTALL_MS = 30_000;
/** How long a freshly ingested pyramid may take to decode every tile of its first view. */
const TILES_READY_MS = 30_000;

const deployments: { name: string; prefix: string }[] = [
	{ name: 'a domain root', prefix: '' },
	// Two segments deep, and named as a course would name it: SPEC story 99 is an instructor hosting
	// their own instance, which on free static hosting is a repository subdirectory.
	{ name: 'a project subdirectory', prefix: '/teaching/ballastella' }
];

/**
 * Wait until this origin's worker will control the next navigation.
 *
 * **`navigator.serviceWorker.ready` and not `active.state === 'activated'`**, which was a real
 * flake and an instructive one: a page can observe its registration's active worker as `activated`
 * a moment before the browser is willing to hand a controller to a navigation, and reloading in
 * that window produces a page that is *permanently* uncontrolled — the controller is assigned once,
 * when the document is created, so there is nothing to poll for afterwards. It read as "the service
 * worker did not install". `ready` is the promise that means what is wanted here.
 */
const waitForReady = (page: Page) =>
	page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

/**
 * Load the app and come back with the page under the worker's control.
 *
 * The second load is not ceremony. A newly installed worker does not claim the page that installed
 * it — deliberately, because claiming a live client is the mid-alignment takeover story 9 rules out
 * — so the first load is always uncontrolled, and offline only means anything from the next one.
 */
async function installAndControl(page: Page, url: string): Promise<void> {
	await page.goto(url);
	await waitForReady(page);
	await page.reload();
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
		timeout: INSTALL_MS
	});
}

/** The registration, as the browser describes it. */
const registrationState = (page: Page) =>
	page.evaluate(async () => {
		const registration = await navigator.serviceWorker.getRegistration();
		return {
			scope: registration?.scope ?? null,
			active: registration?.active?.state ?? null,
			waiting: registration?.waiting?.state ?? null,
			controller: navigator.serviceWorker.controller?.scriptURL ?? null
		};
	});

/** Every URL in every cache this origin has, by cache name. The artefact the fences are about. */
const cachedUrls = (page: Page) =>
	page.evaluate(async () => {
		const found: Record<string, string[]> = {};
		for (const name of await caches.keys()) {
			const cache = await caches.open(name);
			found[name] = (await cache.keys()).map((request) => request.url).sort();
		}
		return found;
	});

const cacheNames = (page: Page) => page.evaluate(() => caches.keys());

/**
 * Requests the *app* made, which is every request except the browser's own check for a new worker.
 *
 * Chromium re-fetches `service-worker.js` on navigation whatever the app does, and Playwright's
 * `setOffline` does not cover a request the browser makes on its own behalf. Excluding it keeps the
 * assertion about the thing under test — that nothing the page needs came off the network — rather
 * than about an implementation detail of the emulation.
 */
const requestsExceptUpdateChecks = (asked: readonly string[]) =>
	asked.filter((path) => !path.endsWith('/service-worker.js'));

/**
 * A Project with one locally ingested Historical Map, both panes live, at whatever URL the page is
 * already on.
 *
 * `support/alignment-workspace.ts`'s `start` cannot be used: it navigates to the Playwright
 * `baseURL`, and every test here is driven against a server of its own at a path of its own. The
 * steps are the same and are a user's.
 *
 * @returns the image id, which is the Alignment's file name
 */
async function startProjectWithMap(page: Page): Promise<string> {
	await page.getByRole('button', { name: 'New Project' }).click();
	const dialog = page.getByRole('dialog', { name: 'New Project' });
	await dialog.getByLabel('Project name').fill(PROJECT_NAME);
	await dialog.getByRole('button', { name: 'Create' }).click();
	await page.getByRole('link', { name: PROJECT_NAME }).click();
	await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();

	await page.getByLabel('Add a Historical Map from a file').setInputFiles({
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(IMAGE_WIDTH, IMAGE_HEIGHT)
	});
	// The image id off the Layer the map arrived with (ADR-0023, ticket 04).
	const addedRow = page.getByTestId('layer-row').first();
	await expect(addedRow).toBeVisible({ timeout: 30_000 });
	return (await addedRow.getAttribute('data-image-id'))!;
}

/**
 * Press Align on the Layer that draws `imageId`.
 *
 * Align is on the Layer since ticket 04, so a Project with two Historical Maps has two of them —
 * naming the image is how a test says which one it means, and `data-image-id` on the row is where
 * that is readable.
 */
const alignLayerFor = (page: Page, imageId: string) =>
	page
		.locator(`[data-testid="layer-row"][data-image-id="${imageId}"]`)
		.getByTestId('align-historical-map')
		.click();

/** Whatever has focus, said in enough detail that a change of focus is a change of string. */
const focusedDescription = (page: Page) =>
	page.evaluate(() => {
		const element = document.activeElement;
		if (!element) return 'nothing';
		return `${element.tagName}#${element.id}.${element.className}[${element.getAttribute('data-testid') ?? ''}]`;
	});

/** The manifest as the page links to it, resolved and parsed. */
async function manifest(page: Page): Promise<{ url: string; document: Record<string, string> }> {
	const url = await page.evaluate(() => {
		const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
		// `link.href` is the *resolved* URL, which is the point: the attribute is relative, and what
		// this asserts is where a browser resolves it to.
		return link?.href ?? null;
	});
	expect(url, 'the page links to no web app manifest').not.toBeNull();
	const response = await page.request.get(url as string);
	expect(response.status(), `the manifest at ${url} was not served`).toBe(200);
	return { url: url as string, document: await response.json() };
}

test.describe('the web app manifest and the service worker scope', () => {
	for (const { name, prefix } of deployments) {
		test.describe(`served at ${name}`, () => {
			let site: EditorDeployment;

			test.beforeEach(async () => {
				site = await deployEditor(prefix);
			});
			test.afterEach(async () => {
				await site.close();
			});

			test('the manifest is installable and points at this deployment, not the origin', async ({
				page
			}) => {
				await page.goto(site.url);
				const { url, document } = await manifest(page);

				// Everything Chromium requires to offer an install: a name, a `display` that is not
				// `browser`, an icon it can use, and a `start_url` inside the scope.
				expect(document['name']).toBe('Ballastella');
				expect(document['short_name']).toBe('Ballastella');
				expect(document['display']).toBe('standalone');

				// **The whole ADR-0006 question, in two lines.** `start_url` and `scope` are `"."` in the
				// file, so the browser resolves them against the manifest's own URL — and the manifest's
				// URL was reached from a relative `href`. At a domain root that lands on the origin; two
				// directories deep it lands two directories deep. A `"/"` in either would pass here at the
				// root and take a subdirectory deployment to somebody else's page.
				expect(new URL(document['start_url'] as string, url).href).toBe(site.url);
				expect(new URL(document['scope'] as string, url).href).toBe(site.url);

				// Every icon is fetchable from where the manifest says it is, which is the half of "valid
				// manifest" that a JSON schema cannot answer.
				const icons = (document as unknown as { icons: { src: string; sizes: string }[] }).icons;
				expect(icons.length).toBeGreaterThan(0);
				for (const icon of icons) {
					const resolved = new URL(icon.src, url).href;
					expect(resolved.startsWith(site.url), `${icon.src} escapes ${site.url}`).toBe(true);
					const response = await page.request.get(resolved);
					expect(response.status(), `${resolved} was not served`).toBe(200);
				}
				// Chromium wants at least one icon of 192 px or more.
				const sizes = icons.flatMap((icon) => icon.sizes.split(/\s+/));
				expect(sizes.some((size) => size === '192x192' || size === '512x512')).toBe(true);

				// And the browser's own verdict on the document, which is the only opinion that decides
				// installability: it parses the manifest itself and reports what it could not use.
				// Filtered to `critical`, because the non-critical entries are advice about fields this
				// app does not set and would make the assertion about Chromium's taste rather than about
				// validity.
				const session = await page.context().newCDPSession(page);
				const appManifest = await session.send('Page.getAppManifest');
				expect(
					appManifest.errors.filter((error) => error.critical !== 0),
					'the browser rejected the manifest'
				).toEqual([]);
				expect(appManifest.url).toBe(url);
			});

			test('the service worker is scoped to this deployment, not to the origin', async ({
				page
			}) => {
				await installAndControl(page, site.url);
				const state = await registrationState(page);

				// The scope is the deployment's own root. At a subdirectory this is the assertion that
				// fails if the registration ever spells `/service-worker.js`: the browser would refuse the
				// scope outright, or — worse, on a host serving a fork at the origin too — claim every
				// other application on the domain.
				expect(state.scope).toBe(site.url);
				expect(state.controller).toBe(`${site.url}service-worker.js`);
				expect(state.active).toBe('activated');
			});

			test('each cache holds exactly what its rule says, and nothing else', async ({ page }) => {
				await installAndControl(page, site.url);

				const caches = await cachedUrls(page);
				const names = Object.keys(caches).sort();
				expect(names).toHaveLength(2);
				expect(names[0]).toMatch(/^ballastella-base-map-/);
				expect(names[1]).toMatch(/^ballastella-shell-/);

				const inside = `${new URL(site.url).origin}${prefix}/`;
				const pathsOf = (name: string) =>
					(caches[name] as string[]).map((url) => {
						// ADR-0012 fences 2, 3 and 4: nothing from anybody else's server is in here, ever, and
						// nothing at all outside this deployment's own directory.
						expect(url.startsWith(inside), `${url} is outside ${inside}`).toBe(true);
						return new URL(url).pathname.slice(prefix.length);
					});

				// Fence 1: the shell cache is the hashed build assets and the entry HTML, and that is the
				// whole list.
				const shell = pathsOf(names[1] as string);
				// `/align` is here because aligning is a route of its own since ticket 03, and it is the
				// route SPEC story 8 is actually about: a scholar in a reading room with no wifi placing
				// Control Points. An entry page missing from this list is a page that 404s offline.
				// `/base-map` and `/layers` are absent because ticket 04 deleted both: the Base Map with
				// its Layer stack *is* `/`, addressed by `?p=`. `/image-pane` stays — retained and
				// unlinked, it is the only storage-independent projection coverage there is.
				const entryHtml = ['/', '/align', '/image-pane'];
				expect(shell.length, 'nothing was precached').toBeGreaterThan(10);
				for (const path of shell) {
					expect(
						path.startsWith('/_app/') || entryHtml.includes(path),
						`${path} is not a hashed build asset and not an entry page`
					).toBe(true);
				}
				for (const route of entryHtml) {
					expect(shell, `${route} is an entry route and must work offline`).toContain(route);
				}

				// The second cache is this deployment's glyphs and sprites. No Base Map archive ships.
				const bundled = pathsOf(names[0] as string);
				expect(bundled.length, 'Base Map display assets were not precached').toBeGreaterThan(3);
				for (const path of bundled) {
					expect(path.startsWith('/base-map/'), `${path} is not a Base Map file`).toBe(true);
					expect(path, 'a PMTiles archive shipped in the installed app').not.toMatch(/\.pmtiles$/);
				}

				// ADR-0019, the half the dependency and bundle fences cannot see. The editor's `static/`
				// holds the staged read-only viewer that Publish writes into a Workspace, and `build` holds
				// two byte-identical 5,084,535-byte copies of `vips.wasm`. A worker that swept either
				// directory whole would put megabytes a Reader never asked for, and a tiler nobody in this
				// session will use, into a cache — which no `package.json` check and no bundle check can
				// observe. Ticket 10 measured taking the `.wasm` in `build`: 5,084,535 bytes on install,
				// 23% more than the archive it removed, for a module this deployment cannot even run
				// (`libvipsUnavailableReason` refuses it without COOP/COEP).
				for (const path of [...shell, ...bundled]) {
					expect(path, 'the staged viewer bundle must never be cached').not.toContain(
						'/viewer-bundle/'
					);
					expect(path, 'wasm-vips must never be cached (ADR-0019)').not.toMatch(/\.wasm$/);
					expect(path, 'test fixtures must never be cached').not.toContain('/fixtures/');
				}
			});

			test('with the network off the app loads from every entry route', async ({
				page,
				context
			}) => {
				const errors: string[] = [];
				page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`));

				await installAndControl(page, site.url);
				// The manifest's own `start_url`, resolved by a browser, is the URL an installed app opens
				// at — the third entry route, and the one no other test in this repository uses.
				const { url: manifestUrl, document } = await manifest(page);
				const startUrl = new URL(document['start_url'] as string, manifestUrl).href;

				await context.setOffline(true);
				const asked = site.requests.length;

				// 1. The direct-load route, at `start_url` — where an installed app opens.
				await page.goto(startUrl);
				await expect(page.getByRole('heading', { name: 'Ballastella Editor' })).toBeVisible();

				// 2. A direct load of a page that is not the root, which is what a bookmark is. `/align`
				// since ticket 04 deleted `/base-map`: it is the app's one other entry route, and it is
				// the one SPEC story 8 is actually about — a scholar with no wifi placing Control Points.
				await page.goto(`${site.url}align?p=nothing-here&layer=none`);
				await expect(page.getByRole('heading', { level: 1, name: 'Align' })).toBeVisible();

				// 3. The link route: a client-side navigation from that page back to the hub. Driven from
				// the second entry route rather than the first, because a class of navigation bug in this
				// epic was invisible for exactly as long as every test used one of the two.
				await page.getByRole('link', { name: 'Back to all Projects' }).click();
				await expect(page.getByRole('heading', { name: 'Ballastella Editor' })).toBeVisible();
				await expect(page.getByRole('button', { name: 'New Project' })).toBeVisible();

				// And the trailing-slash spelling of the same bookmark, which a static host answers with a
				// redirect and which offline nobody is left to answer. The worker does it, because HTML
				// served at `/align/` resolves its own relative `./_app/…` references to nothing.
				await page.goto(`${site.url}align/?p=nothing-here&layer=none`);
				await expect(page).toHaveURL(`${site.url}align?p=nothing-here&layer=none`);
				await expect(page.getByRole('heading', { level: 1, name: 'Align' })).toBeVisible();

				// The network was genuinely absent: the server heard nothing the app asked for after the
				// switch. This is what separates "served from the cache" from "the offline flag did not
				// take". `service-worker.js` is exempt and is *not* the app asking: Chromium checks for a
				// new worker on navigation, and Playwright's offline emulation does not cover a request the
				// browser makes on its own behalf. Nothing the page renders comes through it.
				expect(
					requestsExceptUpdateChecks(site.requests.slice(asked)),
					'the browser reached the server while it was supposed to be offline'
				).toEqual([]);

				// An exception in a Svelte teardown abandons the rest of the destroy flush *and* the mount
				// of the page being navigated to, and leaves nothing on screen while every existing
				// assertion still passes. So navigation is never asserted here without this.
				expect(errors, 'the app threw while running offline').toEqual([]);
			});
		});
	}
});

test.describe('two deployments of this app on one origin', () => {
	/**
	 * ADR-0006's other half, and the one a scope does not cover.
	 *
	 * A service worker's scope keeps two deployments' *registrations* apart, and every other test in
	 * this file rests on that. **Cache storage is not scoped.** `caches.keys()` answers for the whole
	 * origin, so each deployment sees the other's caches, and unless the deployment is written into
	 * the names, `activate` reads them as some other app's litter and deletes them. Whichever
	 * deployment was published second then takes the first one's offline shell with it — silently,
	 * on a deployment nobody touched, discovered by a scholar in a reading room with no network.
	 *
	 * **Two sibling directories rather than a domain root and a subdirectory**, which is the same
	 * failure and a cleaner statement of it: a deployment at the root has a scope of `/`, so it also
	 * *controls* the subdirectory's pages until the more specific registration exists, and that
	 * interleaving would make this test about something else. Two repositories on one GitHub Pages
	 * user site — `user.github.io/ballastella/` and `user.github.io/teaching-ballastella/` — is the
	 * shape here, and it is at least as ordinary.
	 */
	test('do not delete each other’s offline shell', async ({ page, context }) => {
		const [first, second] = await deployEditors('/teaching/ballastella', '/research/ballastella');
		try {
			await installAndControl(page, first.url);
			// A worker of its own, activating for the first time — and `activate` is the only thing in
			// this application that ever deletes a cache.
			await installAndControl(page, second.url);

			// Four, not two: each deployment's shell and its Base Map, side by side on one origin.
			expect(
				await cacheNames(page),
				'a deployment’s caches were swept away by its neighbour'
			).toHaveLength(4);

			// And the claim that is not about caches at all. With the network off, **both** deployments
			// still open — the one installed first exactly as much as the one installed last.
			await context.setOffline(true);
			await page.goto(first.url);
			await expect(page.getByRole('heading', { name: 'Ballastella Editor' })).toBeVisible();
			await page.goto(second.url);
			await expect(page.getByRole('heading', { name: 'Ballastella Editor' })).toBeVisible();
		} finally {
			await first.close();
		}
	});
});

test.describe('the app with the network off', () => {
	let site: EditorDeployment;

	test.beforeEach(async () => {
		site = await deployEditor();
	});
	test.afterEach(async () => {
		await site.close();
	});

	test('a new Project explains the absent Base Map and still accepts a Historical Map file', async ({
		page,
		context
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`));

		await installAndControl(page, site.url);
		await emptyWorkspace(page);
		await context.setOffline(true);
		const asked = site.requests.length;
		await page.getByRole('button', { name: 'New Project' }).click();
		const dialog = page.getByRole('dialog', { name: 'New Project' });
		await dialog.getByLabel('Project name').fill(PROJECT_NAME);
		await dialog.getByRole('button', { name: 'Create' }).click();
		await page.getByRole('link', { name: PROJECT_NAME }).click();

		const notice = page.getByTestId('base-map-offline');
		await expect(notice).toBeVisible();
		await expect(notice).toContainText('no network connection');
		await expect(notice).toContainText('Base Map');
		await expect(notice).toContainText('Historical Map');

		await page.getByLabel('Add a Historical Map from a file').setInputFiles({
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(IMAGE_WIDTH, IMAGE_HEIGHT)
		});
		await expect(page.getByTestId('layer-row')).toHaveCount(1, { timeout: 30_000 });

		// Nothing was asked of the server across the whole session.
		expect(
			requestsExceptUpdateChecks(site.requests.slice(asked)),
			'the browser reached the server during the offline session'
		).toEqual([]);
		expect(errors, 'the app threw during the offline session').toEqual([]);
	});

	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// THE CONTRACT CLAUSE: "a user's Historical Maps, Alignments, and Annotations always work with
	// no network."
	//
	// The Base Map does not, and after ticket 10 it *cannot* — no archive ships and the tile cache is
	// ticket 11 — so this is the clause that has to be proved separately, and separately is where a
	// removal slice is most likely to quietly break it. Everything below runs with the network cut.
	// ═════════════════════════════════════════════════════════════════════════════════════════════
	test('a Project with a local Historical Map is fully usable with the network off', async ({
		page,
		context
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`));
		// **MapLibre's warnings are part of the assertion here.** Its failure mode for an asset it
		// cannot fetch is to carry on: a missing glyph range is a `console.warn` and labels drawn with
		// whatever local font is to hand, and a missing sprite is a warning and no icons. So a map that
		// looks fine in a screenshot can be one that reached the network for half of itself. Anything
		// naming a Base Map file after the switch below is a cache miss — and this listener is the only
		// behavioural proof that the 820 KB of glyphs and sprites this ticket kept are actually served
		// from the cache, rather than merely being present in it.
		const complaints: string[] = [];
		page.on('console', (message) => {
			if (message.text().includes('base-map/')) complaints.push(message.text());
		});

		await installAndControl(page, site.url);
		const precached = await cachedUrls(page);
		await emptyWorkspace(page);
		await page.reload();

		// The Project and its pyramid are made while there is still a network, because that is the
		// scholar's situation: they prepared in the office and are now in the reading room.
		const imageId = await startProjectWithMap(page);

		// ─────────────────────────────────────────────────────────────────────────────────────────
		// THE NETWORK GOES AWAY HERE. Everything below is the reading room.
		await context.setOffline(true);
		const asked = site.requests.length;
		complaints.length = 0;

		await page.reload();
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();

		// **Offline, and the route change is part of what is being asserted.** Aligning is `/align/`
		// since ticket 03, so reaching it with the network off exercises the precached prerendered page
		// and its code chunks as well as the panes themselves.
		await page.getByTestId('align-historical-map').click();
		await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);

		// The user's own pyramid draws with no network, which is ADR-0011's injection layer earning its
		// keep: a locally ingested Historical Map has no URL at all, so nothing about this pane can
		// depend on a server being there.
		await expect(page.getByTestId('image-pane')).toBeVisible();
		await expect(page.getByTestId('historical-map-tiles')).toHaveAttribute(
			'data-tiles-loaded',
			'true',
			{ timeout: TILES_READY_MS }
		);
		await expect(page.getByTestId('pairing-status')).toContainText('first Control Point');

		// Three Control Point pairs, placed by clicking the two panes, offline.
		await makePair(page, [0.3, 0.3]);
		await makePair(page, [0.6, 0.35]);
		await makePair(page, [0.45, 0.7]);
		await expect(rows(page)).toHaveCount(3);
		await expect(imagePoints(page)).toHaveText(['1', '2', '3']);

		// **And they reached the disk.** This is the assertion the ticket singles out: an editor that
		// loads offline and silently fails to save would pass every assertion above it.
		await waitForStored(page, imageId, 3);
		const written = await storedAlignment(page, imageId);
		expect(written, 'no Alignment was written while offline').not.toBeNull();
		expect(JSON.parse(written as string).body.features).toHaveLength(3);

		// A change to an existing pair, saved: the second write, so the claim is "saving works" and not
		// "the first save happened to be queued before the network went".
		await clickAt(historicalMap(page), 0.8, 0.2);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
		await clickAt(baseMap(page), 0.8, 0.2);
		await waitForStored(page, imageId, 4);

		// **The Historical Map is drawn warped over the earth, offline, with no Base Map under it.**
		// This is the assertion ticket 10 was most likely to lose: `BaseMapPane` attaches the warped
		// layer on the map's `load`, and the reason the bundled archive used to be precached was the
		// measurement that a MapLibre style whose one vector source can never be reached never loads.
		// No archive ships now and the tile cache is ticket 11, so the Base Map really is unreachable
		// here — and the scholar's own work still draws over it. Tiles that arrived *and decoded* are
		// counted, because an error `@allmaps/render` logs and swallows renders a blank map.
		await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', 'drawn');
		expect(
			await warpedTiles(page),
			'the aligned Historical Map did not render over the Base Map offline'
		).toBeGreaterThan(0);

		// An Annotation drawn on the Project screen, and written to disk. Back out of the alignment
		// route first: the Layer stack is on the Project (ticket 04), which is where this lands.
		await page.getByTestId('back-to-project').click();
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();
		await expect(page.getByTestId('layer-sidebar')).toBeVisible();
		await page.getByTestId('add-annotation-layer').click();
		await waitForStack(page);
		await centreOnAmsterdam(page);
		const layerId = await annotationLayerId(page);

		await chooseTool(page, 'point');
		await clickAt(annotationBaseMap(page), 0.5, 0.5);
		await expect.poll(async () => (await storedAnnotations(page, layerId)).features.length).toBe(1);
		const drawn = await storedAnnotations(page, layerId);
		expect(drawn.features[0]?.geometry?.type, 'the Annotation reached the disk offline').toBe(
			'Point'
		);

		// Nothing was asked of the server across the whole session.
		expect(
			requestsExceptUpdateChecks(site.requests.slice(asked)),
			'the browser reached the server during the offline session'
		).toEqual([]);
		// ─────────────────────────────────────────────────────────────────────────────────────────
		// **THE 820 KB THIS TICKET KEPT ARE ACTUALLY SERVED, OFFLINE, AT THE URL MAPLIBRE ASKS FOR.**
		//
		// ADR-0025's reason for keeping glyphs and sprites is that without them MapLibre draws the map
		// and *silently* falls back to system fonts — invisible to every assertion about the map. So
		// the listener above watches for the warning that is the only sign of it, and the fetches below
		// ask for the files directly.
		//
		// The direct fetch is here because the listener alone is no longer enough, and measuring that
		// is what earned this paragraph: with no archive shipped and the network off, the Base Map's
		// one vector source never loads, so MapLibre never reaches the point of requesting a glyph
		// range at all. Breaking the glyph precache produces no warning, because nothing asks. A
		// listener that cannot fire is not evidence. These two fetches ask on MapLibre's behalf, at
		// the URLs its style templates expand to — and a space in `Noto Sans Regular` is the whole
		// point of spelling one out: the precache list holds a decoded path, the request carries
		// `%20`, and every glyph range was a cache miss until the worker normalised the two.
		// A rejected fetch is reported as 0 rather than thrown, so that a missing file fails on the
		// named assertion below instead of as an unexplained `TypeError` from `page.evaluate`.
		const fromCacheOffline = (path: string) =>
			page.evaluate(
				(url) =>
					fetch(url).then(
						(response) => response.status,
						() => 0
					),
				new URL(path, site.url).href
			);
		expect(
			await fromCacheOffline('base-map/fonts/Noto Sans Regular/0-255.pbf'),
			'a glyph range was not served from the cache offline'
		).toBe(200);
		expect(
			await fromCacheOffline('base-map/sprites/light.json'),
			'a sprite sheet was not served from the cache offline'
		).toBe(200);
		expect(complaints, 'a Base Map file was not served from the cache').toEqual([]);
		expect(errors, 'the app threw during the offline session').toEqual([]);

		// ─────────────────────────────────────────────────────────────────────────────────────────
		// **AND THE CACHES ARE STILL EXACTLY WHAT `install` MADE THEM.**
		//
		// Compared whole rather than filtered, because the interesting failure is an *addition*: one
		// runtime `cache.put` on a path that passes every per-URL rule in the cache-contents test
		// would be invisible to a check written in terms of those rules, and is precisely what a later
		// "just cache this too" looks like in a diff. It is also what stops the shell's `.wasm`
		// exclusion — 5,084,535 bytes, measured — from being undone without anybody noticing.
		expect(await cachedUrls(page), 'the working session added something to a cache').toEqual(
			precached
		);
	});
});

/**
 * The other half of the same criterion, and the half the offline session cannot reach.
 *
 * ADR-0012's fences 3 and 4 are about *other people's servers* — a library's IIIF endpoint and a
 * remote Base Map archive — and a session with the network off never asks either of them for
 * anything, so it cannot show that what came back was not kept. This one runs online and asks both.
 *
 * Both are stood in for rather than reached. `gallica.example.test` does not exist and the catalog's
 * remote archive is somebody's goodwill bucket; putting either in this suite's path would make a
 * green run depend on the internet. What is under test is not their hosting, it is what this
 * application does with bytes that arrive from somewhere that is not this deployment.
 */
test.describe('a working session that reaches other people’s servers', () => {
	let site: EditorDeployment;

	test.beforeEach(async () => {
		site = await deployEditor();
	});
	test.afterEach(async () => {
		await site.close();
	});

	/** A library's IIIF Image service: reached every time, cached never (ADR-0012 fence 3). */
	const LIBRARY = 'gallica.example.test';
	const SERVICE = `https://${LIBRARY}/iiif/3/btv1b8592433v`;
	const REFERENCED_WIDTH = 700;
	const REFERENCED_HEIGHT = 500;

	test('reads a referenced Historical Map and a Base Map that needs the network, and caches neither', async ({
		page,
		context
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`));

		const here = new URL(site.url).origin;
		const archive = await baseMapArchiveFixture();
		let libraryRequests = 0;
		let remoteArchiveRequests = 0;

		// ─────────────────────────────────────────────────────────────────────────────────────────
		// `context.route`, NOT `page.route`
		//
		// Every page in this file is under a service worker's control, and a request that has passed
		// through a worker is not the page's own as far as Playwright is concerned — `page.route`,
		// which is what every other fixture host in this repository uses, never sees it. This is the
		// only interception in the suite that has to work from underneath a worker.
		await context.route(
			(url) =>
				url.origin !== here && (url.hostname === LIBRARY || url.pathname.endsWith('.pmtiles')),
			async (route) => {
				const url = new URL(route.request().url());
				const cors = { 'access-control-allow-origin': '*' };

				// Somebody else's Base Map archive, answered with this deployment's own bundled bytes: a
				// different *place* and identical behaviour, and the place is the whole of fence 4. Byte
				// served by the same helper the deployment's own host uses, because `pmtiles` rejects a
				// `200` longer than it asked for and would stop after one request.
				if (url.pathname.endsWith('.pmtiles')) {
					remoteArchiveRequests += 1;
					const served = byteRange(
						archive,
						route.request().headers()['range'],
						'application/octet-stream'
					);
					return route.fulfill({
						status: served.status,
						headers: { ...served.headers, ...cors },
						body: served.body
					});
				}

				libraryRequests += 1;
				if (url.pathname.endsWith('/info.json')) {
					return route.fulfill({
						status: 200,
						contentType: 'application/json',
						headers: cors,
						body: JSON.stringify({
							'@context': 'http://iiif.io/api/image/3/context.json',
							id: SERVICE,
							type: 'ImageService3',
							protocol: 'http://iiif.io/api/image',
							profile: 'level2',
							width: REFERENCED_WIDTH,
							height: REFERENCED_HEIGHT,
							tiles: [{ width: 256, height: 256, scaleFactors: [1, 2] }]
						})
					});
				}
				const tile = /\/\d+,\d+,\d+,\d+\/(\d+),(\d+)\/0\/default\.(jpg|png)$/.exec(url.pathname);
				if (!tile) return route.fulfill({ status: 404, headers: cors, body: 'no such tile' });
				return route.fulfill({
					status: 200,
					contentType: 'image/png',
					headers: cors,
					body: gradientPng(Number(tile[1]), Number(tile[2]))
				});
			}
		);

		await installAndControl(page, site.url);
		// What `install` put there. Everything below has to leave it exactly so.
		const precached = await cachedUrls(page);
		await emptyWorkspace(page);
		await page.reload();

		const imageId = await startProjectWithMap(page);
		const project = new URL(page.url()).searchParams.get('p');
		expect(project, 'a Project is addressed by ?p= (ADR-0008)').not.toBeNull();

		// A Historical Map this Project references rather than holds, written beside the local one.
		// Behind the app's back because the route that produces one is ticket 14's, and what is under
		// test here is only what happens to the tiles once they arrive.
		await writeProjectFile(
			page,
			'images/btv1b8592433v/remote.json',
			JSON.stringify({
				service: SERVICE,
				label: 'Carte de la Floride',
				width: REFERENCED_WIDTH,
				height: REFERENCED_HEIGHT
			}),
			// The Workspace root: a referenced Historical Map belongs to the Workspace like any other, so
			// its record sits beside every other map's rather than inside one Project (ADR-0023).
			''
		);
		// And the Layer of *this* Project that draws it. Since ticket 04 the referenced map's host is
		// Layer state on the Project screen rather than a Workspace-wide list, so a fixture that writes
		// only the Workspace's half is writing a map no Project uses.
		await seedMapLayer(page, 'btv1b8592433v', 'Carte de la Floride', project!);
		await page.reload();
		await expect(page.getByTestId('referenced-image-host')).toHaveText(LIBRARY);

		// Reading it as a document is what actually pulls tiles off the library's server (SPEC story
		// 48) — the pane alone would leave fence 3 asserted against a map nobody had loaded.
		await page.getByTestId('view-unwarped').click();
		await expect(page.getByTestId('unwarped-view')).toBeVisible();
		await expect.poll(() => libraryRequests, { timeout: TILES_READY_MS }).toBeGreaterThan(1);
		await page.getByTestId('unwarped-close').click();

		// A Control Point pair, so that this is a working session and not a tour. On `/align/` since
		// ticket 03, and reached from **this Project's own** Layer — Align is per Layer since ticket 04,
		// and the referenced map seeded above has one of its own.
		await alignLayerFor(page, imageId);
		await expect(page.getByTestId('historical-map-tiles')).toHaveAttribute(
			'data-tiles-loaded',
			'true',
			{ timeout: TILES_READY_MS }
		);
		await makePair(page, [0.4, 0.4]);
		await waitForStored(page, imageId, 1);

		// And the Base Map this deployment's catalog marks as needing the network — chosen *by that
		// marking* rather than by its id, because ADR-0020 makes the catalog a fork's to replace and a
		// test naming an entry would be one more thing a fork had to change.
		await page.goto(`${site.url}?p=${project}`);
		const switcher = page.getByRole('combobox', { name: 'Base Map' });
		// Located rather than read out of an `evaluateAll`, which does not auto-wait: straight after
		// `goto` that ran against the options the client had not rendered yet, found none, and failed
		// claiming the catalog offers no such entry. On a slower machine it would have failed; on a
		// faster one it would have passed. A locator retries until the catalog is on the page.
		const remote = switcher.locator('option', { hasText: /needs network/i });
		await expect(remote, 'this catalog offers no Base Map that needs the network').not.toHaveCount(
			0
		);
		await switcher.selectOption(await remote.first().getAttribute('value'));
		await expect.poll(() => remoteArchiveRequests, { timeout: TILES_READY_MS }).toBeGreaterThan(0);

		// ─────────────────────────────────────────────────────────────────────────────────────────
		// **AND NOT ONE BYTE OF EITHER OF THEM IS IN A CACHE.**
		//
		// Compared whole against what `install` left, rather than filtered by host: the failure worth
		// catching is an *addition*, and a check written as "no URL from these two hosts" would wave
		// through the next thing somebody decides to keep.
		expect(await cachedUrls(page), 'the session added something to a cache').toEqual(precached);
		expect(errors, 'the app threw during the session').toEqual([]);
	});
});

test.describe('what offline cannot fix, and what it must not break', () => {
	let site: EditorDeployment;

	test.beforeEach(async () => {
		site = await deployEditor();
	});
	test.afterEach(async () => {
		await site.close();
	});

	test('a referenced Historical Map says so, names its host, and breaks nothing else', async ({
		page,
		context
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`));

		await installAndControl(page, site.url);
		await emptyWorkspace(page);
		await page.reload();
		const imageId = await startProjectWithMap(page);

		// A Historical Map this Project *references* rather than holds, written beside the local one.
		// Behind the app's back because the route that produces it needs a live IIIF host, and what is
		// under test is what happens when there is none.
		await writeProjectFile(
			page,
			'images/btv1b8592433v/remote.json',
			JSON.stringify({
				service: 'https://gallica.example.test/iiif/3/btv1b8592433v',
				label: 'Carte de la Floride',
				width: 700,
				height: 500
			}),
			// The Workspace root (ADR-0023).
			''
		);
		// And the Layer of this Project that draws it — see the note in the session test above.
		await seedMapLayer(page, 'btv1b8592433v', 'Carte de la Floride');
		await page.reload();
		await expect(page.getByTestId('referenced-image-host')).toHaveText('gallica.example.test');
		await expect(page.getByTestId('referenced-offline')).toBeHidden();

		// ─────────────────────────────────────────────────────────────────────────────────────────
		// **The connection goes on the live document, and that is not a shortcut.** Playwright's
		// offline emulation fires `offline` and flips `navigator.onLine` on a running page, but a page
		// *loaded* while it is in force reports `navigator.onLine === true` — the emulation does not
		// reach the new document's initial value, whereas a genuinely disconnected machine reports
		// `false` there. Both feed the same one signal in `InstalledApp`, so this drives the half that
		// can be driven, and the reload below then asserts the half that matters most anyway: that a
		// Project holding a referenced Historical Map still opens and still works offline.
		await context.setOffline(true);

		const notice = page.getByTestId('referenced-offline');
		await expect(notice).toBeVisible();
		await expect(notice).toContainText('gallica.example.test');
		await expect(notice).toHaveAttribute('role', 'alert');

		// **And the rest of the Project is untouched.** ADR-0012's fence 2 says a remote pyramid must
		// not be cached, so this map cannot be shown — but a Project that contained one and therefore
		// would not open at all is the failure that matters.
		await page.reload();
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();
		await expect(page.getByTestId('referenced-image-host')).toHaveText('gallica.example.test');
		// The Project's *own* Historical Map still aligns, on `/align/` (ticket 03), reached from its
		// own Layer (ticket 04).
		await alignLayerFor(page, imageId);
		await expect(page.getByTestId('historical-map-tiles')).toHaveAttribute(
			'data-tiles-loaded',
			'true',
			{ timeout: TILES_READY_MS }
		);
		await makePair(page, [0.35, 0.35]);
		await waitForStored(page, imageId, 1);
		expect(errors, 'an unreachable referenced host must not throw').toEqual([]);
	});

	test('the service worker does not serve the ProjectStore', async ({ page, context }) => {
		await installAndControl(page, site.url);
		await emptyWorkspace(page);
		await page.reload();
		await startProjectWithMap(page);

		// ADR-0011 rejected a service worker serving the store at a virtual path, on File System Access
		// permission semantics, and a service worker existing does not reopen that. Asserted from both
		// sides.
		//
		// Online: a request that *looks* like a Project file is answered by the server — a 404, because
		// no such file is deployed — rather than by the worker out of OPFS. A worker that had quietly
		// grown a virtual store path would answer 200 here.
		const status = await page.evaluate(
			(url) => fetch(url).then((response) => response.status),
			`${site.url}amsterdam-1625/project.json`
		);
		expect(status, 'something answered a store path over HTTP').toBe(404);

		// Offline: the same request fails outright. The worker declines to respond at all, so the
		// browser's own network failure is what the caller sees — while `project.json` is right there in
		// OPFS and readable, which is the point. Two sources of truth for one Project is the thing
		// ADR-0012 fence 2 calls the most damaging outcome available to this ticket.
		await context.setOffline(true);
		const offline = await page.evaluate(
			(url) =>
				fetch(url).then(
					() => 'answered',
					() => 'refused'
				),
			`${site.url}amsterdam-1625/project.json`
		);
		expect(offline, 'the worker answered a store path from a cache').toBe('refused');
		expect(JSON.parse(await readProjectFile(page, 'project.json')).name).toBe(PROJECT_NAME);
	});
});

test.describe('the offer to install', () => {
	let site: EditorDeployment;

	test.beforeEach(async () => {
		site = await deployEditor();
	});
	test.afterEach(async () => {
		await site.close();
	});

	test('is made where the folder permission is explained, and says how when the browser will not offer', async ({
		page
	}) => {
		await page.goto(site.url);
		await emptyWorkspace(page);
		await page.reload();

		// SPEC story 6, and ADR-0012's reason for the whole slice: installing is the answer to "why does
		// it keep asking about my folder?", so the offer belongs beside that explanation and nowhere else.
		const storage = page.getByRole('region', { name: 'Where your work is stored' });
		await expect(storage.getByTestId('install-offer')).toBeVisible();

		// Headless Chromium does not fire `beforeinstallprompt`, and neither does Firefox or Safari ever.
		// So the state that most users are in is the one asserted first: a sentence saying where to look,
		// not a disabled button and not silence.
		await expect(page.getByTestId('install-state-unavailable')).toBeVisible();
		await expect(page.getByTestId('install-state-unavailable')).toContainText('Install');
		await expect(page.getByTestId('install-app')).toBeHidden();
	});

	test('becomes a button when the browser offers, and asks the browser rather than nagging', async ({
		page
	}) => {
		await page.goto(site.url);
		await emptyWorkspace(page);
		await page.reload();
		// **Waited for, because the listener is attached in the layout's mount effect** — which runs
		// after `load`, since hydration is a dynamic import. Dispatching before it is attached is a
		// test that measures nothing, and it failed as "the offer never appeared".
		await expect(page.getByTestId('install-state-unavailable')).toBeVisible();

		// The event is synthesised because Chromium's install criteria include engagement heuristics no
		// automated run satisfies. What is under test is this app's handling of it — that the offer is
		// *kept* and shown as a button rather than prompted immediately, which is the "do not nag"
		// half of ADR-0012 — and that is entirely ours.
		await page.evaluate(() => {
			const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
				prompt?: () => Promise<void>;
			};
			const record = { prompted: 0, defaultPrevented: false };
			(window as unknown as { installProbe: typeof record }).installProbe = record;
			event.prompt = () => {
				record.prompted += 1;
				return Promise.resolve();
			};
			window.dispatchEvent(event);
			record.defaultPrevented = event.defaultPrevented;
		});

		const probe = () =>
			page.evaluate(
				() =>
					(window as unknown as { installProbe: { prompted: number; defaultPrevented: boolean } })
						.installProbe
			);

		// Nothing was prompted on arrival: the event was taken and held.
		await expect(page.getByTestId('install-app')).toBeVisible();
		expect((await probe()).defaultPrevented, 'the browser was allowed to prompt unasked').toBe(
			true
		);
		expect((await probe()).prompted).toBe(0);

		// And the button is what asks. Keyboard-operable, like every other control (story 95).
		await page.getByTestId('install-app').focus();
		await page.keyboard.press('Enter');
		await expect.poll(async () => (await probe()).prompted).toBe(1);
		// One offer per event, by specification, so the button goes with it rather than staying to be
		// clicked into a no-op.
		await expect(page.getByTestId('install-app')).toBeHidden();
	});
});

test.describe('an update, and who decides when', () => {
	let site: EditorDeployment;

	test.beforeEach(async () => {
		site = await deployEditor();
	});
	test.afterEach(async () => {
		await site.close();
	});

	/**
	 * Publish a new version and wait until the browser has it installed and waiting.
	 *
	 * `registration.update()` is a browser API called from the test, not an app affordance: what is
	 * under test is what the app does *when* an update appears, and provoking one any other way means
	 * reloading the page — which would destroy the mid-alignment state the interesting assertion is
	 * about.
	 */
	async function publishAndDiscover(page: Page): Promise<void> {
		await publishAndCheck(page);
		await page.waitForFunction(
			async () => (await navigator.serviceWorker.getRegistration())?.waiting !== null,
			undefined,
			{ timeout: INSTALL_MS }
		);
	}

	/**
	 * The same, without waiting for the new worker to *wait*.
	 *
	 * On an uncontrolled page it never will: there is no client using the registration for the
	 * browser to protect, so the new worker activates the moment it has installed. That is the case
	 * the test below is about, and `publishAndDiscover` would time out on it.
	 */
	async function publishAndCheck(page: Page): Promise<void> {
		site.publishNewVersion();
		await page.evaluate(async () => {
			const registration = await navigator.serviceWorker.getRegistration();
			await registration?.update();
		});
	}

	test('the prompt appears, nothing reloads, and the alignment in progress is untouched', async ({
		page
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`));

		await installAndControl(page, site.url);
		await emptyWorkspace(page);
		await page.reload();

		// A Project with a Historical Map and two Control Points, and a third pair half made: this is
		// "mid-alignment" in the most literal sense story 9 has, because the pending half lives only in
		// the page and any reload at all would lose it.
		await startProjectWithMap(page);
		// Mid-alignment now means on the alignment route (ticket 03), which is also the sharper form of
		// this test: an update that reloaded would take the pending half *and* the route with it.
		await page.getByTestId('align-historical-map').click();
		await expect(page.getByTestId('historical-map-tiles')).toHaveAttribute(
			'data-tiles-loaded',
			'true',
			{ timeout: TILES_READY_MS }
		);
		await makePair(page, [0.3, 0.3]);
		await makePair(page, [0.6, 0.35]);
		await clickAt(historicalMap(page), 0.75, 0.6);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');

		// A mark that survives nothing. If the page reloads for any reason, it is gone — which makes it
		// the plainest possible statement of "the update did not reload me".
		await page.evaluate(() => {
			(window as unknown as { ballastellaAlive?: string }).ballastellaAlive = 'the same document';
		});
		const controllerBefore = (await registrationState(page)).controller;
		const focusBefore = await focusedDescription(page);

		await publishAndDiscover(page);

		// The prompt is on screen, and it says so in a live region rather than a dialog: a modal would
		// take focus off the pane the user is clicking in, which is the interruption itself.
		await expect(page.getByTestId('update-prompt')).toBeVisible();
		await expect(page.getByTestId('update-prompt')).toContainText('new version');
		const region = page.getByTestId('update-region');
		await expect(region).toHaveAttribute('aria-live', 'polite');
		await expect(region).toHaveAttribute('aria-atomic', 'true');

		// ─────────────────────────────────────────────────────────────────────────────────────────
		// NOTHING HAPPENED TO THE USER'S WORK.
		expect(
			await page.evaluate(
				() => (window as unknown as { ballastellaAlive?: string }).ballastellaAlive
			),
			'the page reloaded itself when an update arrived'
		).toBe('the same document');
		// The two completed pairs, and the half-made third, exactly as they were.
		await expect(rows(page)).toHaveCount(2);
		await expect(imagePoints(page)).toHaveCount(3);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
		// Focus is exactly where the user left it. A `<dialog>` with `showModal()` would be the
		// idiomatic way to announce this and the wrong one: it moves focus, and moving focus out of the
		// pane somebody is placing a Control Point in *is* the interruption.
		expect(await focusedDescription(page), 'the update prompt took focus').toBe(focusBefore);

		// The old worker is still the one in charge, and the new one is only waiting.
		const state = await registrationState(page);
		expect(state.waiting).toBe('installed');
		expect(state.active).toBe('activated');
		expect(state.controller).toBe(controllerBefore);

		expect(errors, 'the app threw while an update was announced').toEqual([]);
	});

	test('dismissing the prompt leaves the old version serving', async ({ page }) => {
		await installAndControl(page, site.url);
		const before = (await cacheNames(page)).sort();
		expect(before).toHaveLength(2);

		await publishAndDiscover(page);
		await expect(page.getByTestId('update-prompt')).toBeVisible();

		await page.getByTestId('update-dismiss').click();
		await expect(page.getByTestId('update-prompt')).toBeHidden();

		// **The artefact, not the state.** After a reload the page must still be the *old* build's HTML,
		// which is decidable because the newly published entry HTML carries a marker the old one does
		// not. A worker that had activated silently, or a fetch handler that consulted the network for a
		// shell asset, would put the marker on screen here.
		await page.reload();
		await expect(page.getByRole('heading', { name: 'Ballastella Editor' })).toBeVisible();
		expect(
			await page.locator(`meta[name="${NEXT_VERSION_MARKER}"]`).count(),
			'the new version took over without being asked'
		).toBe(0);

		// Both builds' caches exist — the old ones because the old worker is still serving out of them,
		// the new ones because the waiting worker has already filled its own — and the old ones have not
		// been emptied.
		const after = (await cacheNames(page)).sort();
		expect(after).toHaveLength(4);
		for (const name of before)
			expect(after, `${name} was deleted under the old worker`).toContain(name);
		const shell = await cachedUrls(page);
		expect(shell[before[0] as string]?.length, 'the old build’s cache was emptied').toBeGreaterThan(
			0
		);
		const state = await registrationState(page);
		expect(state.waiting, 'a plain reload must not activate a waiting worker').toBe('installed');
	});

	test('the prompt does not come back after it is dismissed', async ({ page }) => {
		await installAndControl(page, site.url);
		await publishAndDiscover(page);
		await page.getByTestId('update-dismiss').click();
		await expect(page.getByTestId('update-prompt')).toBeHidden();

		// A second check finds the same waiting worker. Saying so again would be the nagging ADR-0012
		// rules out, and the user has already answered the question for this document.
		await page.evaluate(async () => {
			const registration = await navigator.serviceWorker.getRegistration();
			await registration?.update();
		});
		await page.waitForTimeout(500);
		await expect(page.getByTestId('update-prompt')).toBeHidden();
	});

	test('the prompt is reachable and operable by keyboard', async ({ page }) => {
		await installAndControl(page, site.url);
		await publishAndDiscover(page);
		await expect(page.getByTestId('update-prompt')).toBeVisible();

		// Both actions are real buttons with accessible names, reachable by tab from the page rather
		// than only clickable. The section is labelled by its heading, so a screen-reader user landing
		// on the button knows what it belongs to.
		const dismiss = page.getByTestId('update-dismiss');
		const reload = page.getByTestId('update-reload');
		await expect(dismiss).toHaveAccessibleName('Not now');
		await expect(reload).toHaveAccessibleName('Reload now');
		await expect(page.getByTestId('update-prompt')).toHaveAccessibleName(
			/new version of Ballastella is ready/
		);

		await reload.focus();
		await expect(reload).toBeFocused();
		await dismiss.focus();
		await expect(dismiss).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('update-prompt')).toBeHidden();
	});

	test('taking the update is what applies it, and only when asked', async ({ page }) => {
		await installAndControl(page, site.url);
		await publishAndDiscover(page);

		await page.getByTestId('update-reload').click();

		// The new build is now what the browser is running, said by the marker in its entry HTML.
		await expect(page.locator(`meta[name="${NEXT_VERSION_MARKER}"]`)).toHaveCount(1, {
			timeout: INSTALL_MS
		});
		await expect(page.getByRole('heading', { name: 'Ballastella Editor' })).toBeVisible();
		await expect(page.getByTestId('update-prompt')).toBeHidden();

		// And the old build's caches are gone — which is `activate` having run, and therefore the new
		// worker genuinely being in charge rather than merely being present. Two caches where a moment
		// ago there were four: a shell half of one build and half of another is the version skew
		// ADR-0010 is about, and the marker above already says *which* build is serving. Deliberately
		// no assertion about how a cache is named: SPEC's Testing Decisions rule out asserting on
		// private structure, and a cache name is this worker's business and nobody else's.
		await expect.poll(() => cacheNames(page), { timeout: INSTALL_MS }).toHaveLength(2);
	});

	test('a version published to a page that no worker controls is still announced', async ({
		page
	}) => {
		// ─────────────────────────────────────────────────────────────────────────────────────────
		// **THE FIRST-EVER VISIT, WHICH IS EVERY USER'S FIRST VISIT.**
		//
		// `installAndControl` is deliberately not used here, and its reload is exactly why: a newly
		// installed worker does not claim the page that installed it, so the first load of this app in
		// a browser stays uncontrolled for its whole life. Every other update test in this file starts
		// from the reload, and so none of them could see what this one is about.
		//
		// The consequence is the sharp end of ADR-0012. An uncontrolled page is not a client of the
		// registration, so a version published during this session has nothing to wait behind: the
		// browser installs it, activates it, and `activate` deletes the caches the previous build
		// filled. Nothing a page can do prevents that — but being told is the whole of story 9, and
		// the guard that asked "is there a waiting worker *and* am I controlled" answered no to both
		// halves here and said nothing at all.
		await page.goto(site.url);
		await waitForReady(page);
		expect(
			await page.evaluate(() => navigator.serviceWorker.controller === null),
			'this page is already controlled, so it is not the case under test'
		).toBe(true);

		await publishAndCheck(page);

		await expect(page.getByTestId('update-prompt')).toBeVisible({ timeout: INSTALL_MS });
		await expect(page.getByTestId('update-prompt')).toContainText('new version');

		// And taking it lands on the new build, said by the marker in its entry HTML.
		await page.getByTestId('update-reload').click();
		await expect(page.locator(`meta[name="${NEXT_VERSION_MARKER}"]`)).toHaveCount(1, {
			timeout: INSTALL_MS
		});
		await expect(page.getByRole('heading', { name: 'Ballastella Editor' })).toBeVisible();
	});

	test('an update the deployment cannot answer for is refused, and the offline shell survives', async ({
		page
	}) => {
		await installAndControl(page, site.url);
		await publishAndDiscover(page);
		await expect(page.getByTestId('update-prompt')).toBeVisible();

		// A mark that survives nothing: if this page reloads at all, it is gone.
		await page.evaluate(() => {
			(window as unknown as { ballastellaAlive?: string }).ballastellaAlive = 'the same document';
		});

		// ─────────────────────────────────────────────────────────────────────────────────────────
		// **THE CONNECTION GOES, AND THE BROWSER DOES NOT NOTICE.**
		//
		// Not `setOffline`, deliberately. That flips `navigator.onLine`, which disables the button, so
		// it drives the case the app can already see coming. This is the other one: a captive portal, a
		// wifi network with no route out, a connection that dropped a moment ago — the browser is
		// certain it is online, the button is enabled, and the user clicks it. Taking the update means
		// dropping the registration and reloading, and if the reload does not arrive the user is left
		// with no worker, no controlled page, and no offline shell: worse off than if they had never
		// been offered it, which is the opposite of what this ticket is for.
		await site.stopServing();
		await page.getByTestId('update-reload').click();

		await expect(page.getByTestId('update-unreachable')).toBeVisible();
		await expect(page.getByTestId('update-prompt')).toBeVisible();
		expect(
			await page.evaluate(
				() => (window as unknown as { ballastellaAlive?: string }).ballastellaAlive
			),
			'the page was reloaded into a deployment that could not answer it'
		).toBe('the same document');

		// **And the shell is still on this computer**, which is the whole reason the registration was
		// not dropped. There is no server left, so this reload can only be served out of the cache.
		await page.reload();
		await expect(page.getByRole('heading', { name: 'Ballastella Editor' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'New Project' })).toBeVisible();
	});
});
