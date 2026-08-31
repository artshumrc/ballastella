import { DEFAULT_WORKSPACE, expect, test } from './support/test.js';
import { type Page } from '@playwright/test';

import { projectNameField } from './support/project-screen';
import {
	createFolderWorkspace,
	createWorkspace,
	deleteWorkspace,
	renameWorkspace,
	expectWorkspaceNamed,
	openWorkspaceMenu,
	openTheDoor,
	closeTheDoor,
	seedGitHubCredential,
	switchToWorkspace,
	checkRemoteStatus,
	openPublishFromTheDoor,
	updateFromGitHub
} from './support/workspace';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { routeGitHubHosts } from './support/github-hosts.js';

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
 * Seam 2 for the File System Access Workspace: the running app, a real browser, real IndexedDB,
 * real user gestures, and a real `FileSystemDirectoryHandle`.
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
 * it — the part that can only be exercised in a real browser.
 */

/**
 * The Workspace key the app files the picked folder's durable records under.
 *
 * ⚠ **Read out of the installation database, never spelled.** A folder Workspace is keyed by a
 * minted reference (ADR-0042), so a record seeded at `folder:<folderName>` would belong to a
 * Workspace that does not exist and the app would rightly never look at it. The record the app wrote
 * when the folder was chosen is what says which reference this folder got.
 */
function folderWorkspaceKey(page: Page): Promise<string> {
	return page.evaluate(
		(folderName) =>
			new Promise<string>((resolve, reject) => {
				const open = indexedDB.open('ballastella');
				open.onerror = () => reject(open.error ?? new Error('no installation database'));
				open.onsuccess = () => {
					const database = open.result;
					const all = database
						.transaction('workspace', 'readonly')
						.objectStore('workspace')
						.getAll();
					all.onerror = () => {
						database.close();
						reject(all.error ?? new Error('the Workspace store could not be read'));
					};
					all.onsuccess = () => {
						database.close();
						const held = all.result as { reference?: string; folderName?: string }[];
						const record = held.find((one) => one.folderName === folderName);
						if (!record?.reference) reject(new Error(`no record for ${folderName}`));
						else resolve(`folder:${record.reference}`);
					};
				};
			}),
		PICKED_FOLDER
	);
}

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
		// The whole of browser storage, which is **every named Workspace** rather than one — so no test
		// can see another's, whichever Workspace it was in.
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

/** Every file inside the picked folder, with its text — for a before-and-after comparison. */
async function folderContents(page: Page): Promise<Record<string, string>> {
	const paths = await everyPathInFolder(page);
	return Object.fromEntries(
		await Promise.all(paths.map(async (path) => [path, await readInFolder(page, path)] as const))
	);
}

/** Every file in a named browser Workspace, with its text. Read behind the app's back. */
async function browserStorageContents(
	page: Page,
	workspace: string
): Promise<Record<string, string>> {
	return page.evaluate(async (name) => {
		const walk = async (
			directory: FileSystemDirectoryHandle,
			prefix: string
		): Promise<[string, string][]> => {
			const found: [string, string][] = [];
			for await (const [entry, handle] of directory.entries()) {
				if (handle.kind === 'file') {
					found.push([
						`${prefix}${entry}`,
						await (await (handle as FileSystemFileHandle).getFile()).text()
					]);
				} else {
					found.push(...(await walk(handle as FileSystemDirectoryHandle, `${prefix}${entry}/`)));
				}
			}
			return found;
		};
		const root = await navigator.storage.getDirectory();
		try {
			return Object.fromEntries(await walk(await root.getDirectoryHandle(name), ''));
		} catch {
			return {};
		}
	}, workspace);
}

/** Put files in the folder the picker will hand back, before it is ever picked. */
async function seedFolder(page: Page, files: Record<string, string>): Promise<void> {
	await page.evaluate(
		async ([folder, seeded]) => {
			const root = await navigator.storage.getDirectory();
			const directory = await root.getDirectoryHandle(folder as string, { create: true });
			for (const [name, text] of Object.entries(seeded as Record<string, string>)) {
				const file = await directory.getFileHandle(name, { create: true });
				const writable = await file.createWritable();
				await writable.write(text as string);
				await writable.close();
			}
		},
		[PICKED_FOLDER, files] as const
	);
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
 * Every directory at the OPFS root, which is one per browser-storage Workspace.
 *
 * ⚠ **The directory names, not the names on the roster.** Renaming a Workspace gives it a label and
 * moves nothing (ADR-0042), so this is what says the directory it was made with is still the one
 * holding its work.
 */
async function browserWorkspaceNames(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		return names.sort();
	});
}

/**
 * Every top-level name in the **named** Workspace browser storage opens on, or `null` when there is
 * no such Workspace.
 *
 * The OPFS root holds several named Workspaces, so "what is in browser storage" is a question about
 * one of them — and the picked folder, which this file's stubbed picker also creates in the root, is
 * deliberately not one of them.
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
 * Take the picked folder as a Workspace, from where that is now done.
 *
 * ⚠ **A folder is a *kind of Workspace*, made from the roster, rather than a mode the application
 * is switched into** (ADR-0042). It is named PICKED_FOLDER here so that every assertion about which
 * Workspace is open reads the same as it did when a folder Workspace's name was its directory's:
 * what changed is that the name is the author's own now, and the directory's name is shown beneath
 * it. Everything about the *grant* below is unchanged.
 */
const chooseFolder = async (page: Page) => {
	await createFolderWorkspace(page, PICKED_FOLDER);
};

