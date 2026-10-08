import { DEFAULT_WORKSPACE, expect, test } from './support/test.js';
import { type Page } from '@playwright/test';

import { drawSwitch, openBaseMapOptions } from './support/base-map-options.js';
import { projectNameField } from './support/project-screen';
import {
	createFolderWorkspace,
	renameWorkspace,
	expectWorkspaceNamed,
	openWorkspaceMenu,
	closeWorkspaceDialog,
	editOpenWorkspace,
	openTheDoor,
	seedGitHubCredential,
	switchToWorkspace,
	checkRemoteStatus,
	openSyncModal,
	getFromRemote,
	emptyBrowserStorage,
	everyByteOf,
	workspaceNames
} from './support/workspace';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { routeGitHubHosts } from './support/github-hosts.js';
import { deleteProject, openNewProject } from './support/annotations.js';

test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

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

const PICKED_FOLDER = 'e2e-picked-folder';
const PERMISSION_KEY = 'e2e-folder-permission';
const CANCEL_KEY = 'e2e-folder-cancel';
const FOLDER_NAME_KEY = 'e2e-folder-name';

declare global {
	interface Window {
		e2eFolderGrant?: {
			pickerCalls: { mode: string | undefined; id: string | undefined }[];
			activationAtPick: boolean[];
			permissionQueries: number;
			permissionRequests: number;
			activationAtRequest: boolean[];
		};
		e2eInterruptedWrites?: number;
	}
}

async function installDirectoryPicker(page: Page): Promise<void> {
	await page.addInitScript(
		({ folder, permissionKey, cancelKey, folderNameKey }) => {
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
					const wantedFolder = localStorage.getItem(folderNameKey) || folder;
					return root.getDirectoryHandle(wantedFolder, { create: true });
				}
			});

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
		{
			folder: PICKED_FOLDER,
			permissionKey: PERMISSION_KEY,
			cancelKey: CANCEL_KEY,
			folderNameKey: FOLDER_NAME_KEY
		}
	);
}

async function start(page: Page, picker = true): Promise<void> {
	if (picker) await installDirectoryPicker(page);
	else {
		await page.addInitScript(() => {
			Object.defineProperty(window, 'showDirectoryPicker', {
				configurable: true,
				writable: true,
				value: undefined
			});
		});
	}
	await page.goto('./');
	await emptyBrowserStorage(page, { keepOpen: true, forget: picker, dropDatabase: true });
	await page.reload();
}

async function startInFolder(page: Page): Promise<void> {
	await start(page);
	await chooseFolder(page);
	await createProject(page, 'Amsterdam 1625');
}

const folderFiles = (page: Page) => everyByteOf(page, PICKED_FOLDER);
const folderPaths = async (page: Page) => Object.keys(await folderFiles(page)).sort();
const readInFolder = async (page: Page, path: string) => (await folderFiles(page))[path] ?? '';

async function seedFiles(
	page: Page,
	directory: string | null,
	files: Record<string, string>
): Promise<void> {
	await page.evaluate(
		async ([directory, files]) => {
			const base =
				directory === null
					? await workspaceRoot()
					: await (
							await navigator.storage.getDirectory()
						).getDirectoryHandle(directory, { create: true });
			for (const [full, text] of Object.entries(files)) {
				const segments = full.split('/');
				let handle = base;
				for (const segment of segments.slice(0, -1)) {
					handle = await handle.getDirectoryHandle(segment, { create: true });
				}
				const file = await handle.getFileHandle(segments.at(-1)!, { create: true });
				const writable = await file.createWritable();
				await writable.write(text);
				await writable.close();
			}
		},
		[directory, files] as const
	);
}

const removeFolder = (page: Page) =>
	page.evaluate(
		async (folder) =>
			(await navigator.storage.getDirectory()).removeEntry(folder, { recursive: true }),
		PICKED_FOLDER
	);

