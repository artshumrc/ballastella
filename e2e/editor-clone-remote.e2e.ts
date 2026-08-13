import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { routeGitHubHosts } from './support/github-hosts.js';
import { expectWorkspaceNamed, openWorkspaceMenu, switchToWorkspace } from './support/workspace';

/**
 * Cloning a Workspace out of a public repository (ticket 07, ADR-0031, ADR-0032).
 *
 * SPEC's Seam 2. The engine — the tree listing, the skip-by-blob-SHA resume, the refusals and their
 * sentences — is asserted at Seam 1 in `clone-from-remote.test.ts`, where the assertion is the bytes
 * that arrived and the fake's own request counters rather than a screen. What only a browser can
 * show is here:
 *
 *   - a repository name typed into the editor becomes a **new named Workspace** that the app
 *     switches to, with the Workspace it came from left exactly as it was;
 *   - the Project in it lists on the hub, opens, and draws — so the Historical Map, the Alignment
 *     and the Annotations all really landed, in a store the app reads through its own code;
 *   - only the **owned namespace** arrives, so the publisher's `README.md`, `CNAME` and workflow do
 *     not become the cloner's own content and are not published as theirs later (ADR-0033);
 *   - the result is **bound**, which the bar and `remote.json` both say;
 *   - none of it needs a credential, and none is sent — asserted against a GitHub that answers 401
 *     to anything carrying one;
 *   - **nothing reaches `codeload.github.com`**, because the network fence blocks every host
 *     `github-hosts` does not route and it deliberately routes only two.
 *
 * ⚠ **Resume is asserted at Seam 1 and not here, on purpose.** Skipping a file that is already on
 * disk is invisible in the result — a Clone that re-downloaded everything and wrote the same bytes
 * back leaves a byte-identical Workspace — so the only assertion worth making is on the request
 * counter, and reaching a *partly* filled Workspace needs a destination this screen does not offer:
 * every Clone from here creates a new Workspace, which is what the name-collision rule below
 * requires. `clone-from-remote.test.ts` drives the same fake with a partial destination and asserts
 * `rawGets` directly.
 */

const HUB = './';

const OWNER = 'ada';
const REPOSITORY = 'atlas';
const REMOTE = `${OWNER}/${REPOSITORY}`;

/**
 * A Project as a publish leaves it on the Remote.
 *
 * A map Layer and an annotation Layer, so `images/`, `alignments/` and the Project's own
 * `annotations/` are all really carried — without them the assertion that a cloned Project "opens
 * and renders" would be an assertion about a Project with nothing in it.
 */
const PROJECT_JSON = `${JSON.stringify(
	{
		formatVersion: 1,
		name: 'Amsterdam 1625',
		updatedAt: '2025-03-04T11:22:33.000Z',
		layers: [
			{
				id: 'l1',
				kind: 'annotation',
				name: 'Warehouses',
				visible: true,
				order: 0,
				geojsonRef: 'annotations/warehouses.geojson',
				defaultStyle: {}
			},
			{
				id: 'l2',
				kind: 'map',
				name: 'The 1625 plan',
				visible: true,
				order: 1,
				opacity: 1,
				imageId: 'amsterdam-1625'
			}
		],
		baseMap: null
	},
	null,
	'\t'
)}\n`;

const WAREHOUSES = '{"type":"FeatureCollection","features":[]}';

/**
 * What the publisher's repository holds that is **not** the Workspace (ADR-0033).
 *
 * The scholar's own work on their own repository: the address they cite in print, the licence, the
 * workflow that deploys their site. A publish leaves every one of them alone and so does a Clone —
 * anything downloaded becomes the cloner's Workspace content, and their first publish would push it
 * into their own repository as though they had written it (SPEC story 17).
 */
const OUTSIDE_NAMESPACE = ['README.md', 'CNAME', 'LICENSE', '.github/workflows/pages.yml'];

/**
 * The whole repository, as a publish leaves it.
 *
 * `remote.json` names a **different** repository, as a fork's published binding would, so a Clone
 * that copied it down rather than writing its own would be caught by the binding assertions below.
 */
const PUBLISHED: Record<string, string> = {
	'.nojekyll': '',
	'index.html': '<!doctype html><title>Atlas</title>',
	'remote.json': JSON.stringify({ formatVersion: 1, owner: 'someone-else', repository: 'fork' }),
	'amsterdam-1625/project.json': PROJECT_JSON,
	'amsterdam-1625/annotations/warehouses.geojson': WAREHOUSES,
	// alignment-write-is-the-fixture: the Alignment as it sits on the Remote, seeded into the fake GitHub rather than into any Workspace — the Clone under test is what writes it, through `writeAlignmentBytes`
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'stands in for a tile',
	...Object.fromEntries(OUTSIDE_NAMESPACE.map((path) => [path, `${path}, the scholar's own\n`]))
};

