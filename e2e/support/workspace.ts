import { unpackTar } from 'modern-tar';
import { readFile } from 'node:fs/promises';

import { DEFAULT_WORKSPACE, type Download, expect, type Page } from './test.js';

export const workspaceButton = (page: Page) => page.getByTestId('workspace-switcher');

export async function expectWorkspaceNamed(page: Page, name: string): Promise<void> {
	await expect(workspaceButton(page)).toHaveText(name);
}

export async function openWorkspaceMenu(page: Page): Promise<void> {
	const menu = page.getByTestId('workspace-switcher-menu');
	if (await menu.isVisible()) return;
	await expect(page.getByRole('dialog', { name: 'Rename this Workspace' })).toBeHidden();
	await workspaceButton(page).click();
	await expect(menu).toBeVisible();
}

export async function editWorkspace(page: Page, name: string): Promise<void> {
	await openWorkspaceMenu(page);
	await page.getByRole('button', { name: `Rename ${name}` }).click();
	await expect(page.getByRole('dialog', { name: 'Rename this Workspace' })).toBeVisible();
}

export async function switchToWorkspace(page: Page, name: string): Promise<void> {
	await openWorkspaceMenu(page);
	await page.getByTestId('switch-workspace').filter({ hasText: name }).first().click();
	await expectWorkspaceNamed(page, name);
}

export async function editOpenWorkspace(page: Page): Promise<void> {
	await openWorkspaceMenu(page);
	await page
		.locator('li')
		.filter({ has: page.locator('[data-testid="switch-workspace"][aria-current="true"]') })
		.getByTestId('rename-workspace')
		.click();
	await expect(page.getByRole('dialog', { name: 'Rename this Workspace' })).toBeVisible();
}

export async function backUpWorkspace(page: Page): Promise<Download> {
	await editOpenWorkspace(page);
	const download = page.waitForEvent('download');
	await page.getByTestId('back-up-workspace').click();
	return download;
}

export const downloadedBytes = async (download: Download | Promise<Download>): Promise<Buffer> =>
	readFile(await (await download).path());

export const unpackDownload = async (download: Download | Promise<Download>) =>
	unpackTar(new Uint8Array(await downloadedBytes(download)), { strict: true });

export const restoreFrom = (page: Page, buffer: Buffer, name = `${DEFAULT_WORKSPACE}.tar`) =>
	page.getByTestId('restore-file').setInputFiles({ name, mimeType: 'application/x-tar', buffer });

export async function restoreBackup(page: Page, buffer: Buffer, name?: string): Promise<void> {
	await restoreFrom(page, buffer, name);
	await expect(page.getByTestId('transfer-outcome')).toContainText('Share Links', {
		timeout: 30_000
	});
}

export const installFolderPicker = (page: Page, folder: string) =>
	page.addInitScript((folder: string) => {
		Object.defineProperty(window, 'showDirectoryPicker', {
			configurable: true,
			writable: true,
			value: async () =>
				(await navigator.storage.getDirectory()).getDirectoryHandle(folder, { create: true })
		});
		const handles = FileSystemHandle.prototype as {
			queryPermission?: unknown;
			requestPermission?: unknown;
		};
		handles.queryPermission = handles.requestPermission = async () => 'granted';
	}, folder);

export async function closeWorkspaceDialog(page: Page): Promise<void> {
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog', { name: 'Rename this Workspace' })).toBeHidden();
}

export async function renameWorkspace(page: Page, from: string, to: string): Promise<void> {
	await editWorkspace(page, from);
	await page.getByTestId('rename-workspace-name').fill(to);
	await page.getByTestId('save-workspace-name').click();
	await expect(page.getByTestId('workspace-announcement')).toContainText(to);
}

export async function deleteWorkspace(page: Page, name: string): Promise<void> {
	await openWorkspaceMenu(page);
	await page.getByRole('button', { name: `Delete ${name}` }).click();
	await expect(page.getByRole('dialog', { name: 'Delete this Workspace?' })).toBeVisible();
	await page.getByTestId('confirm-delete-workspace').click();
}

export async function createWorkspace(page: Page, name: string, folder = false): Promise<void> {
	await openWorkspaceMenu(page);
	await page.getByTestId('new-workspace').click();
	await page.getByTestId('new-workspace-name').fill(name);
	if (folder) await page.getByTestId('new-workspace-folder').check();
	await page.getByTestId('create-workspace').click();
	await expectWorkspaceNamed(page, name);
}

