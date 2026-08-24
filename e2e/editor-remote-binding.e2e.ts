import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { readFile } from 'node:fs/promises';

import { whereverTheTokenIs } from './support/credential-scan.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { routeGitHubHosts } from './support/github-hosts.js';
import { oneProjectBundle } from './support/project-bundle.js';
import {
	closeRemoteSettings,
	closeWorkspaceSettings,
	expectCredential,
	expectNoRemote,
	expectRemoteNamed,
	expectRemoteStatus,
	expectWorkspaceNamed,
	openRemoteSettings,
	openWorkspaceSettings
} from './support/workspace';

/**
 * A Workspace bound to a Remote (ticket 03, ADR-0032, ADR-0033).
 *
 * SPEC's Seam 2. The binding document, its tolerant reader, the rights check, the Pages outcomes and
 * the two hard refusals are all asserted at Seam 1 — `remote-binding.test.ts`, `bind-remote.test.ts`
 * and `credential-store.test.ts` in `@ballastella/core`, where the assertion is the bytes and the
 * answer rather than a screen. What only a browser can show is here:
 *
 *   - the binding is made from the Workspace menu, and is still there after a reload, because it is
 *     a file in the Workspace rather than a fact about this tab;
 *   - the workspace menu's header states where the work will go and whether anything may push it
 *     there;
 *   - a refused credential is refused **and not kept anywhere** — not in web storage, and not in the
 *     Workspace, which is where a Backup and a Publish would carry it from;
 *   - a folder Workspace binds exactly as a browser one does, because the binding code branches on
 *     neither backing;
 *   - a first visit is never asked to sign in, and asks GitHub nothing.
 *
 * Nothing here publishes. That is ticket 04.
 */

const HUB = './';

/** A token of the right shape. Its value never matters: the fake looks only for a credential. */
const TOKEN = 'github_pat_11ABCDE0000abcdefghijklmnop';
const OWNER = 'ada';
const REPOSITORY = 'atlas';
const REMOTE = `${OWNER}/${REPOSITORY}`;

// Every spec in this suite is behind the default-deny network fence, and the hub draws a Base Map
// from an archive on somebody else's host. Routed to the committed fixture for the whole file, on
// the `context` rather than the `page`, so a request that has been through a service worker is
// covered too.
test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

/** Empty the whole of browser storage — every named Workspace — so no test sees another's. */
async function emptyBrowserStorage(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
		localStorage.clear();
		sessionStorage.clear();
		// **And the installation database** (ADR-0038), which is where the Remote relationship lives.
		// Left behind, a Workspace made under the same name in the next scenario arrives already bound.
		await new Promise<void>((resolve) => {
			const request = indexedDB.deleteDatabase('ballastella');
			request.onsuccess = () => resolve();
			request.onerror = () => resolve();
			request.onblocked = () => resolve();
		});
	});
}

/** Put a v1 `remote.json` in the Workspace, as an older build of Ballastella left one. */
async function seedBindingFile(page: Page, owner: string, repository: string): Promise<void> {
	await page.evaluate(
		async ([workspace, text]) => {
			const directory = await (
				await navigator.storage.getDirectory()
			).getDirectoryHandle(workspace!, { create: true });
			const file = await directory.getFileHandle('remote.json', { create: true });
			const writable = await file.createWritable();
			await writable.write(text!);
			await writable.close();
		},
		[
			DEFAULT_WORKSPACE,
			`${JSON.stringify({ formatVersion: 1, owner, repository, branch: 'main' }, null, '\t')}\n`
		]
	);
}

/** Start on a clean hub with a GitHub that has one public repository in it. */
async function start(page: Page, options: Parameters<typeof routeGitHubHosts>[1] = {}) {
	const github = await routeGitHubHosts(page, {
		repositories: [{ owner: OWNER, name: REPOSITORY }],
		...options
	});
	await page.goto(HUB);
	await emptyBrowserStorage(page);
	await page.reload();
	return github;
}

/** Fill the bind form and press the button. Does not assert the outcome — each test says its own. */
async function bind(page: Page, repository = REMOTE, token = TOKEN): Promise<void> {
	await openRemoteSettings(page);
	await page.getByTestId('remote-repository-field').fill(repository);
	await page.getByTestId('remote-token-field').fill(token);
	await page.getByTestId('bind-remote').click();
}

