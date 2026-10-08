import { expect, test, type Locator, type Page } from './support/test.js';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	GITHUB_API_ORIGIN,
	routeGitHubHosts,
	type GitHubHosts,
	type FakeRepository,
	type GitHubHostsOptions,
	OWNER,
	REPOSITORY,
	REMOTE,
	TOKEN,
	reloadOnTheHub,
	reloadSignedIn,
	seed,
	syncDialog
} from './support/github-hosts.js';
import { projectNameField } from './support/project-screen.js';
import { asJson, writeSiteFile } from './support/published-site.js';
import { serveDirectory, type StaticSite } from './support/static-site.js';
import {
	closeWorkspaceDialog,
	createWorkspace,
	expectCredential,
	openRepositorySettings,
	openSyncModal,
	openTheDoor,
	readBaseline,
	seedGitHubCredential,
	seedRemoteRelationship,
	emptyWorkspace
} from './support/workspace.js';

test.beforeEach(async ({ page }) => routeBaseMapArchive(page));

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

const decode = (base64: string) => Buffer.from(base64, 'base64').toString('utf8');
const sha256 = (base64: string) =>
	createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
const siteRecordOf = async (page: Page) =>
	JSON.parse(decode((await takeWorkspace(page))['ballastella-site.json']!));

const projectFiles = (
	directory: string,
	fields: { name: string; referenced?: boolean; onFrontPage?: boolean }
): Record<string, string> => ({
	[`${directory}/project.json`]: asJson({
		formatVersion: 1,
		name: fields.name,
		updatedAt: '2026-01-02T03:04:05.000Z',
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
		baseMapAppearance: { streets: false, relief: true, highContrast: false }
	}),
	[`${directory}/annotations/l2.geojson`]: '{"type":"FeatureCollection","features":[]}',
	'alignments/aaa.json': '{"type":"Annotation","id":"aaa"}',
	...(fields.referenced
		? {
				'images/aaa/remote.json': asJson({
					service: 'https://tile.loc.gov/image-services/iiif/service:gmd:sheet',
					label: 'Blaeu’s plan, from the library',
					partOf: '',
					canvas: '',
					rights: '',
					attribution: '',
					width: 1024,
					height: 768
				})
			}
		: {
				'images/aaa/info.json': asJson({
					'@context': 'http://iiif.io/api/image/3/context.json',
					id: 'https://unset.invalid/aaa',
					type: 'ImageService3',
					protocol: 'http://iiif.io/api/image',
					profile: 'level0',
					width: 1024,
					height: 768,
					tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4] }]
				}),
				'images/aaa/0,0,256,256/256,256/0/default.jpg': 'stands in for a tile'
			})
});

const AMSTERDAM = projectFiles('amsterdam-1625', { name: 'Amsterdam 1625' });

async function openWorkspace(
	page: Page,
	files: Record<string, string>,
	{
		unbound = false,
		signedIn = true,
		hosts
	}: { unbound?: boolean; signedIn?: boolean; hosts?: GitHubHostsOptions } = {}
): Promise<GitHubHosts> {
	const github = await routeGitHubHosts(page, {
		repositories: [{ owner: OWNER, name: REPOSITORY }],
		...hosts
	});
	await page.goto('./');
	await emptyWorkspace(page);
	await seed(page, files);
	if (!unbound) await seedRemoteRelationship(page, { owner: OWNER, repository: REPOSITORY });
	if (signedIn) await seedGitHubCredential(page, TOKEN);
	await reloadOnTheHub(page);
	return github;
}

async function openSyncFromTheBar(page: Page): Promise<Locator> {
	await openSyncModal(page);
	return syncDialog(page);
}

async function openSyncModalWithShareLinks(page: Page): Promise<Locator> {
	await openRepositorySettings(page);
	const offer = page.getByTestId('enable-pages');
	if ((await offer.count()) > 0) {
		await offer.click();
		await expect(page.getByTestId('pages-enabled')).toBeVisible({ timeout: 60_000 });
	}
	await closeWorkspaceDialog(page);
	const dialog = await openSyncFromTheBar(page);
	await expect(dialog.getByTestId('sync-modal')).toBeVisible();
	return dialog;
}

async function sync(page: Page, dialog?: Locator) {
	dialog ??= await openSyncModalWithShareLinks(page);
	await expect(dialog.getByTestId('sync-budget')).toBeVisible({ timeout: 60_000 });
	await dialog.getByTestId('sync-send').click();
	await expect(page.getByTestId('sync-status')).toContainText('Sent to', { timeout: 30_000 });
}

