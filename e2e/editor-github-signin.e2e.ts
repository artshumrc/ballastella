import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { readFile } from 'node:fs/promises';

import { whereverTheTokenIs } from './support/credential-scan.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { routeGitHubHosts } from './support/github-hosts.js';
import {
	backUpWorkspace,
	closeTheDoor,
	closeWorkspaceDialog,
	seedGitHubCredential,
	seedRemoteRelationship,
	expectCredential,
	expectRemoteNamed,
	expectWorkspaceNamed,
	openPublishFromTheDoor,
	openTheDoor
} from './support/workspace';

/**
 * Signing in with the GitHub App, through the broker (ADR-0031).
 *
 * Seam 2. The flow's parts are asserted at Seam 1 — `github-sign-in.test.ts` has the authorize URL,
 * the `state` verdicts, the code exchange, the refresh, the expiry and the grant record, against
 * the one shared fake, where the assertion is the answer rather than a screen. What only a browser
 * can show is here:
 *
 *   - the whole round trip: pressing the button, going to GitHub, and coming back signed in;
 *   - the identity, which is the thing a redirect the scholar cannot watch owes them on return;
 *   - the callback's parameters leaving the address bar, with the open Workspace untouched, and the
 *     Project put back only for a reply this tab asked for;
 *   - the address the exchange names being the one the authorisation named, which only a page
 *     reached by a filename can tell apart from the one recomputed on return;
 *   - a forged or absent `state` refused, and a declined authorisation told apart from a bad code;
 *   - an expired sign-in renewed through the broker, or surfaced as "sign in again" before any work
 *     starts — and not taking a token pasted since down with it;
 *   - a Review Workspace reading, offering and spending nothing;
 *   - a sign-in kept past the tab where the author asked for that and not where they did not, with
 *     the renewable half surviving the close, the token that publishes not, and neither reaching a
 *     Backup or a Publish;
 *   - and, with no broker, the sign-in failing legibly while the pasted token binds as it always did.
 *
 * ⚠ **No spec here reaches `github.com`, `api.github.com`, or a real broker.** Every one of those
 * three addresses is served out of `createFakeGitHub` by `routeGitHubHosts`, and anything not routed
 * is aborted by the default-deny fence in the `context` fixture.
 */

const HUB = './';

/** A held token of the right shape. Its value never matters: the fake looks only for a credential. */
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

/**
 * Start on a clean hub with one repository, the sign-in surface served unless told otherwise, and
 * that repository granted.
 *
 * ⚠ **Granted by default, because binding is now a press on GitHub's own answer.** There is no
 * address field and no token field on a deployment with an App (ADR-0042): the door lists what
 * `GET /user/installations` reports and the row is the gesture, so a spec that means "and then bind"
 * needs the listing to have something in it.
 */
async function start(page: Page, options: Parameters<typeof routeGitHubHosts>[1] = {}) {
	const github = await routeGitHubHosts(page, {
		repositories: [{ owner: OWNER, name: REPOSITORY }],
		signIn: true,
		grants: {
			installationId: 1,
			account: OWNER,
			repositories: [{ owner: OWNER, repository: REPOSITORY, push: true }]
		},
		...options
	});
	await page.goto(HUB);
	await emptyBrowserStorage(page);
	await page.reload();
	return github;
}

/** Whether a push credential is held at all, asked of the app rather than of a screen. */
const holdsCredential = (page: Page): Promise<boolean> =>
	page.evaluate(() => sessionStorage.getItem('ballastella.github-credential') !== null);

/** The grant record as the browser holds it, or `null`. Read behind the app's back. */
const grantRecord = (page: Page): Promise<{ token: string; refreshToken: string } | null> =>
	page.evaluate(() => {
		const raw = sessionStorage.getItem('ballastella.github-app-session');
		return raw === null ? null : (JSON.parse(raw) as { token: string; refreshToken: string });
	});

/**
 * What this installation has kept of a sign-in past the tab, read straight out of IndexedDB.
 *
 * Behind the app's back, and by opening the database rather than by asking a screen: the whole
 * claim is about what is *at rest* when the tab that wrote it has gone.
 */
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

