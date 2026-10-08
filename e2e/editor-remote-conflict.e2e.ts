import {
	DEFAULT_WORKSPACE,
	expect,
	test,
	type Locator,
	type Page,
	type Route
} from './support/test.js';

import { createProject } from './support/annotations.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	GITHUB_RAW_ORIGIN,
	grantsFor,
	reloadOnTheHub,
	reloadSignedIn,
	routeGitHubHosts,
	syncDialog,
	type GitHubHosts,
	OWNER,
	REPOSITORY,
	REMOTE,
	seed
} from './support/github-hosts.js';
import {
	createWorkspace,
	doorButton,
	seedBaseline,
	seedRemoteRelationship,
	checkRemoteStatus,
	openRepositorySettings,
	openSyncModal,
	openTheDoor,
	showRemoteStatusDetail,
	getFromRemote,
	switchToWorkspace,
	emptyBrowserStorage
} from './support/workspace.js';
import { gitBlobSha } from '../packages/core/src/remote/blob-sha.js';
import { UPDATE_DOWNLOAD_CONCURRENCY } from '../packages/core/src/remote/get-from-remote.js';

test.beforeEach(async ({ page }) => routeBaseMapArchive(page));

const EMPTY_LAYER = '{"type":"FeatureCollection","features":[]}';

const annotationLayer = (id: string, name: string, order: number) => ({
	id,
	name,
	visible: true,
	order,
	kind: 'annotation',
	geojsonRef: `annotations/${id}.geojson`,
	defaultStyle: {}
});

const projectJson = (name: string, layers = [annotationLayer('l2', 'Warehouses', 0)]): string =>
	`${JSON.stringify(
		{
			formatVersion: 1,
			name,
			updatedAt: '2026-01-02T03:04:05.000Z',
			layers,
			baseMap: 'physical'
		},
		null,
		'\t'
	)}\n`;

const projectFiles = (directory: string, name: string): Record<string, string> => ({
	[`${directory}/project.json`]: projectJson(name),
	[`${directory}/annotations/l2.geojson`]: EMPTY_LAYER
});

const AMSTERDAM = projectFiles('amsterdam-1625', 'Amsterdam 1625');

const siteRecord = (projects: { directory: string; name: string }[]): string =>
	JSON.stringify({
		formatVersion: 2,
		viewerVersion: 'written-earlier',
		publishedAt: '2026-08-01T09:00:00.000Z',
		projects: projects.map((project) => ({ ...project, onFrontPage: true })),
		baseMap: { entries: [] },
		baseMapBundled: false,
		baseMapAssetsBundled: false,
		baseMapCaches: []
	});

async function start(
	page: Page,
	options: {
		workspace?: Record<string, string>;
		onRemote?: Record<string, string>;
		connected?: boolean;
		granted?: boolean;
		login?: string;
	} = {}
): Promise<GitHubHosts> {
	const github = await routeGitHubHosts(page, {
		repositories: [
			{ owner: OWNER, name: REPOSITORY, files: { 'README.md': '# Atlas\n', ...options.onRemote } }
		],
		...(options.granted ? { signIn: true, login: OWNER, grants: grantsFor() } : {}),
		...(options.login === undefined ? {} : { login: options.login })
	});
	await page.goto('./');
	await emptyBrowserStorage(page, { keepOpen: true, forget: true });
	await seed(page, options.workspace ?? {});
	if (options.connected)
		await seedRemoteRelationship(page, { owner: OWNER, repository: REPOSITORY });
	await reloadOnTheHub(page);
	return github;
}

async function sharedShas(files: Record<string, string>): Promise<Record<string, string>> {
	const encoder = new TextEncoder();
	const shas: Record<string, string> = {};
	for (const [path, text] of Object.entries(files)) {
		shas[path] = await gitBlobSha(encoder.encode(text));
	}
	return shas;
}

async function startInSync(
	page: Page,
	workspace: Record<string, string>,
	onRemote = workspace
): Promise<GitHubHosts> {
	const github = await start(page, { workspace, connected: true, onRemote });
	await seedBaseline(page, {
		owner: OWNER,
		repository: REPOSITORY,
		files: await sharedShas(onRemote)
	});
	await reloadOnTheHub(page);
	await signedIn(page);
	await page.keyboard.press('Escape');
	await expect(remoteStatus(page)).toContainText('in sync with ada/atlas');
	return github;
}

