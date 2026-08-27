import { DEFAULT_WORKSPACE, expect, test, type Page, type Route } from './support/test.js';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { GITHUB_RAW_ORIGIN, routeGitHubHosts, type GitHubHosts } from './support/github-hosts.js';
import { oneProjectBundle } from './support/project-bundle.js';
import {
	createWorkspace,
	openRemoteSettings,
	revealBindToken,
	seedBaseline,
	seedGitHubCredential,
	seedRemoteRelationship,
	switchToWorkspace
} from './support/workspace.js';
import { gitBlobSha } from '../packages/core/src/remote/blob-sha.js';
import { UPDATE_DOWNLOAD_CONCURRENCY } from '../packages/core/src/remote/update-from-github.js';

/**
 * The two refusals that stop one machine deleting another's afternoon (ticket 05, ADR-0033).
 *
 * SPEC's Seam 2, driving Seam 1's fake through Playwright routes. The comparison itself — per file
 * and never by commit SHA, the manifest read both ways round, the no-manifest fallback, and what
 * survives a replace — is asserted in `packages/core/src/remote/publish-to-remote.test.ts` and
 * `bind-remote.test.ts`, where the assertion is the resulting tree rather than a screen. What only a
 * browser can settle is here: that the refusal reaches a scholar as a sentence naming the files,
 * that both remedies are on the screen it arrives on, and that taking the second one publishes.
 *
 * ⚠ **Assertions are on what arrived at the Remote**, never on which calls were made — the division
 * SPEC's testing decisions draw, because every failure mode in this ticket is silent and plausible.
 */

test.beforeEach(async ({ page }) => routeBaseMapArchive(page));

const OWNER = 'ada';
const REPOSITORY = 'atlas';
const REMOTE = `${OWNER}/${REPOSITORY}`;
/** A token of the right shape. Its value never matters: the fake looks only for a credential. */
const TOKEN = 'github_pat_11ABCDE0000abcdefghijklmnop';

/** `remote.json`, exactly as `bindWorkspaceToRemote` writes it. */
const boundTo = (): Record<string, string> => ({
	'remote.json': `${JSON.stringify({ formatVersion: 1, owner: OWNER, repository: REPOSITORY, branch: 'main' }, null, '\t')}\n`
});

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

/** The same Project with a second Annotation Layer, as another machine would publish it. */
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

