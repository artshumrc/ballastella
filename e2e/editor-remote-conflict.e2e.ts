import { DEFAULT_WORKSPACE, expect, test, type Page, type Route } from './support/test.js';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { GITHUB_RAW_ORIGIN, routeGitHubHosts, type GitHubHosts } from './support/github-hosts.js';
import {
	createWorkspace,
	doorButton,
	seedBaseline,
	seedGitHubCredential,
	seedRemoteRelationship,
	checkRemoteStatus,
	openRepositorySettings,
	openSyncModal,
	openTheDoor,
	showRemoteStatusDetail,
	getFromRemote,
	switchToWorkspace
} from './support/workspace.js';
import { gitBlobSha } from '../packages/core/src/remote/blob-sha.js';
import { UPDATE_DOWNLOAD_CONCURRENCY } from '../packages/core/src/remote/get-from-remote.js';

/**
 * What stops one machine deleting another's afternoon (ADR-0033, ADR-0044).
 *
 * Seam 2, driving Seam 1's fake through Playwright routes. The comparison itself — per file and
 * never by commit SHA, the Baseline read both ways round, and what an overwrite settles — is
 * asserted in `packages/core/src/remote/send-to-remote.test.ts`, where the assertion is the
 * resulting tree rather than a screen. What only a browser can settle is here: that the Sync modal
 * shows an author what it found before it moves a byte, that a completed send leaves work it has
 * never seen exactly where it is, and that the one gesture which does remove that work names it
 * first and cannot proceed without an answer.
 *
 * ⚠ **Assertions are on what arrived at the Remote**, never on which calls were made, because every
 * failure mode here is silent and plausible.
 */

test.beforeEach(async ({ page }) => routeBaseMapArchive(page));

const OWNER = 'ada';
const REPOSITORY = 'atlas';
const REMOTE = `${OWNER}/${REPOSITORY}`;
/** A token of the right shape. Its value never matters: the fake looks only for a credential. */
const TOKEN = 'github_pat_11ABCDE0000abcdefghijklmnop';

/** One Project, as small as a Project gets: the directory, its `project.json`, and one Layer. */
const projectFiles = (directory: string, name: string): Record<string, string> => ({
	[`${directory}/project.json`]: `${JSON.stringify(
		{
			formatVersion: 1,
			name,
			updatedAt: '2026-01-02T03:04:05.000Z',
			layers: [
				{
					id: 'l2',
					name: 'Warehouses',
					visible: true,
					order: 0,
					kind: 'annotation',
					geojsonRef: `${directory}/annotations/l2.geojson`,
					defaultStyle: {}
				}
			],
			baseMap: 'physical'
		},
		null,
		'\t'
	)}\n`,
	[`${directory}/annotations/l2.geojson`]: '{"type":"FeatureCollection","features":[]}'
});

/** A site record as a Remote with a site carries one, listing whichever Projects it was given. */
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

/** Empty the whole of browser storage, so no test sees another's Workspace or manifest. */
async function emptyBrowserStorage(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const open = await workspaceRoot();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(
			names
				.filter((name) => name !== open.name)
				.map((name) => root.removeEntry(name, { recursive: true }))
		);
		const inside: string[] = [];
		for await (const name of open.keys()) inside.push(name);
		await Promise.all(inside.map((name) => open.removeEntry(name, { recursive: true })));
		// ⚠ The Baseline lives in `localStorage`, so a test that emptied only OPFS would
		// inherit the previous one's evidence about this very repository.
		localStorage.clear();
		sessionStorage.clear();
	});
}

/** Write files straight into the open Workspace, bypassing the app. */
async function seed(page: Page, files: Record<string, string>): Promise<void> {
	await page.evaluate(async (files) => {
		const root = await workspaceRoot();
		for (const [full, text] of Object.entries(files)) {
			const segments = full.split('/');
			let handle = root;
			for (const segment of segments.slice(0, -1)) {
				handle = await handle.getDirectoryHandle(segment, { create: true });
			}
			const file = await handle.getFileHandle(segments[segments.length - 1]!, { create: true });
			const writable = await file.createWritable();
			await writable.write(text);
			await writable.close();
		}
	}, files);
}

/** Open the editor on an empty Workspace holding exactly `files`, with `remote` on GitHub. */
async function start(
	page: Page,
	options: {
		workspace?: Record<string, string>;
		onRemote?: Record<string, string>;
		/**
		 * Whether this installation records a relationship with the repository (ADR-0044).
		 *
		 * Defaults to *not*, which is what a test that connects through the door wants. The
		 * relationship has exactly one home and no fixture can put it in the Workspace's own files, so
		 * this flag is the whole of "start from a connected Workspace".
		 */
		connected?: boolean;
		/**
		 * Answer the door's listing, so the repository can be chosen from where the author asks.
		 *
		 * Left out, nothing routes GitHub's sign-in surface and the door has no list — which is what
		 * every test here that starts from a seeded binding rather than connecting wants.
		 */
		granted?: boolean;
		/**
		 * Whose the seeded credential is, as `GET /user` reports it.
		 *
		 * Left out it is the repository's own owner, which is the solo Remote every other test here
		 * means. Naming somebody else is what makes the Remote *shared* (ADR-0043) — the comparison is
		 * between the repository's owner and this, and it costs no request at all.
		 */
		login?: string;
	} = {}
): Promise<GitHubHosts> {
	const github = await routeGitHubHosts(page, {
		repositories: [
			{
				owner: OWNER,
				name: REPOSITORY,
				files: { 'README.md': '# Atlas\n', ...options.onRemote }
			}
		],
		...(options.granted === true
			? {
					signIn: true,
					login: OWNER,
					grants: {
						installationId: 1,
						account: OWNER,
						repositories: [{ owner: OWNER, repository: REPOSITORY, push: true }]
					}
				}
			: {}),
		// Last, so naming the account is what a test says when it means it — even where the sign-in
		// surface is served and would otherwise report the repository's owner.
		...(options.login === undefined ? {} : { login: options.login })
	});
	await page.goto('./');
	await emptyBrowserStorage(page);
	await seed(page, options.workspace ?? {});
	// ⚠ **The relationship is installation-local and is the only account of it there is** (ADR-0044),
	// so a spec that needs a connected Workspace records it the way an Open or a connect does.
	if (options.connected === true) {
		await seedRemoteRelationship(page, { owner: OWNER, repository: REPOSITORY });
	}
	await page.reload();
	await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
	return github;
}

