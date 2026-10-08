import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';
import { whereverTheTokenIs } from './support/credential-scan.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	grantsFor,
	routeGitHubHosts,
	startOnTheHub,
	syncDialog,
	type GitHubHosts,
	OWNER,
	REPOSITORY,
	REMOTE,
	TOKEN
} from './support/github-hosts.js';
import {
	backUpWorkspace,
	downloadedBytes,
	closeTheDoor,
	closeWorkspaceDialog,
	seedGitHubCredential,
	seedRemoteRelationship,
	expectCredential,
	expectRemoteNamed,
	expectWorkspaceNamed,
	openRepositorySettings,
	openSyncModal,
	openTheDoor,
	HUB
} from './support/workspace.js';

const ALREADY_STALE_SECONDS = 30;

test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

const start = (page: Page, options: Parameters<typeof routeGitHubHosts>[1] = {}) =>
	startOnTheHub(page, {
		repositories: [{ owner: OWNER, name: REPOSITORY }],
		signIn: true,
		grants: grantsFor(),
		...options
	});

const holdsCredential = (page: Page): Promise<boolean> =>
	page.evaluate(() => sessionStorage.getItem('ballastella.github-credential') !== null);

const grantRecord = (page: Page): Promise<{ token: string; refreshToken: string } | null> =>
	page.evaluate(() => {
		const raw = sessionStorage.getItem('ballastella.github-app-session');
		return raw === null ? null : (JSON.parse(raw) as { token: string; refreshToken: string });
	});

const rememberedGrant = (
	page: Page
): Promise<{ refreshToken: string; expiresAt: number | null } | null> =>
	page.evaluate(async () => {
		const database = await new Promise<IDBDatabase | null>((resolve) => {
			const request = indexedDB.open('ballastella');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => resolve(null);
		});
		if (database === null || !database.objectStoreNames.contains('credential')) return null;
		try {
			const raw = await new Promise<unknown>((resolve) => {
				const request = database
					.transaction('credential', 'readonly')
					.objectStore('credential')
					.get('ballastella.github-app-remembered');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => resolve(undefined);
			});
			return typeof raw === 'string'
				? (JSON.parse(raw) as { refreshToken: string; expiresAt: number | null })
				: null;
		} finally {
			database.close();
		}
	});

async function reopenTheTab(page: Page): Promise<void> {
	await page.evaluate(() => sessionStorage.clear());
	await page.reload();
}

async function keepTheSignIn(page: Page): Promise<void> {
	await openTheDoor(page);
	await page.getByTestId('remember-sign-in').check();
	await expect.poll(() => rememberedGrant(page)).not.toBeNull();
	await closeTheDoor(page);
}

async function expectSignedOut(page: Page): Promise<void> {
	await openTheDoor(page);
	await expect(page.getByTestId('connect-signed-in')).toHaveCount(0);
	await expect(page.getByTestId('connect-expiry')).toHaveCount(0);
	await page.getByTestId('connect-have-account').click();
	await expect(page.getByTestId('connect-sign-in-with-github')).toBeVisible();
}

async function completeSignIn(page: Page): Promise<void> {
	await page.getByTestId('connect-sign-in-with-github').click();
	await expect(page.getByTestId('connect-sequence')).toBeVisible({ timeout: 30_000 });
	await closeTheDoor(page);
}

async function signInWithGitHub(page: Page): Promise<void> {
	await openTheDoor(page);
	await page.getByTestId('connect-have-account').click();
	await completeSignIn(page);
}

async function signIn(page: Page, outcome = 'Signed in to GitHub'): Promise<void> {
	await signInWithGitHub(page);
	await expect(page.getByTestId('sign-in-outcome')).toContainText(outcome);
}

async function sendSync(page: Page): Promise<void> {
	await openSyncModal(page);
	await expect(syncDialog(page).getByTestId('sync-budget')).toBeVisible({ timeout: 60_000 });
	await syncDialog(page).getByTestId('sync-send').click();
	await expect(page.getByTestId('sync-status')).toContainText('Sent to', { timeout: 60_000 });
}

async function bindFromTheDoor(page: Page): Promise<void> {
	await openTheDoor(page);
	await page.getByTestId('choose-repository').first().click();
	await expect(page.getByTestId('sync-modal')).toBeVisible({ timeout: 30_000 });
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('sync-modal')).toBeHidden();
	await expectRemoteNamed(page, REMOTE);
}

