import { expect, test, type Page } from '@playwright/test';

/**
 * SPEC's Seam 2: the running app in a real browser against real OPFS.
 *
 * Everything here is a browser behaviour that the core suite cannot see — the save indicator
 * transitioning, the `formatVersion: 2` refusal reaching a screen, "Workspace not reachable"
 * being a page rather than an error boundary, and `<dialog>`'s Escape and focus restoration.
 * The storage layer itself is asserted in `@ballastella/core`, against both adapters.
 */

/** Empty the origin's OPFS, so no test can see another's Projects. */
async function emptyWorkspace(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
	});
}

/** Write a `project.json` straight into OPFS, bypassing the app entirely. */
async function seedProject(page: Page, directory: string, json: string): Promise<void> {
	await page.evaluate(
		async ([directory, json]) => {
			const root = await navigator.storage.getDirectory();
			const project = await root.getDirectoryHandle(directory as string, { create: true });
			const file = await project.getFileHandle('project.json', { create: true });
			const writable = await file.createWritable();
			await writable.write(json as string);
			await writable.close();
		},
		[directory, json]
	);
}

/** SHA-256 of every file in a Project directory, so "nothing was written" is provable. */
async function hashProject(page: Page, directory: string): Promise<Record<string, string>> {
	return page.evaluate(async (directory) => {
		const root = await navigator.storage.getDirectory();
		const project = await root.getDirectoryHandle(directory);
		const hashes: Record<string, string> = {};
		for await (const [name, handle] of project.entries()) {
			if (handle.kind !== 'file') continue;
			const bytes = await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer();
			const digest = await crypto.subtle.digest('SHA-256', bytes);
			hashes[name] = [...new Uint8Array(digest)]
				.map((byte) => byte.toString(16).padStart(2, '0'))
				.join('');
		}
		return hashes;
	}, directory);
}

const createProject = async (page: Page, name: string) => {
	await page.getByRole('button', { name: 'New Project' }).click();
	await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill(name);
	await page.getByRole('button', { name: 'Create Project' }).click();
	await expect(page.getByRole('link', { name })).toBeVisible();
};

test.describe('the Project hub', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('./');
		await emptyWorkspace(page);
		await page.reload();
	});

	test('creating a Project lists it with its name and when it was last saved', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');

		const entry = page.getByRole('listitem').filter({ hasText: 'Amsterdam 1625' });
		// Addressed by query parameter, never by a per-Project path (ADR-0008).
		await expect(entry.getByRole('link', { name: 'Amsterdam 1625' })).toHaveAttribute(
			'href',
			/\?p=amsterdam-1625$/
		);
		await expect(entry.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
		await expect(entry.getByText('amsterdam-1625')).toBeVisible();
	});

	test('the Project is really in OPFS, laid out as ADR-0008 specifies', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');

		expect(Object.keys(await hashProject(page, 'amsterdam-1625'))).toEqual(['project.json']);
		const contents = await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const project = await root.getDirectoryHandle('amsterdam-1625');
			const file = await project.getFileHandle('project.json');
			return (await file.getFile()).text();
		});
		expect(JSON.parse(contents)).toMatchObject({
			formatVersion: 1,
			name: 'Amsterdam 1625',
			layers: [],
			baseMap: null
		});
	});

	test('?p= opens the Project it names', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');

		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();

		await expect(page).toHaveURL(/\?p=amsterdam-1625$/);
		await expect(page.getByRole('heading', { level: 2, name: 'Amsterdam 1625' })).toBeVisible();
	});

	test('renaming to a name another Project already has succeeds', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		await createProject(page, 'Boston 1775');

		const boston = page.getByRole('listitem').filter({ hasText: 'Boston 1775' });
		await boston.getByRole('button', { name: /^Rename/ }).click();
		await page
			.getByRole('dialog', { name: 'Rename Project' })
			.getByLabel('New name')
			.fill('Amsterdam 1625');
		await page.getByRole('button', { name: 'Rename', exact: true }).click();

		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(2);
		// Two display names, two distinct folders: identity is the folder, never the name.
		await expect(page.locator('code', { hasText: 'amsterdam-1625' })).toBeVisible();
		await expect(page.locator('code', { hasText: 'boston-1775' })).toBeVisible();
	});

	test('duplicating a Project adds a copy and leaves the original', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');

		await page.getByRole('button', { name: /^Duplicate/ }).click();

		await expect(page.getByRole('link', { name: 'Amsterdam 1625 (copy)' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625', exact: true })).toBeVisible();
	});

	test('deleting a Project removes it from the list and from OPFS', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');

		await page.getByRole('button', { name: /^Delete/ }).click();
		await page.getByRole('button', { name: 'Delete Project' }).click();

		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);
		const remaining = await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const names: string[] = [];
			for await (const name of root.keys()) names.push(name);
			return names;
		});
		expect(remaining).toEqual([]);
	});
});

test.describe('dialogs (ADR-0016)', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('./');
		await emptyWorkspace(page);
		await page.reload();
	});

	test('Escape closes the dialog and focus returns to the button that opened it', async ({
		page
	}) => {
		const trigger = page.getByRole('button', { name: 'New Project' });
		await trigger.click();
		const dialog = page.getByRole('dialog', { name: 'New Project' });
		await expect(dialog).toBeVisible();

		await page.keyboard.press('Escape');

		await expect(dialog).toBeHidden();
		await expect(trigger).toBeFocused();
	});

	test('is a native <dialog> opened with showModal(), not one of the banned methods', async ({
		page
	}) => {
		await page.getByRole('button', { name: 'New Project' }).click();

		// `:modal` matches only a dialog opened by `showModal()`, so this rules out the
		// checkbox-hack and anchor/hash modals ADR-0016 bans — neither of which handles Escape.
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
	});
});