export const createFolderWorkspace = (page: Page, name: string) =>
	createWorkspace(page, name, true);

export const doorButton = (page: Page) => page.getByTestId('connect-to-github');

export async function openTheDoor(page: Page): Promise<void> {
	await doorButton(page).click();
	const sequence = page.getByTestId('connect-sequence');
	const settings = page.getByTestId('sync-repository-settings');
	await expect
		.poll(async () => (await settings.isVisible()) || (await sequence.isVisible()))
		.toBe(true);
	if (await settings.isVisible().catch(() => false)) {
		await settings.click();
		await expect(page.getByTestId('workspace-remote')).toBeVisible();
		await page.getByTestId('change-repository').click();
	}
	await expect(sequence).toBeVisible();
}

export async function openRepositorySettings(page: Page): Promise<void> {
	await editOpenWorkspace(page);
	await expect(page.getByTestId('workspace-remote')).toBeVisible();
}

export async function closeTheDoor(page: Page): Promise<void> {
	await page.getByTestId('close-connect-sequence').click();
	await expect(page.getByTestId('connect-sequence')).toBeHidden();
}

export async function checkRemoteStatus(page: Page): Promise<void> {
	await openRepositorySettings(page);
	await page.getByTestId('check-remote-status').click();
	await expect(page.getByRole('dialog', { name: 'Rename this Workspace' })).toBeHidden();
}

export async function getFromRemote(page: Page): Promise<void> {
	await openSyncModal(page);
	await page.getByTestId('sync-get').click();
}

export async function openSyncModal(page: Page): Promise<void> {
	await doorButton(page).click();
	await expect(page.getByTestId('sync-modal')).toBeVisible();
}

export async function expectRemoteNamed(page: Page, remote: string): Promise<void> {
	await expect(doorButton(page)).toHaveText('Sync');
	await openRepositorySettings(page);
	await expect(page.getByTestId('workspace-remote-repository')).toContainText(remote);
	await closeWorkspaceDialog(page);
}

export async function expectCredential(page: Page, sentence: string): Promise<void> {
	await openTheDoor(page);
	await expect(page.getByTestId('connect-credential')).toContainText(sentence);
	await closeTheDoor(page);
}

export async function expectNoRemote(page: Page): Promise<void> {
	await expect(doorButton(page)).toHaveText('Sync with GitHub');
	await expect(page.getByTestId('remote-status-slot')).toHaveCount(0);
}

export async function showRemoteStatusDetail(page: Page): Promise<void> {
	const badge = page.getByTestId('where-your-work-is');
	if ((await badge.getAttribute('aria-expanded')) !== 'true') await badge.click();
	await expect(page.getByTestId('remote-status-detail')).toBeVisible();
}

const METADATA_DATABASE = 'ballastella';
const METADATA_DATABASE_VERSION = 3;
const METADATA_STORE = 'synchronization';
const METADATA_STORES = ['workspace', 'synchronization', 'credential'];
const METADATA_FORMAT_VERSION = 2;
const browserWorkspaceKey = (workspace = DEFAULT_WORKSPACE): string => `opfs:${workspace}`;

const putMetadata = (page: Page, key: string, record: Record<string, unknown>): Promise<void> =>
	page.evaluate(
		async ([key, record, database, version, store, stores]) => {
			const open = indexedDB.open(database, version);
			const opened = await new Promise<IDBDatabase>((resolve, reject) => {
				open.onupgradeneeded = () => {
					for (const name of stores) {
						if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name);
					}
				};
				open.onsuccess = () => resolve(open.result);
				open.onerror = () => reject(open.error);
			});
			await new Promise<void>((resolve, reject) => {
				const transaction = opened.transaction(store, 'readwrite');
				const { files } = record as { files?: Record<string, string> };
				const held = files ? { ...record, files: new Map(Object.entries(files)) } : record;
				transaction.objectStore(store).put(held, key);
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
			});
			opened.close();
		},
		[
			key,
			{ formatVersion: METADATA_FORMAT_VERSION, at: new Date().toISOString(), ...record },
			METADATA_DATABASE,
			METADATA_DATABASE_VERSION,
			METADATA_STORE,
			METADATA_STORES
		] as const
	);