/** Everything a Clone brings down: the owned namespace, less the binding it writes for itself. */
const DOWNLOADED = Object.keys(PUBLISHED).filter(
	(path) => path !== 'remote.json' && !OUTSIDE_NAMESPACE.includes(path)
);

// The hub draws a Base Map from an archive on somebody else's host, and every spec here is behind
// the default-deny network fence. On the `context`, so a request through a service worker is covered.
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
	});
}

/** Start on a clean hub, with one public repository holding a published Workspace. */
async function start(page: Page, repository: Record<string, unknown> = {}) {
	const github = await routeGitHubHosts(page, {
		repositories: [{ owner: OWNER, name: REPOSITORY, files: PUBLISHED, ...repository }]
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

/** Fill the Clone form and press the button. Does not assert the outcome — each test says its own. */
async function clone(page: Page, repository = REMOTE): Promise<void> {
	await openRemoteSettings(page);
	await page.getByTestId('clone-repository-field').fill(repository);
	await page.getByTestId('clone-remote').click();
}

const outcome = (page: Page) => page.getByTestId('remote-outcome');
const problem = (page: Page) => page.getByTestId('remote-problem');

/** Every file in a named Workspace, read behind the app's back. */
async function everyByteOf(page: Page, workspace: string): Promise<Record<string, string>> {
	return page.evaluate(async (name) => {
		const found: Record<string, string> = {};
		const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
			for await (const [entry, child] of handle.entries()) {
				if (child.kind === 'directory') {
					await walk(child as FileSystemDirectoryHandle, `${prefix}${entry}/`);
					continue;
				}
				found[`${prefix}${entry}`] = await (await (child as FileSystemFileHandle).getFile()).text();
			}
		};
		try {
			await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(name), '');
		} catch {
			return {};
		}
		return found;
	}, workspace);
}

/** Every named Workspace in browser storage. */
async function workspaceNames(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const names: string[] = [];
		for await (const [name, handle] of (await navigator.storage.getDirectory()).entries()) {
			if (handle.kind === 'directory') names.push(name);
		}
		return names.sort();
	});
}

