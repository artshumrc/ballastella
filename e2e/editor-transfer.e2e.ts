import { expect, test, type Page } from '@playwright/test';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { readFile } from 'node:fs/promises';

/**
 * SPEC's Seam 2 for ticket 13: export and import driven through the UI, against real OPFS.
 *
 * The zip format itself, the round trip's byte-for-byte fidelity, and every rejection are asserted
 * at Seam 1 in `@ballastella/core`. What only a browser can show is here — that a real download
 * arrives with the right name and contents, that a zip chosen through a file input reaches storage,
 * that a collision *stops and asks* rather than overwriting, that each refusal reaches a screen the
 * user can read, and that all of it works from the keyboard with the progress announced.
 *
 * The fixture archives are built here in Node rather than exported by the app, so import is tested
 * against zips the app did not make — which is the only kind it will ever receive.
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

/** The names directly under the Workspace root, sorted. What "nothing was written" is measured on. */
async function workspaceRoot(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		return names.sort();
	});
}

/** Every file in a Project directory, recursively, as text. Subdirectories included. */
async function projectContents(page: Page, directory: string): Promise<Record<string, string>> {
	return page.evaluate(async (directory) => {
		const files: Record<string, string> = {};
		const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
			for await (const [name, entry] of handle.entries()) {
				if (entry.kind === 'file') {
					files[`${prefix}${name}`] = await (
						await (entry as FileSystemFileHandle).getFile()
					).text();
				} else {
					await walk(entry as FileSystemDirectoryHandle, `${prefix}${name}/`);
				}
			}
		};
		const root = await navigator.storage.getDirectory();
		await walk(await root.getDirectoryHandle(directory), '');
		return files;
	}, directory);
}

/** Write a Project straight into OPFS, bypassing the app. */
async function seedProject(
	page: Page,
	directory: string,
	files: Record<string, string>
): Promise<void> {
	await page.evaluate(
		async ([directory, files]) => {
			const root = await navigator.storage.getDirectory();
			for (const [path, text] of Object.entries(files as Record<string, string>)) {
				const segments = path.split('/');
				let handle = await root.getDirectoryHandle(directory as string, { create: true });
				for (const segment of segments.slice(0, -1)) {
					handle = await handle.getDirectoryHandle(segment, { create: true });
				}
				const file = await handle.getFileHandle(segments[segments.length - 1], { create: true });
				const writable = await file.createWritable();
				await writable.write(text);
				await writable.close();
			}
		},
		[directory, files] as [string, Record<string, string>]
	);
}

const projectJson = (overrides: Record<string, unknown> = {}) =>
	`${JSON.stringify(
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
				}
			],
			baseMap: null,
			...overrides
		},
		null,
		'\t'
	)}\n`;

/** A Project with a nested pyramid, so "every file" means more than `project.json`. */
const projectFiles = (overrides: Record<string, string> = {}): Record<string, string> => ({
	'project.json': projectJson(),
	'annotations/warehouses.geojson': '{"type":"FeatureCollection","features":[]}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'stands in for a tile',
	...overrides
});

const buildZip = (files: Record<string, string>): Buffer => {
	const zippable: Zippable = {};
	for (const [name, text] of Object.entries(files)) zippable[name] = strToU8(text);
	return Buffer.from(zipSync(zippable));
};

const zipFixture = (files: Record<string, string>, name = 'amsterdam-1625.zip') => ({
	name,
	mimeType: 'application/zip',
	buffer: buildZip(files)
});