/** A site record as a published Remote carries one, listing whichever Projects it was given. */
const siteRecord = (projects: { directory: string; name: string }[]): string =>
	JSON.stringify({
		formatVersion: 2,
		viewerVersion: 'published-earlier',
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
		// ⚠ The publish manifest lives in `localStorage`, so a test that emptied only OPFS would
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
	options: { workspace?: Record<string, string>; onRemote?: Record<string, string> } = {}
): Promise<GitHubHosts> {
	const github = await routeGitHubHosts(page, {
		repositories: [
			{
				owner: OWNER,
				name: REPOSITORY,
				files: { 'README.md': '# Atlas\n', ...options.onRemote }
			}
		]
	});
	await page.goto('./');
	await emptyBrowserStorage(page);
	await seed(page, options.workspace ?? {});
	// ⚠ **The Remote is installation-local now** (ADR-0038): a seeded `remote.json` is the Published
	// Site's compatibility evidence and binds nothing, so a spec that needs a bound Workspace records
	// the relationship the way an Open or a bind does.
	if (options.workspace?.['remote.json']) {
		await seedRemoteRelationship(page, { owner: OWNER, repository: REPOSITORY });
	}
	await page.reload();
	await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
	return github;
}

const openPublishDialog = async (page: Page) => {
	await page.getByRole('button', { name: 'Publish…' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByTestId('publish-breakdown')).toBeVisible();
	return dialog;
};

/**
 * Reach the publish dialog of a bound Workspace that holds a credential.
 *
 * ⚠ **The credential is seeded rather than acquired.** On a deployment with a GitHub App the publish
 * dialog offers no token field — the door there is a redirect off the page (SPEC story 37) — and
 * every test in this spec is about which files a refusal protects, not about how the credential was
 * got. See {@link seedGitHubCredential}; the door itself is driven in `editor-github-signin.e2e.ts`.
 *
 * The reload is what makes the seeded credential held: it is read when the app starts.
 */
async function signIn(page: Page) {
	await seedGitHubCredential(page, TOKEN);
	await page.reload();
	await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
	return openPublishDialog(page);
}

/**
 * Confirm the dialog and wait for the Remote to be named in the result.
 *
 * The Base Map's own files are included throughout: `base-map/` is inside the owned namespace and
 * does not affect the conflict being exercised.
 */
async function confirm(page: Page, dialog: ReturnType<Page['getByRole']>): Promise<void> {
	await expect(dialog.getByTestId('publish-breakdown')).toBeVisible();
	await dialog.getByRole('button', { name: /^Publish/ }).click();
	await expect(page.getByTestId('publish-status')).toContainText(`Sent to ${REMOTE}`, {
		timeout: 120_000
	});
}

test.describe('binding to a Remote that already carries somebody else’s Projects (story 23)', () => {
	async function bind(page: Page): Promise<void> {
		await openRemoteSettings(page);
		await page.getByTestId('remote-repository-field').fill(REMOTE);
		await revealBindToken(page);
		await page.getByTestId('remote-token-field').fill(TOKEN);
		await page.getByTestId('bind-remote').click();
	}

	test('is refused, names the Project, and points at Open a Workspace from GitHub', async ({
		page
	}) => {
		await start(page, {
			workspace: projectFiles('amsterdam-1625', 'Amsterdam 1625'),
			onRemote: {
				'ballastella-site.json': siteRecord([
					{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' },
					{ directory: 'florida-1657', name: 'Florida 1657' }
				]),
				'florida-1657/project.json': '{"formatVersion":1,"name":"Florida 1657"}'
			}
		});

		await bind(page);

		const problem = page.getByTestId('remote-problem');
		await expect(problem).toContainText('“Florida 1657”');
		await expect(problem).toContainText(`Open ${REMOTE} from GitHub`);
		// The binding is what a Publish button aims at, so a refused bind must leave none — otherwise
		// the next press is the one that deletes the Project just named.
		await expect(page.getByTestId('remote-outcome')).toHaveText('');
	});

	test('goes ahead when the Remote’s Projects are all here', async ({ page }) => {
		await start(page, {
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

		await bind(page);

		await expect(page.getByTestId('remote-outcome')).toContainText(
			`This Workspace is bound to ${REMOTE}`
		);
	});
});

test.describe('a publish that would overwrite work this browser has never seen', () => {
	test('is refused with “we cannot tell” when this browser has no record of the Remote', async ({
		page
	}) => {
		const github = await start(page, {
			workspace: { ...projectFiles('amsterdam-1625', 'Amsterdam 1625'), ...boundTo() },
			// A Remote somebody has already published to, and a browser that has never published to it:
			// an Open from GitHub, a second machine, or storage cleared since. All three look the same
			// from here.
			onRemote: {
				'ballastella-site.json': siteRecord([
					{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }
				]),
				'amsterdam-1625/project.json': '{"formatVersion":1,"name":"published elsewhere"}',
				'index.html': '<!doctype html><title>Published earlier</title>'
			}
		});
		const before = github.head(OWNER, REPOSITORY);

		const dialog = await signIn(page);

		const refusal = dialog.getByTestId('publish-conflict');
		await expect(refusal).toHaveAttribute('data-conflict', 'unknown-history');
		await expect(refusal).toContainText('nothing here can tell');
		// Said as the ordinary state it is: every Workspace opened from a Remote is in it until it has
		// published once, and a scholar meeting an alarm on the first press learns to force (story 24).
		await expect(refusal).toContainText('not a sign that anything has gone wrong');
		await expect(refusal).toContainText(`Open ${REMOTE} from GitHub`);

		// Nothing sent, and the button that would send it is inert with the reason above it.
		await expect(dialog.getByRole('button', { name: 'Publish', exact: true })).toHaveAttribute(
			'aria-disabled',
			'true'
		);
		expect(github.head(OWNER, REPOSITORY)).toBe(before);
		expect(github.fileText(OWNER, REPOSITORY, 'amsterdam-1625/project.json')).toBe(
			'{"formatVersion":1,"name":"published elsewhere"}'
		);
	});

	// ⚠ **The refusal must not shadow "nothing needs changing", and this is the state where it did.**
	// `unknown` is raised on nothing more than "no manifest, and the owned namespace is not empty" —
	// which is equally true of a Remote holding this Workspace byte for byte. Rendered conflict-first,
	// that Workspace met a refusal, a "publish anyway" that armed and changed nothing, and a Publish
	// button `aria-disabled` with the sentence explaining it suppressed: a dead button with nothing on
	// screen accounting for it, which is the failure this whole epic exists to remove. Reachable from a
	// quota refusal that could not keep the manifest, a cleared browser — and the first publish from a
	// complete Open, which is story 24 itself.
	test('says nothing needs changing when the Remote matches, even with no record of publishing it', async ({
		page
	}) => {
		const github = await start(page, {
			workspace: { ...projectFiles('amsterdam-1625', 'Amsterdam 1625'), ...boundTo() }
		});
		await confirm(page, await signIn(page));
		const commit = github.head(OWNER, REPOSITORY);

		// The record of that publish, and nothing else. The Workspace and the Remote still agree
		// exactly; only this browser's evidence about them has gone.
		await page.evaluate(() => localStorage.clear());
		await page.reload();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();

		const dialog = await openPublishDialog(page);

		await expect(dialog.getByTestId('publish-nothing-to-do')).toContainText(REMOTE);
		await expect(dialog.getByTestId('publish-conflict')).toBeHidden();
		// Inert, and now with the reason for it on screen beside it (SPEC story 60).
		await expect(dialog.getByRole('button', { name: 'Publish', exact: true })).toHaveAttribute(
			'aria-disabled',
			'true'
		);
		expect(github.head(OWNER, REPOSITORY)).toBe(commit);
	});

	test('names the file another machine wrote, and replaces it when told to', async ({ page }) => {
		const github = await start(page, {
			workspace: { ...projectFiles('amsterdam-1625', 'Amsterdam 1625'), ...boundTo() }
		});

		// A first publish, which is what gives this browser its record of the Remote.
		await confirm(page, await signIn(page));

		// The other machine's afternoon, arriving after this one last looked. The one thing no gesture
		// in this app can produce, and the whole subject of the refusal.
		await github.commitFiles(OWNER, REPOSITORY, {
			'amsterdam-1625/annotations/l2.geojson':
				'{"type":"FeatureCollection","features":[{"id":"a-whole-afternoon"}]}'
		});

		const dialog = await openPublishDialog(page);
		const refusal = dialog.getByTestId('publish-conflict');
		await expect(refusal).toHaveAttribute('data-conflict', 'remote-changes');
		await expect(refusal).toContainText('amsterdam-1625/annotations/l2.geojson');
		// Both remedies, on the one screen. The first is Update from GitHub rather than a second
		// Workspace: with a Baseline this machine can tell whose the file is, so bringing it in is safe
		// and keeps this Workspace's own unpublished work (SPEC story 133).
		await expect(refusal).toContainText('Update from GitHub first');
		await expect(refusal).toContainText('is on the navigation bar');
		await expect(dialog.getByTestId('publish-replace')).toBeVisible();
		// ⚠ **And the three budgets beside it, not instead of it.** A conflict is where the replacement
		// tree is largest and where the scholar is being asked to press through a warning, so it is the
		// worst state in this dialog to be the one that hides story 9's two numbers.
		await expect(dialog.getByTestId('publish-budget')).toBeVisible();

		// ⚠ **Dismissal first, and from the keyboard.** ADR-0016's `<dialog>` + `showModal()`: Escape
		// closes it and focus comes back to the control that opened it, rather than to the document
		// (WCAG 2.4.3). A refusal a keyboard user can only leave by pointer is a refusal they cannot
		// leave.
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(page.getByRole('button', { name: 'Publish…' })).toBeFocused();
		await openPublishDialog(page);

		// Taking the second remedy is two presses, the shape every irreversible action here has — and
		// both of them are reachable and operable from the keyboard alone (story 148). The confirm
		// button then says what pressing it does rather than "Publish".
		await dialog.getByTestId('publish-replace').focus();
		await page.keyboard.press('Enter');
		const anyway = dialog.getByRole('button', { name: 'Publish anyway, replacing it' });
		await expect(anyway).toBeVisible();
		await anyway.focus();
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('publish-status')).toContainText(`Sent to ${REMOTE}`, {
			timeout: 120_000
		});

		expect(github.fileText(OWNER, REPOSITORY, 'amsterdam-1625/annotations/l2.geojson')).toBe(
			'{"type":"FeatureCollection","features":[]}'
		);
		// Replacing is still ADR-0033's mirror: the scholar's own `README.md` is outside the owned
		// namespace and survives a replace exactly as it survives an ordinary publish.
		expect(github.fileText(OWNER, REPOSITORY, 'README.md')).toBe('# Atlas\n');
		// ⚠ **And the status on the bar is recomputed by the publish, not by the next window focus.**
		// The evidence this machine holds has just moved and the Remote with it, so a control still
		// reading `Changes to publish` beside a finished publish is the one moment an author is most
		// likely to press it again (SPEC story 131's counterpart on the outbound side).
		await expect(remoteStatus(page)).toContainText('Your work is on GitHub');
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// REMOTE STATUS (ticket 12; SPEC stories 111–120, 147)
//
// **One workflow rather than a second planner matrix.** The six determinations and the table behind
// them are exhausted at Seam 1 (`synchronization-planner.test.ts`, `local-change-index.test.ts`),
// and the bounded checking, the retained failure and the per-Workspace isolation at Seam 1 too
// (`remote-status.test.ts`) — all of it without a browser. What only a browser can settle is that
// the control is *there*, on every screen, in words, beside a `Saved locally` that stays its own
// thing; that an authenticated session checks by itself and a signed-out one does not; and that a
// failed check leaves the last answer on screen rather than reporting agreement.
//
// The Baseline is seeded rather than earned through a Publish. Advancing it from a Publish is ticket
// 16's, and a spec that had to publish to reach each state would be testing publishing five times
// over to arrive at the thing it wanted to assert.

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
 * The status control's own words. Never `role="status"` — that is the save indicator's.
 *
 * ⚠ **The bar leads with the plain answer, not with the determination.** `Changes on both sides` and
 * the other five are one press behind it, so the sentences asserted here are `REMOTE_STATUS_LEADS`'s
 * and each still stands for exactly one of the six. Which lead belongs to which determination is
 * `remote-status.dom.test.ts`'s at Seam 1c; what this file can say is that the determination the
 * checker reached is the one the bar is speaking for.
 */
const remoteStatus = (page: Page) => page.getByTestId('remote-status-state');

/** Ask for a check the way an author does, and wait for it to finish. */
async function checkNow(page: Page): Promise<void> {
	await page.getByTestId('check-remote-status').click();
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
 * ⚠ **The status control is not the only thing here that lists a tree**: the publish dialog takes one
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
			workspace: { ...AMSTERDAM, ...boundTo() },
			onRemote: AMSTERDAM
		});

		// Bound, with no Baseline yet: `Cannot tell` is a determination and it needs no request, so its
		// lead is on screen without a credential and without GitHub having been asked anything.
		await expect(remoteStatus(page)).toContainText(
			'Ballastella cannot say whether your work reached GitHub'
		);
		expect(listings(github)).toBe(0);

		// ⚠ **`Saved locally` is still the one `status` region on this bar**, and strict mode is the
		// assertion: a control that had taken that role would make the two facts a scholar most needs
		// kept apart indistinguishable to a screen reader (SPEC story 111).
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		expect(
			await remoteStatus(page).evaluate((element) => [
				element.getAttribute('aria-live'),
				element.getAttribute('role')
			])
		).toEqual(['polite', null]);

		await seedBaseline(page, {
			owner: OWNER,
			repository: REPOSITORY,
			files: await sharedShas(AMSTERDAM)
		});
		await page.reload();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();

		// ⚠ **Signed out, nothing is polled** (SPEC story 115). GitHub allows an anonymous reader sixty
		// requests an hour *per IP address*, so a seminar room on one campus address checking on every
		// window focus would spend the room's whole budget on status.
		await expect(remoteStatus(page)).toContainText('Not checked yet');
		await refocus(page);
		await refocus(page);
		expect(listings(github)).toBe(0);

		// The gesture, reached by the keyboard alone, is what makes status available with no account at
		// all — and the answer is dated, so a retained one can later be told from a current one.
		await page.getByTestId('check-remote-status').focus();
		await page.keyboard.press('Enter');
		await expect(remoteStatus(page)).toContainText('Your work is on GitHub');
		await expect(page.getByTestId('remote-status-checked')).toContainText('Checked at');
		expect(listings(github)).toBe(1);
	});

	test('follows a bound Workspace through drift, staleness and a failed check', async ({
		page
	}) => {
		const github = await start(page, {
			workspace: { ...AMSTERDAM, ...boundTo() },
			onRemote: { ...AMSTERDAM, 'index.html': '<!doctype html><title>Atlas</title>' }
		});
		await seedBaseline(page, {
			owner: OWNER,
			repository: REPOSITORY,
			// A Baseline a Publish wrote: the source paths *and* the generated output it sent, which is
			// what makes Published Site staleness answerable at all.
			files: await sharedShas({
				...AMSTERDAM,
				'index.html': '<!doctype html><title>Atlas</title>'
			})
		});
		await page.reload();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();

		// Signing in is the moment an automatic check becomes possible, and it takes one by itself.
		await signIn(page);
		await page.keyboard.press('Escape');
		await expect(remoteStatus(page)).toContainText('Your work is on GitHub');
		const afterSignIn = await settledListings(page, github);

		// ⚠ **Bounded.** Coming back to the tab three times inside the interval is three focus events
		// and no further listings — the whole reason a focus trigger is affordable (SPEC story 114).
		await refocus(page);
		await refocus(page);
		await refocus(page);
		await expect(remoteStatus(page)).toContainText('Your work is on GitHub');
		expect(listings(github)).toBe(afterSignIn);

		// Another editor version rebuilt the site: different chunk names, identical scholarship. It is
		// said separately and the source status is untouched (SPEC story 120).
		await github.commitFiles(OWNER, REPOSITORY, {
			'index.html': '<!doctype html><title>Atlas, rebuilt</title>'
		});
		await checkNow(page);
		await expect(remoteStatus(page)).toContainText('Your work is on GitHub');
		await expect(page.getByTestId('published-site-stale')).toContainText('Publish again');

		// The author's own work, which GitHub has never seen.
		await page.getByRole('button', { name: 'New Project' }).click();
		await page
			.getByRole('dialog', { name: 'New Project' })
			.getByLabel('Project name')
			.fill('Delft');
		await page.getByRole('button', { name: 'Create Project' }).click();
		await expect(page.getByRole('link', { name: 'Delft' })).toBeVisible();
		await checkNow(page);
		await expect(remoteStatus(page)).toContainText('Not all your work is on GitHub yet');

		// And somebody else's afternoon, arriving on a path this Workspace has not touched. Two safe
		// changes, and the whole point of the state is that it is not a Conflict.
		await github.commitFiles(OWNER, REPOSITORY, {
			'amsterdam-1625/annotations/l2.geojson':
				'{"type":"FeatureCollection","features":[{"id":"theirs"}]}'
		});
		await checkNow(page);
		await expect(remoteStatus(page)).toContainText('This Workspace and GitHub have both changed');

		// Persistent, and it follows the author onto the Project screen — drift stays visible while
		// they work rather than only on the hub (SPEC story 112).
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		await expect(remoteStatus(page)).toContainText('This Workspace and GitHub have both changed');
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		// The same path on both sides, which is the one state the passive check may not read as
		// agreement: it knows `delft/project.json` changed here and cannot compare the bytes.
		await github.commitFiles(OWNER, REPOSITORY, {
			'delft/project.json': '{"formatVersion":1,"name":"Delft, theirs"}'
		});
		await checkNow(page);
		await expect(remoteStatus(page)).toContainText('This Workspace and GitHub disagree');

		// ⚠ **A failed check is not agreement** (SPEC story 118). The last determination stays, dated,
		// with an alert beside it saying it is no longer being confirmed — never relabelled `Up to
		// date`, and never the successful determination `Cannot tell`.
		const checkedBefore = await page.getByTestId('remote-status-checked').textContent();
		await page.route('https://api.github.com/**/git/trees/**', (route) =>
			route.abort('connectionfailed')
		);
		await page.getByTestId('check-remote-status').click();
		const failure = page.getByTestId('remote-status-failure');
		await expect(failure).toBeVisible();
		await expect(failure).toContainText('the last one Ballastella was able to work out');
		await expect(remoteStatus(page)).toHaveAttribute('data-remote-status', 'conflict');
		await expect(remoteStatus(page)).toContainText('This Workspace and GitHub disagree');
		await expect(remoteStatus(page)).toContainText('Check failed');
		expect(await page.getByTestId('remote-status-checked').textContent()).toBe(checkedBefore);
		// The alert is announced rather than merely rendered: it is inserted at the moment its text
		// first exists, which a polite region does not reliably announce.
		expect(await failure.getAttribute('role')).toBe('alert');
		// And the control that was pressed still holds focus, so an alert appearing beside it does not
		// drop a keyboard user to the top of the document (WCAG 2.4.3).
		await expect(page.getByTestId('check-remote-status')).toBeFocused();
	});

	test('cannot render one Workspace’s pending result beside another’s name', async ({ page }) => {
		const AMSTERDAM_SHAS = await sharedShas(AMSTERDAM);
		await start(page, {
			workspace: { ...AMSTERDAM, ...boundTo() },
			onRemote: AMSTERDAM
		});
		await seedBaseline(page, {
			owner: OWNER,
			repository: REPOSITORY,
			files: AMSTERDAM_SHAS
		});
		await page.reload();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
		await signIn(page);
		await page.keyboard.press('Escape');
		await expect(remoteStatus(page)).toContainText('Your work is on GitHub');

		// A listing of a large tree takes seconds, and one click switches Workspace inside one of them.
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route('https://api.github.com/**/git/trees/**', async (route) => {
			await held;
			await route.fallback();
		});
		await page.getByTestId('check-remote-status').click();
		await expect(remoteStatus(page)).toContainText('Checking…');

		await createWorkspace(page, 'Delft');
		release?.();

		// The arriving Workspace is bound to nothing, so it has nothing to compare and says so in the
		// Workspace menu instead. What it must never do is wear the Workspace the author left.
		await expect(page.getByTestId('remote-status-slot')).toHaveCount(0);
		await switchToWorkspace(page, DEFAULT_WORKSPACE);
		await expect(remoteStatus(page)).toContainText('Your work is on GitHub');
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// UPDATE FROM GITHUB (ticket 14; SPEC stories 105, 121–124, 128–131)
//
// **One complete inbound workflow, and the matrix stays at Seam 1.** Every three-way decision, every
// refusal, the SHA verification, the rollback and the Baseline arithmetic are exhausted in
// `packages/core/src/remote/update-from-github.test.ts` against the same fake GitHub, with no
// browser and with complete before-and-after snapshots of the Workspace. What no seam below can
// falsify is that the *application* performs the operation it offers: that the control on the bar is
// the only thing that applies anything, that a real OPFS Workspace ends up holding the Remote's
// Project as ordinary work while the author's own unpublished Project is still there, that the
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

test.describe('Update from GitHub', () => {
	const ATLAS = syncProject('atlas-1625', 'Atlas 1625');
	const THEIRS = '{"type":"FeatureCollection","features":[{"id":"their-afternoon"}]}';

	/**
	 * Enough extra inbound files that `UPDATE_DOWNLOAD_CONCURRENCY` is a limit rather than a ceiling
	 * nothing reaches.
	 *
	 * They are unreferenced Layers beside the Project's own, which the graph check allows — only a
	 * directory with no `project.json` and an Alignment with no Map Image are violations. A transfer
	 * of two files cannot tell "six at a time" from "all at once", and the difference is the whole of
	 * story 149: a Workspace of ten thousand pyramid tiles fetched with one `Promise.all` opens ten
	 * thousand sockets.
	 */
	const INBOUND_LAYERS = Object.fromEntries(
		Array.from({ length: 12 }, (_, index) => [
			`delft/annotations/spare-${index}.geojson`,
			`{"type":"FeatureCollection","features":[{"id":"spare-${index}"}]}`
		])
	);

	test('brings the Remote’s work in when the author asks, and never before', async ({ page }) => {
		const github = await start(page, {
			workspace: { ...ATLAS, ...boundTo() },
			onRemote: ATLAS
		});
		await seedBaseline(page, {
			owner: OWNER,
			repository: REPOSITORY,
			files: await sharedShas(ATLAS)
		});
		await page.reload();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
		await signIn(page);
		await page.keyboard.press('Escape');
		await expect(remoteStatus(page)).toContainText('Your work is on GitHub');

		// The author's own afternoon, which GitHub has never seen and this Update must not touch.
		await page.getByRole('button', { name: 'New Project' }).click();
		await page
			.getByRole('dialog', { name: 'New Project' })
			.getByLabel('Project name')
			.fill('Leiden');
		await page.getByRole('button', { name: 'Create Project' }).click();
		await expect(page.getByRole('link', { name: 'Leiden' })).toBeVisible();

		// And somebody else's: a Project published from another machine, and a change to a file this
		// Workspace has not touched. Two safe changes on different paths (SPEC story 129).
		await github.commitFiles(OWNER, REPOSITORY, {
			...syncProject('delft', 'Delft'),
			...INBOUND_LAYERS,
			'atlas-1625/annotations/l2.geojson': THEIRS
		});
		await checkNow(page);
		await expect(remoteStatus(page)).toContainText('This Workspace and GitHub have both changed');

		// ⚠ **Nothing has arrived, and that is the whole of story 121.** Coming back to the tab and
		// asking for the status again are both observations: neither downloads a byte.
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
		await page.getByTestId('update-from-github').focus();
		await page.keyboard.press('Enter');

		// ⚠ **Per file, and it settles at what has actually arrived** (story 149). One file is held
		// open, so the count has one deterministic resting place short of the total rather than a
		// number the test was lucky to catch mid-transfer — and a progress line that counted the plan
		// rather than the transfer would sit at the total from the first moment.
		const progress = page.getByTestId('update-progress');
		await expect(progress).toHaveText(
			`Updating from GitHub: ${transferred - 1} of ${transferred} files.`,
			{ timeout: 30_000 }
		);
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
		await expect(outcome).toContainText('Nothing has been published');
		await expect(page.getByTestId('update-progress')).toHaveCount(0);

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
		// the one on GitHub: receiving somebody's work cannot make this author's work public (story 122).
		expect(github.head(OWNER, REPOSITORY)).toBe(head);
		expect(github.fileText(OWNER, REPOSITORY, 'atlas-1625/annotations/l2.geojson')).toBe(THEIRS);
		expect(github.fileText(OWNER, REPOSITORY, 'leiden/project.json')).toBe(null);

		// The author's unpublished Project is still here (story 128), and the Remote's is here as
		// ordinary work that opens (story 123).
		await expect(page.getByRole('link', { name: 'Leiden' })).toBeVisible();
		await page.getByRole('link', { name: 'Delft' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Delft');

		// And the next required action is on screen already: the Baseline advanced only for what is now
		// shared, so the Project GitHub has never seen is still Changes to publish (stories 130, 131).
		await expect(remoteStatus(page)).toContainText('Not all your work is on GitHub yet');
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		// Finally: a switch inside a transfer. The Workspace the Update was aimed at is the one it
		// writes to, and the one that arrives wears none of it.
		await github.commitFiles(OWNER, REPOSITORY, { 'atlas-1625/annotations/l9.geojson': '{}' });
		const holdAgain = await holdRawFile(page, 'atlas-1625/annotations/l9.geojson');
		await page.getByTestId('update-from-github').click();
		await expect(page.getByTestId('update-progress')).toContainText('files');
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
		// Update had just brought in (stories 124, 141).
		await expect(page.getByRole('heading', { level: 1, name: 'Delft' })).toBeVisible();
		await expect(page.getByTestId('layer-row')).toHaveCount(1);

		await github.commitFiles(OWNER, REPOSITORY, {
			'delft/project.json': withSecondLayer('delft', 'Delft'),
			'delft/annotations/l3.geojson': '{"type":"FeatureCollection","features":[]}'
		});
		await checkNow(page);
		await page.getByTestId('update-from-github').click();
		await expect(page.getByTestId('update-outcome')).toContainText('Brought');

		await expect(page.getByTestId('layer-row')).toHaveCount(2);
		await page.getByTestId('add-annotation-layer').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(3);
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		// ⚠ **And an Edit History does not survive an Update** (ADR-0039, story 35). A Step holds the
		// bytes of the files its gesture wrote, so a Step taken before an Update describes files the
		// Update may have replaced — and undoing one would write the pre-Update bytes back over what
		// arrived, which is the same silent loss the re-read above prevents, performed by a button.
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
		await page.getByTestId('update-from-github').click();
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
	test('names what a deletion would take, and takes nothing until it is confirmed', async ({
		page
	}) => {
		// Two Projects both sides hold. The Remote loses one of them entirely.
		const both = { ...ATLAS, ...syncProject('delft', 'Delft') };
		const github = await start(page, {
			workspace: { ...both, ...boundTo() },
			onRemote: both
		});
		await seedBaseline(page, {
			owner: OWNER,
			repository: REPOSITORY,
			files: await sharedShas(both)
		});
		await page.reload();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
		await signIn(page);
		await page.keyboard.press('Escape');
		await expect(remoteStatus(page)).toContainText('Your work is on GitHub');

		await github.commitFiles(OWNER, REPOSITORY, {
			'delft/project.json': null,
			'delft/annotations/l2.geojson': null
		});
		// After the other machine's commit, so what this pins is that *Update* moves nothing.
		const head = github.head(OWNER, REPOSITORY);

		// ── The preview, reached from the control and naming the Project by its own name ──────────
		await page.getByTestId('update-from-github').focus();
		await page.keyboard.press('Enter');
		const dialog = page.getByRole('dialog', {
			name: 'Update will remove work from this Workspace'
		});
		await expect(dialog).toBeVisible();
		await expect(dialog.getByTestId('deletion-preview-projects')).toContainText('Delft');
		await expect(dialog.getByTestId('deletion-preview-message')).toContainText(
			'will remove them from this Workspace'
		);

		// ── Cancel: nothing here, nothing there, and focus back where it came from (story 127) ───
		// Operated from the keyboard, like the control that opened it: a destructive question a scholar
		// can only answer with a pointer is one they cannot decline.
		await dialog.getByTestId('cancel-deletions').focus();
		await page.keyboard.press('Enter');
		await expect(dialog).toBeHidden();
		await expect(page.getByTestId('update-from-github')).toBeFocused();
		await expect(page.getByRole('link', { name: 'Delft' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Atlas 1625' })).toBeVisible();
		// The Remote is untouched by the *asking*, and so is the record of what the two sides shared:
		// the status still reads the drift it read before, rather than agreement it never reached.
		expect(github.head(OWNER, REPOSITORY)).toBe(head);
		await checkNow(page);
		await expect(remoteStatus(page)).toContainText('GitHub has work this Workspace does not');

		// ── Confirm: the Project goes, and the one the Remote kept does not ───────────────────────
		await page.getByTestId('update-from-github').click();
		await expect(dialog).toBeVisible();
		await dialog.getByTestId('confirm-deletions').focus();
		await page.keyboard.press('Enter');

		await expect(page.getByTestId('update-outcome')).toContainText('Removed');
		await expect(page.getByRole('link', { name: 'Delft' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Atlas 1625' })).toBeVisible();
		// And the two sides now agree, which is the whole point of applying a deletion rather than
		// refusing it: a synchronized deletion that did not apply comes back at every status check.
		await expect(remoteStatus(page)).toContainText('Your work is on GitHub');

		// ── An Update whose record cannot be read shuts the Workspace, rather than showing half of
		// one (SPEC story 141). Folded in here rather than given its own test because it needs exactly
		// this Workspace: a marker over real Projects, which is what makes "the list is absent" mean
		// something. The engine's own recovery is asserted per durable boundary at Seam 1.
		await seed(page, { 'update.json': '{ not a marker' });
		await page.reload();

		await expect(page.getByTestId('unrecovered-import')).toBeVisible();
		// Nothing enumerates: no Project list, and the Publish control the bar offers over a Workspace
		// it can read is not there either.
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Atlas 1625' })).toHaveCount(0);
		await expect(page.getByTestId('publish')).toHaveCount(0);
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// IMPORT INTO A BOUND WORKSPACE (ticket 17; SPEC stories 49, 50, 161)
//
// **One workflow, and it is the only place the three halves meet.** The allocation table, the
// own-Remote refusal, the inventory refusal and what each of them leaves behind are exhausted at
// Seam 1 (`project-import-own-remote.test.ts`, `project-import-allocation.test.ts`) against a real
// store and the same fake repository. What only a browser can settle is that the *application* wires
// them together: that the hub's Import asks GitHub what this Workspace's Remote holds before it
// allocates a directory, that the arriving Project registers in the change index the status control
// on the bar reads, and that the ordinary Publish — told nothing about Imports — carries it.
test.describe('Importing a Project into a bound Workspace', () => {
	const MINE = syncProject('delft', 'Delft');
	/**
	 * A Project of this Workspace's own Remote that this installation has never seen.
	 *
	 * ⚠ **Its directory is the slug the incoming Project wants**, and its *name* is not: the display
	 * name is allocated against what this Workspace shows and nothing here shows it, so a suffix on the
	 * directory can only have come from the Remote's listing (SPEC story 161).
	 */
	const ONLY_ON_GITHUB = syncProject('amsterdam-1625', 'Amsterdam 1625, revised');

	test('reserves the Remote’s own directories, and publishes as ordinary local work', async ({
		page
	}) => {
		const github = await start(page, {
			workspace: { ...MINE, ...boundTo() },
			onRemote: { ...MINE, ...ONLY_ON_GITHUB }
		});
		await seedBaseline(page, {
			owner: OWNER,
			repository: REPOSITORY,
			files: await sharedShas(MINE)
		});
		await page.reload();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
		await signIn(page);
		await page.keyboard.press('Escape');

		await page.getByTestId('import-project').click();
		await page
			.getByRole('dialog', { name: 'Import a Project' })
			.getByLabel('Project bundle')
			.setInputFiles(await oneProjectBundle());
		await page.getByTestId('confirm-import').click();

		// The name the bundle carried, because nothing on this screen was called it.
		await expect(page.getByTestId('import-notice')).toContainText('Imported Amsterdam 1625 into');
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();

		// ⚠ **The imported files are local work and nothing else** (SPEC story 49). Nothing was sent and
		// no Baseline was advanced, so the status control — which reads ticket 10's write index — reports
		// local drift over a Remote whose head has not moved. It is `Changes on both sides` rather than
		// `Changes to publish` because the Project this installation had never seen is still inbound
		// work: the Import placed itself around it without adopting it.
		const before = github.head(OWNER, REPOSITORY);
		await checkNow(page);
		await expect(remoteStatus(page)).toContainText('This Workspace and GitHub have both changed');
		expect(github.head(OWNER, REPOSITORY)).toBe(before);

		// Taking that inbound work leaves the Import as the only difference between the two sides, which
		// is what makes the publish below an ordinary one rather than a conflict.
		await page.getByTestId('update-from-github').click();
		await expect(page.getByTestId('update-outcome')).toContainText('Brought');
		await expect(remoteStatus(page)).toContainText('Not all your work is on GitHub yet');

		// ⚠ **And the ordinary Publish carries it, having been told nothing about Imports** (SPEC story
		// 50). Publish owns the whole Workspace namespace, which is why an imported Project needs no
		// outbound route of its own. The directory is the claim: `amsterdam-1625` was free everywhere
		// this browser could see and taken on the Remote, so an Import allocated without that listing
		// would have arrived here as two unrelated Projects at one path.
		await confirm(page, await openPublishDialog(page));
		expect(github.fileText(OWNER, REPOSITORY, 'amsterdam-1625-2/project.json')).toContain(
			'Amsterdam 1625'
		);
		expect(github.fileText(OWNER, REPOSITORY, 'amsterdam-1625/project.json')).toContain(
			'Amsterdam 1625, revised'
		);
		expect(github.fileText(OWNER, REPOSITORY, 'delft/project.json')).toContain('Delft');
		// ⚠ **And there is still exactly one Remote relationship, at the Workspace** (SPEC story 51).
		// An imported Project gets no binding, no Baseline and no Publish action of its own, so the
		// published tree carries one `remote.json` rather than one per Project.
		expect(github.files(OWNER, REPOSITORY).filter((path) => path.endsWith('remote.json'))).toEqual([
			'remote.json'
		]);
		await expect(remoteStatus(page)).toContainText('Your work is on GitHub');
	});
});
