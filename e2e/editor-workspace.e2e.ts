import { asFirstVisit, DEFAULT_WORKSPACE, expect, test } from './support/test.js';
import { type Page } from '@playwright/test';

import {
	deleteProject,
	hashesUnder,
	openNewProject,
	openProjectEditor
} from './support/annotations.js';
import { openAddMapImage } from './support/map-images';
import { openProjectSettings, projectNameField } from './support/project-screen';
import { recordSaveStates } from './support/saved';
import { readStoredFile, seedFile } from './support/stored-file';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	createWorkspace,
	emptyWorkspace as emptyOpenWorkspace,
	switchToWorkspace
} from './support/workspace.js';

test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

async function emptyWorkspace(page: Page): Promise<void> {
	await emptyOpenWorkspace(page);
	await page.evaluate(() => {
		for (const key of Object.keys(localStorage)) {
			if (key.startsWith('ballastella.journal.') || key.startsWith('ballastella.deleted.')) {
				localStorage.removeItem(key);
			}
		}
	});
}

async function fresh(page: Page): Promise<void> {
	await page.goto('./');
	await emptyWorkspace(page);
	await page.reload();
}

const holdBackTheDebounce = (page: Page) =>
	page.addInitScript(() => {
		const real = window.setTimeout;
		window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
			typeof delay === 'number' && delay >= 400
				? 0
				: real(handler as never, delay, ...args)) as typeof window.setTimeout;
	});

async function everyPath(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const paths: string[] = [];
		const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
			for await (const [name, entry] of handle.entries()) {
				if (entry.kind === 'file') paths.push(`${prefix}${name}`);
				else await walk(entry as FileSystemDirectoryHandle, `${prefix}${name}/`);
			}
		};
		await walk(await workspaceRoot(), '');
		return paths.sort();
	});
}

const topLevelNames = (page: Page) =>
	page.evaluate(async () => {
		const names: string[] = [];
		for await (const name of (await workspaceRoot()).keys()) names.push(name);
		return names.sort();
	});

const readProjectName = async (page: Page, directory = 'amsterdam-1625') =>
	JSON.parse(await readStoredFile(page, `${directory}/project.json`)).name as string;

const createProject = async (page: Page, name: string) => {
	await openNewProject(page, name);
	await page.getByTestId('all-projects').click();
	await expect(page.getByRole('link', { name })).toBeVisible();
};

const fillNewProject = async (page: Page, name: string) => {
	await page.getByRole('button', { name: 'New Project' }).click();
	await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill(name);
	await page.getByRole('button', { name: 'Create Project' }).click();
};

test.describe('first contact', () => {
	test('lands a first-time visitor in a Project, not on an empty Workspace Home', async ({
		page
	}) => {
		await page.goto('./');
		await emptyWorkspace(page);
		await asFirstVisit(page);
		await page.reload();

		await expect(page.getByTestId('project-name')).toHaveText('Untitled Project');
		expect(new URL(page.url()).searchParams.get('p')).toBe('untitled-project');
		expect(await everyPath(page)).toEqual(['untitled-project/project.json']);
		await expect(page.getByRole('dialog')).toHaveCount(0);
	});

	test('leaves a returning visitor on an empty Workspace Home, then opens the Project the New Project dialog makes', async ({
		page
	}) => {
		await fresh(page);

		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
		await expect(page.getByText('No Projects yet.')).toBeVisible();
		expect(await everyPath(page)).toEqual([]);

		await fillNewProject(page, 'Amsterdam 1625');

		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		expect(new URL(page.url()).searchParams.get('p')).toBe('amsterdam-1625');
	});
});

