import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { routeGitHubHosts } from './support/github-hosts.js';
import {
	closeTheDoor,
	closeWorkspaceDialog,
	expectRemoteNamed,
	expectWorkspaceNamed,
	openRepositorySettings,
	openTheDoor,
	readBaseline,
	readRemoteRelationship
} from './support/workspace';

/**
 * Getting a Workspace from a repository: connect, then get (ADR-0031, ADR-0044).
 *
 * Seam 2. **There is no separate act that opens a Workspace from a repository, because Sync is that
 * act.** Make a Workspace, connect it, get — so what this spec drives is the address typed into the
 * guided sequence, the connection it makes, and the Sync modal that connection hands off to.
 *
 * The transfer itself — the tree listing, the skip-by-blob-SHA resume, the refusals and their
 * sentences — is asserted at Seam 1 in `update-from-github.test.ts`, and what a connection records
 * in `bind-remote.test.ts` and `synchronization-metadata.test.ts`. All of them assert bytes and
 * records rather than a screen. What only a browser can show is here:
 *
 *   - a repository address typed into the editor connects **this** Workspace, and getting fills it;
 *   - the Project that arrives lists on the hub, opens, and draws — so the Map Image, the Alignment
 *     and the Annotations all really landed, in a store the app reads through its own code;
 *   - only the **owned namespace** arrives, so the publisher's `README.md`, `CNAME` and workflow do
 *     not become this author's own content and are not sent as theirs later (ADR-0033);
 *   - the result is bound with a Baseline, and bound to the repository the *author* typed rather
 *     than to the one the published tree names;
 *   - **none of it needs a credential, and none is sent** — asserted against a GitHub that answers
 *     401 to anything carrying one. That is the whole property: a student with no GitHub account
 *     seeding a Workspace from their instructor's repository;
 *   - **nothing reaches `codeload.github.com`**, because the network fence blocks every host
 *     `github-hosts` does not route and it deliberately routes only two.
 *
 * ⚠ **Resume is asserted at Seam 1 and not here, on purpose.** Skipping a file that is already on
 * disk is invisible in the result — a retry that re-downloaded everything and wrote the same bytes
 * back leaves a byte-identical Workspace — so the only assertion worth making is on the request
 * counter, which `update-from-github.test.ts` makes directly.
 *
 * ⚠ **The shipped `?clone=owner/repository` invitation parameter is kept exactly as it is**, because
 * old Published Sites carry it and a link already given out has to go on working. Only what the
 * editor *does* about it changed: it makes a Workspace, connects it, and lands on what there is to
 * get.
 */

const HUB = './';

const OWNER = 'ada';
const REPOSITORY = 'atlas';
const REMOTE = `${OWNER}/${REPOSITORY}`;

/**
 * A Project as a publish leaves it on the Remote.
 *
 * A map Layer and an annotation Layer, so `images/`, `alignments/` and the Project's own
 * `annotations/` are all really carried — without them the assertion that an opened Project "opens
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
 * workflow that deploys their site. A publish leaves every one of them alone and so does an Open —
 * anything downloaded becomes the opener's Workspace content, and their first publish would push it
 * into their own repository as though they had written it.
 */
const OUTSIDE_NAMESPACE = ['README.md', 'CNAME', 'LICENSE', '.github/workflows/pages.yml'];

/**
 * The whole repository, as a publish leaves it.
 *
 * `ballastella-site.json` records **somebody else's** repository, as a fork's published site would,
 * so an Open that read the relationship off the wire instead of out of what the author typed would be
 * caught by the assertions below.
 */
