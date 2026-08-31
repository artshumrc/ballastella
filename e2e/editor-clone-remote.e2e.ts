import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { routeGitHubHosts } from './support/github-hosts.js';
import {
	closeTheDoor,
	expectRemoteNamed,
	expectWorkspaceNamed,
	inTheDoor,
	openTheDoor,
	readBaseline,
	readRemoteRelationship,
	switchToWorkspace
} from './support/workspace';

/**
 * Open a Workspace from GitHub (ADR-0031, ADR-0032, ADR-0038).
 *
 * Seam 2. The transfer — the tree listing, the skip-by-blob-SHA resume, the refusals and
 * their sentences — is asserted at Seam 1 in `clone-from-remote.test.ts`, and what the installation
 * then believes about the Remote in `open-workspace-from-github.test.ts`. Both assert bytes and
 * records rather than a screen. What only a browser can show is here:
 *
 *   - a repository name typed into the editor becomes a **new named Workspace** that the app
 *     switches to, with the Workspace it came from left exactly as it was;
 *   - the Project in it lists on the hub, opens, and draws — so the Map Image, the Alignment
 *     and the Annotations all really landed, in a store the app reads through its own code;
 *   - only the **owned namespace** arrives, so the publisher's `README.md`, `CNAME` and workflow do
 *     not become the opener's own content and are not published as theirs later (ADR-0033);
 *   - the result is **bound with a Baseline**, which the Remote dialog is the one place that says —
 *     and bound to the repository the *user* chose, never the one the published tree named;
 *   - **opening the same repository again goes back to that Workspace** rather than making a second
 *     synchronized copy of it, which needs real IndexedDB and so is unreachable below this seam;
 *   - none of it needs a credential, and none is sent — asserted against a GitHub that answers 401
 *     to anything carrying one;
 *   - **nothing reaches `codeload.github.com`**, because the network fence blocks every host
 *     `github-hosts` does not route and it deliberately routes only two.
 *
 * ⚠ **Resume is asserted at Seam 1 and not here, on purpose.** Skipping a file that is already on
 * disk is invisible in the result — a retry that re-downloaded everything and wrote the same bytes
 * back leaves a byte-identical Workspace — so the only assertion worth making is on the request
 * counter, and reaching a *partly* filled Workspace needs a destination this screen does not offer.
 * `open-workspace-from-github.test.ts` drives the same fake with a partial destination and asserts
 * `rawGets` directly.
 *
 * ⚠ **"Clone" is not product vocabulary any more, and the file name is the one place it survives.**
 * The shipped `?clone=owner/repository` invitation parameter is kept exactly as it is, because old
 * Published Sites carry it — only what the editor *says* about it changed.
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
 * `remote.json` names a **different** repository, as a fork's published binding would, so an Open
 * that copied it down would be caught by the assertions below.
 */
const PUBLISHED: Record<string, string> = {
	'.nojekyll': '',
	'index.html': '<!doctype html><title>Atlas</title>',
	'remote.json': JSON.stringify({ formatVersion: 1, owner: 'someone-else', repository: 'fork' }),
	'amsterdam-1625/project.json': PROJECT_JSON,
	'amsterdam-1625/annotations/warehouses.geojson': WAREHOUSES,
	// alignment-write-is-the-fixture: the Alignment as it sits on the Remote, seeded into the fake GitHub rather than into any Workspace — the Open under test is what writes it, through `writeAlignmentBytes`
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'stands in for a tile',
	...Object.fromEntries(OUTSIDE_NAMESPACE.map((path) => [path, `${path}, the scholar's own\n`]))
};

/**
 * Everything an Open brings down: the owned namespace, less the published tree's own `remote.json`.
 *
 * Nothing writes a binding into the Workspace. The relationship is installation-local metadata
 * (ADR-0038), so a partly-filled directory cannot look like synchronized work.
 */
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
 * Paste an address behind the door and confirm what GitHub says it means.
 *
 * ⚠ **The inbound door is a landing of the one door now** (ADR-0041, ADR-0042), in front of the
 * sign-in rather than behind it: a student opening their instructor's Workspace needs no account. The
 * address is resolved to a repository first and **confirmed** before a byte moves, because an
 * ambiguous Pages address has two real answers and a Workspace can run to gigabytes.
 *
 * Leaves the door open, because what the Open said is said inside it.
 */