async function noteUnfinishedDeletions(page: Page, directories: string[]): Promise<void> {
	await page.evaluate(
		([workspace, directories]) => {
			for (const directory of directories) {
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
		[await folderWorkspaceKey(page), directories] as const
	);
	await page.reload();
	await openFolderFromRoster(page);
	await inFolder(page);
}

const grant = (page: Page) => page.evaluate(() => window.e2eFolderGrant);

const createProject = async (page: Page, name: string) => {
	await openNewProject(page, name);
	await page.getByTestId('all-projects').click();
	await expect(page.getByRole('link', { name })).toBeVisible();
};

const chooseFolder = (page: Page) => createFolderWorkspace(page, PICKED_FOLDER);

async function fillNewFolderWorkspace(page: Page): Promise<void> {
	await openWorkspaceMenu(page);
	await page.getByTestId('new-workspace').click();
	await page.getByTestId('new-workspace-name').fill(PICKED_FOLDER);
	await page.getByTestId('new-workspace-folder').check();
}

const folderRow = (page: Page) =>
	page.locator('[data-testid="switch-workspace"][data-kind="folder"]');

const openFolderFromRoster = async (page: Page) => {
	const resuming = await page.evaluate(() =>
		Boolean(localStorage.getItem('ballastella.open-folder'))
	);
	if (resuming) {
		const prompt = page.getByRole('dialog', { name: 'Open your Workspace folder' });
		await prompt.getByRole('button', { name: 'Open Workspace folder' }).click();
		return;
	}
	await openWorkspaceMenu(page);
	await folderRow(page).click();
};

const useBrowserStorage = (page: Page) => switchToWorkspace(page, DEFAULT_WORKSPACE);
const inFolder = (page: Page) => expectWorkspaceNamed(page, PICKED_FOLDER);
const inBrowserStorage = (page: Page) => expectWorkspaceNamed(page, DEFAULT_WORKSPACE);

test.describe('choosing a folder as the Workspace', () => {
	test.beforeEach(({ page }) => start(page));

	test('asks once, from the user’s gesture, and puts every Project in that folder as ADR-0008 files', async ({
		page
	}) => {
		await inBrowserStorage(page);
		await fillNewFolderWorkspace(page);
		await page.getByTestId('create-workspace').focus();
		await page.keyboard.press('Enter');

		await inFolder(page);
		await createProject(page, 'Amsterdam 1625');
		expect(await folderPaths(page)).toEqual(['amsterdam-1625/project.json']);
		expect(JSON.parse(await readInFolder(page, 'amsterdam-1625/project.json'))).toMatchObject({
			formatVersion: 1,
			name: 'Amsterdam 1625',
			layers: [],
			baseMap: null
		});

		await createProject(page, 'Boston 1775');
		for (const name of ['Amsterdam 1625', 'Boston 1775']) {
			await page.getByRole('link', { name }).click();
			await expect(page.getByTestId('project-name')).toHaveText(name);
			await page.getByTestId('all-projects').click();
			await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
		}

		expect(await grant(page)).toMatchObject({
			pickerCalls: [{ mode: 'readwrite', id: 'ballastella-workspace' }],
			activationAtPick: [true],
			permissionRequests: 0
		});
	});

	test('says nothing at all when the picker is closed without choosing', async ({ page }) => {
		await page.evaluate((key) => localStorage.setItem(key, 'yes'), CANCEL_KEY);

		await fillNewFolderWorkspace(page);
		await page.getByTestId('create-workspace').click();

		await inBrowserStorage(page);
		await expect(page.getByRole('alert')).toHaveCount(0);
	});

	test('moves this Workspace into a folder, preserving every file and keeping the original', async ({
		page
	}) => {
		await createProject(page, 'In Browser');
		const before = await everyByteOf(page, DEFAULT_WORKSPACE);
		expect(Object.keys(before)).toEqual(['in-browser/project.json']);

		await editOpenWorkspace(page);
		await page.getByTestId('move-into-folder').click();

		await inFolder(page);
		await expect(page.getByRole('link', { name: 'In Browser' })).toBeVisible();

		expect(await folderFiles(page)).toEqual(before);
		expect(await everyByteOf(page, DEFAULT_WORKSPACE)).toEqual(before);

		await expect(page.getByTestId('transfer-outcome')).toContainText(PICKED_FOLDER);
		await expect(page.getByTestId('transfer-outcome')).toContainText('browser storage');

		await closeWorkspaceDialog(page);
		await useBrowserStorage(page);
		await expect(page.getByRole('link', { name: 'In Browser' })).toBeVisible();
	});

	test('refuses a folder that already holds files, and says so', async ({ page }) => {
		await createProject(page, 'In Browser');
		await seedFiles(page, PICKED_FOLDER, { 'notes.txt': "somebody else's" });

		await editOpenWorkspace(page);
		await page.getByTestId('move-into-folder').click();

		await expect(page.getByTestId('transfer-problem')).toContainText('already holds files');
		await inBrowserStorage(page);
		expect(await folderFiles(page)).toEqual({ 'notes.txt': "somebody else's" });
	});

	test('will not finish a deletion on its own in a folder, and says so', async ({ page }) => {
		await chooseFolder(page);
		await createProject(page, 'Amsterdam 1625');
		await noteUnfinishedDeletions(page, ['amsterdam-1625']);

		await expect(page.getByTestId('deletion-refused')).toContainText(
			'will not remove it on its own'
		);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		expect(await folderPaths(page)).toEqual(['amsterdam-1625/project.json']);

		await deleteProject(page);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);
		await expect.poll(() => folderPaths(page)).toEqual([]);
	});

	test('forgets a refused deletion’s note, and it stays forgotten across a reload', async ({
		page
	}) => {
		await chooseFolder(page);
		await createProject(page, 'Amsterdam 1625');
		await createProject(page, 'Boston 1775');
		await noteUnfinishedDeletions(page, ['amsterdam-1625', 'boston-1775']);
		await expect(page.getByTestId('deletion-refused')).toHaveCount(2);

		const forget = (directory: string) =>
			page
				.getByRole('button', { name: `Forget the unfinished deletion of “${directory}”` })
				.click();
		await forget('boston-1775');

		await expect(page.getByTestId('deletion-refused')).toHaveCount(1);
		expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
			'recovered-dismiss'
		);

		await forget('amsterdam-1625');

		await expect(page.getByTestId('recovered-edits')).toHaveCount(0);
		expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('MAIN');
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Boston 1775' })).toBeVisible();
		expect(await folderPaths(page)).toEqual([
			'amsterdam-1625/project.json',
			'boston-1775/project.json'
		]);

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
		await chooseFolder(page);
		await createProject(page, 'Amsterdam 1625');

		const provisional = {
			'boston-1775/project.json': '{"formatVersion":1,"name":"Boston 1775","layers":[]}',
			'boston-1775/annotations/wharves.geojson': '{"type":"FeatureCollection","features":[]}',
			'images/img-imported/info.json': '{"width":2048,"height":2048}'
		};
		await seedFiles(page, PICKED_FOLDER, {
			'amsterdam-1625/.project.json.abandoned.ballastella-tmp': 'half a document',
			'amsterdam-1625/.project.json.crashed.ballastella-tmp.crswap': 'half a document',
			...provisional,
			'import.json': JSON.stringify({
				formatVersion: 1,
				transaction: 'e2e-folder-import',
				state: 'writing',
				project: 'boston-1775/project.json',
				paths: Object.keys(provisional).sort(),
				startedAt: '2026-08-22T10:00:00.000Z'
			})
		});
		expect(await folderPaths(page)).toHaveLength(7);

		await page.reload();
		await openFolderFromRoster(page);
		await inFolder(page);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();

		await expect(page.getByRole('link', { name: 'Boston 1775' })).toHaveCount(0);
		await expect.poll(() => folderPaths(page)).toEqual(['amsterdam-1625/project.json']);
	});

	test('lets the author switch away from an unreachable folder, keeping it on the roster', async ({
		page
	}) => {
		await chooseFolder(page);
		await createProject(page, 'Amsterdam 1625');
		await removeFolder(page);
		await page.reload();
		await openFolderFromRoster(page);
		await expect(page.getByRole('alert')).toContainText('Workspace not reachable');

		await useBrowserStorage(page);

		await openWorkspaceMenu(page);
		await expect(folderRow(page)).toBeVisible();
	});

	test('writes a Project the browser backend reads with no conversion, once copied in', async ({
		page
	}) => {
		await chooseFolder(page);
		await createProject(page, 'Amsterdam 1625');
		await seedFiles(page, null, await folderFiles(page));

		await useBrowserStorage(page);

		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
	});
});

