import { expect, test } from './support/test.js';
import { type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { gradientPng } from './support/alignment-workspace.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	GITHUB_API_ORIGIN,
	routeGitHubHosts,
	type GitHubHosts,
	type GitHubHostsOptions
} from './support/github-hosts.js';
import { addHistoricalMapButton, pickHistoricalMapFile } from './support/historical-maps.js';
import { alignFromLayer } from './support/layers.js';
import { projectNameField } from './support/project-screen.js';
import { serveDirectory, type StaticSite } from './support/static-site.js';
import { createWorkspace } from './support/workspace.js';

test.beforeEach(async ({ page }) => routeBaseMapArchive(page));

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
		// The whole of browser storage, which since ticket 12 is **every named Workspace** rather than
		// one — so no test can see another's, whichever Workspace it was in.
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

/** Write files straight into OPFS, bypassing the app. */
async function seed(page: Page, files: Record<string, string>): Promise<void> {
	await page.evaluate(async (files) => {
		const root = await workspaceRoot();
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
		await walk(await workspaceRoot(), '');
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
	fields: { name: string; referenced?: boolean; onFrontPage?: boolean }
): Record<string, string> => ({
	[`${directory}/project.json`]: `${JSON.stringify(
		{
			formatVersion: 1,
			name: fields.name,
			updatedAt: '2026-01-02T03:04:05.000Z',
			// Left out unless a test asks for it, which is the shape every `project.json` written before
			// ADR-0032 has and the shape that means "on the front page".
			...(fields.onFrontPage === undefined ? {} : { onFrontPage: fields.onFrontPage }),
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
	// alignment-write-is-the-fixture: the Workspace this spec publishes from, laid down before the app starts
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

	/**
	 * **This suite's editor is on `localhost`, so nothing it publishes records an instance** (ticket
	 * 09).
	 *
	 * The editor stamps its own origin so a site's Front Page can lead a Reader back to it, and an
	 * address only the publishing machine can reach is refused rather than recorded — a Reader
	 * following `http://localhost:5173/` arrives at whatever is on *their* port 5173. A dev server is
	 * exactly that case, and so is this one.
	 *
	 * Which is why every site below carries no return link and asks for no `remote.json`: the binding
	 * that would name the repository is only worth a round trip when there is an instance to link to.
	 */
	async function expectNoReturnLink(page: Page, site: StaticSite): Promise<void> {
		await expect(page.getByRole('link', { name: /in Ballastella$/ })).toHaveCount(0);
		expect(site.requests.filter((asked) => asked.endsWith('/remote.json'))).toEqual([]);
	}

	test('serves a working site from a domain root and from a subdirectory, from one build', async ({
		page
	}) => {
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));
		await publish(page);

		// Read on the editor, before this page leaves for the site: this suite's editor is served from
		// `localhost`, and an address only the publishing machine can reach is refused rather than
		// recorded. See `expectNoReturnLink` above.
		expect((await siteRecord(page)).editorUrl).toBe('');

		const { root, subpath } = await servePublished(page);

		for (const site of [root, subpath]) {
			const failures: string[] = [];
			page.on('pageerror', (error) => failures.push(error.message));

			await page.goto(site.url);

			// The hub, and the Project on it. Rendered by the viewer's own JavaScript, which means the
			// bundle was found, parsed, and run — none of which a file listing can tell you.
			await expect(page.getByRole('heading', { level: 1, name: 'Front Page' })).toBeVisible();
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
			).toHaveText('Physical geography — needs network');

			// Nothing 404'd. This is the assertion that fails when an asset is referenced as `/_app/…`:
			// it is answered at a domain root and is outside the published folder in a subdirectory,
			// which is the GitHub Pages case ADR-0006 exists for.
			expect(site.failures).toEqual([]);
			expect(failures).toEqual([]);
			await expectNoReturnLink(page, site);
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

	/**
	 * ⚠ **Two different numbers, and the dialog has to say both** (ADR-0032).
	 *
	 * `PublishPlan.projects` is every Project the site will carry, listed or not, so reporting its
	 * length as what the site "will list" describes a Front Page the author did not ask for — and the
	 * announcement afterwards repeats the same count from the record. Both sentences are asserted here
	 * because they are two strings, built from two objects, saying one fact.
	 */
	test('says how many Projects the site carries and how many its front page lists', async ({
		page
	}) => {
		await openWorkspace(page, {
			...projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }),
			...projectFiles('boston-1775', { name: 'Boston 1775', onFrontPage: false })
		});

		const dialog = await openPublishDialog(page);
		await expect(dialog.getByTestId('publish-projects')).toContainText(
			'The site will carry 2 Projects, 1 of them on the front page.'
		);

		await dialog.getByRole('checkbox').uncheck();
		await expect(dialog.locator('[data-warning="base-map-size"]')).toBeHidden();
		await dialog.getByRole('button', { name: 'Publish', exact: true }).click();

		await expect(page.getByTestId('publish-status')).toContainText(
			'carrying 2 Projects, 1 of them on the front page.',
			{ timeout: 30_000 }
		);
	});

	test('states the Base Map’s size before adding it, and adds those files only when asked', async ({
		page
	}) => {
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));

		const dialog = await openPublishDialog(page);
		// The display assets' size is on screen before publishing spends it.
		await expect(dialog.locator('[data-warning="base-map-size"]')).toContainText(/[0-9.]+ (kB|MB)/);
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
		expect(withBaseMap.some((path) => path.endsWith('.pmtiles'))).toBe(false);
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

	/**
	 * Which `baseMapAssetsBundled: false` means the author said no, and which means nobody was asked.
	 *
	 * ⚠ **That field says what was *written***, and a deployment with no Base Map archive writes
	 * `false` whatever the box said. Read back as the answer, a site first published from such a
	 * deployment comes back unticked forever — on every deployment that does have the archive, with no
	 * place names on its geography and nothing on screen saying why. So the record carries the answer
	 * beside what came of it, and it is the answer that is offered back.
	 */
	test('offers the Base Map answer back, not what the last deployment managed to write', async ({
		page
	}) => {
		const publishedSite = (fields: Record<string, unknown>) => ({
			'ballastella-site.json': `${JSON.stringify(
				{
					formatVersion: 2,
					viewerVersion: 'whatever',
					publishedAt: '2026-01-01T00:00:00.000Z',
					projects: [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }],
					baseMapBundled: false,
					...fields
				},
				null,
				'\t'
			)}\n`
		});

		// Asked for and not written, which is what a deployment with no Base Map archive records. The
		// labels are offered again here, where there is an archive to write them from.
		await openWorkspace(page, {
			...projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }),
			...publishedSite({ baseMapAssetsBundled: false, baseMapAssetsRequested: true })
		});
		await expect((await openPublishDialog(page)).getByRole('checkbox')).toBeChecked();
		await page.keyboard.press('Escape');

		// And an author who said no is not asked again: a box that reverted to "on" would re-add five
		// megabytes to their site every time they published a typo fix.
		await openWorkspace(page, {
			...projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }),
			...publishedSite({ baseMapAssetsBundled: false, baseMapAssetsRequested: false })
		});
		await expect((await openPublishDialog(page)).getByRole('checkbox')).not.toBeChecked();
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
		// **Sparse on the disk, but not free of the browser's storage quota.** A `truncate` is charged
		// at its full length against the origin's quota, and Chromium derives that quota from the free
		// space on the filesystem holding the browser profile — so this one test has a precondition no
		// other test in the suite has: ~1 GB of quota must be available to it. On CI it once was not,
		// and the failure read as a bare `QuotaExceededError` from this `evaluate` with no hint that
		// the environment rather than the app was short. So the shortfall is named here, with the two
		// numbers needed to act on it.
		const quota = await page.evaluate(async () => {
			try {
				const root = await workspaceRoot();
				// At the Workspace root: the ~1 GB budget is the Workspace's, shared by every Project that
				// publishes together (ADR-0008, ADR-0023).
				const images = await (await root.getDirectoryHandle('images')).getDirectoryHandle('aaa');
				const handle = await images.getFileHandle('huge.jpg', { create: true });
				const writable = await handle.createWritable();
				await writable.write({ type: 'truncate', size: 999_000_000 });
				await writable.close();
				return null;
			} catch (error) {
				if (!(error instanceof DOMException && error.name === 'QuotaExceededError')) throw error;
				return await navigator.storage.estimate();
			}
		});
		expect(
			quota,
			'this test needs ~1 GB of browser storage quota to stand a Workspace up at the ADR-0008 ' +
				'cliff, and the browser refused the write. Chromium sizes the quota from the free space on ' +
				'the filesystem holding its profile — which is the temporary directory, so check that ' +
				'`TMPDIR` points somewhere with room. Quota the browser reported: ' +
				JSON.stringify(quota)
		).toBeNull();

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
		await expect(addHistoricalMapButton(page)).toBeVisible();
		await pickHistoricalMapFile(page, {
			name: 'amsterdam.png',
			mimeType: 'image/png',
			buffer: gradientPng(600, 400)
		});
		// The image id off the Layer the map arrived with (ADR-0023, ticket 04): the Project's list of
		// image ids is gone, because the Layer already says which image it draws.
		const row = page.getByTestId('layer-row').first();
		await expect(row).toBeVisible({ timeout: 30_000 });
		const imageId = (await row.getAttribute('data-image-id'))!;
		// The pane that reads through the shim is the `/align/` route since ticket 03, so this is where
		// `ballastellaServedTiles` is filled from. Reached by opening the Layer, which is where the Align
		// link lives since ticket 05.
		await alignFromLayer(page, row);
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
		await expect(addHistoricalMapButton(page)).toBeVisible();
		await alignFromLayer(page);
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

		// Reached by tabbing rather than by clicking (SPEC story 95). From the theme toggle, which is
		// the control before it on the bar since ticket 04 moved Publish there — `UndoControl` sits
		// between them and renders nothing at all when there is nothing to undo, which is the state a
		// freshly seeded Workspace is in.
		const publishButton = page.getByRole('button', { name: 'Publish…' });
		await page.getByTestId('theme-toggle').focus();
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

	/**
	 * SPEC story 2, and the reason the word changed at all.
	 *
	 * Publish now means *send this Workspace to its Remote*, and the indicator sits beside that
	 * button — so the bare word "Saved" conflated the two facts a scholar most needs kept apart. The
	 * other two states keep their own words, because there is nowhere else for an unsaved edit to be.
	 */
	test('reads “Saved locally” beside Publish, and is still the only status region', async ({
		page
	}) => {
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));

		// ⚠ **Strict-mode `getByRole('status')` is the assertion here, not a convenience.** A second
		// `status` on the editor makes this throw, and a locator that has to be disambiguated is a hint
		// that a screen-reader user would have to disambiguate as well (ADR-0016).
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		await expect(page.getByTestId('publish')).toBeVisible();

		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');

		// The **words**, recorded as they happen and paired with the state that produced them.
		// "Unsaved changes" is the 400 ms debounce window and "Saving…" can be over in a few
		// milliseconds, so both are observed with a `MutationObserver` rather than polled for — the
		// discipline `support/saved.ts` records, and the reason a poll here says nothing when it passes.
		await page.evaluate(() => {
			const indicator = document.querySelector('[data-save-state]');
			if (!indicator) throw new Error('no [data-save-state] element to observe');
			const read = () =>
				`${indicator.getAttribute('data-save-state')}=${indicator.textContent?.trim()}`;
			const seen: string[] = [read()];
			new MutationObserver(() => {
				if (read() !== seen[seen.length - 1]) seen.push(read());
			}).observe(indicator, {
				attributes: true,
				characterData: true,
				childList: true,
				subtree: true
			});
			(window as unknown as { __labels?: string[] }).__labels = seen;
		});

		// A debounced edit, which is the only kind that passes through all three states: renaming is
		// behind the Project settings dialog since ticket 04, and follows the ordinary autosave rules.
		await (await projectNameField(page)).fill('Amsterdam 1626');

		await expect
			.poll(
				() => page.evaluate(() => (window as unknown as { __labels?: string[] }).__labels ?? []),
				{ message: 'the indicator should pass through unsaved and saving, in its own words' }
			)
			.toEqual([
				'saved=Saved locally',
				'unsaved=Unsaved changes',
				'saving=Saving…',
				'saved=Saved locally'
			]);
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// PUBLISHING TO A REMOTE (ticket 04; ADR-0031, ADR-0032, ADR-0033)
//
// SPEC's Seam 2, driving SPEC's Seam 1 fake through Playwright routes. The engine's own
// correctness — the incremental upload, the owned-namespace rules, the truncation refusal, the
// three budgets — is asserted in `packages/core/src/remote/publish-to-remote.test.ts`, where the
// assertion is the resulting tree and no browser is involved. What only a browser can settle is
// here: that one press of one button on the navigation bar puts a Workspace on GitHub, and that
// every way it can go wrong reaches a scholar as a sentence they can act on.
//
// ⚠ **Assertions are on what arrived at the Remote, never on which calls were made.** Every failure
// mode in this epic is silent and plausible, and a test counting requests passes over all of them.
// The one exception is `blobPosts`, which measures what was *sent* — "the second publish uploaded
// nothing" and "the refusal stopped the uploads" are claims no assertion on a tree can make.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const OWNER = 'ada';
const REPOSITORY = 'atlas';
const REMOTE = `${OWNER}/${REPOSITORY}`;
/** A token of the right shape. Its value never matters: the fake looks only for a credential. */
const TOKEN = 'github_pat_11ABCDE0000abcdefghijklmnop';
/** Well into the future, so a reset time is a stable clock reading rather than a race. */
const RESET_AT = 1_800_000_000;