test.describe('the Project hub', () => {
	test.beforeEach(({ page }) => fresh(page));

	test('creating a Project writes it to OPFS as ADR-0008 specifies, lists it with when it was saved, and ?p= opens it', async ({
		page
	}) => {
		await createProject(page, 'Amsterdam 1625');

		expect(await everyPath(page)).toEqual(['amsterdam-1625/project.json']);
		expect(JSON.parse(await readStoredFile(page, 'amsterdam-1625/project.json'))).toMatchObject({
			formatVersion: 1,
			name: 'Amsterdam 1625',
			layers: [],
			baseMap: null
		});

		const entry = page.getByRole('listitem').filter({ hasText: 'Amsterdam 1625' });
		await expect(entry.getByRole('link', { name: 'Amsterdam 1625' })).toHaveAttribute(
			'href',
			/\?p=amsterdam-1625$/
		);
		await expect(entry.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
		await expect(entry.getByText('amsterdam-1625')).toBeVisible();

		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();

		await expect(page).toHaveURL(/\?p=amsterdam-1625$/);
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
	});

	test('renaming to a name another Project already has succeeds', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		await createProject(page, 'Boston 1775');

		const editor = await openProjectEditor(page, 'Boston 1775');
		await editor.getByLabel('Project name').fill('Amsterdam 1625');
		await editor.getByRole('button', { name: 'Save Changes' }).click();

		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(2);
		await expect(page.locator('code', { hasText: 'amsterdam-1625' })).toBeVisible();
		await expect(page.locator('code', { hasText: 'boston-1775' })).toBeVisible();
	});

	test('duplicating a Project adds a copy and leaves the original', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');

		await page.getByRole('button', { name: /^Duplicate/ }).click();

		await expect(page.getByRole('link', { name: 'Amsterdam 1625 (copy)' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625', exact: true })).toBeVisible();
	});

	for (const [displayName, folder] of [
		['Images', 'images'],
		['bAsE mAp', 'base-map']
	]) {
		test(`refuses a Project called “${displayName}” and names the reservation`, async ({
			page
		}) => {
			await createProject(page, 'Amsterdam 1625');

			await fillNewProject(page, displayName);

			const refusal = page.getByTestId('reserved-name');
			await expect(refusal).toBeVisible();
			await expect(refusal).toContainText(folder);
			await expect(refusal).toContainText('reserved');

			await expect(page.getByText('Workspace not reachable')).toHaveCount(0);
			await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
			expect(await topLevelNames(page)).toEqual(['amsterdam-1625']);

			await createProject(page, `${displayName} of Amsterdam`);
			await expect(refusal).toHaveCount(0);
		});
	}

	test('deleting a Project removes it from the list and from OPFS', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');

		await deleteProject(page);

		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);
		expect(await topLevelNames(page)).toEqual([]);
	});

	test('New Project is a native <dialog> opened with showModal(), closed by Escape back to its trigger (ADR-0016)', async ({
		page
	}) => {
		const trigger = page.getByRole('button', { name: 'New Project' });
		await trigger.click();
		const dialog = page.getByRole('dialog', { name: 'New Project' });
		await expect(dialog).toBeVisible();

		expect(
			await page.evaluate(() => {
				const dialog = document.querySelector('dialog[open]');
				return {
					tagName: dialog?.tagName ?? null,
					isModal: dialog?.matches(':modal') ?? false,
					holdsFocus: dialog?.contains(document.activeElement) ?? false
				};
			})
		).toEqual({ tagName: 'DIALOG', isModal: true, holdsFocus: true });

		await page.keyboard.press('Escape');

		await expect(dialog).toBeHidden();
		await expect(trigger).toBeFocused();
	});

	test('the keyboard alone creates, opens, and deletes a Project without a pointer', async ({
		page
	}) => {
		const newProject = page.getByRole('button', { name: 'New Project' });
		await newProject.focus();
		await page.keyboard.press('Enter');
		await page
			.getByRole('dialog', { name: 'New Project' })
			.getByLabel('Project name')
			.fill('Keyboard Only');
		await page.keyboard.press('Enter');

		await expect(page.getByTestId('project-name')).toHaveText('Keyboard Only');
		await page.getByTestId('all-projects').focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('link', { name: 'Keyboard Only' })).toBeVisible();

		await page.getByRole('link', { name: 'Keyboard Only' }).focus();
		for (const control of [
			page.getByRole('button', { name: /^Open/ }),
			page.getByRole('button', { name: /^Edit/ }),
			page.getByRole('button', { name: /^Duplicate/ })
		]) {
			await page.keyboard.press('Tab');
			await expect(control).toBeFocused();
		}

		await page.getByRole('button', { name: /^Edit/ }).focus();
		await page.keyboard.press('Enter');
		const editing = page.getByRole('dialog', { name: 'Edit Project' });
		await editing.getByRole('button', { name: 'Delete Project…' }).focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('dialog', { name: 'Delete Project' })).toBeVisible();
		await page.getByRole('button', { name: 'Delete Project', exact: true }).focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('link', { name: 'Keyboard Only' })).toHaveCount(0);
	});

	test('the save indicator transitions saved → unsaved → saving → saved as the Project name is typed (ADR-0017 rule 5)', async ({
		page
	}) => {
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();

		const indicator = page.getByRole('status').getByTestId('where-your-work-is');
		await expect(indicator).toHaveAttribute('data-save-state', 'saved');

		const saveStates = await recordSaveStates(page);
		const field = await projectNameField(page);
		await field.fill('Amsterdam 1626');

		await expect
			.poll(saveStates, { message: 'the save indicator should pass through unsaved and saving' })
			.toEqual(['saved', 'unsaved', 'saving', 'saved']);

		await expect(indicator).toHaveText('Saved here');

		await page.reload();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1626');
	});

	test('opening a Project, tabbing and clicking through its name field, and closing it writes nothing (ADR-0010)', async ({
		page
	}) => {
		await createProject(page, 'Amsterdam 1625');
		await seedFile(
			page,
			'amsterdam-1625/annotations/l-notes.geojson',
			'{"type":"FeatureCollection","features":[]}'
		);
		const before = await hashesUnder(page, '', 'amsterdam-1625');
		expect(before.map((line) => line.split(' ')[0])).toEqual([
			'annotations/l-notes.geojson',
			'project.json'
		]);

		await page.goto('./?p=amsterdam-1625');
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		const dialog = await openProjectSettings(page);
		const field = dialog.getByLabel('Project name');
		await expect(field).toBeVisible();

		await field.focus();
		await expect(field).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(field).not.toBeFocused();

		await field.click();
		await dialog.getByRole('heading', { name: 'Project settings' }).click();
		await expect(field).not.toBeFocused();

		await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
		await page.waitForTimeout(600);
		expect(await hashesUnder(page, '', 'amsterdam-1625')).toEqual(before);

		await page.goto('./');
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
		expect(await hashesUnder(page, '', 'amsterdam-1625')).toEqual(before);
	});
});