async function turnShareLinksOn(page: Page, github: GitHubHosts): Promise<void> {
	await openRepositorySettings(page);
	await expect(page.getByTestId('pages-setup-by-hand')).toBeVisible();
	await page.getByTestId('enable-pages').click();
	await expect(page.getByTestId('check-pages')).toBeVisible({ timeout: 30_000 });
	github.turnPagesOn(OWNER, REPOSITORY);
	await page.getByTestId('check-pages').click();
	await expect(page.getByTestId('pages-enabled')).toBeVisible({ timeout: 60_000 });
	await closeWorkspaceDialog(page);
}

async function arriveAt(page: Page, search: string, seeded: string | null): Promise<void> {
	await page.evaluate(
		({ state }) => {
			if (state === null) sessionStorage.removeItem('ballastella.github-sign-in-state');
			else sessionStorage.setItem('ballastella.github-sign-in-state', state);
		},
		{ state: seeded }
	);
	await page.goto(`${HUB}${search}`);
}

test.describe('signing in with GitHub', () => {
	test('completes the round trip, says whose account it is, cleans the address bar, and keeps the grant in session storage only', async ({
		page
	}) => {
		await start(page, { login: 'ada' });
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);

		await signIn(page, 'Signed in to GitHub as ada');

		expect(await holdsCredential(page)).toBe(true);
		const url = new URL(page.url());
		expect(url.searchParams.get('code')).toBeNull();
		expect(url.searchParams.get('state')).toBeNull();
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);

		const grant = await grantRecord(page);
		expect(grant?.token).toBeTruthy();
		expect(grant?.refreshToken).toBeTruthy();
		expect(await whereverTheTokenIs(page, grant?.token ?? '')).toEqual([
			'sessionStorage:ballastella.github-app-session',
			'sessionStorage:ballastella.github-credential'
		]);
		expect(await whereverTheTokenIs(page, grant?.refreshToken ?? '')).toEqual([
			'sessionStorage:ballastella.github-app-session'
		]);
	});

	test('puts the Project the sign-in left from back on the address bar', async ({ page }) => {
		await start(page);
		await page.goto('./?p=amsterdam-1625');

		await signIn(page);

		const url = new URL(page.url());
		expect(url.searchParams.get('p')).toBe('amsterdam-1625');
		expect(url.searchParams.get('code')).toBeNull();
		expect(url.searchParams.get('state')).toBeNull();
	});

	test('says the authorisation was declined when Cancel was pressed on GitHub', async ({
		page
	}) => {
		const github = await start(page);

		await arriveAt(
			page,
			'?error=access_denied&error_description=The+user+has+denied+your+application+access.&state=the-state-this-tab-made',
			'the-state-this-tab-made'
		);

		await expect(page.getByTestId('sign-in-problem')).toContainText('not given permission');
		await expect(page.getByTestId('sign-in-problem')).toContainText('Cancel');
		expect(await holdsCredential(page)).toBe(false);
		expect(github.requests.filter((path) => path.startsWith('/github/'))).toEqual([]);
	});
});

test.describe('binding while already signed in', () => {
	test('offers no credential to supply, binds on the sign-in, keeps the grant renewable, and names the account', async ({
		page
	}) => {
		await start(page, { login: 'ada' });
		await signIn(page, 'as ada');
		const before = await grantRecord(page);
		expect(before?.refreshToken).toBeTruthy();

		await openTheDoor(page);
		await expect(page.getByTestId('repository-choice')).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId('connect-token-field')).toHaveCount(0);
		await page.getByTestId('choose-repository').first().click();
		await expect(page.getByTestId('sync-modal')).toBeVisible({ timeout: 30_000 });
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('sync-modal')).toBeHidden();
		await expectRemoteNamed(page, REMOTE);

		expect(await grantRecord(page)).toEqual(before);
		await expectCredential(page, 'Signed in to GitHub as ada');
	});
});

test.describe('a page reached by a filename', () => {
	test.use({ serviceWorkers: 'block' });

	test('sends the address it left from, not the one it came back to', async ({ page }) => {
		await start(page);

		let departed = false;
		let exchanged = '';
		page.on('request', (request) => {
			const url = new URL(request.url());
			if (url.pathname.endsWith('/installations/new')) departed = true;
			if (url.pathname === '/github/token' && request.method() === 'POST') {
				exchanged =
					(JSON.parse(request.postData() ?? '{}') as { redirect_uri?: string }).redirect_uri ?? '';
			}
		});

		await page.goto('./index.html');
		await signIn(page);

		expect(departed).toBe(true);
		expect(exchanged).toContain('/index.html');
		expect(await holdsCredential(page)).toBe(true);
	});
});