test.describe('syncing a Workspace', () => {
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

	async function servePublished(page: Page): Promise<{ root: StaticSite; subpath: StaticSite }> {
		const directory = await mkdtemp(path.join(tmpdir(), 'ballastella-served-'));
		directories.push(directory);
		for (const [relative, base64] of Object.entries(await takeWorkspace(page))) {
			await writeSiteFile(directory, relative, Buffer.from(base64, 'base64'));
		}
		const root = await serveDirectory(directory, '');
		const subpath = await serveDirectory(directory, '/student/atlas-2026');
		sites.push(root, subpath);
		return { root, subpath };
	}

	test('states the Base Map’s size, announces progress in the modal, and writes only relative references', async ({
		page
	}) => {
		await openWorkspace(page, AMSTERDAM);
		const dialog = await openSyncModalWithShareLinks(page);
		await expect(dialog.getByTestId('sync-site-breakdown')).toContainText(/[0-9.]+ (kB|MB)/);

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
				return { progress: region('sync-progress'), result: region('toast-stack') };
			})
		).toEqual({
			progress: { insideTheModal: true, live: 'polite', atomic: 'true' },
			result: { insideTheModal: false, live: 'polite', atomic: null }
		});

		await page.route('**/viewer-bundle/**', async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 200));
			await route.continue();
		});
		await expect(dialog.getByTestId('sync-budget')).toBeVisible({ timeout: 60_000 });
		await dialog.getByTestId('sync-send').click();
		await expect(dialog.getByTestId('sync-progress')).toContainText(
			/Writing the viewer: \d+ of \d+ files\./
		);
		await expect(page.getByTestId('sync-status')).toContainText('Sent to', { timeout: 60_000 });
		await expect(page.getByTestId('sync-progress')).toHaveText('');

		const taken = await takeWorkspace(page);
		const inspected = Object.keys(taken).filter((relative) =>
			/\.(html|css|js|json)$/.test(relative)
		);
		const offenders = inspected.flatMap((relative) =>
			[...decode(taken[relative]!).matchAll(/(?:src|href)="\/[^"]*"/g)].map(
				(match) => `${relative}: ${match[0]}`
			)
		);
		expect(offenders).toEqual([]);
		expect(inspected).toContain('index.html');
		expect(inspected.filter((relative) => relative.startsWith('_app/')).length).toBeGreaterThan(5);
		const baseMap = Object.keys(taken).filter((relative) => relative.startsWith('base-map/'));
		expect(baseMap.length).toBeGreaterThan(1);
		expect(baseMap.some((relative) => /\.(html|css|js|json)$/.test(relative))).toBe(true);
		expect(baseMap.some((relative) => relative.endsWith('.pmtiles'))).toBe(false);
	});

	test('always syncs Base Map assets for a legacy site', async ({ page }) => {
		await openWorkspace(page, {
			...AMSTERDAM,
			'ballastella-site.json': asJson({
				formatVersion: 2,
				viewerVersion: 'whatever',
				publishedAt: '2026-01-01T00:00:00.000Z',
				projects: [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }],
				baseMapBundled: false,
				baseMapAssetsBundled: false
			})
		});
		const dialog = await openSyncModalWithShareLinks(page);
		await expect(dialog.getByTestId('sync-site-breakdown')).toBeVisible();
		await sync(page, dialog);
		expect(
			Object.keys(await takeWorkspace(page)).some((path) => path.startsWith('base-map/'))
		).toBe(true);
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
		await sync(page, dialog);

		const { root } = await servePublished(page);
		await page.goto(`${root.url}?p=amsterdam-1625`);

		await expect(page.getByTestId('project-needs-network')).toContainText('Blaeu’s plan');
		expect(root.failures).toEqual([{ path: '/images/aaa/info.json', status: 404 }]);
	});

	test('a second Sync extends the hub page, refreshes a stale version stamp, and leaves the first Project untouched', async ({
		page
	}) => {
		await openWorkspace(
			page,
			projectFiles('amsterdam-1625', { name: 'Amsterdam 1625', onFrontPage: true })
		);
		await sync(page);
		const firstProject = await takeWorkspace(page);
		const stamped = await siteRecordOf(page);
		expect(stamped.viewerVersion).toMatch(/^[0-9a-f]{16}$/);

		await seed(page, {
			...projectFiles('boston-1775', { name: 'Boston 1775', onFrontPage: true }),
			'ballastella-site.json': JSON.stringify({ ...stamped, viewerVersion: 'an-older-viewer' })
		});
		await page.reload();
		await expect(page.getByRole('link', { name: 'Boston 1775' })).toBeVisible();
		await openSyncModalWithShareLinks(page);
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('sync-stale')).toContainText('an older version of the viewer');

		await sync(page);

		expect((await siteRecordOf(page)).viewerVersion).toBe(stamped.viewerVersion);
		await expect(page.getByTestId('sync-stale')).toBeHidden();
		const after = await takeWorkspace(page);
		const amsterdam = Object.keys(firstProject).filter((path) =>
			/^(amsterdam-1625|images|alignments)\//.test(path)
		);
		expect(amsterdam.length).toBeGreaterThan(3);
		for (const relative of amsterdam) {
			expect(sha256(after[relative]!), relative).toBe(sha256(firstProject[relative]!));
		}

		const { subpath } = await servePublished(page);
		await page.goto(subpath.url);

		await expect(page.getByTestId('front-page-projects')).toContainText('Amsterdam 1625');
		await expect(page.getByTestId('front-page-projects')).toContainText('Boston 1775');
		expect(subpath.failures).toEqual([]);
	});

	test('renders a Project’s name as text, never as markup, on the published site', async ({
		page
	}) => {
		const payload =
			'Amsterdam <img src=x onerror="window.pwned=1"> 1625<script>window.pwned=1</script>';
		await openWorkspace(page, projectFiles('amsterdam-1625', { name: payload, onFrontPage: true }));
		await sync(page);

		const { root } = await servePublished(page);
		const failures: string[] = [];
		page.on('pageerror', (error) => failures.push(error.message));
		await page.goto(root.url);

		await expect(page.getByTestId('front-page-projects')).toContainText(payload);
		expect(
			await page.evaluate(() => {
				const host = document.querySelector('[data-testid="front-page-projects"]');
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

	test('reads “Saved here” beside Sync, and is still the only status region', async ({ page }) => {
		await openWorkspace(page, AMSTERDAM);

		await expect(page.getByRole('status')).toContainText('Saved here');
		await expect(page.getByTestId('connect-to-github')).toBeVisible();

		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		await expect(page.getByTestId('connect-to-github')).toBeVisible();

		await page.evaluate(() => {
			const indicator = document.querySelector('[data-save-state]');
			if (!indicator) throw new Error('no [data-save-state] element to observe');
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

const RESET_AT = 1_800_000_000;

test.describe('syncing to a Remote', () => {
	const start = (page: Page, hosts?: GitHubHostsOptions) =>
		openWorkspace(page, AMSTERDAM, { signedIn: false, hosts });

	const withRepository = (fields: Partial<FakeRepository>) => ({
		repositories: [{ owner: OWNER, name: REPOSITORY, ...fields }]
	});

	const EXTRA_FILES = {
		files: { 'README.md': '# Atlas\n', CNAME: 'atlas.example\n', 'docs/guide.md': 'How to\n' }
	};

	async function signedIn(page: Page) {
		await reloadSignedIn(page);
		return openSyncModalWithShareLinks(page);
	}

	async function sendToRemote(page: Page, dialog: Locator) {
		await expect(dialog.getByTestId('sync-site-breakdown')).toBeVisible();
		await dialog.getByTestId('sync-send').click();
		await expect(page.getByTestId('sync-status')).toContainText(`Sent to ${REMOTE}`, {
			timeout: 120_000
		});
	}

	test('sends the Workspace, .nojekyll and all; then has nothing to resend, and clears for the next Workspace', async ({
		page
	}) => {
		const github = await start(page, withRepository(EXTRA_FILES));
		const dialog = await signedIn(page);
		await expect(dialog.getByTestId('sync-budget')).toBeVisible();

		await sendToRemote(page, dialog);

		const arrived = github.files(OWNER, REPOSITORY);
		expect(arrived).toEqual(
			expect.arrayContaining([
				'.nojekyll',
				'index.html',
				'ballastella-site.json',
				'amsterdam-1625/project.json',
				'images/aaa/0,0,256,256/256,256/0/default.jpg',
				'CNAME',
				'README.md',
				'docs/guide.md'
			])
		);
		expect(arrived.filter((path) => path.startsWith('_app/')).length).toBeGreaterThan(5);
		expect(github.fileText(OWNER, REPOSITORY, 'images/aaa/0,0,256,256/256,256/0/default.jpg')).toBe(
			'stands in for a tile'
		);
		expect(github.fileText(OWNER, REPOSITORY, 'CNAME')).toBe('atlas.example\n');
		expect(github.fileText(OWNER, REPOSITORY, 'docs/guide.md')).toBe('How to\n');
		const baseline = await readBaseline(page);
		expect(baseline?.commit).toBe(github.head(OWNER, REPOSITORY));
		expect(baseline?.files.sort()).toEqual([
			'alignments/aaa.json',
			'amsterdam-1625/annotations/l2.geojson',
			'amsterdam-1625/project.json',
			'images/aaa/0,0,256,256/256,256/0/default.jpg',
			'images/aaa/info.json'
		]);

		const sent = github.blobPosts();
		const commit = github.head(OWNER, REPOSITORY);
		const again = await openSyncFromTheBar(page);
		await expect(again.getByTestId('sync-nothing-to-do')).toContainText(REMOTE);
		await expect(again.getByTestId('sync-send')).toHaveAttribute('aria-disabled', 'true');
		expect(github.blobPosts() - sent).toBe(0);
		expect(github.head(OWNER, REPOSITORY)).toBe(commit);

		await page.keyboard.press('Escape');
		await createWorkspace(page, 'Marking 2026');
		for (const testid of ['sync-status', 'sync-stale', 'sync-failure']) {
			await expect(page.getByTestId(testid)).toHaveCount(0);
		}
	});

	test('states the file count it will send, announces progress against it, and keeps focus', async ({
		page
	}) => {
		const github = await start(page);
		const dialog = await signedIn(page);
		await expect(dialog.getByTestId('sync-site-breakdown')).toBeVisible();
		await expect(dialog.getByTestId('sync-budget')).toBeVisible();
		const stated = await dialog.locator('[data-budget="files"]').innerText();
		const [, uploads, total] = stated.match(/(\d+) of (\d+) files need uploading/) ?? [];
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
		const announced = Number(/of (\d+) files/.exec((await progress.textContent()) ?? '')?.[1]);
		expect(announced).toBeGreaterThan(0);
		const door = page.getByTestId('connect-to-github');
		await expect(door).toHaveAttribute('aria-disabled', 'true');
		await expect(door).toContainText(/(Writing the viewer|Sending)… \d+\/\d+/);
		expect(await page.evaluate(() => document.activeElement?.tagName ?? 'NONE')).not.toBe('BODY');

		await expect(page.getByTestId('sync-status')).toContainText(`Sent to ${REMOTE}`, {
			timeout: 120_000
		});
		await expect(page.getByTestId('sync-status')).toBeVisible();
		await expect(page.getByTestId('sync-status')).toContainText(`${uploads} of them uploaded`);
		await expect(syncDialog(page)).toBeHidden();
		await expect(page.getByTestId('sync-progress')).toHaveText('');
		const arrived = github.files(OWNER, REPOSITORY);
		expect(arrived).toContain('index.html');
		expect(Number(total)).toBe(arrived.length - 1);
		expect(Number(uploads)).toBeLessThan(Number(total));
		expect(github.blobPosts()).toBe(announced);
	});

	test('refuses a truncated tree, quoting the file count, and sends nothing', async ({ page }) => {
		const github = await start(page, withRepository({ ...EXTRA_FILES, truncateAfter: 3 }));
		const before = github.files(OWNER, REPOSITORY);
		const dialog = await signedIn(page);
		const refusal = dialog.getByTestId('sync-problem');
		await expect(refusal).toContainText('first 2 files');
		await expect(refusal).toContainText('deleting Map Images no Project uses');
		expect(github.blobPosts()).toBe(0);
		expect(github.files(OWNER, REPOSITORY)).toEqual(before);

		await page.keyboard.press('Escape');
		await expect(syncDialog(page)).toBeHidden();
		const refusalToast = page.getByTestId('sync-failure');
		await expect(page.locator('.toast')).toContainText('first 2 files');
		await expect(refusalToast).toContainText('first 2 files');
		await refusalToast.getByRole('button', { name: 'Dismiss' }).click();
		await expect(refusalToast).toHaveCount(0);
	});

	test('warns before starting when it needs more requests than remain, naming the reset', async ({
		page
	}) => {
		await start(page, withRepository({ rateLimit: { remaining: 15, reset: RESET_AT } }));

		const dialog = await signedIn(page);
		const warning = dialog.locator('[data-remote-warning="request-budget"]');
		await expect(warning).toContainText('requests in all');
		await expect(warning).toContainText(/\d{1,2}:\d{2}/);
		await expect(dialog.locator('[data-budget="requests"]')).toContainText(/\d{1,2}:\d{2}/);
		await expect(dialog.locator('[data-budget="files"]')).toContainText('need uploading');
		await expect(dialog.locator('[data-budget="bytes"]')).toContainText(
			/the repository would hold\s+[\d.]+ (bytes|kB|MB|GB) \/ 1\.0 GB\s+GitHub Pages limit\./
		);
	});

	test('stops legibly when the budget runs out part way, leaving the site as it was', async ({
		page
	}) => {
		const github = await start(
			page,
			withRepository({ rateLimit: { remaining: 20, reset: RESET_AT } })
		);
		const before = github.files(OWNER, REPOSITORY);
		const commit = github.head(OWNER, REPOSITORY);
		const dialog = await signedIn(page);
		await expect(dialog.getByTestId('sync-site-breakdown')).toBeVisible();

		await dialog.getByTestId('sync-send').click();

		const stopped = dialog.getByRole('alert').first();
		await expect(stopped).toContainText('hourly request budget ran out', { timeout: 120_000 });
		await expect(stopped).toContainText(/\d{1,2}:\d{2}/);
		await expect(stopped).toContainText('Nothing has been sent');
		expect(github.files(OWNER, REPOSITORY)).toEqual(before);
		expect(github.head(OWNER, REPOSITORY)).toBe(commit);

		await page.keyboard.press('Escape');
		await expect(page.getByTestId('sync-failure')).toContainText('written into this Workspace');
	});

	test('lands on connecting, not on syncing, for a Workspace bound to nothing', async ({
		page
	}) => {
		const github = await openWorkspace(page, AMSTERDAM, { unbound: true, signedIn: false });

		await expect(page.getByTestId('connect-to-github')).toHaveText('Sync with GitHub');
		await openTheDoor(page);

		await expect(page.getByTestId('connect-needs-account')).toBeVisible();
		await expect(page.getByTestId('sync-send')).toHaveCount(0);
		expect(github.requests).toEqual([]);
	});

	test('requires sign-in before sending from a bound Workspace', async ({ page }) => {
		const github = await start(page);
		const dialog = await openSyncFromTheBar(page);
		await expect(dialog.getByTestId('sync-sign-in-needed')).toContainText(REMOTE);
		await expect(dialog.getByTestId('sync-sign-in-with-github')).toBeVisible();
		await expect(dialog.getByTestId('sync-get')).toBeVisible();
		for (const absent of ['sync-token-field', 'sync-send', 'sync-reading']) {
			await expect(dialog.getByTestId(absent)).toHaveCount(0);
		}
		expect(
			github.requests.filter((path) => !path.startsWith(`/repos/${OWNER}/${REPOSITORY}`))
		).toEqual([]);
	});

	test('offers no way to Sync at all where the sign-in may not push', async ({ page }) => {
		const github = await start(page, withRepository({ push: false }));
		const before = github.head(OWNER, REPOSITORY);

		await reloadSignedIn(page);
		await openRepositorySettings(page);

		await expect(page.getByTestId('read-only-remote')).toContainText('you cannot send to it');
		await expect(page.getByTestId('change-repository')).toBeVisible();
		expect(github.head(OWNER, REPOSITORY)).toBe(before);

		await closeWorkspaceDialog(page);
		const modal = await openSyncFromTheBar(page);
		await expect(modal.getByTestId('sync-read-only')).toContainText('cannot write to it');
		await expect(modal.getByTestId('sync-get')).toBeVisible();
		for (const absent of ['sync-send', 'sync-both', 'sync-arm-overwrite', 'to-send']) {
			await expect(modal.getByTestId(absent)).toHaveCount(0);
		}
	});

	test('says the sign-in has expired, offers the way back in, and forgets the credential', async ({
		page
	}) => {
		const github = await start(page);
		await expect((await signedIn(page)).getByTestId('sync-budget')).toBeVisible();
		await page.keyboard.press('Escape');
		await expectCredential(page, 'Signed in to GitHub');

		const revoked = await routeGitHubHosts(page, {
			...withRepository({}),
			rejectCredential: true
		});

		const dialog = await openSyncFromTheBar(page);
		const refusal = dialog.getByTestId('sync-problem');
		await expect(refusal).toContainText('sign-in has expired');
		await expect(refusal).toContainText(REMOTE);
		await expect(refusal).not.toContainText('Bad credentials');
		expect(revoked.blobPosts()).toBe(0);
		expect(github.files(OWNER, REPOSITORY)).toEqual(['README.md']);

		await expect(dialog.getByTestId('sync-sign-in-with-github')).toBeVisible();
		await expect(dialog.getByTestId('sync-token-field')).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expectCredential(page, 'Not signed in');
	});
});