const PUBLISHED: Record<string, string> = {
	'.nojekyll': '',
	'index.html': '<!doctype html><title>Atlas</title>',
	'ballastella-site.json': JSON.stringify({
		formatVersion: 2,
		projects: [],
		repository: { owner: 'someone-else', repository: 'fork', branch: 'main' }
	}),
	'amsterdam-1625/project.json': PROJECT_JSON,
	'amsterdam-1625/annotations/warehouses.geojson': WAREHOUSES,
	// alignment-write-is-the-fixture: the Alignment as it sits on the Remote, seeded into the fake GitHub rather than into any Workspace — the Open under test is what writes it, through `writeAlignmentBytes`
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'stands in for a tile',
	...Object.fromEntries(OUTSIDE_NAMESPACE.map((path) => [path, `${path}, the scholar's own\n`]))
};

/**
 * Everything a get brings down: the **source** namespace, and nothing else.
 *
 * ⚠ **The generated site is not got, and its absence here is the assertion.** Generated site output
 * is inside the owned namespace only where the Workspace has Share Links (ADR-0045), and a Workspace
 * that has just connected has none — so `index.html`, `.nojekyll` and the site record are neither
 * fetched nor a difference. What arrives is the scholar's own files.
 *
 * Nothing writes the relationship into the Workspace either. It is installation-local (ADR-0044), so
 * a partly-filled directory cannot look like synchronized work.
 */
