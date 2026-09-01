import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { readFile } from 'node:fs/promises';

import { whereverTheTokenIs } from './support/credential-scan.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { routeGitHubHosts } from './support/github-hosts.js';
import {
	closeTheDoor,
	createFolderWorkspace,
	expectCredential,
	expectNoRemote,
	expectRemoteNamed,
	expectRemoteStatus,
	expectWorkspaceNamed,
	openTheDoor,
	seedGitHubCredential
} from './support/workspace';

/**
 * A Workspace bound to a Remote (ADR-0032, ADR-0033).
 *
 * Seam 2. The binding document, its tolerant reader, the rights check, the Pages outcomes and
 * the two hard refusals are all asserted at Seam 1 — `remote-binding.test.ts`, `bind-remote.test.ts`
 * and `credential-store.test.ts` in `@ballastella/core`, where the assertion is the bytes and the
 * answer rather than a screen. What only a browser can show is here:
 *
 *   - the binding is made from the one door, by choosing a repository out of GitHub's own answer, and
 *     is still there after a reload, because it is a relationship this installation holds rather than
 *     a fact about this tab;
 *   - the door states where the work will go and whether a sign-in is held, and signing out is beside
 *     giving the repository up, so the two gestures a person handing a machine over makes are together;
 *   - a credential is held in `sessionStorage` and nowhere else — not in the Workspace, which is where
 *     a Backup and a Publish would carry it from;
 *   - a folder Workspace binds exactly as a browser one does, because the binding code branches on
 *     neither backing;
 *   - a first visit is never asked to sign in, and asks GitHub nothing.
 *
 * Nothing here publishes; `editor-publish.e2e.ts` is where that is driven.
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
		// ⚠ **Granted, and a credential held, because binding is a press on GitHub's own answer now.**
		// There is no address field and no token field anywhere on a deployment with an App
		// (ADR-0042): the door lists what `GET /user/installations` reports, marks each row with
		// whether it can be published to, and choosing one is the whole of binding. The sign-in round
		// trip that would otherwise get the credential is `editor-github-signin.e2e.ts`'s subject.
		signIn: true,
		login: OWNER,
		grants: {
			installationId: 1,
			account: OWNER,
			repositories: [{ owner: OWNER, repository: REPOSITORY, push: true }]
		},
		...options
	});
	await page.goto(HUB);
	await emptyBrowserStorage(page);
	await seedGitHubCredential(page, TOKEN);
	await page.reload();
	return github;
}

/**
 * Choose the granted repository from the door, and wait for the connection to be stated.
 *
 * Leaves the door open, because what a bind said is said inside it — each test closes when it is
 * done reading.
 */
async function bind(page: Page): Promise<void> {
	await openTheDoor(page);
	await page.getByTestId('choose-repository').first().click();
	await expect(page.getByTestId('connect-outcome')).toContainText(REMOTE, { timeout: 30_000 });
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
	test('is done from the one door, and survives a reload', async ({ page }) => {
		await start(page);

		await bind(page);
		await closeTheDoor(page);

		// The binding is a **file in the Workspace** as well as a relationship this installation holds
		// — which is what lets a Published Site say what it was built from, and a Clone learn its own
		// Remote (ADR-0032, ADR-0038).
		expect(JSON.parse((await bindingFile(page)) ?? 'null')).toEqual({
			formatVersion: 1,
			owner: OWNER,
			repository: REPOSITORY,
			branch: 'main'
		});

		await page.reload();
		await expectRemoteNamed(page, REMOTE);
	});

	test('states the Remote and the sign-in on the door', async ({ page }) => {
		await start(page);

		await bind(page);
		await closeTheDoor(page);

		await expectRemoteNamed(page, REMOTE);
		await expectCredential(page, 'Signed in to GitHub');
	});
});

