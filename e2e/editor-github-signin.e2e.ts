import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { routeGitHubHosts } from './support/github-hosts.js';
import { expectWorkspaceNamed, openWorkspaceMenu } from './support/workspace';

/**
 * Signing in with the GitHub App, through the broker (ticket 10, ADR-0031).
 *
 * SPEC's Seam 2. The flow's parts are asserted at Seam 1 — `github-sign-in.test.ts` has the
 * authorize URL, the `state` verdicts, the code exchange, the refresh, the expiry and the grant
 * record, against the one shared fake, where the assertion is the answer rather than a screen. What
 * only a browser can show is here:
 *
 *   - the whole round trip: pressing the button, going to GitHub, and coming back signed in;
 *   - the identity, which is the thing a redirect the scholar cannot watch owes them on return;
 *   - the callback's parameters leaving the address bar, with the open Workspace untouched;
 *   - a forged or absent `state` refused, with nothing kept;
 *   - an expired sign-in renewed through the broker, or surfaced as "sign in again";
 *   - and, with no broker served at all, the pasted token binding exactly as it always did.
 *
 * ⚠ **No spec here reaches `github.com`, `api.github.com`, or a real broker.** Every one of those
 * three addresses is served out of `createFakeGitHub` by `routeGitHubHosts`, and anything not routed
 * is aborted by the default-deny fence in the `context` fixture.
 */

const HUB = './';

/** A pasted token of the right shape. Its value never matters: the fake looks only for a credential. */
const PASTED = 'github_pat_11ABCDE0000abcdefghijklmnop';
const OWNER = 'ada';
const REPOSITORY = 'atlas';
const REMOTE = `${OWNER}/${REPOSITORY}`;

/**
 * Short enough that the grant is stale the moment it is issued.
 *
 * `CREDENTIAL_FRESHNESS_MARGIN_MS` is a minute, so a token with thirty seconds on it is already past
 * the line — which is how expiry is reached without a spec waiting eight hours for it.
 */
const ALREADY_STALE_SECONDS = 30;

test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

async function emptyBrowserStorage(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
		localStorage.clear();
		sessionStorage.clear();
	});
}

/** Start on a clean hub with one repository, and the sign-in surface served unless told otherwise. */
async function start(page: Page, options: Parameters<typeof routeGitHubHosts>[1] = {}) {
	const github = await routeGitHubHosts(page, {
		repositories: [{ owner: OWNER, name: REPOSITORY }],
		signIn: true,
		...options
	});
	await page.goto(HUB);
	await emptyBrowserStorage(page);
	await page.reload();
	return github;
}

const openRemoteSettings = async (page: Page): Promise<void> => {
	await openWorkspaceMenu(page);
	await page.getByTestId('open-remote-settings').click();
	await expect(page.getByRole('dialog', { name: 'Remote repository' })).toBeVisible();
};

/** Every web-storage key holding this string, read behind the app's back. */
async function whereverTheTokenIs(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const found: string[] = [];
		const scan = (storage: Storage, label: string) => {
			for (let at = 0; at < storage.length; at += 1) {
				const key = storage.key(at);
				if (key !== null) found.push(`${label}:${key}`);
			}
		};
		scan(localStorage, 'localStorage');
		scan(sessionStorage, 'sessionStorage');
		return found.sort();
	});
}

/** Whether a push credential is held at all, asked of the app rather than of a screen. */
const holdsCredential = (page: Page): Promise<boolean> =>
	page.evaluate(() => sessionStorage.getItem('ballastella.github-credential') !== null);

/** Press the button and wait for the round trip through GitHub to land back here. */
async function signInWithGitHub(page: Page): Promise<void> {
	await openRemoteSettings(page);
	await page.getByTestId('sign-in-with-github').click();
}