/** Open the import dialog and hand it a zip, without pressing Import yet. */
async function chooseZip(
	page: Page,
	fixture: { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
	await page.getByRole('button', { name: 'Import Project…' }).click();
	await page
		.getByRole('dialog', { name: 'Import Project' })
		.getByLabel('Project zip')
		.setInputFiles(fixture);
}

/** Choose a zip and press Import. */
async function importZip(
	page: Page,
	fixture: { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
	await chooseZip(page, fixture);
	await page.getByRole('button', { name: 'Import Project', exact: true }).click();
}

test.beforeEach(async ({ page }) => {
	await page.goto('./');
	await emptyWorkspace(page);
	await page.reload();
	await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
});

test.describe('exporting a Project as a zip (SPEC story 5)', () => {
	test('downloads a zip named for the folder, rooted at the Project, and announces it', async ({
		page
	}) => {
		await seedProject(page, 'amsterdam-1625', projectFiles());
		await page.reload();

		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: /^Export/ }).click();
		const saved = await download;

		expect(saved.suggestedFilename()).toBe('amsterdam-1625.zip');
		const path = await saved.path();
		const entries = unzipSync(new Uint8Array(await readFile(path)));
		// Rooted at the Project directory: no `amsterdam-1625/` prefix on anything.
		expect(Object.keys(entries).sort()).toEqual(Object.keys(projectFiles()).sort());
		expect(new TextDecoder().decode(entries['project.json'])).toBe(projectJson());

		// Progress is announced, not merely drawn (SPEC story 96).
		await expect(page.getByRole('status')).toHaveText(/Exported Amsterdam 1625: 4 files\./);
	});

	test('exports a Project this build refuses to open (ADR-0010)', async ({ page }) => {
		// The Project a user most needs out of a browser they cannot see into is the one that will not
		// open, so Export is deliberately not disabled for it.
		await seedProject(page, 'from-the-future', {
			'project.json': '{"formatVersion":99,"name":"Tomorrow","layers":[]}'
		});
		await page.reload();
		await expect(page.getByText('Made with a newer version of Ballastella.')).toBeVisible();

		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: /^Export/ }).click();
		const entries = unzipSync(new Uint8Array(await readFile(await (await download).path())));

		expect(new TextDecoder().decode(entries['project.json'])).toBe(
			'{"formatVersion":99,"name":"Tomorrow","layers":[]}'
		);
	});
});

test.describe('importing a Project zip (SPEC story 13)', () => {
	test('adds the Project to the Workspace, with every file', async ({ page }) => {
		await importZip(page, zipFixture(projectFiles()));

		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		await expect(page.getByRole('dialog', { name: 'Import Project' })).toBeHidden();
		expect(await projectContents(page, 'amsterdam-1625')).toEqual(projectFiles());
		await expect(page.getByRole('status')).toHaveText(/Imported Amsterdam 1625: 4 files\./);
	});

	test('takes the folder name from the file name, not from the display name', async ({ page }) => {
		// Identity is the folder (ADR-0008), and a Project zip is rooted at the Project directory, so
		// the name travels on the file. This is also what keeps a shared display name from colliding.
		await importZip(page, zipFixture(projectFiles(), 'assignment-3.zip'));

		// The list first, so the import has certainly finished before OPFS is read: a bare
		// `expect(await …)` on storage does not retry, and it read an empty Workspace.
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		expect(await workspaceRoot(page)).toEqual(['assignment-3']);
	});

	test('a shared display name alone does not block the import', async ({ page }) => {
		await seedProject(page, 'my-amsterdam', projectFiles());
		await page.reload();

		await importZip(page, zipFixture(projectFiles()));

		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(2);
		expect(await workspaceRoot(page)).toEqual(['amsterdam-1625', 'my-amsterdam']);
	});
});