test.describe('cloning a published Workspace', () => {
	test('makes a new Workspace, fills it, and switches to it', async ({ page }) => {
		await start(page);

		await clone(page);

		await expect(outcome(page)).toContainText(`Cloned ${REMOTE}`);
		await expect(outcome(page)).toContainText('“atlas”');
		await page.getByTestId('close-remote-settings').click();

		// Switched to, which the bar is the one place that says.
		await expectWorkspaceNamed(page, 'atlas');
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE, 'atlas']);

		const stored = await everyByteOf(page, 'atlas');
		// The owned namespace, plus the binding this Clone wrote — and nothing of the publisher's own.
		expect(Object.keys(stored).sort()).toEqual([...DOWNLOADED, 'remote.json'].sort());
		for (const path of OUTSIDE_NAMESPACE) expect(Object.keys(stored)).not.toContain(path);
		expect(stored['images/amsterdam-1625/info.json']).toBe('{"width":4096,"height":3072}');
		expect(stored['alignments/amsterdam-1625.json']).toBe(
			'{"type":"Annotation","id":"amsterdam-1625"}'
		);
		expect(stored['amsterdam-1625/annotations/warehouses.geojson']).toBe(WAREHOUSES);
	});

	test('the cloned Project lists on the hub, opens, and draws', async ({ page }) => {
		// The Workspace read back through the app's own code rather than through `getFileHandle`: a
		// Project that lists, opens and renders is what "the Alignments and Annotations are readable"
		// actually means to a scholar.
		await start(page);

		await clone(page);
		await expect(outcome(page)).toContainText('Cloned');
		await page.getByTestId('close-remote-settings').click();

		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();

		await expect(page).toHaveURL(/\?p=amsterdam-1625$/);
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		await expect(page.getByTestId('project-screen')).toBeVisible();
		// Both Layers, so the map Layer's Historical Map and the annotation Layer's document both
		// survived the round trip through GitHub. Read off the Layer list rather than by text: each
		// name is also on that Layer's own Open button, and `getByText` matches both.
		// In the Project's own Layer order, top first, which is the order the file declares.
		await expect(page.getByTestId('layer-name-text')).toHaveText(['Warehouses', 'The 1625 plan']);
	});

	test('binds the result to the repository it came from', async ({ page }) => {
		await start(page);

		await clone(page);
		await expect(outcome(page)).toContainText('Cloned');
		await page.getByTestId('close-remote-settings').click();
		await expectWorkspaceNamed(page, 'atlas');

		// The binding as the app reads it, in the dialog that reports where a Workspace publishes.
		await openRemoteSettings(page);
		await expect(page.getByTestId('bound-remote')).toHaveText(REMOTE);
		await page.getByTestId('close-remote-settings').click();

		// ⚠ And on disk, naming the repository the user typed rather than the `someone-else/fork` the
		// published tree carried. A Clone writes its own binding; it never copies the one it downloads.
		const stored = await everyByteOf(page, 'atlas');
		expect(JSON.parse(stored['remote.json'] ?? '{}')).toMatchObject({
			owner: OWNER,
			repository: REPOSITORY,
			branch: 'main'
		});
	});

	test('needs no credential, and sends none', async ({ page }) => {
		// ⚠ **The criterion, pinned rather than assumed.** `rejectCredential` answers 401 to every
		// request *carrying* a token and leaves anonymous ones alone, exactly as the real API does for
		// a public repository — so a Clone that attached an `Authorization` header anywhere would fail
		// here. Nothing signs in first, which is the point: a student with no GitHub account.
		const github = await routeGitHubHosts(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY, files: PUBLISHED }],
			rejectCredential: true
		});
		await page.goto(HUB);
		await emptyBrowserStorage(page);
		await page.reload();

		await clone(page);

		await expect(outcome(page)).toContainText('Cloned');
		// Still signed out afterwards: cloning neither needs nor acquires a credential.
		await expect(page.getByTestId('remote-signed-in')).toHaveCount(0);
		// Indexed rather than `toHaveProperty`, which reads a dot in the key as a path separator.
		const stored = await everyByteOf(page, 'atlas');
		expect(stored['images/amsterdam-1625/info.json']).toBe('{"width":4096,"height":3072}');
		expect(github.rawGets(OWNER, REPOSITORY)).toBe(DOWNLOADED.length);
	});

	test('reads bytes only from the raw host, and never from codeload', async ({ page }) => {
		// ADR-0031: `codeload.github.com` answers a *specific* `access-control-allow-origin`, so a
		// browser fetch of the tarball is blocked. `github-hosts` routes exactly two hosts, and the
		// default-deny fence aborts everything else — so a Clone that reached for the tarball would
		// fail outright here rather than at a scholar's machine.
		const github = await start(page);

		await clone(page);
		await expect(outcome(page)).toContainText('Cloned');

		// One request per file, from the raw host, and the file list from exactly one API call.
		expect(github.rawGets(OWNER, REPOSITORY)).toBe(DOWNLOADED.length);
		expect(github.rawRequests).toHaveLength(DOWNLOADED.length);
		expect(github.requests).toEqual([`/repos/${OWNER}/${REPOSITORY}/git/trees/main`]);
		expect(github.requests.some((path) => path.includes('tarball'))).toBe(false);
	});

	test('reports per-file progress while it runs', async ({ page }) => {
		await start(page);

		await openRemoteSettings(page);
		await page.getByTestId('clone-repository-field').fill(REMOTE);
		await page.getByTestId('clone-remote').click();

		// `role="status"`, so it reaches assistive technology rather than only the screen. Raced
		// against a Clone of eight files, so the assertion is that it appears and counts rather than
		// that it stops on a particular number.
		const progress = page.getByTestId('clone-progress');
		await expect(progress).toContainText(
			`of ${DOWNLOADED.length} files downloaded from ${REMOTE}`,
			{
				timeout: 10_000
			}
		);
		await expect(progress).toHaveAttribute('role', 'status');

		await expect(outcome(page)).toContainText('Cloned');
	});
});