test.describe('signing in with GitHub', () => {
	// SPEC stories 32 and 56, and the ticket's first acceptance criterion: pressing sign in, going to
	// GitHub, coming back, and arriving signed in with the identity shown.
	test('completes the round trip and says whose account it is', async ({ page }) => {
		await start(page, { login: 'ada' });

		await signInWithGitHub(page);

		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub as ada');
		expect(await holdsCredential(page)).toBe(true);
	});

	// ⚠ **The code must not be left in the address bar.** One left there is replayed by a reload,
	// preserved by a bookmark, and leaked by a screenshot — and the Workspace must be exactly as it
	// was, because a sign-in is not an edit.
	test('takes the code and state off the address bar, leaving the Workspace alone', async ({
		page
	}) => {
		await start(page);
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);

		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');

		const url = new URL(page.url());
		expect(url.searchParams.get('code')).toBeNull();
		expect(url.searchParams.get('state')).toBeNull();
		// The Workspace is the one that was open before the redirect: a sign-in is not an edit.
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
	});

	// ADR-0033, SPEC "Out of scope" item 9: the credential and the grant beside it live in
	// `sessionStorage` and nowhere else. `localStorage` holds the write-ahead journal, and the
	// Workspace is what a Backup packs and a Publish uploads.
	test('keeps the sign-in in session storage and nothing in localStorage', async ({ page }) => {
		await start(page);

		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');

		const held = await whereverTheTokenIs(page);
		expect(held).toContain('sessionStorage:ballastella.github-credential');
		expect(held).toContain('sessionStorage:ballastella.github-app-session');
		expect(held.filter((key) => key.startsWith('localStorage:ballastella.github'))).toEqual([]);
	});

	test('shows the account on the bar once the Workspace is bound', async ({ page }) => {
		await start(page, { login: 'ada' });
		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('as ada');

		await openRemoteSettings(page);
		await page.getByTestId('remote-repository-field').fill(REMOTE);
		await page.getByTestId('remote-token-field').fill(PASTED);
		await page.getByTestId('bind-remote').click();
		await expect(page.getByTestId('remote-outcome')).toContainText(REMOTE);
		await page.getByTestId('close-remote-settings').click();

		await expect(page.getByTestId('remote-credential')).toHaveText('Signed in to GitHub as ada');
	});
});

// The whole of the protection on a flow GitHub gives no PKCE to. A mismatch or an absence is a
// refusal and never a retry: sending the user back round would make the second attempt carry a
// `state` this tab really did generate, which is the attack succeeding.
test.describe('a callback this tab did not ask for', () => {
	/** Arrive at the callback with these parameters, having seeded whatever state we like. */
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

	test('is refused when the state does not match, and no credential is kept', async ({ page }) => {
		await start(page);

		await arriveAt(page, '?code=code_0001&state=forged', 'the-state-this-tab-made');

		await expect(page.getByTestId('sign-in-problem')).toContainText('did not match');
		expect(await holdsCredential(page)).toBe(false);
	});

	test('is refused when there is no state at all', async ({ page }) => {
		await start(page);

		await arriveAt(page, '?code=code_0001', 'the-state-this-tab-made');

		await expect(page.getByTestId('sign-in-problem')).toContainText('did not match');
		expect(await holdsCredential(page)).toBe(false);
	});

	// The other absence: a callback arriving in a tab that never started a sign-in, which is what a
	// link somebody was sent looks like.
	test('is refused when this tab never started a sign-in', async ({ page }) => {
		await start(page);

		await arriveAt(page, '?code=code_0001&state=whatever', null);

		await expect(page.getByTestId('sign-in-problem')).toContainText(
			'did not start a GitHub sign-in'
		);
		expect(await holdsCredential(page)).toBe(false);
	});

	// And a refused callback is still taken off the bar, or every reload re-refuses it.
	test('leaves nothing on the address bar afterwards', async ({ page }) => {
		await start(page);

		await arriveAt(page, '?code=code_0001&state=forged', 'the-state-this-tab-made');
		await expect(page.getByTestId('sign-in-problem')).toBeVisible();

		const url = new URL(page.url());
		expect(url.searchParams.get('code')).toBeNull();
		expect(url.searchParams.get('state')).toBeNull();
	});
});