test.describe('a folder name that is already taken (SPEC story 14)', () => {
	/** The Project already in the Workspace, which no import may touch. */
	const mine = projectFiles({
		'project.json': projectJson({ name: 'My own Amsterdam' }),
		'annotations/warehouses.geojson': '{"type":"FeatureCollection","features":["mine"]}'
	});

	test.beforeEach(async ({ page }) => {
		await seedProject(page, 'amsterdam-1625', mine);
		await page.reload();
	});

	test('reports the collision and overwrites nothing when cancelled', async ({ page }) => {
		await chooseZip(page, zipFixture(projectFiles()));
		await page.getByRole('button', { name: 'Import Project', exact: true }).click();

		const dialog = page.getByRole('dialog', { name: 'Import Project' });
		await expect(dialog.getByRole('alert')).toContainText('already has a folder called');
		await expect(dialog.getByRole('alert')).toContainText('or cancel');
		// Both choices the ticket requires are on screen at once.
		await expect(dialog.getByLabel('Import as folder')).toHaveValue('amsterdam-1625-2');
		await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();

		await dialog.getByRole('button', { name: 'Cancel' }).click();

		await expect(dialog).toBeHidden();
		// Not one byte of the Project that was here, and no half-written directory beside it.
		expect(await projectContents(page, 'amsterdam-1625')).toEqual(mine);
		expect(await workspaceRoot(page)).toEqual(['amsterdam-1625']);
	});

	test('imports under a new folder name, leaving the existing Project alone', async ({ page }) => {
		await chooseZip(page, zipFixture(projectFiles()));
		await page.getByRole('button', { name: 'Import Project', exact: true }).click();

		const dialog = page.getByRole('dialog', { name: 'Import Project' });
		await dialog.getByLabel('Import as folder').fill('amsterdam-1625-colleague');
		await page.getByRole('button', { name: 'Import under this name' }).click();

		await expect(dialog).toBeHidden();
		expect(await workspaceRoot(page)).toEqual(['amsterdam-1625', 'amsterdam-1625-colleague']);
		expect(await projectContents(page, 'amsterdam-1625')).toEqual(mine);
		expect(await projectContents(page, 'amsterdam-1625-colleague')).toEqual(projectFiles());
		await expect(page.getByRole('link', { name: 'Amsterdam 1625', exact: true })).toBeVisible();
		await expect(page.getByRole('link', { name: 'My own Amsterdam' })).toBeVisible();
	});
});

test.describe('a zip that is refused, with nothing written', () => {
	/** Seeded so a rejection has something it could damage, and provably does not. */
	const mine = projectFiles({ 'project.json': projectJson({ name: 'My own Amsterdam' }) });

	test.beforeEach(async ({ page }) => {
		await seedProject(page, 'boston-1775', mine);
		await page.reload();
	});

	const refuses = async (
		page: Page,
		fixture: { name: string; mimeType: string; buffer: Buffer },
		...expected: (string | RegExp)[]
	) => {
		await importZip(page, fixture);

		const alert = page.getByRole('dialog', { name: 'Import Project' }).getByRole('alert');
		for (const text of expected) await expect(alert).toContainText(text);
		// The dialog is still open, so the message is not a flash the user can miss.
		await expect(page.getByRole('dialog', { name: 'Import Project' })).toBeVisible();
		// And the Workspace is exactly as it was: no new folder, and the existing Project untouched.
		expect(await workspaceRoot(page)).toEqual(['boston-1775']);
		expect(await projectContents(page, 'boston-1775')).toEqual(mine);
	};

	test('a zip with no project.json', async ({ page }) => {
		await refuses(
			page,
			zipFixture({ 'annotations/x.geojson': '{}' }),
			'no project.json at its root'
		);
	});

	test('a project.json that cannot be parsed', async ({ page }) => {
		await refuses(page, zipFixture({ 'project.json': '{ not json' }), 'could not be read');
	});

	test('a formatVersion from the future, naming the remedy (ADR-0010)', async ({ page }) => {
		await refuses(
			page,
			zipFixture({ 'project.json': projectJson({ formatVersion: 2 }) }),
			'newer version of Ballastella',
			'update your copy',
			'https://'
		);
	});

	test('a missing geojsonRef, naming what is not there', async ({ page }) => {
		const files = projectFiles();
		delete files['annotations/warehouses.geojson'];

		await refuses(page, zipFixture(files), 'annotations/warehouses.geojson');
	});

	test('an image directory with no info.json, naming it', async ({ page }) => {
		const files = projectFiles();
		delete files['images/amsterdam-1625/info.json'];

		await refuses(page, zipFixture(files), 'images/amsterdam-1625/info.json');
	});

	test('an entry that climbs out of the Project directory', async ({ page }) => {
		// A zip is a file another person made. On ticket 12's File System Access backend this entry
		// would be written into a folder the user never chose.
		await refuses(
			page,
			zipFixture({ ...projectFiles(), '../../escaped.txt': 'payload' }),
			'climbs out of the Project directory'
		);
		// Nothing anywhere in the Workspace, which is the whole of what the origin's OPFS can hold.
		expect(await workspaceRoot(page)).toEqual(['boston-1775']);
	});
});

