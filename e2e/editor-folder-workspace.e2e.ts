import { expect, test, type Page } from '@playwright/test';

import { projectNameField } from './support/project-screen';

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
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
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

/** Every top-level name in browser storage — the OPFS Workspace's own root. */
async function browserStorageEntries(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
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

const chooseFolder = (page: Page) =>
	page.getByRole('button', { name: 'Choose Workspace folder…' }).click();

const inFolder = (page: Page) =>
	expect(page.getByText(`Your Workspace is the folder ${PICKED_FOLDER}`)).toBeVisible();

const inBrowserStorage = (page: Page) =>
	expect(page.getByText("Your Workspace is in this browser's own private storage")).toBeVisible();

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
		await page.getByRole('button', { name: 'Choose Workspace folder…' }).focus();
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
			await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
			await page.getByRole('link', { name: 'Back to all Projects' }).click();
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

		await page.getByRole('button', { name: 'Use browser storage instead' }).click();

		await inBrowserStorage(page);
		await expect(page.getByRole('link', { name: 'In Browser' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'In Folder' })).toHaveCount(0);

		// And back again: the folder still holds what was made in it.
		await chooseFolder(page);
		await inFolder(page);
		await expect(page.getByRole('link', { name: 'In Folder' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'In Browser' })).toHaveCount(0);
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

		await page.getByRole('button', { name: 'Use browser storage instead' }).click();

		await inBrowserStorage(page);
		// Still offered, because the folder has not been given up — only stepped away from.
		await expect(page.getByRole('button', { name: `Reopen “${PICKED_FOLDER}”` })).toBeVisible();
	});

	test('forgets the folder when browser storage is chosen deliberately', async ({ page }) => {
		// The other half of the same button, so the fix above is not just "never forget".
		await chooseFolder(page);
		await inFolder(page);
		await createProject(page, 'Amsterdam 1625');

		await page.getByRole('button', { name: 'Use browser storage instead' }).click();

		await inBrowserStorage(page);
		await expect(page.getByRole('button', { name: /^Reopen/ })).toHaveCount(0);
		await page.reload();
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
			await copy(source, await root.getDirectoryHandle('amsterdam-1625', { create: true }));
		}, PICKED_FOLDER);

		await page.getByRole('button', { name: 'Use browser storage instead' }).click();

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
			const root = await navigator.storage.getDirectory();
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
			const root = await navigator.storage.getDirectory();
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
		await expect(page.getByRole('button', { name: 'Choose Workspace folder…' })).toHaveCount(0);
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