const GENERATED = ['.nojekyll', 'index.html', 'ballastella-site.json'];
const DOWNLOADED = Object.keys(PUBLISHED).filter(
	(path) => !OUTSIDE_NAMESPACE.includes(path) && !GENERATED.includes(path)
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
		// **And the installation database** (ADR-0038), which is where the Remote relationship and the
		// Synchronization Baseline now live. Left behind, the reverse lookup in the next scenario would
		// find the previous one's Workspace and select a directory that is no longer there.
		await new Promise<void>((resolve) => {
			const request = indexedDB.deleteDatabase('ballastella');
			request.onsuccess = () => resolve();
			request.onerror = () => resolve();
			request.onblocked = () => resolve();
		});
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

/**
 * Type an address into the guided sequence and confirm what GitHub says it means.
 *
 * ⚠ **The address is in front of the sign-in rather than behind it** (ADR-0044): connecting to a
 * public repository needs no account, and a student getting their instructor's Workspace is the
 * likeliest thing this tool is asked to do. It is resolved to a repository first and **confirmed**
 * before the connection is made, because an ambiguous Pages address has two real answers.
 *
 * Leaves whatever the confirmation produced on screen — the Sync modal for a connection, the
 * refusal inside the sequence for anything else.
 */
async function connectByAddress(page: Page, repository = REMOTE): Promise<void> {
	await openTheDoor(page);
	await page.getByTestId('open-by-address').click();
	await page.getByTestId('workspace-address-field').fill(repository);
	await page.getByTestId('find-workspace-address').click();
	// ⚠ **Waited for by *either* answer**, because the probe is a request: a bare count of the refusal
	// races the render and reads "no refusal" out of the frame before GitHub has replied.
	await expect(
		page.getByTestId('resolved-address').or(page.getByTestId('workspace-address-refused'))
	).toBeVisible({ timeout: 30_000 });
	if ((await page.getByTestId('workspace-address-refused').count()) > 0) return;
	await page.getByTestId('open-resolved-address').click();
	await expect(page.getByTestId('sync-modal')).toBeVisible({ timeout: 30_000 });
}

/**
 * Answer the Sync modal the connection handed off to: get, and nothing else.
 *
 * ⚠ **Signed out, and *Get changes* is the one control on it that is not about sending.** The modal
 * plans both sides anonymously, so a student with no GitHub account reads what is there and presses
 * this — which is the whole of what this spec exists to prove is reachable.
 */
async function getEverything(page: Page): Promise<void> {
	const dialog = page.getByRole('dialog', { name: 'Sync with GitHub' });
	// The four choices appear with the plan, and *Get changes* is the one a signed-out author has.
	// The three budgets are not waited for: they are about a send, so they are not on this screen.
	await expect(dialog.getByTestId('sync-get')).toBeVisible({ timeout: 60_000 });
	await dialog.getByTestId('sync-get').click();
	await expect(page.getByTestId('sync-modal')).toBeHidden({ timeout: 120_000 });
}

/** Connect by address and get, which is the whole of getting a Workspace from a repository. */
async function connectAndGet(page: Page, repository = REMOTE): Promise<void> {
	await connectByAddress(page, repository);
	await getEverything(page);
}

/** What a get left behind, on the bar, once the modal has closed. */
const outcome = (page: Page) => page.getByTestId('sync-status');
/** What it says when it counted files in. */
const BROUGHT_IN = `Brought in ${DOWNLOADED.length} new files`;
/** What a pasted address that names no repository at all is refused with. */
const addressRefusal = (page: Page) => page.getByTestId('workspace-address-refused');

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

test.describe('connecting to a public repository, and getting from it', () => {
	test('fills the Workspace with the owned namespace and nothing else', async ({ page }) => {
		await start(page);

		await connectAndGet(page);

		await expect(outcome(page)).toContainText(BROUGHT_IN, { timeout: 60_000 });
		await expectRemoteNamed(page, REMOTE);
		// The Workspace the author was already in, which is the one they connected.
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);

		const stored = await everyByteOf(page, DEFAULT_WORKSPACE);
		// The owned namespace and nothing else: not the publisher's own files, and nothing describing
		// which repository this Workspace belongs to — that is installation-local (ADR-0044).
		expect(Object.keys(stored).sort()).toEqual([...DOWNLOADED].sort());
		for (const path of [...OUTSIDE_NAMESPACE, ...GENERATED]) {
			expect(Object.keys(stored)).not.toContain(path);
		}
		expect(stored['images/amsterdam-1625/info.json']).toBe('{"width":4096,"height":3072}');
		expect(stored['alignments/amsterdam-1625.json']).toBe(
			'{"type":"Annotation","id":"amsterdam-1625"}'
		);
		expect(stored['amsterdam-1625/annotations/warehouses.geojson']).toBe(WAREHOUSES);
	});

	test('the Project that arrives lists on the hub, opens, and draws', async ({ page }) => {
		// The Workspace read back through the app's own code rather than through `getFileHandle`: a
		// Project that lists, opens and renders is what "the Alignments and Annotations are readable"
		// actually means to a scholar.
		await start(page);

		await connectAndGet(page);
		await expect(outcome(page)).toContainText(BROUGHT_IN, { timeout: 60_000 });

		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();

		await expect(page).toHaveURL(/\?p=amsterdam-1625$/);
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		await expect(page.getByTestId('project-screen')).toBeVisible();
		// Both Layers, so the map Layer's Map Image and the annotation Layer's document both
		// survived the round trip through GitHub. Read off the Layer list rather than by text: each
		// name is also on that Layer's own Open button, and `getByText` matches both.
		// In the Project's own Layer order, top first, which is the order the file declares.
		await expect(page.getByTestId('layer-name-text')).toHaveText(['Warehouses', 'The 1625 plan']);
	});

	test('records the repository the author typed, and a Baseline', async ({ page }) => {
		// ⚠ **The published tree's site record names `someone-else/fork`**, as a fork's would. Read as
		// the relationship it would aim this author's Sync at a repository they have never seen — so
		// what is recorded is the repository they typed and nothing else (ADR-0044).
		await start(page);

		await connectAndGet(page);
		await expect(outcome(page)).toContainText(BROUGHT_IN, { timeout: 60_000 });

		// The Remote and the Baseline as the app reads them: the bar names the repository, and the
		// Workspace's own row carries the evidence behind the badge (ADR-0042).
		await expectRemoteNamed(page, REMOTE);
		await openRepositorySettings(page);
		await expect(page.getByTestId('remote-baseline')).toContainText(`last agreed with ${REMOTE}`);
		await expect(page.getByTestId('remote-baseline')).not.toContainText('Cannot tell');
		await closeWorkspaceDialog(page);

		// ⚠ And in the installation database, behind the app's back — the point of ADR-0044 is that
		// this evidence is *outside* the Workspace, so it cannot travel in a Backup or up to a Remote.
		expect(await readRemoteRelationship(page, DEFAULT_WORKSPACE)).toMatchObject({
			owner: OWNER,
			repository: REPOSITORY,
			branch: 'main'
		});
		const baseline = await readBaseline(page, DEFAULT_WORKSPACE);
		expect(baseline).not.toBeNull();
		expect(baseline?.commit).not.toBe('');
		// Source only: the Baseline describes scholarship, never the viewer a Sync generated.
		expect(baseline?.files).toContain('images/amsterdam-1625/info.json');
		expect(baseline?.files).not.toContain('index.html');
		// And nothing of `someone-else/fork` reached the record this installation acts on.
		expect(await readRemoteRelationship(page, DEFAULT_WORKSPACE)).not.toMatchObject({
			repository: 'fork'
		});
	});

	test('needs no credential, and sends none', async ({ page }) => {
		// ⚠ **The criterion, pinned rather than assumed.** `rejectCredential` answers 401 to every
		// request *carrying* a token and leaves anonymous ones alone, exactly as the real API does for
		// a public repository — so a connection or a get that attached an `Authorization` header
		// anywhere would fail here. Nothing signs in: a student with no GitHub account.
		const github = await routeGitHubHosts(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY, files: PUBLISHED }],
			rejectCredential: true
		});
		await page.goto(HUB);
		await emptyBrowserStorage(page);
		await page.reload();

		await connectAndGet(page);

		await expect(outcome(page)).toContainText(BROUGHT_IN, { timeout: 60_000 });
		// Still signed out afterwards: this neither needs nor acquires a credential.
		await openTheDoor(page);
		await expect(page.getByTestId('connect-signed-in')).toHaveCount(0);
		await closeTheDoor(page);
		// Indexed rather than `toHaveProperty`, which reads a dot in the key as a path separator.
		const stored = await everyByteOf(page, DEFAULT_WORKSPACE);
		expect(stored['images/amsterdam-1625/info.json']).toBe('{"width":4096,"height":3072}');
		expect(github.rawGets(OWNER, REPOSITORY)).toBe(DOWNLOADED.length);
	});

	test('reads bytes only from the raw host, and never from codeload', async ({ page }) => {
		// ADR-0031: `codeload.github.com` answers a *specific* `access-control-allow-origin`, so a
		// browser fetch of the tarball is blocked. `github-hosts` routes exactly two hosts, and the
		// default-deny fence aborts everything else — so a get that reached for the tarball would
		// fail outright here rather than at a scholar's machine.
		const github = await start(page);

		await connectAndGet(page);
		await expect(outcome(page)).toContainText(BROUGHT_IN, { timeout: 60_000 });

		// One request per file, from the raw host, and nothing from the tarball endpoint. Bounded, on
		// the sixty an anonymous reader gets per hour.
		expect(github.rawGets(OWNER, REPOSITORY)).toBe(DOWNLOADED.length);
		expect(github.rawRequests).toHaveLength(DOWNLOADED.length);
		expect(github.requests.some((path) => path.includes('tarball'))).toBe(false);
		// And every one of them was about the repository the address resolved to.
		expect(github.requests.every((path) => path.startsWith(`/repos/${OWNER}/${REPOSITORY}`))).toBe(
			true
		);
	});
});

