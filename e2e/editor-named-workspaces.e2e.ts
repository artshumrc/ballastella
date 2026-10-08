import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { seedMapLayer } from './support/project-screen';
import { openLayerRow } from './support/layers';
import { recordSaveStates } from './support/saved';
import {
	deleteWorkspace,
	createWorkspace,
	editWorkspace,
	expectWorkspaceNamed,
	openWorkspaceMenu,
	switchToWorkspace,
	workspaceButton,
	emptyBrowserStorage,
	everyPathInBrowserStorage,
	HUB
} from './support/workspace.js';
const PROJECT = 'amsterdam-1625';

test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

async function readInWorkspace(
	page: Page,
	workspace: string,
	path: string
): Promise<string | null> {
	return page.evaluate(
		async ([workspace, path]) => {
			const segments = path.split('/');
			const name = segments.pop() as string;
			try {
				let directory = await (
					await navigator.storage.getDirectory()
				).getDirectoryHandle(workspace);
				for (const segment of segments) directory = await directory.getDirectoryHandle(segment);
				return await (await (await directory.getFileHandle(name)).getFile()).text();
			} catch {
				return null;
			}
		},
		[workspace, path] as const
	);
}

async function holdTheDebounce(page: Page): Promise<void> {
	await page.evaluate(() => {
		const real = window.setTimeout.bind(window);
		window.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) =>
			ms === 400 ? 0 : real(handler, ms, ...rest)) as typeof window.setTimeout;
	});
}

async function storedOpacity(page: Page, workspace: string): Promise<number | null> {
	const text = await readInWorkspace(page, workspace, `${PROJECT}/project.json`);
	if (text === null) return null;
	const layers = (JSON.parse(text) as { layers?: { opacity?: number }[] }).layers ?? [];
	return layers[0]?.opacity ?? null;
}

const createProject = async (page: Page, name: string) => {
	await page.getByRole('button', { name: 'New Project' }).click();
	await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill(name);
	await page.getByRole('button', { name: 'Create Project' }).click();
	await expect(page.getByTestId('project-name')).toHaveText(name);
	await page.getByTestId('all-projects').click();
	await expect(page.getByRole('link', { name })).toBeVisible();
};

const seedJournals = (
	page: Page,
	workspace: string,
	deletions: readonly string[],
	journals: readonly string[] = []
) =>
	page.evaluate(
		({ workspace, deletions, journals }) => {
			const key = encodeURIComponent(`opfs:${workspace}`);
			const at = new Date().toISOString();
			for (const directory of deletions) {
				localStorage.setItem(
					`ballastella.deleted.${key}/${encodeURIComponent(directory)}`,
					JSON.stringify({ formatVersion: 1, at, was: null })
				);
			}
			for (const path of journals) {
				localStorage.setItem(
					`ballastella.journal.${key}/${encodeURIComponent(path)}`,
					JSON.stringify({ formatVersion: 1, at, bytes: btoa('{}') })
				);
			}
		},
		{ workspace, deletions, journals }
	);

const deletionKeys = (page: Page) =>
	page.evaluate(() =>
		Object.keys(localStorage).filter((key) => key.startsWith('ballastella.deleted.'))
	);

async function startOnTheHub(page: Page): Promise<void> {
	await page.goto(HUB);
	await emptyBrowserStorage(page);
	await page.reload();
}

async function secondWorkspaceWithBoston(page: Page): Promise<void> {
	await createWorkspace(page, 'Marking 2026');
	await createProject(page, 'Boston 1775');
	await switchToWorkspace(page, DEFAULT_WORKSPACE);
}

