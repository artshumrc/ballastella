import { expect, test } from './support/test.js';
import { type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	GITHUB_API_ORIGIN,
	routeGitHubHosts,
	type GitHubHosts,
	type GitHubHostsOptions
} from './support/github-hosts.js';
import { projectNameField } from './support/project-screen.js';
import { serveDirectory, type StaticSite } from './support/static-site.js';
import {
	closeTheDoor,
	createWorkspace,
	expectCredential,
	openSyncModal,
	openTheDoor,
	readBaseline,
	seedGitHubCredential,
	seedRemoteRelationship
} from './support/workspace.js';

const DEFAULT_PUBLISH_TOKEN = 'github_pat_11ABCDE0000abcdefghijklmnop';

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
 * Seam 2 for publishing, and the assertion the whole of it rests on.
 *
 * The file-level behaviour — additive publishing, the recorded file set, and the warnings — is asserted
 * at Seam 1 in `@ballastella/core`, where the bytes are the assertion. What only
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

const sha256 = (base64: string) =>
	createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');

/** A Project with a Map Image, an Alignment, an Annotation Layer, and a pyramid. */
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
			baseMap: null,
			baseMapAppearance: { streets: false, relief: true, muted: false }
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
				// A referenced Map Image has no `info.json` of ours: `remote.json` beside a missing one is
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

/**
 * Open the editor on an empty Workspace holding exactly `files`.
 *
 * A credential is seeded unless `signedIn: false`, because publishing is not offered without one and
 * on a deployment with a GitHub App there is no token field on this screen to type one into. See
 * {@link seedGitHubCredential}: the door is asserted in `editor-github-signin.e2e.ts`, and every
 * test here is about the files a publish writes.
 */
async function openWorkspace(
	page: Page,
	files: Record<string, string>,
	options: { unbound?: boolean; signedIn?: boolean } = {}
): Promise<void> {
	await routeGitHubOnce(page);
	await page.goto('./');
	await emptyWorkspace(page);
	await seed(page, files);
	// ⚠ **The relationship is installation-local and is the only account of it there is** (ADR-0044),
	// so a spec that needs a connected Workspace records it the way an Open or a connect does. Nothing
	// seeded into the Workspace's own files can make it connected.
	if (!options.unbound) await seedRemoteRelationship(page, { owner: 'ada', repository: 'atlas' });
	if (options.signedIn !== false) await seedGitHubCredential(page, DEFAULT_PUBLISH_TOKEN);
	await page.reload();
	await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
}

/**
 * Ask for Share Links, from the door's own press, unless this Workspace already has them.
 *
 * ⚠ **A repository holds the work until the author asks for an address** (ADR-0045), so a Sync from a
 * Workspace that never asked carries the scholar's own files and no website at all. Every claim in
 * this spec is about a *site* — its relative asset paths, its front page, its Base Map, its version
 * stamp — so the press that grants one is part of the arrangement rather than part of the subject.
 * What the press itself does is asserted at Seam 1 (`bind-remote.test.ts`) and at Seam 1c
 * (`connect-to-github.dom.test.ts`).
 *
 * Tolerant of a Workspace that has one already: the offer is replaced by *Withdraw Share Links* the
 * moment the site record is there, so a second call is a no-op rather than a second press.
 */
async function withShareLinks(page: Page): Promise<void> {
	const offer = page.getByTestId('enable-pages');
	if ((await offer.count()) === 0) return;
	await offer.click();
	await expect(page.getByTestId('pages-enabled')).toBeVisible({ timeout: 60_000 });
}

/**
 * Open the Sync modal and wait for the plan it computed.
 *
 * The door is opened first because these specs need Share Links — a Sync from a Workspace that never
 * asked for them carries no website at all (ADR-0045) — and the door is where that press is. The bar
 * opens this modal directly for a Workspace with a repository, which `editor-remote-binding` asserts.
 */
async function openSyncFromTheBar(page: Page) {
	await openSyncModal(page);
	return page.getByRole('dialog', { name: 'Sync with GitHub' });
}

async function openSyncModalWithShareLinks(page: Page) {
	await openTheDoor(page);
	await withShareLinks(page);
	await page.getByTestId('connect-sync').click();
	// Named, because the door's own `<dialog>` stays in the document behind this one and a bare
	// `getByRole('dialog')` is then two elements rather than one.
	const dialog = page.getByRole('dialog', { name: 'Sync with GitHub' });
	await expect(dialog.getByTestId('sync-modal')).toBeVisible();
	return dialog;
}

/**
 * Publish, and wait for the announced result.
 *
 */
/**
 * The one fake GitHub a spec's publishes all reach.
 *
 * ⚠ **One per spec, and that is a correctness requirement now rather than tidiness.** Installing the
 * routes again builds a *new* repository with nothing in it, and Publish is baseline-aware: a Remote
 * that has lost every source path this machine's Baseline says it holds is an inbound deletion, so
 * the second publish is correctly refused and directed to Update. The reset was invisible while the
 * conflict check could only see the Remote's own tree.
 */
const gitHubOf = new WeakMap<Page, Promise<GitHubHosts>>();

