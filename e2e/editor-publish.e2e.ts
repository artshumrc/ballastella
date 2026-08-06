import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { gradientPng } from './support/alignment-workspace.js';
import { serveDirectory, type StaticSite } from './support/static-site.js';

/**
 * The app's own log of tiles it drew. See `apps/editor/src/lib/image-pane/browser-test-handle.ts`.
 *
 * Declared identically to `editor-stored-image-pane.e2e.ts`'s copy, because both augment the same
 * global and TypeScript compares the two structurally.
 */
type ServedTile = {
	paneId: string;
	scaleFactor: number;
	column: number;
	row: number;
	url: string;
	placement: { width: number; height: number };
};

declare global {
	interface Window {
		ballastellaServedTiles?: ServedTile[];
	}
}

/**
 * SPEC's Seam 2 for ticket 16, and the assertion the whole ticket rests on.
 *
 * The file-level behaviour — additive publishing, the recorded file set, the warnings, the canonical
 * stamp — is asserted at Seam 1 in `@ballastella/core`, where the bytes are the assertion. What only
 * a browser can settle is the claim ADR-0006 actually makes: that the folder publishing wrote **is a
 * working website**, from one build, at a domain root *and* in a subdirectory.
 *
 * So these tests do not inspect files and conclude. They publish through the UI, take the Workspace
 * out of OPFS exactly as `git push` would take it off disk, serve it over HTTP at two different base
 * paths, and drive the site in a browser. "The files are present" is a much weaker claim, and it is
 * the one that would pass with every asset referenced as `/_app/…` — which works at a root and 404s
 * on GitHub Pages, where the students are.
 */

/** Empty the origin's OPFS, so no test can see another's Workspace. */
async function emptyWorkspace(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
	});
}

/** Write files straight into OPFS, bypassing the app. */
async function seed(page: Page, files: Record<string, string>): Promise<void> {
	await page.evaluate(async (files) => {
		const root = await navigator.storage.getDirectory();
		for (const [full, text] of Object.entries(files)) {
			const segments = full.split('/');
			let handle = root;
			for (const segment of segments.slice(0, -1)) {
				handle = await handle.getDirectoryHandle(segment, { create: true });
			}
			const file = await handle.getFileHandle(segments[segments.length - 1]!, { create: true });
			const writable = await file.createWritable();
			await writable.write(text);
			await writable.close();
		}
	}, files);
}

/**
 * Every file in the Workspace, base64 encoded, keyed by its path.
 *
 * The reserved temporary suffix is skipped, with or without a further extension. Those are the
 * half-finished atomic writes `ProjectStore#list` never reports and `reclaimAbandonedWrites` removes
 * — garbage by construction, invisible to the app, and not the user's data. Including them would
 * make the byte-identity assertions below fail whenever a publish swept litter an earlier write left,
 * which is a true statement about litter and says nothing about a Project.
 */
async function takeWorkspace(page: Page): Promise<Record<string, string>> {
	return page.evaluate(async () => {
		const files: Record<string, string> = {};
		const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
			for await (const [name, entry] of handle.entries()) {
				if (/\.ballastella-tmp(\.[^./]+)?$/.test(name)) continue;
				if (entry.kind === 'file') {
					const bytes = new Uint8Array(
						await (await (entry as FileSystemFileHandle).getFile()).arrayBuffer()
					);
					let binary = '';
					for (const byte of bytes) binary += String.fromCharCode(byte);
					files[`${prefix}${name}`] = btoa(binary);
				} else {
					await walk(entry as FileSystemDirectoryHandle, `${prefix}${name}/`);
				}
			}
		};
		await walk(await navigator.storage.getDirectory(), '');
		return files;
	});
}

/** The Workspace on disk, as a static host would see it. */
async function writeWorkspaceToDisk(files: Record<string, string>): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'ballastella-published-'));
	for (const [relative, base64] of Object.entries(files)) {
		const file = path.join(directory, relative);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, Buffer.from(base64, 'base64'));
	}
	return directory;
}