test.describe('returning to a folder Workspace (ADR-0012)', () => {
	test.beforeEach(({ page }) => startInFolder(page));

	test('holds a folder Project route for a gesture that restores its Workspace', async ({
		page
	}) => {
		await page.evaluate((key) => localStorage.setItem(key, 'prompt'), PERMISSION_KEY);
		await page.goto('./?p=amsterdam-1625');

		const dialog = page.getByRole('dialog', { name: 'Open your Workspace folder' });
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText('Project is read from the right place');
		await expect(page.getByRole('heading', { name: 'Project not found' })).toHaveCount(0);
		expect(await grant(page)).toMatchObject({ permissionQueries: 0, permissionRequests: 0 });

		await dialog.getByRole('button', { name: 'Open Workspace folder' }).click();

		await inFolder(page);
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
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

		await expect(page.getByRole('alert')).toContainText('not been moved or lost');
		await expect(page.getByRole('button', { name: 'Choose folder again' })).toBeVisible();
		await inBrowserStorage(page);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);
		await expect(page.getByRole('heading', { level: 1, name: 'Ballastella Editor' })).toBeVisible();
	});

	test('reports a folder that has been deleted as unreachable, with a way to locate it again', async ({
		page
	}) => {
		await removeFolder(page);
		await page.reload();

		await openFolderFromRoster(page);

		await expect(page.getByRole('alert')).toContainText('Workspace not reachable');
		await expect(page.getByRole('heading', { level: 1, name: 'Ballastella Editor' })).toBeVisible();

		await openWorkspaceMenu(page);
		await expect(page.getByTestId('workspace-unreachable')).toContainText(
			'Unreachable. The notice on this screen can locate it again.'
		);
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('workspace-switcher-menu')).toBeHidden();

		await page.getByRole('button', { name: 'Locate Workspace folder again' }).click();

		await inFolder(page);
		await expect(page.getByText('No Projects yet')).toBeVisible();
	});
});