test.describe('what a Clone never does', () => {
	test('leaves the Workspace it was started from exactly as it was', async ({ page }) => {
		// ADR-0024's rule: never merges, never overwrites. The Workspace of the user's own holds a
		// Project of the same name and the same directory as the Remote's, which is the collision a
		// merge would produce.
		await start(page);
		await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const workspace = await root.getDirectoryHandle('My Workspace', { create: true });
			const project = await workspace.getDirectoryHandle('amsterdam-1625', { create: true });
			const file = await project.getFileHandle('project.json', { create: true });
			const writable = await file.createWritable();
			await writable.write(
				JSON.stringify({
					formatVersion: 1,
					name: 'My own Amsterdam',
					updatedAt: '2025-01-01T00:00:00.000Z',
					layers: [],
					baseMap: null
				})
			);
			await writable.close();
		});
		await page.reload();

		await clone(page);
		await expect(outcome(page)).toContainText('Cloned');

		const mine = await everyByteOf(page, DEFAULT_WORKSPACE);
		expect(Object.keys(mine)).toEqual(['amsterdam-1625/project.json']);
		expect(mine['amsterdam-1625/project.json']).toContain('My own Amsterdam');
		// And nothing of the Remote's leaked into it — no binding, no pyramid. Indexed rather than
		// `toHaveProperty`, which reads the dot in the key as a path separator.
		expect(mine['remote.json']).toBeUndefined();
	});

	test('goes on saying what it did after the dialog is closed and the Workspace changed', async ({
		page
	}) => {
		// The dialog is mounted for the page's life, so nothing but this clears what it last said —
		// and “Cloned ada/atlas into a new Workspace called “atlas”” read as a report about whatever
		// Workspace the user had moved to by the time they opened it again.
		await start(page);

		await clone(page);
		await expect(outcome(page)).toContainText('Cloned');
		await page.getByTestId('close-remote-settings').click();
		await switchToWorkspace(page, DEFAULT_WORKSPACE);

		await openRemoteSettings(page);
		await expect(outcome(page)).toHaveText('');
		await expect(problem(page)).toHaveCount(0);
		await page.getByTestId('close-remote-settings').click();

		// The refusal too, which is the half a stale reading of would send somebody chasing a fault
		// that has already been fixed.
		await clone(page, 'not a repository');
		await expect(problem(page)).toBeVisible();
		await page.getByTestId('close-remote-settings').click();
		await openRemoteSettings(page);
		await expect(problem(page)).toHaveCount(0);
	});

	test('a second Clone of the same repository gets its own name, not the first one', async ({
		page
	}) => {
		// Suffixed rather than refused, and above all rather than written into: cloning the same
		// repository twice to compare a colleague's published work against your own copy of it is a
		// thing people do, and the second must not overwrite the first.
		await start(page);

		await clone(page);
		await expect(outcome(page)).toContainText('“atlas”');
		await page.getByTestId('close-remote-settings').click();

		await clone(page);
		await expect(outcome(page)).toContainText('“atlas (2)”');
		await page.getByTestId('close-remote-settings').click();

		await expectWorkspaceNamed(page, 'atlas (2)');
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE, 'atlas', 'atlas (2)']);
		// Both are whole, which is what "not overwriting" has to mean.
		expect(Object.keys(await everyByteOf(page, 'atlas'))).toHaveLength(DOWNLOADED.length + 1);
		expect(Object.keys(await everyByteOf(page, 'atlas (2)'))).toHaveLength(DOWNLOADED.length + 1);
	});
});

/**
 * A Reader who followed "Open this Workspace in Ballastella" off a Published Site's Front Page
 * (ticket 09; SPEC stories 49 and 51).
 *
 * ⚠ **The offer is the behaviour under test, not the Clone.** A URL is a thing anyone can send, and
 * one that silently created a Workspace and switched to it would let a link rearrange a stranger's
 * editor — so what is asserted here is that landing changes nothing at all, that a press is what
 * runs ticket 07's Clone, and that the parameter does not survive to be replayed by a reload.
 *
 * The *link* — its wording, its address, and both base paths it has to work at — is the viewer's
 * half, asserted in `viewer-reader.e2e.ts` against a real Published Site.
 */