async function openFromGitHub(page: Page, repository = REMOTE): Promise<void> {
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
}

const outcome = (page: Page) => page.getByTestId('connect-notice');
const problem = (page: Page) => page.getByTestId('connect-problem');
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

test.describe('opening a published Workspace', () => {
	test('makes a new Workspace, fills it, and switches to it', async ({ page }) => {
		await start(page);

		await openFromGitHub(page);

		await expect(outcome(page)).toContainText(`Opened ${REMOTE}`);
		await expect(outcome(page)).toContainText('“atlas”');
		await closeTheDoor(page);

		// Switched to, which the bar is the one place that says.
		await expectWorkspaceNamed(page, 'atlas');
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE, 'atlas']);

		const stored = await everyByteOf(page, 'atlas');
		// The owned namespace and nothing else: not the publisher's own files, and not a `remote.json`
		// either — the relationship is installation-local metadata now (ADR-0038).
		expect(Object.keys(stored).sort()).toEqual([...DOWNLOADED].sort());
		for (const path of OUTSIDE_NAMESPACE) expect(Object.keys(stored)).not.toContain(path);
		expect(stored['images/amsterdam-1625/info.json']).toBe('{"width":4096,"height":3072}');
		expect(stored['alignments/amsterdam-1625.json']).toBe(
			'{"type":"Annotation","id":"amsterdam-1625"}'
		);
		expect(stored['amsterdam-1625/annotations/warehouses.geojson']).toBe(WAREHOUSES);
	});

	test('the opened Project lists on the hub, opens, and draws', async ({ page }) => {
		// The Workspace read back through the app's own code rather than through `getFileHandle`: a
		// Project that lists, opens and renders is what "the Alignments and Annotations are readable"
		// actually means to a scholar.
		await start(page);

		await openFromGitHub(page);
		await expect(outcome(page)).toContainText('Opened');
		await closeTheDoor(page);

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

	test('records the selected Remote and a Baseline, and no stale binding can redirect it', async ({
		page
	}) => {
		// ⚠ **The published tree carries a `remote.json` naming `someone-else/fork`**, as a fork's
		// published binding would. Read as the relationship it would aim this author's Publish button
		// at a repository they have never seen — so it is not downloaded at all, and what is recorded
		// is the repository they typed.
		await start(page);

		await openFromGitHub(page);
		await expect(outcome(page)).toContainText('Opened');
		await closeTheDoor(page);
		await expectWorkspaceNamed(page, 'atlas');

		// The Remote and the Baseline as the app reads them, both from the door — which is where the
		// evidence sits beside the repository it is about (ADR-0041).
		await expectRemoteNamed(page, REMOTE);
		await inTheDoor(page, async () => {
			await expect(page.getByTestId('remote-baseline')).toContainText(`last agreed with ${REMOTE}`);
			await expect(page.getByTestId('remote-baseline')).not.toContainText('Cannot tell');
		});

		// ⚠ And in the installation database, behind the app's back — the point of ADR-0038 is that
		// this evidence is *outside* the Workspace, so it cannot travel in a Backup or up to a Remote.
		expect(await readRemoteRelationship(page, 'atlas')).toMatchObject({
			owner: OWNER,
			repository: REPOSITORY,
			branch: 'main'
		});
		const baseline = await readBaseline(page, 'atlas');
		expect(baseline).not.toBeNull();
		expect(baseline?.commit).not.toBe('');
		// Source only: the Baseline describes scholarship, never the viewer a publish generated.
		expect(baseline?.files).toContain('images/amsterdam-1625/info.json');
		expect(baseline?.files).not.toContain('index.html');
		// And nothing of `someone-else/fork` reached the Workspace or the record.
		expect(Object.keys(await everyByteOf(page, 'atlas'))).not.toContain('remote.json');
	});

	test('needs no credential, and sends none', async ({ page }) => {
		// ⚠ **The criterion, pinned rather than assumed.** `rejectCredential` answers 401 to every
		// request *carrying* a token and leaves anonymous ones alone, exactly as the real API does for
		// a public repository — so an Open that attached an `Authorization` header anywhere would fail
		// here. Nothing signs in first, which is the point: a student with no GitHub account.
		const github = await routeGitHubHosts(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY, files: PUBLISHED }],
			rejectCredential: true
		});
		await page.goto(HUB);
		await emptyBrowserStorage(page);
		await page.reload();

		await openFromGitHub(page);

		await expect(outcome(page)).toContainText('Opened');
		// Still signed out afterwards: this neither needs nor acquires a credential.
		await expect(page.getByTestId('connect-signed-in')).toHaveCount(0);
		// Indexed rather than `toHaveProperty`, which reads a dot in the key as a path separator.
		const stored = await everyByteOf(page, 'atlas');
		expect(stored['images/amsterdam-1625/info.json']).toBe('{"width":4096,"height":3072}');
		expect(github.rawGets(OWNER, REPOSITORY)).toBe(DOWNLOADED.length);
	});

	test('reads bytes only from the raw host, and never from codeload', async ({ page }) => {
		// ADR-0031: `codeload.github.com` answers a *specific* `access-control-allow-origin`, so a
		// browser fetch of the tarball is blocked. `github-hosts` routes exactly two hosts, and the
		// default-deny fence aborts everything else — so an Open that reached for the tarball would
		// fail outright here rather than at a scholar's machine.
		const github = await start(page);

		await openFromGitHub(page);
		await expect(outcome(page)).toContainText('Opened');

		// One request per file, from the raw host, and exactly three API calls: the listing the probe
		// works out which repository the address means from, the transfer's own listing, and the commit
		// the Baseline records the shared state at. Bounded, on the sixty an anonymous reader gets per
		// hour — and the probe's read is what buys the confirmation before gigabytes move.
		expect(github.rawGets(OWNER, REPOSITORY)).toBe(DOWNLOADED.length);
		expect(github.rawRequests).toHaveLength(DOWNLOADED.length);
		expect(github.requests).toEqual([
			`/repos/${OWNER}/${REPOSITORY}/git/trees/main`,
			`/repos/${OWNER}/${REPOSITORY}/git/trees/main`,
			`/repos/${OWNER}/${REPOSITORY}/git/ref/heads/main`
		]);
		expect(github.requests.some((path) => path.includes('tarball'))).toBe(false);
	});

	test('reports per-file progress while it runs, and stays keyboard operable', async ({ page }) => {
		const github = await start(page);

		// ⚠ **The Project's own manifest is held, and it is downloaded last** — `cloneFromRemote` keeps
		// manifests back from the transfer as well as from the write, so this is the one file whose
		// being held leaves the count with a resting place rather than a moment the assertion has to be
		// lucky enough to catch.
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route(`**/amsterdam-1625/project.json`, async (route) => {
			await held;
			await route.fallback();
		});

		// Started from the keyboard alone, which is the half a `click()` cannot show: an Open a scholar
		// with no pointer cannot begin is one they cannot do. Both presses — finding the repository the
		// address means, and confirming it — are made with Enter.
		await openTheDoor(page);
		await page.getByTestId('open-by-address').click();
		await page.getByTestId('workspace-address-field').fill(REMOTE);
		await page.getByTestId('find-workspace-address').focus();
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('resolved-address')).toContainText(REMOTE, { timeout: 30_000 });
		await page.getByTestId('open-resolved-address').focus();
		await page.keyboard.press('Enter');

		// `role="status"`, so it reaches assistive technology rather than only the screen. And it
		// settles on what has actually arrived: a line counting the plan rather than the transfer would
		// read the total from the first moment.
		const progress = page.getByTestId('address-progress');
		await expect(progress).toHaveText(
			`${DOWNLOADED.length - 1} of ${DOWNLOADED.length} files downloaded from ${REMOTE}.`,
			{ timeout: 30_000 }
		);
		await expect(progress).toHaveAttribute('role', 'status');
		// ⚠ **`aria-disabled` while busy and never `disabled`.** A `disabled` button leaves the tab
		// order the moment it is pressed, which drops a keyboard user's focus to `<body>` for the
		// length of a download that runs in minutes (WCAG 2.4.3) — so it is still reachable and still
		// says it is unavailable.
		const button = page.getByTestId('open-resolved-address');
		await expect(button).toHaveAttribute('aria-disabled', 'true');
		// The *native* attribute, read off the element: `toBeDisabled()` counts `aria-disabled` as
		// disabled too, so `not.toBeDisabled()` beside the line above passes only on a transfer that has
		// already finished, never seeing the property it names.
		expect(await button.evaluate((element) => (element as HTMLButtonElement).disabled)).toBe(false);
		await button.focus();
		await expect(button).toBeFocused();
		// And a transfer that runs in minutes never strands a keyboard user on the document itself.
		expect(await page.evaluate(() => document.activeElement?.tagName ?? 'NONE')).not.toBe('BODY');

		release?.();
		await expect(outcome(page)).toContainText('Opened');
		// One request per file and no more: the count the line settled on is the transfer it named.
		expect(github.rawGets(OWNER, REPOSITORY)).toBe(DOWNLOADED.length);
	});
});