/**
 * Close the tab and open a new one, as far as a spec can stage it.
 *
 * `sessionStorage` is per-tab and everything else on the origin is not, so emptying it and loading
 * the page again is exactly the state the next visit arrives in — without giving up the routes, the
 * fake's memory of what it has issued, or the request log the assertions are made of.
 */
async function reopenTheTab(page: Page): Promise<void> {
	await page.evaluate(() => sessionStorage.clear());
	await page.reload();
}

/**
 * Tick "keep me signed in on this computer", and wait for the record it makes to land.
 *
 * Behind the door, which is where everything about a sign-in is (ADR-0041, ADR-0042).
 */
async function keepTheSignIn(page: Page): Promise<void> {
	await openTheDoor(page);
	await page.getByTestId('remember-sign-in').check();
	// ⚠ Polled rather than asserted once: the durable write is queued behind the database opening,
	// and a spec that emptied `sessionStorage` before it landed would be staging a different tab
	// close from the one it means.
	await expect.poll(() => rememberedGrant(page)).not.toBeNull();
	await closeTheDoor(page);
}

/**
 * Press the button and wait for the round trip through GitHub to land back here.
 *
 * The sign-in is a step of the door, and the step before it — *have you got a GitHub account?* — is
 * offered rather than detected, so it is pressed past the way somebody with one does.
 */
async function signInWithGitHub(page: Page): Promise<void> {
	await openTheDoor(page);
	await page.getByTestId('connect-have-account').click();
	await page.getByTestId('connect-sign-in-with-github').click();
	// ⚠ **The door is standing open when the round trip lands, and closing it is this helper's job.**
	// The App sign-in replaces the document, and the sequence reopens over the page it comes back to
	// (`connectSequence`'s resuming mark) — which is the behaviour, not an accident. A spec that went
	// on to press anything on the bar would be clicking behind a `showModal()` dialog, so it is
	// closed here once rather than at twenty call sites.
	await expect(page.getByTestId('connect-sequence')).toBeVisible({ timeout: 30_000 });
	await closeTheDoor(page);
}

/**
 * Connect the Workspace to the granted repository, from the door.
 *
 * ⚠ **Nothing is typed and nothing is pasted.** The credential is the one the sign-in issued, and the
 * repository is chosen out of GitHub's own list — which is the whole of what binding is now.
 */
async function bindFromTheDoor(page: Page): Promise<void> {
	await openTheDoor(page);
	await page.getByTestId('choose-repository').first().click();
	await expect(page.getByTestId('connect-outcome')).toContainText(REMOTE, { timeout: 30_000 });
	await closeTheDoor(page);
}

/** Arrive at the callback with these parameters, having seeded whatever `state` we like. */
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
	// The whole round trip: pressing sign in, going to GitHub, coming back, and arriving signed in
	// with the identity shown.
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

	// The callback URL cannot carry `?p=` — a GitHub App matches the redirect against the address
	// registered on it — so the Project is stashed on the way out and put back on the way in.
	test('puts the Project the sign-in left from back on the address bar', async ({ page }) => {
		await start(page);
		await page.goto('./?p=amsterdam-1625');

		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');

		const url = new URL(page.url());
		expect(url.searchParams.get('p')).toBe('amsterdam-1625');
		expect(url.searchParams.get('code')).toBeNull();
		expect(url.searchParams.get('state')).toBeNull();
	});

	// A scholar who changes their mind on GitHub's own screen is sent back with `error=access_denied`,
	// **the real `state`**, and no code at all. Read as a code-and-state pair alone, that verifies and
	// then posts the empty string to the broker — so somebody who chose Cancel was told the code
	// passed was incorrect or expired.
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
		// And nothing was offered to the broker: there was nothing to exchange.
		expect(github.requests.filter((path) => path.startsWith('/github/'))).toEqual([]);
	});

	// ADR-0033: the credential and the grant beside it live in `sessionStorage` and nowhere else.
	// `localStorage` holds the write-ahead journal, and the Workspace is what a Backup packs and a
	// Publish uploads.
	//
	// ⚠ **The refresh token is scanned for by value, and it is the one that matters most.** It
	// outlives the eight-hour access token it mints and is the longer-lived credential of the two, so
	// `whereverTheTokenIs` — comparing values and walking OPFS and IndexedDB as well as web storage —
	// is what asks. A scan that enumerated keys would report the same shape here while asserting
	// nothing about where the secret actually is.
	test('keeps the sign-in in session storage and nothing in localStorage', async ({ page }) => {
		await start(page);

		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');

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

	test('names the account where the sign-in is held, once the Workspace is bound', async ({
		page
	}) => {
		await start(page, { login: 'ada' });
		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('as ada');

		await bindFromTheDoor(page);

		await expectCredential(page, 'Signed in to GitHub as ada');
	});
});

