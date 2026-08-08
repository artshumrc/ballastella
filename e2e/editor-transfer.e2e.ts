import { packTar, type TarEntry } from 'modern-tar';
import { readFile } from 'node:fs/promises';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { expect, test, type Page } from './support/test.js';
import { openWorkspaceMenu, openWorkspaceSettings } from './support/workspace.js';

/**
 * SPEC's Seam 2 for ticket 14: handing a Project over and reviewing one, driven through the UI
 * against real OPFS.
 *
 * The bundle format itself, the round trip's fidelity, and every rejection are asserted at Seam 1 in
 * `@ballastella/core`. What only a browser can show is here — that a real download arrives with the
 * right name and contents; that a bundle chosen through a file input lands in a **separate**
 * Workspace; that the user's own Workspace is byte-for-byte what it was; that the banner is on every
 * screen and its two exits work from the keyboard; and that two review copies of the same sheet never
 * see each other's Alignment.
 *
 * The fixture archives are built here in Node rather than exported by the app, so opening is tested
 * against bundles the app did not make — which is the only kind it will ever receive.
 */

/** Every named Workspace in the OPFS root, sorted. */
async function workspaceNames(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const [name, handle] of root.entries()) {
			if (handle.kind === 'directory') names.push(name);
		}
		return names.sort();
	});
}

/**
 * Empty the origin's OPFS, so no test can see another's Projects or another's review copies.
 *
 * ⚠ **The Workspace the app is holding open is emptied, not removed.** `DirectoryHandleStore` caches
 * its root handle once it resolves (ADR-0008), and that handle is a *named subdirectory* rather than
 * the OPFS root; deleting the directory out from under a running app latches it "unreachable" until
 * a reload, which is a state about the harness rather than about the product.
 */