test.describe('the Workspace roster', () => {
	test.beforeEach(({ page }) => start(page));

	test('lists both kinds in one list, each opened and renamed from its own row', async ({
		page
	}) => {
		const named = (name: string) => page.getByTestId('switch-workspace').filter({ hasText: name });
		await chooseFolder(page);
		await createProject(page, 'In the folder');
		await useBrowserStorage(page);

		await openWorkspaceMenu(page);
		await expect(folderRow(page)).toHaveCount(1);
		await expect(
			page.locator('[data-testid="switch-workspace"][data-kind="browser"]').filter({
				hasText: DEFAULT_WORKSPACE
			})
		).toBeVisible();
		await expect(page.getByTestId('workspace-folder-name')).toHaveText(PICKED_FOLDER);
		await page.keyboard.press('Escape');

		await openWorkspaceMenu(page);
		await folderRow(page).locator('xpath=following-sibling::button[1]').click();
		await page.getByTestId('rename-workspace-name').fill('Amsterdam sheets');
		await page.getByTestId('save-workspace-name').click();
		await expect(page.getByTestId('workspace-announcement')).toContainText('Amsterdam sheets');
		await openWorkspaceMenu(page);
		await expect(named('Amsterdam sheets')).toBeVisible();
		await expect(page.getByTestId('workspace-folder-name')).toHaveText(PICKED_FOLDER);

		await named('Amsterdam sheets').click();
		await expectWorkspaceNamed(page, 'Amsterdam sheets');
		await expect(page.getByRole('link', { name: 'In the folder' })).toBeVisible();
		expect(await folderPaths(page)).toEqual(['in-the-folder/project.json']);

		await page.reload();
		await openFolderFromRoster(page);
		await openWorkspaceMenu(page);
		await expect(named('Amsterdam sheets')).toBeVisible();
		await page.keyboard.press('Escape');

		await renameWorkspace(page, DEFAULT_WORKSPACE, 'My research');
		await openWorkspaceMenu(page);
		await expect(named('My research')).toBeVisible();
		await page.keyboard.press('Escape');
		expect(await workspaceNames(page)).toContain(DEFAULT_WORKSPACE);

		await switchToWorkspace(page, 'My research');
	});
});