test.describe('the Workspace’s Map Images', () => {
	const manifest = (label: string) => JSON.stringify({ label: { none: [label] } });
	const projectWith = (name: string, imageIds: readonly string[]) =>
		JSON.stringify({
			formatVersion: 1,
			name,
			updatedAt: '2026-01-02T03:04:05.000Z',
			layers: imageIds.map((imageId, order) => ({
				kind: 'map',
				id: `layer-${order}`,
				name: `${name} layer`,
				visible: true,
				order,
				opacity: 1,
				imageId
			}))
		});

	const seedImage = async (page: Page, imageId: string, label: string) => {
		await seedFile(
			page,
			`images/${imageId}/info.json`,
			`{"id":"https://unset.invalid/${imageId}"}`
		);
		await seedFile(page, `images/${imageId}/manifest.json`, manifest(label));
		await seedFile(page, `images/${imageId}/0,0,256,256/256,256/0/default.jpg`, 'x'.repeat(50_000));
	};

	const entry = (page: Page, label: string) =>
		page.getByTestId('map-image').filter({ hasText: label });
	const deleteButton = (page: Page, label: string) =>
		entry(page, label).getByRole('button', { name: /^Delete/ });

	test.beforeEach(async ({ page }) => {
		await page.goto('./');
		await emptyWorkspace(page);
		for (const [imageId, label] of [
			['shared', 'Blaeu’s plan of Amsterdam'],
			['solo', 'Bonner’s Boston'],
			['orphan', 'A map nobody kept']
		] as const) {
			await seedImage(page, imageId, label);
			await seedFile(page, `alignments/${imageId}.json`, '{}');
		}
		await seedFile(
			page,
			'images/remote-one/remote.json',
			JSON.stringify({
				service: 'https://iiif.bnf.example/iiif/3/btv1b',
				label: 'Plan de Paris',
				width: 4000,
				height: 3000
			})
		);
		await seedFile(
			page,
			'amsterdam-1625/project.json',
			projectWith('Amsterdam 1625', ['shared', 'solo'])
		);
		await seedFile(page, 'boston-1775/project.json', projectWith('Boston 1775', ['shared']));
		await page.reload();
		await expect(page.getByTestId('map-image')).toHaveCount(4);
	});

	test('lists Map Images weighed and attributed from disk, confirms in a modal closable by Escape, and deletes an unused one with its remote.json and Alignment', async ({
		page
	}) => {
		await expect(entry(page, 'Blaeu’s plan of Amsterdam')).toContainText('50 kB in 4 files');
		await expect(entry(page, 'Plan de Paris')).toContainText('Tiles on iiif.bnf.example');
		await expect(entry(page, 'Blaeu’s plan of Amsterdam')).toContainText('Tiles in this Workspace');
		await expect(entry(page, 'Blaeu’s plan of Amsterdam')).toContainText(
			'Projects that use this image: Amsterdam 1625, Boston 1775.'
		);
		await expect(entry(page, 'A map nobody kept')).toContainText(
			'Projects that use this image: None.'
		);
		const total = page.getByTestId('map-images-total');
		await expect(total).toContainText('4');
		await expect(total).toContainText('(3 local, 1 IIIF external)');
		await expect(page.getByTestId('map-images-size')).toHaveText('150 kB');

		const trigger = deleteButton(page, 'A map nobody kept');
		await trigger.click();
		const dialog = page.getByRole('dialog', { name: 'Delete Map Image' });
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText('A map nobody kept');
		await expect(dialog).toContainText('50 kB');
		expect(
			await page.evaluate(() => document.querySelector('dialog[open]')?.matches(':modal') ?? false)
		).toBe(true);

		await page.keyboard.press('Escape');

		await expect(dialog).toBeHidden();
		await expect(trigger).toBeFocused();
		await expect(page.getByTestId('map-image')).toHaveCount(4);

		await trigger.click();
		await page.getByRole('button', { name: 'Delete Map Image' }).click();

		await expect(page.getByTestId('map-image')).toHaveCount(3);
		await expect(total).toContainText('3');
		await expect(total).toContainText('(2 local, 1 IIIF external)');
		await expect(page.getByTestId('map-images-size')).toHaveText('100 kB');
		const announcement = page.getByTestId('map-image-status');
		await expect(announcement).toHaveAttribute('aria-live', 'polite');
		await expect(announcement).toContainText('Deleted A map nobody kept, reclaiming 50 kB');

		const remaining = await everyPath(page);
		expect(remaining.filter((path) => path.startsWith('images/orphan/'))).toEqual([]);
		expect(remaining).not.toContain('alignments/orphan.json');
		expect(remaining).toContain('alignments/shared.json');
		expect(remaining).toContain('images/shared/info.json');
		expect(remaining).toContain('amsterdam-1625/project.json');
	});

	test('deleting a Project keeps the Workspace’s Map Images, and the dialog says so', async ({
		page
	}) => {
		const editor = await openProjectEditor(page, 'Boston 1775');
		await editor.getByRole('button', { name: 'Delete Project…' }).click();

		const dialog = page.getByRole('dialog', { name: 'Delete Project' });
		await expect(dialog).toContainText('The Map Images it drew stay in the Workspace');
		await expect(dialog).not.toContainText('Its Map Images');
		await page.getByRole('button', { name: 'Delete Project', exact: true }).click();

		await expect(page.getByRole('link', { name: 'Boston 1775' })).toHaveCount(0);
		await expect(entry(page, 'Blaeu’s plan of Amsterdam')).toContainText(
			'Projects that use this image: Amsterdam 1625.'
		);
		const remaining = await everyPath(page);
		expect(remaining).toContain('images/shared/info.json');
		expect(remaining).toContain('alignments/shared.json');
	});

	test('refuses to delete a map two Projects use, naming both, and keeps the pyramid', async ({
		page
	}) => {
		const before = await everyPath(page);

		await deleteButton(page, 'Blaeu’s plan of Amsterdam').click();
		await expect(page.getByTestId('delete-map-consequence')).toContainText(
			'deleting it will be refused'
		);
		await page.getByRole('button', { name: 'Delete Map Image' }).click();

		const refusal = page.getByTestId('map-image-refused');
		await expect(refusal).toContainText('Amsterdam 1625');
		await expect(refusal).toContainText('Boston 1775');
		expect(await everyPath(page)).toEqual(before);
	});

	test('confirms before deleting even when the list is a moment out of date', async ({ page }) => {
		await expect(entry(page, 'Bonner’s Boston')).toContainText(
			'Projects that use this image: Amsterdam 1625.'
		);

		await page.evaluate(async () =>
			(await workspaceRoot()).removeEntry('amsterdam-1625', { recursive: true })
		);
		const before = await everyPath(page);

		await deleteButton(page, 'Bonner’s Boston').click();

		await expect(page.getByRole('dialog', { name: 'Delete Map Image' })).toBeVisible();
		expect(await everyPath(page)).toEqual(before);

		await page.getByRole('button', { name: 'Delete Map Image' }).click();
		await expect(entry(page, 'Bonner’s Boston')).toHaveCount(0);
		expect((await everyPath(page)).filter((path) => path.startsWith('images/solo/'))).toEqual([]);
	});

	test('will not call a map unused, or delete it, because a Project is from a newer version', async ({
		page
	}) => {
		await emptyWorkspace(page);
		await seedImage(page, 'orphan', 'A map nobody kept');
		await seedFile(
			page,
			'from-the-future/project.json',
			'{"formatVersion":2,"name":"Tomorrow","layers":[{"kind":"something-new"}],"baseMap":null}'
		);
		await page.reload();

		await expect(
			page.getByText('Made with a newer version of Ballastella.', { exact: true })
		).toBeVisible();
		await expect(entry(page, 'A map nobody kept')).not.toContainText(
			'Projects that use this image: None.'
		);
		await expect(entry(page, 'A map nobody kept')).toContainText('from-the-future');

		const before = await everyPath(page);
		await deleteButton(page, 'A map nobody kept').click();
		await page.getByRole('button', { name: 'Delete Map Image' }).click();

		await expect(page.getByTestId('map-image-refused')).toContainText('from-the-future');
		expect(await everyPath(page)).toEqual(before);
	});

	test('a Workspace with no Map Images says so', async ({ page }) => {
		await emptyWorkspace(page);
		await page.reload();

		await expect(page.getByTestId('no-map-images')).toHaveText('No Map Images yet.');
		await expect(page.getByTestId('map-image')).toHaveCount(0);
	});
});