/**
 * The picked folder's row in the roster — the one place a folder Workspace is opened from.
 *
 * ⚠ **Scoped by kind, because this file's stubbed picker hands back a directory in the OPFS root**,
 * which is where the named browser Workspaces live — so the app quite correctly lists a *browser*
 * Workspace of the same name beside the folder one. That is an artefact of the only source of a real
 * `FileSystemDirectoryHandle` an automated browser has, and it is the reason a name is not enough to
 * name a row here.
 */
const folderRow = (page: Page) =>
	page.locator('[data-testid="switch-workspace"][data-kind="folder"]');

/**
 * Open the picked folder from its row — one press, and the browser's own grant.
 *
 * ⚠ **A folder that is not open is an ordinary row** (ADR-0042). There is no "reopen the folder from
 * last visit" offer anywhere any more: that offer stood on every screen for ever, could be cleared
 * by no control that was rendered in the state it applied to, and made every Project in every
 * Workspace unopenable. Opening still costs a gesture, because a browser grants a directory only
 * when the user asks.
 */
const openFolderFromRoster = async (page: Page) => {
	await openWorkspaceMenu(page);
	await folderRow(page).click();
};

/**
 * Go back to the browser Workspace, which is an ordinary row in the roster.
 *
 * ⚠ **There is no *Use browser storage instead* any more** (ADR-0042). It was half of a toggle
 * between two backings, and a backing is a property of each listed Workspace rather than a mode:
 * switching to a browser Workspace is pressing its row, and the folder stays on the list.
 */
const useBrowserStorage = async (page: Page) => {
	await switchToWorkspace(page, DEFAULT_WORKSPACE);
};

