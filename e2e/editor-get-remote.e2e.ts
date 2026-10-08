import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { asJson } from './support/published-site.js';
import {
	startOnTheHub,
	syncDialog,
	type GitHubHostsOptions,
	OUTSIDE_NAMESPACE,
	OWNER,
	REPOSITORY,
	REMOTE,
	seed
} from './support/github-hosts.js';
import {
	closeTheDoor,
	closeWorkspaceDialog,
	expectRemoteNamed,
	expectWorkspaceNamed,
	openRepositorySettings,
	openTheDoor,
	readBaseline,
	readRemoteRelationship,
	everyByteOf,
	workspaceNames,
	HUB
} from './support/workspace.js';

const PROJECT_JSON = asJson({
	formatVersion: 1,
	name: 'Amsterdam 1625',
	updatedAt: '2025-03-04T11:22:33.000Z',
	layers: [
		{
			id: 'l1',
			kind: 'annotation',
			name: 'Warehouses',
			visible: true,
			order: 0,
			geojsonRef: 'annotations/warehouses.geojson',
			defaultStyle: {}
		},
		{
			id: 'l2',
			kind: 'map',
			name: 'The 1625 plan',
			visible: true,
			order: 1,
			opacity: 1,
			imageId: 'amsterdam-1625'
		}
	],
	baseMap: null
});

const WAREHOUSES = '{"type":"FeatureCollection","features":[]}';

const ON_REMOTE: Record<string, string> = {
	'.nojekyll': '',
	'index.html': '<!doctype html><title>Atlas</title>',
	'ballastella-site.json': JSON.stringify({
		formatVersion: 2,
		projects: [],
		repository: { owner: 'someone-else', repository: 'fork', branch: 'main' }
	}),
	'amsterdam-1625/project.json': PROJECT_JSON,
	'amsterdam-1625/annotations/warehouses.geojson': WAREHOUSES,
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'stands in for a tile',
	...Object.fromEntries(OUTSIDE_NAMESPACE.map((path) => [path, `${path}, the scholar's own\n`]))
};

const GENERATED = ['.nojekyll', 'index.html', 'ballastella-site.json'];
const DOWNLOADED = Object.keys(ON_REMOTE).filter(
	(path) => !OUTSIDE_NAMESPACE.includes(path) && !GENERATED.includes(path)
);

test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

const start = (
	page: Page,
	repository: Record<string, unknown> = {},
	options: GitHubHostsOptions = {}
) =>
	startOnTheHub(
		page,
		{
			repositories: [{ owner: OWNER, name: REPOSITORY, files: ON_REMOTE, ...repository }],
			...options
		},
		{ dropDatabase: true }
	);

async function connectByAddress(page: Page, repository = REMOTE): Promise<void> {
	await openTheDoor(page);
	await page.getByTestId('open-by-address').click();
	await page.getByTestId('workspace-address-field').fill(repository);
	await page.getByTestId('find-workspace-address').click();
	await expect(
		page.getByTestId('resolved-address').or(page.getByTestId('workspace-address-refused'))
	).toBeVisible({ timeout: 30_000 });
	if ((await page.getByTestId('workspace-address-refused').count()) > 0) return;
	await page.getByTestId('open-resolved-address').click();
	await expect(page.getByTestId('sync-modal')).toBeVisible({ timeout: 30_000 });
}

async function pressGet(page: Page): Promise<void> {
	await expect(syncDialog(page).getByTestId('sync-get')).toBeVisible({ timeout: 60_000 });
	await syncDialog(page).getByTestId('sync-get').click();
}

async function getEverything(page: Page): Promise<void> {
	await pressGet(page);
	await expect(page.getByTestId('sync-modal')).toBeHidden({ timeout: 120_000 });
}

async function connectAndGet(page: Page): Promise<void> {
	await connectByAddress(page);
	await getEverything(page);
	await expect(page.getByTestId('sync-status')).toContainText(
		`Brought in ${DOWNLOADED.length} new files`,
		{ timeout: 60_000 }
	);
}
const addressRefusal = (page: Page) => page.getByTestId('workspace-address-refused');

