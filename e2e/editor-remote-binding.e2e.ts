import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { readFile } from 'node:fs/promises';

import { whereverTheTokenIs } from './support/credential-scan.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { routeGitHubHosts } from './support/github-hosts.js';
import {
	closeTheDoor,
	backUpWorkspace,
	closeWorkspaceDialog,
	createFolderWorkspace,
	expectCredential,
	expectNoRemote,
	expectRemoteNamed,
	expectWorkspaceNamed,
	openRepositorySettings,
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
 * Choose the granted repository from the door, and wait for the Sync modal it hands off to.
 *
 * ⚠ **The sequence ends at the connection** (ADR-0044). There is no step saying it worked: what
 * opens is the Sync modal, on both sides compared, with nothing moved — so that is what waiting for
 * the connection means here. The modal is left on screen; each test dismisses it when it is done.
 */
async function bind(page: Page): Promise<void> {
	await openTheDoor(page);
	await page.getByTestId('choose-repository').first().click();
	await expect(page.getByTestId('sync-modal')).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId('connect-sequence')).toBeHidden();
}

/** Dismiss the Sync modal a connection hands off to, so the bar behind it can be reached. */
async function leaveSync(page: Page): Promise<void> {
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('sync-modal')).toBeHidden();
}

/**
 * Every top-level *file* the Workspace holds, sorted.
 *
 * ⚠ **The claim it carries is that none of them names a repository** (ADR-0044). The relationship is
 * installation-local and has exactly one home; a document in the Workspace would be a second copy,
 * travelling into a Backup, a folder and a fork, where a repository nobody chose could claim the
 * Workspace it landed in.
 */
async function topLevelFiles(page: Page, workspace = DEFAULT_WORKSPACE): Promise<string[]> {
	return page.evaluate(async (name) => {
		const found: string[] = [];
		try {
			const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
			for await (const [entry, handle] of directory) {
				if (handle.kind === 'file') found.push(entry);
			}
		} catch {
			return found;
		}
		return found.sort();
	}, workspace);
}

test.describe('binding a Workspace to a repository', () => {
	// ⚠ **Driven against a *private* repository, because that is the row that used to be a dead end**
	// (ADR-0044). A private repository was present-and-unselectable until this Epic, which left a
	// scholar under embargo with one honest option: keep the work on the laptop. It is chosen exactly
	// as a public one is now, and what being private costs is a sentence beside the row rather than a
	// fence in front of it. The note's wording and the press being reported are
	// `repository-choice.dom.test.ts`'s at Seam 1c, and the sync itself `private-remote.test.ts`'s at
	// Seam 1; what only a browser shows is that the row a scholar actually meets is pressable.
	test('is done from the one door, and survives a reload', async ({ page }) => {
		await start(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY, private: true }],
			grants: {
				installationId: 1,
				account: OWNER,
				repositories: [{ owner: OWNER, repository: REPOSITORY, push: true, private: true }]
			}
		});

		await openTheDoor(page);
		const row = page.getByTestId('granted-repository').first();
		await expect(row.getByTestId('repository-note')).toContainText('paid GitHub plan', {
			timeout: 30_000
		});
		await expect(row.getByTestId('choose-repository')).not.toHaveAttribute('aria-disabled', 'true');
		await row.getByTestId('choose-repository').click();
		await expect(page.getByTestId('sync-modal')).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId('connect-sequence')).toBeHidden();
		await leaveSync(page);

		// ⚠ **The relationship is installation-local and is written nowhere in the Workspace**
		// (ADR-0044). It survives the reload below because this installation kept it, not because a
		// file in the folder says so — which is what makes a copied Workspace arrive connected to
		// nothing.
		expect(await topLevelFiles(page)).toEqual([]);

		await page.reload();
		await expectRemoteNamed(page, REMOTE);
	});

	test('states the Remote and the sign-in on the door', async ({ page }) => {
		await start(page);

		await bind(page);
		await leaveSync(page);

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
		expect(await topLevelFiles(page)).toEqual([]);
	});
});

// A repository full of correct files that serves nothing is the failure; an error dialog over a
// connection that otherwise worked is a worse one.
// ⚠ **A Remote is a place the work lives before it is a site anybody reads** (ADR-0045). Share Links
// are a separate, later, optional act with a press of their own, on the door's connected step — so
// connecting must leave the repository exactly as it found it and say nothing about Pages at all.
// What each of the four outcomes says is `bind-remote.test.ts`'s at Seam 1, and that the presses
// exist and render their answers is the door's at Seam 1c.
test.describe('connecting does not turn Pages on', () => {
	test('leaves the site off, with nothing to say about it', async ({ page }) => {
		const github = await start(page);

		await bind(page);

		expect(github.pagesOn(OWNER, REPOSITORY)).toBe(false);
		await expect(page.getByTestId('pages-notice')).toHaveCount(0);
		await leaveSync(page);
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
		await leaveSync(page);

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
		await leaveSync(page);

		// Giving the repository up is on the Workspace's own row, beside the standing fact it undoes
		// (ADR-0042); signing out is on the door, which is where every gesture about a sign-in is.
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
		await leaveSync(page);

		await expectRemoteNamed(page, REMOTE);
		// And nothing about it is in the folder, exactly as nothing about it is in browser storage's
		// copy: a folder handed to a colleague carries the work and no claim on a repository.
		expect(await topLevelFiles(page, 'e2e-remote-folder')).toEqual([]);
	});
});

// ADR-0044: the relationship is installation-local, so a restored Backup arrives connected to
// nothing by construction rather than by a document being dropped on the way in. A scholar restoring
// one is somebody recovering from something having gone wrong, and handing them a Sync aimed at their
// live, cited address at that moment is the failure this makes unreachable.
test.describe('a restored Backup', () => {
	test('arrives unbound', async ({ page }) => {
		await start(page);
		await bind(page);
		await leaveSync(page);
		await expectRemoteNamed(page, REMOTE);

		// Backup and Restore are in the Workspace's own dialog, beside its name (ADR-0042), and the
		// Restore below is in there with it.
		const backup = await readFile(await (await backUpWorkspace(page)).path());

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
		expect(await topLevelFiles(page, `${DEFAULT_WORKSPACE} (2)`)).toEqual([]);
	});
});