test.describe('imported content is untrusted (ADR-0009)', () => {
	test('an XSS payload in an annotation description arrives inert', async ({ page }) => {
		// Ticket 10 owns the sanitising and there is nothing yet that renders a `description`; this is
		// the reason that sanitising is required rather than theoretical. What import owes is to treat
		// the file as bytes — never parsing, interpreting, or inserting it — so the payload reaches
		// storage unchanged and nothing in the import path executes it.
		const payload =
			'{"type":"FeatureCollection","features":[{"type":"Feature","properties":' +
			'{"description":"<img src=x onerror=\\"window.__xss=1\\"><script>window.__xss=1</script>"},' +
			'"geometry":null}]}';
		const failures: string[] = [];
		page.on('pageerror', (error) => failures.push(error.message));
		page.on('dialog', (dialog) => failures.push(`dialog: ${dialog.message()}`));

		await importZip(page, zipFixture(projectFiles({ 'annotations/warehouses.geojson': payload })));
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();

		const stored = await projectContents(page, 'amsterdam-1625');
		expect(stored['annotations/warehouses.geojson']).toBe(payload);
		expect(failures).toEqual([]);
		// Nothing from the payload reached the document.
		expect(
			await page.evaluate(() => ({
				injected: document.querySelector('img[src="x"]') !== null,
				ran: '__xss' in window
			}))
		).toEqual({ injected: false, ran: false });
	});
});

test.describe('the keyboard alone (SPEC story 95)', () => {
	test('imports and exports a Project with no pointer', async ({ page }) => {
		const importButton = page.getByRole('button', { name: 'Import Project…' });
		await importButton.focus();
		await page.keyboard.press('Enter');

		const dialog = page.getByRole('dialog', { name: 'Import Project' });
		await expect(dialog).toBeVisible();
		// The file input itself has to be reachable; `setInputFiles` is how a test supplies a file,
		// but focusing it first is the assertion that a keyboard user can get to it.
		const chooser = dialog.getByLabel('Project zip');
		await chooser.focus();
		await expect(chooser).toBeFocused();
		await chooser.setInputFiles(zipFixture(projectFiles()));

		const confirm = page.getByRole('button', { name: 'Import Project', exact: true });
		await confirm.focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();

		const download = page.waitForEvent('download');
		const exportButton = page.getByRole('button', { name: /^Export/ });
		await exportButton.focus();
		await expect(exportButton).toBeFocused();
		await page.keyboard.press('Enter');
		expect((await download).suggestedFilename()).toBe('amsterdam-1625.zip');
	});

	test('Escape closes the import dialog and focus returns to the button that opened it', async ({
		page
	}) => {
		const trigger = page.getByRole('button', { name: 'Import Project…' });
		await trigger.click();
		await expect(page.getByRole('dialog', { name: 'Import Project' })).toBeVisible();

		await page.keyboard.press('Escape');

		await expect(page.getByRole('dialog', { name: 'Import Project' })).toBeHidden();
		await expect(trigger).toBeFocused();
	});
});
