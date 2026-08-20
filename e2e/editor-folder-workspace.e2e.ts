import { DEFAULT_WORKSPACE, expect, test } from './support/test.js';
import { type Page } from '@playwright/test';

import { projectNameField } from './support/project-screen';
import {
	closeWorkspaceSettings,
	createWorkspace,
	expectWorkspaceNamed,
	openWorkspaceMenu,
	openWorkspaceSettings
} from './support/workspace';
import { routeBaseMapArchive } from './support/editor-deployment.js';

// Every spec in this suite is behind the default-deny network fence in `support/network-fence.ts`,
// and this deployment's Base Map catalog points every entry at an archive on somebody else's host.
// So the archive is served from the committed fixture, in one place, for the whole file.
//
// **`context` rather than `page`**: a request that has passed through a service worker is not the
// page's own as far as Playwright is concerned, and `page.route` never sees it (measured in
// `editor-pwa.e2e.ts`, which says so at its own interception). Routing the context has no downside
// for a spec with no worker, and is the spelling that keeps working when one appears.
test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

/**
 * SPEC's Seam 2 for the File System Access Workspace: the running app, a real browser, real
 * IndexedDB, real user gestures, and a real `FileSystemDirectoryHandle`.
 *
 * **What is real and what is not, stated plainly, because it matters here more than anywhere
 * else.** `showDirectoryPicker()` opens an operating-system dialog and waits for a person; no
 * browser automation can supply one, and Playwright has no equivalent of `grantPermissions` for
 * the file system. So two things are ours:
 *
 * - the picker call itself, which hands back a genuine `FileSystemDirectoryHandle` — obtained from
 *   OPFS, which is the only source of a real one an automated browser has. Every file operation the
 *   app then performs on it is the real API: real `createWritable`, real `move`, real
 *   `removeEntry`. What is simulated is the dialog and the fact that the folder is one the user
 *   could open in Finder, not the storage.
 * - the two permission methods, whose answers are scripted per test so that *declined* and
 *   *lapsed* can be exercised at all.
 *
 * Everything else is the running app: the click or keypress that reaches the picker is a real user
 * gesture and the tests assert `navigator.userActivation.isActive` inside the call, so the rule
 * that resumption must never be an automatic call on load is asserted rather than assumed. The
 * handle really goes through `structuredClone` into IndexedDB and really comes back across a
 * reload. A folder that has "been deleted" really is deleted, and the failure the app renders is
 * the browser's own `NotFoundError`.
 *
 * The byte-level behaviour of the adapter is asserted in `@ballastella/core` against the shared
 * adapter suite, in both Chromium and Firefox. This file is about the grant and the screens around
 * it — which is what SPEC's Seam 2 says can only be exercised in a real browser.
 */

/** The folder the stubbed picker hands back, as a directory in OPFS. */
const PICKED_FOLDER = 'e2e-picked-folder';
/** `granted` | `prompt` | `denied` — what the scripted permission methods answer. */
const PERMISSION_KEY = 'e2e-folder-permission';
/** `yes` makes the stubbed picker report the dialog being closed without a choice. */
const CANCEL_KEY = 'e2e-folder-cancel';

declare global {
	interface Window {
		/**
		 * What the stubbed picker and permission methods were asked, for `e2e/` only. Reset on every
		 * page load, which is what lets "nothing was asked automatically" be an assertion.
		 */
		e2eFolderGrant?: {
			pickerCalls: { mode: string | undefined; id: string | undefined }[];
			activationAtPick: boolean[];
			permissionQueries: number;
			permissionRequests: number;
			activationAtRequest: boolean[];
		};
		/** How many writes the interrupted-write test's injected failure actually interrupted. */
		e2eInterruptedWrites?: number;
	}
}

/**
 * Put a picker and a permission model in the page, before any of the app's own scripts run.
 *
 * The picker is an **own** property on `window`, because a browser's real `showDirectoryPicker`
 * lives on `Window.prototype` and cannot be deleted from the instance; shadowing is also how
 * {@link hideDirectoryPicker} makes Chromium look like Firefox.
 */
async function installDirectoryPicker(page: Page): Promise<void> {
	await page.addInitScript(
		({ folder, permissionKey, cancelKey }) => {
			const grant = {
				pickerCalls: [] as { mode: string | undefined; id: string | undefined }[],
				activationAtPick: [] as boolean[],
				permissionQueries: 0,
				permissionRequests: 0,
				activationAtRequest: [] as boolean[]
			};
			window.e2eFolderGrant = grant;

			const wanted = () => localStorage.getItem(permissionKey) ?? 'granted';

			Object.defineProperty(window, 'showDirectoryPicker', {
				configurable: true,
				writable: true,
				value: async (options?: { mode?: string; id?: string }) => {
					grant.pickerCalls.push({ mode: options?.mode, id: options?.id });
					grant.activationAtPick.push(navigator.userActivation.isActive);
					if (localStorage.getItem(cancelKey) === 'yes') {
						throw new DOMException('The user aborted a request.', 'AbortError');
					}
					const root = await navigator.storage.getDirectory();
					return root.getDirectoryHandle(folder, { create: true });
				}
			});

			// On the prototype rather than on the handle: a handle recalled from IndexedDB is a fresh
			// object, so own properties would not survive the reload these tests are about.
			const handles = FileSystemHandle.prototype as {
				queryPermission?: unknown;
				requestPermission?: unknown;
			};
			handles.queryPermission = async () => {
				grant.permissionQueries += 1;
				return wanted() === 'granted' ? 'granted' : 'prompt';
			};
			handles.requestPermission = async () => {
				grant.permissionRequests += 1;
				grant.activationAtRequest.push(navigator.userActivation.isActive);
				return wanted() === 'denied' ? 'denied' : 'granted';
			};
		},
		{ folder: PICKED_FOLDER, permissionKey: PERMISSION_KEY, cancelKey: CANCEL_KEY }
	);
}