/**
 * Install this page's one fake GitHub, if it has not been installed yet.
 *
 * ⚠ **Called before the Workspace is opened, and that ordering is load-bearing.** A bound Workspace
 * arrives holding a credential (see {@link openWorkspace}), so the publish dialog asks GitHub what
 * the Remote already holds the moment it opens. Routes installed after that open are routes
 * installed after the request the default-deny fence would abort.
 */
function routeGitHubOnce(page: Page, options?: GitHubHostsOptions): Promise<GitHubHosts> {
	let hosts = gitHubOf.get(page);
	if (hosts === undefined) {
		hosts = routeGitHubHosts(page, options ?? { repositories: [{ owner: 'ada', name: 'atlas' }] });
		gitHubOf.set(page, hosts);
	}
	return hosts;
}

async function preparePublish(page: Page, dialog: ReturnType<Page['getByRole']>) {
	await routeGitHubOnce(page);
	// The credential came with the Workspace (see `openWorkspace`), so what is waited for here is the
	// forecast the dialog asks GitHub for the moment it opens.
	await expect(dialog.getByTestId('sync-budget')).toBeVisible({ timeout: 60_000 });
}

async function publish(page: Page, existingDialog?: ReturnType<Page['getByRole']>) {
	const dialog = existingDialog ?? (await openSyncModalWithShareLinks(page));
	await preparePublish(page, dialog);
	await dialog.getByTestId('sync-send').click();
	// Generous, because a Sync fetches every file of the bundle and writes it into OPFS: real work,
	// and the suite runs four workers each driving a real map against the same origin's storage. The
	// default 5 s here is a measurement of the machine rather than of a Sync.
	await expect(page.getByTestId('sync-status')).toContainText('Sent to', { timeout: 30_000 });
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

	test('references every asset relatively, asserted on the bytes that were written', async ({
		page
	}) => {
		// The served assertion above is the real one. This is the ADR-0006 fence applied to the *user's
		// folder* rather than to our build output — the case the CI fence deliberately does not cover,
		// because it greps `apps/*/build` and the thing that ships to a Reader is this.
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));
		await publish(page);

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

	// "adds the site to the Workspace and copies no Project data" was asked here and is now asked in
	// `packages/core/src/publish/publish.test.ts`, where the bytes are the assertion rather than a
	// base64 round trip through OPFS: "writes the viewer and the site record at the Workspace, beside
	// the Projects" for the file set, "modifies no Project data, asserted on the bytes of every Project
	// file" and "writes nothing at all inside a Project directory" for the Project half, and
	// "duplicates no tile bytes: the pyramid is in the Workspace exactly once" for the pyramid.

	/**
	 * The Front Page choice belongs with publishing: the dialog shows the consequence, persists the
	 * choice, and forecasts the resulting site before the button is pressed.
	 */
	test('lets the author choose which Projects appear on the front page', async ({ page }) => {
		await openWorkspace(page, {
			...projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }),
			...projectFiles('boston-1775', { name: 'Boston 1775' })
		});

		const dialog = await openSyncModalWithShareLinks(page);
		const boston = dialog.getByTestId('on-front-page-boston-1775');
		await expect(boston).toBeChecked();
		await expect(boston).toHaveAccessibleName('On the front page — Boston 1775');
		const description = dialog.locator('#sync-project-description');
		await expect(boston).toHaveAttribute(
			'aria-describedby',
			(await description.getAttribute('id')) ?? ''
		);

		await boston.uncheck();
		await expect(description).toContainText('All Projects stay published.');
		await expect(dialog.getByTestId('sync-site-breakdown')).toBeVisible();
		// ⚠ **The forecast, not the checkbox.** Unchecking writes `project.json`, and the plan the
		// dialog holds is re-made from the Projects afterwards — so pressing Publish on the strength of
		// the checkbox alone publishes whichever plan happened to be in hand.
		await expect(dialog.getByTestId('sync-site-projects')).toContainText(
			'2 Projects, 1 of them on the front page'
		);

		await publish(page, dialog);

		await expect(page.getByTestId('sync-status')).toContainText(
			'carrying 2 Projects, 1 of them on the front page.',
			{ timeout: 30_000 }
		);
	});

	test('states the Base Map’s size before publishing, and adds those files', async ({ page }) => {
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));

		const dialog = await openSyncModalWithShareLinks(page);
		// The display assets' size is on screen before publishing spends it.
		await expect(dialog.getByTestId('sync-site-breakdown')).toContainText(/[0-9.]+ (kB|MB)/);
		await publish(page, dialog);
		await expect(page.getByTestId('sync-status')).toContainText('Sent to', {
			timeout: 30_000
		});

		const withBaseMap = Object.keys(await takeWorkspace(page)).filter((path) =>
			path.startsWith('base-map/')
		);
		expect(withBaseMap.length).toBeGreaterThan(1);
		expect(withBaseMap.some((path) => path.endsWith('.pmtiles'))).toBe(false);
	});

	test('always publishes Base Map assets for a legacy site', async ({ page }) => {
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

		// A legacy record may say the display assets were absent; the next publish repairs the site.
		await openWorkspace(page, {
			...projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }),
			...publishedSite({ baseMapAssetsBundled: false })
		});
		const dialog = await openSyncModalWithShareLinks(page);
		await expect(dialog.getByTestId('sync-site-breakdown')).toBeVisible();
		await publish(page, dialog);
		await expect(page.getByTestId('sync-status')).toContainText('Sent to', {
			timeout: 30_000
		});
		expect(
			Object.keys(await takeWorkspace(page)).some((path) => path.startsWith('base-map/'))
		).toBe(true);
	});

	test('announces progress from inside the modal, where the document is not inert', async ({
		page
	}) => {
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));
		const dialog = await openSyncModalWithShareLinks(page);

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
				// The result is a toast, so what has to be outside the modal — and mounted before it has
				// anything to say — is the stack that will hold it. There is no result yet at this point
				// in the publish, which is the whole reason the region is asked about rather than the
				// message: a region raised together with its first text is not announced.
				return { progress: region('sync-progress'), result: region('toast-stack') };
			})
		).toEqual({
			progress: { insideTheModal: true, live: 'polite', atomic: 'true' },
			// The result is outside on purpose: by the time it has anything to say the dialog has closed,
			// and an `aria-live` region inside an inert subtree is not a quiet one — it is not announced
			// at all. The two never speak at once.
			result: { insideTheModal: false, live: 'polite', atomic: null }
		});

		// Slow the viewer's own files down, so the progress line is on screen long enough to assert
		// rather than long enough to be lucky. Publishing fetches each one from the editor's deployment.
		await page.route('**/viewer-bundle/**', async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 200));
			await route.continue();
		});
		await preparePublish(page, dialog);
		await dialog.getByTestId('sync-send').click();
		await expect(dialog.getByTestId('sync-progress')).toContainText(
			/Writing the viewer: \d+ of \d+ files\./
		);

		await expect(page.getByTestId('sync-status')).toContainText('Sent to', {
			timeout: 60_000
		});
		// One region speaks at a time: the progress line is emptied rather than left holding a sentence
		// a screen reader would read out again on the next publish.
		await expect(page.getByTestId('sync-progress')).toHaveText('');
	});

	test('warns that a referenced Map Image leaves a Reader with no network seeing nothing', async ({
		page
	}) => {
		await openWorkspace(
			page,
			projectFiles('amsterdam-1625', { name: 'Amsterdam 1625', referenced: true })
		);

		const dialog = await openSyncModalWithShareLinks(page);

		const warning = dialog.locator('[data-warning="referenced-images"]');
		await expect(warning).toContainText('Blaeu’s plan, from the library');
		await expect(warning).toContainText('no network');
		// And the Reader is told too, on the site itself.
		await publish(page, dialog);
		await expect(page.getByTestId('sync-status')).toContainText('Sent to', {
			timeout: 30_000
		});

		const { root } = await servePublished(page);
		await page.goto(`${root.url}?p=amsterdam-1625`);

		await expect(page.getByTestId('project-needs-network')).toContainText('Blaeu’s plan');
		// **One expected 404, and it is named rather than filtered out of the way.** A published site has no
		// directory listing, so the viewer asks whether a Map Image has an `info.json` of its own and
		// reads the answer off the status (ADR-0023) — a referenced map has none, and that is how the site
		// learns its tiles are on a Library's server. Every *other* failed request is still fatal here.
		expect(root.failures).toEqual([{ path: `/images/${'aaa'}/info.json`, status: 404 }]);
	});

	// "names the hosting limit when the Workspace is about to cross it" was asked here and is now asked
	// in `packages/core/src/publish/publish.test.ts` as "names the hosting limit when the site would take
	// the Workspace past it", which asserts the same two strings and a third this could not — the byte
	// figure — against arithmetic rather than against a browser's storage quota. The claim that a
	// planning warning reaches the dialog at all is kept at Seam 2 by the two tests either side of this
	// one: "states the Base Map's size before adding it" and "warns that a referenced Map Image
	// leaves a Reader with no network seeing nothing".
	//
	// Retiring it also retires the only precondition in this suite the machine can fail: the fixture was
	// a 999 MB sparse file, charged in full against the origin's quota, which Chromium sizes from the
	// free space behind `TMPDIR`.

	test('extends the hub page on a second publish and leaves the first Project untouched', async ({
		page
	}) => {
		// The semester-long, one-repository workflow.
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
		// The first Project's own files **and** the shared Map Image it draws (ADR-0023). Scoped to
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
		await openSyncModalWithShareLinks(page);
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('sync-stale')).toContainText('an older version of the viewer');

		await publish(page);

		const refreshed = JSON.parse(
			Buffer.from((await takeWorkspace(page))['ballastella-site.json']!, 'base64').toString('utf8')
		);
		expect(refreshed.viewerVersion).toBe(stamped.viewerVersion);
		await expect(page.getByTestId('sync-stale')).toBeHidden();
	});

	test('renders a Project’s name as text, never as markup, on the published site', async ({
		page
	}) => {
		// The display name comes out of a `project.json` and is untrusted content, and a Published Site
		// runs on the author's own domain — so a name rendered as HTML there is stored XSS on
		// `student.github.io` (ADR-0009). The discipline this inherits from the editor's own sanitisation
		// tests matters most in one part: **assert the real prose is on the page first**, because a
		// blank surface passes every "nothing dangerous survived" check.
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

	/**
	 * The reason the word changed at all.
	 *
	 * A Sync sends this Workspace to its Remote and the indicator sits beside that control, so the
	 * bare word "Saved" conflated the two facts a scholar most needs kept apart. The other two states
	 * keep their own words, because there is nowhere else for an unsaved edit to be.
	 */
	test('reads “Saved here” beside Sync, and is still the only status region', async ({ page }) => {
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }));

		// ⚠ **Strict-mode `getByRole('status')` is the assertion here, not a convenience.** A second
		// `status` on the editor makes this throw, and a locator that has to be disambiguated is a hint
		// that a screen-reader user would have to disambiguate as well (ADR-0016). One region carries
		// both clauses of the badge (ADR-0044), which is why this reads the local one rather than the
		// whole line.
		await expect(page.getByRole('status')).toContainText('Saved here');
		// The one GitHub control, on Workspace Home — which is the screen a student meets before they
		// have opened a Project, and the reason the control is on the bar rather than in a settings
		// dialog (ADR-0044).
		await expect(page.getByTestId('connect-to-github')).toBeVisible();

		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		// And on the Project screen too, which is what "on every route" means: the door does not have
		// to be gone back to Workspace Home for.
		await expect(page.getByTestId('connect-to-github')).toBeVisible();

		// The **words**, recorded as they happen and paired with the state that produced them.
		// "Unsaved changes" is the 400 ms debounce window and "Saving…" can be over in a few
		// milliseconds, so both are observed with a `MutationObserver` rather than polled for — the
		// discipline `support/saved.ts` records, and the reason a poll here says nothing when it passes.
		await page.evaluate(() => {
			const indicator = document.querySelector('[data-save-state]');
			if (!indicator) throw new Error('no [data-save-state] element to observe');
			// The local clause alone: the badge's other clause is about GitHub and changes on its own
			// schedule, and what this records is the three save states in their own words.
			const read = () =>
				`${indicator.getAttribute('data-save-state')}=${(indicator.textContent ?? '')
					.split('·')[0]
					.trim()}`;
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

		// A debounced edit, which is the only kind that passes through all three states: renaming is in
		// the Project settings dialog and follows the ordinary autosave rules.
		await (await projectNameField(page)).fill('Amsterdam 1626');

		await expect
			.poll(
				() => page.evaluate(() => (window as unknown as { __labels?: string[] }).__labels ?? []),
				{ message: 'the indicator should pass through unsaved and saving, in its own words' }
			)
			.toEqual([
				'saved=Saved here',
				'unsaved=Unsaved changes',
				'saving=Saving…',
				'saved=Saved here'
			]);
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// PUBLISHING TO A REMOTE (ADR-0031, ADR-0032, ADR-0033)
//
// Seam 2, driving the Seam 1 fake through Playwright routes. The engine's own
// correctness — the incremental upload, the owned-namespace rules, the truncation refusal, the
// three budgets — is asserted in `packages/core/src/remote/publish-to-remote.test.ts`, where the
// assertion is the resulting tree and no browser is involved. What only a browser can settle is
// here: that one press of one button on the navigation bar puts a Workspace on GitHub, and that
// every way it can go wrong reaches a scholar as a sentence they can act on.
//
// ⚠ **Assertions are on what arrived at the Remote, never on which calls were made.** Every failure
// mode a publish has is silent and plausible, and a test counting requests passes over all of them.
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

test.describe('publishing to a Remote', () => {
	/** A bound Workspace on a clean hub, with one repository on the fake GitHub. */
	async function start(
		page: Page,
		options: { files?: Record<string, string>; hosts?: GitHubHostsOptions } = {}
	): Promise<GitHubHosts> {
		const github = await routeGitHubOnce(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY }],
			...options.hosts
		});
		// ⚠ **No credential, because that is the state this describe starts every test from**:
		// connected, and pressed to Publish with nothing held. `signedIn` is what moves past it.
		await openWorkspace(
			page,
			{
				...projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }),
				...options.files
			},
			{ signedIn: false }
		);
		return github;
	}

	/**
	 * Reach the publish dialog of a bound Workspace that holds a credential.
	 *
	 * ⚠ **The credential is seeded rather than acquired, and that is a statement about what these
	 * tests are for.** On a deployment with a GitHub App the publish dialog offers no token field —
	 * the door there is a redirect off the page — and every test in this describe is
	 * about the bytes that reach the Remote rather than about how the credential was got. Driving the
	 * real door here would make ten tests of the Remote into ten tests of the sign-in; it is asserted
	 * once, in `editor-github-signin.e2e.ts`, against the real `isGitHubAppConfigured`.
	 *
	 * The reload is what makes the seeded credential held: it is read when the app starts.
	 */
	async function signedIn(page: Page) {
		await seedGitHubCredential(page, TOKEN);
		await page.reload();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
		// Through the door, because every claim in this describe is about a *site* reaching the Remote
		// and a Sync from a Workspace that never asked for Share Links carries none (ADR-0045).
		return openSyncModalWithShareLinks(page);
	}

	/**
	 * Confirm, and wait for the outcome to be announced.
	 *
	 * The Base Map's own files are included throughout this describe: `base-map/` is inside the owned
	 * namespace either way (ADR-0033), and the remote tests assert on the resulting bytes.
	 */
	async function publishToRemote(page: Page, dialog: ReturnType<Page['getByRole']>) {
		await expect(dialog.getByTestId('sync-site-breakdown')).toBeVisible();
		await dialog.getByTestId('sync-send').click();
		await expect(page.getByTestId('sync-status')).toContainText(`Sent to ${REMOTE}`, {
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
		const dialog = await signedIn(page);
		await expect(dialog.getByTestId('sync-budget')).toBeVisible();

		await publishToRemote(page, dialog);

		// What arrived, rather than what was asked for. The Workspace's own files, the website that was
		// written into it, and the marker without which GitHub Pages serves a blank page.
		const arrived = github.files(OWNER, REPOSITORY);
		expect(arrived).toContain('.nojekyll');
		expect(arrived).toContain('index.html');
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

		// ⚠ **The Synchronization Baseline is kept, and it is kept *outside* the Workspace** (ADR-0038).
		// It records what **this machine** last shared with the Remote, which is what a conflict check
		// refuses an overwrite on — so a copy inside the Workspace would be packed into a Backup,
		// uploaded by the very publish it describes, and downloaded by a Clone, at which point another
		// machine's belief arrives as this one's evidence. Installation-local, keyed by Workspace and
		// backing, and in IndexedDB rather than the origin's 5 MB of `localStorage`, which a Workspace of
		// 40 000 files overran.
		const baseline = await readBaseline(page);
		expect(baseline?.commit).toBe(github.head(OWNER, REPOSITORY));
		// ⚠ **What it holds is the *source* this publish wrote, and not merely the paths it uploaded** —
		// the distinction the refusal rests on, because a file skipped as already-present is still a
		// file this machine put there and may replace. Two things are excluded. `CNAME`, `README.md`
		// and `docs/guide.md` were carried into the commit from the tree listing, with SHAs nothing
		// here has read bytes for, so claiming them would be this machine asserting authorship of
		// files it never sent. And the generated site — `index.html`, `_app/**`, `.nojekyll`,
		// `ballastella-site.json`, the Base Map's fonts and sprites — is Publish-owned output: it is
		// sent every time and it is never shared *source*, or two editor versions would read each
		// other's chunk names as changed scholarship.
		expect(baseline?.files.sort()).toEqual([
			'alignments/aaa.json',
			'amsterdam-1625/annotations/l2.geojson',
			'amsterdam-1625/project.json',
			'images/aaa/0,0,256,256/256,256/0/default.jpg',
			'images/aaa/info.json'
		]);
		expect(arrived).toEqual(expect.arrayContaining(['CNAME', 'README.md', 'docs/guide.md']));
	});

	test('says nothing needed changing on a second publish, and sends no blob', async ({ page }) => {
		const github = await start(page);
		await publishToRemote(page, await signedIn(page));
		const sent = github.blobPosts();
		const commit = github.head(OWNER, REPOSITORY);

		const again = await openSyncFromTheBar(page);

		await expect(again.getByTestId('sync-nothing-to-do')).toContainText(REMOTE);
		// Nothing to press, because there is nothing to do — and nothing was sent finding that out
		// beyond the two requests the plan itself makes.
		//
		// ⚠ **Inert rather than gone.** A button removed from the DOM leaves the tab order exactly as a
		// `disabled` one does, dropping a keyboard user's focus to `<body>` — the failure decision 4 in
		// `PublishDialog`'s header rules out, and this is the same rule applied to the other way of
		// taking a control away (WCAG 2.4.3).
		const confirm = again.getByTestId('sync-send');
		await expect(confirm).toHaveAttribute('aria-disabled', 'true');
		expect(github.blobPosts() - sent).toBe(0);
		expect(github.head(OWNER, REPOSITORY)).toBe(commit);
	});

	/**
	 * Four claims in one run, because they are one moment.
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
		const dialog = await signedIn(page);
		await expect(dialog.getByTestId('sync-site-breakdown')).toBeVisible();
		// Slow every GitHub request down so the progress line is on screen long enough to assert rather
		// than long enough to be lucky. Installed *after* the fake's own handler, so it is consulted
		// first and falls back to it — the delay is the whole of what this adds.
		await page.route(`${GITHUB_API_ORIGIN}/**`, async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 60));
			await route.fallback();
		});

		await dialog.getByTestId('sync-send').click();

		const progress = dialog.getByTestId('sync-progress');
		await expect(progress).toContainText(
			/Sending: \d+ of \d+ files\. \d+ GitHub requests left this hour\./,
			{ timeout: 60_000 }
		);
		// The total the line is counting towards, kept so the finished publish can be held to it.
		const announced = Number(/of (\d+) files/.exec((await progress.textContent()) ?? '')?.[1]);
		expect(announced).toBeGreaterThan(0);
		// The bar's one GitHub control says so, and does it with `aria-disabled`: a `disabled` button
		// leaves the tab order the moment it is pressed, dropping focus to `<body>` for the length of
		// the publish (WCAG 2.4.3). It is the control this publish was started from — the door closed
		// on the press — and it is the only one on the bar that could say it.
		await expect(page.getByTestId('connect-to-github')).toHaveAttribute('aria-disabled', 'true');
		await expect(page.getByTestId('connect-to-github')).toContainText(
			/(Writing the viewer|Sending)… \d+\/\d+/
		);
		expect(await page.evaluate(() => document.activeElement?.tagName ?? 'NONE')).not.toBe('BODY');

		await expect(page.getByTestId('sync-status')).toContainText(`Sent to ${REMOTE}`, {
			timeout: 120_000
		});
		// The outcome is outside the dialog, where the dialog no longer is — and it stays there.
		await expect(page.getByTestId('sync-status')).toBeVisible();
		await expect(page.getByRole('dialog', { name: 'Sync with GitHub' })).toBeHidden();
		// One region speaks at a time: the progress line is emptied rather than left holding a sentence
		// a screen reader would read out again on the next publish.
		await expect(page.getByTestId('sync-progress')).toHaveText('');
		expect(github.files(OWNER, REPOSITORY)).toContain('index.html');
		// ⚠ **And the count it was climbing towards is the transfer that happened**, not the plan it
		// started from: every file the line promised was uploaded, one blob apiece. A progress line
		// counting something else — the tree's entries, the Workspace's files — would leave a scholar
		// watching a number that never arrives where it said it would.
		expect(github.blobPosts()).toBe(announced);
	});

	test('refuses a truncated tree, quoting the file count, and sends nothing', async ({ page }) => {
		// The real endpoint truncates at 100 000 entries or a 7 MB response and **answers 200**, so a
		// publish that did not look would upload everything again and then commit a tree missing most
		// of a Map Image — a silently incomplete site on a scholar's own address.
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

		const dialog = await signedIn(page);

		// Two, not three: a recursive listing carries an entry per directory as well, and quoting the
		// folder would tell a scholar to delete files they do not have.
		const refusal = dialog.getByTestId('sync-problem');
		await expect(refusal).toContainText('first 2 files');
		await expect(refusal).toContainText('deleting Map Images no Project uses');
		expect(github.blobPosts()).toBe(0);
		expect(github.files(OWNER, REPOSITORY)).toEqual(before);

		// **The refusal outlives the dialog**, which is the whole of that control state: it is the one
		// thing on this screen the scholar has to act on, and dismissing the modal is how they get back
		// to the Workspace to act on it.
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog', { name: 'Sync with GitHub' })).toBeHidden();
		const refusalToast = page.getByTestId('sync-failure');
		// In the app's one toast stack, which is what makes it dismissible and what keeps it from
		// pushing the Workspace down the screen behind it.
		await expect(page.locator('.toast')).toContainText('first 2 files');
		await expect(refusalToast).toContainText('first 2 files');
		await refusalToast.getByRole('button', { name: 'Dismiss' }).click();
		await expect(refusalToast).toHaveCount(0);
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
		// files in instead of making the decision the forecast exists to give them.
		await start(page, {
			hosts: {
				repositories: [
					{ owner: OWNER, name: REPOSITORY, rateLimit: { remaining: 15, reset: RESET_AT } }
				]
			}
		});

		const dialog = await signedIn(page);

		const warning = dialog.locator('[data-remote-warning="request-budget"]');
		await expect(warning).toContainText('requests in all');
		await expect(warning).toContainText(/\d{1,2}:\d{2}/);
		// And the budget is stated whether or not it warns, because "how many files, how many bytes,
		// how much of the hour" is what a scholar needs before the button is pressed at all.
		await expect(dialog.locator('[data-budget="requests"]')).toContainText(/\d{1,2}:\d{2}/);
		await expect(dialog.locator('[data-budget="files"]')).toContainText('need uploading');
		// **Both numbers on the byte axis**: what the site will weigh, and the ceiling it is measured
		// against (ADR-0008's cliff). The *warning* on that axis is asserted at seam 1
		// — `publish-to-remote.test.ts`, "warns when the site would pass the static-hosting limit" —
		// because provoking it from a browser means a Workspace of over a gigabyte, and a publish hashes
		// every byte it is about to send: the fixture that stands the local warning up is a sparse file
		// `ProjectStore#size` reports without reading, and this path would read all of it.
		await expect(dialog.locator('[data-budget="bytes"]')).toContainText(
			/the repository would hold\s+[\d.]+ (bytes|kB|MB|GB) \/ 1\.0 GB\s+GitHub Pages limit\./
		);
	});

	/**
	 * The forecast's two numbers, checked against what actually arrived and what was announced.
	 *
	 * ⚠ **A forecast is worth nothing unless it is the same count as the outcome**, and the two are
	 * computed at different moments against different evidence: the dialog states what it will send
	 * before a byte moves, and `publishToRemote` plans again afterwards against the Workspace the local
	 * publish has just refreshed. So both halves are tied down here — the stated total against the tree
	 * the Remote ends up holding (every file the forecast named, plus the `README.md` outside the owned
	 * namespace that a Sync preserves), and the stated uploads against the number the result announces.
	 */
	test('states the file count it will send, and the outcome agrees with it', async ({ page }) => {
		const github = await start(page);
		const dialog = await signedIn(page);
		await expect(dialog.getByTestId('sync-site-breakdown')).toBeVisible();
		await expect(dialog.getByTestId('sync-budget')).toBeVisible();

		const stated = await dialog.locator('[data-budget="files"]').innerText();
		const [, uploads, total] = stated.match(/(\d+) of (\d+) files need uploading/) ?? [];

		await publishToRemote(page, dialog);

		const arrived = github.files(OWNER, REPOSITORY);
		expect(arrived).toContain('index.html');
		expect(Number(total)).toBe(arrived.length - 1);
		// ⚠ **Fewer blobs than files, and the gap is the claim.** Two paths holding the same bytes are
		// one `POST /git/blobs` between them — every empty file in the site is byte-identical to every
		// other — so a forecast that counted paths would send a scholar to wait for a rate-limit reset
		// they were never going to meet.
		expect(Number(uploads)).toBeLessThan(Number(total));
		await expect(page.getByTestId('sync-status')).toContainText(`${uploads} of them uploaded`);
	});

	test('stops legibly when the budget runs out part way, leaving the site as it was', async ({
		page
	}) => {
		// Enough for the sign-in, both plans and a handful of blobs, and not enough for the bundle.
		// Nothing is visible on a Remote until the ref moves, so an interrupted publish has to leave the
		// site exactly as it was rather than half replaced.
		const github = await start(page, {
			hosts: {
				repositories: [
					{ owner: OWNER, name: REPOSITORY, rateLimit: { remaining: 20, reset: RESET_AT } }
				]
			}
		});
		const before = github.files(OWNER, REPOSITORY);
		const commit = github.head(OWNER, REPOSITORY);
		const dialog = await signedIn(page);
		await expect(dialog.getByTestId('sync-site-breakdown')).toBeVisible();

		await dialog.getByTestId('sync-send').click();

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
		await expect(page.getByTestId('sync-failure')).toContainText('written into this Workspace');
	});

	// An unbound Workspace must be connected to a GitHub repository before publishing is offered —
	// and with one door, that is what the door *lands on* rather than a refusal a publish dialog
	// gives after the fact (ADR-0041). A Workspace with nowhere to publish has no Publish to press.
	test('lands on connecting, not on publishing, for a Workspace bound to nothing', async ({
		page
	}) => {
		const github = await routeGitHubOnce(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY }]
		});
		// Signed out as well as unbound, which is the state a Workspace with nowhere to publish is
		// actually in: nothing has asked this author for a credential yet.
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' }), {
			unbound: true,
			signedIn: false
		});

		await expect(page.getByTestId('connect-to-github')).toHaveText('Sync with GitHub');
		await openTheDoor(page);

		// The path to a repository, and no publish anywhere on it: there is nowhere to send this
		// Workspace, so nothing offers to.
		await expect(page.getByTestId('connect-needs-account')).toBeVisible();
		await expect(page.getByTestId('connect-sync')).toBeHidden();
		await expect(page.getByTestId('sync-send')).toHaveCount(0);
		// ⚠ **And nothing is asked of GitHub to find that out.** A Workspace with nowhere to publish
		// is asked for no credential at all until the author says they have an account, because a
		// credential would answer a question nobody has yet put. The *signed-out bound* state is the
		// test below and the one in `editor-github-signin.e2e.ts`.
		expect(github.requests).toEqual([]);
	});

	/**
	 * A bound Workspace without a credential is offered the sign-in, and publishing is not offered.
	 *
	 * ⚠ **One door, and on this deployment it is not a token field**. The credential
	 * is this tab's and the binding is not, so this is where a bound Workspace reopened in a fresh tab
	 * lands — an ordinary arrival, and the last place in the editor with a credential to ask a student
	 * for at all. Which door is offered comes from
	 * `WorkspaceStorage.signInWithGitHubOffered`, and the round trip behind it is driven for real in
	 * `editor-github-signin.e2e.ts`; what is asserted here is that the field is *absent* rather than
	 * empty or disabled, and that nothing was asked of GitHub to find that out.
	 */
	test('requires sign-in before publishing a bound Workspace', async ({ page }) => {
		const github = await start(page);

		const dialog = await openSyncFromTheBar(page);
		await expect(dialog.getByTestId('sync-sign-in-needed')).toContainText(REMOTE);
		await expect(dialog.getByTestId('sync-sign-in-with-github')).toBeVisible();
		await expect(dialog.getByTestId('sync-token-field')).toHaveCount(0);
		await expect(dialog.getByTestId('sync-send')).toHaveCount(0);
		expect(github.requests).toEqual([]);
	});

	/**
	 * The credential that reaches a repository and cannot push to it.
	 *
	 * ⚠ **This test used to press through to a refusal, and it cannot any more — by design**
	 * (ADR-0043). A read-only collaborator is offered no publish affordance at all: the door
	 * is the only way to the publish dialog (ADR-0041), and the door withdraws **Publish…** once
	 * GitHub has said this sign-in may not write there. So the claim this test carries is now the
	 * *absence*, which is the stronger one — a control that will certainly refuse is worse than no
	 * control — and the engine's own refusal before a byte moves stays asserted at Seam 1, in
	 * `publish-to-remote.test.ts`'s permission check.
	 *
	 * What only a browser can settle is that the real `WorkspaceStorage` reads the real rights off the
	 * bound Remote and the bar's one GitHub control acts on them.
	 */
	test('offers no way to publish at all where the sign-in may not push', async ({ page }) => {
		const github = await start(page, {
			hosts: { repositories: [{ owner: OWNER, name: REPOSITORY, push: false }] }
		});
		const before = github.head(OWNER, REPOSITORY);

		await seedGitHubCredential(page, TOKEN);
		await page.reload();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
		await openTheDoor(page);

		// The relationship stated once, where the author is standing, rather than discovered at a
		// refusal after the whole website has been written into the Workspace.
		await expect(page.getByTestId('pull-only-remote')).toContainText('you cannot publish to it');
		await expect(page.getByTestId('connect-sync')).toHaveCount(0);
		// The way forward is on the same screen as the limitation.
		await expect(page.getByTestId('publish-to-your-own')).toBeVisible();
		expect(github.head(OWNER, REPOSITORY)).toBe(before);

		// And getting is untouched: taking changes from a repository needs no write access, so the
		// Sync modal offers that one choice and none of the three that send (ADR-0044).
		await closeTheDoor(page);
		await openSyncModal(page);
		const modal = page.getByRole('dialog', { name: 'Sync with GitHub' });
		await expect(modal.getByTestId('sync-read-only')).toContainText('cannot write to it');
		await expect(modal.getByTestId('sync-get')).toBeVisible();
		await expect(modal.getByTestId('sync-send')).toHaveCount(0);
		await expect(modal.getByTestId('sync-both')).toHaveCount(0);
		await expect(modal.getByTestId('sync-arm-overwrite')).toHaveCount(0);
		await expect(modal.getByTestId('to-send')).toHaveCount(0);
	});

	/**
	 * The result renders **outside** the dialog, on a bar that is on every screen.
	 *
	 * So closing is not what makes it stale — switching Workspace is. "Published … Sent to ada/atlas"
	 * left under the bar of the Workspace a scholar has just switched to is a statement about that
	 * Workspace, and it is false.
	 */
	test('leaves no result from one Workspace standing under the bar of the next', async ({
		page
	}) => {
		await start(page);
		await publishToRemote(page, await signedIn(page));
		await expect(page.getByTestId('sync-status')).toContainText(`Sent to ${REMOTE}`);

		await createWorkspace(page, 'Marking 2026');

		await expect(page.getByTestId('sync-status')).toHaveCount(0);
		await expect(page.getByTestId('sync-stale')).toHaveCount(0);
		await expect(page.getByTestId('sync-failure')).toHaveCount(0);
	});

	/**
	 * The stale sign-in, and where its refusal arrives.
	 *
	 * Rights are read at a bind and at a paste and at no other moment, so the door's "Signed in to
	 * GitHub" means *a credential is held*, never *a credential still works*. The sentence is left
	 * alone and the **refusal** carries it instead. It arrives on opening the dialog, because planning
	 * is the first credentialed request a publish makes and it sends nothing — so a scholar meets it
	 * with the Remote untouched rather than after four thousand tiles have gone.
	 */
	test('says the sign-in has expired, offers the way back in, and forgets the credential', async ({
		page
	}) => {
		const github = await start(page);
		// Waited out rather than merely started: the forecast that follows a sign-in is what would meet
		// the revoked token below, and closing the dialog on top of one still in flight would be a test
		// asserting a race rather than the behaviour.
		await expect((await signedIn(page)).getByTestId('sync-budget')).toBeVisible();
		await page.keyboard.press('Escape');
		await expectCredential(page, 'Signed in to GitHub');

		// The token is revoked on GitHub's side while the tab still holds it — which is the situation,
		// and which nothing in this browser can notice until it next asks. A second fake, installed
		// later and therefore consulted first, is how that is arranged: Playwright takes the most
		// recently registered matching handler.
		const revoked = await routeGitHubHosts(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY }],
			rejectCredential: true
		});

		const dialog = await openSyncFromTheBar(page);

		const refusal = dialog.getByTestId('sync-problem');
		await expect(refusal).toContainText('sign-in has expired');
		await expect(refusal).toContainText(REMOTE);
		// Not "GitHub refused this publish", which sends a scholar off to check a repository that is
		// perfectly fine — and not a byte sent finding out.
		await expect(refusal).not.toContainText('Bad credentials');
		expect(revoked.blobPosts()).toBe(0);
		expect(github.files(OWNER, REPOSITORY)).toEqual(['README.md']);

		// And the credential is forgotten rather than merely reported on, so the door back in is on the
		// screen beside the refusal — the menu tells the truth from here on, because there is now
		// genuinely no credential held. On this deployment that door is the sign-in and never a token
		// field: an expiry is not an occasion to ask a student to choose between two credentials.
		await expect(dialog.getByTestId('sync-sign-in-with-github')).toBeVisible();
		await expect(dialog.getByTestId('sync-token-field')).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expectCredential(page, 'Not signed in');
	});
});