// ⚠ **A sign-in is acquired *before* there is anything to bind to** — that is the order the door
// offers — so the first thing a signed-in scholar meets is the list of repositories GitHub says they
// have granted, and choosing one is the whole of binding. Nothing is typed and nothing is pasted.
test.describe('binding while already signed in', () => {
	test('offers no credential to supply anywhere, and binds on the strength of the sign-in', async ({
		page
	}) => {
		// ⚠ **The real gate, which no seam below this one can see.** `signInWithGitHubOffered` is
		// `isGitHubAppConfigured(GITHUB_APP)` read once by the real `WorkspaceStorage`; every seam
		// beneath Seam 2 is *given* it, so a gate wired to the wrong side of it shows up only as a
		// student being asked for a token. Absence, on the step a signed-in author actually lands on.
		await start(page, { login: 'ada' });
		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('as ada');

		await openTheDoor(page);
		await expect(page.getByTestId('repository-choice')).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId('connect-token-field')).toHaveCount(0);
		await page.getByTestId('choose-repository').first().click();

		await expect(page.getByTestId('connect-outcome')).toContainText(REMOTE, { timeout: 30_000 });
	});

	// ⚠ **The trap in the fix.** Binding by paste clears the grant record, which is right for a paste
	// and fatal for a sign-in: the record holds the refresh token, so a binding that cleared it would
	// leave an eight-hour credential that cannot renew — and the scholar would be told their sign-in
	// had expired an hour into an afternoon's work, having done nothing but bind.
	test('leaves the grant record intact, so the sign-in can still be renewed', async ({ page }) => {
		await start(page, { login: 'ada' });
		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('as ada');
		const before = await grantRecord(page);
		expect(before?.refreshToken).toBeTruthy();

		await bindFromTheDoor(page);

		expect(await grantRecord(page)).toEqual(before);
	});
});

// ⚠ **The exchange must name the same `redirect_uri` the authorisation did, byte for byte.** GitHub
// answers `redirect_uri_mismatch` to anything else, so this is the difference between a deployment
// whose front door works and one where it has never worked at all — and it is invisible at a
// directory address, where the string the sign-in leaves from and the string a return would
// recompute happen to be the same. Reached by a *filename*, they are not: taking the callback's
// parameters off the bar navigates to the app's own resolved root, and `/index.html` is not that.
test.describe('a page reached by a filename', () => {
	// The app's own worker performs the static host's redirect offline (`service-worker.ts`), and
	// `/index.html` is exactly what it canonicalises. Left to install, it would decide by its
	// activation timing whether this spec had two spellings to tell apart at all.
	test.use({ serviceWorkers: 'block' });

	test('sends the address it left from, not the one it came back to', async ({ page }) => {
		await start(page);

		/** What the flow actually put on the wire, read off the requests. */
		let departed = false;
		let exchanged = '';
		page.on('request', (request) => {
			const url = new URL(request.url());
			// Matched by path, never by host: `check-github-broker.mjs` refuses a spec that writes the
			// broker's address or the App's slug down, and GitHub's own host is not this spec's business
			// either.
			if (url.pathname.endsWith('/installations/new')) departed = true;
			if (url.pathname === '/github/token' && request.method() === 'POST') {
				exchanged =
					(JSON.parse(request.postData() ?? '{}') as { redirect_uri?: string }).redirect_uri ?? '';
			}
		});

		await page.goto('./index.html');
		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');

		// ⚠ **The install-first departure carries no `redirect_uri` at all** — GitHub's install screen
		// takes none and comes back to the callback registered on the App — so what has to be right is
		// the address the *exchange* names. It is the one the sign-in left from, kept across the
		// redirect, and not the app's own resolved root a navigation would have normalised it to.
		expect(departed).toBe(true);
		expect(exchanged).toContain('/index.html');
		expect(await holdsCredential(page)).toBe(true);
	});
});