/** Make the browser look like Firefox, Safari, or Chrome on Android: no picker at all. */
async function hideDirectoryPicker(page: Page): Promise<void> {
	await page.addInitScript(() => {
		Object.defineProperty(window, 'showDirectoryPicker', {
			configurable: true,
			writable: true,
			value: undefined
		});
	});
}

/** Empty the origin's OPFS, so no test can see another's Projects. */
async function emptyBrowserStorage(page: Page): Promise<void> {
	await page.evaluate(async () => {
		// The whole of browser storage, which since ticket 12 is **every named Workspace** rather than
		// one — so no test can see another's, whichever Workspace it was in.
		//
		// ⚠ **The Workspace the app is holding open is emptied, not removed.** `DirectoryHandleStore`
		// caches its root handle once it resolves (ADR-0008), and that handle is now a *named
		// subdirectory* rather than the OPFS root, which cannot vanish. Deleting the directory out from
		// under a running app therefore latches it "unreachable" until a reload — a state about the
		// harness rather than about the product, and one that used to be unreachable because emptying
		// the root left the root itself in place. Emptying it is exactly what this always meant.
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
	});
}

/** Forget the remembered folder handle, so each test starts with nothing to resume. */
async function forgetRememberedFolder(page: Page): Promise<void> {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				const request = indexedDB.deleteDatabase('ballastella');
				request.onsuccess = () => resolve();
				request.onerror = () => resolve();
				// Another connection is still open. Not a state this app reaches, and not one a test
				// should hang on.
				request.onblocked = () => resolve();
			})
	);
}