test.describe('what Open never does', () => {
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

		await openFromGitHub(page);
		await expect(outcome(page)).toContainText('Opened');

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
		// and “Opened ada/atlas into a new Workspace called “atlas”” read as a report about whatever
		// Workspace the user had moved to by the time they opened it again.
		await start(page);

		await openFromGitHub(page);
		await expect(outcome(page)).toContainText('Opened');
		await closeTheDoor(page);
		await switchToWorkspace(page, DEFAULT_WORKSPACE);

		await openTheDoor(page);
		await expect(outcome(page)).toHaveCount(0);
		await expect(problem(page)).toHaveCount(0);
		await closeTheDoor(page);

		// The refusal too, which is the half a stale reading of would send somebody chasing a fault
		// that has already been fixed.
		await openFromGitHub(page, 'https://example.com/not/a/repo');
		await expect(addressRefusal(page)).toBeVisible();
		await closeTheDoor(page);
		await openTheDoor(page);
		await expect(addressRefusal(page)).toHaveCount(0);
	});

	test('makes a second synchronized copy of a repository it has already opened', async ({
		page
	}) => {
		// ⚠ **The reason the reverse lookup exists.** Two local Workspaces both synchronized with
		// `ada/atlas` are two Publish buttons aimed at one site, and whichever is pressed second silently
		// replaces the other's work with its own idea of the whole Workspace. So opening it again goes
		// *back*, downloading nothing — and the author's own edits since are still there, because
		// reopening is a way back to work rather than a transfer.
		await start(page);

		await openFromGitHub(page);
		await expect(outcome(page)).toContainText('“atlas”');
		await closeTheDoor(page);
		const baseline = await readBaseline(page, 'atlas');
		await page.evaluate(async () => {
			const workspace = await (await navigator.storage.getDirectory()).getDirectoryHandle('atlas');
			const annotations = await (
				await workspace.getDirectoryHandle('amsterdam-1625')
			).getDirectoryHandle('annotations');
			const writable = await (
				await annotations.getFileHandle('warehouses.geojson')
			).createWritable();
			await writable.write('{"type":"FeatureCollection","features":[{"id":"mine"}]}');
			await writable.close();
		});
		await switchToWorkspace(page, DEFAULT_WORKSPACE);

		await openFromGitHub(page);

		await expect(outcome(page)).toContainText('Went back to “atlas”');
		await expect(outcome(page)).toContainText('Nothing has been downloaded');
		await closeTheDoor(page);
		// Back in it, with no second directory and the same stable identity as before.
		await expectWorkspaceNamed(page, 'atlas');
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE, 'atlas']);
		expect(await readRemoteRelationship(page, 'atlas')).toMatchObject({ repository: REPOSITORY });
		// The author's own work is untouched and the Baseline has not moved on from a fresh listing —
		// which would have reported their unpublished edit as the Remote's work.
		const mine = await everyByteOf(page, 'atlas');
		expect(mine['amsterdam-1625/annotations/warehouses.geojson']).toContain('"mine"');
		expect(await readBaseline(page, 'atlas')).toEqual(baseline);
	});
});

