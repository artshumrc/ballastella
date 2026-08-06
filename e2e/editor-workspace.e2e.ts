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

/**
 * SHA-256 of every file in a Project directory, **recursively**, so "nothing was written" is
 * provable.
 *
 * The recursion is the point. Skipping subdirectories left the hash covering `project.json` alone,
 * so the nested `images/…/info.json` that the byte-identity test deliberately seeds — standing in
 * for the pyramid a real Project is mostly made of — was silently never checked.
 */
async function hashProject(page: Page, directory: string): Promise<Record<string, string>> {
	return page.evaluate(async (directory) => {
		const hex = (digest: ArrayBuffer) =>
			[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

		const hashes: Record<string, string> = {};
		const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
			for await (const [name, entry] of handle.entries()) {
				if (entry.kind === 'file') {
					const bytes = await (await (entry as FileSystemFileHandle).getFile()).arrayBuffer();
					hashes[`${prefix}${name}`] = hex(await crypto.subtle.digest('SHA-256', bytes));
				} else {
					await walk(entry as FileSystemDirectoryHandle, `${prefix}${name}/`);
				}
			}
		};

		const root = await navigator.storage.getDirectory();
		await walk(await root.getDirectoryHandle(directory), '');
		return hashes;
	}, directory);
}

/** The display name in `project.json` as it sits on disk. */
/**
 * The `name` in `project.json`, read out of OPFS behind the app's back.
 *
 * Retried, because the app writes atomically — a temp file, then `move()` over the destination
 * (ADR-0017) — and a read that lands inside that window throws rather than returning stale bytes:
 * `getFileHandle` with a `NotFoundError` while the destination is momentarily gone, or `getFile()`
 * with a `NotReadableError` as it is replaced. Those are transient by construction, but they were
 * propagating out of `expect.poll`, whose retry covers a failed *assertion* and not a callback that
 * throws. That made this the flakiest test in the suite — it failed 2 of 5 runs at `--workers=1`,
 * with nothing else running.
 *
 * This is a fix to the read, not to the assertion: the bytes on disk are still what is compared, so
 * a write that never happens still fails. Only a read that collided with an atomic replace is
 * forgiven, and only for as long as one can plausibly last.
 */