/** Every file inside the picked folder, recursively, sorted. */
async function everyPathInFolder(page: Page): Promise<string[]> {
	return page.evaluate(async (folder) => {
		const walk = async (
			directory: FileSystemDirectoryHandle,
			prefix: string
		): Promise<string[]> => {
			const found: string[] = [];
			for await (const [name, handle] of directory.entries()) {
				if (handle.kind === 'file') found.push(`${prefix}${name}`);
				else found.push(...(await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`)));
			}
			return found;
		};
		const root = await navigator.storage.getDirectory();
		try {
			return (await walk(await root.getDirectoryHandle(folder), '')).sort();
		} catch {
			return [];
		}
	}, PICKED_FOLDER);
}

/** One file's text from inside the picked folder. */
async function readInFolder(page: Page, path: string): Promise<string> {
	return page.evaluate(
		async ([folder, path]) => {
			const root = await navigator.storage.getDirectory();
			let directory = await root.getDirectoryHandle(folder as string);
			const segments = (path as string).split('/');
			const name = segments.pop() as string;
			for (const segment of segments) directory = await directory.getDirectoryHandle(segment);
			return (await (await directory.getFileHandle(name)).getFile()).text();
		},
		[PICKED_FOLDER, path]
	);
}

/**
 * Every top-level name in the **named** Workspace browser storage opens on, or `null` when there is
 * no such Workspace.
 *
 * Since ticket 12 the OPFS root holds several named Workspaces, so "what is in browser storage" is a
 * question about one of them — and the picked folder, which this file's stubbed picker also creates
 * in the root, is deliberately not one of them.
 *
 * ⚠ **`workspaceRootIfAny`, never `workspaceRoot`.** The creating one made this helper answer `[]`
 * for a Workspace that was not there by *making* it, which turns "browser storage holds nothing of
 * yours" into an assertion that cannot fail and quietly leaves a directory behind for whatever the
 * spec checks next.
 */
async function browserStorageEntries(page: Page): Promise<string[] | null> {
	return page.evaluate(async () => {
		const root = await workspaceRootIfAny();
		if (root === null) return null;
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		return names.sort();
	});
}

const grant = (page: Page) => page.evaluate(() => window.e2eFolderGrant);

const createProject = async (page: Page, name: string) => {
	await page.getByRole('button', { name: 'New Project' }).click();
	await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill(name);
	await page.getByRole('button', { name: 'Create Project' }).click();
	await expect(page.getByRole('link', { name })).toBeVisible();
};

/**
 * Choose a folder, from where the choice now lives (ticket 12).
 *
 * The offer moved out of first contact and into Workspace settings — ADR-0001's own principle is
 * that a folder Workspace is a capability upgrade and never a gate, and the hub asked the question
 * anyway. Everything about the *grant* below is unchanged; only the two clicks in front of it are
 * new, and they are written once here rather than at every call.
 */
const chooseFolder = async (page: Page) => {
	await openWorkspaceSettings(page);
	await page.getByTestId('settings-choose-folder').click();
	await closeWorkspaceSettings(page);
};

/** Go back to browser storage, which is also in settings. */
const useBrowserStorage = async (page: Page) => {
	await openWorkspaceSettings(page);
	await page.getByRole('button', { name: 'Use browser storage instead' }).click();
	await closeWorkspaceSettings(page);
};

/**
 * Which Workspace is open, read off the **navigation bar**.
 *
 * The bar names it on every screen (SPEC story 88), which is a better place to ask than the settings
 * dialog: it is what a scholar actually sees, and it does not need opening. In both backings the
 * directory *is* the Workspace, so a folder Workspace is named by its folder and a browser-managed
 * one by its own name.
 */
const inFolder = (page: Page) => expectWorkspaceNamed(page, PICKED_FOLDER);

const inBrowserStorage = (page: Page) => expectWorkspaceNamed(page, DEFAULT_WORKSPACE);

test.describe('choosing a folder as the Workspace', () => {
	test.beforeEach(async ({ page }) => {
		await installDirectoryPicker(page);
		await page.goto('./');
		await emptyBrowserStorage(page);
		await forgetRememberedFolder(page);
		await page.evaluate(() => localStorage.clear());
		await page.reload();
	});

	test('puts Projects in that folder, as real files laid out as ADR-0008 specifies', async ({
		page
	}) => {
		await inBrowserStorage(page);

		await chooseFolder(page);

		await inFolder(page);
		await createProject(page, 'Amsterdam 1625');

		expect(await everyPathInFolder(page)).toEqual(['amsterdam-1625/project.json']);
		expect(JSON.parse(await readInFolder(page, 'amsterdam-1625/project.json'))).toMatchObject({
			formatVersion: 1,
			name: 'Amsterdam 1625',
			layers: [],
			baseMap: null
		});
	});

	test('asks for read and write in one grant, from the user’s own gesture', async ({ page }) => {
		// `requestPermission` needs transient user activation. A picker reached without a gesture
		// fails, and the app then looks as though it has lost the folder — so the gesture is the
		// assertion, not an implementation detail.
		await openWorkspaceSettings(page);
		await page.getByTestId('settings-choose-folder').focus();
		await page.keyboard.press('Enter');
		await closeWorkspaceSettings(page);

		await inFolder(page);
		expect(await grant(page)).toMatchObject({
			pickerCalls: [{ mode: 'readwrite', id: 'ballastella-workspace' }],
			activationAtPick: [true]
		});
	});

	test('covers every Project with that one grant — switching Projects prompts nothing', async ({
		page
	}) => {
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'Amsterdam 1625');
		await createProject(page, 'Boston 1775');

		for (const name of ['Amsterdam 1625', 'Boston 1775']) {
			await page.getByRole('link', { name }).click();
			await expect(page.getByTestId('project-name')).toHaveText(name);
			await page.getByTestId('all-projects').click();
			await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
		}

		const asked = await grant(page);
		expect(asked?.pickerCalls).toHaveLength(1);
		expect(asked?.permissionRequests).toBe(0);
	});

	test('says nothing at all when the picker is closed without choosing', async ({ page }) => {
		await page.evaluate((key) => localStorage.setItem(key, 'yes'), CANCEL_KEY);

		await chooseFolder(page);

		await inBrowserStorage(page);
		await expect(page.getByRole('alert')).toHaveCount(0);
	});

	test('leaves the browser Workspace’s Projects untouched, in both directions', async ({
		page
	}) => {
		await createProject(page, 'In Browser');

		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'In Folder');
		await expect(page.getByRole('link', { name: 'In Browser' })).toHaveCount(0);

		await useBrowserStorage(page);

		await inBrowserStorage(page);
		await expect(page.getByRole('link', { name: 'In Browser' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'In Folder' })).toHaveCount(0);

		// And back again: the folder still holds what was made in it.
		await chooseFolder(page);
		await inFolder(page);
		await expect(page.getByRole('link', { name: 'In Folder' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'In Browser' })).toHaveCount(0);
	});

	/**
	 * ⚠ **THE WHOLE OF ROUND 3's DESIGN DECISION, IN THE PLACE IT APPLIES.**
	 *
	 * A folder Workspace's key is `folder:<folder name>` — a name the user can put on any folder on
	 * any drive — because the browser offers a page no stable identifier for a picked directory
	 * (ADR-0017), and ADR-0023 explicitly invites synced folders, colleagues' copies and second
	 * checkouts. Two rounds of this ticket tried to make an unattended recursive delete safe *there*
	 * by comparing what is inside the directory against what the record captured, and it cannot be
	 * done: Dropbox, Drive, rsync and `cp -a` reproduce `project.json` byte for byte, and ADR-0010
	 * guarantees that opening a Project writes nothing, so a **backup of the very Project the user
	 * deleted** matches every field of the record perfectly. Every comparison says "remove".
	 *
	 * So the folder case does not delete unattended at all. The Project is listed, the user is told
	 * plainly that its deletion did not finish, and deleting it again is one gesture — visible and
	 * non-destructive, which is what ADR-0017 asks of the rest of the recovery chain. The record is
	 * seeded here exactly as `DeletedProjects.record` writes it, evidence included, so this is the
	 * *matching* record — the one every content check would have carried out.
	 */
	test('will not finish a deletion on its own in a folder, and says so', async ({ page }) => {
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'Amsterdam 1625');
		// Exactly the state the ~20% teardown window leaves: the record written, nothing removed.
		const manifest = await readInFolder(page, 'amsterdam-1625/project.json');
		await page.evaluate(
			([folder, text]) => {
				const was = JSON.parse(text as string);
				localStorage.setItem(
					`ballastella.deleted.${encodeURIComponent(`folder:${folder as string}`)}/${encodeURIComponent('amsterdam-1625')}`,
					JSON.stringify({
						formatVersion: 1,
						at: new Date().toISOString(),
						was: { name: was.name, updatedAt: was.updatedAt }
					})
				);
			},
			[PICKED_FOLDER, manifest]
		);

		await page.reload();
		await page.getByRole('button', { name: `Reopen “${PICKED_FOLDER}”` }).click();
		await inFolder(page);

		await expect(page.getByTestId('deletion-refused')).toContainText(
			'will not remove it on its own'
		);
		// Not one byte, and the Project is still there to be deleted deliberately.
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		expect(await everyPathInFolder(page)).toEqual(['amsterdam-1625/project.json']);

		// And the gesture that ends it is the ordinary one, right there in the list.
		await page.getByRole('button', { name: /^Delete/ }).click();
		await page.getByRole('button', { name: 'Delete Project' }).click();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);
		await expect.poll(() => everyPathInFolder(page)).toEqual([]);
	});

	/**
	 * ⚠ **THE REFUSAL WAS PERMANENT, AND ITS ONE OFFERED EXIT DESTROYED SOMEBODY ELSE'S PROJECT.**
	 *
	 * This is the case the refusal above exists for, played out: the user opens a **colleague's**
	 * `maps` folder, which happens to hold its own `amsterdam-1625`. The manifest is readable so the
	 * record is not cleared, the identity rule refuses, and the note is kept — and nothing ends it.
	 * No record expires, `Workspace.#claim` fires only when a Project is created or duplicated under
	 * that name, Workspace settings' discard is by construction unable to reach the Workspace that is
	 * *open*, and the panel's "Got it" is keyed on the report's contents, so the next startup builds a
	 * byte-identical report and shows the same warning again. Since round 3 made a refusal the only
	 * thing a folder Workspace ever reports, that is a warning at every visit for ever — whose one
	 * offered remedy, "delete it again", destroys the colleague's work.
	 *
	 * Asserted across a reload, because "it stops" is a claim about the *next* startup and the
	 * dismissal that does not survive one is precisely what was wrong.
	 */
	test('forgets a refused deletion’s note, and it stays forgotten across a reload', async ({
		page
	}) => {
		await chooseFolder(page);
		await inFolder(page);
		// Somebody else's Project, of the same name, in a folder of the same name. Nothing this build
		// can read tells it apart from the one the user deleted on their own machine.
		await createProject(page, 'Amsterdam 1625');
		// ⚠ **Two, and that is the point** (round 5). One refusal made three things unfalsifiable: the
		// "still showing" arm of the focus move, `bind:this={dismissButton}`, and the accessible names
		// — two buttons both reading "Forget this note", told apart only by prose in a `<p>` that is
		// associated with neither. A screen-reader user meets two identical controls and has to guess
		// which note each one throws away, for the one gesture here that is supposed to be safe.
		await createProject(page, 'Boston 1775');
		await page.evaluate((folder) => {
			for (const directory of ['amsterdam-1625', 'boston-1775']) {
				localStorage.setItem(
					`ballastella.deleted.${encodeURIComponent(`folder:${folder}`)}/${encodeURIComponent(directory)}`,
					JSON.stringify({
						formatVersion: 1,
						at: new Date().toISOString(),
						was: { name: 'Whatever it was called', updatedAt: '2026-08-08T09:00:00.000Z' }
					})
				);
			}
		}, PICKED_FOLDER);

		await page.reload();
		await page.getByRole('button', { name: `Reopen “${PICKED_FOLDER}”` }).click();
		await inFolder(page);
		await expect(page.getByTestId('deletion-refused')).toHaveCount(2);

		// Named by the folder each one is about, so they are distinguishable to somebody who cannot
		// see which paragraph the button sits in.
		await page
			.getByRole('button', { name: 'Forget the unfinished deletion of “boston-1775”' })
			.click();

		// The panel is still saying something, so focus stays inside it rather than falling to <body>.
		await expect(page.getByTestId('deletion-refused')).toHaveCount(1);
		expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
			'recovered-dismiss'
		);

		await page
			.getByRole('button', { name: 'Forget the unfinished deletion of “amsterdam-1625”' })
			.click();

		// The panel goes, because that refusal was the last of what it had to say — and focus lands
		// where a dismissal's does rather than on the element that has just been removed.
		await expect(page.getByTestId('recovered-edits')).toHaveCount(0);
		expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('MAIN');
		// Notes went and files did not: both Projects are untouched.
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Boston 1775' })).toBeVisible();
		expect(await everyPathInFolder(page)).toEqual([
			'amsterdam-1625/project.json',
			'boston-1775/project.json'
		]);

		// And it stays gone, which is the half a content-keyed dismissal could never deliver.
		await page.reload();
		await page.getByRole('button', { name: `Reopen “${PICKED_FOLDER}”` }).click();
		await inFolder(page);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		await expect(page.getByTestId('deletion-refused')).toHaveCount(0);
		expect(
			await page.evaluate(() =>
				Object.keys(localStorage).filter((key) => key.startsWith('ballastella.deleted.'))
			)
		).toEqual([]);
	});

	test('sweeps abandoned writes out of the folder when it is adopted', async ({ page }) => {
		// A laptop that died mid-autosave leaves a `.ballastella-tmp` — or Chromium's
		// `.ballastella-tmp.crswap` — inside the Project directory. `list` hides it, `delete` refuses
		// it, and `reclaimAbandonedWrites` had exactly one caller in the app: `Workspace.deleteProject`.
		// So in `~/Dropbox/maps/amsterdam-1625/` it is a file `git add -A` commits and Dropbox syncs,
		// and nothing removed it unless the whole Project was deleted. Choosing or reopening a folder is
		// the one moment a full sweep is cheap and expected.
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'Amsterdam 1625');

		await page.evaluate(async (folder) => {
			const root = await navigator.storage.getDirectory();
			const project = await (
				await root.getDirectoryHandle(folder)
			).getDirectoryHandle('amsterdam-1625');
			for (const litter of [
				'.project.json.abandoned.ballastella-tmp',
				'.project.json.crashed.ballastella-tmp.crswap'
			]) {
				const writable = await (
					await project.getFileHandle(litter, { create: true })
				).createWritable();
				await writable.write('half a document');
				await writable.close();
			}
		}, PICKED_FOLDER);
		expect(await everyPathInFolder(page)).toHaveLength(3);

		// Reopening is an adoption too, so the sweep has to be on that path and not only on picking.
		await page.reload();
		await page.getByRole('button', { name: `Reopen “${PICKED_FOLDER}”` }).click();
		await inFolder(page);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();

		await expect.poll(() => everyPathInFolder(page)).toEqual(['amsterdam-1625/project.json']);
	});

	test('keeps the folder when "Use browser storage instead" is the escape from an unreachable one', async ({
		page
	}) => {
		// The same button is two things: a deliberate switch, where forgetting the folder is right
		// because continuing to offer one the user has just left is nagging; and the escape hatch beside
		// "Locate Workspace folder again" when the Workspace cannot be reached. Forgetting on the second
		// costs a user whose external drive is unplugged their persistent grant, and sends them back
		// through the operating system's dialog to get it back.
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'Amsterdam 1625');
		await page.evaluate(async (folder) => {
			const root = await navigator.storage.getDirectory();
			await root.removeEntry(folder, { recursive: true });
		}, PICKED_FOLDER);
		await page.reload();
		await page.getByRole('button', { name: `Reopen “${PICKED_FOLDER}”` }).click();
		await expect(page.getByRole('alert')).toContainText('Workspace not reachable');

		await useBrowserStorage(page);

		await inBrowserStorage(page);
		// Still offered, because the folder has not been given up — only stepped away from.
		await expect(page.getByRole('button', { name: `Reopen “${PICKED_FOLDER}”` })).toBeVisible();
	});

	test('forgets the folder when browser storage is chosen deliberately', async ({ page }) => {
		// The other half of the same button, so the fix above is not just "never forget".
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'Amsterdam 1625');

		await useBrowserStorage(page);

		await inBrowserStorage(page);
		await expect(page.getByRole('button', { name: /^Reopen/ })).toHaveCount(0);
		await page.reload();
		// ⚠ **The gate, and it is the only thing that makes the line below an assertion.** This is the
		// sole check on the *persistence* half — line above covers the in-memory clear — and an
		// unhydrated page has no Reopen button either, so `toHaveCount(0)` resolved on the first poll
		// against a page that had not rendered anything yet. The deletion that kept it green: make
		// "forget the folder" clear the reactive state and skip the `localStorage` write. Waiting for
		// the hub to say which Workspace it is in is what the reload has to survive.
		await inBrowserStorage(page);
		await expect(page.getByRole('button', { name: /^Reopen/ })).toHaveCount(0);
	});

	test('writes a Project the browser backend reads with no conversion, once copied in', async ({
		page
	}) => {
		// The whole claim of ADR-0001's abstraction, end to end: identical layout, so a Project moved
		// between backends by hand — or into a zip, or into a git repository — is just files.
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'Amsterdam 1625');

		await page.evaluate(async (folder) => {
			const copy = async (from: FileSystemDirectoryHandle, to: FileSystemDirectoryHandle) => {
				for await (const [name, entry] of from.entries()) {
					if (entry.kind === 'file') {
						const bytes = await (await (entry as FileSystemFileHandle).getFile()).arrayBuffer();
						const writable = await (
							await to.getFileHandle(name, { create: true })
						).createWritable();
						await writable.write(bytes);
						await writable.close();
					} else {
						await copy(
							entry as FileSystemDirectoryHandle,
							await to.getDirectoryHandle(name, { create: true })
						);
					}
				}
			};
			const root = await navigator.storage.getDirectory();
			const source = await (
				await root.getDirectoryHandle(folder)
			).getDirectoryHandle('amsterdam-1625');
			// Into the **named** Workspace browser storage opens on, not into the OPFS root: since
			// ticket 12 the root holds several Workspaces and is not one itself.
			const workspace = await workspaceRoot();
			await copy(source, await workspace.getDirectoryHandle('amsterdam-1625', { create: true }));
		}, PICKED_FOLDER);

		await useBrowserStorage(page);

		await inBrowserStorage(page);
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
	});
});