/** The site record the Workspace now holds, parsed. */
async function siteRecord(page: Page): Promise<Record<string, unknown>> {
	const taken = await takeWorkspace(page);
	return JSON.parse(Buffer.from(taken['ballastella-site.json']!, 'base64').toString('utf8'));
}

const sha256 = (base64: string) =>
	createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');

/** A Project with a Historical Map, an Alignment, an Annotation Layer, and a pyramid. */
const projectFiles = (
	directory: string,
	fields: { name: string; referenced?: boolean }
): Record<string, string> => ({
	[`${directory}/project.json`]: `${JSON.stringify(
		{
			formatVersion: 1,
			name: fields.name,
			updatedAt: '2026-01-02T03:04:05.000Z',
			layers: [
				{
					id: 'l1',
					name: fields.referenced ? 'Blaeu’s plan, from the library' : 'The 1625 plan',
					visible: true,
					order: 0,
					kind: 'map',
					opacity: 0.8,
					imageId: 'aaa'
				},
				{
					id: 'l2',
					name: 'Warehouses',
					visible: true,
					order: 1,
					kind: 'annotation',
					geojsonRef: 'annotations/l2.geojson',
					defaultStyle: {}
				}
			],
			baseMap: 'physical'
		},
		null,
		'\t'
	)}\n`,
	[`${directory}/annotations/l2.geojson`]: '{"type":"FeatureCollection","features":[]}',
	// At the Workspace root, shared by every Project (ADR-0023) — so these paths carry no Project name and
	// are written once however many Projects the fixture lays down.
	'alignments/aaa.json': '{"type":"Annotation","id":"aaa"}',
	...(fields.referenced
		? {
				// A referenced Historical Map has no `info.json` of ours: `remote.json` beside a missing one is
				// what says the tiles are on a Library's server (ADR-0023), and nothing in `project.json` does.
				'images/aaa/remote.json': `${JSON.stringify(
					{
						service: 'https://tile.loc.gov/image-services/iiif/service:gmd:sheet',
						label: 'Blaeu’s plan, from the library',
						partOf: '',
						canvas: '',
						rights: '',
						attribution: '',
						width: 1024,
						height: 768
					},
					null,
					'\t'
				)}\n`
			}
		: {
				'images/aaa/info.json': `${JSON.stringify(
					{
						'@context': 'http://iiif.io/api/image/3/context.json',
						id: 'https://unset.invalid/aaa',
						type: 'ImageService3',
						protocol: 'http://iiif.io/api/image',
						profile: 'level0',
						width: 1024,
						height: 768,
						tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4] }]
					},
					null,
					'\t'
				)}\n`,
				'images/aaa/0,0,256,256/256,256/0/default.jpg': 'stands in for a tile'
			})
});

/** Open the editor on an empty Workspace holding exactly `files`. */
async function openWorkspace(page: Page, files: Record<string, string>): Promise<void> {
	await page.goto('./');
	await emptyWorkspace(page);
	await seed(page, files);
	await page.reload();
	await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
}