/** `remote.json` as the Workspace holds it, or `null`. */
async function bindingFile(page: Page, workspace = DEFAULT_WORKSPACE): Promise<string | null> {
	return page.evaluate(async (name) => {
		try {
			const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
			return await (await (await directory.getFileHandle('remote.json')).getFile()).text();
		} catch {
			return null;
		}
	}, workspace);
}

test.describe('binding a Workspace to a repository', () => {
	test('is done from the Workspace menu, and survives a reload (stories 4, 30)', async ({
		page
	}) => {
		await start(page);

		await bind(page);

		await expect(page.getByTestId('remote-outcome')).toContainText(
			`This Workspace is bound to ${REMOTE}`
		);
		await closeRemoteSettings(page);

		// The binding is a **file in the Workspace**, not a fact about this tab — which is what makes
		// it survive a reload, travel into a folder, and come back out of a Clone.
		expect(JSON.parse((await bindingFile(page)) ?? 'null')).toEqual({
			formatVersion: 1,
			owner: OWNER,
			repository: REPOSITORY,
			branch: 'main'
		});

		await page.reload();
		await expectRemoteNamed(page, REMOTE);
	});

	test('states the Remote and the sign-in in the Workspace menu’s header (story 36)', async ({
		page
	}) => {
		await start(page);

		await bind(page);
		await closeRemoteSettings(page);

		await expectRemoteNamed(page, REMOTE);
		await expectCredential(page, 'Signed in to GitHub');
	});

	test('takes the whole address out of the browser’s bar, not only owner/repository', async ({
		page
	}) => {
		await start(page);

		await bind(page, `https://github.com/${REMOTE}`);

		await expect(page.getByTestId('remote-outcome')).toContainText(REMOTE);
	});

	// SPEC story 8. The one step the tool does not take is still a short one when the field arrives
	// filled in, and the offer is made *before* the refusal rather than only after it.
	test('offers a link to create the repository, with the name prefilled', async ({ page }) => {
		await start(page);
		await openRemoteSettings(page);

		const link = page.getByTestId('create-repository');
		await expect(link).toHaveAttribute('href', 'https://github.com/new?name=my-workspace');
	});

	test('says so when there is no such repository, rather than binding to nothing', async ({
		page
	}) => {
		await start(page);

		await bind(page, `${OWNER}/not-a-repository`);

		await expect(page.getByTestId('remote-problem')).toContainText(
			'private repository looks exactly like a missing one'
		);
		expect(await bindingFile(page)).toBeNull();
	});
});

// SPEC story 5, ADR-0033: *"Push rights are checked when a Remote is bound, not when 4,000 tiles
// have finished uploading."* The binding still succeeds, because it is provenance rather than
// permission — what must not happen is discovering the refusal after an upload.
test.describe('a credential that cannot push', () => {
	test('says so plainly, and the binding still succeeds', async ({ page }) => {
		await start(page, { repositories: [{ owner: OWNER, name: REPOSITORY, push: false }] });

		await bind(page);

		await expect(page.getByTestId('remote-outcome')).toContainText(
			`This Workspace is bound to ${REMOTE}`
		);
		await expect(page.getByTestId('remote-notice').first()).toContainText(
			`cannot push to ${REMOTE}`
		);
		await expect(page.getByTestId('remote-notice').first()).toContainText(
			'Contents: Read and write'
		);
		await closeRemoteSettings(page);
		await expectRemoteNamed(page, REMOTE);
	});
});