test('connecting by address and getting fills only the owned namespace, anonymously, from the raw host', async ({
	page
}) => {
	const github = await start(page, {}, { rejectCredential: true });

	await connectAndGet(page);
	await expectRemoteNamed(page, REMOTE);
	await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
	expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	const stored = await everyByteOf(page, DEFAULT_WORKSPACE);
	expect(Object.keys(stored).sort()).toEqual([...DOWNLOADED].sort());
	for (const path of [...OUTSIDE_NAMESPACE, ...GENERATED]) {
		expect(Object.keys(stored)).not.toContain(path);
	}
	expect(stored['images/amsterdam-1625/info.json']).toBe('{"width":4096,"height":3072}');
	expect(stored['alignments/amsterdam-1625.json']).toBe(
		'{"type":"Annotation","id":"amsterdam-1625"}'
	);
	expect(stored['amsterdam-1625/annotations/warehouses.geojson']).toBe(WAREHOUSES);

	expect(github.rawGets(OWNER, REPOSITORY)).toBe(DOWNLOADED.length);
	expect(github.rawRequests).toHaveLength(DOWNLOADED.length);
	expect(github.requests.some((path) => path.includes('tarball'))).toBe(false);
	expect(github.requests.every((path) => path.startsWith(`/repos/${OWNER}/${REPOSITORY}`))).toBe(
		true
	);

	await openTheDoor(page);
	await expect(page.getByTestId('connect-signed-in')).toHaveCount(0);
	await closeTheDoor(page);

	await openRepositorySettings(page);
	await expect(page.getByTestId('remote-baseline')).toContainText(`last agreed with ${REMOTE}`);
	await expect(page.getByTestId('remote-baseline')).not.toContainText('Cannot tell');
	await closeWorkspaceDialog(page);
	expect(await readRemoteRelationship(page, DEFAULT_WORKSPACE)).toMatchObject({
		owner: OWNER,
		repository: REPOSITORY,
		branch: 'main'
	});
	const baseline = await readBaseline(page, DEFAULT_WORKSPACE);
	expect(baseline?.commit).toBeTruthy();
	expect(baseline?.files).toContain('images/amsterdam-1625/info.json');
	expect(baseline?.files).not.toContain('index.html');

	await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
	await expect(page).toHaveURL(/\?p=amsterdam-1625$/);
	await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
	await expect(page.getByTestId('project-screen')).toBeVisible();
	await expect(page.getByTestId('layer-name-text')).toHaveText(['Warehouses', 'The 1625 plan']);
});

test('connecting moves nothing until the Sync modal is answered', async ({ page }) => {
	const github = await start(page);

	await connectByAddress(page);

	await expect(page.getByTestId('sync-get')).toBeVisible({ timeout: 60_000 });
	expect(github.rawGets(OWNER, REPOSITORY)).toBe(0);
	expect(await everyByteOf(page, DEFAULT_WORKSPACE)).toEqual({});
	await page.keyboard.press('Escape');
	await expectRemoteNamed(page, REMOTE);
});