test.describe('surviving a real navigation (ADR-0017 rule 3, as amended)', () => {
	test.beforeEach(async ({ page }) => {
		await holdBackTheDebounce(page);
		await fresh(page);
	});

	const openProject = async (page: Page) => {
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');
		return projectNameField(page);
	};

	const openAndRename = async (page: Page, typed: string) => {
		await (await openProject(page)).fill(typed);
		expect(await readProjectName(page)).toBe('Amsterdam 1625');
	};

	const noteDeletion = (page: Page, updatedAt?: string) =>
		page.evaluate(async (updatedAt) => {
			const project = await (await workspaceRoot()).getDirectoryHandle('amsterdam-1625');
			const manifest = JSON.parse(
				await (await (await project.getFileHandle('project.json')).getFile()).text()
			);
			const workspace = `opfs:${localStorage.getItem('ballastella.workspace') || 'My Workspace'}`;
			localStorage.setItem(
				`ballastella.deleted.${encodeURIComponent(workspace)}/${encodeURIComponent('amsterdam-1625')}`,
				JSON.stringify({
					formatVersion: 1,
					at: new Date().toISOString(),
					was: { name: manifest.name, updatedAt: updatedAt ?? manifest.updatedAt }
				})
			);
		}, updatedAt);

	const journal = (page: Page, path: string, text: string) =>
		page.evaluate(
			([path, text]) => {
				const workspace = `opfs:${localStorage.getItem('ballastella.workspace') || 'My Workspace'}`;
				localStorage.setItem(
					`ballastella.journal.${encodeURIComponent(workspace)}/${encodeURIComponent(path)}`,
					JSON.stringify({ formatVersion: 1, at: new Date().toISOString(), bytes: btoa(text) })
				);
			},
			[path, text] as const
		);

	test('pagehide flushes a write that is still inside its debounce window (rule 3)', async ({
		page
	}) => {
		await openAndRename(page, 'Half a keystroke ago');

		await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));

		await expect.poll(() => readProjectName(page)).toBe('Half a keystroke ago');
	});

	test('a debounced rename survives a reload inside the debounce window, says so to a screen reader, and leaves the screen usable', async ({
		page
	}) => {
		await openAndRename(page, 'Amsterdam 1626');

		await page.reload();

		await expect
			.poll(() => readProjectName(page), {
				message: 'the rename should be in OPFS after a real reload, not only on screen'
			})
			.toBe('Amsterdam 1626');
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1626');

		const notice = page.getByTestId('recovered-edits');
		await expect(notice).toBeVisible();
		await expect(notice).toContainText('amsterdam-1625/project.json');
		await expect(page.getByTestId('recovered-region')).toHaveAttribute('aria-live', 'polite');

		const addDialog = await openAddMapImage(page);
		await expect(notice).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(addDialog).toBeHidden();

		await page.getByTestId('recovered-dismiss').click();
		await expect(notice).toBeHidden();
		expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('MAIN');
	});

	test('replays the last edit to a file, not an earlier one', async ({ page }) => {
		const field = await openProject(page);
		await field.fill('A name typed and thought better of');
		await field.fill('Amsterdam 1625');

		await page.reload();

		expect(await readProjectName(page)).toBe('Amsterdam 1625');
	});

	test('does not put an edit back into a Project the user deleted', async ({ page }) => {
		await openAndRename(page, 'Gone before it was saved');

		await page.goto('./');
		await deleteProject(page);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);

		await page.reload();

		await expect(page.getByText('No Projects yet')).toBeVisible();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Gone before it was saved' })).toHaveCount(0);
		expect(await everyPath(page)).toEqual([]);
	});

	test('says at startup which Project it finished deleting', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		await noteDeletion(page);

		await page.reload();

		await expect(page.getByTestId('deletion-finished')).toContainText('amsterdam-1625');
		await expect(page.getByText('No Projects yet')).toBeVisible();
		expect(await everyPath(page)).toEqual([]);
	});

	test('says at startup which deletion it would not carry out, and leaves the Project alone', async ({
		page
	}) => {
		await createProject(page, 'Amsterdam 1625');
		await noteDeletion(page, '2020-01-01T00:00:00.000Z');

		await page.reload();

		await expect(page.getByTestId('deletion-refused')).toContainText('Amsterdam 1625');
		await expect(page.getByTestId('deletion-refused')).toContainText('nothing was removed');
		await expect(page.getByTestId('recovered-edits')).toContainText('A deletion was not finished');
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		expect(await everyPath(page)).toEqual(['amsterdam-1625/project.json']);
	});

	test('says when the browser will not write a deletion down', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		await page.evaluate(() => {
			const setItem = Storage.prototype.setItem;
			Storage.prototype.setItem = function (key: string, value: string) {
				if (key.startsWith('ballastella.deleted.')) throw new Error('QuotaExceededError');
				setItem.call(this, key, value);
			};
		});

		await deleteProject(page);

		await expect(page.getByTestId('deletion-warning')).toContainText(
			'would not let Ballastella write the deletion down'
		);
		await expect(page.getByText('No Projects yet')).toBeVisible();
	});

	test('does not leak a deleted Project’s file into a new one that reused its folder', async ({
		page
	}) => {
		await createProject(page, 'Amsterdam 1625');
		await journal(page, 'amsterdam-1625/annotations/stray.geojson', '{}');

		await deleteProject(page);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);

		await createProject(page, 'Amsterdam 1625');

		await page.reload();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();

		expect(await everyPath(page)).toEqual(['amsterdam-1625/project.json']);
	});

	test('offers no way to throw away a copy the Workspace already has', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		const path = 'amsterdam-1625/project.json';
		await journal(page, path, await readStoredFile(page, path));

		await page.reload();

		const notice = page.getByTestId('recovered-edits');
		await expect(notice).toBeVisible();
		await expect(notice).toContainText('did not need to be put back');
		await expect(page.getByTestId('recovered-restored')).toHaveCount(0);
		await expect(page.getByTestId('forget-replay-skip')).toHaveCount(0);
	});

	test('offers a way to throw away a copy it is still holding', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		const path = 'amsterdam-1625/project.json';
		await journal(page, path, '{"formatVersion":1,"name":"A rename that never reached the disk"}');

		await page.reload();

		const notice = page.getByTestId('recovered-edits');
		await expect(notice).toBeVisible();
		await expect(notice).toContainText('cannot tell whether it is newer');
		const exit = page.getByTestId('forget-replay-skip');
		await expect(exit).toHaveCount(1);
		await expect(exit).toHaveAccessibleName(`Throw away the kept copy of “${path}”`);
		await exit.click();
		await expect(page.getByTestId('recovered-skipped')).toHaveCount(0);

		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
	});

	test('does not put an edit into a different named Workspace, and puts it back when its own is opened again', async ({
		page
	}) => {
		await openAndRename(page, 'Typed in the first Workspace');

		await page.goto('./');
		await createWorkspace(page, 'Teaching');
		await expect(page.getByText('No Projects yet')).toBeVisible();

		await page.reload();

		expect(await everyPath(page)).toEqual([]);
		await expect(page.getByTestId('recovered-edits')).toBeHidden();

		await switchToWorkspace(page, DEFAULT_WORKSPACE);

		await expect(page.getByRole('link', { name: 'Typed in the first Workspace' })).toBeVisible();
		expect(await readProjectName(page)).toBe('Typed in the first Workspace');
	});
});