test.describe('a callback this tab did not ask for', () => {
	for (const { title, search, seeded, problem } of [
		{
			title: 'is refused when the state does not match',
			search: '?code=code_0001&state=forged',
			seeded: 'the-state-this-tab-made',
			problem: 'did not match'
		},
		{
			title: 'is refused when there is no state at all',
			search: '?code=code_0001',
			seeded: 'the-state-this-tab-made',
			problem: 'did not match'
		},
		{
			title: 'is refused when this tab never started a sign-in',
			search: '?code=code_0001&state=whatever',
			seeded: null,
			problem: 'did not start a GitHub sign-in'
		}
	]) {
		test(`${title}, keeping no credential and leaving nothing on the address bar`, async ({
			page
		}) => {
			await start(page);

			await arriveAt(page, search, seeded);

			await expect(page.getByTestId('sign-in-problem')).toContainText(problem);
			expect(await holdsCredential(page)).toBe(false);
			const url = new URL(page.url());
			expect(url.searchParams.get('code')).toBeNull();
			expect(url.searchParams.get('state')).toBeNull();
		});
	}

	test('does not put the stashed Project back, and does not leave it to be replayed', async ({
		page
	}) => {
		await start(page);
		await page.evaluate(() => {
			sessionStorage.setItem('ballastella.github-sign-in-return', '?p=amsterdam-1625');
		});

		await arriveAt(page, '?code=code_0001&state=forged', 'the-state-this-tab-made');
		await expect(page.getByTestId('sign-in-problem')).toContainText('did not match');

		expect(new URL(page.url()).searchParams.get('p')).toBeNull();
		expect(
			await page.evaluate(() => sessionStorage.getItem('ballastella.github-sign-in-return'))
		).toBeNull();
	});
});

test.describe('a sign-in that has run out', () => {
	test('is renewed through the broker unnoticed, and surfaces as “sign in again” once the refresh is refused', async ({
		page
	}) => {
		const github = await start(page, { tokenLifetimeSeconds: ALREADY_STALE_SECONDS });
		await signIn(page);

		await openTheDoor(page);
		await expect(page.getByTestId('connect-signed-in')).toBeVisible();
		expect(await holdsCredential(page)).toBe(true);
		expect(github.requests).toContain('/github/refresh');
		await closeTheDoor(page);

		github.refuseRefresh();
		await openTheDoor(page);

		await expect(page.getByTestId('connect-expiry')).toContainText('sign-in has expired');
		await expect(page.getByTestId('connect-expiry')).toContainText('Sign in with GitHub');
		expect(await holdsCredential(page)).toBe(false);
	});

	test('is caught before any work starts, rather than by a 401 partway through', async ({
		page
	}) => {
		const github = await start(page, { tokenLifetimeSeconds: ALREADY_STALE_SECONDS });
		await signIn(page);

		github.expireSignIn();
		github.refuseRefresh();
		const asked = github.requests.length;

		await openTheDoor(page);

		await expect(page.getByTestId('connect-expiry')).toContainText('sign-in has expired');
		expect(await holdsCredential(page)).toBe(false);
		expect(
			github.requests.slice(asked).filter((path) => path.startsWith('/repos/') || path === '/user')
		).toEqual([]);
	});
});