const openSync = async (page: Page) => {
	await openSyncModal(page);
	const dialog = syncDialog(page);
	await expect(dialog.getByTestId('sync-budget')).toBeVisible({ timeout: 60_000 });
	return dialog;
};

async function signedIn(page: Page) {
	await reloadSignedIn(page);
	return openSync(page);
}

async function send(page: Page, dialog: Locator): Promise<void> {
	await dialog.getByTestId('sync-send').click();
	await expect(page.getByTestId('sync-status')).toContainText(`Sent to ${REMOTE}`, {
		timeout: 120_000
	});
}

async function newProject(page: Page, name: string): Promise<void> {
	await createProject(page, name);
	await expect(page.getByRole('link', { name })).toBeVisible();
}

const remoteStatus = (page: Page) => page.getByTestId('where-your-work-is');

async function checkNow(page: Page): Promise<void> {
	await checkRemoteStatus(page);
	await expect(remoteStatus(page)).not.toContainText('Checking…');
}

const refocus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

const listings = (github: GitHubHosts) =>
	github.requests.filter((path) => path.includes('/git/trees/')).length;

async function settledListings(page: Page, github: GitHubHosts): Promise<number> {
	let previous = -1;
	for (let sample = 0; sample < 40; sample += 1) {
		const now = listings(github);
		if (now === previous) return now;
		previous = now;
		await page.waitForTimeout(250);
	}
	throw new Error('The tree-listing count never settled.');
}

async function hold(page: Page, url: string): Promise<() => void> {
	let release: (() => void) | undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(url, async (route) => {
		await held;
		await route.fallback();
	});
	return () => release?.();
}

