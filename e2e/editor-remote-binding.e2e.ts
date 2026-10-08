import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { whereverTheTokenIs } from './support/credential-scan.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	grantsFor,
	routeGitHubHosts,
	startOnTheHub,
	OWNER,
	REPOSITORY,
	REMOTE,
	TOKEN
} from './support/github-hosts.js';
import {
	closeTheDoor,
	backUpWorkspace,
	closeWorkspaceDialog,
	createFolderWorkspace,
	downloadedBytes,
	everyByteOf,
	expectCredential,
	expectNoRemote,
	expectRemoteNamed,
	expectWorkspaceNamed,
	installFolderPicker,
	openRepositorySettings,
	openTheDoor,
	restoreBackup
} from './support/workspace.js';

test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

const start = (page: Page, options: Parameters<typeof routeGitHubHosts>[1] = {}) =>
	startOnTheHub(
		page,
		{
			repositories: [{ owner: OWNER, name: REPOSITORY }],
			signIn: true,
			login: OWNER,
			grants: grantsFor(),
			...options
		},
		{ dropDatabase: true, credential: TOKEN }
	);

const firstVisit = (page: Page) =>
	startOnTheHub(
		page,
		{ repositories: [{ owner: OWNER, name: REPOSITORY }] },
		{ dropDatabase: true }
	);

async function choose(page: Page, row = page.getByTestId('granted-repository').first()) {
	await row.getByTestId('choose-repository').click();
	await expect(page.getByTestId('sync-modal')).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId('connect-sequence')).toBeHidden();
}

async function bind(page: Page): Promise<void> {
	await openTheDoor(page);
	await choose(page);
}

async function leaveSync(page: Page): Promise<void> {
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('sync-modal')).toBeHidden();
}

const topLevelFiles = async (page: Page, workspace = DEFAULT_WORKSPACE): Promise<string[]> =>
	Object.keys(await everyByteOf(page, workspace))
		.filter((path) => !path.includes('/'))
		.sort();

test.describe('binding a Workspace to a repository', () => {
	test('is done from the one door, and survives a reload', async ({ page }) => {
		await start(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY, private: true }],
			grants: grantsFor({ private: true })
		});

		await openTheDoor(page);
		const row = page.getByTestId('granted-repository').first();
		await expect(row.getByTestId('repository-note')).toContainText('paid GitHub plan', {
			timeout: 30_000
		});
		await expect(row.getByTestId('choose-repository')).not.toHaveAttribute('aria-disabled', 'true');
		await choose(page, row);
		await leaveSync(page);

		expect(await topLevelFiles(page)).toEqual([]);

		await page.reload();
		await expectRemoteNamed(page, REMOTE);
	});

	test('keeps the Remote and the sign-in, leaves Pages off, and forgets the credential on signing out', async ({
		page
	}) => {
		const github = await start(page);

		await bind(page);
		expect(github.pagesOn(OWNER, REPOSITORY)).toBe(false);
		await expect(page.getByTestId('pages-notice')).toHaveCount(0);
		await leaveSync(page);

		await expectRemoteNamed(page, REMOTE);
		await expectCredential(page, 'Signed in to GitHub');
		await page.reload();
		await expectCredential(page, 'Signed in to GitHub');

		await openTheDoor(page);
		await page.getByTestId('connect-sign-out').click();
		await expect(page.getByTestId('connect-signed-out')).toBeVisible();
		await closeTheDoor(page);

		await expectCredential(page, 'Not signed in');
		expect(await whereverTheTokenIs(page, TOKEN)).toEqual([]);

		await page.reload();
		await expectRemoteNamed(page, REMOTE);
		await expectCredential(page, 'Not signed in');
	});

	test('can still be signed out of after unbinding', async ({ page }) => {
		await start(page);
		await bind(page);
		await leaveSync(page);

		await openRepositorySettings(page);
		await page.getByTestId('unbind-remote').click();
		await expect(page.getByTestId('workspace-remote-notice')).toContainText('no longer syncs');
		await closeWorkspaceDialog(page);

		await openTheDoor(page);
		await page.getByTestId('connect-sign-out').click();

		expect(await whereverTheTokenIs(page, TOKEN)).toEqual([]);
		await closeTheDoor(page);
		await expectNoRemote(page);
	});

	test('cannot choose a repository this credential cannot send to', async ({ page }) => {
		await start(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY, push: false }],
			grants: grantsFor({ push: false })
		});

		await openTheDoor(page);

		const row = page.getByTestId('granted-repository').first();
		await expect(row.getByTestId('push-mark')).toContainText('Cannot be sent to', {
			timeout: 30_000
		});
		await expect(row.getByTestId('choose-repository')).toHaveAttribute('aria-disabled', 'true');
		await closeTheDoor(page);
		await expectNoRemote(page);
		expect(await topLevelFiles(page)).toEqual([]);
	});

	test('binds a folder Workspace exactly as a browser Workspace', async ({ page }) => {
		await installFolderPicker(page, 'e2e-remote-folder');
		await start(page);
		await createFolderWorkspace(page, 'e2e-remote-folder');

		await bind(page);
		await leaveSync(page);

		await expectRemoteNamed(page, REMOTE);
		expect(await topLevelFiles(page, 'e2e-remote-folder')).toEqual([]);
	});
});

test('a first visit shows no sign-in affordance anywhere and asks GitHub nothing', async ({
	page
}) => {
	const github = await firstVisit(page);

	await page.getByTestId('navigation-bar').waitFor();
	expect(github.requests).toEqual([]);
	await expectNoRemote(page);
	await expect(page.getByText(/sign in/i).filter({ visible: true })).toHaveCount(0);
	await expect(
		page.getByTestId('connect-sign-in-with-github').filter({ visible: true })
	).toHaveCount(0);
	await expect(page.getByTestId('connect-token-field').filter({ visible: true })).toHaveCount(0);
	expect(github.requests).toEqual([]);
});

test('a restored Backup arrives unbound', async ({ page }) => {
	await start(page);
	await bind(page);
	await leaveSync(page);
	await expectRemoteNamed(page, REMOTE);

	await restoreBackup(page, await downloadedBytes(backUpWorkspace(page)));

	await expectWorkspaceNamed(page, `${DEFAULT_WORKSPACE} (2)`);
	await expectNoRemote(page);
	expect(await topLevelFiles(page, `${DEFAULT_WORKSPACE} (2)`)).toEqual([]);
});