test.describe('a sign-in kept past the tab', () => {
	test('keeps the renewable half only, and signs itself back in with it', async ({ page }) => {
		const github = await start(page, { login: 'ada' });
		await signIn(page, 'Signed in to GitHub as ada');

		await openTheDoor(page);
		await page.getByTestId('remember-sign-in').check();
		await expect(page.getByTestId('connect-signed-in')).toContainText('coming back tomorrow');
		await expect(page.getByTestId('connect-signed-in')).toContainText(
			'still forgotten when this tab closes'
		);
		await expect.poll(() => rememberedGrant(page)).not.toBeNull();
		await closeTheDoor(page);

		const held = await grantRecord(page);
		expect(held?.token).toBeTruthy();
		expect(await rememberedGrant(page)).toMatchObject({ refreshToken: held?.refreshToken });

		await page.evaluate(() => sessionStorage.clear());
		expect(await whereverTheTokenIs(page, held?.token ?? '')).toEqual([]);
		expect(await whereverTheTokenIs(page, held?.refreshToken ?? '')).toEqual([
			'indexedDB:ballastella/credential'
		]);

		const departures = github.requests.filter((path) => path === '/login/oauth/authorize').length;
		await page.reload();

		await openTheDoor(page);
		await expect(page.getByTestId('connect-signed-in')).toContainText('as ada');
		expect(await holdsCredential(page)).toBe(true);
		expect((await grantRecord(page))?.token).not.toBe(held?.token);
		expect(github.requests).toContain('/github/refresh');
		expect(github.requests.filter((path) => path === '/login/oauth/authorize')).toHaveLength(
			departures
		);
	});

	test('is not the default, and ends when it is unticked, when the author signs out, and when it will not renew', async ({
		page
	}) => {
		const github = await start(page);
		await signIn(page);

		await openTheDoor(page);
		await expect(page.getByTestId('remember-sign-in')).not.toBeChecked();
		await expect(page.getByTestId('connect-signed-in')).toContainText(
			'forgotten when this tab closes'
		);
		await closeTheDoor(page);
		expect(await rememberedGrant(page)).toBeNull();
		await reopenTheTab(page);
		expect(await holdsCredential(page)).toBe(false);
		expect(await rememberedGrant(page)).toBeNull();
		await expectSignedOut(page);
		await completeSignIn(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');
		await keepTheSignIn(page);

		await openTheDoor(page);
		await page.getByTestId('remember-sign-in').uncheck();
		await expect.poll(() => rememberedGrant(page)).toBeNull();
		await closeTheDoor(page);
		await reopenTheTab(page);
		expect(await holdsCredential(page)).toBe(false);
		await openTheDoor(page);
		await expect(page.getByTestId('remember-sign-in')).not.toBeChecked();
		await closeTheDoor(page);

		await signIn(page);
		await keepTheSignIn(page);
		await openTheDoor(page);
		await page.getByTestId('connect-sign-out').click();
		await expect.poll(() => rememberedGrant(page)).toBeNull();
		await closeTheDoor(page);
		await reopenTheTab(page);
		expect(await holdsCredential(page)).toBe(false);

		await signIn(page);
		await keepTheSignIn(page);
		github.refuseRefresh();
		await reopenTheTab(page);

		await expect.poll(() => rememberedGrant(page)).toBeNull();
		expect(await holdsCredential(page)).toBe(false);
		await expectSignedOut(page);
	});

	test('is in no Backup the author mails and no Sync they upload', async ({ page }) => {
		const github = await start(page);
		await signIn(page);
		await keepTheSignIn(page);
		const held = await grantRecord(page);
		expect(held?.refreshToken).toBeTruthy();
		const archive = await downloadedBytes(backUpWorkspace(page));
		expect(archive.includes(held?.refreshToken ?? '')).toBe(false);
		expect(archive.includes(held?.token ?? '')).toBe(false);
		await closeWorkspaceDialog(page);

		await bindFromTheDoor(page);
		await turnShareLinksOn(page, github);

		await sendSync(page);

		const uploaded = github.files(OWNER, REPOSITORY);
		expect(uploaded.length).toBeGreaterThan(0);
		const carrying = uploaded.filter((path) => {
			const text = github.fileText(OWNER, REPOSITORY, path) ?? '';
			return text.includes(held?.refreshToken ?? '') || text.includes(held?.token ?? '');
		});
		expect(carrying).toEqual([]);
	});
});

test.describe('with no broker served at all', () => {
	test('the sign-in fails legibly, and the way in behind the disclosure binds with no request to the broker', async ({
		page
	}) => {
		const github = await start(page, { brokerUnreachable: true });

		await signInWithGitHub(page);

		await expect(page.getByTestId('sign-in-problem')).toContainText('could not be reached');
		await expect(page.getByTestId('sign-in-problem')).toContainText('personal access token');
		expect(await holdsCredential(page)).toBe(false);
		expect(github.requests).toContain('/github/token');
		const asked = github.requests.length;

		await openTheDoor(page);
		await expect(page.getByTestId('connect-token-field')).toHaveCount(0);
		await page.getByTestId('connect-other-way-in').click();
		await page.getByTestId('connect-repository-field').fill(REMOTE);
		await page.getByTestId('connect-token-field').fill(TOKEN);
		await page.getByTestId('connect-paste').click();

		await expect(page.getByTestId('sync-modal')).toBeVisible({ timeout: 30_000 });
		await page.keyboard.press('Escape');
		await expectRemoteNamed(page, REMOTE);
		expect(await holdsCredential(page)).toBe(true);
		expect(github.requests.slice(asked)).not.toContain('/github/token');
		expect(github.requests).not.toContain('/github/refresh');
	});

	test('a bound Workspace survives a reload with its credential, broker or no broker', async ({
		page
	}) => {
		await start(page, { signIn: false });
		await seedRemoteRelationship(page, { owner: OWNER, repository: REPOSITORY });
		await seedGitHubCredential(page, TOKEN);

		await page.reload();

		await expectRemoteNamed(page, REMOTE);
		await expectCredential(page, 'Signed in to GitHub');
	});
});

test.describe('a bound Workspace pressed to Sync with no credential', () => {
	test('offers the GitHub sign-in and no token field, and the return leg reaches a send', async ({
		page
	}) => {
		const github = await start(page, { login: OWNER });

		await signIn(page);
		await bindFromTheDoor(page);

		await page.evaluate(() => {
			sessionStorage.removeItem('ballastella.github-credential');
			sessionStorage.removeItem('ballastella.github-app-session');
		});
		await page.reload();
		await expectRemoteNamed(page, REMOTE);
		expect(await holdsCredential(page)).toBe(false);

		await openSyncModal(page);
		const dialog = syncDialog(page);
		await expect(dialog.getByTestId('sync-sign-in-needed')).toContainText(REMOTE);
		await expect(dialog.getByTestId('sync-token-field')).toHaveCount(0);

		await dialog.getByTestId('sync-sign-in-with-github').click();

		await expect(page.getByTestId('connect-credential')).toContainText('Signed in to GitHub', {
			timeout: 30_000
		});
		await closeTheDoor(page);
		expect(await holdsCredential(page)).toBe(true);
		await expectRemoteNamed(page, REMOTE);

		await turnShareLinksOn(page, github);

		await sendSync(page);

		expect(github.files(OWNER, REPOSITORY)).toContain('index.html');
	});
});

test.describe('the guided sequence, wired to the real thing', () => {
	test('goes from the navigation bar through sign-in and a chosen repository to a published site', async ({
		page
	}) => {
		const github = await start(page, { login: OWNER });

		await expect(page.getByTestId('connect-to-github')).toBeVisible();
		const saysGitHub = await page.evaluate(() =>
			[...document.querySelectorAll('body *')]
				.filter(
					(element) =>
						element.children.length === 0 &&
						/github/i.test(element.textContent ?? '') &&
						element.closest('dialog:not([open])') === null &&
						element.checkVisibility()
				)
				.map(
					(element) =>
						(element.closest('[data-testid]') as HTMLElement | null)?.dataset.testid ??
						element.tagName.toLowerCase()
				)
		);
		expect([...new Set(saysGitHub)].sort()).toEqual(['connect-to-github']);
		await expect(page.locator('dialog[open]')).toHaveCount(0);

		await page.getByTestId('connect-to-github').click();

		await expect(page.getByTestId('connect-needs-account')).toBeVisible();
		await page.getByTestId('connect-have-account').click();
		await expect(page.getByTestId('connect-sign-in')).toBeVisible();

		await page.getByTestId('connect-sign-in-with-github').click();
		await expect(page.getByTestId('connect-choosing')).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId('connect-account')).toContainText(`as ${OWNER}`);

		await expect(page.getByTestId('granted-repository')).toHaveText(new RegExp(REMOTE));
		await page.getByTestId('choose-repository').click();

		await expect(syncDialog(page).getByTestId('sync-budget')).toBeVisible({ timeout: 30_000 });
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('sync-modal')).toBeHidden();
		await expectRemoteNamed(page, REMOTE);

		expect(github.pagesOn(OWNER, REPOSITORY)).toBe(false);
		await openRepositorySettings(page);
		await expect(page.getByTestId('published-site-address')).toHaveText(
			`https://${OWNER}.github.io/${REPOSITORY}/`
		);
		await page.getByTestId('enable-pages').click();
		await expect(page.getByTestId('check-pages')).toBeVisible({ timeout: 30_000 });
		expect(github.pagesOn(OWNER, REPOSITORY)).toBe(false);
		github.turnPagesOn(OWNER, REPOSITORY);
		await page.getByTestId('check-pages').click();
		await expect(page.getByTestId('pages-enabled')).toBeVisible({ timeout: 30_000 });
		expect(github.pagesOn(OWNER, REPOSITORY)).toBe(true);
		await closeWorkspaceDialog(page);

		await sendSync(page);

		expect(github.files(OWNER, REPOSITORY)).toContain('index.html');
	});
});
