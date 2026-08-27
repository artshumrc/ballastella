import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { whereverTheTokenIs } from './support/credential-scan.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { routeGitHubHosts } from './support/github-hosts.js';
import { oneProjectBundle } from './support/project-bundle.js';
import {
	closeRemoteSettings,
	expectCredential,
	expectNoRemote,
	expectRemoteNamed,
	expectWorkspaceNamed,
	openRemoteSettings,
	revealBindToken
} from './support/workspace';

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
 *   - the callback's parameters leaving the address bar, with the open Workspace untouched, and the
 *     Project put back only for a reply this tab asked for;
 *   - the address the exchange names being the one the authorisation named, which only a page
 *     reached by a filename can tell apart from the one recomputed on return;
 *   - a forged or absent `state` refused, and a declined authorisation told apart from a bad code;
 *   - an expired sign-in renewed through the broker, or surfaced as "sign in again" before any work
 *     starts — and not taking a token pasted since down with it;
 *   - a Review Workspace reading, offering and spending nothing (story 40, ticket 03's criterion 9);
 *   - and, with no broker, the sign-in failing legibly while the pasted token binds as it always did.
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

/** Whether a push credential is held at all, asked of the app rather than of a screen. */
const holdsCredential = (page: Page): Promise<boolean> =>
	page.evaluate(() => sessionStorage.getItem('ballastella.github-credential') !== null);

/** The grant record as the browser holds it, or `null`. Read behind the app's back. */
const grantRecord = (page: Page): Promise<{ token: string; refreshToken: string } | null> =>
	page.evaluate(() => {
		const raw = sessionStorage.getItem('ballastella.github-app-session');
		return raw === null ? null : (JSON.parse(raw) as { token: string; refreshToken: string });
	});

/** Press the button and wait for the round trip through GitHub to land back here. */
async function signInWithGitHub(page: Page): Promise<void> {
	await openRemoteSettings(page);
	await page.getByTestId('sign-in-with-github').click();
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

	// SPEC story 57: a scholar who changes their mind on GitHub's own screen is sent back with
	// `error=access_denied`, **the real `state`**, and no code at all. Read as a code-and-state pair
	// alone, that verifies and then posts the empty string to the broker — so somebody who chose
	// Cancel was told the code passed was incorrect or expired.
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

	// ADR-0033, SPEC "Out of scope" item 9: the credential and the grant beside it live in
	// `sessionStorage` and nowhere else. `localStorage` holds the write-ahead journal, and the
	// Workspace is what a Backup packs and a Publish uploads.
	//
	// ⚠ **The refresh token is scanned for by value, and it is the one that matters most.** It
	// outlives the eight-hour access token it mints and is the longer-lived credential of the two, so
	// ticket 03's scan — the same function, comparing values and walking OPFS and IndexedDB as well
	// as web storage — is what asks. A scan that enumerated keys would report the same shape here
	// while asserting nothing about where the secret actually is.
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

	test('names the account in the Workspace menu once the Workspace is bound', async ({ page }) => {
		await start(page, { login: 'ada' });
		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('as ada');

		await openRemoteSettings(page);
		await page.getByTestId('remote-repository-field').fill(REMOTE);
		await revealBindToken(page);
		await page.getByTestId('remote-token-field').fill(PASTED);
		await page.getByTestId('bind-remote').click();
		await expect(page.getByTestId('remote-outcome')).toContainText(REMOTE);
		await closeRemoteSettings(page);

		await expectCredential(page, 'Signed in to GitHub as ada');
	});
});