test.describe('what connecting never does', () => {
	// ⚠ **Connecting moves not one byte** (ADR-0044). It is safe to be one press away precisely
	// because the Sync modal it hands off to states both sides before anything happens.
	test('moves nothing until the Sync modal is answered', async ({ page }) => {
		const github = await start(page);

		await connectByAddress(page);

		await expect(page.getByTestId('sync-get')).toBeVisible({ timeout: 60_000 });
		expect(github.rawGets(OWNER, REPOSITORY)).toBe(0);
		expect(await everyByteOf(page, DEFAULT_WORKSPACE)).toEqual({});
		// And it is connected, which is what makes the column on screen a plan rather than a preview.
		await page.keyboard.press('Escape');
		await expectRemoteNamed(page, REMOTE);
	});

	test('leaves no refusal from the last address behind it', async ({ page }) => {
		// The dialog is mounted for the page's life, so nothing but a close clears what it last said —
		// and a stale refusal would send somebody chasing a fault that has already been fixed.
		await start(page);

		await connectByAddress(page, 'https://example.com/not/a/repo');
		await expect(addressRefusal(page)).toBeVisible();
		await closeTheDoor(page);

		await openTheDoor(page);
		await expect(addressRefusal(page)).toHaveCount(0);
		await closeTheDoor(page);
	});
});