test.describe('returning to a folder Workspace (ADR-0012)', () => {
	test.beforeEach(async ({ page }) => {
		await installDirectoryPicker(page);
		await page.goto('./');
		await emptyBrowserStorage(page);
		await forgetRememberedFolder(page);
		await page.evaluate(() => localStorage.clear());
		await page.reload();
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'Amsterdam 1625');
	});

	test('resumes only from a gesture, never automatically on load', async ({ page }) => {
		// The grant has lapsed, so resuming needs `requestPermission()` — which needs transient user
		// activation. Called automatically on load it fails silently, and the app appears to have lost
		// the folder; so on load nothing may be asked at all.
		await page.evaluate((key) => localStorage.setItem(key, 'prompt'), PERMISSION_KEY);
		await page.reload();

		await inBrowserStorage(page);
		expect(await grant(page)).toMatchObject({ permissionQueries: 0, permissionRequests: 0 });
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);

		// Reachable and operable from the keyboard alone, like every other control.
		const reopen = page.getByRole('button', { name: `Reopen “${PICKED_FOLDER}”` });
		await reopen.focus();
		await expect(reopen).toBeFocused();
		await page.keyboard.press('Enter');

		await inFolder(page);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		expect(await grant(page)).toMatchObject({
			permissionRequests: 1,
			activationAtRequest: [true]
		});
	});

	test('resumes with no prompt when the grant is still held', async ({ page }) => {
		await page.reload();

		await page.getByRole('button', { name: `Reopen “${PICKED_FOLDER}”` }).click();

		await inFolder(page);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		expect(await grant(page)).toMatchObject({ permissionRequests: 0 });
	});

	test('explains a declined folder and offers a retry, rather than falling back silently', async ({
		page
	}) => {
		await page.evaluate((key) => localStorage.setItem(key, 'denied'), PERMISSION_KEY);
		await page.reload();

		await page.getByRole('button', { name: `Reopen “${PICKED_FOLDER}”` }).click();

		const alert = page.getByRole('alert');
		await expect(alert).toContainText('Your Workspace folder was not opened');
		await expect(alert).toContainText('not been moved or lost');
		await expect(alert.getByRole('button', { name: 'Choose a folder again' })).toBeVisible();
		// Not silently on the other backend pretending to be the folder: the Workspace is plainly
		// browser storage, and the folder's Project is plainly not listed.
		await inBrowserStorage(page);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);
		// SvelteKit's error boundary would have replaced the page.
		await expect(page.getByRole('heading', { level: 1, name: 'Ballastella Editor' })).toBeVisible();
	});

	test('reports a folder that has been deleted as unreachable, with a way to locate it again', async ({
		page
	}) => {
		// A real deletion of the real directory the handle names, and a real `NotFoundError` from the
		// browser. ADR-0008: a normal state with a recovery, never an unhandled rejection.
		await page.evaluate(async (folder) => {
			const root = await navigator.storage.getDirectory();
			await root.removeEntry(folder, { recursive: true });
		}, PICKED_FOLDER);
		await page.reload();

		await page.getByRole('button', { name: `Reopen “${PICKED_FOLDER}”` }).click();

		const alert = page.getByRole('alert');
		await expect(alert).toContainText('Workspace not reachable');
		await expect(page.getByRole('heading', { level: 1, name: 'Ballastella Editor' })).toBeVisible();

		// ⚠ SPEC story 43. The roster marks the folder as unreachable on its own row, in words, and
		// names where the recovery is — the menu no longer carries a folder control, so a scholar who
		// opens it to ask which Workspace they are in has to be able to read that this one has gone.
		await openWorkspaceMenu(page);
		await expect(page.getByTestId('workspace-unreachable')).toContainText(
			'Unreachable. Workspace settings can locate it again.'
		);
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('workspace-switcher-menu')).toBeHidden();

		// And the recovery works: locating it again re-grants a folder of that name, which is now
		// empty because it really was deleted.
		await page.getByRole('button', { name: 'Locate Workspace folder again' }).click();

		await inFolder(page);
		await expect(page.getByText('No Projects yet')).toBeVisible();
	});
});