// SPEC stories 6 and 7. A repository full of correct files that serves nothing is the failure; an
// error dialog over a binding that otherwise worked is a worse one.
test.describe('turning Pages on', () => {
	test('turns it on when the credential is permitted to', async ({ page }) => {
		const github = await start(page);

		await bind(page);
		await expect(page.getByTestId('remote-outcome')).toContainText(REMOTE);

		expect(github.pagesOn(OWNER, REPOSITORY)).toBe(true);
		await expect(page.getByTestId('remote-notice')).toHaveCount(0);
	});

	// A scholar binding a second machine to the repository they published from last week meets this
	// every time, and it is success: the site already serves.
	test('treats “already enabled” as success, with nothing to say', async ({ page }) => {
		await start(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY, pagesEnabled: true }]
		});

		await bind(page);

		await expect(page.getByTestId('remote-outcome')).toContainText(REMOTE);
		await expect(page.getByTestId('remote-notice')).toHaveCount(0);
	});

	test('names the setting, the branch and the folder when it could not', async ({ page }) => {
		await start(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY, refusePages: true }]
		});

		await bind(page);

		const notice = page.getByTestId('remote-notice').first();
		await expect(notice).toContainText('Settings → Pages');
		await expect(notice).toContainText('Deploy from a branch');
		await expect(notice).toContainText('/ (root)');
		// And the binding stands, which is the half a refusal would have cost.
		await expect(page.getByTestId('remote-outcome')).toContainText(REMOTE);
	});
});

test.describe('the pasted credential', () => {
	test('is refused before any request when it is not a token at all (story 31)', async ({
		page
	}) => {
		const github = await start(page);

		await bind(page, REMOTE, 'ghp_short');

		await expect(page.getByTestId('remote-problem')).toContainText('too short');
		// Nothing was asked of GitHub, and nothing was bound: the cheap check is what makes a mistyped
		// paste cost a sentence rather than a round trip.
		expect(github.requests).toEqual([]);
		expect(await bindingFile(page)).toBeNull();
	});

	test('is refused when GitHub will not accept it, and is not kept', async ({ page }) => {
		await start(page, { rejectCredential: true });

		await bind(page);

		await expect(page.getByTestId('remote-problem')).toContainText('would not accept that token');
		expect(await bindingFile(page)).toBeNull();
		expect(await whereverTheTokenIs(page, TOKEN)).toEqual([]);
	});

	// ADR-0033. The token may be in `sessionStorage` and nowhere else: `localStorage` holds the
	// write-ahead journal, and the Workspace is what a Backup packs and a Publish uploads.
	test('is kept in session storage only, never in the Workspace and never in localStorage', async ({
		page
	}) => {
		await start(page);

		await bind(page);
		await closeRemoteSettings(page);

		expect(await whereverTheTokenIs(page, TOKEN)).toEqual([
			'sessionStorage:ballastella.github-credential'
		]);
	});

	test('survives a reload and is forgotten on signing out (stories 35, 37)', async ({ page }) => {
		await start(page);
		await bind(page);
		await closeRemoteSettings(page);

		await page.reload();
		await expectCredential(page, 'Signed in to GitHub');

		await openRemoteSettings(page);
		await page.getByTestId('remote-sign-out').click();
		await expect(page.getByTestId('remote-outcome')).toContainText('Signed out of GitHub');
		await closeRemoteSettings(page);

		await expectCredential(page, 'Not signed in');
		expect(await whereverTheTokenIs(page, TOKEN)).toEqual([]);

		// And a reload after signing out has none, which is the half `sessionStorage` could have got
		// wrong quietly: the binding is still there, and the credential is not.
		await page.reload();
		await expectRemoteNamed(page, REMOTE);
		await expectCredential(page, 'Not signed in');
	});

	// SPEC story 37: *"a way to sign out, so that I can hand my machine to somebody"*. Unbinding
	// deliberately leaves the credential alive — it belongs to a GitHub account rather than to this
	// Workspace — so a sign-in section gated on the binding took the only Sign out button off the
	// screen at exactly the moment it was still needed, and the token stayed in the tab.
	test('can still be signed out of after unbinding (story 37)', async ({ page }) => {
		await start(page);
		await bind(page);
		await page.getByTestId('unbind-remote').click();
		await expect(page.getByTestId('remote-outcome')).toContainText('no longer publishes');

		await page.getByTestId('remote-sign-out').click();

		await expect(page.getByTestId('remote-outcome')).toContainText('Signed out of GitHub');
		expect(await whereverTheTokenIs(page, TOKEN)).toEqual([]);
	});

	test('can be supplied again for a Workspace that is already bound (story 30)', async ({
		page
	}) => {
		await start(page);
		await bind(page);
		await closeRemoteSettings(page);
		await openRemoteSettings(page);
		await page.getByTestId('remote-sign-out').click();

		await page.getByTestId('remote-sign-in-field').fill(TOKEN);
		await page.getByTestId('remote-sign-in').click();

		await expect(page.getByTestId('remote-outcome')).toContainText('Signed in to GitHub');
		await closeRemoteSettings(page);
		await expectCredential(page, 'Signed in to GitHub');
	});
});