// SPEC story 33. A GitHub App's user token lasts eight hours, and the answer is never a publish that
// fails partway through — it is checked before work starts, renewed where it can be, and turned into
// "sign in again" where it cannot.
test.describe('a sign-in that has run out', () => {
	test('is renewed through the broker without the scholar noticing', async ({ page }) => {
		const github = await start(page, { tokenLifetimeSeconds: ALREADY_STALE_SECONDS });
		await signInWithGitHub(page);
		// The redirect closed the dialog on its way through, so there is nothing to close here.
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');

		// Opening this screen is what asks; ticket 04's Publish asks the same question the same way.
		await openRemoteSettings(page);

		await expect(page.getByTestId('remote-signed-in')).toBeVisible();
		expect(await holdsCredential(page)).toBe(true);
		expect(github.requests).toContain('/github/refresh');
	});

	test('surfaces as “sign in again” when the refresh is refused, and is not kept', async ({
		page
	}) => {
		const github = await start(page, { tokenLifetimeSeconds: ALREADY_STALE_SECONDS });
		await signInWithGitHub(page);
		// The redirect closed the dialog on its way through, so there is nothing to close here.
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');

		github.refuseRefresh();
		await openRemoteSettings(page);

		await expect(page.getByTestId('remote-problem')).toContainText('sign-in has expired');
		await expect(page.getByTestId('remote-problem')).toContainText('Sign in with GitHub');
		// ⚠ Cleared, not merely reported: every screen must render the not-signed-in state, so that a
		// publish started a moment later cannot pick up a credential GitHub has stopped honouring.
		expect(await holdsCredential(page)).toBe(false);
		expect(github.requests).toContain('/github/refresh');
	});
});

// SPEC story 56 and ADR-0031's first consequence: *a fork with no infrastructure is fully
// functional, not degraded.* This is also the state **this deployment ships in** — `github-app.ts`
// points at a reserved domain that will never answer — so it is not a hypothetical.
test.describe('with no broker served at all', () => {
	test('the pasted token still binds, and the sign-in fails legibly rather than silently', async ({
		page
	}) => {
		// `signIn: false`: the authorize address and the broker are not routed, so the default-deny
		// network fence aborts any request to either. That is a broker that is not there.
		const github = await start(page, { signIn: false });

		await openRemoteSettings(page);
		await page.getByTestId('remote-repository-field').fill(REMOTE);
		await page.getByTestId('remote-token-field').fill(PASTED);
		await page.getByTestId('bind-remote').click();

		await expect(page.getByTestId('remote-outcome')).toContainText(
			`This Workspace is bound to ${REMOTE}`
		);
		expect(await holdsCredential(page)).toBe(true);
		// Pages was turned on and the rights were read — the whole binding path, against GitHub's data
		// plane, with no broker anywhere in it.
		expect(github.pagesOn(OWNER, REPOSITORY)).toBe(true);
		expect(github.requests).toContain(`/repos/${OWNER}/${REPOSITORY}`);
		// And nothing in that path went near the broker.
		expect(github.requests.filter((path) => path.startsWith('/github/'))).toEqual([]);
	});

	test('a bound Workspace survives a reload with its credential, broker or no broker', async ({
		page
	}) => {
		await start(page, { signIn: false });
		await openRemoteSettings(page);
		await page.getByTestId('remote-repository-field').fill(REMOTE);
		await page.getByTestId('remote-token-field').fill(PASTED);
		await page.getByTestId('bind-remote').click();
		await expect(page.getByTestId('remote-outcome')).toContainText(REMOTE);
		await page.getByTestId('close-remote-settings').click();

		await page.reload();

		await expect(page.getByTestId('remote-name')).toHaveText(REMOTE);
		await expect(page.getByTestId('remote-credential')).toHaveText('Signed in to GitHub');
	});
});