// The bar's one GitHub control opens the Sync modal directly for a Workspace that has a repository
// (ADR-0044): pressing Sync reads both sides and shows what it found, and moves nothing.
const openSync = async (page: Page) => {
	await openSyncModal(page);
	// Named, because the guided sequence's own `<dialog>` may still be in the document behind this
	// one and a bare `getByRole('dialog')` is then two elements rather than one.
	const dialog = page.getByRole('dialog', { name: 'Sync with GitHub' });
	await expect(dialog.getByTestId('sync-budget')).toBeVisible({ timeout: 60_000 });
	return dialog;
};

/**
 * Reach the Sync modal of a connected Workspace that holds a credential.
 *
 * ⚠ **The credential is seeded rather than acquired.** On a deployment with a GitHub App the modal
 * offers no token field — the door there is a redirect off the page — and every test in this spec is
 * about which files a Sync touches, not about how the credential was got. See
 * {@link seedGitHubCredential}; the door itself is driven in `editor-github-signin.e2e.ts`.
 *
 * The reload is what makes the seeded credential held: it is read when the app starts.
 */
async function signedIn(page: Page) {
	await seedGitHubCredential(page, TOKEN);
	await page.reload();
	await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
	return openSync(page);
}

/** Send, and wait for the Remote to be named in the result. */
async function send(page: Page, dialog: ReturnType<Page['getByRole']>): Promise<void> {
	await dialog.getByTestId('sync-send').click();
	await expect(page.getByTestId('sync-status')).toContainText(`Sent to ${REMOTE}`, {
		timeout: 120_000
	});
}