test.describe('connecting to a Remote that already carries Projects', () => {
	for (const { title, workspace, onRemote, toGet } of [
		{
			title: 'connects to one holding Projects this Workspace has not got',
			workspace: AMSTERDAM,
			onRemote: {
				'ballastella-site.json': siteRecord([
					{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' },
					{ directory: 'florida-1657', name: 'Florida 1657' }
				]),
				'florida-1657/project.json': '{"formatVersion":1,"name":"Florida 1657"}'
			},
			toGet: 'florida-1657'
		},
		{
			title: 'goes ahead when the Remote’s Projects are all here',
			workspace: { ...AMSTERDAM, ...projectFiles('florida-1657', 'Florida 1657') },
			onRemote: {
				'ballastella-site.json': siteRecord([
					{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }
				]),
				'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam 1625"}'
			},
			toGet: null
		}
	]) {
		test(title, async ({ page }) => {
			await start(page, { granted: true, workspace, onRemote });
			await reloadSignedIn(page);

			await openTheDoor(page);
			await page.getByTestId('choose-repository').first().click();
			await expect(page.getByTestId('sync-modal')).toBeVisible({ timeout: 30_000 });

			if (toGet) {
				const dialog = syncDialog(page);
				await expect(dialog.getByTestId('sync-budget')).toBeVisible({ timeout: 60_000 });
				await expect(dialog.getByTestId('to-get')).toContainText(toGet);
				await expect(dialog.getByTestId('to-send-removals')).toHaveCount(0);
			}

			await page.keyboard.press('Escape');
			await expect(doorButton(page)).toHaveText('Sync');
		});
	}
});

test.describe('a send against a Remote this browser has never seen', () => {
	test('leaves what it cannot attribute alone, and sends this Workspace’s work anyway', async ({
		page
	}) => {
		const github = await start(page, {
			workspace: AMSTERDAM,
			connected: true,
			onRemote: {
				'ballastella-site.json': siteRecord([
					{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }
				]),
				'florida-1657/project.json': '{"formatVersion":1,"name":"sent elsewhere"}',
				'index.html': '<!doctype html><title>Written earlier</title>'
			}
		});

		const dialog = await signedIn(page);
		await expect(dialog.getByTestId('to-get')).toContainText('florida-1657');
		for (const absent of ['to-send-removals', 'to-get-removals', 'sync-conflicts']) {
			await expect(dialog.getByTestId(absent)).toHaveCount(0);
		}

		await send(page, dialog);

		expect(github.fileText(OWNER, REPOSITORY, 'florida-1657/project.json')).toBe(
			'{"formatVersion":1,"name":"sent elsewhere"}'
		);
		expect(github.files(OWNER, REPOSITORY)).toContain('amsterdam-1625/project.json');
	});

	test('says nothing needs changing when the Remote matches, even with no record of sending it', async ({
		page
	}) => {
		const github = await start(page, { workspace: AMSTERDAM, connected: true });
		await send(page, await signedIn(page));
		const commit = github.head(OWNER, REPOSITORY);

		await page.evaluate(() => localStorage.clear());
		await reloadOnTheHub(page);

		const dialog = await openSync(page);
		await expect(dialog.getByTestId('sync-nothing-to-do')).toContainText(REMOTE);
		await expect(dialog.getByTestId('sync-conflicts')).toHaveCount(0);
		await expect(dialog.getByTestId('sync-send')).toHaveAttribute('aria-disabled', 'true');
		expect(github.head(OWNER, REPOSITORY)).toBe(commit);
	});

	test('leaves the file another machine wrote alone, and offers it under To get', async ({
		page
	}) => {
		const theirs = '{"type":"FeatureCollection","features":[{"id":"a-whole-afternoon"}]}';
		const github = await start(page, { workspace: AMSTERDAM, connected: true });
		await send(page, await signedIn(page));

		await github.commitFiles(OWNER, REPOSITORY, {
			'amsterdam-1625/annotations/l2.geojson': theirs
		});
		await newProject(page, 'Delft');

		const dialog = await openSync(page);
		await expect(dialog.getByTestId('to-get')).toContainText('Amsterdam 1625');
		await expect(dialog.getByTestId('to-send')).toContainText('Delft');
		await expect(dialog.getByTestId('to-send-removals')).toHaveCount(0);

		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(doorButton(page)).toBeFocused();

		await send(page, await openSync(page));

		expect(github.fileText(OWNER, REPOSITORY, 'amsterdam-1625/annotations/l2.geojson')).toBe(
			theirs
		);
		expect(github.files(OWNER, REPOSITORY)).toContain('delft/project.json');
		await expect(remoteStatus(page)).toContainText('changes to get');
	});

	test('names what an overwrite would remove from a shared Remote, and will not proceed until told', async ({
		page
	}) => {
		const github = await start(page, { workspace: AMSTERDAM, connected: true, login: 'grace' });
		await send(page, await signedIn(page));

		await github.commitFiles(OWNER, REPOSITORY, {
			'florida-1657/project.json': '{"formatVersion":1,"name":"Florida 1657"}',
			'florida-1657/annotations/l1.geojson': EMPTY_LAYER
		});

		const dialog = await openSync(page);
		await expect(dialog.getByTestId('sync-overwrite-removals')).toContainText('florida-1657');
		await dialog.getByTestId('sync-arm-overwrite').click();

		const preview = dialog.getByTestId('sync-shared-remote');
		await expect(preview).toContainText(`${REMOTE} belongs to ${OWNER}, not to you`);
		await expect(preview).toContainText('the Project florida-1657');
		await expect(dialog.getByTestId('sync-overwrite')).toHaveCount(0);
		expect(github.files(OWNER, REPOSITORY)).toContain('florida-1657/project.json');

		await dialog.getByTestId('confirm-shared-overwrite').click();
		await dialog.getByTestId('sync-overwrite').click();
		await expect(page.getByTestId('sync-status')).toContainText(`Sent to ${REMOTE}`, {
			timeout: 120_000
		});

		expect(github.files(OWNER, REPOSITORY)).not.toContain('florida-1657/project.json');
		expect(github.fileText(OWNER, REPOSITORY, 'README.md')).toBe('# Atlas\n');
	});
});

test.describe('Remote Status on the navigation bar', () => {
	test('is checked explicitly and anonymously while signed out, and never polled', async ({
		page
	}) => {
		const github = await start(page, {
			workspace: AMSTERDAM,
			connected: true,
			onRemote: AMSTERDAM
		});

		await expect(remoteStatus(page)).toContainText("can't tell what's on GitHub");
		expect(listings(github)).toBe(0);

		const status = page.getByRole('status');
		await expect(status).toContainText('Saved here');
		await expect(status).toContainText('GitHub');
		await expect(status).toHaveAttribute('aria-atomic', 'true');
		await expect(status.getByTestId('where-your-work-is')).toBeVisible();

		await seedBaseline(page, {
			owner: OWNER,
			repository: REPOSITORY,
			files: await sharedShas(AMSTERDAM)
		});
		await reloadOnTheHub(page);

		await expect(remoteStatus(page)).toContainText('not checked yet');
		await refocus(page);
		await refocus(page);
		expect(listings(github)).toBe(0);

		await openRepositorySettings(page);
		await page.getByTestId('check-remote-status').focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('dialog', { name: 'Rename this Workspace' })).toBeHidden();
		await expect(remoteStatus(page)).toContainText('in sync with ada/atlas');
		await showRemoteStatusDetail(page);
		await expect(page.getByTestId('remote-status-checked')).toContainText('Checked at');
		expect(listings(github)).toBe(1);
	});

	test('follows a bound Workspace through drift, staleness and a failed check', async ({
		page
	}) => {
		const github = await startInSync(page, AMSTERDAM, {
			...AMSTERDAM,
			'index.html': '<!doctype html><title>Atlas</title>'
		});
		const afterSignIn = await settledListings(page, github);

		for (let focus = 0; focus < 3; focus += 1) await refocus(page);
		await expect(remoteStatus(page)).toContainText('in sync with ada/atlas');
		expect(listings(github)).toBe(afterSignIn);

		await github.commitFiles(OWNER, REPOSITORY, {
			'index.html': '<!doctype html><title>Atlas, rebuilt</title>'
		});
		await checkNow(page);
		await expect(remoteStatus(page)).toContainText('in sync with ada/atlas');
		await expect(page.getByTestId('published-site-stale')).toContainText(
			'The next Sync rebuilds it'
		);

		await newProject(page, 'Delft');
		await checkNow(page);
		await expect(remoteStatus(page)).toContainText('changes to send');

		const expectBothWays = async () => {
			await expect(remoteStatus(page)).toContainText('changes both ways');
			await expect(remoteStatus(page)).toHaveAttribute('data-remote-status', 'changes-both-ways');
		};
		await github.commitFiles(OWNER, REPOSITORY, {
			'amsterdam-1625/annotations/l2.geojson':
				'{"type":"FeatureCollection","features":[{"id":"theirs"}]}'
		});
		await checkNow(page);
		await expectBothWays();

		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		await expect(remoteStatus(page)).toContainText('changes both ways');
		await expect(page.getByRole('status')).toContainText('Saved here');

		await github.commitFiles(OWNER, REPOSITORY, {
			'delft/project.json': '{"formatVersion":1,"name":"Delft, theirs"}'
		});
		await checkNow(page);
		await expectBothWays();

		await showRemoteStatusDetail(page);
		const checkedBefore = await page.getByTestId('remote-status-checked').textContent();
		await page.route('https://api.github.com/**/git/trees/**', (route) =>
			route.abort('connectionfailed')
		);
		await checkRemoteStatus(page);
		const failure = page.getByTestId('remote-status-failure');
		await expect(failure).toBeVisible();
		await expect(failure).toContainText('the last one Ballastella was able to work out');
		await expect(failure).toHaveAttribute('role', 'alert');
		await expectBothWays();
		await expect(remoteStatus(page)).toContainText('Check failed');
		expect(await page.getByTestId('remote-status-checked').textContent()).toBe(checkedBefore);
		await expect(page.getByTestId('workspace-switcher')).toBeFocused();
	});

	test('cannot render one Workspace’s pending result beside another’s name', async ({ page }) => {
		await startInSync(page, AMSTERDAM);

		const release = await hold(page, 'https://api.github.com/**/git/trees/**');
		await checkRemoteStatus(page);
		await expect(remoteStatus(page)).toContainText('Checking…');

		await createWorkspace(page, 'Delft');
		release();

		await expect(page.getByTestId('remote-status-slot')).toHaveCount(0);
		await switchToWorkspace(page, DEFAULT_WORKSPACE);
		await expect(remoteStatus(page)).toContainText('in sync with ada/atlas');
	});
});