/**
 * Which Workspace is open, read off the **navigation bar**.
 *
 * The bar names it on every screen, which is a better place to ask than the settings
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
		await openWorkspaceMenu(page);
		await page.getByTestId('new-workspace').click();
		await page.getByTestId('new-workspace-name').fill(PICKED_FOLDER);
		await page.getByTestId('new-workspace-folder').check();
		await page.getByTestId('create-workspace').focus();
		await page.keyboard.press('Enter');

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

		// Not through {@link chooseFolder}, which waits for the Workspace it asked for: a cancelled
		// gesture makes none, and what is asserted is that nothing at all happened.
		await openWorkspaceMenu(page);
		await page.getByTestId('new-workspace').click();
		await page.getByTestId('new-workspace-name').fill(PICKED_FOLDER);
		await page.getByTestId('new-workspace-folder').check();
		await page.getByTestId('create-workspace').click();

		await inBrowserStorage(page);
		await expect(page.getByRole('alert')).toHaveCount(0);
	});

	/**
	 * ⚠ **The one way work that already exists reaches a folder** (ADR-0042).
	 *
	 * A Backup restores into browser storage, hydrating a Remote makes a browser Workspace, and a
	 * folder Workspace can otherwise only be made new and empty — so without *Move this Workspace
	 * into a folder…* there is no route at all from the Projects a scholar has to files they can see.
	 * It is a one-way move rather than half of a toggle: *Use browser storage instead* is gone,
	 * because switching to a browser Workspace is pressing its row in the roster.
	 *
	 * Seam 2, and only what a browser can settle. The copy itself — every file, byte for byte, an
	 * Alignment through its one writer, and a non-empty destination refused with nothing written — is
	 * `copy-workspace-files.test.ts`'s at Seam 1, and which control is offered for which kind of
	 * Workspace is `keeping-your-work.dom.test.ts`'s at Seam 1c. What no seam below can falsify is
	 * two real stores meeting at one press: that a real granted `FileSystemDirectoryHandle` ends up
	 * holding what a real OPFS Workspace held, that the Workspace it came from is still there with
	 * every byte in it, and that the app is now looking at the folder.
	 */
	test('moves this Workspace into a folder, preserving every file and keeping the original', async ({
		page
	}) => {
		await createProject(page, 'In Browser');
		const before = await browserStorageContents(page, DEFAULT_WORKSPACE);
		expect(Object.keys(before)).toEqual(['in-browser/project.json']);

		await page.getByTestId('move-into-folder').click();

		// Switched into the folder, which the bar says on every screen — and the Project is listed
		// there, which is `listProjects` over the File System Access adapter rather than a path
		// comparison.
		await inFolder(page);
		await expect(page.getByRole('link', { name: 'In Browser' })).toBeVisible();

		// ⚠ **Byte for byte, in both directions.** The folder holds what the Workspace held, and the
		// Workspace it came from is untouched: nothing is deleted by a move, so an author who looks in
		// the folder and does not like what they see still has their work.
		expect(await folderContents(page)).toEqual(before);
		expect(await browserStorageContents(page, DEFAULT_WORKSPACE)).toEqual(before);

		// Said in words, including that the copy in browser storage is still listed.
		await expect(page.getByTestId('transfer-outcome')).toContainText(PICKED_FOLDER);
		await expect(page.getByTestId('transfer-outcome')).toContainText('browser storage');

		// And it is an ordinary row in the roster afterwards, which is what "not open" means now.
		await useBrowserStorage(page);
		await inBrowserStorage(page);
		await expect(page.getByRole('link', { name: 'In Browser' })).toBeVisible();
	});

	// The refusal that keeps a move from being a merge: ADR-0023 has one Alignment per Map Image in a
	// Workspace, so laying one Workspace over another would overwrite an Alignment the author's own
	// Projects are drawn by. Nothing is written, and the Workspace does not change.
	test('refuses a folder that already holds files, and says so', async ({ page }) => {
		await createProject(page, 'In Browser');
		await seedFolder(page, { 'notes.txt': "somebody else's" });

		await page.getByTestId('move-into-folder').click();

		await expect(page.getByTestId('transfer-problem')).toContainText('already holds files');
		await inBrowserStorage(page);
		expect(await folderContents(page)).toEqual({ 'notes.txt': "somebody else's" });
	});

	/**
	 * ⚠ **THE WHOLE OF THE DESIGN DECISION, IN THE PLACE IT APPLIES.**
	 *
	 * A folder Workspace's key is `folder:<folder name>` — a name the user can put on any folder on
	 * any drive — because the browser offers a page no stable identifier for a picked directory
	 * (ADR-0017), and ADR-0023 explicitly invites synced folders, colleagues' copies and second
	 * checkouts. An unattended recursive delete cannot be made safe *there* by comparing what is
	 * inside the directory against what the record captured: Dropbox, Drive, rsync and `cp -a`
	 * reproduce `project.json` byte for byte, and ADR-0010 guarantees that opening a Project writes
	 * nothing, so a **backup of the very Project the user deleted** matches every field of the record
	 * perfectly. Every comparison says "remove".
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
			([workspace, text]) => {
				const was = JSON.parse(text as string);
				localStorage.setItem(
					`ballastella.deleted.${encodeURIComponent(workspace as string)}/${encodeURIComponent('amsterdam-1625')}`,
					JSON.stringify({
						formatVersion: 1,
						at: new Date().toISOString(),
						was: { name: was.name, updatedAt: was.updatedAt }
					})
				);
			},
			[await folderWorkspaceKey(page), manifest]
		);

		await page.reload();
		await openFolderFromRoster(page);
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
		await page.evaluate(
			(workspace) => {
				for (const directory of ['amsterdam-1625', 'boston-1775']) {
					localStorage.setItem(
						`ballastella.deleted.${encodeURIComponent(workspace)}/${encodeURIComponent(directory)}`,
						JSON.stringify({
							formatVersion: 1,
							at: new Date().toISOString(),
							was: { name: 'Whatever it was called', updatedAt: '2026-08-08T09:00:00.000Z' }
						})
					);
				}
			},
			await folderWorkspaceKey(page)
		);

		await page.reload();
		await openFolderFromRoster(page);
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
		await openFolderFromRoster(page);
		await inFolder(page);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		await expect(page.getByTestId('deletion-refused')).toHaveCount(0);
		expect(
			await page.evaluate(() =>
				Object.keys(localStorage).filter((key) => key.startsWith('ballastella.deleted.'))
			)
		).toEqual([]);
	});

	test('sweeps abandoned writes and an unfinished Import out of the folder when it is adopted', async ({
		page
	}) => {
		// A laptop that died mid-autosave leaves a `.ballastella-tmp` — or Chromium's
		// `.ballastella-tmp.crswap` — inside the Project directory. `list` hides it, `delete` refuses
		// it, and `reclaimAbandonedWrites` had exactly one caller in the app: `Workspace.deleteProject`.
		// So in `~/Dropbox/maps/amsterdam-1625/` it is a file `git add -A` commits and Dropbox syncs,
		// and nothing removed it unless the whole Project was deleted. Choosing or reopening a folder is
		// the one moment a full sweep is cheap and expected.
		//
		// **And it is the moment an unfinished Import is swept, which is the same claim about a folder.**
		// An Import writes its provisional files at ordinary paths under one durable marker, so a tab
		// that died half way through leaves a `project.json` in a real directory on somebody's disk —
		// and in a folder Workspace that directory is *visible to the user in Finder*. Both kinds of
		// residue are what adoption exists to resolve, and the engine that resolves them is asserted per
		// boundary in `project-import-recovery.test.ts`; what only a browser can show is that a folder
		// Workspace really goes through it.
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'Amsterdam 1625');

		await page.evaluate(async (folder) => {
			const root = await navigator.storage.getDirectory();
			const workspace = await root.getDirectoryHandle(folder);
			const put = async (path: string, text: string) => {
				const segments = path.split('/');
				let directory = workspace;
				for (const segment of segments.slice(0, -1)) {
					directory = await directory.getDirectoryHandle(segment, { create: true });
				}
				const handle = await directory.getFileHandle(segments[segments.length - 1] as string, {
					create: true
				});
				const writable = await handle.createWritable();
				await writable.write(text);
				await writable.close();
			};
			for (const litter of [
				'amsterdam-1625/.project.json.abandoned.ballastella-tmp',
				'amsterdam-1625/.project.json.crashed.ballastella-tmp.crswap'
			]) {
				await put(litter, 'half a document');
			}
			// An Import of “Boston 1775” that had written its whole closure and died before the marker
			// said so, so every one of these is provisional and none of it is the user's.
			const provisional = {
				'boston-1775/project.json': '{"formatVersion":1,"name":"Boston 1775","layers":[]}',
				'boston-1775/annotations/wharves.geojson': '{"type":"FeatureCollection","features":[]}',
				'images/img-imported/info.json': '{"width":2048,"height":2048}'
			};
			for (const [path, text] of Object.entries(provisional)) await put(path, text);
			await put(
				'import.json',
				JSON.stringify({
					formatVersion: 1,
					transaction: 'e2e-folder-import',
					state: 'writing',
					project: 'boston-1775/project.json',
					paths: Object.keys(provisional).sort(),
					startedAt: '2026-08-22T10:00:00.000Z'
				})
			);
		}, PICKED_FOLDER);
		expect(await everyPathInFolder(page)).toHaveLength(7);

		// Reopening is an adoption too, so the sweep has to be on that path and not only on picking.
		await page.reload();
		await openFolderFromRoster(page);
		await inFolder(page);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();

		// The half-arrived Project was never on the hub: the Workspace does not open until the marker
		// is resolved, so there is no frame in which it could have been listed.
		await expect(page.getByRole('link', { name: 'Boston 1775' })).toHaveCount(0);
		await expect.poll(() => everyPathInFolder(page)).toEqual(['amsterdam-1625/project.json']);
	});

	test('lets the author switch away from an unreachable folder, keeping it on the roster', async ({
		page
	}) => {
		// ⚠ **A broken folder is not a trap** (story 93). The escape is an ordinary row in the roster —
		// there is no "use browser storage instead" any more, because a backing is a property of each
		// listed Workspace rather than a mode the application is in. What must not happen is the folder
		// being given up on the way out: a user whose external drive is unplugged would lose their
		// persistent grant and be sent back through the operating system's dialog to get it back.
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'Amsterdam 1625');
		await page.evaluate(async (folder) => {
			const root = await navigator.storage.getDirectory();
			await root.removeEntry(folder, { recursive: true });
		}, PICKED_FOLDER);
		await page.reload();
		await openFolderFromRoster(page);
		await expect(page.getByRole('alert')).toContainText('Workspace not reachable');

		await useBrowserStorage(page);

		await inBrowserStorage(page);
		// Still on the roster, because the folder has not been given up — only stepped away from. A
		// Workspace that is not open is an ordinary row (ADR-0042), which is what makes switching away
		// from an unreachable one a way out rather than a trap.
		await openWorkspaceMenu(page);
		await expect(folderRow(page)).toBeVisible();
		await page.keyboard.press('Escape');
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
			// Into the **named** Workspace browser storage opens on, not into the OPFS root: the root
			// holds several Workspaces and is not one itself.
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
		await openWorkspaceMenu(page);
		const row = folderRow(page);
		await row.focus();
		await expect(row).toBeFocused();
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

		await openFolderFromRoster(page);

		await inFolder(page);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		expect(await grant(page)).toMatchObject({ permissionRequests: 0 });
	});

	test('explains a declined folder and offers a retry, rather than falling back silently', async ({
		page
	}) => {
		await page.evaluate((key) => localStorage.setItem(key, 'denied'), PERMISSION_KEY);
		await page.reload();

		await openFolderFromRoster(page);

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

		await openFolderFromRoster(page);

		const alert = page.getByRole('alert');
		await expect(alert).toContainText('Workspace not reachable');
		await expect(page.getByRole('heading', { level: 1, name: 'Ballastella Editor' })).toBeVisible();

		// ⚠ The roster marks the open Workspace as unreachable on its own row, in words, and names
		// where the recovery is — so a scholar who opens the list to ask which Workspace they are in
		// has to be able to read that this one has gone.
		await openWorkspaceMenu(page);
		await expect(page.getByTestId('workspace-unreachable')).toContainText(
			'Unreachable. The notice on this screen can locate it again.'
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

/**
 * The roster: every Workspace of either kind in one list, each opened, renamed or deleted from its
 * own row (ADR-0042).
 *
 * Seam 2 because it is made of the three things only a browser has: a real granted
 * `FileSystemDirectoryHandle`, the installation's own IndexedDB record that gives that folder an
 * identity of its own, and a real OPFS Workspace listed beside it. There is no `WorkspaceStorage`
 * harness below this, and a roster asserted against a fake store would be a list agreeing with the
 * fake that produced it.
 */