// SPEC story 38. A local-first tool stays local-first: a scholar who never publishes must never meet
// a sign-in prompt, and is never asked for a credential they have no reason to hold.
//
// **Story 38 is read as a sign-in prompt specifically, not as the word "GitHub" being absent** —
// decided 2026-08-14, closing the question `publish-to-a-remote`'s TRACKER left open. Story 50's
// "Review from GitHub…" button sits on the hub of a Workspace that has never published, so
// the two stories only conflict under the broader reading. They are different things: a button a
// scholar chooses is not a credential asked of one. What 38 protects is that nothing *demands*
// identity before there is anything to publish, and the sibling test below fences the other half by
// proving GitHub is not so much as spoken to.
test.describe('a first visit', () => {
	test('shows no sign-in affordance anywhere', async ({ page }) => {
		await start(page);

		await expectNoRemote(page);
		// ⚠ **Visible, not merely present.** The Remote dialog is mounted unconditionally so that its
		// `<dialog>` element exists before `showModal()` is asked for, and a closed `<dialog>` still
		// holds its markup — so a bare `toHaveCount(0)` here would be asserting that a component this
		// spec drives elsewhere does not exist, and would fail for the wrong reason. What story 38 is
		// about is what a scholar *sees*, which is nothing.
		await expect(page.getByText(/sign in/i).filter({ visible: true })).toHaveCount(0);
		// The prompt itself and the field it asks into, by test id rather than by prose: these are the
		// two elements that make a scholar produce a credential, and `RemoteSettings` is the only place
		// in the app that mounts either.
		await expect(page.getByTestId('remote-sign-in').filter({ visible: true })).toHaveCount(0);
		await expect(page.getByTestId('remote-sign-in-field').filter({ visible: true })).toHaveCount(0);
	});

	test('asks GitHub nothing at all', async ({ page }) => {
		const github = await start(page);

		await page.getByTestId('navigation-bar').waitFor();

		expect(github.requests).toEqual([]);
	});
});

// ADR-0032: the binding is orthogonal to the backing. `WorkspaceBacking` stays a two-member union,
// and nothing on the binding path asks which member it is — asserted here by driving both.
test.describe('a folder Workspace', () => {
	/**
	 * A picker that hands back a real `FileSystemDirectoryHandle`, taken from OPFS.
	 *
	 * `showDirectoryPicker()` opens an operating-system dialog and waits for a person, and no browser
	 * automation can supply one. What is simulated is the dialog; every file operation the app then
	 * performs on the handle is the real API. The fuller model — declined and lapsed permissions,
	 * activation assertions — is `editor-folder-workspace.e2e.ts`'s subject and stays there.
	 */
	const installDirectoryPicker = (page: Page) =>
		page.addInitScript((folder: string) => {
			Object.defineProperty(window, 'showDirectoryPicker', {
				configurable: true,
				value: async () =>
					(await navigator.storage.getDirectory()).getDirectoryHandle(folder, { create: true })
			});
		}, 'e2e-remote-folder');

	test('binds exactly as a browser Workspace does', async ({ page }) => {
		await installDirectoryPicker(page);
		await start(page);
		await openWorkspaceSettings(page);
		await page.getByTestId('settings-choose-folder').click();
		await closeWorkspaceSettings(page);
		await expectWorkspaceNamed(page, 'e2e-remote-folder');

		await bind(page);

		await expect(page.getByTestId('remote-outcome')).toContainText(
			`This Workspace is bound to ${REMOTE}`
		);
		await closeRemoteSettings(page);
		await expectRemoteNamed(page, REMOTE);
		// In the folder, which is where the binding has to be for a Clone to learn its own Remote.
		expect(JSON.parse((await bindingFile(page, 'e2e-remote-folder')) ?? 'null')).toHaveProperty(
			'repository',
			REPOSITORY
		);
	});
});