/** Open the Publish dialog and wait for the plan it computed. */
async function openPublishDialog(page: Page) {
	await page.getByRole('button', { name: 'Publish…' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByText('read-only viewer')).toBeVisible();
	return dialog;
}

/**
 * Publish, and wait for the announced result.
 *
 * The Base Map checkbox is set explicitly rather than left alone, because the dialog remembers the
 * last answer within a session — so a second publish in one test inherits the first one's choice.
 */
async function publish(page: Page, options: { baseMap?: boolean; canonicalUrl?: string } = {}) {
	const dialog = await openPublishDialog(page);
	const wanted = options.baseMap === true;
	const includeBaseMap = dialog.getByRole('checkbox');
	if (wanted) await includeBaseMap.check();
	else await includeBaseMap.uncheck();
	// The stated size follows the answer, so waiting for it is waiting for the re-planned figure the
	// button is about to act on rather than for a timeout.
	const stated = dialog.locator('[data-warning="base-map-size"]');
	if (wanted) await expect(stated).toBeVisible();
	else await expect(stated).toBeHidden();
	if (options.canonicalUrl) {
		await dialog.getByLabel(/Address your Historical Maps/).fill(options.canonicalUrl);
	}
	await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
	// Generous, because publishing fetches every file of the bundle and writes it into OPFS: real work,
	// and the suite runs four workers each driving a real map against the same origin's storage. The
	// default 5 s here is a measurement of the machine rather than of publishing.
	await expect(page.getByTestId('publish-status')).toContainText('Published:', { timeout: 30_000 });
}

test.describe('publishing a Workspace', () => {
	let sites: StaticSite[] = [];
	let directories: string[] = [];

	test.afterEach(async () => {
		await Promise.all(sites.map((site) => site.close()));
		await Promise.all(
			directories.map((directory) => rm(directory, { recursive: true, force: true }))
		);
		sites = [];
		directories = [];
	});

	/** Publish, take the Workspace out of OPFS, and serve it at a root and at a subdirectory. */
	async function servePublished(page: Page): Promise<{ root: StaticSite; subpath: StaticSite }> {
		const taken = await takeWorkspace(page);
		const directory = await writeWorkspaceToDisk(taken);
		directories.push(directory);
		// The **same directory** behind both, so this cannot accidentally become a test of two builds.
		const root = await serveDirectory(directory, '');
		const subpath = await serveDirectory(directory, '/student/atlas-2026');
		sites.push(root, subpath);
		return { root, subpath };
	}

	test('serves a working site from a domain root and from a subdirectory, from one build', async ({
		page
	}) => {
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));
		await publish(page);

		const { root, subpath } = await servePublished(page);

		for (const site of [root, subpath]) {
			const failures: string[] = [];
			page.on('pageerror', (error) => failures.push(error.message));

			await page.goto(site.url);

			// The hub, and the Project on it. Rendered by the viewer's own JavaScript, which means the
			// bundle was found, parsed, and run — none of which a file listing can tell you.
			await expect(
				page.getByRole('heading', { level: 1, name: 'Published Projects' })
			).toBeVisible();
			await expect(page.getByTestId('published-projects')).toContainText('Amsterdam 1625');

			// `?p=` opens one, reached by clicking the link the hub rendered rather than by a URL this
			// test composed — so the link is relative in the way the base path needs.
			await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
			await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
			await expect(page).toHaveURL(`${site.url}?p=amsterdam-1625`);

			// The Project's own data was read over HTTP, relative to the site: the Layer names come out
			// of `amsterdam-1625/project.json`.
			//
			// `reader-layers` rather than ticket 16's `project-layers`: that was a static list of what the
			// Project contained, and ticket 17 replaced it with the Reader's own Layer controls over the same
			// data. The claim this test makes is unchanged — those names could only have come from
			// `project.json`, fetched relative to this document — so it moves to the element that now carries
			// them rather than being weakened.
			await expect(page.getByTestId('reader-layers')).toContainText('The 1625 plan');
			await expect(page.getByTestId('reader-layers')).toContainText('Warehouses');
			// And the Base Map the author chose is the one shown first, resolved against the catalog that
			// travelled with the site rather than against this build's (ADR-0020, SPEC story 69). The
			// switcher's *selected* value, since ticket 17 made the choice a Reader's to change.
			await expect(page.getByTestId('base-map-switcher')).toHaveValue('physical');
			await expect(
				page.getByTestId('base-map-switcher').locator('option[value="physical"]')
			).toHaveText('Physical geography');

			// Nothing 404'd. This is the assertion that fails when an asset is referenced as `/_app/…`:
			// it is answered at a domain root and is outside the published folder in a subdirectory,
			// which is the GitHub Pages case ADR-0006 exists for.
			expect(site.failures).toEqual([]);
			expect(failures).toEqual([]);
			// Every request stayed inside the published folder, so nothing reached for the host's root —
			// the stronger form of the same claim, since a host answering `/favicon.ico` with a page
			// would otherwise hide it.
			expect(site.requests.filter((asked) => !asked.startsWith(`${site.prefix}/`))).toEqual([]);
			// And the subdirectory case really was a subdirectory rather than a second root.
			expect(site.requests.some((asked) => asked !== `${site.prefix}/`)).toBe(true);
			page.removeAllListeners('pageerror');
		}
	});

	test('references every asset relatively, asserted on the bytes that were written', async ({
		page
	}) => {
		// The served assertion above is the real one. This is the ADR-0006 fence applied to the *user's
		// folder* rather than to our build output — the case the CI fence deliberately does not cover,
		// because it greps `apps/*/build` and the thing that ships to a Reader is this.
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));
		await publish(page, { baseMap: true });

		const taken = await takeWorkspace(page);
		const offenders: string[] = [];
		const inspected: string[] = [];
		for (const [relative, base64] of Object.entries(taken)) {
			if (!/\.(html|css|js|json)$/.test(relative)) continue;
			inspected.push(relative);
			const text = Buffer.from(base64, 'base64').toString('utf8');
			for (const match of text.matchAll(/(?:src|href)="\/[^"]*"/g)) {
				offenders.push(`${relative}: ${match[0]}`);
			}
		}

		expect(offenders).toEqual([]);
		// The whole tree, not the three files that happen to sit at the root. An earlier version of
		// this skipped everything with a `/` in its path, which is `_app/immutable/**` — the entire
		// viewer — and all of `base-map/`: the criterion's own verification command is
		// `grep -rEo '(src|href)="/[^"]*"'` over the published Workspace, and `-r` is the point.
		expect(inspected).toContain('index.html');
		expect(inspected.filter((relative) => relative.startsWith('_app/')).length).toBeGreaterThan(5);
		expect(inspected.some((relative) => relative.startsWith('base-map/'))).toBe(true);
	});

	test('adds the site to the Workspace and copies no Project data', async ({ page }) => {
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));
		const before = await takeWorkspace(page);

		await publish(page, { baseMap: true });

		const after = await takeWorkspace(page);
		// Every Project file, byte for byte, hashed rather than compared by length.
		const hashes = (files: Record<string, string>) =>
			Object.fromEntries(
				Object.entries(files)
					.filter(
						([relative]) =>
							relative.startsWith('amsterdam-1625/') ||
							relative.startsWith('images/') ||
							relative.startsWith('alignments/')
					)
					.map(([relative, base64]) => [relative, sha256(base64)])
			);
		expect(hashes(after)).toEqual(hashes(before));

		// No pyramid was duplicated: the tile exists exactly once in the whole Workspace.
		const tile = sha256(before['images/aaa/0,0,256,256/256,256/0/default.jpg']!);
		expect(Object.values(after).filter((base64) => sha256(base64) === tile)).toHaveLength(1);
	});

	test('states the Base Map’s size before adding it, and adds those files only when asked', async ({
		page
	}) => {
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));

		const dialog = await openPublishDialog(page);
		// SPEC story 89: the figure is on screen *before* the button is pressed, and it is real megabytes
		// rather than a placeholder.
		await expect(dialog.locator('[data-warning="base-map-size"]')).toContainText(/[0-9.]+ MB/);
		await dialog.getByRole('checkbox').uncheck();
		await expect(dialog.locator('[data-warning="base-map-size"]')).toBeHidden();
		await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
		await expect(page.getByTestId('publish-status')).toContainText('Published:', {
			timeout: 30_000
		});

		expect(
			Object.keys(await takeWorkspace(page)).filter((path) => path.startsWith('base-map/'))
		).toEqual([]);
		// A site with the Base Map left out still says so in its own record, which is what ticket 17's
		// switcher has to read to know whether an offline Base Map is there at all (ADR-0020).
		expect(await siteRecord(page)).toMatchObject({ baseMapBundled: false });

		await publish(page, { baseMap: true });

		const withBaseMap = Object.keys(await takeWorkspace(page)).filter((path) =>
			path.startsWith('base-map/')
		);
		expect(withBaseMap.length).toBeGreaterThan(1);
		expect(withBaseMap.some((path) => path.endsWith('.pmtiles'))).toBe(true);
	});

	test('removes a Base Map it published before, when the next publish leaves it out', async ({
		page
	}) => {
		// The order the folder gets wrong. Publishing only ever wrote, so ~5 MB of `base-map/` stayed in
		// the Workspace while the record written beside it said the site carried no Base Map at all —
		// the folder and the site's own account of itself disagreeing, in a folder the user is about to
		// push. The other order is covered above; this is the one that leaves litter.
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));
		await publish(page, { baseMap: true });

		const bundled = await takeWorkspace(page);
		expect(
			Object.keys(bundled).filter((path) => path.startsWith('base-map/')).length
		).toBeGreaterThan(1);

		await publish(page);

		const after = await takeWorkspace(page);
		expect(Object.keys(after).filter((path) => path.startsWith('base-map/'))).toEqual([]);
		expect(await siteRecord(page)).toMatchObject({ baseMapBundled: false });
		// The site is still whole: the sweep only ever reaches the paths publishing records.
		expect(Object.keys(after)).toContain('index.html');
		// And it never reaches a Project. Every Project file is byte-identical across the republish.
		const hashes = (files: Record<string, string>) =>
			Object.fromEntries(
				Object.entries(files)
					.filter(([relative]) => relative.startsWith('amsterdam-1625/'))
					.map(([relative, base64]) => [relative, sha256(base64)])
			);
		expect(hashes(after)).toEqual(hashes(bundled));
	});

	test('refuses a mistyped address before it writes a thing, which is what its refusal claims', async ({
		page
	}) => {
		// `scholar.example` — no scheme — is how a user ordinarily arrives here, the placeholder being
		// the only hint. Core's refusal ends "Nothing has been changed.", so the address has to be
		// settled *before* the site is written rather than after: the failure this guards is the whole
		// Workspace gaining a website and the user being told, in the same breath, that it did not.
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));
		const before = await takeWorkspace(page);

		const dialog = await openPublishDialog(page);
		await dialog.getByRole('checkbox').uncheck();
		await dialog.getByLabel(/Address your Historical Maps/).fill('scholar.example');
		await dialog.getByRole('button', { name: 'Publish', exact: true }).click();

		const refusal = dialog.getByRole('alert');
		await expect(refusal).toContainText('scholar.example');
		await expect(refusal).toContainText('https://');
		await expect(refusal).toContainText('Nothing has been changed.');

		// The sentence, checked against the folder rather than taken on trust.
		expect(await takeWorkspace(page)).toEqual(before);
		// And nothing was announced as published, because nothing was.
		await expect(page.getByTestId('publish-status')).toHaveText('');
	});

	test('announces progress from inside the modal, where the document is not inert', async ({
		page
	}) => {
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));
		const dialog = await openPublishDialog(page);
		await dialog.getByRole('checkbox').uncheck();

		// `showModal()` makes every node outside the open `<dialog>` inert, and an inert live region is
		// not a quiet one — it is never announced. So *where* the region sits is the accessibility
		// claim, and its attributes are not: a correct `aria-live="polite"` outside the modal announces
		// nothing while the modal is open. Asked here the way the browser decides it.
		expect(
			await page.evaluate(() => {
				const modal = document.querySelector('dialog[open]');
				const region = (testid: string) => {
					const element = document.querySelector(`[data-testid="${testid}"]`);
					if (element === null || modal === null) return 'missing';
					return {
						insideTheModal: modal.contains(element),
						live: element.getAttribute('aria-live'),
						atomic: element.getAttribute('aria-atomic')
					};
				};
				return { progress: region('publish-progress'), result: region('publish-status') };
			})
		).toEqual({
			progress: { insideTheModal: true, live: 'polite', atomic: 'true' },
			// The result is outside on purpose: by the time it has anything to say the dialog has closed,
			// and it stays on screen afterwards. The two never speak at once.
			result: { insideTheModal: false, live: 'polite', atomic: 'true' }
		});

		// Slow the viewer's own files down, so the progress line is on screen long enough to assert
		// rather than long enough to be lucky. Publishing fetches each one from the editor's deployment.
		await page.route('**/viewer-bundle/**', async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 200));
			await route.continue();
		});
		await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
		await expect(dialog.getByTestId('publish-progress')).toContainText(
			/Publishing: \d+ of \d+ files\./
		);

		await expect(page.getByTestId('publish-status')).toContainText('Published:', {
			timeout: 60_000
		});
		// One region speaks at a time: the progress line is emptied rather than left holding a sentence
		// a screen reader would read out again on the next publish.
		await expect(page.getByTestId('publish-progress')).toHaveText('');
	});

	test('warns that a referenced Historical Map leaves a Reader with no network seeing nothing', async ({
		page
	}) => {
		await openWorkspace(
			page,
			projectFiles('amsterdam-1625', { name: 'Amsterdam 1625', referenced: true })
		);

		const dialog = await openPublishDialog(page);

		const warning = dialog.locator('[data-warning="referenced-images"]');
		await expect(warning).toContainText('Blaeu’s plan, from the library');
		await expect(warning).toContainText('no network');
		// And the Reader is told too, on the site itself (SPEC story 29).
		await dialog.getByRole('checkbox').uncheck();
		await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
		await expect(page.getByTestId('publish-status')).toContainText('Published:', {
			timeout: 30_000
		});

		const { root } = await servePublished(page);
		await page.goto(`${root.url}?p=amsterdam-1625`);

		await expect(page.getByTestId('project-needs-network')).toContainText('Blaeu’s plan');
		// **One expected 404, and it is named rather than filtered out of the way.** A published site has no
		// directory listing, so the viewer asks whether a Historical Map has an `info.json` of its own and
		// reads the answer off the status (ADR-0023) — a referenced map has none, and that is how the site
		// learns its tiles are on a Library's server. Every *other* failed request is still fatal here.
		expect(root.failures).toEqual([{ path: `/images/${'aaa'}/info.json`, status: 404 }]);
	});

	test('names the hosting limit when the Workspace is about to cross it', async ({ page }) => {
		// Just under the 1 GB budget, so that the site's own bytes take it over. Written as one sparse
		// file rather than as a real gigabyte: `ProjectStore#size` reports its length without reading it,
		// which is the whole reason the warning can be computed at all (ADR-0001, ADR-0008).
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));
		await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			// At the Workspace root: the ~1 GB budget is the Workspace's, shared by every Project that
			// publishes together (ADR-0008, ADR-0023).
			const images = await (await root.getDirectoryHandle('images')).getDirectoryHandle('aaa');
			const handle = await images.getFileHandle('huge.jpg', { create: true });
			const writable = await handle.createWritable();
			await writable.write({ type: 'truncate', size: 999_000_000 });
			await writable.close();
		});

		const dialog = await openPublishDialog(page);

		const warning = dialog.locator('[data-warning="hosting-limit"]');
		await expect(warning).toContainText('1.0 GB');
		await expect(warning).toContainText('GitHub Pages');
	});

	test('extends the hub page on a second publish and leaves the first Project untouched', async ({
		page
	}) => {
		// The semester-long, one-repository workflow (SPEC story 81).
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));
		await publish(page);
		const firstProject = await takeWorkspace(page);

		await seed(page, projectFiles('boston-1775', { name: 'Boston 1775' }));
		await page.reload();
		await expect(page.getByRole('link', { name: 'Boston 1775' })).toBeVisible();
		await publish(page);

		// Read out **before** navigating to the served site: OPFS is per-origin, and the site is served
		// from a port of its own, so a `takeWorkspace` after the `goto` reads an empty Workspace and every
		// byte-identity assertion below passes vacuously. That is exactly how this test first passed.
		const after = await takeWorkspace(page);
		// The first Project's own files **and** the shared Historical Map it draws (ADR-0023). Scoped to
		// `amsterdam-1625/` alone this would be two files — `project.json` and one GeoJSON — and the claim
		// "publishing wrote nothing of the user's" would stop covering the pyramid, which is most of it.
		const amsterdam = Object.keys(firstProject).filter(
			(path) =>
				path.startsWith('amsterdam-1625/') ||
				path.startsWith('images/') ||
				path.startsWith('alignments/')
		);
		expect(amsterdam.length).toBeGreaterThan(3);
		for (const relative of amsterdam) {
			expect(sha256(after[relative]!), relative).toBe(sha256(firstProject[relative]!));
		}

		const { subpath } = await servePublished(page);
		await page.goto(subpath.url);

		await expect(page.getByTestId('published-projects')).toContainText('Amsterdam 1625');
		await expect(page.getByTestId('published-projects')).toContainText('Boston 1775');
		expect(subpath.failures).toEqual([]);
	});

	test('refreshes a version stamp that has gone stale, and says so before it is refreshed', async ({
		page
	}) => {
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));
		await publish(page);
		const stamped = JSON.parse(
			Buffer.from((await takeWorkspace(page))['ballastella-site.json']!, 'base64').toString('utf8')
		);
		expect(stamped.viewerVersion).toMatch(/^[0-9a-f]{16}$/);

		// A Workspace published by an older build of the editor, which is what a re-publish is for.
		await seed(page, {
			'ballastella-site.json': JSON.stringify({ ...stamped, viewerVersion: 'an-older-viewer' })
		});
		await page.reload();
		await page.getByRole('button', { name: 'Publish…' }).click();
		await expect(page.getByRole('dialog').getByText('read-only viewer')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('publish-stale')).toContainText('an older version of the viewer');

		await publish(page);

		const refreshed = JSON.parse(
			Buffer.from((await takeWorkspace(page))['ballastella-site.json']!, 'base64').toString('utf8')
		);
		expect(refreshed.viewerVersion).toBe(stamped.viewerVersion);
		await expect(page.getByTestId('publish-stale')).toBeHidden();
	});

	test('renders a Project’s name as text, never as markup, on the published site', async ({
		page
	}) => {
		// The display name comes out of a `project.json` and is untrusted content, and a Published Site
		// runs on the author's own domain — so a name rendered as HTML there is stored XSS on
		// `student.github.io` (ADR-0009). Ticket 10 established the discipline this inherits, including
		// the part that matters most: **assert the real prose is on the page first**, because a blank
		// surface passes every "nothing dangerous survived" check.
		const payload =
			'Amsterdam <img src=x onerror="window.pwned=1"> 1625<script>window.pwned=1</script>';
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: payload }));
		await publish(page);

		const { root } = await servePublished(page);
		const failures: string[] = [];
		page.on('pageerror', (error) => failures.push(error.message));
		await page.goto(root.url);

		const list = page.getByTestId('published-projects');
		// The text is there, in full, including the parts that look like markup.
		await expect(list).toContainText(payload);
		expect(
			await page.evaluate(() => {
				const host = document.querySelector('[data-testid="published-projects"]');
				const handlers: string[] = [];
				for (const element of host?.querySelectorAll('*') ?? []) {
					for (const attribute of element.attributes) {
						if (attribute.name.toLowerCase().startsWith('on')) handlers.push(attribute.name);
					}
				}
				return {
					images: host?.querySelectorAll('img').length ?? -1,
					scripts: host?.querySelectorAll('script').length ?? -1,
					handlers,
					pwned: 'pwned' in window
				};
			})
		).toEqual({ images: 0, scripts: 0, handlers: [], pwned: false });
		expect(failures).toEqual([]);
		page.removeAllListeners('pageerror');
	});

	test('stamps every info.json id with the canonical address, and the editor still opens it', async ({
		page
	}) => {
		// Driven against a **real ingested pyramid** rather than a seeded stub, because the assertion
		// that matters is not what the file says: it is that the editor still draws the map after its
		// `info.json` has been rewritten to point at somebody else's address. `info.json`'s `id` is what
		// `@allmaps/iiif-parser` concatenates every tile URL onto, so a stamp the load-time override did
		// not beat would send every tile to `scholar.example` and leave the pane blank (ADR-0004).
		await page.addInitScript(() => {
			window.ballastellaServedTiles = [];
		});
		await page.goto('./');
		await emptyWorkspace(page);
		await page.reload();
		await page.getByRole('button', { name: 'New Project' }).click();
		const created = page.getByRole('dialog', { name: 'New Project' });
		await created.getByLabel('Project name').fill('Amsterdam 1625');
		await created.getByRole('button', { name: 'Create' }).click();
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();
		await page.getByLabel('Add a Historical Map from a file').setInputFiles({
			name: 'amsterdam.png',
			mimeType: 'image/png',
			buffer: gradientPng(600, 400)
		});
		await expect(page.getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
		const imageId = (await page.getByRole('listitem').first().innerText()).trim();
		// The pane that reads through the shim is the `/align/` route since ticket 03, so this is where
		// `ballastellaServedTiles` is filled from.
		await page.getByTestId('align-historical-map').click();
		await expect
			.poll(() => page.evaluate(() => (window.ballastellaServedTiles ?? []).length), {
				timeout: 30_000
			})
			.toBeGreaterThan(0);

		await page.goto('./');
		await publish(page, { canonicalUrl: 'https://scholar.example/atlas/' });
		await expect(page.getByTestId('publish-status')).toContainText(
			'stamped for https://scholar.example/atlas'
		);

		const taken = await takeWorkspace(page);
		const info = JSON.parse(
			Buffer.from(taken[`images/${imageId}/info.json`]!, 'base64').toString('utf8')
		);
		// **No Project directory in the address** (ADR-0023). A Historical Map is shared, so it answers at
		// one citable endpoint however many Projects draw it — and a stamp naming one of them would 404 for
		// every tile the moment that Project was renamed or deleted.
		expect(info.id).toBe(`https://scholar.example/atlas/images/${imageId}`);
		// Every other field of the document survived the stamp, so the pyramid is still describable.
		expect(info).toMatchObject({
			type: 'ImageService3',
			profile: 'level0',
			width: 600,
			height: 400
		});
		// The Project still records the address it was stamped for, so a later publish can offer it back.
		const projectFile = Object.keys(taken).find((path) => path.endsWith('/project.json'))!;
		expect(
			JSON.parse(Buffer.from(taken[projectFile]!, 'base64').toString('utf8')).canonicalUrl
		).toBe('https://scholar.example/atlas');

		// Load-time override wins (ADR-0004): the stamped Project still opens here, and the pane still
		// draws out of the store. `ballastellaServedTiles` is the decisive form of that — a pyramid read
		// from OPFS issues no request at all, so every entry in it is a tile the injection shim answered
		// at the placeholder host, which no blank canvas and no fallback to the network could produce.
		const requested: string[] = [];
		page.on('request', (request) => requested.push(request.url()));
		await page.reload();
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();
		await page.getByTestId('align-historical-map').click();
		await expect
			.poll(() => page.evaluate(() => (window.ballastellaServedTiles ?? []).length), {
				timeout: 30_000
			})
			.toBeGreaterThan(0);

		const served = await page.evaluate(() => window.ballastellaServedTiles ?? []);
		for (const tile of served) {
			expect(tile.url.startsWith(`https://unset.invalid/${imageId}/`), tile.url).toBe(true);
		}
		expect(requested.filter((url) => url.startsWith('https://scholar.example'))).toEqual([]);
		page.removeAllListeners('request');
	});

	test('is reachable and operable from the keyboard, with progress announced', async ({ page }) => {
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));

		// Reached by tabbing rather than by clicking (SPEC story 95).
		const publishButton = page.getByRole('button', { name: 'Publish…' });
		await page.getByRole('button', { name: 'Import Project…' }).focus();
		await page.keyboard.press('Tab');
		await expect(publishButton).toBeFocused();
		await page.keyboard.press('Enter');

		const dialog = page.getByRole('dialog');
		await expect(dialog.getByText('read-only viewer')).toBeVisible();
		// ADR-0016's mandated `<dialog>` + `showModal()`: Escape closes it and focus comes back.
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(publishButton).toBeFocused();

		await page.keyboard.press('Enter');
		await expect(dialog.getByText('read-only viewer')).toBeVisible();
		await dialog.getByRole('checkbox').uncheck();
		await dialog.getByRole('button', { name: 'Publish', exact: true }).press('Enter');

		// The outcome is announced rather than only drawn (SPEC story 96).
		const status = page.getByTestId('publish-status');
		await expect(status).toContainText('Published:', { timeout: 30_000 });
		await expect(status).toContainText('1 Project');
		// A live region rather than `role="status"`, because the hub's transfer region already holds that
		// role and two of them make it ambiguous — for a screen reader as much as for a locator.
		expect(
			await status.evaluate((element) => [
				element.getAttribute('aria-live'),
				element.getAttribute('aria-atomic')
			])
		).toEqual(['polite', 'true']);
	});
});