const getMetadata = <T>(page: Page, key: string): Promise<T | null> =>
	page.evaluate(
		async ([key, database, store]) => {
			const open = indexedDB.open(database);
			const opened = await new Promise<IDBDatabase | null>((resolve) => {
				open.onsuccess = () => resolve(open.result);
				open.onerror = () => resolve(null);
			});
			if (!opened || !opened.objectStoreNames.contains(store)) {
				opened?.close();
				return null;
			}
			const record = await new Promise<unknown>((resolve) => {
				const request = opened.transaction(store, 'readonly').objectStore(store).get(key);
				request.onsuccess = () => resolve(request.result ?? null);
				request.onerror = () => resolve(null);
			});
			opened.close();
			const { files } = (record ?? {}) as { files?: unknown };
			return (files instanceof Map ? { ...record!, files: [...files.keys()] } : record) as T | null;
		},
		[key, METADATA_DATABASE, METADATA_STORE] as const
	);

export const seedRemoteRelationship = (
	page: Page,
	options: { owner: string; repository: string; branch?: string; workspace?: string }
): Promise<void> =>
	putMetadata(page, relationshipKey(options.workspace), {
		owner: options.owner,
		repository: options.repository,
		branch: options.branch ?? 'main'
	});

export const seedGitHubCredential = (page: Page, token: string): Promise<void> =>
	page.evaluate((held) => sessionStorage.setItem('ballastella.github-credential', held), token);

export const readRemoteRelationship = (
	page: Page,
	workspace?: string
): Promise<{ owner: string; repository: string; branch: string } | null> =>
	getMetadata(page, relationshipKey(workspace));

export async function readBaseline(
	page: Page,
	workspace?: string
): Promise<{ commit: string; files: string[] } | null> {
	const held = await getMetadata<{ commit: string; files: string[] }>(
		page,
		baselineRecordKey(workspace)
	);
	return held === null ? null : { commit: held.commit, files: held.files };
}

export const seedBaseline = (
	page: Page,
	options: {
		owner: string;
		repository: string;
		branch?: string;
		commit?: string;
		files: Readonly<Record<string, string>>;
		workspace?: string;
	}
): Promise<void> =>
	putMetadata(page, baselineRecordKey(options.workspace), {
		owner: options.owner,
		repository: options.repository,
		branch: options.branch ?? 'main',
		commit: options.commit ?? 'seeded-commit',
		files: options.files
	});

const syncKey = (record: string) => (workspace?: string) =>
	`synchronization/${encodeURIComponent(browserWorkspaceKey(workspace))}/${record}`;
const relationshipKey = syncKey('remote');
const baselineRecordKey = syncKey('baseline');

export async function everyByteOf(page: Page, workspace: string): Promise<Record<string, string>> {
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

export async function workspaceNames(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const names: string[] = [];
		for await (const [name, handle] of (await navigator.storage.getDirectory()).entries()) {
			if (handle.kind === 'directory') names.push(name);
		}
		return names.sort();
	});
}

export async function emptyBrowserStorage(
	page: Page,
	options: { keepOpen?: boolean; forget?: boolean; dropDatabase?: boolean } = {}
): Promise<void> {
	await page.evaluate(
		async ({ keepOpen, forget, dropDatabase, database }) => {
			const root = await navigator.storage.getDirectory();
			const open = keepOpen ? await workspaceRoot() : null;
			const empty = async (directory: FileSystemDirectoryHandle, keep?: string) => {
				const names: string[] = [];
				for await (const name of directory.keys()) if (name !== keep) names.push(name);
				await Promise.all(names.map((name) => directory.removeEntry(name, { recursive: true })));
			};
			await empty(root, open?.name);
			if (open) await empty(open);
			if (forget) {
				localStorage.clear();
				localStorage.setItem('ballastella.visited', 'yes');
				sessionStorage.clear();
			} else if (!keepOpen) {
				localStorage.removeItem('ballastella.workspace');
			}
			if (dropDatabase) {
				await new Promise<void>((resolve) => {
					const request = indexedDB.deleteDatabase(database);
					request.onsuccess = request.onerror = request.onblocked = () => resolve();
				});
			}
		},
		{ ...options, database: METADATA_DATABASE }
	);
}

export const emptyWorkspace = (page: Page): Promise<void> =>
	emptyBrowserStorage(page, { keepOpen: true });

export async function everyPathInBrowserStorage(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const paths: string[] = [];
		const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
			for await (const [name, entry] of handle.entries()) {
				if (entry.kind === 'file') paths.push(`${prefix}${name}`);
				else await walk(entry as FileSystemDirectoryHandle, `${prefix}${name}/`);
			}
		};
		await walk(await navigator.storage.getDirectory(), '');
		return paths.sort();
	});
}

export const HUB = './';