async function readProjectName(page: Page, directory = 'amsterdam-1625'): Promise<string> {
	return page.evaluate(async (directory) => {
		let lastFailure: unknown;
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				const root = await navigator.storage.getDirectory();
				const project = await root.getDirectoryHandle(directory);
				const file = await project.getFileHandle('project.json');
				return JSON.parse(await (await file.getFile()).text()).name as string;
			} catch (cause) {
				lastFailure = cause;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
		throw new Error(
			`project.json in ${directory} could not be read in 20 attempts — the last failure was ` +
				`${lastFailure instanceof Error ? `${lastFailure.name}: ${lastFailure.message}` : String(lastFailure)}. ` +
				'A transient failure here is the atomic-replace window; a persistent one is not.'
		);
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
		for (const label of [/^Rename/, /^Duplicate/, /^Export/, /^Delete/]) {
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
});

test.describe('flushing on hide (ADR-0017 rule 3)', () => {
	/**
	 * Hold back the app's own debounce, so that only a flush can put bytes on disk.
	 *
	 * This is what makes the test below about rule 3 rather than about rule 2. Rule 3 is the write
	 * the timer has *not yet reached* — the closed laptop — and the app's window is 400 ms while
	 * `expect.poll` waits five seconds, so with the timer live it fired well inside the poll and the
	 * assertion passed with `installFlushOnHide` deleted altogether. Verified both ways.
	 *
	 * Swallowing long timers rather than freezing the clock: Playwright's `clock` also replaces
	 * `Date` and `performance`, and a frozen clock stopped the flush from completing at all. Only
	 * timers at or beyond the debounce are dropped, and the save indicator's own 400 ms dwell goes
	 * with them — which is why this describe asserts files rather than the indicator.
	 */
	const holdBackTheDebounce = (page: Page) =>
		page.addInitScript(() => {
			const real = window.setTimeout;
			window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
				typeof delay === 'number' && delay >= 400
					? 0
					: real(handler as never, delay, ...args)) as typeof window.setTimeout;
		});

	test.beforeEach(async ({ page }) => {
		await holdBackTheDebounce(page);
		await page.goto('./');
		await emptyWorkspace(page);
		await page.reload();
	});

	// The `visibilitychange` half of rule 3 is asserted at the core seam instead
	// (`autosave.test.ts`), where the visibility state can be set. Chromium exposes no way for a
	// test to make a page genuinely hidden, and shadowing `document.visibilityState` from inside the
	// page does not take — so an e2e version would assert the shadowing, not the app.
	test('pagehide flushes a write that is still inside its debounce window', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByLabel('Project name')).toBeVisible();
		// Wait for the view to settle before typing. The field appears as soon as the Project has been
		// read, but opening is driven by an effect over the URL that can run again, and a keystroke
		// landing while it is re-reading is dropped — see the note on `EditorSession.open`. An idle
		// indicator means nothing is in flight, so this test is about rule 3 and not about that race.
		await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');

		await page.getByLabel('Project name').fill('Half a keystroke ago');
		// Still only in memory: the debounce window cannot close, so nothing has been written yet.
		expect(await readProjectName(page)).toBe('Amsterdam 1625');

		// Dispatched rather than provoked by a navigation, so the assertion is about the listener
		// being installed on the real window and not about how fast the browser tears a page down.
		await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));

		await expect.poll(() => readProjectName(page)).toBe('Half a keystroke ago');
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

	test('tabbing and clicking through the name field writes nothing', async ({ page }) => {
		// The byte-identity test below navigates with `page.goto` and never focuses anything, so it
		// cannot see this: `onblur` committed with no dirty check, and `writeProject` stamps a fresh
		// `updatedAt` unconditionally, so a user who merely tabbed into the field and out again
		// rewrote `project.json`. ADR-0010 is explicit — merely looking at an old Project must not
		// modify files, or opening one in a git working tree produces an unexplained diff and opening
		// one in a Dropbox folder syncs a rewrite to every other machine.
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		const field = page.getByLabel('Project name');
		await expect(field).toBeVisible();
		const before = await hashProject(page, 'amsterdam-1625');

		await field.focus();
		await expect(field).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(field).not.toBeFocused();

		// And with the pointer, which is the same gesture through a different event order.
		await field.click();
		await page.getByRole('heading', { level: 2, name: 'Amsterdam 1625' }).click();
		await expect(field).not.toBeFocused();

		// An absence, so it needs a settle: longer than the 400 ms debounce, plus the flush that
		// `pagehide` forces, so any write the app was going to make has certainly happened.
		await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
		await page.waitForTimeout(600);

		expect(await hashProject(page, 'amsterdam-1625')).toEqual(before);
	});

	test('writes nothing: every file is byte-identical before and after', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const project = await root.getDirectoryHandle('amsterdam-1625');
			// `annotations/` rather than `images/`: since ADR-0023 a pyramid is the Workspace's and is not
			// inside a Project at all, so a nested fixture under the Project has to be one of the Project's
			// own files or the claim below would be about a file the application never puts there.
			const annotations = await project.getDirectoryHandle('annotations', { create: true });
			const file = await annotations.getFileHandle('l-notes.geojson', { create: true });
			const writable = await file.createWritable();
			await writable.write('{"type":"FeatureCollection","features":[]}');
			await writable.close();
		});
		const before = await hashProject(page, 'amsterdam-1625');
		// The hash has to reach into subdirectories, or "every file is byte-identical" is a claim
		// about `project.json` alone. The nested `annotations/l-notes.geojson` stands in for the
		// Annotations a real Project holds — untouched by merely looking. Sorted, because OPFS promises no
		// enumeration order.
		expect(Object.keys(before).sort()).toEqual(['annotations/l-notes.geojson', 'project.json']);

		await page.goto('./?p=amsterdam-1625');
		await expect(page.getByRole('heading', { level: 2, name: 'Amsterdam 1625' })).toBeVisible();
		await page.goto('./');
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();

		expect(await hashProject(page, 'amsterdam-1625')).toEqual(before);
	});
});
