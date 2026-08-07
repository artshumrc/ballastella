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

/**
 * A Workspace as one Project's archive sees it: the Project's own files, plus the shared material at
 * the Workspace root, keyed by archive path.
 *
 * The inverse of {@link seedProject}, so `toEqual(projectFiles())` still means "every file arrived with
 * these bytes" after an import that hoisted half of them.
 */
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
		for (const shared of ['images', 'alignments']) {
			try {
				await walk(await root.getDirectoryHandle(shared), `${shared}/`);
			} catch {
				// A Workspace with no Historical Maps has neither directory, which is ordinary.
			}
		}
		return files;
	}, directory);
}

/**
 * Write a Project straight into OPFS, bypassing the app.
 *
 * The shared material goes to the Workspace root and the Project's own files inside `directory`, which
 * is the split `Workspace.importProject` performs (ADR-0023) — so a seeded Workspace is one the
 * application could really have produced. `images/<id>/…` and `alignments/<id>.json` are the shared
 * halves; the archive's own paths did not change, which is why the split has to be applied on both
 * sides, here and in {@link projectContents}.
 *
 * The predicate is written out inside the `page.evaluate` rather than shared with that function: the
 * body is serialised and sent to the browser, so it cannot close over anything defined out here.
 */
async function seedProject(
	page: Page,
	directory: string,
	files: Record<string, string>
): Promise<void> {
	await page.evaluate(
		async ([directory, files]) => {
			const shared = (path: string) => path.startsWith('images/') || path.startsWith('alignments/');
			const root = await navigator.storage.getDirectory();
			for (const [path, text] of Object.entries(files as Record<string, string>)) {
				const segments = path.split('/');
				let handle = shared(path)
					? root
					: await root.getDirectoryHandle(directory as string, { create: true });
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
				},
				// A map Layer, because since ADR-0023 an export gathers the Workspace Historical Maps a
				// Project's **Layers reference** — a Workspace can hold maps no Project uses, and a Project
				// bundle must not carry a stranger's pyramid. Without this the archive would legitimately hold
				// no `images/`, and every assertion below about a self-contained zip would be vacuous.
				{
					id: 'l2',
					kind: 'map',
					name: 'The 1625 plan',
					visible: true,
					order: 1,
					opacity: 1,
					imageId: 'amsterdam-1625'
				}
			],
			baseMap: null,
			...overrides
		},
		null,
		'\t'
	)}\n`;

/**
 * A Project's whole archive, so "every file" means more than `project.json`.
 *
 * These are archive paths, and ADR-0023 changed none of them — what changed is where they come from
 * and go to in a Workspace: `images/` and `alignments/` are the Workspace's and sit at its root, while
 * `project.json` and `annotations/` stay inside the Project directory. {@link seedProject} and
 * {@link projectContents} are the two places that split.
 */
const projectFiles = (overrides: Record<string, string> = {}): Record<string, string> => ({
	'project.json': projectJson(),
	'annotations/warehouses.geojson': '{"type":"FeatureCollection","features":[]}',
	// alignment-write-is-the-fixture: the Workspace this spec exports and imports, laid down before the app starts
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
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

/**
 * The hub's transfer line, addressed **by its role**, because being announced is the claim.
 *
 * SPEC story 96 is that progress is announced and not merely drawn, and `[data-transfer]` would go
 * on passing with the live region deleted — the attribute is a test hook, not an accessible name.
 * There is one `role="status"` per page here by convention; the Historical Maps list beside this one
 * is an `aria-live="polite"` region for exactly that reason.
 */
const transferStatus = (page: Page) => page.getByRole('status');

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
		await expect(transferStatus(page)).toHaveText(/Exported Amsterdam 1625: 5 files\./);
	});

	test('says so when an export fails, rather than blanking the status line', async ({ page }) => {
		// Another tab deleting the Project, or a folder grant that lapsed. The failure was written to
		// `transferError`, which was rendered *only* inside the import dialog — so the status region
		// simply cleared and nothing appeared. On the path ADR-0001 makes the only way out of a browser
		// the user cannot see into, that is indistinguishable from a click that did not register.
		await seedProject(page, 'amsterdam-1625', projectFiles());
		await page.reload();
		// Listed before it is deleted, or the delete races the hub's first listing and the Export
		// button this test is about is never rendered at all.
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();

		// Delete it underneath the open hub, the way a second tab would.
		await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			await root.removeEntry('amsterdam-1625', { recursive: true });
		});
		await page.getByRole('button', { name: /^Export/ }).click();

		const alert = page.getByRole('alert');
		await expect(alert).toBeVisible();
		await expect(alert).toContainText('project.json');
	});

	test('keeps the Export button focusable while an export runs (SPEC story 95)', async ({
		page
	}) => {
		// `disabled` takes a pressed button out of the tab order, so focus fell to `<body>` for the
		// length of the export and was never restored — leaving a keyboard user to tab in from the top
		// of the page after every one.
		await seedProject(page, 'amsterdam-1625', projectFiles());
		await page.reload();

		const download = page.waitForEvent('download');
		const exportButton = page.getByRole('button', { name: /^Export/ });
		await exportButton.focus();
		await page.keyboard.press('Enter');
		await download;

		await expect(transferStatus(page)).toHaveText(/Exported/);
		await expect(exportButton).toBeFocused();
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
		await expect(transferStatus(page)).toHaveText(/Imported Amsterdam 1625: 5 files\./);
	});

	test('takes the folder name from the file name, not from the display name', async ({ page }) => {
		// Identity is the folder (ADR-0008), and a Project zip is rooted at the Project directory, so
		// the name travels on the file. This is also what keeps a shared display name from colliding.
		await importZip(page, zipFixture(projectFiles(), 'assignment-3.zip'));

		// The list first, so the import has certainly finished before OPFS is read: a bare
		// `expect(await …)` on storage does not retry, and it read an empty Workspace.
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		// `images` and `alignments` are the Workspace's own, hoisted out of the archive (ADR-0023), so the
		// root holds them beside the Project rather than the Project holding them.
		expect(await workspaceRoot(page)).toEqual(['alignments', 'assignment-3', 'images']);
	});

	test('a shared display name alone does not block the import', async ({ page }) => {
		await seedProject(page, 'my-amsterdam', projectFiles());
		await page.reload();

		await importZip(page, zipFixture(projectFiles()));

		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(2);
		expect(await workspaceRoot(page)).toEqual([
			'alignments',
			'amsterdam-1625',
			'images',
			'my-amsterdam'
		]);
	});

	// ADR-0023's deduplication, and the direction that cannot lose work: the Workspace's own copy of a
	// Historical Map is what every existing Project is already drawn by, so a colleague's archive of the
	// same map must change nothing about it.
	test('leaves a Historical Map the Workspace already has untouched', async ({ page }) => {
		await seedProject(page, 'mine', {
			...projectFiles(),
			// The same image id, different bytes — which makes "untouched" a claim about content.
			'images/amsterdam-1625/info.json': '{"width":1,"height":1}'
		});
		await page.reload();

		await importZip(page, zipFixture(projectFiles(), 'assignment-3.zip'));

		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(2);
		// One pyramid, and it is still the one that was there.
		const contents = await projectContents(page, 'assignment-3');
		expect(contents['images/amsterdam-1625/info.json']).toBe('{"width":1,"height":1}');
		// And the Project itself holds only its own files.
		expect(await workspaceRoot(page)).toEqual(['alignments', 'assignment-3', 'images', 'mine']);
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
		expect(await workspaceRoot(page)).toEqual(['alignments', 'amsterdam-1625', 'images']);
	});

	test('a different case of the same name does not overwrite the existing Project', async ({
		page
	}) => {
		// The forbidden outcome of SPEC story 14, reached through the affordance built to prevent it.
		// The field was bound straight to the input and the collision test was an exact string match,
		// so a user correctly shown the collision, typing `Amsterdam-1625`, was told there was no
		// collision — and on macOS/APFS or Windows `getDirectoryHandle` would then hand back the
		// *existing* folder and overwrite their own Project with the colleague's.
		await chooseZip(page, zipFixture(projectFiles()));
		await page.getByRole('button', { name: 'Import Project', exact: true }).click();

		const dialog = page.getByRole('dialog', { name: 'Import Project' });
		await expect(dialog.getByRole('alert')).toContainText('already has a folder called');
		await dialog.getByLabel('Import as folder').fill('Amsterdam-1625');
		await page.getByRole('button', { name: 'Import under this name' }).click();

		// Reported again rather than accepted, and the dialog is still open with the question in it.
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('alert')).toContainText('already has a folder called');
		expect(await workspaceRoot(page)).toEqual(['alignments', 'amsterdam-1625', 'images']);
		expect(await projectContents(page, 'amsterdam-1625')).toEqual(mine);
	});

	test('the folder field cannot dead-end the dialog when it is emptied', async ({ page }) => {
		// Once a collision was reported the error block was not rendered in that branch at all, so
		// emptying the field and pressing the button threw `InvalidPathError` behind a dialog that
		// showed nothing: a button that does not work and does not say why.
		await chooseZip(page, zipFixture(projectFiles()));
		await page.getByRole('button', { name: 'Import Project', exact: true }).click();

		const dialog = page.getByRole('dialog', { name: 'Import Project' });
		await dialog.getByLabel('Import as folder').fill('   ');

		await expect(page.getByRole('button', { name: 'Import under this name' })).toBeDisabled();
		expect(await workspaceRoot(page)).toEqual(['alignments', 'amsterdam-1625', 'images']);
	});

	test('imports under a new folder name, leaving the existing Project alone', async ({ page }) => {
		await chooseZip(page, zipFixture(projectFiles()));
		await page.getByRole('button', { name: 'Import Project', exact: true }).click();

		const dialog = page.getByRole('dialog', { name: 'Import Project' });
		await dialog.getByLabel('Import as folder').fill('amsterdam-1625-colleague');
		await page.getByRole('button', { name: 'Import under this name' }).click();

		await expect(dialog).toBeHidden();
		expect(await workspaceRoot(page)).toEqual([
			'alignments',
			'amsterdam-1625',
			'amsterdam-1625-colleague',
			'images'
		]);
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
		expect(await workspaceRoot(page)).toEqual(['alignments', 'boston-1775', 'images']);
		expect(await projectContents(page, 'boston-1775')).toEqual(mine);
	};

	test('a Project that will not fit in what this browser has left', async ({ page }) => {
		// Asked before the import is offered, not discovered part way through it. A zip declares how
		// much it unpacks to and browser-managed storage will say how much room is left, so the one
		// moment worth asking is while nothing has been written and cancelling costs nothing.
		//
		// The quota is scripted because no automated browser can be made genuinely full, and because
		// what is being asserted is the app's sequencing rather than Chromium's accounting.
		await page.addInitScript(() => {
			navigator.storage.estimate = async () => ({ quota: 1_000_128, usage: 1_000_000 });
		});
		await page.reload();

		await refuses(page, zipFixture(projectFiles()), 'needs about', 'left for Ballastella');
	});

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
		expect(await workspaceRoot(page)).toEqual(['alignments', 'boston-1775', 'images']);
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