/**
 * A Reader who followed "Open this Workspace in Ballastella" off a Published Site's Front Page.
 *
 * ⚠ **The offer is the behaviour under test, not the transfer.** A URL is a thing anyone can send,
 * and one that silently created a Workspace and switched to it would let a link rearrange a
 * stranger's editor — so what is asserted here is that landing changes nothing at all, that a press
 * is what runs the Open, and that the parameter does not survive to be replayed by a reload.
 *
 * ⚠ **`?clone=` is the shipped parameter and is kept**: every Published Site already
 * in the world carries it. Only what the editor *says* about it is Open now.
 *
 * The *link* — its wording, its address, and both base paths it has to work at — is the viewer's
 * half, asserted in `viewer-reader.e2e.ts` against a real Published Site.
 */
test.describe('arriving on a link from a Published Site', () => {
	const offer = (page: Page) => page.getByTestId('return-link-offer');
	const accept = (page: Page) => page.getByTestId('accept-return-link');

	test('offers an Open, and has done nothing until it is confirmed', async ({ page }) => {
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

	test('confirming runs the Open, and switches to what it made', async ({ page }) => {
		// ⚠ **No sign-in anywhere on this path**, which is the whole point of a link a student with no
		// GitHub account can follow.
		await start(page);
		await page.goto(`${HUB}?clone=${REMOTE}`);

		await accept(page).click();

		await expect(page.getByTestId('return-link-outcome')).toContainText(`Opened ${REMOTE}`);
		await expectWorkspaceNamed(page, 'atlas');
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE, 'atlas']);
		// The same Workspace the dialog's Open produces, asserted on what arrived rather than on the
		// sentence, and synchronized on the strength of the same installation-local record.
		const stored = await everyByteOf(page, 'atlas');
		expect(Object.keys(stored).sort()).toEqual([...DOWNLOADED].sort());
		expect(await readRemoteRelationship(page, 'atlas')).toMatchObject({
			owner: OWNER,
			repository: REPOSITORY
		});
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
		// user a Workspace with most of a pyramid silently missing — and here it is caught one step
		// earlier still: the probe that works out which repository an address means reads the same
		// listing, so a truncated one cannot even be confirmed, let alone downloaded.
		const github = await start(page, { truncateAfter: 3 });

		await openFromGitHub(page);

		await expect(addressRefusal(page)).toContainText('could only list the first');
		await expect(addressRefusal(page)).toContainText('Nothing has been downloaded.');
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

		await openFromGitHub(page);

		await expect(problem(page)).toContainText('needs about');
		await expect(problem(page)).toContainText('free');
		await expect(problem(page)).toContainText('already in use');
		expect(github.rawGets(OWNER, REPOSITORY)).toBe(0);
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});

	test('a repository nobody can read anonymously', async ({ page }) => {
		await start(page);

		await openFromGitHub(page, `${OWNER}/not-published`);

		// A private repository and a missing one are one answer to an anonymous reader, and the
		// sentence says so rather than asserting the first of the two.
		await expect(addressRefusal(page)).toContainText('no public repository');
		await expect(addressRefusal(page)).toContainText('private');
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});

	test('something that is not a repository address at all', async ({ page }) => {
		await start(page);

		await openFromGitHub(page, 'https://example.com/not/a/repo');

		// ⚠ **Refused before any request, and by the address rather than by GitHub.** A host that is
		// neither github.com nor a Pages address produces no candidate to probe at all, so the sentence
		// says why and what to paste instead (ADR-0041).
		await expect(addressRefusal(page)).toContainText('a site on an address of its own');
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
		// ⚠ **Focus stays on the surface that was asked from**, so a keyboard user who reads the
		// refusal is still where the field they have to correct is. A refusal that dropped focus to
		// `<body>` would leave them tabbing in from the top of a modal to find it (WCAG 2.4.3).
		await expect(page.getByTestId('connect-sequence')).toBeVisible();
		await expect(page.getByTestId('find-workspace-address')).toBeFocused();
	});
});