// SPEC story 41, ADR-0032. `remote.json` is inside the published tree deliberately, so a Backup
// carries it — and a scholar restoring one is somebody recovering from something having gone wrong.
// Handing them a Publish button aimed at their live, cited address at that moment is the failure.
test.describe('a restored Backup', () => {
	test('arrives unbound', async ({ page }) => {
		await start(page);
		await bind(page);
		await closeRemoteSettings(page);
		await expectRemoteNamed(page, REMOTE);

		const settings = page.getByRole('dialog', { name: 'Workspace settings' });
		await openWorkspaceSettings(page);
		const downloading = page.waitForEvent('download');
		await settings.getByTestId('back-up-workspace').click();
		const backup = await readFile(await (await downloading).path());

		await settings.getByTestId('restore-file').setInputFiles({
			name: `${DEFAULT_WORKSPACE}.tar`,
			mimeType: 'application/x-tar',
			buffer: backup
		});
		await expect(settings.getByTestId('transfer-outcome')).toContainText('publish', {
			timeout: 30_000
		});
		await closeWorkspaceSettings(page);

		await expectWorkspaceNamed(page, `${DEFAULT_WORKSPACE} (2)`);
		await expectNoRemote(page);
		expect(await bindingFile(page, `${DEFAULT_WORKSPACE} (2)`)).toBeNull();
	});
});

// ADR-0024, SPEC stories 39 and 40. Somebody else's work is never published to your own address, and
// opening a submission must not reach the teacher's own credential. The refusals themselves live in
// `packages/core`; what is asserted here is that the screens say so.
test.describe('a Review Workspace', () => {
	test('arrives unbound, and reads no credential while it is open (stories 40, 42)', async ({
		page
	}) => {
		await start(page);
		await bind(page);
		await closeRemoteSettings(page);
		await expectCredential(page, 'Signed in to GitHub');

		await page.getByTestId('open-bundle').click();
		await page
			.getByRole('dialog', { name: 'Review a Project' })
			.getByLabel('Project bundle')
			.setInputFiles(await oneProjectBundle());
		await page.getByTestId('confirm-open-bundle').click();
		await expect(page.getByTestId('review-banner')).toBeVisible({ timeout: 30_000 });

		// Unbound, so nothing on the bar names a Remote at all.
		await expectNoRemote(page);
		await openRemoteSettings(page);
		await expect(page.getByTestId('no-remote-in-review')).toContainText(
			'cannot be bound to a repository'
		);
		await expect(page.getByTestId('bind-remote')).toHaveCount(0);
		// ⚠ **This is the assertion that reads the seal, and it is chosen because it would read
		// differently if the seal broke.** The teacher signed in moments ago and the credential is
		// still in `sessionStorage` — sealed, not deleted — and the sign-in section is on screen
		// whenever `signedIn` or a binding says it should be. So a credential store that answered a
		// review copy would put this button right here, on the screen a submission is open on.
		await expect(page.getByTestId('remote-sign-out')).toHaveCount(0);
		await expect(page.getByTestId('remote-signed-in')).toHaveCount(0);
		await closeRemoteSettings(page);

		// And the teacher's own credential is **sealed rather than deleted**, which is what makes
		// putting a submission down and going back to one's own work cost nothing — the same two
		// locators, the opposite answers, one gesture apart.
		await page.getByTestId('leave-review').click();
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
		await expectCredential(page, 'Signed in to GitHub');
		await openRemoteSettings(page);
		await expect(page.getByTestId('remote-signed-in')).toBeVisible();
		await expect(page.getByTestId('remote-sign-out')).toBeVisible();
	});
});

/**
 * A v1 Workspace's Remote, lifted out of the Workspace and into this installation (ADR-0038).
 *
 * SPEC stories 155–157. What only a browser can show is the *decision*: a binding this installation
 * can corroborate is lifted with its evidence and says so; one it cannot is named and asked about,
 * and declining leaves the Workspace unbound; and once the relationship is installation-local, a
 * `remote.json` arriving inside copied or forked repository content cannot redirect it.
 *
 * The storage rules themselves — a Baseline for another repository, a corrupt record, a refused write
 * — are `synchronization-metadata.test.ts`'s, where the assertion is the record rather than a screen.
 */