test.describe('the Workspace is the same one on every route', () => {
	test.beforeEach(async ({ page }) => {
		await installDirectoryPicker(page);
		await page.goto('./');
		await emptyBrowserStorage(page);
		await forgetRememberedFolder(page);
		await page.evaluate(() => localStorage.clear());
		await page.reload();
	});

	test('the Base Map pane records the author’s choice in the folder, not in browser storage', async ({
		page
	}) => {
		// The state this asserts against is one the suite above deliberately creates: the same
		// directory name in browser storage *and* in the folder. The deleted `/base-map/` reached for
		// OPFS directly while `/` went through the backing the user had chosen, and there was no shared
		// context, so the choice did not cross the route boundary — the OPFS namesake was written with
		// a fresh `updatedAt`, the indicator said "Saved", and the folder file was untouched. Ticket 04
		// leaves one route for both screens, so the switcher is on the Project itself and the class of
		// defect is structurally gone; the assertion stays, because the Workspace it writes into is
		// still the thing that has to be right.
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'Amsterdam 1625');

		// A namesake in browser storage, which is what makes the write assertable either way.
		await page.evaluate(async () => {
			const root = await workspaceRoot();
			const project = await root.getDirectoryHandle('amsterdam-1625', { create: true });
			const writable = await (
				await project.getFileHandle('project.json', { create: true })
			).createWritable();
			await writable.write(
				'{"formatVersion":1,"name":"In browser storage","updatedAt":"2020-01-01T00:00:00.000Z","layers":[],"baseMap":null}'
			);
			await writable.close();
		});

		await page.goto('./?p=amsterdam-1625');
		// A bookmarked Project on a route that cannot resume the folder without a gesture. The pane
		// has to say so and offer the gesture, rather than quietly using the other Workspace.
		const reopen = page.getByRole('button', { name: `Reopen “${PICKED_FOLDER}”` });
		await expect(reopen).toBeVisible();
		await reopen.click();

		await page.getByRole('combobox', { name: 'Base Map' }).selectOption('physical');
		await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');

		// The folder's copy carries the choice.
		expect(JSON.parse(await readInFolder(page, 'amsterdam-1625/project.json'))).toMatchObject({
			name: 'Amsterdam 1625',
			baseMap: 'physical'
		});
		// And browser storage's namesake is untouched, `updatedAt` included.
		const untouched = await page.evaluate(async () => {
			const root = await workspaceRoot();
			const project = await root.getDirectoryHandle('amsterdam-1625');
			return (await (await project.getFileHandle('project.json')).getFile()).text();
		});
		expect(JSON.parse(untouched)).toMatchObject({
			name: 'In browser storage',
			updatedAt: '2020-01-01T00:00:00.000Z',
			baseMap: null
		});
	});

	test('a Project page says the folder is not open yet, rather than "Project not found"', async ({
		page
	}) => {
		// Returning to a bookmarked `?p=` with a folder remembered but not resumed. The Project is in
		// the folder, so browser storage does not have it, so the page said "There is no Project called
		// amsterdam-1625 in this Workspace" — with no hint that the folder simply is not open yet and
		// no way to open it.
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'Amsterdam 1625');
		await page.goto('./?p=amsterdam-1625');

		const reopen = page.getByRole('button', { name: `Reopen “${PICKED_FOLDER}”` });
		await expect(reopen).toBeVisible();
		await reopen.click();

		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
	});

	test('a Project page reports an unreachable Workspace with a locate-again action', async ({
		page
	}) => {
		// Ticket 12's acceptance criterion 7 on the Project page rather than only on the hub. The
		// implementing agent read this as ticket 02's; it is not — in OPFS the root cannot vanish, and
		// making a deletable folder the store is precisely what this ticket did.
		//
		// What the page said before the fix was worse than the reported "Opening…": "There is no
		// Project called amsterdam-1625 in this Workspace." A deleted Workspace folder makes
		// `getDirectoryHandle('amsterdam-1625')` raise the same `NotFoundError` as a Project that
		// really has gone, so the two are one failure on the read path — and the page picked the guess
		// that tells a scholar their work does not exist while it sits in a folder on their desk, with
		// the wrong recovery offered and no locate-again at all.
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');

		await page.evaluate(async (folder) => {
			const root = await navigator.storage.getDirectory();
			await root.removeEntry(folder, { recursive: true });
		}, PICKED_FOLDER);
		await page.reload();
		await page.getByRole('button', { name: `Reopen “${PICKED_FOLDER}”` }).click();

		const alert = page.getByRole('alert');
		await expect(alert).toContainText('Workspace not reachable');
		await expect(page.getByText('Opening…')).toHaveCount(0);
		await expect(
			alert.getByRole('button', { name: 'Locate Workspace folder again' })
		).toBeVisible();
	});
});