// ⚠ **A repository already carrying Ballastella work is bound to, not refused** (ADR-0044).
// ADR-0033's subset refusal existed because a first send would have deleted every Project the
// Workspace had not got; it cannot, because a send removes only what the Synchronization Baseline
// recorded. What that repository holds reads as *To get* on the Sync modal instead, which is
// asserted in the describe below.
test.describe('connecting to a Remote that already carries Projects', () => {
	/**
	 * Connect from the door, choosing the repository GitHub says the author has granted.
	 *
	 * ⚠ **The sequence lists what GitHub answers and the row is the gesture** (ADR-0042), and it ends
	 * at the connection: what a press hands off to is the Sync modal, on both sides compared
	 * (ADR-0044).
	 */
	async function bind(page: Page): Promise<void> {
		await openTheDoor(page);
		await page.getByTestId('choose-repository').first().click();
		await expect(page.getByTestId('sync-modal')).toBeVisible({ timeout: 30_000 });
	}

	test('connects to one holding Projects this Workspace has not got', async ({ page }) => {
		await start(page, {
			granted: true,
			workspace: projectFiles('amsterdam-1625', 'Amsterdam 1625'),
			onRemote: {
				'ballastella-site.json': siteRecord([
					{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' },
					{ directory: 'florida-1657', name: 'Florida 1657' }
				]),
				'florida-1657/project.json': '{"formatVersion":1,"name":"Florida 1657"}'
			}
		});
		await seedGitHubCredential(page, TOKEN);
		await page.reload();

		await bind(page);

		// And what it holds is offered as work to get rather than as work about to be deleted, which
		// is the whole of why the refusal could go — on the modal the connection handed off to.
		const dialog = page.getByRole('dialog', { name: 'Sync with GitHub' });
		await expect(dialog.getByTestId('sync-budget')).toBeVisible({ timeout: 60_000 });
		await expect(dialog.getByTestId('to-get')).toContainText('florida-1657');
		await expect(dialog.getByTestId('to-send-removals')).toHaveCount(0);

		await page.keyboard.press('Escape');
		await expect(doorButton(page)).toHaveText('Sync');
	});

	test('goes ahead when the Remote’s Projects are all here', async ({ page }) => {
		await start(page, {
			granted: true,
			workspace: {
				...projectFiles('amsterdam-1625', 'Amsterdam 1625'),
				...projectFiles('florida-1657', 'Florida 1657')
			},
			onRemote: {
				'ballastella-site.json': siteRecord([
					{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }
				]),
				'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam 1625"}'
			}
		});
		await seedGitHubCredential(page, TOKEN);
		await page.reload();

		await bind(page);

		await page.keyboard.press('Escape');
		await expect(doorButton(page)).toHaveText('Sync');
	});
});

test.describe('a send against a Remote this browser has never seen', () => {
	// ⚠ **What used to be the `we cannot tell` refusal, and what makes a first Sync safe** (ADR-0044).
	// With no record of what the two sides last shared, a send removes nothing and overwrites nothing:
	// the Remote's own copy of a path is left exactly as it is and offered as work to get, and this
	// Workspace's work reaches the repository in the same commit.
	test('leaves what it cannot attribute alone, and sends this Workspace’s work anyway', async ({
		page
	}) => {
		const github = await start(page, {
			workspace: projectFiles('amsterdam-1625', 'Amsterdam 1625'),
			connected: true,
			// A Remote somebody has already sent to, and a browser that has never sent to it:
			// an Open from GitHub, a second machine, or storage cleared since. All three look the same
			// from here.
			onRemote: {
				'ballastella-site.json': siteRecord([
					{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }
				]),
				'florida-1657/project.json': '{"formatVersion":1,"name":"sent elsewhere"}',
				'index.html': '<!doctype html><title>Written earlier</title>'
			}
		});

		const dialog = await signedIn(page);

		// Their Project is in the other column, and nothing on this screen says anything would be
		// removed from either side.
		await expect(dialog.getByTestId('to-get')).toContainText('florida-1657');
		await expect(dialog.getByTestId('to-send-removals')).toHaveCount(0);
		await expect(dialog.getByTestId('to-get-removals')).toHaveCount(0);
		await expect(dialog.getByTestId('sync-conflicts')).toHaveCount(0);

		await send(page, dialog);

		// Their Project is still there, whole, after a completed send from a Workspace that has never
		// held it — and this Workspace's own work arrived beside it.
		expect(github.fileText(OWNER, REPOSITORY, 'florida-1657/project.json')).toBe(
			'{"formatVersion":1,"name":"sent elsewhere"}'
		);
		expect(github.files(OWNER, REPOSITORY)).toContain('amsterdam-1625/project.json');
	});

	test('says nothing needs changing when the Remote matches, even with no record of sending it', async ({
		page
	}) => {
		const github = await start(page, {
			workspace: projectFiles('amsterdam-1625', 'Amsterdam 1625'),
			connected: true
		});
		await send(page, await signedIn(page));
		const commit = github.head(OWNER, REPOSITORY);

		// The record of that send, and nothing else. The Workspace and the Remote still agree exactly;
		// only this browser's evidence about them has gone.
		await page.evaluate(() => localStorage.clear());
		await page.reload();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();

		const dialog = await openSync(page);

		await expect(dialog.getByTestId('sync-nothing-to-do')).toContainText(REMOTE);
		await expect(dialog.getByTestId('sync-conflicts')).toHaveCount(0);
		// Inert, and with the reason for it on screen beside it.
		await expect(dialog.getByTestId('sync-send')).toHaveAttribute('aria-disabled', 'true');
		expect(github.head(OWNER, REPOSITORY)).toBe(commit);
	});

	// ⚠ **The single most important behaviour in this Epic, in a browser.** Another machine's
	// afternoon arrives after this one last looked; a send neither overwrites it nor drops it out of
	// the tree it posts, and the Sync modal offers it as work to get instead.
	test('leaves the file another machine wrote alone, and offers it under To get', async ({
		page
	}) => {
		const github = await start(page, {
			workspace: projectFiles('amsterdam-1625', 'Amsterdam 1625'),
			connected: true
		});

		// A first send, which is what gives this browser its record of the Remote.
		await send(page, await signedIn(page));

		// The other machine's afternoon. The one thing no gesture in this app can produce.
		await github.commitFiles(OWNER, REPOSITORY, {
			'amsterdam-1625/annotations/l2.geojson':
				'{"type":"FeatureCollection","features":[{"id":"a-whole-afternoon"}]}'
		});
		// The author's own work at a different path, so this is a Sync with something in both columns.
		await page.getByRole('button', { name: 'New Project' }).click();
		await page
			.getByRole('dialog', { name: 'New Project' })
			.getByLabel('Project name')
			.fill('Delft');
		await page.getByRole('button', { name: 'Create Project' }).click();
		await expect(page.getByRole('link', { name: 'Delft' })).toBeVisible();

		const dialog = await openSync(page);
		await expect(dialog.getByTestId('to-get')).toContainText('Amsterdam 1625');
		await expect(dialog.getByTestId('to-send')).toContainText('Delft');
		await expect(dialog.getByTestId('to-send-removals')).toHaveCount(0);

		// ⚠ **Dismissal first, and from the keyboard.** ADR-0016's `<dialog>` + `showModal()`: Escape
		// closes it and focus comes back to the control that opened it rather than to the document
		// (WCAG 2.4.3).
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(page.getByTestId('connect-to-github')).toBeFocused();

		await send(page, await openSync(page));

		// Their afternoon, untouched by a completed send from a machine that has never seen it.
		expect(github.fileText(OWNER, REPOSITORY, 'amsterdam-1625/annotations/l2.geojson')).toBe(
			'{"type":"FeatureCollection","features":[{"id":"a-whole-afternoon"}]}'
		);
		// And this Workspace's own new Project reached it in the same commit.
		expect(github.files(OWNER, REPOSITORY)).toContain('delft/project.json');
		// ⚠ **And the status on the bar is recomputed by the Sync, not by the next window focus.** The
		// send recorded nothing about the path it left alone, so the two sides still differ and the
		// badge says which way.
		await expect(remoteStatus(page)).toContainText('changes to get');
	});

	// ⚠ **Overwrite is the one control whose blast radius is somebody else's afternoon** (ADR-0043).
	// On a repository that is the author's alone it can only ever discard their own work; on a shared
	// one it deletes a collaborator's, so what it would remove is named — the Projects and the Map
	// Images, never a file count — and it cannot proceed without that confirmation. Whose the
	// repository is, and the sentence the preview carries, are Seam 1's (`shared-remote.test.ts`);
	// what only a browser can settle is that the real modal asks the real GitHub, that the control
	// refuses until the question is answered, and that answering it sends to a repository the author
	// does not own.
	test('names what an overwrite would remove from a shared Remote, and will not proceed until told', async ({
		page
	}) => {
		const github = await start(page, {
			workspace: projectFiles('amsterdam-1625', 'Amsterdam 1625'),
			connected: true,
			// `ada/atlas` is not grace's, so the Remote is shared before anybody has contributed to it.
			login: 'grace'
		});

		// A first send, which is what gives this browser its record of the Remote — and a collaborator
		// sending to a repository they do not own, which is a shared Remote end to end.
		await send(page, await signedIn(page));

		// A whole Project arriving from somebody else's machine. It is inbound source this Workspace
		// has never taken in, so an ordinary send leaves it alone — and an overwrite would take it
		// down, which is precisely the afternoon the preview has to name.
		await github.commitFiles(OWNER, REPOSITORY, {
			'florida-1657/project.json': '{"formatVersion":1,"name":"Florida 1657"}',
			'florida-1657/annotations/l1.geojson': '{"type":"FeatureCollection","features":[]}'
		});

		const dialog = await openSync(page);
		// Named before it is carried out, on the screen the author is already reading (Story 15).
		await expect(dialog.getByTestId('sync-overwrite-removals')).toContainText('florida-1657');
		await dialog.getByTestId('sync-arm-overwrite').click();

		const preview = dialog.getByTestId('sync-shared-remote');
		// Whose it is, then what goes: named as a Project rather than as two files, because "2 files
		// will be removed" is not a question anybody can answer.
		await expect(preview).toContainText(`${REMOTE} belongs to ${OWNER}, not to you`);
		await expect(preview).toContainText('the Project florida-1657');
		// ⚠ **And it has not armed.** There is no control to carry it out while the question stands,
		// so the press that named the deletion is not also the press that does it.
		await expect(dialog.getByTestId('sync-overwrite')).toHaveCount(0);
		expect(github.files(OWNER, REPOSITORY)).toContain('florida-1657/project.json');

		await dialog.getByTestId('confirm-shared-overwrite').click();
		await dialog.getByTestId('sync-overwrite').click();
		await expect(page.getByTestId('sync-status')).toContainText(`Sent to ${REMOTE}`, {
			timeout: 120_000
		});

		expect(github.files(OWNER, REPOSITORY)).not.toContain('florida-1657/project.json');
		// The mirror is still ADR-0033's: the repository's own files are outside the owned namespace
		// and a confirmed overwrite does not reach them.
		expect(github.fileText(OWNER, REPOSITORY, 'README.md')).toBe('# Atlas\n');
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// REMOTE STATUS
//
// **One workflow rather than a second planner matrix.** The six determinations and the table behind
// them are exhausted at Seam 1 (`synchronization-planner.test.ts`, `local-change-index.test.ts`),
// and the bounded checking, the retained failure and the per-Workspace isolation at Seam 1 too
// (`remote-status.test.ts`) — all of it without a browser. What only a browser can settle is that
// the clause is *there*, on every screen, in words, beside a `Saved here` that is never allowed to
// stand for it; that an authenticated session checks by itself and a signed-out one does not; and
// that a failed check leaves the last answer on screen rather than reporting agreement.
//
// The Baseline is seeded rather than earned through a Sync: a spec that had to send to reach
// each state would be testing the send five times over to arrive at the thing it wanted to assert.
// That a send advances the Baseline is asserted where the send is.

/** `path → blob SHA` for bytes seeded on the Remote, which is what a Baseline records. */
async function sharedShas(files: Record<string, string>): Promise<Record<string, string>> {
	const encoder = new TextEncoder();
	const shas: Record<string, string> = {};
	for (const [path, text] of Object.entries(files)) {
		shas[path] = await gitBlobSha(encoder.encode(text));
	}
	return shas;
}

/**
 * The one badge, and its two clauses (ADR-0044).
 *
 * ⚠ **The GitHub clause is the outstanding direction, not the determination.** `Changes both ways`
 * and the other five are one press behind it, and the repository is named in the agreeing clause
 * alone. Which clause belongs to which determination is `remote-status.dom.test.ts`'s at Seam 1c;
 * what this file can say is that the determination the checker reached is the one the bar is
 * speaking for.
 */
const remoteStatus = (page: Page) => page.getByTestId('where-your-work-is');

/** Ask for a check the way an author does, and wait for it to finish. */
async function checkNow(page: Page): Promise<void> {
	await checkRemoteStatus(page);
	await expect(remoteStatus(page)).not.toContainText('Checking…');
}

/** Coming back to the tab, which is the moment an out-of-band commit is worth looking for. */
const refocus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

/** How many tree listings this session has asked GitHub for. */
const listings = (github: GitHubHosts) =>
	github.requests.filter((path) => path.includes('/git/trees/')).length;

/**
 * The same count, once it has stopped moving.
 *
 * ⚠ **The status control is not the only thing here that lists a tree**: the sync modal takes one
 * of its own for the breakdown, and closing the dialog does not cancel it. Sampled the moment the
 * dialog goes, the number can be one short of the truth — and the bound asserted against it then
 * fails on a request the spec itself caused rather than on a poll the product made.
 */
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

test.describe('Remote Status on the navigation bar', () => {
	const AMSTERDAM = projectFiles('amsterdam-1625', 'Amsterdam 1625');

	test('is checked explicitly and anonymously while signed out, and never polled', async ({
		page
	}) => {
		const github = await start(page, {
			workspace: AMSTERDAM,
			connected: true,
			onRemote: AMSTERDAM
		});

		// Bound, with no Baseline yet: `Cannot tell` is a determination and it needs no request, so its
		// lead is on screen without a credential and without GitHub having been asked anything.
		await expect(remoteStatus(page)).toContainText("can't tell what's on GitHub");
		expect(listings(github)).toBe(0);

		// ⚠ **One `status` region on this bar, carrying both clauses**, and strict mode is the
		// assertion: a second region would make the two facts a scholar most needs kept apart into two
		// announcements, of which a screen-reader user has to work out which is now true.
		await expect(page.getByRole('status')).toContainText('Saved here');
		await expect(page.getByRole('status')).toContainText('GitHub');
		expect(
			await remoteStatus(page).evaluate((element) => [
				element.getAttribute('role'),
				element.getAttribute('aria-atomic')
			])
		).toEqual(['status', 'true']);

		await seedBaseline(page, {
			owner: OWNER,
			repository: REPOSITORY,
			files: await sharedShas(AMSTERDAM)
		});
		await page.reload();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();

		// ⚠ **Signed out, nothing is polled**. GitHub allows an anonymous reader sixty
		// requests an hour *per IP address*, so a seminar room on one campus address checking on every
		// window focus would spend the room's whole budget on status.
		await expect(remoteStatus(page)).toContainText('not checked yet');
		await refocus(page);
		await refocus(page);
		expect(listings(github)).toBe(0);

		// The gesture, reached by the keyboard alone, is what makes status available with no account at
		// all — and the answer is dated, so a retained one can later be told from a current one. The
		// gesture is on the Workspace's own row (ADR-0042) and the date is behind the badge's
		// disclosure: what is *done* about GitHub is one place, and what is *true* of it is the other.
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
		const github = await start(page, {
			workspace: AMSTERDAM,
			connected: true,
			onRemote: { ...AMSTERDAM, 'index.html': '<!doctype html><title>Atlas</title>' }
		});
		await seedBaseline(page, {
			owner: OWNER,
			repository: REPOSITORY,
			// A Baseline a send wrote: the source paths *and* the generated output it sent, which is
			// what makes Published Site staleness answerable at all.
			files: await sharedShas({
				...AMSTERDAM,
				'index.html': '<!doctype html><title>Atlas</title>'
			})
		});
		await page.reload();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();

		// Signing in is the moment an automatic check becomes possible, and it takes one by itself.
		await signedIn(page);
		await page.keyboard.press('Escape');
		await expect(remoteStatus(page)).toContainText('in sync with ada/atlas');
		const afterSignIn = await settledListings(page, github);

		// ⚠ **Bounded.** Coming back to the tab three times inside the interval is three focus events
		// and no further listings — the whole reason a focus trigger is affordable.
		await refocus(page);
		await refocus(page);
		await refocus(page);
		await expect(remoteStatus(page)).toContainText('in sync with ada/atlas');
		expect(listings(github)).toBe(afterSignIn);

		// Another editor version rebuilt the site: different chunk names, identical scholarship. It is
		// said separately and the source status is untouched.
		await github.commitFiles(OWNER, REPOSITORY, {
			'index.html': '<!doctype html><title>Atlas, rebuilt</title>'
		});
		await checkNow(page);
		await expect(remoteStatus(page)).toContainText('in sync with ada/atlas');
		await expect(page.getByTestId('published-site-stale')).toContainText(
			'The next Sync rebuilds it'
		);

		// The author's own work, which GitHub has never seen.
		await page.getByRole('button', { name: 'New Project' }).click();
		await page
			.getByRole('dialog', { name: 'New Project' })
			.getByLabel('Project name')
			.fill('Delft');
		await page.getByRole('button', { name: 'Create Project' }).click();
		await expect(page.getByRole('link', { name: 'Delft' })).toBeVisible();
		await checkNow(page);
		await expect(remoteStatus(page)).toContainText('changes to send');

		// And somebody else's afternoon, arriving on a path this Workspace has not touched. Two safe
		// changes, and the whole point of the state is that it is not a Conflict.
		await github.commitFiles(OWNER, REPOSITORY, {
			'amsterdam-1625/annotations/l2.geojson':
				'{"type":"FeatureCollection","features":[{"id":"theirs"}]}'
		});
		await checkNow(page);
		await expect(remoteStatus(page)).toContainText('changes both ways');
		await expect(remoteStatus(page)).toHaveAttribute('data-remote-status', 'changes-both-ways');

		// Persistent, and it follows the author onto the Project screen — drift stays visible while
		// they work rather than only on the hub.
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		await expect(remoteStatus(page)).toContainText('changes both ways');
		await expect(page.getByRole('status')).toContainText('Saved here');

		// The same path on both sides, which is the one state the passive check may not read as
		// agreement: it knows `delft/project.json` changed here and cannot compare the bytes.
		await github.commitFiles(OWNER, REPOSITORY, {
			'delft/project.json': '{"formatVersion":1,"name":"Delft, theirs"}'
		});
		await checkNow(page);
		// ⚠ **The badge says which directions are outstanding and a Conflict has both** — and it is not
		// a determination of its own (ADR-0046): a Sync resolves it into a copy, so the state a scholar
		// is in is the same both-ways one they were already in.
		await expect(remoteStatus(page)).toContainText('changes both ways');
		await expect(remoteStatus(page)).toHaveAttribute('data-remote-status', 'changes-both-ways');

		// ⚠ **A failed check is not agreement**. The last determination stays, dated,
		// with an alert beside it saying it is no longer being confirmed — never relabelled `In sync`,
		// and never the successful determination `Cannot tell`.
		await showRemoteStatusDetail(page);
		const checkedBefore = await page.getByTestId('remote-status-checked').textContent();
		await page.route('https://api.github.com/**/git/trees/**', (route) =>
			route.abort('connectionfailed')
		);
		await checkRemoteStatus(page);
		const failure = page.getByTestId('remote-status-failure');
		await expect(failure).toBeVisible();
		await expect(failure).toContainText('the last one Ballastella was able to work out');
		await expect(remoteStatus(page)).toHaveAttribute('data-remote-status', 'changes-both-ways');
		await expect(remoteStatus(page)).toContainText('changes both ways');
		await expect(remoteStatus(page)).toContainText('Check failed');
		expect(await page.getByTestId('remote-status-checked').textContent()).toBe(checkedBefore);
		// The alert is announced rather than merely rendered: it is inserted at the moment its text
		// first exists, which a polite region does not reliably announce.
		expect(await failure.getAttribute('role')).toBe('alert');
		// And focus is on the control the closing dialog put it back on — the Workspace switcher the
		// row was reached from — rather than on the document, so an alert appearing does not drop a
		// keyboard user to the top of the page (WCAG 2.4.3).
		await expect(page.getByTestId('workspace-switcher')).toBeFocused();
	});

	test('cannot render one Workspace’s pending result beside another’s name', async ({ page }) => {
		const AMSTERDAM_SHAS = await sharedShas(AMSTERDAM);
		await start(page, {
			workspace: AMSTERDAM,
			connected: true,
			onRemote: AMSTERDAM
		});
		await seedBaseline(page, {
			owner: OWNER,
			repository: REPOSITORY,
			files: AMSTERDAM_SHAS
		});
		await page.reload();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
		await signedIn(page);
		await page.keyboard.press('Escape');
		await expect(remoteStatus(page)).toContainText('in sync with ada/atlas');

		// A listing of a large tree takes seconds, and one click switches Workspace inside one of them.
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route('https://api.github.com/**/git/trees/**', async (route) => {
			await held;
			await route.fallback();
		});
		await checkRemoteStatus(page);
		await expect(remoteStatus(page)).toContainText('Checking…');

		await createWorkspace(page, 'Delft');
		release?.();

		// The arriving Workspace is bound to nothing, so it has nothing to compare and says so in the
		// Workspace menu instead. What it must never do is wear the Workspace the author left.
		await expect(page.getByTestId('remote-status-slot')).toHaveCount(0);
		await switchToWorkspace(page, DEFAULT_WORKSPACE);
		await expect(remoteStatus(page)).toContainText('in sync with ada/atlas');
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// UPDATE FROM GITHUB
//
// **One complete inbound workflow, and the matrix stays at Seam 1.** Every three-way decision, every
// refusal, the SHA verification, the rollback and the Baseline arithmetic are exhausted in
// `packages/core/src/remote/get-from-remote.test.ts` against the same fake GitHub, with no
// browser and with complete before-and-after snapshots of the Workspace. What no seam below can
// falsify is that the *application* performs the operation it offers: that the control on the bar is
// the only thing that applies anything, that a real OPFS Workspace ends up holding the Remote's
// Project as ordinary work while the author's own unsent Project is still there, that the
// Remote's head has not moved, and that the status beside it is recomputed against what the Update
// left rather than what was there before.

/** A Project whose Layer names its Annotation the way a real `project.json` does: Project-relative. */
const syncProject = (directory: string, name: string): Record<string, string> => ({
	[`${directory}/project.json`]: `${JSON.stringify(
		{
			formatVersion: 1,
			name,
			updatedAt: '2026-01-02T03:04:05.000Z',
			layers: [
				{
					id: 'l2',
					name: 'Warehouses',
					visible: true,
					order: 0,
					kind: 'annotation',
					geojsonRef: 'annotations/l2.geojson',
					defaultStyle: {}
				}
			],
			baseMap: 'physical'
		},
		null,
		'\t'
	)}\n`,
	[`${directory}/annotations/l2.geojson`]: '{"type":"FeatureCollection","features":[]}'
});

/** The same Project with a second Annotation Layer, as another machine would send it. */
const withSecondLayer = (directory: string, name: string): string => {
	const project = JSON.parse(syncProject(directory, name)[`${directory}/project.json`] as string);
	project.layers.push({
		id: 'l3',
		name: 'Wharves',
		visible: true,
		order: 1,
		kind: 'annotation',
		geojsonRef: 'annotations/l3.geojson',
		defaultStyle: {}
	});
	return `${JSON.stringify(project, null, '\t')}\n`;
};

/** Hold one raw-host path until the returned function is called, so progress can be observed. */
async function holdRawFile(page: Page, path: string): Promise<() => void> {
	let release: (() => void) | undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(`https://raw.githubusercontent.com/**/${path}`, async (route) => {
		await held;
		await route.fallback();
	});
	return () => release?.();
}

test.describe('getting a Remote’s changes', () => {
	const ATLAS = syncProject('atlas-1625', 'Atlas 1625');
	const THEIRS = '{"type":"FeatureCollection","features":[{"id":"their-afternoon"}]}';

	/**
	 * Enough extra inbound files that `UPDATE_DOWNLOAD_CONCURRENCY` is a limit rather than a ceiling
	 * nothing reaches.
	 *
	 * They are unreferenced Layers beside the Project's own, which the graph check allows — only a
	 * directory with no `project.json` and an Alignment with no Map Image are violations. A transfer
	 * of two files cannot tell "six at a time" from "all at once", and the difference is the whole
	 * point: a Workspace of ten thousand pyramid tiles fetched with one `Promise.all` opens ten thousand
	 * sockets.
	 */
	const INBOUND_LAYERS = Object.fromEntries(
		Array.from({ length: 12 }, (_, index) => [
			`delft/annotations/spare-${index}.geojson`,
			`{"type":"FeatureCollection","features":[{"id":"spare-${index}"}]}`
		])
	);

	test('brings the Remote’s work in when the author asks, and never before', async ({ page }) => {
		const github = await start(page, {
			workspace: ATLAS,
			connected: true,
			onRemote: ATLAS
		});
		await seedBaseline(page, {
			owner: OWNER,
			repository: REPOSITORY,
			files: await sharedShas(ATLAS)
		});
		await page.reload();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
		await signedIn(page);
		await page.keyboard.press('Escape');
		await expect(remoteStatus(page)).toContainText('in sync with ada/atlas');

		// The author's own afternoon, which GitHub has never seen and this Update must not touch.
		await page.getByRole('button', { name: 'New Project' }).click();
		await page
			.getByRole('dialog', { name: 'New Project' })
			.getByLabel('Project name')
			.fill('Leiden');
		await page.getByRole('button', { name: 'Create Project' }).click();
		await expect(page.getByRole('link', { name: 'Leiden' })).toBeVisible();

		// And somebody else's: a Project sent from another machine, and a change to a file this
		// Workspace has not touched. Two safe changes on different paths.
		await github.commitFiles(OWNER, REPOSITORY, {
			...syncProject('delft', 'Delft'),
			...INBOUND_LAYERS,
			'atlas-1625/annotations/l2.geojson': THEIRS
		});
		await checkNow(page);
		await expect(remoteStatus(page)).toContainText('changes both ways');

		// ⚠ **Nothing has arrived, and that is the whole claim.** Coming back to the tab and asking for
		// the status again are both observations: neither downloads a byte.
		await refocus(page);
		await checkNow(page);
		await expect(page.getByRole('link', { name: 'Delft' })).toHaveCount(0);

		// The gesture, reached by the keyboard alone, with its progress reported while it runs.
		//
		// Every byte read is slowed down so that requests genuinely overlap: the bound below is a
		// property of a transfer in flight, and a fake that answers instantly makes any limit look
		// like 1. Installed after the fake's own handler, so it is consulted first and falls back.
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

		// ⚠ **Announced from inside the modal, which is where it has to be.** `showModal()` makes
		// everything outside the open `<dialog>` inert, and an inert `aria-live` region is not a quiet
		// one — it is not announced at all (ADR-0016). So the modal stays up for the transfer and the
		// line lives in it; the outcome is announced from the toast stack once it has closed.
		//
		// ⚠ **Per file, and it settles at what has actually arrived**. One file is held open, so the
		// count has one deterministic resting place short of the total rather than a number the test
		// was lucky to catch mid-transfer — and a progress line that counted the plan rather than the
		// transfer would sit at the total from the first moment.
		const progress = modal.getByTestId('sync-progress');
		await expect(progress).toHaveText(`Getting: ${transferred - 1} of ${transferred} files.`, {
			timeout: 30_000
		});
		// Announced rather than only drawn, and atomic: "14 of 15" read on its own says nothing about
		// what is being counted.
		expect(
			await progress.evaluate((element) => [
				element.getAttribute('aria-live'),
				element.getAttribute('aria-atomic')
			])
		).toEqual(['polite', 'true']);
		// And a long transfer never strands a keyboard user at the top of the document.
		expect(await page.evaluate(() => document.activeElement?.tagName ?? 'NONE')).not.toBe('BODY');
		release();

		const outcome = page.getByTestId('update-outcome');
		await expect(outcome).toContainText('Brought');
		await expect(outcome).toContainText('Nothing has been sent');
		await expect(modal).toBeHidden();

		// ⚠ **Bounded, and the outcome agrees with the count.** No assertion on the paths requested or
		// on what landed can tell six at a time from all at once, so the peak overlap is measured at
		// the transport; and the sentence names the same files the progress line counted.
		expect(github.peakRawInFlight()).toBeLessThanOrEqual(UPDATE_DOWNLOAD_CONCURRENCY);
		expect(github.peakRawInFlight()).toBeGreaterThan(1);
		await expect(outcome).toContainText(`${transferred - 1} new files and 1 changed file`);
		expect(github.rawGets(OWNER, REPOSITORY)).toBe(transferred);
		// Named, so this removes the delay and leaves the fake's own handler for the leg below.
		await page.unroute(`${GITHUB_RAW_ORIGIN}/**`, slowly);

		// ⚠ **Inbound only.** The branch has not moved and the file the other machine wrote is still
		// the one on GitHub: receiving somebody's work cannot make this author's work public.
		expect(github.head(OWNER, REPOSITORY)).toBe(head);
		expect(github.fileText(OWNER, REPOSITORY, 'atlas-1625/annotations/l2.geojson')).toBe(THEIRS);
		expect(github.fileText(OWNER, REPOSITORY, 'leiden/project.json')).toBe(null);

		// The author's unsent Project is still here, and the Remote's is here as
		// ordinary work that opens.
		await expect(page.getByRole('link', { name: 'Leiden' })).toBeVisible();
		await page.getByRole('link', { name: 'Delft' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Delft');

		// And the next required action is on screen already: the Baseline advanced only for what is now
		// shared, so the Project GitHub has never seen is still Changes to send.
		await expect(remoteStatus(page)).toContainText('changes to send');
		await expect(page.getByRole('status')).toContainText('Saved here');

		// Finally: a switch inside a transfer. The Workspace the Update was aimed at is the one it
		// writes to, and the one that arrives wears none of it.
		await github.commitFiles(OWNER, REPOSITORY, { 'atlas-1625/annotations/l9.geojson': '{}' });
		const holdAgain = await holdRawFile(page, 'atlas-1625/annotations/l9.geojson');
		await getFromRemote(page);
		// The line itself, not its count: whether the plan has resolved by now decides between "file"
		// and "files", and what this needs is only that a transfer is under way to switch out of.
		await expect(page.getByTestId('sync-progress')).toContainText('Getting');
		// ⚠ **Escape while it runs, which is the state this leg is about.** The transfer outlives the
		// modal that started it, so the author can put the modal away and carry on — including by
		// switching Workspace, which is the switch under test.
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog', { name: 'Sync with GitHub' })).toBeHidden();
		await createWorkspace(page, 'Elsewhere');
		holdAgain();

		await expect(page.getByTestId('remote-status-slot')).toHaveCount(0);
		await expect(page.getByTestId('update-outcome')).toHaveCount(0);
		// Nothing was written into it either: it is a new Workspace and it holds no Projects at all.
		await expect(page.getByRole('link', { name: 'Atlas 1625' })).toHaveCount(0);
		await switchToWorkspace(page, DEFAULT_WORKSPACE);
		await expect(page.getByTestId('update-outcome')).toHaveCount(0);

		// ⚠ **And the Project on screen reads the Update too, not only the hub's list.** The control is
		// on the navigation bar, so an Update lands while a Project is open — and `project.json` is the
		// document every Layer edit spreads over before writing it back. Left unread, the next ordinary
		// edit writes the pre-Update Layer stack back over the Remote's, silently taking the Layer the
		// Update had just brought in.
		await expect(page.getByRole('heading', { level: 1, name: 'Delft' })).toBeVisible();
		await expect(page.getByTestId('layer-row')).toHaveCount(1);

		await github.commitFiles(OWNER, REPOSITORY, {
			'delft/project.json': withSecondLayer('delft', 'Delft'),
			'delft/annotations/l3.geojson': '{"type":"FeatureCollection","features":[]}'
		});
		await checkNow(page);
		await getFromRemote(page);
		await expect(page.getByTestId('update-outcome')).toContainText('Brought');

		await expect(page.getByTestId('layer-row')).toHaveCount(2);
		await page.getByTestId('add-annotation-layer').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(3);
		await expect(page.getByRole('status')).toContainText('Saved here');

		// ⚠ **And an Edit History does not survive an Update** (ADR-0039). A Step holds the bytes of the
		// files its gesture wrote, so a Step taken before an Update describes files the Update may have
		// replaced — and undoing one would write the pre-Update bytes back over what arrived, which is
		// the same silent loss the re-read above prevents, performed by a button.
		// Two Steps with one walked back, so both ends of the history are on the bar to lose.
		await page.getByTestId('add-annotation-layer').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(4);
		await page.getByTestId('edit-history-undo').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(3);
		await expect(page.getByTestId('edit-history-undo')).toBeVisible();
		await expect(page.getByTestId('edit-history-redo')).toBeVisible();
		await expect(page.getByTestId('edit-history-outcome')).toContainText('Undone:');

		await github.commitFiles(OWNER, REPOSITORY, {
			'delft/annotations/l4.geojson': '{"type":"FeatureCollection","features":[]}'
		});
		await checkNow(page);
		await getFromRemote(page);
		await expect(page.getByTestId('update-outcome')).toContainText('Brought');

		await expect(page.getByTestId('edit-history-undo')).toHaveCount(0);
		await expect(page.getByTestId('edit-history-redo')).toHaveCount(0);
		// **Silently**: the controls simply go. The stack still holds what the undo said and nothing
		// else, because a second message about a vanished button would compete with the Update's own.
		await expect(page.getByTestId('edit-history-outcome')).toContainText('Undone:');

		// Off disk rather than off the screen: the question is what the edit wrote, not what it drew.
		await page.reload();
		await expect(page.getByTestId('layer-row')).toHaveCount(3);
	});
	test('names what a deletion would take before anything is pressed, and then takes it', async ({
		page
	}) => {
		// Two Projects both sides hold. The Remote loses one of them entirely.
		const both = { ...ATLAS, ...syncProject('delft', 'Delft') };
		const github = await start(page, {
			workspace: both,
			connected: true,
			onRemote: both
		});
		await seedBaseline(page, {
			owner: OWNER,
			repository: REPOSITORY,
			files: await sharedShas(both)
		});
		await page.reload();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
		await signedIn(page);
		await page.keyboard.press('Escape');
		await expect(remoteStatus(page)).toContainText('in sync with ada/atlas');

		await github.commitFiles(OWNER, REPOSITORY, {
			'delft/project.json': null,
			'delft/annotations/l2.geojson': null
		});
		// After the other machine's commit, so what this pins is that *Update* moves nothing.
		const head = github.head(OWNER, REPOSITORY);

		// ── The removal, named on the modal the author reads before pressing anything ────────────
		//
		// ⚠ **No confirmation, and that is the whole shape** (ADR-0044). The deletion is on the screen
		// the author is already looking at, named by the Project's own name, *before* the press — a
		// deletion discovered after one is the failure this modal exists to prevent, and a second
		// question in front of a decision already taken is one people learn to press through.
		const dialog = await openSync(page);
		await expect(dialog.getByTestId('to-get-removals')).toBeVisible();
		await expect(dialog.getByTestId('to-get')).toContainText('Delft');

		// ── Dismissed: nothing here, nothing there, and focus back where it came from ─────────────
		// From the keyboard, like the control that opened it: a screen a scholar can only leave with a
		// pointer is one they cannot leave.
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(page.getByTestId('connect-to-github')).toBeFocused();
		await expect(page.getByRole('link', { name: 'Delft' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Atlas 1625' })).toBeVisible();
		// The Remote is untouched by the *reading*, and so is the record of what the two sides shared:
		// the status still reads the drift it read before, rather than agreement it never reached.
		expect(github.head(OWNER, REPOSITORY)).toBe(head);
		await checkNow(page);
		await expect(remoteStatus(page)).toContainText('changes to get');

		// ── Get changes: the Project goes, and the one the Remote kept does not ───────────────────
		await getFromRemote(page);

		await expect(page.getByTestId('update-outcome')).toContainText('Removed');
		await expect(page.getByRole('link', { name: 'Delft' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Atlas 1625' })).toBeVisible();
		// And the two sides now agree, which is the whole point of applying a deletion rather than
		// refusing it: a synchronized deletion that did not apply comes back at every status check.
		await expect(remoteStatus(page)).toContainText('in sync with ada/atlas');

		// ── An Update whose record cannot be read shuts the Workspace, rather than showing half of
		// one. Folded in here rather than given its own test because it needs exactly
		// this Workspace: a marker over real Projects, which is what makes "the list is absent" mean
		// something. The engine's own recovery is asserted per durable boundary at Seam 1.
		await seed(page, { 'update.json': '{ not a marker' });
		await page.reload();

		await expect(page.getByTestId('unrecovered-import')).toBeVisible();
		// Nothing enumerates: no Project list, and the GitHub control the bar offers over a Workspace
		// it can read is not there either — which takes the whole Sync with it.
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Atlas 1625' })).toHaveCount(0);
		await expect(page.getByTestId('connect-to-github')).toHaveCount(0);
	});
});