test.describe('arriving on a link from a Published Site', () => {
	const offer = (page: Page) => page.getByTestId('return-link-offer');
	const accept = (page: Page) => page.getByTestId('accept-return-link');

	test('offers a Clone, and has done nothing until it is confirmed', async ({ page }) => {
		await start(page);

		await page.goto(`${HUB}?clone=${REMOTE}`);

		await expect(offer(page)).toContainText(REMOTE);
		await expect(accept(page)).toBeVisible();
		// Nothing is running, and nothing has arrived: the visitor is in the Workspace they already
		// had, and it is the only one.
		await expect(page.getByTestId('return-link-progress')).toHaveCount(0);
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});

	test('confirming runs the Clone, and switches to what it made', async ({ page }) => {
		await start(page);
		await page.goto(`${HUB}?clone=${REMOTE}`);

		await accept(page).click();

		await expect(page.getByTestId('return-link-outcome')).toContainText(`Cloned ${REMOTE}`);
		await expectWorkspaceNamed(page, 'atlas');
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE, 'atlas']);
		// The same Workspace the dialog's Clone produces, asserted on what arrived rather than on the
		// sentence: the owned namespace plus the binding the Clone wrote for itself.
		const stored = await everyByteOf(page, 'atlas');
		expect(Object.keys(stored).sort()).toEqual([...DOWNLOADED, 'remote.json'].sort());
	});

	test('takes the parameter off the address, so a reload does not offer again', async ({
		page
	}) => {
		await start(page);

		await page.goto(`${HUB}?clone=${REMOTE}`);
		await expect(offer(page)).toBeVisible();

		expect(new URL(page.url()).searchParams.get('clone')).toBeNull();
		await page.reload();
		await expect(page.getByRole('heading', { name: 'Ballastella Editor' })).toBeVisible();
		await expect(offer(page)).toHaveCount(0);
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});

	test('can be turned down, and turning it down downloads nothing', async ({ page }) => {
		await start(page);
		await page.goto(`${HUB}?clone=${REMOTE}`);

		await page.getByTestId('dismiss-return-link').click();

		await expect(offer(page)).toHaveCount(0);
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});

	// ⚠ Both halves of the reference are interpolated into a GitHub API path, and `ada/../../orgs`
	// retargets every request the engine makes. A link nobody in this repository wrote offers nothing
	// at all rather than being repaired into something.
	//
	// ⚠ **And it comes off the address anyway.** A parameter that raised no offer is still one a
	// reload replays, a bookmark keeps, and whoever copies the address passes on — which is the whole
	// reason the good ones are stripped. Refusing it on screen and leaving it in the bar would make
	// the invariant hold only for links that parsed.
	test('offers nothing for a link that does not name a repository, and keeps none of it', async ({
		page
	}) => {
		await start(page);

		for (const reference of ['ada', 'ada/../../orgs', 'ada atlas']) {
			await page.goto(`${HUB}?clone=${encodeURIComponent(reference)}`);
			await expect(page.getByRole('heading', { name: 'Ballastella Editor' })).toBeVisible();
			await expect(offer(page)).toHaveCount(0);
			await expect
				.poll(() => new URL(page.url()).searchParams.get('clone'), {
					message: `?clone=${reference} left in the address bar`
				})
				.toBeNull();
		}
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});
});

test.describe('refusals, all before a byte is written', () => {
	test('a truncated file list, with no Workspace made at all', async ({ page }) => {
		// ⚠ A truncated listing answers **200**, so nothing throws anywhere. Proceeding would hand the
		// user a Workspace with most of a pyramid silently missing — ticket 02's failure arriving from
		// the other direction.
		const github = await start(page, { truncateAfter: 3 });

		await clone(page);

		await expect(problem(page)).toContainText('silently missing');
		await expect(problem(page)).toContainText('Nothing has been downloaded.');
		// Not one byte asked for, and no Workspace to leave behind.
		expect(github.rawGets(OWNER, REPOSITORY)).toBe(0);
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});

	test('not enough room, named in bytes, with no Workspace made at all', async ({ page }) => {
		// The quota is scripted because no automated browser can be made genuinely full; what is
		// asserted is the app's sequencing rather than Chromium's accounting (ADR-0024).
		const github = await start(page);
		await page.addInitScript(() => {
			navigator.storage.estimate = async () => ({ quota: 1_000_128, usage: 1_000_000 });
		});
		await page.reload();

		await clone(page);

		await expect(problem(page)).toContainText('needs about');
		await expect(problem(page)).toContainText('free');
		await expect(problem(page)).toContainText('already in use');
		expect(github.rawGets(OWNER, REPOSITORY)).toBe(0);
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});

	test('a repository nobody can read anonymously', async ({ page }) => {
		await start(page);

		await clone(page, `${OWNER}/not-published`);

		// A private repository and a missing one are one answer to an anonymous reader, and the
		// sentence says so rather than asserting the first of the two.
		await expect(problem(page)).toContainText('no public repository');
		await expect(problem(page)).toContainText('private');
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});

	test('something that is not a repository address at all', async ({ page }) => {
		await start(page);

		await clone(page, 'https://example.com/not/a/repo');

		await expect(problem(page)).toContainText('is not a repository address');
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});
});