test.describe('arriving on a link from a Published Site', () => {
	const offer = (page: Page) => page.getByTestId('return-link-offer');
	const accept = (page: Page) => page.getByTestId('accept-return-link');

	test('offers it once, does nothing until confirmed, and can be turned down', async ({ page }) => {
		await start(page);

		await page.goto(`${HUB}?clone=${REMOTE}`);

		await expect(offer(page)).toContainText(REMOTE);
		await expect(accept(page)).toBeVisible();
		await expect(page.getByTestId('return-link-progress')).toHaveCount(0);
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
		expect(new URL(page.url()).searchParams.get('clone')).toBeNull();

		await page.reload();
		await expect(page.getByRole('heading', { name: 'Ballastella Editor' })).toBeVisible();
		await expect(offer(page)).toHaveCount(0);

		await page.goto(`${HUB}?clone=${REMOTE}`);
		await page.getByTestId('dismiss-return-link').click();
		await expect(offer(page)).toHaveCount(0);
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});

	test('confirming makes a connected Workspace to get into, leaving the one it was followed from alone', async ({
		page
	}) => {
		await start(page);
		await seed(page, {
			'amsterdam-1625/project.json': JSON.stringify({
				formatVersion: 1,
				name: 'My own Amsterdam',
				updatedAt: '2025-01-01T00:00:00.000Z',
				layers: [],
				baseMap: null
			})
		});
		await page.goto(`${HUB}?clone=${REMOTE}`);

		await accept(page).click();

		await expect(page.getByTestId('return-link-outcome')).toContainText(REMOTE);
		await expectWorkspaceNamed(page, 'atlas');
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE, 'atlas']);
		expect(await readRemoteRelationship(page, 'atlas')).toMatchObject({
			owner: OWNER,
			repository: REPOSITORY
		});
		expect(await everyByteOf(page, 'atlas')).toEqual({});

		await getEverything(page);

		expect(Object.keys(await everyByteOf(page, 'atlas')).sort()).toEqual([...DOWNLOADED].sort());
		const mine = await everyByteOf(page, DEFAULT_WORKSPACE);
		expect(Object.keys(mine)).toEqual(['amsterdam-1625/project.json']);
		expect(mine['amsterdam-1625/project.json']).toContain('My own Amsterdam');
		expect(await readRemoteRelationship(page, DEFAULT_WORKSPACE)).toBeNull();
	});

	test('offers nothing for a link that does not name a repository, and keeps none of it', async ({
		page
	}) => {
		await start(page);

		for (const reference of ['ada', 'ada/../../orgs', 'ada atlas']) {
			await page.goto(`${HUB}?clone=${encodeURIComponent(reference)}`);
			await expect(page.getByRole('heading', { name: 'Ballastella Editor' })).toBeVisible();
			await expect(offer(page)).toHaveCount(0);
			await expect
				.poll(() => new URL(page.url()).searchParams.get('clone'), {
					message: `?clone=${reference} left in the address bar`
				})
				.toBeNull();
		}
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});
});

test.describe('refusals, all before a byte is written', () => {
	test('a truncated file list, with nothing connected at all', async ({ page }) => {
		const github = await start(page, { truncateAfter: 3 });

		await connectByAddress(page);

		await expect(addressRefusal(page)).toContainText('could only list the first');
		await expect(addressRefusal(page)).toContainText('Nothing has been downloaded.');
		expect(github.rawGets(OWNER, REPOSITORY)).toBe(0);
		await closeTheDoor(page);
		expect(await readRemoteRelationship(page, DEFAULT_WORKSPACE)).toBeNull();
	});

	test('a private repository, then a non-repository address, each refused without a trace', async ({
		page
	}) => {
		await start(page);

		await connectByAddress(page, `${OWNER}/nothing-sent`);
		await expect(addressRefusal(page)).toContainText('no public repository');
		await expect(addressRefusal(page)).toContainText('private');
		await closeTheDoor(page);
		expect(await readRemoteRelationship(page, DEFAULT_WORKSPACE)).toBeNull();

		await connectByAddress(page, 'https://example.com/not/a/repo');
		await expect(addressRefusal(page)).toContainText('a site on an address of its own');
		expect(await readRemoteRelationship(page, DEFAULT_WORKSPACE)).toBeNull();
		await expect(page.getByTestId('connect-sequence')).toBeVisible();
		await expect(page.getByTestId('find-workspace-address')).toBeFocused();
		await closeTheDoor(page);

		await openTheDoor(page);
		await expect(addressRefusal(page)).toHaveCount(0);
		await closeTheDoor(page);
	});
	test('not enough room, named in bytes, with nothing written', async ({ page }) => {
		await start(page);
		await page.addInitScript(() => {
			navigator.storage.estimate = async () => ({ quota: 1_000_128, usage: 1_000_000 });
		});
		await page.reload();

		await connectByAddress(page);
		await pressGet(page);

		const refusal = page.getByTestId('sync-modal').getByRole('alert').first();
		await expect(refusal).toContainText('needs about', { timeout: 60_000 });
		await expect(refusal).toContainText('free');
		expect(await everyByteOf(page, DEFAULT_WORKSPACE)).toEqual({});
	});
});
