import { expect, test, type Page } from './support/test.js';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { routeGitHubHosts, type GitHubHosts } from './support/github-hosts.js';
import { openRemoteSettings } from './support/workspace.js';

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

/** Sign in from the publish dialog itself, which is the bound-with-no-credential state. */
async function signIn(page: Page) {
	const dialog = await openPublishDialog(page);
	await dialog.getByTestId('publish-token-field').fill(TOKEN);
	await dialog.getByTestId('publish-sign-in').click();
	return dialog;
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
		await page.getByTestId('remote-token-field').fill(TOKEN);
		await page.getByTestId('bind-remote').click();
	}

	test('is refused, names the Project, and points at Clone', async ({ page }) => {
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
		await expect(problem).toContainText(`Clone ${REMOTE}`);
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
			// a Clone, a second machine, or storage cleared since. All three look the same from here.
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
		await expect(refusal).toHaveAttribute('data-conflict', 'unknown');
		await expect(refusal).toContainText('nothing here can tell');
		// Said as the ordinary state it is: every Workspace cloned from a Remote is in it until it has
		// published once, and a scholar meeting an alarm on the first press learns to force (story 24).
		await expect(refusal).toContainText('not a sign that anything has gone wrong');
		await expect(refusal).toContainText(`Clone ${REMOTE}`);

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
	// complete Clone, which is story 24 itself.
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
		await expect(refusal).toHaveAttribute('data-conflict', 'changed');
		await expect(refusal).toContainText('amsterdam-1625/annotations/l2.geojson');
		// Both remedies, on the one screen: the clone, and the replace.
		await expect(refusal).toContainText(`Clone ${REMOTE}`);
		await expect(dialog.getByTestId('publish-replace')).toBeVisible();
		// ⚠ **And the three budgets beside it, not instead of it.** A conflict is where the replacement
		// tree is largest and where the scholar is being asked to press through a warning, so it is the
		// worst state in this dialog to be the one that hides story 9's two numbers.
		await expect(dialog.getByTestId('publish-budget')).toBeVisible();

		// Taking the second one is two presses, the shape every irreversible action here has — and the
		// confirm button then says what pressing it does rather than "Publish".
		await dialog.getByTestId('publish-replace').click();
		await expect(
			dialog.getByRole('button', { name: 'Publish anyway, replacing it' })
		).toBeVisible();
		await confirm(page, dialog);

		expect(github.fileText(OWNER, REPOSITORY, 'amsterdam-1625/annotations/l2.geojson')).toBe(
			'{"type":"FeatureCollection","features":[]}'
		);
		// Replacing is still ADR-0033's mirror: the scholar's own `README.md` is outside the owned
		// namespace and survives a replace exactly as it survives an ordinary publish.
		expect(github.fileText(OWNER, REPOSITORY, 'README.md')).toBe('# Atlas\n');
	});
});