// ADR-0033: *"Push rights are checked when a Remote is bound, not when 4,000 tiles have finished
// uploading."* That check sits *in front of* the choice: a repository the author cannot
// publish to is marked as such in the door's list and cannot be chosen at all, so there is no
// binding-with-a-notice state left to drive from a browser. Which mark each row carries and why is
// asserted at Seam 1c against a reactive fake (`repository-choice.dom.test.ts`), and what the rights
// read answers at Seam 1 (`bind-remote.test.ts`).
test.describe('a repository this credential cannot publish to', () => {
	test('is marked in the list and cannot be chosen', async ({ page }) => {
		await start(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY, push: false }],
			grants: {
				installationId: 1,
				account: OWNER,
				repositories: [{ owner: OWNER, repository: REPOSITORY, push: false }]
			}
		});

		await openTheDoor(page);

		const row = page.getByTestId('granted-repository').first();
		await expect(row.getByTestId('publish-mark')).toContainText('Cannot be published to', {
			timeout: 30_000
		});
		await expect(row.getByTestId('choose-repository')).toHaveAttribute('aria-disabled', 'true');
		await closeTheDoor(page);
		// Nothing was bound by looking at it.
		await expectNoRemote(page);
		expect(await bindingFile(page)).toBeNull();
	});
});

// A repository full of correct files that serves nothing is the failure; an error dialog over a
// binding that otherwise worked is a worse one.
// ⚠ **A Remote is a place the work lives before it is a site anybody reads.** Turning a Published
// Site on is a separate, later, optional act with a press of its own, on the door's connected step —
// so connecting must leave the repository exactly as it found it and say nothing about Pages at all.
// What the later act says when GitHub refuses it is `bind-remote.test.ts`'s at Seam 1, and that the
// press exists and renders the answer is the door's at Seam 1c.
test.describe('binding does not turn Pages on', () => {
	test('leaves the site off, with nothing to say about it', async ({ page }) => {
		const github = await start(page);

		await bind(page);

		expect(github.pagesOn(OWNER, REPOSITORY)).toBe(false);
		await expect(page.getByTestId('pages-notice')).toHaveCount(0);
		await closeTheDoor(page);
	});
});

// ADR-0033. The credential is this tab's and nothing else's: `localStorage` holds the write-ahead
// journal, and the Workspace is what a Backup packs and a Publish uploads.
//
// ⚠ **Three tests came out of this describe with the Remote dialog** (ADR-0042), and all three were
// about a *pasted* token: that a paste of the wrong shape is refused with no request, that a paste
// GitHub refuses is not kept, and that a paste can be supplied again for a Workspace that is already
// bound. There is no token field anywhere on a deployment with an App: the fork's own paste is the
// door's `no-app` step, and the only other way to one is the escape hatch an instructor whose
// Installation has broken opens. `describeTokenProblem` and the rights read are exhausted at Seam 1
// (`credential-store.test.ts`, `bind-remote.test.ts`).
test.describe('the credential this tab holds', () => {
	test('survives a reload and is forgotten on signing out', async ({ page }) => {
		await start(page);
		await bind(page);
		await closeTheDoor(page);

		await page.reload();
		await expectCredential(page, 'Signed in to GitHub');

		await openTheDoor(page);
		await page.getByTestId('connect-sign-out').click();
		await expect(page.getByTestId('connect-signed-out')).toBeVisible();
		await closeTheDoor(page);

		await expectCredential(page, 'Not signed in');
		expect(await whereverTheTokenIs(page, TOKEN)).toEqual([]);

		// And a reload after signing out has none, which is the half `sessionStorage` could have got
		// wrong quietly: the binding is still there, and the credential is not.
		await page.reload();
		await expectRemoteNamed(page, REMOTE);
		await expectCredential(page, 'Not signed in');
	});

	// There is always a way to sign out, so that a machine can be handed to somebody else. Unbinding
	// deliberately leaves the credential alive — it belongs to a GitHub account rather than to this
	// Workspace — so the two gestures a person handing a machine over makes are on one surface.
	test('can still be signed out of after unbinding', async ({ page }) => {
		await start(page);
		await bind(page);

		// Giving the repository up is the door's, beside the standing fact it undoes (ADR-0041), and
		// signing out is beside it on the same surface.
		await page.getByTestId('unbind-remote').click();
		await expect(page.getByTestId('connect-notice')).toContainText('no longer publishes');

		await page.getByTestId('connect-sign-out').click();

		expect(await whereverTheTokenIs(page, TOKEN)).toEqual([]);
		await closeTheDoor(page);
		await expectNoRemote(page);
	});
});