test.describe('the Workspace roster', () => {
	test.beforeEach(async ({ page }) => {
		await installDirectoryPicker(page);
		await page.goto('./');
		await emptyBrowserStorage(page);
		await forgetRememberedFolder(page);
		await page.evaluate(() => localStorage.clear());
		await page.reload();
	});

	test('lists both kinds in one list, each opened and renamed from its own row', async ({
		page
	}) => {
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'In the folder');
		await useBrowserStorage(page);
		await inBrowserStorage(page);

		// One list, both kinds, and the folder is an ordinary row rather than a mode the app is in.
		await openWorkspaceMenu(page);
		await expect(folderRow(page)).toHaveCount(1);
		await expect(
			page.locator('[data-testid="switch-workspace"][data-kind="browser"]').filter({
				hasText: DEFAULT_WORKSPACE
			})
		).toBeVisible();
		// The directory's own name is shown beneath the label, because it says which *place* this is —
		// never as identity, which is the minted reference nobody sees (ADR-0042).
		await expect(page.getByTestId('workspace-folder-name')).toHaveText(PICKED_FOLDER);
		await page.keyboard.press('Escape');

		// Renamed from its row, and nothing on disk moves: identity is the reference, never the name.
		await openWorkspaceMenu(page);
		await folderRow(page).locator('xpath=following-sibling::button[1]').click();
		await page.getByTestId('rename-workspace-name').fill('Amsterdam sheets');
		await page.getByTestId('save-workspace-name').click();
		await expect(page.getByTestId('workspace-announcement')).toContainText('Amsterdam sheets');
		await openWorkspaceMenu(page);
		await expect(
			page.getByTestId('switch-workspace').filter({ hasText: 'Amsterdam sheets' })
		).toBeVisible();
		await expect(page.getByTestId('workspace-folder-name')).toHaveText(PICKED_FOLDER);

		// Opened from its row — one press, and the browser's own grant.
		await page.getByTestId('switch-workspace').filter({ hasText: 'Amsterdam sheets' }).click();
		await expectWorkspaceNamed(page, 'Amsterdam sheets');
		await expect(page.getByRole('link', { name: 'In the folder' })).toBeVisible();
		// The rename is the author's, so the folder on disk still answers to the name the operating
		// system gave it and every file in it is exactly where it was.
		expect(await everyPathInFolder(page)).toEqual(['in-the-folder/project.json']);

		// And it survives the reload, because the name is on the folder's own record.
		await page.reload();
		await openWorkspaceMenu(page);
		await expect(
			page.getByTestId('switch-workspace').filter({ hasText: 'Amsterdam sheets' })
		).toBeVisible();
		await page.keyboard.press('Escape');

		// A browser Workspace renames the same way and on the same terms: the label is the author's
		// and the directory keeps the name it was made with, because OPFS has no directory move and
		// the alternative is copying every byte of somebody's only copy of their work.
		await renameWorkspace(page, DEFAULT_WORKSPACE, 'My research');
		await openWorkspaceMenu(page);
		await expect(
			page.getByTestId('switch-workspace').filter({ hasText: 'My research' })
		).toBeVisible();
		await page.keyboard.press('Escape');
		expect(await browserWorkspaceNames(page)).toContain(DEFAULT_WORKSPACE);

		// Opening it names it by the name its author gave it, on every screen.
		await switchToWorkspace(page, 'My research');
		await expectWorkspaceNamed(page, 'My research');
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
		// a fresh `updatedAt`, the indicator said "Saved", and the folder file was untouched. One route
		// serves both screens, so the switcher is on the Project itself and the class of defect is
		// structurally gone; the assertion stays, because the Workspace it writes into is still the
		// thing that has to be right.
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
		// A bookmarked Project on a route the folder is not open on. The browser Workspace's namesake
		// is what opens — which is the honest answer, and the whole reason the choice below has to
		// land in the folder rather than in whichever Workspace the route happened to resolve.
		await expect(page.getByTestId('project-name')).toHaveText('In browser storage');
		await openFolderFromRoster(page);
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');

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

	/**
	 * ⚠ **The lockout, and the reason `awaitingFolder` had to cease to exist** (ADR-0042).
	 *
	 * `ProjectScreen` and the align route both computed `recovering = status === 'unreachable' ||
	 * storage.awaitingFolder` and drew the recovery notice **instead of the screen** — and
	 * `awaitingFolder` was true for any folder this installation merely remembered, in any Workspace.
	 * So a scholar who had once chosen a folder and gone back to browser storage could not open a
	 * Project anywhere, in any Workspace, ever again: one Workspace's state was every Workspace's.
	 *
	 * It is asserted here rather than at a lower seam because that is exactly what it was made of —
	 * a real folder record in real IndexedDB, a real OPFS Workspace beside it, and a route effect
	 * over `?p=` in a real browser. Nothing below Seam 2 has all three.
	 */
	test('a Project in a browser Workspace opens with a folder Workspace present but not open', async ({
		page
	}) => {
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'In the folder');

		// Back to browser storage, with the folder still recorded: the state a scholar is in for ever
		// after once trying a folder, and the one this lockout was reachable from.
		await useBrowserStorage(page);
		await inBrowserStorage(page);
		await createProject(page, 'Amsterdam 1625');

		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');

		// And across the reload, which is where the remembered folder was read back in and where the
		// notice used to reappear over a Project that had just opened.
		await page.goto('./?p=amsterdam-1625');
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		// Not one word about a folder anywhere on the screen: no notice, dismissible or otherwise.
		await expect(page.getByRole('alert')).toHaveCount(0);

		// The folder is not gone — it is a row, which is what "not open" now means.
		await openWorkspaceMenu(page);
		await expect(folderRow(page)).toBeVisible();
	});

	test('a Project page reports an unreachable Workspace with a locate-again action', async ({
		page
	}) => {
		// An unreachable Workspace is reported on the Project page and not only on the hub. It is a
		// folder Workspace's failure specifically: in OPFS the root cannot vanish, and only a folder
		// the user can delete makes the store disappear underneath a running app.
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
		await openFolderFromRoster(page);

		const alert = page.getByRole('alert');
		await expect(alert).toContainText('Workspace not reachable');
		await expect(page.getByText('Opening…')).toHaveCount(0);
		await expect(
			alert.getByRole('button', { name: 'Locate Workspace folder again' })
		).toBeVisible();
	});
});