test.describe('a browser with no File System Access API (SPEC story 4)', () => {
	test.beforeEach(async ({ page }) => {
		await hideDirectoryPicker(page);
		await page.goto('./');
		await emptyBrowserStorage(page);
		await forgetRememberedFolder(page);
		await page.reload();
	});

	test('offers no folder at all, and browser storage keeps working with no error', async ({
		page
	}) => {
		// Absent from the bar's own screens *and* from the settings dialog the offer moved into — where
		// the browser has no picker the option is simply not there (ADR-0001).
		await expect(page.getByTestId('settings-choose-folder')).toHaveCount(0);
		await openWorkspaceSettings(page);
		await expect(page.getByTestId('settings-choose-folder')).toHaveCount(0);
		await closeWorkspaceSettings(page);
		await expect(page.getByRole('button', { name: /^Reopen/ })).toHaveCount(0);
		await inBrowserStorage(page);

		await createProject(page, 'Amsterdam 1625');

		// Nothing is disabled, nothing is explained away, and nothing has gone wrong.
		await expect(page.getByRole('alert')).toHaveCount(0);
		expect(await browserStorageEntries(page)).toEqual(['amsterdam-1625']);
	});
});

test.describe('an interrupted write to a real folder (ADR-0017 rule 4)', () => {
	test.beforeEach(async ({ page }) => {
		await installDirectoryPicker(page);
		await page.goto('./');
		await emptyBrowserStorage(page);
		await forgetRememberedFolder(page);
		await page.evaluate(() => localStorage.clear());
		await page.reload();
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'Amsterdam 1625');
	});

	test('leaves the previous project.json intact, parseable, and with no litter beside it', async ({
		page
	}) => {
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');

		// Fail the next write where a full disk is reported, restoring itself as it fires so exactly
		// one write fails. Injected at the browser API: the app cannot tell it is being lied to.
		await page.evaluate(() => {
			window.e2eInterruptedWrites = 0;
			const close = FileSystemWritableFileStream.prototype.close;
			FileSystemWritableFileStream.prototype.close = function () {
				FileSystemWritableFileStream.prototype.close = close;
				window.e2eInterruptedWrites = (window.e2eInterruptedWrites ?? 0) + 1;
				return Promise.reject(new DOMException('the disk is full', 'QuotaExceededError'));
			};
		});

		await (await projectNameField(page)).fill('Amsterdam 1626');
		// Force the write instead of waiting out the debounce, and then wait for the interruption to
		// have actually happened. Without this the assertions below are satisfied by the state
		// *before* the write — the edit is legitimately "unsaved" while its timer is still running and
		// the file legitimately still holds the old name — so every one of them passed with the
		// interruption never reached. Verified by breaking the cleanup and watching this fail.
		await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
		await expect.poll(() => page.evaluate(() => window.e2eInterruptedWrites)).toBe(1);

		// ADR-0017 rule 5: the indicator is the user's only signal, and it must not read "Saved".
		await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'unsaved');
		const survivor = await readInFolder(page, 'amsterdam-1625/project.json');
		expect(JSON.parse(survivor)).toMatchObject({ formatVersion: 1, name: 'Amsterdam 1625' });
		expect(await everyPathInFolder(page)).toEqual(['amsterdam-1625/project.json']);
	});
});