/**
 * A Reader who followed "Open this Workspace in Ballastella" off a Published Site's Front Page.
 *
 * ⚠ **The offer is the behaviour under test, not the transfer.** A URL is a thing anyone can send,
 * and one that silently created a Workspace and switched to it would let a link rearrange a
 * stranger's editor — so what is asserted here is that landing changes nothing at all, that a press
 * is what makes the Workspace and connects it, and that the parameter does not survive to be
 * replayed by a reload.
 *
 * ⚠ **`?clone=` is the shipped parameter and is kept**: every Published Site already in the world
 * carries it. What the press does is make a Workspace, connect it, and land on what there is to get.
 *
 * The *link* — its wording, its address, and both base paths it has to work at — is the viewer's
 * half, asserted in `viewer-reader.e2e.ts` against a real Published Site.
 */
test.describe('arriving on a link from a Published Site', () => {
	const offer = (page: Page) => page.getByTestId('return-link-offer');
	const accept = (page: Page) => page.getByTestId('accept-return-link');

	test('offers it, and has done nothing until it is confirmed', async ({ page }) => {
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

	// ⚠ **Make a Workspace, connect it, get** (ADR-0044). The press does the first two — the visitor's
	// own Workspace is left alone, because the repository's contents are not theirs to be poured into
	// — and lands on the Sync modal, where everything there is to get stands in one column.
	test('confirming makes a Workspace, connects it, and lands on what there is to get', async ({
		page
	}) => {
		// ⚠ **No sign-in anywhere on this path**, which is the whole point of a link a student with no
		// GitHub account can follow.
		await start(page);
		await page.goto(`${HUB}?clone=${REMOTE}`);

		await accept(page).click();

		await expect(page.getByTestId('return-link-outcome')).toContainText(REMOTE);
		await expectWorkspaceNamed(page, 'atlas');
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE, 'atlas']);
		expect(await readRemoteRelationship(page, 'atlas')).toMatchObject({
			owner: OWNER,
			repository: REPOSITORY
		});
		// Nothing has been downloaded: the Workspace it made is empty and the modal is what would
		// fill it.
		expect(await everyByteOf(page, 'atlas')).toEqual({});

		await getEverything(page);

		const stored = await everyByteOf(page, 'atlas');
		expect(Object.keys(stored).sort()).toEqual([...DOWNLOADED].sort());
	});

	// ADR-0024's rule: never merges, never overwrites. The visitor's own Workspace holds a Project of
	// the same name and the same directory as the repository's, which is the collision a merge would
	// produce — and the link makes a Workspace of its own precisely so there is none.
	test('leaves the Workspace it was followed from exactly as it was', async ({ page }) => {
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
		await page.goto(`${HUB}?clone=${REMOTE}`);

		await accept(page).click();
		await expect(page.getByTestId('return-link-outcome')).toContainText(REMOTE);
		await getEverything(page);

		const mine = await everyByteOf(page, DEFAULT_WORKSPACE);
		expect(Object.keys(mine)).toEqual(['amsterdam-1625/project.json']);
		expect(mine['amsterdam-1625/project.json']).toContain('My own Amsterdam');
		// And nothing of the repository's leaked into it — no site record, no pyramid. Indexed rather
		// than `toHaveProperty`, which reads the dot in the key as a path separator.
		expect(mine['ballastella-site.json']).toBeUndefined();
		// Nor did it acquire a repository of its own on the way past.
		expect(await readRemoteRelationship(page, DEFAULT_WORKSPACE)).toBeNull();
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
	test('a truncated file list, with nothing connected at all', async ({ page }) => {
		// ⚠ A truncated listing answers **200**, so nothing throws anywhere. Proceeding would hand the
		// user a Workspace with most of a pyramid silently missing — and here it is caught one step
		// earlier still: the probe that works out which repository an address means reads the same
		// listing, so a truncated one cannot even be confirmed, let alone connected to.
		const github = await start(page, { truncateAfter: 3 });

		await connectByAddress(page);

		await expect(addressRefusal(page)).toContainText('could only list the first');
		await expect(addressRefusal(page)).toContainText('Nothing has been downloaded.');
		// Not one byte asked for, and no repository claimed.
		expect(github.rawGets(OWNER, REPOSITORY)).toBe(0);
		await closeTheDoor(page);
		expect(await readRemoteRelationship(page, DEFAULT_WORKSPACE)).toBeNull();
	});

	test('a repository nobody can read anonymously', async ({ page }) => {
		await start(page);

		await connectByAddress(page, `${OWNER}/not-published`);

		// A private repository and a missing one are one answer to an anonymous reader, and the
		// sentence says so rather than asserting the first of the two.
		await expect(addressRefusal(page)).toContainText('no public repository');
		await expect(addressRefusal(page)).toContainText('private');
		await closeTheDoor(page);
		expect(await readRemoteRelationship(page, DEFAULT_WORKSPACE)).toBeNull();
	});

	test('something that is not a repository address at all', async ({ page }) => {
		await start(page);

		await connectByAddress(page, 'https://example.com/not/a/repo');

		// ⚠ **Refused before any request, and by the address rather than by GitHub.** A host that is
		// neither github.com nor a Pages address produces no candidate to probe at all, so the sentence
		// says why and what to paste instead (ADR-0044).
		await expect(addressRefusal(page)).toContainText('a site on an address of its own');
		expect(await readRemoteRelationship(page, DEFAULT_WORKSPACE)).toBeNull();
		// ⚠ **Focus stays on the surface that was asked from**, so a keyboard user who reads the
		// refusal is still where the field they have to correct is. A refusal that dropped focus to
		// `<body>` would leave them tabbing in from the top of a modal to find it (WCAG 2.4.3).
		await expect(page.getByTestId('connect-sequence')).toBeVisible();
		await expect(page.getByTestId('find-workspace-address')).toBeFocused();
	});

	// The quota is scripted because no automated browser can be made genuinely full; what is asserted
	// is the app's sequencing rather than Chromium's accounting (ADR-0024). It is the *get* that
	// refuses, because connecting moves nothing and so needs no room.
	test('not enough room, named in bytes, with nothing written', async ({ page }) => {
		await start(page);
		await page.addInitScript(() => {
			navigator.storage.estimate = async () => ({ quota: 1_000_128, usage: 1_000_000 });
		});
		await page.reload();

		await connectByAddress(page);
		const dialog = page.getByRole('dialog', { name: 'Sync with GitHub' });
		await expect(dialog.getByTestId('sync-get')).toBeVisible({ timeout: 60_000 });
		await dialog.getByTestId('sync-get').click();

		// Inside the modal, which stays open: the refusal is the one thing on screen the author has to
		// act on, and the columns behind it are re-read so they describe both sides as they now are.
		const refusal = page.getByTestId('sync-modal').getByRole('alert').first();
		await expect(refusal).toContainText('needs about', { timeout: 60_000 });
		await expect(refusal).toContainText('free');
		// Refused before it wrote: the room is counted against the whole plan, so the Workspace is as
		// empty afterwards as it was before.
		expect(await everyByteOf(page, DEFAULT_WORKSPACE)).toEqual({});
	});
});