// ⚠ **The front door's whole point, and it did not work.** A sign-in is acquired *before* there is
// anything to bind to — that is the order the screen offers — so the binding form is the first thing
// a signed-in scholar meets, and it used to validate its paste field regardless and refuse an empty
// one. Signing in and then being told to paste a personal access token leaves the button decorative.
test.describe('binding while already signed in', () => {
	test('binds with nothing pasted, on the strength of the sign-in', async ({ page }) => {
		await start(page, { login: 'ada' });
		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('as ada');

		await openRemoteSettings(page);
		await page.getByTestId('remote-repository-field').fill(REMOTE);
		// ⚠ **Not merely empty: not on the screen** (SPEC stories 37, 46). This used to be a field
		// with an empty value beside the button, which is exactly the two-credentials question a
		// signed-in scholar must never be asked. It is behind the escape hatch now.
		await expect(page.getByTestId('remote-token-field')).toHaveCount(0);
		await page.getByTestId('bind-remote').click();

		await expect(page.getByTestId('remote-outcome')).toContainText(REMOTE);
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

		await openRemoteSettings(page);
		await page.getByTestId('remote-repository-field').fill(REMOTE);
		await page.getByTestId('bind-remote').click();
		await expect(page.getByTestId('remote-outcome')).toContainText(REMOTE);

		expect(await grantRecord(page)).toEqual(before);
	});

	// ⚠ **Two claims deliberately not made here.** That a paste still wins over the sign-in is
	// already covered by "shows the account on the bar once the Workspace is bound" above, which
	// binds with `PASTED` while signed in. That an empty field with nobody signed in is still
	// refused is a path this change does not touch: `describeTokenProblem` sees the empty string
	// exactly as it did before.
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

		/** What the two halves of the flow actually put on the wire, read off the requests. */
		let authorized = '';
		let exchanged = '';
		page.on('request', (request) => {
			const url = new URL(request.url());
			// Matched by path, never by host: `check-github-broker.mjs` refuses a spec that writes the
			// broker's address down, and GitHub's own is not this spec's business either.
			if (url.pathname === '/login/oauth/authorize') {
				authorized = url.searchParams.get('redirect_uri') ?? '';
			}
			if (url.pathname === '/github/token' && request.method() === 'POST') {
				exchanged =
					(JSON.parse(request.postData() ?? '{}') as { redirect_uri?: string }).redirect_uri ?? '';
			}
		});

		await page.goto('./index.html');
		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');

		// The premise: the two spellings really were different, so the assertion below is about the app
		// rather than about a coincidence.
		expect(authorized).toContain('/index.html');
		expect(exchanged).toBe(authorized);
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

	// The ticket's seventh acceptance criterion, end to end: *before* a publish starts, not during
	// one. The fake's own tokens are aged as eight hours would age them, so GitHub would now refuse
	// the credential — and what has to be shown is that the app never presents it. The remedy comes
	// from the check, and the only thing that reached GitHub was the refresh that was refused.
	test('is caught before any work starts, rather than by a 401 partway through', async ({
		page
	}) => {
		const github = await start(page, { tokenLifetimeSeconds: ALREADY_STALE_SECONDS });
		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');

		github.expireSignIn();
		github.refuseRefresh();
		const asked = github.requests.length;

		await openRemoteSettings(page);

		await expect(page.getByTestId('remote-problem')).toContainText('sign-in has expired');
		expect(await holdsCredential(page)).toBe(false);
		expect(
			github.requests.slice(asked).filter((path) => path.startsWith('/repos/') || path === '/user')
		).toEqual([]);
	});

	// ⚠ **A record is only ever about the credential it names.** Nothing clears it when a token
	// arrives by paste, so a scholar whose sign-in has run out and who pastes a working personal
	// access token instead was, on the next opening of this screen, told that sign-in had expired —
	// and the token they had just pasted was thrown away to prove it.
	test('does not take a pasted token down with it', async ({ page }) => {
		const github = await start(page, { tokenLifetimeSeconds: ALREADY_STALE_SECONDS });
		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub');

		// Opening the screen renews the stale grant, so a record — a fresh one, for a token that is
		// about to stop being the one held — is in place when the paste happens.
		await openRemoteSettings(page);
		await expect(page.getByTestId('remote-repository-field')).toBeVisible();
		await page.getByTestId('remote-repository-field').fill(REMOTE);
		await revealBindToken(page);
		await page.getByTestId('remote-token-field').fill(PASTED);
		await page.getByTestId('bind-remote').click();
		await expect(page.getByTestId('remote-outcome')).toContainText(REMOTE);
		await closeRemoteSettings(page);

		// Whatever the App session was, it is over: the refresh below must never be reached, because
		// there is nothing left to refresh.
		github.refuseRefresh();
		await openRemoteSettings(page);

		await expect(page.getByTestId('remote-signed-in')).toBeVisible();
		await expect(page.getByTestId('remote-problem')).toHaveCount(0);
		expect(await page.evaluate(() => sessionStorage.getItem('ballastella.github-credential'))).toBe(
			PASTED
		);
		expect(await grantRecord(page)).toBeNull();
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

// ADR-0024, SPEC story 40 and ticket 03's ninth criterion: *with a Review Workspace open, the
// credential store neither reads nor writes.* The App path has two more things to seal than the
// pasted one — the sign-in button, and the grant record whose refresh token can mint fresh
// credentials — and it is asserted here rather than only in `editor-remote-binding.e2e.ts` because
// none of the three exists over there.
test.describe('a Review Workspace, with a GitHub sign-in held', () => {
	test('reads no sign-in, offers none, and spends nothing while it is open', async ({ page }) => {
		// Stale on arrival, which is what makes the refresh below a thing that *would* happen: this is
		// the exact state in which a sealed record is the difference between doing nothing and sending
		// a teacher's refresh token to the broker from inside a student's submission.
		const github = await start(page, { tokenLifetimeSeconds: ALREADY_STALE_SECONDS, login: 'ada' });
		await signInWithGitHub(page);
		await expect(page.getByTestId('sign-in-outcome')).toContainText('Signed in to GitHub as ada');
		const held = await grantRecord(page);
		expect(held?.refreshToken).toBeTruthy();
		const asked = github.requests.length;

		await page.getByTestId('open-bundle').click();
		await page
			.getByRole('dialog', { name: 'Review a Project' })
			.getByLabel('Project bundle')
			.setInputFiles(await oneProjectBundle());
		await page.getByTestId('confirm-open-bundle').click();
		await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 30_000 });

		await expectNoRemote(page);
		await openRemoteSettings(page);
		await expect(page.getByTestId('no-remote-in-review')).toContainText(
			'cannot be bound to a repository'
		);
		// ⚠ **The three assertions the seal is read by.** The teacher signed in moments ago and both
		// records are still in `sessionStorage` — sealed, not deleted — so a store that answered a
		// review copy would put every one of these on the screen a submission is open on. The button is
		// the one a gate widened on `signInWithGitHubOffered` brought back: it answers a question about
		// the deployment, which no seal moves.
		await expect(page.getByTestId('remote-signed-in')).toHaveCount(0);
		await expect(page.getByTestId('remote-sign-out')).toHaveCount(0);
		await expect(page.getByTestId('sign-in-with-github')).toHaveCount(0);
		await closeRemoteSettings(page);

		// ⚠ **And nothing was spent.** Opening that screen is what asks whether the sign-in is still
		// good, and the held grant is stale — so an unsealed record would have sent the refresh token
		// to the broker from inside somebody else's Project, and an unsealed clear would have ended
		// the teacher's own session on their behalf.
		expect(github.requests.slice(asked)).toEqual([]);
		expect(await grantRecord(page)).toEqual(held);
		expect(await holdsCredential(page)).toBe(true);

		// Sealed rather than deleted: the same locators, the opposite answers, one gesture apart.
		await page.getByTestId('leave-review').click();
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
		await openRemoteSettings(page);
		await expect(page.getByTestId('remote-signed-in')).toBeVisible();
		expect(github.requests).toContain('/github/refresh');
	});
});

// SPEC story 56 and ADR-0031's first consequence: *a fork with no infrastructure is fully
// functional, not degraded.* This is also the state **this deployment ships in** — `github-app.ts`
// points at a reserved domain that will never answer — so it is not a hypothetical.
test.describe('with no broker served at all', () => {
	test('the pasted token still binds, with nothing anywhere near the broker', async ({ page }) => {
		// `signIn: false`: the authorize address and the broker are not routed, so the default-deny
		// network fence aborts any request to either. That is a broker that is not there.
		const github = await start(page, { signIn: false });

		await openRemoteSettings(page);
		await page.getByTestId('remote-repository-field').fill(REMOTE);
		await revealBindToken(page);
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

	// ⚠ **This is the state this deployment ships in, exactly**: GitHub is real and answers, and the
	// broker's host is reserved by RFC 2606 and resolves nowhere. So the scholar gets all the way
	// through the redirect and meets the failure at the exchange, and what has to come out of it is a
	// sentence naming the path that needs no service — not a blank screen, and not a token.
	test('the sign-in fails legibly, and the paste is offered on the same screen', async ({
		page
	}) => {
		const github = await start(page, { brokerUnreachable: true });

		await signInWithGitHub(page);

		await expect(page.getByTestId('sign-in-problem')).toContainText('could not be reached');
		await expect(page.getByTestId('sign-in-problem')).toContainText('personal access token');
		expect(await holdsCredential(page)).toBe(false);
		// Tried and could not, rather than never tried: the code went to the broker and no further.
		expect(github.requests).toContain('/github/token');

		// And the remedy on offer works, on the same screen, with the broker still unreachable.
		await openRemoteSettings(page);
		await page.getByTestId('remote-repository-field').fill(REMOTE);
		await revealBindToken(page);
		await page.getByTestId('remote-token-field').fill(PASTED);
		await page.getByTestId('bind-remote').click();

		await expect(page.getByTestId('remote-outcome')).toContainText(
			`This Workspace is bound to ${REMOTE}`
		);
		expect(github.pagesOn(OWNER, REPOSITORY)).toBe(true);
	});

	// ⚠ **The gate itself, which no seam below this one can see** (SPEC stories 37, 46, 50, and this
	// ticket's first two criteria). Which fields `RemoteSettings` renders for which value of
	// `signInWithGitHubOffered` is markup, and the derivation is asserted at Seam 1c — but *the value
	// this deployment computes* is `isGitHubAppConfigured(GITHUB_APP)` read out of the real
	// `WorkspaceStorage` in the real application, and a component seam is given it rather than reading
	// it. So: the screen a scholar actually meets, in the state this deployment actually ships in.
	//
	// The broker is unreachable here because that is the fork's own case as well as this deployment's,
	// and it makes the second half a real claim rather than a convenience: the paste is not deleted,
	// it is one press away, and it still binds with no service of any kind involved.
	test('offers no token field until the escape hatch is opened, and the paste behind it still binds', async ({
		page
	}) => {
		const github = await start(page, { brokerUnreachable: true });

		await openRemoteSettings(page);

		// ⚠ **Absent, not empty and not disabled.** A student on this deployment is never asked to
		// choose between two credentials, so neither field exists until somebody asks for it.
		await expect(page.getByTestId('remote-token-field')).toHaveCount(0);
		await expect(page.getByTestId('remote-sign-in-field')).toHaveCount(0);
		// And the sign-in is what is on the screen instead, with the hatch not a peer of it.
		await expect(page.getByTestId('sign-in-with-github')).toBeVisible();

		// Opened, then closed again with the dialog: an escape hatch left standing open would be on the
		// screen of whoever opens this next, which is the second door this epic exists to remove.
		await revealBindToken(page);
		await closeRemoteSettings(page);
		await openRemoteSettings(page);
		await expect(page.getByTestId('remote-token-field')).toHaveCount(0);

		await revealBindToken(page);
		await page.getByTestId('remote-repository-field').fill(REMOTE);
		await page.getByTestId('remote-token-field').fill(PASTED);
		await page.getByTestId('bind-remote').click();

		await expect(page.getByTestId('remote-outcome')).toContainText(
			`This Workspace is bound to ${REMOTE}`
		);
		expect(await holdsCredential(page)).toBe(true);
		expect(github.pagesOn(OWNER, REPOSITORY)).toBe(true);
		// And nothing in that path went near the broker, which is not there anyway.
		expect(github.requests.filter((path) => path.startsWith('/github/'))).toEqual([]);
	});

	test('a bound Workspace survives a reload with its credential, broker or no broker', async ({
		page
	}) => {
		await start(page, { signIn: false });
		await openRemoteSettings(page);
		await page.getByTestId('remote-repository-field').fill(REMOTE);
		await revealBindToken(page);
		await page.getByTestId('remote-token-field').fill(PASTED);
		await page.getByTestId('bind-remote').click();
		await expect(page.getByTestId('remote-outcome')).toContainText(REMOTE);
		await closeRemoteSettings(page);

		await page.reload();

		await expectRemoteNamed(page, REMOTE);
		await expectCredential(page, 'Signed in to GitHub');
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

		// Story 1 and 2: one control, in the bar, on Workspace Home — before any Project is open.
		await page.getByTestId('connect-to-github').click();

		// Story 3: the first thing on screen is the prerequisite, rather than a sign-in button that
		// cannot succeed for somebody with no GitHub account. It is offered rather than detected, so
		// somebody who has an account presses past it — which is what this fake author is.
		await expect(page.getByTestId('connect-needs-account')).toBeVisible();
		await page.getByTestId('connect-have-account').click();
		await expect(page.getByTestId('connect-sign-in')).toBeVisible();

		// Story 7 and 8: out to GitHub, authorise, and back **inside the sequence** at the next step.
		// The redirect replaces the document, so landing on the choice is the claim no fake can carry.
		await page.getByTestId('connect-sign-in-with-github').click();
		await expect(page.getByTestId('connect-choosing')).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId('connect-account')).toContainText(`as ${OWNER}`);

		// Story 11 and 26: the list is GitHub's own answer, and choosing is one act.
		await expect(page.getByTestId('granted-repository')).toHaveText(new RegExp(REMOTE));
		await page.getByTestId('choose-repository').click();

		await expect(page.getByTestId('connect-outcome')).toContainText(REMOTE, { timeout: 30_000 });
		// Story 29: Pages was turned on as part of that one press, with nothing else asked of anybody.
		expect(github.pagesOn(OWNER, REPOSITORY)).toBe(true);
		// Story 32: the address the assignment asked for.
		await expect(page.getByTestId('published-site-address')).toHaveText(
			`https://${OWNER}.github.io/${REPOSITORY}/`
		);

		// Story 28: the handoff is the Publish button that was always on the bar, and it reaches GitHub.
		await page.getByTestId('connect-publish').click();
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByTestId('publish-breakdown')).toBeVisible({ timeout: 30_000 });
		await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
		await expect(page.getByTestId('publish-status')).toContainText('Published:', {
			timeout: 60_000
		});

		// What arrived, rather than which calls were made: the repository is serving a site.
		expect(github.files(OWNER, REPOSITORY)).toContain('index.html');
	});
});