test.describe('a Workspace bound by an older build', () => {
	/** The v1 publish manifest, exactly as `PublishManifests.write` left one. */
	async function seedPublishManifest(page: Page, commit: string): Promise<void> {
		await page.evaluate(
			([key, value]) => localStorage.setItem(key!, value!),
			[
				`ballastella.publish-manifest.${encodeURIComponent(`opfs:${DEFAULT_WORKSPACE}`)}`,
				JSON.stringify({
					formatVersion: 1,
					at: '2026-08-01T09:00:00.000Z',
					owner: OWNER,
					repository: REPOSITORY,
					branch: 'main',
					commit,
					files: { 'amsterdam-1625/project.json': 'aaaa' }
				})
			]
		);
	}

	// SPEC story 155: prior successful Publish evidence is not discarded. The manifest is
	// installation-local, so it is proof *this browser* published there — and that is enough.
	test('is lifted with its Baseline when this browser’s own publish evidence agrees', async ({
		page
	}) => {
		await start(page);
		await seedBindingFile(page, OWNER, REPOSITORY);
		await seedPublishManifest(page, 'c0ffeec0ffee');
		await page.reload();

		// Bound with no question asked, and with real evidence behind it.
		await expectRemoteNamed(page, REMOTE);
		await openRemoteSettings(page);
		await expect(page.getByTestId('legacy-remote-offer')).toHaveCount(0);
		await expect(page.getByTestId('remote-baseline')).toContainText('at commit');
		await expect(page.getByTestId('remote-baseline')).toContainText('c0ffeec0ffee');
		await closeRemoteSettings(page);
		// Which is the visible difference from the confirmed case below.
		await expectRemoteStatus(page, '');
	});

	// SPEC stories 156 and 157: a binding with nothing corroborating it is asked about, and confirming
	// it binds without fabricating a Baseline — so the status is `Cannot tell` rather than "up to date".
	test('is asked about when nothing corroborates it, and copied content cannot redirect it', async ({
		page
	}) => {
		await start(page);
		await seedBindingFile(page, OWNER, REPOSITORY);
		await page.reload();

		// Unbound until it is answered. A file inside the published tree is not evidence about this
		// browser, so nothing offers to publish anywhere yet.
		await expectNoRemote(page);
		await openRemoteSettings(page);
		await expect(page.getByTestId('legacy-remote-offer')).toContainText(REMOTE);
		await expect(page.getByTestId('bind-remote')).toHaveCount(0);

		// Declining writes nothing at all.
		await page.getByTestId('decline-legacy-remote').click();
		await expect(page.getByTestId('remote-outcome')).toContainText('Left unbound');
		await closeRemoteSettings(page);
		await expectNoRemote(page);

		// The question is asked again on the next visit, and confirming it names the repository.
		await page.reload();
		await openRemoteSettings(page);
		await expect(page.getByTestId('legacy-remote')).toHaveText(REMOTE);
		await page.getByTestId('accept-legacy-remote').click();
		await expect(page.getByTestId('bound-remote')).toHaveText(REMOTE);
		// ⚠ **Bound, and `Cannot tell`.** Confirmation lifts the relationship and nothing else: an
		// invented empty Baseline would claim the Remote holds nothing, which is the reading that
		// licenses overwriting all of it.
		await expect(page.getByTestId('remote-baseline')).toContainText('Cannot tell');
		await closeRemoteSettings(page);
		await expectRemoteNamed(page, REMOTE);
		await expectRemoteStatus(page, 'Cannot tell what has changed');

		// ⚠ **Copied or forked repository content cannot redirect the selected repository** (story 109).
		// A fork carries a `remote.json` naming the repository it was forked *from*; the relationship is
		// installation-local now, so it is never consulted again.
		await seedBindingFile(page, 'someone-else', 'fork');
		await page.reload();
		await expectRemoteNamed(page, REMOTE);
		await openRemoteSettings(page);
		await expect(page.getByTestId('legacy-remote-offer')).toHaveCount(0);
		await expect(page.getByTestId('bound-remote')).toHaveText(REMOTE);
	});
});