test('a Project from a newer version is listed as unopenable, and opening it is refused with the remedy and leaves it unmodified (ADR-0010)', async ({
	page
}) => {
	const fromTheFuture =
		'{"formatVersion":2,"name":"Tomorrow","layers":[{"kind":"something-new"}],"baseMap":null}';
	await page.goto('./');
	await emptyWorkspace(page);
	await seedFile(page, 'from-the-future/project.json', fromTheFuture);
	const before = await hashesUnder(page, '', 'from-the-future');

	await page.goto('./');
	await expect(page.getByText('Made with a newer version of Ballastella.')).toBeVisible();

	await page.goto('./?p=from-the-future');

	const alert = page.getByRole('alert');
	await expect(alert).toContainText('newer version of Ballastella');
	await expect(alert).toContainText('update your copy');
	await expect(alert).toContainText('https://');

	expect(await hashesUnder(page, '', 'from-the-future')).toEqual(before);
	expect(await readStoredFile(page, 'from-the-future/project.json')).toBe(fromTheFuture);
});

test('an unreachable Workspace shows "Workspace not reachable" with a locate-again action, not an error boundary (ADR-0008)', async ({
	page
}) => {
	await page.addInitScript(() => {
		navigator.storage.getDirectory = () =>
			Promise.reject(new DOMException('The Workspace could not be found', 'NotFoundError'));
	});
	await page.goto('./');

	const alert = page.getByRole('alert');
	await expect(alert).toContainText('Workspace not reachable');
	await expect(alert).toContainText('The Workspace could not be found');

	const locate = page.getByRole('button', { name: 'Locate Workspace again' });
	await expect(locate).toBeVisible();
	await locate.focus();
	await expect(locate).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(alert).toContainText('Workspace not reachable');

	await expect(page.getByRole('heading', { level: 1, name: 'Ballastella Editor' })).toBeVisible();
});