// A local-first tool stays local-first: a scholar who never publishes must never meet a sign-in
// prompt, and is never asked for a credential they have no reason to hold.
//
// That is read as **a sign-in prompt specifically, not as the word "GitHub" being absent** —
// decided 2026-08-14. The "Review from GitHub…" button sits on the hub of a Workspace that has
// never published, and the two requirements conflict only under the broader reading. They are
// different things: a button a scholar chooses is not a credential asked of one. What this protects
// is that nothing *demands* identity before there is anything to publish, and the sibling test
// below fences the other half by proving GitHub is not so much as spoken to.
test.describe('a first visit', () => {
	test('shows no sign-in affordance anywhere', async ({ page }) => {
		// ⚠ **No credential seeded, because the subject is a scholar who has never been to GitHub.**
		await routeGitHubHosts(page, { repositories: [{ owner: OWNER, name: REPOSITORY }] });
		await page.goto(HUB);
		await emptyBrowserStorage(page);
		await page.reload();

		await expectNoRemote(page);
		// ⚠ **Visible, not merely present.** The door's `<dialog>` is mounted unconditionally so that
		// it exists before `showModal()` is asked for, and a closed `<dialog>` still holds its markup —
		// so a bare `toHaveCount(0)` would be asserting that a component this spec drives elsewhere
		// does not exist, and would fail for the wrong reason. What this is about is what a scholar
		// *sees*, which is nothing.
		await expect(page.getByText(/sign in/i).filter({ visible: true })).toHaveCount(0);
		// The two elements that make a scholar produce a credential: the button that leaves for GitHub
		// and the fork's own paste field. Both are inside the door, which nothing has opened.
		await expect(
			page.getByTestId('connect-sign-in-with-github').filter({ visible: true })
		).toHaveCount(0);
		await expect(page.getByTestId('connect-token-field').filter({ visible: true })).toHaveCount(0);
	});

	test('asks GitHub nothing at all', async ({ page }) => {
		// The same arrival, with no credential of any kind: a first visit spends nobody's rate limit.
		const github = await routeGitHubHosts(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY }]
		});
		await page.goto(HUB);
		await emptyBrowserStorage(page);
		await page.reload();

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
		// A folder Workspace is created from the roster, which is where a Workspace of either kind now
		// comes from (ADR-0042). Named after the folder so every assertion below reads the same.
		await createFolderWorkspace(page, 'e2e-remote-folder');

		await bind(page);
		await closeTheDoor(page);

		await expectRemoteNamed(page, REMOTE);
		// In the folder, which is where the binding has to be for a Clone to learn its own Remote.
		expect(JSON.parse((await bindingFile(page, 'e2e-remote-folder')) ?? 'null')).toHaveProperty(
			'repository',
			REPOSITORY
		);
	});
});

// ADR-0032: `remote.json` is inside the published tree deliberately, so a Backup carries it — and a
// scholar restoring one is somebody recovering from something having gone wrong. Handing them a
// Publish button aimed at their live, cited address at that moment is the failure.
test.describe('a restored Backup', () => {
	test('arrives unbound', async ({ page }) => {
		await start(page);
		await bind(page);
		await closeTheDoor(page);
		await expectRemoteNamed(page, REMOTE);

		// Backup and Restore are on Workspace Home, which is the screen this test is standing on
		// (ADR-0042).
		const downloading = page.waitForEvent('download');
		await page.getByTestId('back-up-workspace').click();
		const backup = await readFile(await (await downloading).path());

		await page.getByTestId('restore-file').setInputFiles({
			name: `${DEFAULT_WORKSPACE}.tar`,
			mimeType: 'application/x-tar',
			buffer: backup
		});
		await expect(page.getByTestId('transfer-outcome')).toContainText('publish', {
			timeout: 30_000
		});

		await expectWorkspaceNamed(page, `${DEFAULT_WORKSPACE} (2)`);
		await expectNoRemote(page);
		expect(await bindingFile(page, `${DEFAULT_WORKSPACE} (2)`)).toBeNull();
	});
});