test.describe('the Workspace on the bar', () => {
	test.beforeEach(async ({ page }) => startOnTheHub(page));

	test('asks nothing about where work is stored on a first visit, and its editing dialog says where the files are', async ({
		page
	}) => {
		await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

		await expect(page.getByTestId('move-into-folder')).toHaveCount(0);
		await editWorkspace(page, DEFAULT_WORKSPACE);
		await expect(page.getByTestId('rename-workspace-name')).toBeVisible();
		await expect(page.getByTestId('workspace-storage-place')).toHaveText(DEFAULT_WORKSPACE);
		await expect(page.getByTestId('move-into-folder')).toBeVisible();
		await expect(page.getByTestId('install-offer')).toBeVisible();
		await expect(page.getByTestId('durability-lead')).toBeVisible();
		await page.keyboard.press('Escape');

		await openWorkspaceMenu(page);
		await expect(page.getByTestId('workspace-header')).toContainText(DEFAULT_WORKSPACE);
		await expect(page.getByTestId('workspace-backing')).toHaveText('Kept in this browser');
		await expect(page.getByTestId('workspace-header')).not.toContainText('GitHub');
		await expect(page.getByTestId('switch-workspace')).toHaveCount(1);
		for (const absent of [
			'delete-workspace',
			'locate-workspace-folder',
			'use-browser-storage',
			'reopen-workspace-folder',
			'choose-workspace-folder',
			'open-workspace-settings',
			'open-remote-settings'
		])
			await expect(page.getByTestId(absent)).toHaveCount(0);

		await page.keyboard.press('Escape');
		await expect(page.getByTestId('workspace-switcher-menu')).toBeHidden();
	});

	test('names the Workspace everywhere, keeps a second one apart and remembered, and announces what happened', async ({
		page
	}) => {
		const announced = page.getByTestId('workspace-announcement');
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
		await page.getByTestId('all-projects').click();

		await createWorkspace(page, 'Marking 2026');
		await expect(announced).toHaveText('Created the Workspace “Marking 2026” and switched to it.');
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);
		await expect(page.getByText('No Projects yet')).toBeVisible();

		await createProject(page, 'Boston 1775');
		expect(await everyPathInBrowserStorage(page)).toEqual(
			[
				`${DEFAULT_WORKSPACE}/amsterdam-1625/project.json`,
				'Marking 2026/boston-1775/project.json'
			].sort()
		);

		await page.reload();
		await expectWorkspaceNamed(page, 'Marking 2026');
		await expect(page.getByRole('link', { name: 'Boston 1775' })).toBeVisible();

		await switchToWorkspace(page, DEFAULT_WORKSPACE);
		await expect(announced).toHaveText(`Switched to the Workspace “${DEFAULT_WORKSPACE}”.`);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Boston 1775' })).toHaveCount(0);

		await openWorkspaceMenu(page);
		await page.getByTestId('new-workspace').click();
		await page.getByTestId('new-workspace-name').fill('Marking 2026');
		await page.getByTestId('create-workspace').click();
		await expect(announced).toHaveText(
			'Created the Workspace “Marking 2026 (2)” and switched to it.'
		);
		await expectWorkspaceNamed(page, 'Marking 2026 (2)');
		await expect(workspaceButton(page)).toBeFocused();
	});

	test('is operable from the keyboard alone, and gives focus back to the switcher when its dialog closes', async ({
		page
	}) => {
		await workspaceButton(page).focus();
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('workspace-switcher-menu')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('workspace-switcher-menu')).toBeHidden();

		await workspaceButton(page).focus();
		await page.keyboard.press('Enter');
		await page.getByTestId('new-workspace').focus();
		await page.keyboard.press('Enter');
		await page.getByTestId('new-workspace-name').fill('Typed 2026');
		await page.keyboard.press('Enter');
		await expectWorkspaceNamed(page, 'Typed 2026');
		await expect(workspaceButton(page)).toBeFocused();

		for (const dismiss of [
			async () => page.getByRole('button', { name: 'Cancel' }).click(),
			async () => page.keyboard.press('Escape')
		]) {
			await openWorkspaceMenu(page);
			await page.getByTestId('new-workspace').click();
			await expect(page.getByTestId('new-workspace-name')).toBeFocused();
			await dismiss();
			await expect(page.getByTestId('new-workspace-name')).toHaveCount(0);
			await expect(workspaceButton(page)).toBeFocused();
		}
	});
});