test.describe('getting a Remote’s changes', () => {
	const ATLAS = projectFiles('atlas-1625', 'Atlas 1625');
	const THEIRS = '{"type":"FeatureCollection","features":[{"id":"their-afternoon"}]}';
	const holdRawFile = (page: Page, path: string) =>
		hold(page, `https://raw.githubusercontent.com/**/${path}`);

	const INBOUND_LAYERS = Object.fromEntries(
		Array.from({ length: 12 }, (_, index) => [
			`delft/annotations/spare-${index}.geojson`,
			`{"type":"FeatureCollection","features":[{"id":"spare-${index}"}]}`
		])
	);

	async function getAndExpectBrought(page: Page): Promise<void> {
		await checkNow(page);
		await getFromRemote(page);
		await expect(page.getByTestId('update-outcome')).toContainText('Brought');
	}

	test('brings the Remote’s work in when the author asks, and never before', async ({ page }) => {
		const github = await startInSync(page, ATLAS);
		await newProject(page, 'Leiden');

		await github.commitFiles(OWNER, REPOSITORY, {
			...projectFiles('delft', 'Delft'),
			...INBOUND_LAYERS,
			'atlas-1625/annotations/l2.geojson': THEIRS
		});
		await checkNow(page);
		await expect(remoteStatus(page)).toContainText('changes both ways');

		await refocus(page);
		await checkNow(page);
		await expect(page.getByRole('link', { name: 'Delft' })).toHaveCount(0);

		const head = github.head(OWNER, REPOSITORY);
		const transferred = Object.keys(INBOUND_LAYERS).length + 3;
		const slowly = async (route: Route) => {
			await new Promise((resolve) => setTimeout(resolve, 40));
			await route.fallback();
		};
		await page.route(`${GITHUB_RAW_ORIGIN}/**`, slowly);
		const release = await holdRawFile(page, 'delft/annotations/l2.geojson');
		const modal = await openSync(page);
		await modal.getByTestId('sync-get').focus();
		await page.keyboard.press('Enter');

		const progress = modal.getByTestId('sync-progress');
		await expect(progress).toHaveText(`Getting: ${transferred - 1} of ${transferred} files.`, {
			timeout: 30_000
		});
		await expect(progress).toHaveAttribute('aria-live', 'polite');
		await expect(progress).toHaveAttribute('aria-atomic', 'true');
		expect(await page.evaluate(() => document.activeElement?.tagName ?? 'NONE')).not.toBe('BODY');
		release();
		const outcome = page.getByTestId('update-outcome');
		await expect(outcome).toContainText('Brought');
		await expect(outcome).toContainText('Nothing has been sent');
		await expect(modal).toBeHidden();

		expect(github.peakRawInFlight()).toBeLessThanOrEqual(UPDATE_DOWNLOAD_CONCURRENCY);
		expect(github.peakRawInFlight()).toBeGreaterThan(1);
		await expect(outcome).toContainText(`${transferred - 1} new files and 1 changed file`);
		expect(github.rawGets(OWNER, REPOSITORY)).toBe(transferred);
		await page.unroute(`${GITHUB_RAW_ORIGIN}/**`, slowly);

		expect(github.head(OWNER, REPOSITORY)).toBe(head);
		expect(github.fileText(OWNER, REPOSITORY, 'atlas-1625/annotations/l2.geojson')).toBe(THEIRS);
		expect(github.fileText(OWNER, REPOSITORY, 'leiden/project.json')).toBe(null);

		await expect(page.getByRole('link', { name: 'Leiden' })).toBeVisible();
		await page.getByRole('link', { name: 'Delft' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Delft');
		await expect(remoteStatus(page)).toContainText('changes to send');
		await expect(page.getByRole('status')).toContainText('Saved here');

		await github.commitFiles(OWNER, REPOSITORY, { 'atlas-1625/annotations/l9.geojson': '{}' });
		const holdAgain = await holdRawFile(page, 'atlas-1625/annotations/l9.geojson');
		await getFromRemote(page);
		await expect(page.getByTestId('sync-progress')).toContainText('Getting');
		await page.keyboard.press('Escape');
		await expect(syncDialog(page)).toBeHidden();
		await createWorkspace(page, 'Elsewhere');
		holdAgain();

		await expect(page.getByTestId('remote-status-slot')).toHaveCount(0);
		await expect(page.getByTestId('update-outcome')).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Atlas 1625' })).toHaveCount(0);
		await switchToWorkspace(page, DEFAULT_WORKSPACE);
		await expect(page.getByTestId('update-outcome')).toHaveCount(0);

		const layerRows = page.getByTestId('layer-row');
		await expect(page.getByRole('heading', { level: 1, name: 'Delft' })).toBeVisible();
		await expect(layerRows).toHaveCount(1);

		await github.commitFiles(OWNER, REPOSITORY, {
			'delft/project.json': projectJson('Delft', [
				annotationLayer('l2', 'Warehouses', 0),
				annotationLayer('l3', 'Wharves', 1)
			]),
			'delft/annotations/l3.geojson': EMPTY_LAYER
		});
		await getAndExpectBrought(page);

		await expect(layerRows).toHaveCount(2);
		await page.getByTestId('add-annotation-layer').click();
		await expect(layerRows).toHaveCount(3);
		await expect(page.getByRole('status')).toContainText('Saved here');

		await page.getByTestId('add-annotation-layer').click();
		await expect(layerRows).toHaveCount(4);
		await page.getByTestId('edit-history-undo').click();
		await expect(layerRows).toHaveCount(3);
		await expect(page.getByTestId('edit-history-undo')).toBeVisible();
		await expect(page.getByTestId('edit-history-redo')).toBeVisible();
		await expect(page.getByTestId('edit-history-outcome')).toContainText('Undone:');

		await github.commitFiles(OWNER, REPOSITORY, { 'delft/annotations/l4.geojson': EMPTY_LAYER });
		await getAndExpectBrought(page);

		await expect(page.getByTestId('edit-history-undo')).toHaveCount(0);
		await expect(page.getByTestId('edit-history-redo')).toHaveCount(0);
		await expect(page.getByTestId('edit-history-outcome')).toContainText('Undone:');

		await page.reload();
		await expect(layerRows).toHaveCount(3);
	});

	test('names what a deletion would take before anything is pressed, and then takes it', async ({
		page
	}) => {
		const github = await startInSync(page, { ...ATLAS, ...projectFiles('delft', 'Delft') });

		await github.commitFiles(OWNER, REPOSITORY, {
			'delft/project.json': null,
			'delft/annotations/l2.geojson': null
		});
		const head = github.head(OWNER, REPOSITORY);
		const dialog = await openSync(page);
		await expect(dialog.getByTestId('to-get-removals')).toBeVisible();
		await expect(dialog.getByTestId('to-get')).toContainText('Delft');

		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(doorButton(page)).toBeFocused();
		await expect(page.getByRole('link', { name: 'Delft' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Atlas 1625' })).toBeVisible();
		expect(github.head(OWNER, REPOSITORY)).toBe(head);
		await checkNow(page);
		await expect(remoteStatus(page)).toContainText('changes to get');

		await getFromRemote(page);

		await expect(page.getByTestId('update-outcome')).toContainText('Removed');
		await expect(page.getByRole('link', { name: 'Delft' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Atlas 1625' })).toBeVisible();
		await expect(remoteStatus(page)).toContainText('in sync with ada/atlas');

		await seed(page, { 'update.json': '{ not a marker' });
		await page.reload();

		await expect(page.getByTestId('unrecovered-import')).toBeVisible();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Atlas 1625' })).toHaveCount(0);
		await expect(doorButton(page)).toHaveCount(0);
	});
});