// The whole of the protection on a flow GitHub gives no PKCE to. A mismatch or an absence is a
// refusal and never a retry: sending the user back round would make the second attempt carry a
// `state` this tab really did generate, which is the attack succeeding.
test.describe('a callback this tab did not ask for', () => {
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

	// ⚠ **And it does not get to choose where the tab goes.** The stashed `?p=` is put back only once
	// the `state` has verified: a reply that was not this tab's must not steer it, however harmless
	// the destination looks. The stash is still *consumed*, or a later reload would restore it into an
	// unrelated navigation.
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

// A GitHub App's user token lasts eight hours, and the answer is never a publish that fails partway
// through — it is checked before work starts, renewed where it can be, and turned into "sign in
// again" where it cannot.
test.describe('a sign-in that has run out', () => {
	test('is renewed through the broker without the scholar noticing', async ({ page }) => {
		const github = await start(page, { tokenLifetimeSeconds: ALREADY_STALE_SECONDS });
		await signInWithGitHub(page);
		// The redirect closed the dialog on its way through, so there is nothing to close here.
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');

		// Opening this screen is what asks; a Publish asks the same question the same way.
		await openTheDoor(page);

		await expect(page.getByTestId('connect-signed-in')).toBeVisible();
		expect(await holdsCredential(page)).toBe(true);
		expect(github.requests).toContain('/github/refresh');
	});

	// End to end, and *before* a publish starts rather than during one. The fake's own tokens are aged
	// as eight hours would age them, so GitHub would now refuse the credential — and what has to be
	// shown is that the app never presents it. The remedy comes from the check, and the only thing
	// that reached GitHub was the refresh that was refused.
	test('is caught before any work starts, rather than by a 401 partway through', async ({
		page
	}) => {
		const github = await start(page, { tokenLifetimeSeconds: ALREADY_STALE_SECONDS });
		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');

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

	test('surfaces as “sign in again” when the refresh is refused, and is not kept', async ({
		page
	}) => {
		const github = await start(page, { tokenLifetimeSeconds: ALREADY_STALE_SECONDS });
		await signInWithGitHub(page);
		// The redirect closed the dialog on its way through, so there is nothing to close here.
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');

		github.refuseRefresh();
		await openTheDoor(page);

		await expect(page.getByTestId('connect-expiry')).toContainText('sign-in has expired');
		await expect(page.getByTestId('connect-expiry')).toContainText('Sign in with GitHub');
		// ⚠ Cleared, not merely reported: every screen must render the not-signed-in state, so that a
		// publish started a moment later cannot pick up a credential GitHub has stopped honouring.
		expect(await holdsCredential(page)).toBe(false);
		expect(github.requests).toContain('/github/refresh');
	});
});

// ADR-0041: the credential rule narrows rather than falls. *Forgotten when the tab closes* becomes
// *forgotten when the tab closes unless the author has asked otherwise on this machine* — and what
// is kept is the renewable half, in the installation's own database, where neither a Backup nor a
// Publish walks.
test.describe('a sign-in kept past the tab', () => {
	// The pair that has to stay true: the scholar on a shared or lab machine
	// changes nothing, is changed by nothing, and is told which rule is in force while they decide.
	test('is not the default, says so, and leaves nothing when the tab closes', async ({ page }) => {
		await start(page);
		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');

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
		// Signed out, so the door is back at its first step and the sign-in is offered again — past the
		// account question, which is offered rather than detected.
		await openTheDoor(page);
		await expect(page.getByTestId('connect-signed-in')).toHaveCount(0);
		await page.getByTestId('connect-have-account').click();
		await expect(page.getByTestId('connect-sign-in-with-github')).toBeVisible();
	});

	// The refresh token is what survives; the eight-hour token that publishes is
	// kept nowhere at all, and the way back to one is the broker — which is what leaves the broker's
	// `Origin` allowlist in the path of anybody who took the database.
	test('keeps the renewable half only, and signs itself back in with it', async ({ page }) => {
		const github = await start(page, { login: 'ada' });
		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub as ada');

		await openTheDoor(page);
		await page.getByTestId('remember-sign-in').check();
		// The sentence turns over with the tick, because the scholar deciding is asking exactly this.
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
		// ⚠ **Asked of the whole browser, by value.** The access token must be nowhere — not in the
		// database that kept the refresh token, and not in a Workspace — and the refresh token must be
		// in exactly one place, which is the database this feature added.
		expect(await whereverTheTokenIs(page, held?.token ?? '')).toEqual([]);
		expect(await whereverTheTokenIs(page, held?.refreshToken ?? '')).toEqual([
			'indexedDB:ballastella/credential'
		]);

		const departures = github.requests.filter((path) => path === '/login/oauth/authorize').length;
		await page.reload();

		await openTheDoor(page);
		await expect(page.getByTestId('connect-signed-in')).toContainText('as ada');
		// A new access token, minted from the half that was kept — and no second trip to GitHub's
		// authorise screen, which is the whole of "a new sign-in is not required".
		expect(await holdsCredential(page)).toBe(true);
		expect((await grantRecord(page))?.token).not.toBe(held?.token);
		expect(github.requests).toContain('/github/refresh');
		expect(github.requests.filter((path) => path === '/login/oauth/authorize')).toHaveLength(
			departures
		);
	});

	// The three ways a kept sign-in ends, in one journey because each leg starts from the state the
	// one before it leaves. Unticking is an answer about this machine, so it has to take away what
	// ticking put there; **Sign out** means this machine rather than this tab; and a refresh token
	// that will no longer renew is a sign-in that has ended, thrown away rather than offered to the
	// broker again on every visit for ever — and announced to nobody, because the scholar did not
	// start that one.
	test('ends when it is unticked, when the author signs out, and when it will not renew', async ({
		page
	}) => {
		const github = await start(page);
		await signInWithGitHub(page);
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

		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');
		await keepTheSignIn(page);
		await openTheDoor(page);
		await page.getByTestId('connect-sign-out').click();
		await expect.poll(() => rememberedGrant(page)).toBeNull();
		await closeTheDoor(page);
		await reopenTheTab(page);
		expect(await holdsCredential(page)).toBe(false);

		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');
		await keepTheSignIn(page);
		github.refuseRefresh();
		await reopenTheTab(page);

		await expect.poll(() => rememberedGrant(page)).toBeNull();
		expect(await holdsCredential(page)).toBe(false);
		// Signed out, and told nothing about an expiry: there is no sign-in left to have expired, so
		// what is on offer is a fresh one, past the account question the first step asks.
		await openTheDoor(page);
		await expect(page.getByTestId('connect-expiry')).toHaveCount(0);
		await page.getByTestId('connect-have-account').click();
		await expect(page.getByTestId('connect-sign-in-with-github')).toBeVisible();
	});

	// Both places a held sign-in could leak from, out of one: `export-workspace-tar` walks a Workspace into a
	// file the author mails to a colleague, and a Publish uploads one to a public repository. The
	// archive's own bytes and the fake's received files are what is asked — a list of paths would
	// pass just as happily with the secret inside one of them.
	test('is in no Backup the author mails and no Publish they upload', async ({ page }) => {
		const github = await start(page);
		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');
		await keepTheSignIn(page);
		const held = await grantRecord(page);
		expect(held?.refreshToken).toBeTruthy();

		// Backup is in the Workspace's own dialog, beside its name (ADR-0042).
		const archive = await readFile(await (await backUpWorkspace(page)).path());
		expect(archive.includes(held?.refreshToken ?? '')).toBe(false);
		expect(archive.includes(held?.token ?? '')).toBe(false);
		await closeWorkspaceDialog(page);

		// Bound on the strength of the credential already held, which is what the sign-in door exists
		// to make possible: nothing is typed and nothing is pasted.
		await bindFromTheDoor(page);

		await openPublishFromTheDoor(page);
		const dialog = page.getByRole('dialog', { name: 'Publish this Workspace' });
		await expect(dialog.getByTestId('publish-breakdown')).toBeVisible({ timeout: 60_000 });
		await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
		await expect(page.getByTestId('publish-status')).toContainText('Published:', {
			timeout: 60_000
		});

		const uploaded = github.files(OWNER, REPOSITORY);
		expect(uploaded.length).toBeGreaterThan(0);
		const carrying = uploaded.filter((path) => {
			const text = github.fileText(OWNER, REPOSITORY, path) ?? '';
			return text.includes(held?.refreshToken ?? '') || text.includes(held?.token ?? '');
		});
		expect(carrying).toEqual([]);
	});
});

// ADR-0031's first consequence: *a fork with no infrastructure is fully functional, not degraded.*
// This is also the state **this deployment ships in** — `github-app.ts` points at a reserved domain
// that will never answer — so it is not a hypothetical.
test.describe('with no broker served at all', () => {
	// ⚠ **This is the state this deployment ships in, exactly**: GitHub is real and answers, and the
	// broker's host is reserved by RFC 2606 and resolves nowhere. So the scholar gets all the way
	// through the redirect and meets the failure at the exchange, and what has to come out of it is a
	// sentence naming the path that needs no service — not a blank screen, and not a token.
	test('the sign-in fails legibly, naming the path that needs no service', async ({ page }) => {
		const github = await start(page, { brokerUnreachable: true });

		await signInWithGitHub(page);

		await expect(page.getByTestId('sign-in-problem')).toContainText('could not be reached');
		await expect(page.getByTestId('sign-in-problem')).toContainText('personal access token');
		expect(await holdsCredential(page)).toBe(false);
		// Tried and could not, rather than never tried: the code went to the broker and no further.
		expect(github.requests).toContain('/github/token');
	});

	// ⚠ **The escape hatch, driven against the *real* `isGitHubAppConfigured(GITHUB_APP)`** (stories
	// 126 and 127). This checkout has an App configured, so the door offers the sign-in and no token
	// field — which is the state an instructor whose installation has broken is standing in, and the
	// one the disclosure exists for. Here rather than at Seam 1c because the gate is the deployment's
	// own value rather than a fake's, and because "the broker is on no data path" is a claim about
	// which hosts were reached: the broker's origin is routed and every request to it fails, so a
	// bind that touched it could not pass and one that did not is proved rather than assumed.
	test('the way in behind the disclosure binds with no request to the broker', async ({ page }) => {
		const github = await start(page, { brokerUnreachable: true });

		await openTheDoor(page);
		// Absent, not empty and not disabled, until somebody who knows what they are asking for asks.
		await expect(page.getByTestId('connect-token-field')).toHaveCount(0);
		await page.getByTestId('connect-other-way-in').click();

		await page.getByTestId('connect-repository-field').fill(REMOTE);
		await page.getByTestId('connect-token-field').fill(PASTED);
		await page.getByTestId('connect-paste').click();

		await expect(page.getByTestId('connect-outcome')).toContainText(REMOTE, { timeout: 30_000 });
		expect(await holdsCredential(page)).toBe(true);
		expect(github.requests).not.toContain('/github/token');
		expect(github.requests).not.toContain('/github/refresh');
	});

	// ⚠ **A held credential and a bound Workspace are two different durabilities, and both survive
	// with no service of any kind involved.** The credential is this tab's `sessionStorage` and the
	// binding is the installation's IndexedDB, so a reload is where a deployment whose broker will
	// never answer either goes on working or quietly forgets both.
	test('a bound Workspace survives a reload with its credential, broker or no broker', async ({
		page
	}) => {
		await start(page, { signIn: false });
		await seedRemoteRelationship(page, { owner: OWNER, repository: REPOSITORY });
		await seedGitHubCredential(page, PASTED);

		await page.reload();

		await expectRemoteNamed(page, REMOTE);
		await expectCredential(page, 'Signed in to GitHub');
	});
});

// ⚠ **The last second door, and the state a scholar reaches it from is an ordinary arrival.** The
// credential is this tab's and the binding is the installation's, so a bound Workspace reopened
// tomorrow morning and pressed to Publish is signed out with somewhere to publish to. It is the
// last screen in the editor that has a credential to ask for, so it is gated on the deployment's
// own answer exactly as every other one is: where an App is configured, no token field.
//
// It gets one test in a browser, here rather than in `editor-publish.e2e.ts`, because the claim is
// about the **real** `isGitHubAppConfigured(GITHUB_APP)`: the gate reads it through
// `WorkspaceStorage.signInWithGitHubOffered`, and this is the spec where that value is the subject
// rather than the setting. The round trip is the other half — a redirect off the page cannot be
// asserted anywhere but a browser, and what it has to land on is a publish.
test.describe('a bound Workspace pressed to Publish with no credential', () => {
	test('offers the GitHub sign-in and no token field, and the return leg reaches a publish', async ({
		page
	}) => {
		const github = await start(page, { login: OWNER });

		// Bound on the strength of the sign-in, which is how a bound Workspace comes to exist here.
		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');
		await bindFromTheDoor(page);

		// ⚠ **Tomorrow morning's tab, reached rather than simulated.** Taking the sign-in out of
		// `sessionStorage` and reloading is precisely what closing the tab does to it; the binding is in
		// the installation database and survives, which is the asymmetry that makes this state ordinary.
		await page.evaluate(() => {
			sessionStorage.removeItem('ballastella.github-credential');
			sessionStorage.removeItem('ballastella.github-app-session');
		});
		await page.reload();
		await expectRemoteNamed(page, REMOTE);
		expect(await holdsCredential(page)).toBe(false);

		await openPublishFromTheDoor(page);
		const dialog = page.getByRole('dialog', { name: 'Publish this Workspace' });
		await expect(dialog.getByTestId('publish-sign-in-needed')).toContainText(REMOTE);
		// ⚠ **Absent, not empty and not disabled**, and this is the deployment's own answer rather than
		// a fake's: nothing in this spec configures `GITHUB_APP`, it is what the app was built with.
		await expect(dialog.getByTestId('publish-token-field')).toHaveCount(0);

		await dialog.getByTestId('publish-sign-in-with-github').click();

		// The redirect replaces the document, so nothing in the dialog resumes: the mark reopens the
		// door, and a Workspace that is already bound derives its `connected` step — whose **Publish…**
		// is the same dialog. Signing in from Publish therefore arrives back at Publish, which is the
		// whole reason the dialog is not closed to open the door and the door gains no extra step.
		await expect(page.getByTestId('connect-outcome')).toContainText(REMOTE, { timeout: 30_000 });
		expect(await holdsCredential(page)).toBe(true);

		await page.getByTestId('connect-publish').click();
		await expect(dialog.getByTestId('publish-breakdown')).toBeVisible({ timeout: 30_000 });
		await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
		await expect(page.getByTestId('publish-status')).toContainText('Published:', {
			timeout: 60_000
		});

		// What arrived, rather than which calls were made: the repository is serving a site.
		expect(github.files(OWNER, REPOSITORY)).toContain('index.html');
	});
});

// ⚠ **The one Seam 2 test the guided sequence gets, and it is about *wiring*.** Every state of the
// sequence, every sentence it says, and every outcome it renders are asserted at Seam 1c against a
// fake store (`apps/editor/src/lib/components/connect-to-github.dom.test.ts`), and what the listing
// and the bind do with what they are given is asserted at Seam 1 against this same fake GitHub. All
// of that would stay green if the application never connected the component to anything — which is
// the one failure no seam below can see, and the whole reason this test costs what it costs.
//
// It is one test rather than five because each leg's starting state is the state the leg before it
// leaves: the sign-in has to have happened for the listing to be readable, the listing has to have
// been read for a repository to be choosable, and the connection has to have been made for the
// Publish it hands off to to have anywhere to go.
test.describe('the guided sequence, wired to the real thing', () => {
	test('goes from the navigation bar through sign-in and a chosen repository to a published site', async ({
		page
	}) => {
		const github = await start(page, {
			login: OWNER,
			grants: {
				installationId: 1,
				account: OWNER,
				repositories: [{ owner: OWNER, repository: REPOSITORY, push: true }]
			}
		});

		// ⚠ **Nothing is asked of an author who has decided nothing, and this is the only seam that can
		// see the whole screen.** A scholar arrives with a Workspace already made and meets no dialog,
		// no sign-in and no prompt. What says GitHub at all is two controls, and both are doors: the
		// bar's one door, and the reviewer's way in from a link somebody sent them (ADR-0024, whose
		// re-homing of Workspace Home is a later slice's). Neither is open and neither is a question.
		//
		// Read as every element on screen whose own words say it, so a sentence added anywhere fails
		// this rather than slipping past a locator that was only ever asked about one testid.
		//
		// A closed `<dialog>` keeps its children in the document, and daisyUI's `.modal` keeps them laid
		// out as well — `ModalDialog` says so where it has to work around the same thing — so `dialog:
		// not([open])` is what tells "in the tree" from "on screen". Clipped text is on screen: the
		// bar's announcements are read aloud, and a sentence about GitHub hidden in one would still
		// reach the reader this story is written for.
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

		// One control, in the bar, on Workspace Home — before any Project is open.
		await page.getByTestId('connect-to-github').click();

		// The first thing on screen is the prerequisite, rather than a sign-in button that cannot
		// succeed for somebody with no GitHub account. It is offered rather than detected, so
		// somebody who has an account presses past it — which is what this fake author is.
		await expect(page.getByTestId('connect-needs-account')).toBeVisible();
		await page.getByTestId('connect-have-account').click();
		await expect(page.getByTestId('connect-sign-in')).toBeVisible();

		// Out to GitHub, authorise, and back **inside the sequence** at the next step.
		// The redirect replaces the document, so landing on the choice is the claim no fake can carry.
		await page.getByTestId('connect-sign-in-with-github').click();
		await expect(page.getByTestId('connect-choosing')).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId('connect-account')).toContainText(`as ${OWNER}`);

		// The list is GitHub's own answer, and choosing is one act.
		await expect(page.getByTestId('granted-repository')).toHaveText(new RegExp(REMOTE));
		await page.getByTestId('choose-repository').click();

		await expect(page.getByTestId('connect-outcome')).toContainText(REMOTE, { timeout: 30_000 });
		// The address the assignment asked for.
		await expect(page.getByTestId('published-site-address')).toHaveText(
			`https://${OWNER}.github.io/${REPOSITORY}/`
		);

		// ⚠ **Connecting turned nothing on**, because a Remote is a place the work lives before it is
		// a site anybody reads. Letting other people see it is the press after it, and this is the one
		// place the whole of that act is wired to the real GitHub.
		expect(github.pagesOn(OWNER, REPOSITORY)).toBe(false);
		await page.getByTestId('enable-pages').click();
		await expect(page.getByTestId('pages-enabled')).toBeVisible({ timeout: 30_000 });
		expect(github.pagesOn(OWNER, REPOSITORY)).toBe(true);

		// The handoff is the door's own **Publish…**, and it reaches GitHub.
		await page.getByTestId('connect-publish').click();
		const dialog = page.getByRole('dialog', { name: 'Publish this Workspace' });
		await expect(dialog.getByTestId('publish-breakdown')).toBeVisible({ timeout: 30_000 });
		await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
		await expect(page.getByTestId('publish-status')).toContainText('Published:', {
			timeout: 60_000
		});

		// What arrived, rather than which calls were made: the repository is serving a site.
		expect(github.files(OWNER, REPOSITORY)).toContain('index.html');
	});
});