test('flushes the pending write to the Workspace being left, and writes nothing to the one entered', async ({
	page
}) => {
	await startOnTheHub(page);
	await createProject(page, 'Amsterdam 1625');
	await createWorkspace(page, 'Marking 2026');
	await switchToWorkspace(page, DEFAULT_WORKSPACE);
	await seedMapLayer(page, 'blaeu', 'Blaeu sheet', PROJECT);

	await page.goto(`${HUB}?p=${PROJECT}`);
	await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
	const states = await recordSaveStates(page);
	await holdTheDebounce(page);

	const row = await openLayerRow(page);
	await row.getByTestId('layer-opacity').evaluate((node) => {
		(node as HTMLInputElement).value = '0.5';
		node.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await expect(page.getByTestId('layer-opacity-value')).toHaveText('50%');

	await expect.poll(async () => await states()).toContain('unsaved');
	expect(
		await storedOpacity(page, DEFAULT_WORKSPACE),
		'the debounce should still be holding these bytes'
	).toBe(1);

	await switchToWorkspace(page, 'Marking 2026');

	await expect.poll(async () => storedOpacity(page, DEFAULT_WORKSPACE)).toBe(0.5);
	expect(await everyPathInBrowserStorage(page)).toEqual([
		`${DEFAULT_WORKSPACE}/amsterdam-1625/project.json`
	]);
});

test.describe('deleting a Workspace', () => {
	test.beforeEach(async ({ page }) => startOnTheHub(page));

	test('offers only one you are not inside, keeps it when declined, and otherwise removes it entirely after naming its size', async ({
		page
	}) => {
		await secondWorkspaceWithBoston(page);

		await openWorkspaceMenu(page);
		await expect(page.getByTestId('delete-workspace')).toHaveCount(1);
		await expect(page.getByRole('button', { name: 'Delete Marking 2026' })).toBeVisible();
		await expect(page.getByRole('button', { name: `Delete ${DEFAULT_WORKSPACE}` })).toHaveCount(0);
		await page.getByRole('button', { name: 'Delete Marking 2026' }).click();
		await page.getByRole('button', { name: 'Keep it' }).click();
		expect(await readInWorkspace(page, 'Marking 2026', 'boston-1775/project.json')).not.toBeNull();

		await openWorkspaceMenu(page);
		await page.getByRole('button', { name: 'Delete Marking 2026' }).click();
		const confirm = page.getByRole('dialog', { name: 'Delete this Workspace?' });
		await expect(confirm).toBeVisible();
		await expect(confirm).toContainText('Marking 2026');
		await expect(page.getByTestId('delete-workspace-size')).toContainText(
			/It holds 1\s+file, \d+ bytes\./
		);
		await page.getByTestId('confirm-delete-workspace').click();

		await expect(page.getByTestId('workspace-announcement')).toContainText('Marking 2026');
		expect(await everyPathInBrowserStorage(page)).toEqual([]);
	});

	test('takes the Workspace’s unfinished deletions with it, not only its journal', async ({
		page
	}) => {
		await secondWorkspaceWithBoston(page);
		await seedJournals(page, 'Marking 2026', ['boston-1775']);

		await deleteWorkspace(page, 'Marking 2026');
		await expect(page.getByTestId('workspace-announcement')).toContainText('Marking 2026');
		expect(await deletionKeys(page)).toEqual([]);
	});

	test('reports and discards an unfinished deletion left by a Workspace that is gone', async ({
		page
	}) => {
		await seedJournals(page, 'A Workspace nobody has any more', ['boston-1775']);
		await page.reload();
		await editWorkspace(page, DEFAULT_WORKSPACE);

		await expect(page.getByTestId('orphaned-journals')).toContainText(
			'A Workspace nobody has any more'
		);
		await page.getByTestId('discard-orphaned-journal').click();

		await expect(page.getByTestId('discard-outcome')).toContainText(
			'Threw away 1 unfinished deletion'
		);
		await expect(page.getByTestId('discard-outcome')).not.toContainText('unsaved');
	});

	test('names both kinds when an absent Workspace held edits and deletions', async ({ page }) => {
		await seedJournals(
			page,
			'A Workspace nobody has any more',
			['boston-1775', 'amsterdam-1625'],
			['boston-1775/project.json', 'boston-1775/annotations/one.geojson']
		);
		await page.reload();
		await editWorkspace(page, DEFAULT_WORKSPACE);

		await page.getByTestId('discard-orphaned-journal').click();

		await expect(page.getByTestId('discard-outcome')).toContainText(
			'Threw away 2 unsaved changes and 2 unfinished deletions'
		);
		await expect(page.getByTestId('orphaned-journals')).toHaveCount(0);
		expect(await deletionKeys(page)).toEqual([]);
	});
});

test('surfaces an unreachable Workspace on the hub rather than hiding it in settings', async ({
	page
}) => {
	await page.addInitScript(() => {
		navigator.storage.getDirectory = () =>
			Promise.reject(new DOMException('The Workspace could not be found', 'NotFoundError'));
	});
	await page.goto(HUB);

	const alert = page.getByRole('alert').filter({ hasText: 'Workspace not reachable' });
	await expect(alert).toHaveCount(1);
	await expect(alert).toContainText('Nothing has been lost');
	await expect(page.getByRole('heading', { level: 1, name: 'Ballastella Editor' })).toBeVisible();
});