// ⚠ **A folder Workspace is one of the user's own, and the review copy's first exit has to lead back
// to it** (ticket 14, ADR-0024, workspace-and-layers SPEC story 93).
//
// This is the case the first cut of ticket 14 got wrong, and it got it wrong in the most expensive
// direction. "Which Workspace do I go back to" was recorded only for *browser-backed* Workspaces, so
// a scholar whose Workspace is a folder on their own disk — ADR-0001's capability upgrade, and the
// only backing where the files are theirs to see — was never recorded as being in one of their own at
// all. Pressing "Back to my Workspace" then ran `openWorkspace('My Workspace')`, which **creates**,
// and dropped them into an empty OPFS Workspace while the banner announced they were back in their
// own. Their real work was in the folder, untouched, off screen, with nothing saying so. The hub's
// open-bundle button is not gated on backing, so the whole path was reachable.
//
// It lives in this file rather than in `editor-transfer.e2e.ts` because a real
// `FileSystemDirectoryHandle` is what makes it a test at all, and the picker that hands one back is
// here.
test.describe('a bundle opened from a folder Workspace (ticket 14)', () => {
	test.beforeEach(async ({ page }) => {
		await installDirectoryPicker(page);
		await page.goto('./');
		await emptyBrowserStorage(page);
		await forgetRememberedFolder(page);
		await page.evaluate(() => localStorage.clear());
		await page.reload();
	});

	/** Every directory in the OPFS root, which is where Review Workspaces are made. */
	const opfsWorkspaces = (page: Page): Promise<string[]> =>
		page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const names: string[] = [];
			for await (const [name, handle] of root.entries()) {
				if (handle.kind === 'directory') names.push(name);
			}
			return names.sort();
		});

	/** A one-Project bundle, built in Node so the app is opening one it did not write. */
	const bundle = async (): Promise<{ name: string; mimeType: string; buffer: Buffer }> => {
		const { packTar } = await import('modern-tar');
		const files: Record<string, string> = {
			'project.json': JSON.stringify({
				formatVersion: 1,
				name: 'Somebody else’s Amsterdam',
				updatedAt: '2026-03-04T11:22:33.000Z',
				layers: [],
				baseMap: null
			}),
			'annotations/notes.geojson': '{"type":"FeatureCollection","features":[]}'
		};
		const encode = (text: string) => new TextEncoder().encode(text);
		return {
			name: 'assignment 7.project.tar',
			mimeType: 'application/x-tar',
			buffer: Buffer.from(
				await packTar(
					Object.entries(files).map(([name, text]) => ({
						header: { name, size: encode(text).length, type: 'file' as const },
						body: encode(text)
					}))
				)
			)
		};
	};

	test('goes back to the folder, not to an OPFS Workspace invented for the purpose', async ({
		page
	}) => {
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'My own work');

		await page.getByTestId('open-bundle').click();
		await page
			.getByRole('dialog', { name: 'Open a Project someone sent me' })
			.getByLabel('Project bundle')
			.setInputFiles(await bundle());
		await page.getByTestId('confirm-open-bundle').click();

		// Into a review copy in browser storage, whatever the current backing is: a folder cannot make
		// a second Workspace by itself, and a subdirectory of this one would be a Workspace inside a
		// Workspace. The folder is untouched.
		const banner = page.getByTestId('review-banner');
		await expect(banner).toBeVisible();
		await expect(banner).toContainText('Somebody else’s Amsterdam');
		expect(await everyPathInFolder(page)).toEqual(['my-own-work/project.json']);

		await page.getByTestId('leave-review').click();

		// **Back in the folder**, and said so in the words the user reads. Not "My Workspace".
		await expect(banner).toBeHidden();
		await inFolder(page);
		await expect(page.getByRole('link', { name: 'My own work' })).toBeVisible();
		await expect(page.getByTestId('review-announcement')).toContainText(
			`You are back in your own Workspace, “${PICKED_FOLDER}”.`
		);
		// The default OPFS Workspace holds no Project, because the user's own work was never in browser
		// storage at all. It *exists* — the app makes it on load, before a folder is ever chosen — so
		// this corroborates rather than carries: what fails when the exit invents a Workspace to land in
		// is `inFolder` and the announcement above, and what this adds is that nothing of the user's
		// went there. Read without creating, so the claim is about what the app did and not about what
		// the assertion did on its way to being made.
		expect(await browserStorageEntries(page)).toEqual([]);
		expect(await opfsWorkspaces(page)).toContain('assignment 7');
		expect(await everyPathInFolder(page)).toEqual(['my-own-work/project.json']);
	});

	test('discards the review copy and returns to the folder', async ({ page }) => {
		await chooseFolder(page);
		await createProject(page, 'My own work');

		await page.getByTestId('open-bundle').click();
		await page
			.getByRole('dialog', { name: 'Open a Project someone sent me' })
			.getByLabel('Project bundle')
			.setInputFiles(await bundle());
		await page.getByTestId('confirm-open-bundle').click();
		await expect(page.getByTestId('review-banner')).toBeVisible();

		await page.getByTestId('discard-review').click();
		await page.getByTestId('confirm-discard-review').click();

		await expect(page.getByTestId('review-announcement')).toContainText('Discarded');
		await inFolder(page);
		await expect(page.getByRole('link', { name: 'My own work' })).toBeVisible();
		await expect(page.getByTestId('review-banner')).toBeHidden();
		// The review copy is gone, and the folder is exactly as it was.
		expect(await opfsWorkspaces(page)).not.toContain('assignment 7');
		expect(await everyPathInFolder(page)).toEqual(['my-own-work/project.json']);
	});

	// ⚠ **The arrangement in which "leave, then delete" leaves nothing, and deletes the Workspace the
	// user is still inside.** Every step below is one the app offers and none of them is a mistake:
	//
	//   1. a browser Workspace called "assignment 7" — so that is where "back to my Workspace" points;
	//   2. a switch to a folder, which carries that name across unchanged and is meant to;
	//   3. deleting the OPFS "assignment 7" from settings, which is legal because it is not open;
	//   4. opening `assignment 7.project.tar`, whose review copy takes the name that just came free;
	//   5. Discard, with the folder grant refused.
	//
	// The exit reopens the folder, cannot, and falls back to the browser Workspace it remembers —
	// which is now the review copy's own name, so the switch is a no-op, and the removal that follows
	// deleted a Workspace with a live `EditorSession` on it. That is the failure the delete guard
	// exists for, reached by the one caller that used to go round it: an `Autosave` whose next flush
	// recreates the directory, and a user still inside a review copy the app has announced as gone.
	test('leaves the review copy even when it holds the name the exit goes back to', async ({
		page
	}) => {
		await createWorkspace(page, 'assignment 7');
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'My own work');

		// Legal: it is not the Workspace being looked out of, so settings offers it.
		await openWorkspaceSettings(page);
		await page.getByTestId('delete-workspace').filter({ hasText: 'assignment 7' }).click();
		await page.getByTestId('confirm-delete-workspace').click();
		await expect(page.getByTestId('workspace-delete-outcome')).toContainText('assignment 7');
		await closeWorkspaceSettings(page);

		await page.getByTestId('open-bundle').click();
		await page
			.getByRole('dialog', { name: 'Open a Project someone sent me' })
			.getByLabel('Project bundle')
			.setInputFiles(await bundle());
		await page.getByTestId('confirm-open-bundle').click();
		await expect(page.getByTestId('review-banner')).toBeVisible();
		// The name really did come free and the review copy really did take it, or the rest of this
		// spec is about a case that cannot happen.
		expect(await opfsWorkspaces(page)).toContain('assignment 7');

		// The grant is withdrawn between opening and discarding — a browser restart, a revoked
		// permission, or a user answering the prompt the other way.
		await page.evaluate((key) => localStorage.setItem(key, 'denied'), PERMISSION_KEY);
		await page.getByTestId('discard-review').click();
		await page.getByTestId('confirm-discard-review').click();

		await expect(page.getByTestId('review-announcement')).toContainText('Discarded');
		// **Out of it.** A banner still on screen after this is a live session on a deleted directory.
		await expect(page.getByTestId('review-banner')).toBeHidden();
		// Somewhere real and of the user's own: a suffixed empty Workspace beside the doomed name, which
		// is the only landing that is neither the review copy nor a refusal to leave it.
		await expectWorkspaceNamed(page, 'assignment 7 (2)');
		const after = await opfsWorkspaces(page);
		expect(after).not.toContain('assignment 7');
		expect(after).toContain('assignment 7 (2)');
		// And the folder — the thing that actually holds their work — is untouched throughout.
		expect(await everyPathInFolder(page)).toEqual(['my-own-work/project.json']);
		// The folder that would not reopen is said where the user is, not only on the settings screen
		// they are not looking at. `#switchTo` clears `problem`, so this used to be wiped by the very
		// fallback that made it worth saying.
		await expect(page.getByTestId('review-announcement')).toContainText(
			'was not given permission to read and write the folder'
		);
	});
});