test.describe('a browser with no File System Access API', () => {
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
		// Absent from Workspace Home, where the move into a folder now is, and from the roster, where a
		// folder Workspace is created — where the browser has no picker the option is simply not there
		// (ADR-0001).
		await expect(page.getByTestId('move-into-folder')).toHaveCount(0);
		await openWorkspaceMenu(page);
		await page.getByTestId('new-workspace').click();
		await expect(page.getByTestId('new-workspace-folder')).toHaveCount(0);
		await page.keyboard.press('Escape');
		await inBrowserStorage(page);

		await createProject(page, 'Amsterdam 1625');

		// Nothing is disabled, nothing is explained away, and nothing has gone wrong.
		await expect(page.getByRole('alert')).toHaveCount(0);
		expect(await browserStorageEntries(page)).toEqual(['amsterdam-1625']);
	});

	/**
	 * ⚠ **The kind is never *named*, not merely never offered** (ADR-0042). Where the browser has no
	 * picker there is no choice to make, and telling somebody their work is "kept in this browser"
	 * implies another sort was available and is a sentence they can do nothing with. A Workspace is
	 * simply a Workspace. What is *not* hidden is the risk: the eviction warning is stated as an
	 * ordinary fact about this Workspace, which is ADR-0024's whole point and lives elsewhere.
	 */
	test('names no kind anywhere in the switcher, and offers none at creation', async ({ page }) => {
		await openWorkspaceMenu(page);

		await expect(page.getByTestId('workspace-backing')).toHaveCount(0);
		await expect(page.getByTestId('workspace-folder-name')).toHaveCount(0);
		const menu = page.getByTestId('workspace-switcher-menu');
		await expect(menu).not.toContainText('folder');
		await expect(menu).not.toContainText('browser');

		// The choice at creation is absent too, rather than present with one arm disabled.
		await page.getByTestId('new-workspace').click();
		await expect(page.getByTestId('new-workspace-kind')).toHaveCount(0);
		await expect(page.getByTestId('new-workspace-name')).toBeVisible();
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
// to it** (ADR-0024).
//
// The failure this rules out runs in the most expensive direction. Record "which Workspace do I go
// back to" for *browser-backed* Workspaces alone, and a scholar whose Workspace is a folder on their
// own disk — ADR-0001's capability upgrade, and the only backing where the files are theirs to see —
// is never recorded as being in one of their own at all. Pressing "Back to my Workspace" then runs
// `openWorkspace('My Workspace')`, which **creates**, and drops them into an empty OPFS Workspace
// while the banner announces they are back in their own. Their real work is in the folder,
// untouched, off screen, with nothing saying so. The hub's open-bundle button is not gated on
// backing, so the whole path is reachable.
//
// It lives in this file rather than in `editor-transfer.e2e.ts` because a real
// `FileSystemDirectoryHandle` is what makes it a test at all, and the picker that hands one back is
// here.
test.describe('a bundle opened from a folder Workspace', () => {
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
			.getByRole('dialog', { name: 'Review a Project' })
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
			.getByRole('dialog', { name: 'Review a Project' })
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

	// ⚠ **The case a display name cannot express, which is why a folder origin retains the grant
	// itself** (ADR-0037). Two folders on one machine may share a name; a folder can be deleted and
	// another made in its place. So the Review mark records an installation-local reference to the
	// *granted handle*, and the Import asks for that exact folder back — through a real
	// `requestPermission()`, from the reviewer's own press.
	test('imports the review copy into the folder it was opened from, and only then discards it', async ({
		page
	}) => {
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'My own work');

		await page.getByTestId('open-bundle').click();
		await page
			.getByRole('dialog', { name: 'Review a Project' })
			.getByLabel('Project bundle')
			.setInputFiles(await bundle());
		await page.getByTestId('confirm-open-bundle').click();
		await expect(page.getByTestId('review-banner')).toBeVisible();

		// The offer names the folder, not the browser Workspace the review copy is actually in.
		await expect(page.getByTestId('import-review')).toHaveText(`Import into “${PICKED_FOLDER}”`);
		await page.getByTestId('import-review').click();
		await page.getByTestId('confirm-import-review').click();

		// Back in the folder, with the Project copied into it as real files, and the review copy gone
		// only after that.
		await expect(page.getByTestId('review-banner')).toBeHidden();
		await inFolder(page);
		await expect(page.getByTestId('review-announcement')).toContainText(`into “${PICKED_FOLDER}”`);
		const paths = await everyPathInFolder(page);
		expect(paths).toContain('my-own-work/project.json');
		// A second Project directory in the folder, whatever the allocator named it — the reviewer's
		// own work beside it, untouched.
		expect(
			paths.filter((path) => path.endsWith('/project.json') && !path.startsWith('my-own-work/'))
		).toHaveLength(1);
		expect(await opfsWorkspaces(page)).not.toContain('assignment 7');
	});

	// A refused grant, at the backing where it is likeliest: a folder grant is a thing a browser
	// restart, a revoked permission or a second thought can take away. The refusal must not be what
	// loses the afternoon's reading, so the review copy stays open and is still an ordinary review copy
	// after it.
	//
	// ⚠ **The sibling case — a folder deleted and another put in its place under the same name — is
	// not assertable in this harness, and saying so is better than a test that looks like it covers
	// it.** It is why a folder origin retains the *grant* rather than the name: a real File System
	// Access handle names one directory entry, so a replacement raises `NotFoundError` and
	// `#reopenReviewOrigin` refuses it as gone. The handles here come from OPFS, which is the only
	// source of a real one an automated browser has (see this file's header), and Chromium resolves an
	// OPFS handle by path — so the replacement is reachable through the old handle and the Import
	// succeeds, which is the harness disagreeing with the browsers this feature ships to rather than
	// the app. The refusal's own wording is asserted at Seam 1 in `project-import-review.test.ts`.
	test('refuses when the folder grant is declined, leaving the review copy open', async ({
		page
	}) => {
		await chooseFolder(page);
		await createProject(page, 'My own work');

		await page.getByTestId('open-bundle').click();
		await page
			.getByRole('dialog', { name: 'Review a Project' })
			.getByLabel('Project bundle')
			.setInputFiles(await bundle());
		await page.getByTestId('confirm-open-bundle').click();
		await expect(page.getByTestId('review-banner')).toBeVisible();

		await page.evaluate((key) => localStorage.setItem(key, 'denied'), PERMISSION_KEY);
		await page.getByTestId('import-review').click();
		await page.getByTestId('confirm-import-review').click();

		// An alert rather than the polite line the successful outcomes use: a refused Import is text
		// inserted at the moment it is needed, and it names the folder it could not reach.
		const said = page.getByTestId('review-import-problem');
		await expect(said).toContainText(`the folder “${PICKED_FOLDER}”`);
		await expect(said).toContainText('not given permission');
		await expect(said).toContainText('this review copy is still here');
		// Still inside it, and still able to leave normally once the grant comes back.
		await expect(page.getByTestId('review-banner')).toBeVisible();
		await expectWorkspaceNamed(page, 'assignment 7');
		expect(await opfsWorkspaces(page)).toContain('assignment 7');
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

		// Legal: it is not the Workspace being looked out of, so its row offers it.
		await deleteWorkspace(page, 'assignment 7');
		await expect(page.getByTestId('workspace-announcement')).toContainText('assignment 7');

		await page.getByTestId('open-bundle').click();
		await page
			.getByRole('dialog', { name: 'Review a Project' })
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

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE BACKING IS NOT A SYNCHRONIZATION SEMANTIC
//
// **One lifecycle, run on a chosen folder, against what browser storage sends for the same bytes.**
// Every domain claim underneath it is exhausted at Seam 1 over both real backings: the shared
// adapter suite (`project-store-suite.ts`) for the bytes, and `describeUpdateTransaction` — run from
// `opfs-project-store.browser.test.ts` and `file-system-access-project-store.browser.test.ts` —
// for the transaction, its sixteen durable boundaries, the recovery choice and the resulting
// Baseline. None of that needs Playwright, and duplicating it here would be a second matrix.
//
// What no seam below can falsify is the wiring: that a Workspace whose files are in a folder the
// user picked gets the same Remote relationship, the same six determinations, the same destructive
// confirmation and the same committed source bytes as one in browser storage. `WorkspaceBacking` is
// a two-member union and the synchronization code branches on neither member — this is the
// assertion that says so about the *applications*, and it is the only place a real
// `FileSystemDirectoryHandle` and a Remote meet at all.
test.describe('synchronizing a folder Workspace', () => {
	const OWNER = 'ada';
	const FROM_BROWSER = 'browser-atlas';
	const FROM_FOLDER = 'folder-atlas';
	/** A token of the right shape. Its value never matters: the fake looks only for a credential. */
	const TOKEN = 'github_pat_11ABCDE0000abcdefghijklmnop';

	/** One Project, seeded byte-for-byte into whichever backing is being driven. */
	const SOURCE: Record<string, string> = {
		'amsterdam-1625/project.json': `${JSON.stringify(
			{
				formatVersion: 1,
				name: 'Amsterdam 1625',
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
		'amsterdam-1625/annotations/l2.geojson': '{"type":"FeatureCollection","features":[]}'
	};

	/** A second Project, as another machine's publish leaves it on the Remote. */
	const THEIRS: Record<string, string> = {
		'delft/project.json': `${JSON.stringify(
			{
				formatVersion: 1,
				name: 'Delft',
				updatedAt: '2026-02-03T04:05:06.000Z',
				layers: [],
				baseMap: 'physical'
			},
			null,
			'\t'
		)}\n`
	};

	/**
	 * Write files straight into a directory in OPFS, bypassing the app.
	 *
	 * The picked folder is a directory in OPFS — that is the only source of a real
	 * `FileSystemDirectoryHandle` an automated browser has — so one helper seeds both backings, and
	 * the two Workspaces really do start from identical bytes rather than from two Projects made by
	 * two runs of the same clicks a second apart.
	 */
	async function seedInto(page: Page, directory: string | null): Promise<void> {
		await page.evaluate(
			async ([directory, files]) => {
				const root = await navigator.storage.getDirectory();
				const base =
					directory === null
						? await workspaceRoot()
						: await root.getDirectoryHandle(directory as string, { create: true });
				for (const [full, text] of Object.entries(files as Record<string, string>)) {
					const segments = full.split('/');
					let handle = base;
					for (const segment of segments.slice(0, -1)) {
						handle = await handle.getDirectoryHandle(segment, { create: true });
					}
					const file = await handle.getFileHandle(segments[segments.length - 1]!, {
						create: true
					});
					const writable = await file.createWritable();
					await writable.write(text);
					await writable.close();
				}
			},
			[directory, SOURCE] as const
		);
	}

	/**
	 * Connect the open Workspace to one of the granted repositories, from the door (ADR-0041).
	 *
	 * ⚠ **Chosen out of GitHub's own answer rather than typed.** There is no address field and no
	 * token field anywhere on a deployment that has an App (ADR-0042): the door lists what GitHub
	 * says the author has granted, and the row is the gesture. The credential is seeded rather than
	 * acquired, because the sign-in round trip is `editor-github-signin.e2e.ts`'s subject and this
	 * test's is a folder.
	 */
	async function bindTo(page: Page, repository: string): Promise<void> {
		await openTheDoor(page);
		await page
			.getByTestId('granted-repository')
			.filter({ hasText: `${OWNER}/${repository}` })
			.getByTestId('choose-repository')
			.click();
		await expect(page.getByTestId('connect-outcome')).toContainText(`${OWNER}/${repository}`, {
			timeout: 30_000
		});
		await closeTheDoor(page);
	}

	/** Publish the open Workspace to its Remote and wait for the Remote to be named in the result. */
	async function publish(page: Page, repository: string): Promise<void> {
		await openPublishFromTheDoor(page);
		const dialog = page.getByRole('dialog', { name: 'Publish this Workspace' });
		await expect(dialog.getByTestId('publish-breakdown')).toBeVisible();
		await dialog.getByRole('button', { name: /^Publish/ }).click();
		await expect(page.getByTestId('publish-status')).toContainText(
			`Sent to ${OWNER}/${repository}`,
			{ timeout: 120_000 }
		);
	}

	/** The one badge's GitHub clause, which each determination has exactly one of (ADR-0041). */
	const remoteStatus = (page: Page) => page.getByTestId('where-your-work-is');

	/** Ask for a check the way an author does, and wait for it to finish. */
	async function checkNow(page: Page): Promise<void> {
		await checkRemoteStatus(page);
		await expect(remoteStatus(page)).not.toContainText('Checking…');
	}

	test('sends the same bytes and reads the same states as browser storage does', async ({
		page
	}) => {
		const github = await routeGitHubHosts(page, {
			repositories: [
				{ owner: OWNER, name: FROM_BROWSER, files: { 'README.md': '# Atlas\n' } },
				{ owner: OWNER, name: FROM_FOLDER, files: { 'README.md': '# Atlas\n' } }
			],
			// Both repositories granted, because the door offers what GitHub says the author may
			// touch and this test connects to one of them from each backing.
			signIn: true,
			login: OWNER,
			grants: {
				installationId: 1,
				account: OWNER,
				repositories: [
					{ owner: OWNER, repository: FROM_BROWSER, push: true },
					{ owner: OWNER, repository: FROM_FOLDER, push: true }
				]
			}
		});
		await installDirectoryPicker(page);
		await page.goto('./');
		await emptyBrowserStorage(page);
		await forgetRememberedFolder(page);
		await page.evaluate(() => localStorage.clear());

		// ── The control: the same Project, published out of browser storage ───────────────────────
		await seedInto(page, null);
		// ⚠ **Seeded before the reload, and before the folder is taken.** The credential is read when
		// the app starts, and a folder Workspace resumes only from a gesture — so this is the last
		// reload in the test.
		await seedGitHubCredential(page, TOKEN);
		await page.reload();
		await inBrowserStorage(page);
		await bindTo(page, FROM_BROWSER);
		await publish(page, FROM_BROWSER);

		// ── The same Project, in a folder the user picked ─────────────────────────────────────────
		//
		// Seeded before the folder is chosen rather than after: a folder Workspace resumes only from a
		// gesture (ADR-0012), so a reload here would land back on browser storage.
		await seedInto(page, PICKED_FOLDER);
		await chooseFolder(page);
		await inFolder(page);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		await bindTo(page, FROM_FOLDER);
		await publish(page, FROM_FOLDER);

		// ⚠ **Byte-equivalent, path by path.** Only the source closure is compared: a published site
		// carries its own build stamp, so `index.html` differing between two publishes seconds apart
		// says nothing about the backing. What the two Remotes must agree on to the byte is the
		// scholarship — and `remote.json` is deliberately not in it, because each names its own
		// repository.
		for (const path of Object.keys(SOURCE)) {
			expect(github.fileText(OWNER, FROM_FOLDER, path)).toBe(
				github.fileText(OWNER, FROM_BROWSER, path)
			);
			expect(github.fileText(OWNER, FROM_FOLDER, path)).toBe(SOURCE[path]);
		}
		// And a Publish earns a Baseline in the folder Workspace exactly as it does in the other one,
		// which is what makes every determination below answerable at all.
		await expect(remoteStatus(page)).toContainText('Your work is on GitHub');

		// ── Somebody else's afternoon, arriving on the folder's Remote ────────────────────────────
		await github.commitFiles(OWNER, FROM_FOLDER, THEIRS);
		await checkNow(page);
		await expect(remoteStatus(page)).toContainText('GitHub has work this Workspace does not');

		await updateFromGitHub(page);
		await expect(page.getByTestId('update-outcome')).toContainText('Brought');
		// In the folder, as real files: the transfer wrote through the File System Access adapter and
		// the bytes are the Remote's own.
		expect(await everyPathInFolder(page)).toContain('delft/project.json');
		expect(await readInFolder(page, 'delft/project.json')).toBe(THEIRS['delft/project.json']);
		await expect(page.getByRole('link', { name: 'Delft' })).toBeVisible();
		await expect(remoteStatus(page)).toContainText('Your work is on GitHub');

		// ── And a destructive one, which is refused until it is confirmed ─────────────────────────
		const before = await everyPathInFolder(page);
		await github.commitFiles(OWNER, FROM_FOLDER, { 'delft/project.json': null });
		await updateFromGitHub(page);
		const dialog = page.getByRole('dialog', {
			name: 'Update will remove work from this Workspace'
		});
		await expect(dialog.getByTestId('deletion-preview-projects')).toContainText('Delft');

		// Cancelling writes nothing to the folder, and puts focus back where it came from.
		await dialog.getByTestId('cancel-deletions').click();
		await expect(dialog).toBeHidden();
		// The door closed on the press that started the Update, so this is where focus goes back to.
		await expect(page.getByTestId('connect-to-github')).toBeFocused();
		expect(await everyPathInFolder(page)).toEqual(before);

		await updateFromGitHub(page);
		await dialog.getByTestId('confirm-deletions').click();
		await expect(page.getByTestId('update-outcome')).toContainText('Removed');
		await expect(page.getByRole('link', { name: 'Delft' })).toHaveCount(0);
		// Nothing of the removed Project is left in the folder, and the Project the Remote kept is
		// untouched — which is the transaction's own claim, seen through the adapter it ran on. The
		// folder also holds the site the Publish above materialised, which is why this asks about the
		// Projects rather than about every path.
		const after = await everyPathInFolder(page);
		expect(after.filter((path) => path.startsWith('delft/'))).toEqual([]);
		expect(after).toEqual(expect.arrayContaining(Object.keys(SOURCE)));
		expect(await readInFolder(page, 'amsterdam-1625/project.json')).toBe(
			SOURCE['amsterdam-1625/project.json']
		);
		await expect(remoteStatus(page)).toContainText('Your work is on GitHub');
	});
});