/**
 * A v1 Workspace's Remote, lifted out of the Workspace and into this installation (ADR-0038).
 *
 * What only a browser can show is the *decision*: a binding this installation
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

	// Prior successful Publish evidence is not discarded. The manifest is installation-local, so it is
	// proof *this browser* published there — and that is enough.
	test('is lifted with its Baseline when this browser’s own publish evidence agrees', async ({
		page
	}) => {
		await start(page);
		await seedBindingFile(page, OWNER, REPOSITORY);
		await seedPublishManifest(page, 'c0ffeec0ffee');
		await page.reload();

		// Bound with no question asked, and with real evidence behind it.
		await expectRemoteNamed(page, REMOTE);
		await openTheDoor(page);
		await expect(page.getByTestId('legacy-remote-offer')).toHaveCount(0);
		await expect(page.getByTestId('remote-baseline')).toContainText('at commit');
		await expect(page.getByTestId('remote-baseline')).toContainText('c0ffeec0ffee');
		await closeTheDoor(page);
		// Which is the visible difference from the confirmed case below.
		await expectRemoteStatus(page, '');
	});

	// A binding with nothing corroborating it is asked about, and confirming it binds without
	// fabricating a Baseline — so the status is `Cannot tell` rather than "up to date".
	test('is asked about when nothing corroborates it, and copied content cannot redirect it', async ({
		page
	}) => {
		await start(page);
		await seedBindingFile(page, OWNER, REPOSITORY);
		await page.reload();

		// Unbound until it is answered. A file inside the published tree is not evidence about this
		// browser, so nothing offers to publish anywhere yet.
		await expectNoRemote(page);
		// ⚠ **The question is the door's landing, asked once because it is true** (ADR-0041), and it
		// stands in front of every step of the path to a repository: there is nothing to connect and
		// nothing to sign in for until somebody says whether that repository is theirs.
		await openTheDoor(page);
		await expect(page.getByTestId('legacy-remote-offer')).toContainText(REMOTE);
		await expect(page.getByTestId('connect-sign-in')).toHaveCount(0);
		// And there is no second surface it could be answered on by accident: the question is the door's
		// landing, and the dialogs that used to describe a Remote are gone (ADR-0042).
		await expect(page.getByTestId('repository-choice')).toHaveCount(0);
		await closeTheDoor(page);

		// Declining writes nothing at all.
		await openTheDoor(page);
		await page.getByTestId('decline-legacy-remote').click();
		await expect(page.getByTestId('connect-notice')).toContainText('Left unbound');
		await closeTheDoor(page);
		await expectNoRemote(page);

		// The question is asked again on the next visit, and confirming it names the repository.
		await page.reload();
		await openTheDoor(page);
		await expect(page.getByTestId('legacy-remote')).toHaveText(REMOTE);
		await page.getByTestId('accept-legacy-remote').click();
		// ⚠ **Bound, and `Cannot tell`.** Confirmation lifts the relationship and nothing else: an
		// invented empty Baseline would claim the Remote holds nothing, which is the reading that
		// licenses overwriting all of it.
		await expect(page.getByTestId('remote-baseline')).toContainText('Cannot tell');
		await closeTheDoor(page);
		await expectRemoteNamed(page, REMOTE);

		// ⚠ **Copied or forked repository content cannot redirect the selected repository**.
		// A fork carries a `remote.json` naming the repository it was forked *from*; the relationship is
		// installation-local now, so it is never consulted again.
		await seedBindingFile(page, 'someone-else', 'fork');
		await page.reload();
		await expectRemoteNamed(page, REMOTE);
		await openTheDoor(page);
		await expect(page.getByTestId('legacy-remote-offer')).toHaveCount(0);
		await expect(page.getByTestId('remote-baseline')).toContainText('Cannot tell');
		await closeTheDoor(page);
	});
});