async function emptyEverything(page: Page): Promise<void> {
	await page.evaluate(async () => {
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
	// The app remembers which Workspace it was in across a reload, and a spec that ended inside a
	// review copy would otherwise start the next one there — pointing `workspaceRoot()` at a Workspace
	// that has just been deleted.
	await page.evaluate(() => {
		localStorage.removeItem('ballastella.workspace');
		localStorage.removeItem('ballastella.own-workspace');
	});
}

/**
 * Every path and every byte of one named Workspace.
 *
 * ⚠ **This is the "byte-identical before and after" criterion, and it is the easiest in this ticket
 * to fake.** Asserting that the Project list is unchanged would pass while an Alignment had been
 * overwritten, so this lists every path and reads every byte — the contents, not a count, not a
 * listing, and not a size.
 */
async function everyByteOf(page: Page, workspace: string): Promise<Record<string, string>> {
	return page.evaluate(async (workspace) => {
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
		await walk(await root.getDirectoryHandle(workspace), '');
		return files;
	}, workspace);
}

/**
 * Write a Project straight into the open Workspace, bypassing the app.
 *
 * The shared material goes to the Workspace root and the Project's own files inside `directory`,
 * which is ADR-0023's split — so a seeded Workspace is one the application could really have
 * produced.
 */
async function seedProject(
	page: Page,
	directory: string,
	files: Record<string, string>
): Promise<void> {
	await page.evaluate(
		async ([directory, files]) => {
			const shared = (path: string) => path.startsWith('images/') || path.startsWith('alignments/');
			const root = await workspaceRoot();
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
				// Project's **Layers reference**. Without this the bundle would legitimately hold no
				// `images/`, and every assertion below about a self-contained archive would be vacuous.
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
 * These are archive paths and ADR-0023 changed none of them: `images/` and `alignments/` are the
 * Workspace's and sit at its root, while `project.json` and `annotations/` stay inside the Project
 * directory. {@link seedProject} is where that split is applied.
 */
const projectFiles = (overrides: Record<string, string> = {}): Record<string, string> => ({
	'project.json': projectJson(),
	'annotations/warehouses.geojson': '{"type":"FeatureCollection","features":[]}',
	// alignment-write-is-the-fixture: the Workspace this spec exports and opens, laid down before the app starts
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'stands in for a tile',
	...overrides
});

async function buildBundle(files: Record<string, string>): Promise<Buffer> {
	const encode = (text: string) => new TextEncoder().encode(text);
	const entries: TarEntry[] = Object.entries(files).map(([name, text]) => ({
		header: { name, size: encode(text).length, type: 'file' },
		body: encode(text)
	}));
	return Buffer.from(await packTar(entries));
}

const bundleFixture = async (
	files: Record<string, string>,
	name = 'amsterdam-1625.project.tar'
): Promise<{ name: string; mimeType: string; buffer: Buffer }> => ({
	name,
	mimeType: 'application/x-tar',
	buffer: await buildBundle(files)
});

/** Open the "Open a Project someone sent me" dialog and hand it a file, without confirming. */
async function chooseBundle(
	page: Page,
	fixture: { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
	await page.getByTestId('open-bundle').click();
	await page
		.getByRole('dialog', { name: 'Open a Project someone sent me' })
		.getByLabel('Project bundle')
		.setInputFiles(fixture);
}

/** Choose a bundle and press the button, and wait for the review copy to be on screen. */
async function openBundle(
	page: Page,
	fixture: { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
	await chooseBundle(page, fixture);
	await page.getByTestId('confirm-open-bundle').click();
}

const banner = (page: Page) => page.getByTestId('review-banner');

/**
 * The transfer announcement.
 *
 * `[data-transfer]` rather than `getByRole('status')`: since ticket 04 the save indicator is on the
 * navigation bar and therefore on the hub too, so the hub has one `status` role of its own and this
 * region is an `aria-live="polite"` one — this repo's settled convention wherever the two meet.
 */
const transferStatus = (page: Page) => page.locator('[data-transfer]');

test.beforeEach(async ({ page }) => {
	await page.goto('./');
	await emptyEverything(page);
	await page.reload();
	await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
});

test.describe('exporting a Project as a bundle (SPEC story 89)', () => {
	test('downloads a tar named for the folder, rooted at the Project, and announces it', async ({
		page
	}) => {
		await seedProject(page, 'amsterdam-1625', projectFiles());
		await page.reload();

		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: /^Export/ }).click();
		const saved = await download;

		expect(saved.suggestedFilename()).toBe('amsterdam-1625.project.tar');
		const { unpackTar } = await import('modern-tar');
		const entries = await unpackTar(new Uint8Array(await readFile(await saved.path())), {
			strict: true
		});
		// Rooted at the Project directory: no `amsterdam-1625/` prefix on anything.
		expect(entries.map((entry) => entry.header.name).sort()).toEqual(
			Object.keys(projectFiles()).sort()
		);
		expect(
			new TextDecoder().decode(entries.find((entry) => entry.header.name === 'project.json')!.data!)
		).toBe(projectJson());

		// Progress is announced, not merely drawn (SPEC story 96).
		await expect(transferStatus(page)).toHaveText(/Exported Amsterdam 1625: 5 files\./);
	});

	// A bundle carries the Project it names and the shared material *that Project's Layers reference*,
	// and not the Workspace's other maps. That is the whole difference between a handoff and a backup,
	// so it is asserted at the seam where a real Workspace holds both.
	test('leaves the Workspace’s other Historical Maps out of it', async ({ page }) => {
		await seedProject(page, 'amsterdam-1625', projectFiles());
		await seedProject(page, 'the-canal-ring', {
			'project.json': projectJson({ name: 'The Canal Ring', layers: [] }),
			'images/blaeu-1649/info.json': '{"width":2048,"height":2048}',
			// alignment-write-is-the-fixture: the other map's Alignment, seeded so that leaving it out of the bundle is assertable
			'alignments/blaeu-1649.json': '{"type":"Annotation","id":"blaeu-1649"}'
		});
		await page.reload();

		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Export Amsterdam 1625' }).click();
		const { unpackTar } = await import('modern-tar');
		const entries = await unpackTar(new Uint8Array(await readFile(await (await download).path())), {
			strict: true
		});

		const names = entries.map((entry) => entry.header.name);
		expect(names.sort()).toEqual(Object.keys(projectFiles()).sort());
		expect(names).not.toContain('images/blaeu-1649/info.json');
		expect(names).not.toContain('alignments/blaeu-1649.json');
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
		const { unpackTar } = await import('modern-tar');
		const entries = await unpackTar(new Uint8Array(await readFile(await (await download).path())), {
			strict: true
		});

		expect(
			new TextDecoder().decode(entries.find((entry) => entry.header.name === 'project.json')!.data!)
		).toBe('{"formatVersion":99,"name":"Tomorrow","layers":[]}');
	});

	test('says so when an export fails, rather than blanking the status line', async ({ page }) => {
		await seedProject(page, 'amsterdam-1625', projectFiles());
		await page.reload();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();

		// Delete it underneath the open hub, the way a second tab would.
		await page.evaluate(async () => {
			const root = await workspaceRoot();
			await root.removeEntry('amsterdam-1625', { recursive: true });
		});
		await page.getByRole('button', { name: /^Export/ }).click();

		const alert = page.getByRole('alert');
		await expect(alert).toBeVisible();
		await expect(alert).toContainText('project.json');
	});
});

test.describe('opening a bundle lands in a review copy (SPEC stories 90–92)', () => {
	test('creates a separate Workspace holding exactly that one Project', async ({ page }) => {
		await openBundle(page, await bundleFixture(projectFiles()));

		// A **different** Workspace, beside the user's own rather than inside it.
		await expect(banner(page)).toBeVisible();
		expect(await workspaceNames(page)).toEqual(['My Workspace', 'amsterdam-1625']);
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		expect(await everyByteOf(page, 'amsterdam-1625')).toEqual({
			'review.json': expect.any(String),
			'amsterdam-1625/project.json': projectJson(),
			'amsterdam-1625/annotations/warehouses.geojson': '{"type":"FeatureCollection","features":[]}',
			// alignment-write-is-the-fixture: the Alignment a bundle fixture carries, and the one seeded on disk that opening it must not touch
			'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
			'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
			'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'stands in for a tile'
		});
	});

	// ⚠ **The most important criterion in this ticket, and the easiest to fake.** Every path and every
	// byte, before and after — asserting on the Project list would pass while an Alignment had been
	// overwritten.
	test('leaves the user’s own Workspace byte-identical, through opening and discarding', async ({
		page
	}) => {
		await seedProject(page, 'my-own-amsterdam', {
			...projectFiles({ 'project.json': projectJson({ name: 'My own Amsterdam' }) }),
			// The **same image id** as the bundle's, with different bytes. This is the collision the
			// whole design exists to prevent: nothing in the bundle may reach this Alignment.
			// alignment-write-is-the-fixture: the Alignment a bundle fixture carries, and the one seeded on disk that opening it must not touch
			'alignments/amsterdam-1625.json': '{"type":"Annotation","controlPoints":"mine, an afternoon"}'
		});
		await page.reload();
		const before = await everyByteOf(page, 'My Workspace');
		expect(Object.keys(before).length).toBeGreaterThan(0);

		await openBundle(
			page,
			await bundleFixture(
				projectFiles({
					// alignment-write-is-the-fixture: the Alignment a bundle fixture carries, and the one seeded on disk that opening it must not touch
					'alignments/amsterdam-1625.json': '{"type":"Annotation","controlPoints":"theirs"}'
				})
			)
		);
		await expect(banner(page)).toBeVisible();
		// Read while the review copy is open, which is when an overwrite would have happened.
		expect(await everyByteOf(page, 'My Workspace')).toEqual(before);

		await page.getByTestId('discard-review').click();
		await page.getByTestId('confirm-discard-review').click();
		await expect(banner(page)).toBeHidden();

		expect(await everyByteOf(page, 'My Workspace')).toEqual(before);
		expect(await workspaceNames(page)).toEqual(['My Workspace']);
	});

	test('names what was opened, and the file that was picked names the Workspace', async ({
		page
	}) => {
		await openBundle(page, await bundleFixture(projectFiles(), 'assignment 3.project.tar'));

		await expect(banner(page)).toContainText('Amsterdam 1625');
		expect(await workspaceNames(page)).toEqual(['My Workspace', 'assignment 3']);
		// And the reader's own sentence reaches a screen, naming the review copy it made. It is the
		// same sentence that carries a declined entry, so a page that dropped it would drop that too.
		await expect(page.getByTestId('bundle-notice')).toContainText('assignment 3');
	});

	// ⚠ **The declined-write path ticket 13 left unreachable, reached.** `writeRestored`'s decline was
	// unreachable while every destination was a brand-new Workspace; a bundle reaches it, because a tar
	// has no index and nothing stops an archive from naming a path twice. The **first** entry wins, and
	// the second is reported rather than silently overwriting it — a transfer that quietly delivers
	// something other than what it was handed is the failure this format change escaped.
	test('says so when a bundle names one Alignment twice, and keeps the first', async ({ page }) => {
		const encode = (text: string) => new TextEncoder().encode(text);
		const files = projectFiles();
		const archive = await packTar([
			...Object.entries(files).map(([name, text]) => ({
				header: { name, size: encode(text).length, type: 'file' as const },
				body: encode(text)
			})),
			{
				header: {
					name: 'alignments/amsterdam-1625.json',
					size: encode('{"second":true}').length,
					type: 'file' as const
				},
				body: encode('{"second":true}')
			}
		]);

		await openBundle(page, {
			name: 'amsterdam-1625.project.tar',
			mimeType: 'application/x-tar',
			buffer: Buffer.from(archive)
		});

		await expect(banner(page)).toBeVisible();
		await expect(page.getByTestId('bundle-notice')).toContainText('alignments/amsterdam-1625.json');
		expect((await everyByteOf(page, 'amsterdam-1625'))['alignments/amsterdam-1625.json']).toBe(
			'{"type":"Annotation","id":"amsterdam-1625"}'
		);
	});

	// Criterion 10's three halves. The containment is structural — a review copy is a different
	// directory in the OPFS root — rather than a filter anybody has to remember.
	test('is absent from the user’s own Project list, backup, and size', async ({ page }) => {
		await seedProject(page, 'my-own-amsterdam', {
			'project.json': projectJson({ name: 'My own Amsterdam', layers: [] })
		});
		await page.reload();
		await openBundle(page, await bundleFixture(projectFiles()));
		await expect(banner(page)).toBeVisible();

		// Back to the user's own Workspace: the reviewed Project is not in its list.
		await page.getByTestId('leave-review').click();
		await expect(banner(page)).toBeHidden();
		await expect(page.getByRole('link', { name: 'My own Amsterdam' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);

		// And not in a backup of it, nor in what that backup weighs.
		const download = page.waitForEvent('download');
		await openWorkspaceSettings(page);
		await page.getByTestId('back-up-workspace').click();
		const saved = await download;
		const { unpackTar } = await import('modern-tar');
		const entries = await unpackTar(new Uint8Array(await readFile(await saved.path())), {
			strict: true
		});
		const names = entries.map((entry) => entry.header.name);
		expect(names).toContain('My Workspace/my-own-amsterdam/project.json');
		expect(names.filter((name) => name.includes('Amsterdam 1625'))).toEqual([]);
		expect(names.filter((name) => name.includes('review.json'))).toEqual([]);
	});

	test('publishing while a review copy exists publishes only the user’s own Workspace', async ({
		page
	}) => {
		await seedProject(page, 'my-own-amsterdam', {
			'project.json': projectJson({ name: 'My own Amsterdam', layers: [] })
		});
		await page.reload();
		await openBundle(page, await bundleFixture(projectFiles()));
		await expect(banner(page)).toBeVisible();

		// There is no Publish button inside a review copy at all.
		await expect(page.getByTestId('publish')).toHaveCount(0);
		await expect(page.getByTestId('review-workspace-note')).toBeVisible();

		await page.getByTestId('leave-review').click();
		await expect(banner(page)).toBeHidden();
		await page.getByTestId('publish').click();
		const dialog = page.getByRole('dialog', { name: /Publish/ });
		await expect(dialog).toBeVisible();
		// The dialog counts the Projects it is about to publish, and counts **one** — the user's own.
		// The reviewed Project is in another Workspace entirely and is not among them.
		await expect(dialog).toContainText('will list');
		await expect(dialog).toContainText('1 Project');
	});

	// ⚠ **Criterion 7, and the collision this whole design exists to prevent.** The same image id in
	// both bundles with *different* Control Points, asserted through the app by switching between the
	// two review copies.
	test('two review copies keep their own Alignment of the same sheet', async ({ page }) => {
		await openBundle(
			page,
			await bundleFixture(
				projectFiles({
					// alignment-write-is-the-fixture: the Alignment a bundle fixture carries, and the one seeded on disk that opening it must not touch
					'alignments/amsterdam-1625.json': '{"type":"Annotation","controlPoints":"student A"}'
				}),
				'student A.project.tar'
			)
		);
		await expect(banner(page)).toBeVisible();
		await page.getByTestId('leave-review').click();
		await expect(banner(page)).toBeHidden();

		await openBundle(
			page,
			await bundleFixture(
				projectFiles({
					// alignment-write-is-the-fixture: the Alignment a bundle fixture carries, and the one seeded on disk that opening it must not touch
					'alignments/amsterdam-1625.json': '{"type":"Annotation","controlPoints":"student B"}'
				}),
				'student B.project.tar'
			)
		);
		await expect(banner(page)).toBeVisible();

		expect(await workspaceNames(page)).toEqual(['My Workspace', 'student A', 'student B']);
		expect((await everyByteOf(page, 'student A'))['alignments/amsterdam-1625.json']).toBe(
			'{"type":"Annotation","controlPoints":"student A"}'
		);
		expect((await everyByteOf(page, 'student B'))['alignments/amsterdam-1625.json']).toBe(
			'{"type":"Annotation","controlPoints":"student B"}'
		);

		// And switching between them is one gesture, which is what a teacher marking thirty needs.
		await openWorkspaceMenu(page);
		await expect(
			page.getByTestId('switch-workspace').filter({ hasText: 'student A' })
		).toContainText('review copy');
	});

	// Criterion 9. There is deliberately no "keep this", "copy to my Workspace", or "save a copy":
	// promotion is the Alignment collision arriving through a convenience (ADR-0024).
	test('offers nothing that copies, promotes, or merges the reviewed Project', async ({ page }) => {
		await openBundle(page, await bundleFixture(projectFiles()));
		await expect(banner(page)).toBeVisible();

		for (const forbidden of [
			/keep this/i,
			/copy to my workspace/i,
			/save a copy/i,
			/promote/i,
			/move to my workspace/i,
			/import into/i
		]) {
			await expect(page.getByRole('button', { name: forbidden })).toHaveCount(0);
		}
		// The one control that *could* have grown into it — the hub's own duplicate — copies inside
		// this Workspace and cannot reach another one, so the review copy still has it and it is still
		// harmless. What must not exist is a route out.
		await expect(page.getByTestId('open-bundle')).toHaveCount(0);
	});

	test('a review copy is editable, which is deliberate', async ({ page }) => {
		// A teacher demonstrating a fix is a real use (ADR-0024). Nothing is ever written back to the
		// bundle file, which is a property of there being no writer for it at all.
		await openBundle(page, await bundleFixture(projectFiles()));
		await expect(banner(page)).toBeVisible();

		await page.getByRole('button', { name: 'Rename Amsterdam 1625' }).click();
		const dialog = page.getByRole('dialog', { name: 'Rename Project' });
		await dialog.getByLabel('New name').fill('Amsterdam 1625, marked');
		await dialog.getByRole('button', { name: 'Rename' }).click();

		await expect(page.getByRole('link', { name: 'Amsterdam 1625, marked' })).toBeVisible();
	});
});

test.describe('the review banner is on every screen (SPEC story 92)', () => {
	test.beforeEach(async ({ page }) => {
		await openBundle(page, await bundleFixture(projectFiles()));
		await expect(banner(page)).toBeVisible();
	});

	test('on the hub, on the Project screen, and on the alignment route', async ({ page }) => {
		// The alignment route draws a Base Map, and no test in this suite may reach the network — a
		// recorded decision, and the reason `demo-bucket.protomaps.com` turning 404 must not be able to
		// turn this suite red for a reason that has nothing to do with the banner.
		await routeBaseMapArchive(page);
		// The hub.
		await expect(banner(page)).toContainText('Amsterdam 1625');

		// The Project screen — one of the two screens a user forgets where they are on.
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(banner(page)).toBeVisible();
		await expect(banner(page)).toContainText('Amsterdam 1625');

		// And the alignment route, which is the other one.
		await page.goto('./align/?p=amsterdam-1625&image=amsterdam-1625');
		await expect(banner(page)).toBeVisible();
		await expect(banner(page)).toContainText('Amsterdam 1625');
	});

	test('survives a reload, because the mark is on the Workspace and not in this tab', async ({
		page
	}) => {
		// A banner kept only in memory would vanish on a reload, and the user would be inside a
		// throwaway Workspace with nothing on screen saying so — which is exactly the "mode you can
		// forget you are in" ADR-0024 rules out.
		await page.reload();

		await expect(banner(page)).toBeVisible();
		await expect(banner(page)).toContainText('Amsterdam 1625');
	});

	test('is reachable as a landmark, with both exits as real buttons', async ({ page }) => {
		const region = page.getByRole('region', { name: 'Review copy' });
		await expect(region).toBeVisible();
		await expect(region.getByRole('button', { name: 'Back to my Workspace' })).toBeVisible();
		await expect(region.getByRole('button', { name: 'Discard this review copy' })).toBeVisible();
	});

	test('both exits work from the keyboard alone (SPEC story 95)', async ({ page }) => {
		const back = page.getByTestId('leave-review');
		await back.focus();
		await expect(back).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(banner(page)).toBeHidden();

		// And the other one, on a second review copy.
		await openBundle(page, await bundleFixture(projectFiles()));
		await expect(banner(page)).toBeVisible();
		const discard = page.getByTestId('discard-review');
		await discard.focus();
		await expect(discard).toBeFocused();
		await page.keyboard.press('Enter');
		const dialog = page.getByRole('dialog', { name: 'Discard this review copy' });
		await expect(dialog).toBeVisible();
		const confirm = page.getByTestId('confirm-discard-review');
		await confirm.focus();
		await page.keyboard.press('Enter');

		await expect(banner(page)).toBeHidden();
		// Only the discarded one went; the one that was merely left is still there.
		expect(await workspaceNames(page)).toEqual(['My Workspace', 'amsterdam-1625']);
	});

	// `showModal()` is mandated rather than merely available (ADR-0016), and Escape is the property
	// that distinguishes it from the checkbox-hack modals daisyUI still documents.
	test('the discard confirmation is a real modal, dismissible with Escape', async ({ page }) => {
		await page.getByTestId('discard-review').click();
		const dialog = page.getByRole('dialog', { name: 'Discard this review copy' });
		await expect(dialog).toBeVisible();
		expect(
			await dialog.evaluate((element) => (element as HTMLDialogElement).matches(':modal'))
		).toBe(true);
		await expect(page.getByTestId('discard-review-consequence')).toBeVisible();

		await page.keyboard.press('Escape');

		await expect(dialog).toBeHidden();
		// Nothing was discarded, which is what a confirmation is for.
		await expect(banner(page)).toBeVisible();
		expect(await workspaceNames(page)).toEqual(['My Workspace', 'amsterdam-1625']);
	});

	test('discarding removes the Workspace and every file in it', async ({ page }) => {
		await page.getByTestId('discard-review').click();
		await page.getByTestId('confirm-discard-review').click();

		await expect(banner(page)).toBeHidden();
		expect(await workspaceNames(page)).toEqual(['My Workspace']);
		// And it is announced: both exits change the whole screen and neither says anything by itself.
		await expect(page.getByTestId('review-announcement')).toContainText('Discarded');
	});

	test('a review copy is not backed up', async ({ page }) => {
		await openWorkspaceSettings(page);

		await expect(page.getByTestId('no-backup-in-review')).toBeVisible();
		await expect(page.getByTestId('back-up-workspace')).toHaveCount(0);
	});
});

test.describe('a bundle that is refused, with nothing created', () => {
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
		const before = await everyByteOf(page, 'My Workspace');
		await openBundle(page, fixture);

		const alert = page.getByTestId('bundle-error');
		for (const text of expected) await expect(alert).toContainText(text);
		// The dialog is still open, so the message is not a flash the user can miss.
		await expect(
			page.getByRole('dialog', { name: 'Open a Project someone sent me' })
		).toBeVisible();
		// No review copy was left behind, and the user's own Workspace is exactly as it was.
		expect(await workspaceNames(page)).toEqual(['My Workspace']);
		expect(await everyByteOf(page, 'My Workspace')).toEqual(before);
	};

	test('a file that is not a tar at all', async ({ page }) => {
		await refuses(
			page,
			{ name: 'holiday.jpg', mimeType: 'application/x-tar', buffer: Buffer.from('not a tar') },
			'could not be read as a Ballastella Project bundle',
			'Nothing has been opened.'
		);
	});

	test('a bundle whose download stopped half way', async ({ page }) => {
		const whole = await buildBundle(projectFiles());
		await refuses(
			page,
			{
				name: 'amsterdam-1625.project.tar',
				mimeType: 'application/x-tar',
				buffer: whole.subarray(0, whole.length - 2048)
			},
			'may not have downloaded completely'
		);
	});

	test('an archive with no project.json', async ({ page }) => {
		await refuses(
			page,
			await bundleFixture({ 'annotations/x.geojson': '{}' }),
			'no project.json at its root'
		);
	});

	test('a formatVersion from the future, naming the remedy (ADR-0010)', async ({ page }) => {
		await refuses(
			page,
			await bundleFixture({ 'project.json': projectJson({ formatVersion: 2 }) }),
			'newer version of Ballastella',
			'https://'
		);
	});

	test('a missing geojsonRef, naming what is not there', async ({ page }) => {
		const files = projectFiles();
		delete files['annotations/warehouses.geojson'];

		await refuses(page, await bundleFixture(files), 'annotations/warehouses.geojson');
	});

	test('an image directory with no info.json, naming it', async ({ page }) => {
		const files = projectFiles();
		delete files['images/amsterdam-1625/info.json'];

		await refuses(page, await bundleFixture(files), 'images/amsterdam-1625/info.json');
	});

	test('an entry that climbs out of the Project', async ({ page }) => {
		// A bundle is a file another person made, and since ticket 12 an escaping entry would land in
		// another of the user's own Workspaces — including the one they are looking at.
		await refuses(
			page,
			await bundleFixture({ ...projectFiles(), '../../escaped.txt': 'payload' }),
			'climbs out of the Project'
		);
	});

	test('a bundle there is no room for, refused before anything is created', async ({ page }) => {
		// Asked before the Workspace is made, not discovered part way through. The quota is scripted
		// because no automated browser can be made genuinely full, and what is being asserted is the
		// app's sequencing rather than Chromium's accounting.
		await page.addInitScript(() => {
			navigator.storage.estimate = async () => ({ quota: 1_000_128, usage: 1_000_000 });
		});
		await page.reload();

		await refuses(page, await bundleFixture(projectFiles()), 'needs about', 'free');
	});
});

test.describe('bundled content is untrusted (ADR-0009)', () => {
	test('an XSS payload in an annotation description arrives inert', async ({ page }) => {
		// What opening a bundle owes is to treat the file as bytes — never parsing, interpreting, or
		// inserting it — so the payload reaches storage unchanged and nothing in the path executes it.
		const payload =
			'{"type":"FeatureCollection","features":[{"type":"Feature","properties":' +
			'{"description":"<img src=x onerror=\\"window.__xss=1\\"><script>window.__xss=1</script>"},' +
			'"geometry":null}]}';
		const failures: string[] = [];
		page.on('pageerror', (error) => failures.push(error.message));
		page.on('dialog', (dialog) => failures.push(`dialog: ${dialog.message()}`));

		await openBundle(
			page,
			await bundleFixture(projectFiles({ 'annotations/warehouses.geojson': payload }))
		);
		await expect(banner(page)).toBeVisible();

		const stored = await everyByteOf(page, 'amsterdam-1625');
		expect(stored['amsterdam-1625/annotations/warehouses.geojson']).toBe(payload);
		expect(failures).toEqual([]);
		expect(
			await page.evaluate(() => ({
				injected: document.querySelector('img[src="x"]') !== null,
				ran: '__xss' in window
			}))
		).toEqual({ injected: false, ran: false });
	});
});

test.describe('the keyboard alone (SPEC story 95)', () => {
	test('opens a bundle and exports a Project with no pointer', async ({ page }) => {
		const openButton = page.getByTestId('open-bundle');
		await openButton.focus();
		await page.keyboard.press('Enter');

		const dialog = page.getByRole('dialog', { name: 'Open a Project someone sent me' });
		await expect(dialog).toBeVisible();
		// The file input itself has to be reachable; `setInputFiles` is how a test supplies a file, but
		// focusing it first is the assertion that a keyboard user can get to it.
		const chooser = dialog.getByLabel('Project bundle');
		await chooser.focus();
		await expect(chooser).toBeFocused();
		await chooser.setInputFiles(await bundleFixture(projectFiles()));

		const confirm = page.getByTestId('confirm-open-bundle');
		await confirm.focus();
		await page.keyboard.press('Enter');
		await expect(banner(page)).toBeVisible();

		const download = page.waitForEvent('download');
		const exportButton = page.getByRole('button', { name: /^Export/ });
		await exportButton.focus();
		await expect(exportButton).toBeFocused();
		await page.keyboard.press('Enter');
		expect((await download).suggestedFilename()).toBe('amsterdam-1625.project.tar');
	});

	test('Escape closes the dialog and focus returns to the button that opened it', async ({
		page
	}) => {
		const trigger = page.getByTestId('open-bundle');
		await trigger.click();
		await expect(
			page.getByRole('dialog', { name: 'Open a Project someone sent me' })
		).toBeVisible();

		await page.keyboard.press('Escape');

		await expect(page.getByRole('dialog', { name: 'Open a Project someone sent me' })).toBeHidden();
		await expect(trigger).toBeFocused();
	});
});