/** `remote.json`, exactly as `bindWorkspaceToRemote` writes it — see `editor-remote-binding.e2e.ts`. */
const boundTo = (owner = OWNER, repository = REPOSITORY): Record<string, string> => ({
	'remote.json': `${JSON.stringify({ formatVersion: 1, owner, repository, branch: 'main' }, null, '\t')}\n`
});

test.describe('publishing to a Remote', () => {
	/** A bound Workspace on a clean hub, with one repository on the fake GitHub. */
	async function start(
		page: Page,
		options: { files?: Record<string, string>; hosts?: GitHubHostsOptions } = {}
	): Promise<GitHubHosts> {
		const github = await routeGitHubHosts(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY }],
			...options.hosts
		});
		await openWorkspace(page, {
			...projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }),
			...boundTo(),
			...options.files
		});
		return github;
	}

	/**
	 * Sign in from the publish dialog itself, which **is** the bound-with-no-credential state.
	 *
	 * The Publish control is enabled in that state and pressing it asks for the credential here rather
	 * than sending the user to another dialog — one of the six states this ticket settled.
	 */
	async function signIn(page: Page) {
		const dialog = await openPublishDialog(page);
		await expect(dialog.getByTestId('publish-sign-in-needed')).toContainText(REMOTE);
		await dialog.getByTestId('publish-token-field').fill(TOKEN);
		await dialog.getByTestId('publish-sign-in').click();
		return dialog;
	}

	/**
	 * Confirm, and wait for the outcome to be announced.
	 *
	 * The Base Map's own files are left out throughout this describe: they are five megabytes of
	 * glyphs and sprites whose journey through `page.route` says nothing about the transport, and
	 * `base-map/` is inside the owned namespace either way (ADR-0033) — which
	 * `publish-to-remote.test.ts` asserts on the bytes.
	 */
	async function publishToRemote(page: Page, dialog: ReturnType<Page['getByRole']>) {
		await dialog.getByRole('checkbox').uncheck();
		await expect(dialog.locator('[data-warning="base-map-size"]')).toBeHidden();
		await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
		await expect(page.getByTestId('publish-status')).toContainText(`Sent to ${REMOTE}`, {
			timeout: 120_000
		});
	}

	test('sends the Workspace to its Remote, .nojekyll and all', async ({ page }) => {
		const github = await start(page, {
			// A `CNAME` and a `docs/` folder the scholar put there themselves: outside the owned
			// namespace, so a publish must leave both exactly where they are (ADR-0033).
			hosts: {
				repositories: [
					{
						owner: OWNER,
						name: REPOSITORY,
						files: {
							'README.md': '# Atlas\n',
							CNAME: 'atlas.example\n',
							'docs/guide.md': 'How to\n'
						}
					}
				]
			}
		});
		const dialog = await signIn(page);
		await expect(dialog.getByTestId('publish-budget')).toBeVisible();

		await publishToRemote(page, dialog);

		// What arrived, rather than what was asked for. The Workspace's own files, the website that was
		// written into it, the binding, and the marker without which GitHub Pages serves a blank page.
		const arrived = github.files(OWNER, REPOSITORY);
		expect(arrived).toContain('.nojekyll');
		expect(arrived).toContain('index.html');
		expect(arrived).toContain('remote.json');
		expect(arrived).toContain('ballastella-site.json');
		expect(arrived).toContain('amsterdam-1625/project.json');
		expect(arrived).toContain('images/aaa/0,0,256,256/256,256/0/default.jpg');
		expect(arrived.filter((path) => path.startsWith('_app/')).length).toBeGreaterThan(5);
		// The tile's bytes, not merely its path: a publish that sent every file empty would pass a
		// listing and serve a site of blank tiles.
		expect(github.fileText(OWNER, REPOSITORY, 'images/aaa/0,0,256,256/256,256/0/default.jpg')).toBe(
			'stands in for a tile'
		);
		// And nothing of the scholar's own was published over. This is the assertion that fails when the
		// owned namespace is one segment too wide, and it fails silently in production: a `CNAME` gone
		// moves a cited address back to a `github.io` URL, and the next publish does it again.
		expect(github.fileText(OWNER, REPOSITORY, 'CNAME')).toBe('atlas.example\n');
		expect(github.fileText(OWNER, REPOSITORY, 'docs/guide.md')).toBe('How to\n');

		// ⚠ **The publish manifest is kept, and it is kept *outside* the Workspace** (ADR-0033). It
		// records what **this machine** last saw on the Remote, which is what ticket 05 refuses an
		// overwrite on — so a copy inside the Workspace would be packed into a Backup, uploaded by the
		// very publish it describes, and downloaded by a Clone, at which point another machine's belief
		// arrives as this one's evidence. `localStorage`, keyed by Workspace and backing, exactly as the
		// write-ahead journal is.
		const manifest = await page.evaluate(() => {
			const key = Object.keys(localStorage).find((name) =>
				name.startsWith('ballastella.publish-manifest.')
			);
			return key === undefined
				? null
				: { key, files: Object.keys(JSON.parse(localStorage.getItem(key) ?? '{}').files ?? {}) };
		});
		expect(manifest?.key).toBe('ballastella.publish-manifest.opfs%3AMy%20Workspace');
		// ⚠ **What it holds is every path this publish *wrote*, and not merely the ones it uploaded** —
		// the distinction a conflict check rests on, because a file skipped as already-present is still
		// a file this machine put there and may replace. `CNAME`, `README.md` and `docs/guide.md` are
		// the other exclusion and the sharper one: they were carried into the commit from the tree
		// listing, with SHAs nothing here has read bytes for, so claiming them would be this machine
		// asserting authorship of files it never sent.
		const preserved = ['CNAME', 'README.md', 'docs/guide.md'];
		expect(manifest?.files.sort()).toEqual(arrived.filter((path) => !preserved.includes(path)));
		expect(arrived).toEqual(expect.arrayContaining(preserved));
		expect(Object.keys(await takeWorkspace(page))).not.toContain('publish-manifest.json');
	});

	test('says nothing needed changing on a second publish, and sends no blob', async ({ page }) => {
		const github = await start(page);
		await publishToRemote(page, await signIn(page));
		const sent = github.blobPosts();
		const commit = github.head(OWNER, REPOSITORY);

		const again = await openPublishDialog(page);

		await expect(again.getByTestId('publish-nothing-to-do')).toContainText(REMOTE);
		// Nothing to press, because there is nothing to do — and nothing was sent finding that out
		// beyond the two requests the plan itself makes.
		//
		// ⚠ **Inert rather than gone.** A button removed from the DOM leaves the tab order exactly as a
		// `disabled` one does, dropping a keyboard user's focus to `<body>` — the failure decision 4 in
		// `PublishDialog`'s header rules out, and this is the same rule applied to the other way of
		// taking a control away (SPEC story 60, WCAG 2.4.3).
		const confirm = again.getByRole('button', { name: 'Publish', exact: true });
		await expect(confirm).toHaveAttribute('aria-disabled', 'true');
		expect(github.blobPosts() - sent).toBe(0);
		expect(github.head(OWNER, REPOSITORY)).toBe(commit);
	});

	/**
	 * SPEC stories 13, 14, 59 and 60 in one run, because they are one moment.
	 *
	 * Three numbers, because a publish can be slow for three different reasons and a scholar cannot
	 * tell them apart otherwise; announced from inside the modal, because `showModal()` makes the rest
	 * of the document inert and an inert live region is never announced at all; and focus stays where
	 * it is, because the control that started it is `aria-disabled` rather than `disabled`.
	 */
	test('announces files done, files total and the requests left, and keeps focus', async ({
		page
	}) => {
		const github = await start(page);
		const dialog = await signIn(page);
		await dialog.getByRole('checkbox').uncheck();
		await expect(dialog.locator('[data-warning="base-map-size"]')).toBeHidden();
		// Slow every GitHub request down so the progress line is on screen long enough to assert rather
		// than long enough to be lucky. Installed *after* the fake's own handler, so it is consulted
		// first and falls back to it — the delay is the whole of what this adds.
		await page.route(`${GITHUB_API_ORIGIN}/**`, async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 60));
			await route.fallback();
		});

		await dialog.getByRole('button', { name: 'Publish', exact: true }).click();

		await expect(dialog.getByTestId('publish-progress')).toContainText(
			/Uploading: \d+ of \d+ files\. \d+ GitHub requests left this hour\./,
			{ timeout: 60_000 }
		);
		// The control that started it says so, and does it with `aria-disabled`: a `disabled` button
		// leaves the tab order the moment it is pressed, dropping focus to `<body>` for the length of
		// the publish (WCAG 2.4.3).
		await expect(page.getByTestId('publish')).toHaveAttribute('aria-disabled', 'true');
		await expect(page.getByTestId('publish')).toContainText(/(Publishing|Uploading)… \d+\/\d+/);
		expect(await page.evaluate(() => document.activeElement?.tagName ?? 'NONE')).not.toBe('BODY');

		await expect(page.getByTestId('publish-status')).toContainText(`Sent to ${REMOTE}`, {
			timeout: 120_000
		});
		// The outcome is outside the dialog, where the dialog no longer is — and it stays there.
		await expect(page.getByTestId('publish-status')).toBeVisible();
		await expect(page.getByRole('dialog')).toBeHidden();
		// One region speaks at a time: the progress line is emptied rather than left holding a sentence
		// a screen reader would read out again on the next publish.
		await expect(page.getByTestId('publish-progress')).toHaveText('');
		expect(github.files(OWNER, REPOSITORY)).toContain('index.html');
	});

	test('refuses a truncated tree, quoting the file count, and sends nothing', async ({ page }) => {
		// The real endpoint truncates at 100 000 entries or a 7 MB response and **answers 200**, so a
		// publish that did not look would upload everything again and then commit a tree missing most
		// of a Historical Map — a silently incomplete site on a scholar's own address.
		const github = await start(page, {
			hosts: {
				repositories: [
					{
						owner: OWNER,
						name: REPOSITORY,
						files: {
							'README.md': '# Atlas\n',
							CNAME: 'atlas.example\n',
							'docs/guide.md': 'How to\n'
						},
						truncateAfter: 3
					}
				]
			}
		});
		const before = github.files(OWNER, REPOSITORY);

		const dialog = await signIn(page);

		// Two, not three: a recursive listing carries an entry per directory as well, and quoting the
		// folder would tell a scholar to delete files they do not have.
		const refusal = dialog.getByTestId('publish-upload-problem');
		await expect(refusal).toContainText('first 2 files');
		await expect(refusal).toContainText('deleting Historical Maps no Project uses');
		expect(github.blobPosts()).toBe(0);
		expect(github.files(OWNER, REPOSITORY)).toEqual(before);

		// **The refusal outlives the dialog**, which is the whole of that control state: it is the one
		// thing on this screen the scholar has to act on, and dismissing the modal is how they get back
		// to the Workspace to act on it.
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toBeHidden();
		await expect(page.getByTestId('publish-failure')).toContainText('first 2 files');
	});

	test('warns before starting when it needs more requests than remain, naming the reset', async ({
		page
	}) => {
		// ⚠ **A budget the Workspace fits into and the publish does not, which is the whole point of
		// forecasting what is about to be written.** This fixture holds six files; with the two the plan
		// itself spends, thirteen is room for all of them, for the tree, for the commit and for the ref
		// move. What does not fit is the website — twenty-odd files of viewer bundle and a site record,
		// none of them in the Workspace at the moment this warning is computed. A forecast made against
		// the folder as it stands says this publish fits, and the scholar meets the 403 three hundred
		// files in instead of making the decision story 11 exists to give them.
		await start(page, {
			hosts: {
				repositories: [
					{ owner: OWNER, name: REPOSITORY, rateLimit: { remaining: 15, reset: RESET_AT } }
				]
			}
		});

		const dialog = await signIn(page);

		const warning = dialog.locator('[data-remote-warning="request-budget"]');
		await expect(warning).toContainText('requests in all');
		await expect(warning).toContainText(/\d{1,2}:\d{2}/);
		// And the budget is stated whether or not it warns, because "how many files, how many bytes,
		// how much of the hour" is what story 9 asks for before the button is pressed at all.
		await expect(dialog.locator('[data-budget="requests"]')).toContainText(/\d{1,2}:\d{2}/);
		await expect(dialog.locator('[data-budget="files"]')).toContainText('need uploading');
		// **Both numbers on the byte axis**: what the site will weigh, and the ceiling it is measured
		// against (ADR-0008's cliff). The *warning* on that axis is asserted at seam 1
		// — `publish-to-remote.test.ts`, "warns when the site would pass the static-hosting limit" —
		// because provoking it from a browser means a Workspace of over a gigabyte, and a publish hashes
		// every byte it is about to send: the fixture that stands the local warning up is a sparse file
		// `ProjectStore#size` reports without reading, and this path would read all of it.
		await expect(dialog.locator('[data-budget="bytes"]')).toContainText(
			/The site will hold [\d.]+ (bytes|kB|MB|GB),\s+of the\s+1\.0 GB GitHub Pages will serve\./
		);
	});

	/**
	 * Story 9's two numbers, checked against what actually arrived.
	 *
	 * ⚠ **The forecast is made before the local publish writes**, so a count taken off the Workspace as
	 * it stands is short by the whole website: `index.html`, `_app/**` and `ballastella-site.json` are
	 * not there yet when the dialog states what it will send. The assertion is the one that cannot pass
	 * over that — the stated total against the tree the Remote ends up holding, which is every file the
	 * forecast named plus the `README.md` outside the owned namespace that a publish preserves.
	 */
	test('states a first publish’s file count including the website it is about to write', async ({
		page
	}) => {
		const github = await start(page);
		const dialog = await signIn(page);
		await dialog.getByRole('checkbox').uncheck();
		await expect(dialog.locator('[data-warning="base-map-size"]')).toBeHidden();
		await expect(dialog.getByTestId('publish-budget')).toBeVisible();

		const stated = await dialog.locator('[data-budget="files"]').innerText();
		const [, uploads, total] = stated.match(/(\d+) of (\d+) files need uploading/) ?? [];

		await publishToRemote(page, dialog);

		const arrived = github.files(OWNER, REPOSITORY);
		expect(arrived).toContain('index.html');
		expect(Number(total)).toBe(arrived.length - 1);
		// And the same total is what the publish had to upload: the repository held only the `README.md`
		// it keeps, so every file the forecast named was new.
		expect(Number(uploads)).toBe(Number(total));
	});

	test('stops legibly when the budget runs out part way, leaving the site as it was', async ({
		page
	}) => {
		// Enough for the sign-in, both plans and a handful of blobs, and not enough for the bundle.
		// Nothing is visible on a Remote until the ref moves, so an interrupted publish has to leave the
		// site exactly as it was rather than half replaced (SPEC story 16).
		const github = await start(page, {
			hosts: {
				repositories: [
					{ owner: OWNER, name: REPOSITORY, rateLimit: { remaining: 20, reset: RESET_AT } }
				]
			}
		});
		const before = github.files(OWNER, REPOSITORY);
		const commit = github.head(OWNER, REPOSITORY);
		const dialog = await signIn(page);
		await dialog.getByRole('checkbox').uncheck();
		await expect(dialog.locator('[data-warning="base-map-size"]')).toBeHidden();

		await dialog.getByRole('button', { name: 'Publish', exact: true }).click();

		const stopped = dialog.getByRole('alert').first();
		await expect(stopped).toContainText('hourly request budget ran out', { timeout: 120_000 });
		await expect(stopped).toContainText(/\d{1,2}:\d{2}/);
		await expect(stopped).toContainText('Nothing has been published');
		// The branch did not move, so the Reader sees what they saw before.
		expect(github.files(OWNER, REPOSITORY)).toEqual(before);
		expect(github.head(OWNER, REPOSITORY)).toBe(commit);

		// It survives the dialog, and it says the website itself did reach the Workspace — the half a
		// message about the Remote alone would leave a scholar unable to account for.
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('publish-failure')).toContainText('written into this Workspace');
	});

	test('settles the address before any upload, and a refused one sends nothing', async ({
		page
	}) => {
		// `scholar.example` — no scheme — is how a user ordinarily arrives here. Core's refusal ends
		// "Nothing has been changed.", so the address is settled before the site is written *and*
		// before a byte is sent: a refusal after an upload would make that sentence false on a public
		// host as well as in a folder.
		const github = await start(page);
		const before = await takeWorkspace(page);
		const dialog = await signIn(page);
		await expect(dialog.getByTestId('publish-budget')).toBeVisible();

		await dialog.getByLabel(/Address your Historical Maps/).fill('scholar.example');
		await dialog.getByRole('button', { name: 'Publish', exact: true }).click();

		await expect(dialog.getByRole('alert').first()).toContainText('Nothing has been changed.');
		expect(await takeWorkspace(page)).toEqual(before);
		expect(github.blobPosts()).toBe(0);
		expect(github.files(OWNER, REPOSITORY)).toEqual(['README.md']);
	});

	// SPEC story 38 in the one place it could most easily be broken: the Publish button is on every
	// screen now, and a scholar who never publishes must still never meet a sign-in prompt.
	test('offers the binding rather than a sign-in when the Workspace is bound to nothing', async ({
		page
	}) => {
		const github = await routeGitHubHosts(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY }]
		});
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));

		const dialog = await openPublishDialog(page);

		await expect(dialog.getByTestId('publish-unbound')).toContainText('Remote repository…');
		await expect(dialog.getByTestId('publish-token-field')).toHaveCount(0);
		// Nothing was asked of GitHub, and the local publish is still there and still works — a user
		// with no Remote is not blocked by an epic about Remotes.
		expect(github.requests).toEqual([]);
		await dialog.getByRole('checkbox').uncheck();
		await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
		await expect(page.getByTestId('publish-status')).toContainText('Published:', {
			timeout: 30_000
		});
		await expect(page.getByTestId('publish-status')).not.toContainText('Sent to');
		expect(github.requests).toEqual([]);
	});

	/**
	 * The state between the two the unbound test covers, and the one that can report a lie.
	 *
	 * ⚠ **Bound with no credential publishes into the Workspace and reaches nobody.** The paste form
	 * and the confirm button are on screen together, so the press is available before the sign-in is —
	 * and the worst arrangement of it is the one the expired-token test above produces, where the
	 * credential is cleared from under a scholar who then presses Publish and would be told their work
	 * is on the web. What must be on screen afterwards is the Remote that did **not** get it.
	 */
	test('says nothing was sent when the Workspace is bound and not signed in', async ({ page }) => {
		const github = await start(page);
		const before = github.files(OWNER, REPOSITORY);

		const dialog = await openPublishDialog(page);
		await expect(dialog.getByTestId('publish-sign-in-needed')).toContainText(REMOTE);
		await dialog.getByRole('checkbox').uncheck();
		await expect(dialog.locator('[data-warning="base-map-size"]')).toBeHidden();
		// The label says so as well, before it is pressed: "Publish" beside a token field is the one
		// control here that reads as putting the work on the web without doing it.
		await dialog.getByRole('button', { name: 'Publish into this Workspace only' }).click();

		const status = page.getByTestId('publish-status');
		await expect(status).toContainText('Published:', { timeout: 30_000 });
		await expect(status).toContainText(`Nothing was sent to ${REMOTE}`);
		await expect(status).toContainText('not signed in to GitHub');
		await expect(status).not.toContainText('Sent to');
		// And the Remote is exactly as it was, which is what the sentence claims.
		expect(github.blobPosts()).toBe(0);
		expect(github.files(OWNER, REPOSITORY)).toEqual(before);
		// The website itself did reach the Workspace, so publishing again after a sign-in sends it.
		expect(Object.keys(await takeWorkspace(page))).toContain('index.html');
	});

	/**
	 * Story 5: the credential that reaches a repository and cannot push to it.
	 *
	 * `signIn` reads the rights for exactly this reason, and every request a forecast makes is a GET —
	 * so a `Contents: Read` token pastes cleanly, plans cleanly, and meets its 403 at the first blob,
	 * with the whole website already written into the Workspace. The Remote dialog says so at a bind;
	 * this says so at a paste.
	 */
	test('says a token that cannot push cannot push, before anything is written', async ({
		page
	}) => {
		await start(page, {
			hosts: { repositories: [{ owner: OWNER, name: REPOSITORY, push: false }] }
		});

		const dialog = await signIn(page);

		const notice = dialog.getByTestId('publish-no-push');
		await expect(notice).toContainText(REMOTE);
		await expect(notice).toContainText('Contents: Read and write');
		// It is a notice and not a refusal: the forecast is still shown, because the sentence is about
		// what the publish will meet rather than about anything that has already gone wrong.
		await expect(dialog.getByTestId('publish-budget')).toBeVisible();
	});

	/**
	 * The result renders **outside** the dialog, on a bar that is on every screen (ticket 07's class).
	 *
	 * So closing is not what makes it stale — switching Workspace is. "Published … Sent to ada/atlas"
	 * left under the bar of the Workspace a scholar has just switched to is a statement about that
	 * Workspace, and it is false.
	 */
	test('leaves no result from one Workspace standing under the bar of the next', async ({
		page
	}) => {
		await start(page);
		await publishToRemote(page, await signIn(page));
		await expect(page.getByTestId('publish-status')).toContainText(`Sent to ${REMOTE}`);

		await createWorkspace(page, 'Marking 2026');

		await expect(page.getByTestId('publish-status')).toHaveText('');
		await expect(page.getByTestId('publish-stale')).toHaveCount(0);
		await expect(page.getByTestId('publish-failure')).toHaveCount(0);
	});

	/**
	 * The stale sign-in ticket 03 recorded and this ticket settled.
	 *
	 * Rights are read at a bind and at a paste and at no other moment, so the bar's "Signed in to
	 * GitHub" means *a credential is held*, never *a credential still works*. The answer taken is:
	 * leave the label alone and let the **refusal** carry it. It arrives on opening the dialog,
	 * because planning is the first credentialed request a publish makes and it sends nothing — so a
	 * scholar meets it with the Remote untouched rather than after four thousand tiles have gone.
	 */
	test('says the sign-in has expired, offers the paste, and forgets the credential', async ({
		page
	}) => {
		const github = await start(page);
		// Waited out rather than merely started: the forecast that follows a sign-in is what would meet
		// the revoked token below, and closing the dialog on top of one still in flight would be a test
		// asserting a race rather than the behaviour.
		await expect((await signIn(page)).getByTestId('publish-budget')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('remote-credential')).toHaveText('Signed in to GitHub');

		// The token is revoked on GitHub's side while the tab still holds it — which is the situation,
		// and which nothing in this browser can notice until it next asks. A second fake, installed
		// later and therefore consulted first, is how that is arranged: Playwright takes the most
		// recently registered matching handler.
		const revoked = await routeGitHubHosts(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY }],
			rejectCredential: true
		});

		const dialog = await openPublishDialog(page);

		const refusal = dialog.getByTestId('publish-upload-problem');
		await expect(refusal).toContainText('sign-in has expired');
		await expect(refusal).toContainText(REMOTE);
		// Not "GitHub refused this publish", which sends a scholar off to check a repository that is
		// perfectly fine — and not a byte sent finding out.
		await expect(refusal).not.toContainText('Bad credentials');
		expect(revoked.blobPosts()).toBe(0);
		expect(github.files(OWNER, REPOSITORY)).toEqual(['README.md']);

		// And the credential is forgotten rather than merely reported on, so the paste is back — the
		// bar tells the truth from here on, because there is now genuinely no credential held.
		await expect(dialog.getByTestId('publish-token-field')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('remote-credential')).toHaveText('Not signed in');
	});
});