test.describe('the keyboard alone', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('./');
		await emptyWorkspace(page);
		await page.reload();
	});

	test('creates, opens, and deletes a Project without a pointer', async ({ page }) => {
		const newProject = page.getByRole('button', { name: 'New Project' });
		await newProject.focus();
		await page.keyboard.press('Enter');
		await page
			.getByRole('dialog', { name: 'New Project' })
			.getByLabel('Project name')
			.fill('Keyboard Only');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('link', { name: 'Keyboard Only' })).toBeVisible();

		// Every control on the row is reachable by tabbing forward from the heading link.
		await page.getByRole('link', { name: 'Keyboard Only' }).focus();
		for (const label of [/^Rename/, /^Duplicate/, /^Delete/]) {
			await page.keyboard.press('Tab');
			await expect(page.getByRole('button', { name: label })).toBeFocused();
		}

		await page.keyboard.press('Enter');
		await expect(page.getByRole('dialog', { name: 'Delete Project' })).toBeVisible();
		await page.getByRole('button', { name: 'Delete Project' }).focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('link', { name: 'Keyboard Only' })).toHaveCount(0);
	});
});

test.describe('the save indicator (ADR-0017 rule 5)', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('./');
		await emptyWorkspace(page);
		await page.reload();
	});

	test('transitions saved → saving → saved as the Project name is typed', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();

		const indicator = page.getByRole('status');
		await expect(indicator).toHaveAttribute('data-save-state', 'saved');

		await page.getByLabel('Project name').fill('Amsterdam 1626');

		await expect(indicator).toHaveAttribute('data-save-state', 'saving');
		await expect(indicator).toHaveAttribute('data-save-state', 'saved');
		await expect(indicator).toHaveText('Saved');

		// And the store really has it: reloading shows the new name.
		await page.reload();
		await expect(page.getByRole('heading', { level: 2, name: 'Amsterdam 1626' })).toBeVisible();
	});

	test('pagehide flushes a write that is still inside its debounce window', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByRole('status')).toHaveAttribute('data-save-state', 'saved');

		// Typed and then immediately gone: the real "closed the laptop" path. The event is
		// dispatched rather than provoked by a navigation so the assertion is about the listener
		// being installed on the real window, not about how fast the browser tears a page down.
		await page.getByLabel('Project name').fill('Half a keystroke ago');
		await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));

		await expect
			.poll(() =>
				page.evaluate(async () => {
					const root = await navigator.storage.getDirectory();
					const project = await root.getDirectoryHandle('amsterdam-1625');
					const file = await project.getFileHandle('project.json');
					return JSON.parse(await (await file.getFile()).text()).name;
				})
			)
			.toBe('Half a keystroke ago');
	});
});

test.describe('a Project from a newer version (ADR-0010)', () => {
	const fromTheFuture =
		'{"formatVersion":2,"name":"Tomorrow","layers":[{"kind":"something-new"}],"baseMap":null}';

	test.beforeEach(async ({ page }) => {
		await page.goto('./');
		await emptyWorkspace(page);
		await seedProject(page, 'from-the-future', fromTheFuture);
	});

	test('is refused with a message that names the remedy, and is not modified', async ({ page }) => {
		const before = await hashProject(page, 'from-the-future');

		await page.goto('./?p=from-the-future');

		const alert = page.getByRole('alert');
		await expect(alert).toContainText('newer version of Ballastella');
		await expect(alert).toContainText('update your copy');
		await expect(alert).toContainText('https://');

		expect(await hashProject(page, 'from-the-future')).toEqual(before);
		const contents = await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const project = await root.getDirectoryHandle('from-the-future');
			return (await (await project.getFileHandle('project.json')).getFile()).text();
		});
		expect(contents).toBe(fromTheFuture);
	});

	test('is still listed on the hub, marked as unopenable', async ({ page }) => {
		await page.goto('./');

		await expect(page.getByText('Made with a newer version of Ballastella.')).toBeVisible();
	});
});

test.describe('an unreachable Workspace (ADR-0008)', () => {
	// The failure is injected at the browser API, not through a hook in the app: the app cannot
	// tell it is being lied to, which is the point.
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => {
			navigator.storage.getDirectory = () =>
				Promise.reject(new DOMException('The Workspace could not be found', 'NotFoundError'));
		});
	});

	test('shows "Workspace not reachable" with a locate-again action, not an error boundary', async ({
		page
	}) => {
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

		// SvelteKit's error boundary would have replaced the page.
		await expect(page.getByRole('heading', { level: 1, name: 'Ballastella Editor' })).toBeVisible();
	});
});

test.describe('opening a Project and closing it (ADR-0010)', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('./');
		await emptyWorkspace(page);
		await page.reload();
	});

	test('writes nothing: every file is byte-identical before and after', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const project = await root.getDirectoryHandle('amsterdam-1625');
			const images = await project.getDirectoryHandle('images', { create: true });
			const file = await images.getFileHandle('info.json', { create: true });
			const writable = await file.createWritable();
			await writable.write('{"width":1}');
			await writable.close();
		});
		const before = await hashProject(page, 'amsterdam-1625');

		await page.goto('./?p=amsterdam-1625');
		await expect(page.getByRole('heading', { level: 2, name: 'Amsterdam 1625' })).toBeVisible();
		await page.goto('./');
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();

		expect(await hashProject(page, 'amsterdam-1625')).toEqual(before);
	});
});