test.describe('the Workspace is the same one on every route', () => {
	test.beforeEach(({ page }) => start(page));

	test('the Base Map pane records the author’s choice in the folder, not in browser storage', async ({
		page
	}) => {
		await chooseFolder(page);
		await createProject(page, 'Amsterdam 1625');
		const stale =
			'{"formatVersion":1,"name":"In browser storage","updatedAt":"2020-01-01T00:00:00.000Z","layers":[],"baseMap":null}';
		await seedFiles(page, null, { 'amsterdam-1625/project.json': stale });

		await page.goto('./?p=amsterdam-1625');
		await openFolderFromRoster(page);
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');

		await openBaseMapOptions(page);
		await drawSwitch(page, 'Streets').click();
		await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');

		expect(JSON.parse(await readInFolder(page, 'amsterdam-1625/project.json'))).toMatchObject({
			name: 'Amsterdam 1625',
			baseMapAppearance: { streets: false }
		});
		const untouched = await page.evaluate(async () => {
			const project = await (await workspaceRoot()).getDirectoryHandle('amsterdam-1625');
			return (await (await project.getFileHandle('project.json')).getFile()).text();
		});
		expect(untouched).toBe(stale);
	});

	test('a Project in a browser Workspace opens with a folder Workspace present but not open', async ({
		page
	}) => {
		await chooseFolder(page);
		await createProject(page, 'In the folder');
		await useBrowserStorage(page);
		await createProject(page, 'Amsterdam 1625');

		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');

		await page.goto('./?p=amsterdam-1625');
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		await expect(page.getByRole('alert')).toHaveCount(0);

		await openWorkspaceMenu(page);
		await expect(folderRow(page)).toBeVisible();
	});

	test('a Project page reports an unreachable Workspace with a locate-again action', async ({
		page
	}) => {
		await chooseFolder(page);
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');

		await removeFolder(page);
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

test('a browser with no File System Access API offers no folder or kind anywhere, and browser storage works', async ({
	page
}) => {
	await start(page, false);
	await expect(page.getByTestId('move-into-folder')).toHaveCount(0);

	await openWorkspaceMenu(page);
	await expect(page.getByTestId('workspace-backing')).toHaveCount(0);
	await expect(page.getByTestId('workspace-folder-name')).toHaveCount(0);
	const menu = page.getByTestId('workspace-switcher-menu');
	await expect(menu).not.toContainText('folder');
	await expect(menu).not.toContainText('browser');

	await page.getByTestId('new-workspace').click();
	await expect(page.getByTestId('new-workspace-name')).toBeVisible();
	await expect(page.getByTestId('new-workspace-kind')).toHaveCount(0);
	await expect(page.getByTestId('new-workspace-folder')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await inBrowserStorage(page);

	await createProject(page, 'Amsterdam 1625');

	await expect(page.getByRole('alert')).toHaveCount(0);
	expect(Object.keys(await everyByteOf(page, DEFAULT_WORKSPACE))).toEqual([
		'amsterdam-1625/project.json'
	]);
});

test('an interrupted write to a real folder leaves the previous project.json intact, parseable, and with no litter beside it (ADR-0017 rule 4)', async ({
	page
}) => {
	await startInFolder(page);
	await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
	await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
	await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');

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
	await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
	await expect.poll(() => page.evaluate(() => window.e2eInterruptedWrites)).toBe(1);

	await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'unsaved');
	const survivor = await readInFolder(page, 'amsterdam-1625/project.json');
	expect(JSON.parse(survivor)).toMatchObject({ formatVersion: 1, name: 'Amsterdam 1625' });
	expect(await folderPaths(page)).toEqual(['amsterdam-1625/project.json']);
});

test.describe('synchronizing a folder Workspace', () => {
	const OWNER = 'ada';
	const FROM_BROWSER = 'browser-atlas';
	const FROM_FOLDER = 'folder-atlas';
	const TOKEN = 'github_pat_11ABCDE0000abcdefghijklmnop';
	const asFile = (value: unknown) => `${JSON.stringify(value, null, '\t')}\n`;

	const SOURCE: Record<string, string> = {
		'amsterdam-1625/project.json': asFile({
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
			baseMap: null
		}),
		'amsterdam-1625/annotations/l2.geojson': '{"type":"FeatureCollection","features":[]}'
	};

	const THEIRS = {
		'delft/project.json': asFile({
			formatVersion: 1,
			name: 'Delft',
			updatedAt: '2026-02-03T04:05:06.000Z',
			layers: [],
			baseMap: null
		})
	};

	async function bindAndSend(page: Page, repository: string): Promise<void> {
		await openTheDoor(page);
		await page
			.getByTestId('granted-repository')
			.filter({ hasText: `${OWNER}/${repository}` })
			.getByTestId('choose-repository')
			.click();
		await expect(page.getByTestId('sync-modal')).toBeVisible({ timeout: 30_000 });
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('sync-modal')).toBeHidden();

		await openSyncModal(page);
		const dialog = page.getByRole('dialog', { name: 'Sync with GitHub' });
		await expect(dialog.getByTestId('sync-budget')).toBeVisible();
		await dialog.getByTestId('sync-send').click();
		await expect(page.getByTestId('sync-status')).toContainText(`Sent to ${OWNER}/${repository}`, {
			timeout: 120_000
		});
	}

	const remoteStatus = (page: Page) => page.getByTestId('where-your-work-is');
	const inSync = (page: Page) =>
		expect(remoteStatus(page)).toContainText(`in sync with ${OWNER}/${FROM_FOLDER}`);

	test('sends the same bytes and reads the same states as browser storage does', async ({
		page
	}) => {
		const github = await routeGitHubHosts(page, {
			repositories: [
				{ owner: OWNER, name: FROM_BROWSER, files: { 'README.md': '# Atlas\n' } },
				{ owner: OWNER, name: FROM_FOLDER, files: { 'README.md': '# Atlas\n' } }
			],
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
		await start(page);
		await seedFiles(page, null, SOURCE);
		await seedGitHubCredential(page, TOKEN);
		await page.reload();
		await inBrowserStorage(page);
		await bindAndSend(page, FROM_BROWSER);

		await seedFiles(page, PICKED_FOLDER, SOURCE);
		await chooseFolder(page);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		await bindAndSend(page, FROM_FOLDER);

		for (const path of Object.keys(SOURCE)) {
			expect(github.fileText(OWNER, FROM_FOLDER, path)).toBe(
				github.fileText(OWNER, FROM_BROWSER, path)
			);
			expect(github.fileText(OWNER, FROM_FOLDER, path)).toBe(SOURCE[path]);
		}
		await inSync(page);

		await github.commitFiles(OWNER, FROM_FOLDER, THEIRS);
		await checkRemoteStatus(page);
		await expect(remoteStatus(page)).not.toContainText('Checking…');
		await expect(remoteStatus(page)).toContainText('changes to get');

		await getFromRemote(page);
		await expect(page.getByTestId('update-outcome')).toContainText('Brought');
		expect(await readInFolder(page, 'delft/project.json')).toBe(THEIRS['delft/project.json']);
		await expect(page.getByRole('link', { name: 'Delft' })).toBeVisible();
		await inSync(page);

		const before = await folderPaths(page);
		await github.commitFiles(OWNER, FROM_FOLDER, { 'delft/project.json': null });
		await openSyncModal(page);
		const dialog = page.getByRole('dialog', { name: 'Sync with GitHub' });
		await expect(dialog.getByTestId('to-get-removals')).toBeVisible({ timeout: 60_000 });
		await expect(dialog.getByTestId('to-get')).toContainText('Delft');

		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(page.getByTestId('connect-to-github')).toBeFocused();
		expect(await folderPaths(page)).toEqual(before);

		await getFromRemote(page);
		await expect(page.getByTestId('update-outcome')).toContainText('Removed');
		await expect(page.getByRole('link', { name: 'Delft' })).toHaveCount(0);
		const after = await folderPaths(page);
		expect(after.filter((path) => path.startsWith('delft/'))).toEqual([]);
		expect(after).toEqual(expect.arrayContaining(Object.keys(SOURCE)));
		expect(await readInFolder(page, 'amsterdam-1625/project.json')).toBe(
			SOURCE['amsterdam-1625/project.json']
		);
		await inSync(page);
	});
});
