import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { unpackTar } from 'modern-tar';
import { readFile } from 'node:fs/promises';

import {
	closeWorkspaceSettings,
	expectWorkspaceNamed,
	openWorkspaceSettings
} from './support/workspace';

/**
 * Backing a Workspace up to one tar, and restoring it (ticket 13, ADR-0024).
 *
 * SPEC's Seam 2. The archive format, the byte-for-byte round trip, every refusal, and the streaming
 * and long-path measurements are all asserted at Seam 1 — `workspace-tar.test.ts` and
 * `tar-format.test.ts` in `@ballastella/core`. What only a browser can show is here:
 *
 *   - a real download arrives, named after the Workspace, and is a real tar when Node opens it;
 *   - a tar chosen through a file input reaches **OPFS**, in a Workspace that did not exist before;
 *   - the Workspace that was open is still there, untouched, with the app now looking at the new one;
 *   - the re-publish notice reaches a screen the user can read, and is announced.
 *
 * ⚠ **Every claim about where work went is read out of OPFS behind the app's back**, the discipline
 * `editor-named-workspaces.e2e.ts` sets down: the save indicator says "Saved" before a save begins as
 * well as after one, so it cannot answer "which directory did the bytes land in".
 */

const HUB = './';

/** Empty the whole of browser storage — every named Workspace — so no test sees another's. */
async function emptyBrowserStorage(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
		localStorage.removeItem('ballastella.workspace');
	});
}

/** Every path in the OPFS root, Workspace directory included, so containment is provable. */
async function everyPathInBrowserStorage(page: Page): Promise<string[]> {
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

const projectJson = (name: string): string =>
	`${JSON.stringify(
		{
			formatVersion: 1,
			name,
			updatedAt: '2025-03-04T11:22:33.000Z',
			layers: [
				{
					id: 'l1',
					name: 'The 1625 plan',
					visible: true,
					order: 0,
					kind: 'map',
					opacity: 0.8,
					imageId: 'amsterdam-1625'
				}
			],
			baseMap: null
		},
		null,
		'\t'
	)}\n`;

/**
 * A Workspace with two Projects over one shared Map Image — the first acceptance criterion's
 * shape, and the one ADR-0023 made possible.
 */
const workspaceFiles = (): Record<string, string> => ({
	'amsterdam-1625/project.json': projectJson('Amsterdam 1625'),
	'amsterdam-1625/annotations/warehouses.geojson': '{"type":"FeatureCollection","features":[]}',
	'the-canal-ring/project.json': projectJson('The Canal Ring'),
	'the-canal-ring/annotations/bridges.geojson': '{"type":"FeatureCollection","features":[]}',
	// alignment-write-is-the-fixture: the Workspace this spec backs up and restores, laid down before the app starts
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'stands in for a tile',
	// Build output, which a backup must leave behind (ADR-0006). Seeded so its *absence* is a
	// measurement rather than an assumption.
	'index.html': '<!doctype html><title>a stale site</title>',
	'ballastella-site.json': '{"projects":[]}',
	'_app/immutable/chunks/abc123.js': 'export{}'
});

/** Write files into the named Workspace in OPFS, before the app has looked at it. */
async function seedWorkspace(
	page: Page,
	workspace: string,
	files: Record<string, string>
): Promise<void> {
	await page.evaluate(
		async ({ workspace, files }) => {
			const root = await navigator.storage.getDirectory();
			const into = await root.getDirectoryHandle(workspace, { create: true });
			for (const [path, text] of Object.entries(files)) {
				const segments = path.split('/');
				const name = segments.pop() as string;
				let directory = into;
				for (const segment of segments) {
					directory = await directory.getDirectoryHandle(segment, { create: true });
				}
				const handle = await directory.getFileHandle(name, { create: true });
				const writable = await handle.createWritable();
				await writable.write(text);
				await writable.close();
			}
		},
		{ workspace, files }
	);
}

const settings = (page: Page) => page.getByRole('dialog', { name: 'Workspace settings' });

/**
 * A path inside a named Workspace — an archive entry's, or a path in the OPFS root.
 *
 * A function rather than a template literal at each call site, because
 * `${workspace}/alignments/<id>.json` is *exactly* the Project-rooted spelling ADR-0023 forbids and
 * `check-workspace-rooted-paths` rightly refuses on sight. The shape is legitimate here and nowhere
 * else in the tree: the leading segment is the **Workspace's** own name, which since ticket 12 is a
 * directory above the store root, so no store path ever contains it. Saying that in one named helper
 * is better than an opt-out pragma on four lines claiming something that is not true of them.
 */
const inWorkspace = (workspace: string, path: string): string => `${workspace}/${path}`;

test.describe('backing up a Workspace', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(HUB);
		await emptyBrowserStorage(page);
		await seedWorkspace(page, DEFAULT_WORKSPACE, workspaceFiles());
		await page.reload();
	});

	test('downloads one tar named after the Workspace, holding the work and not the site', async ({
		page
	}) => {
		await openWorkspaceSettings(page);

		const downloading = page.waitForEvent('download');
		await settings(page).getByTestId('back-up-workspace').click();
		const download = await downloading;

		// Named after the Workspace, because since ticket 12 the Workspace's name is its directory
		// name and that is the only place it lives.
		expect(download.suggestedFilename()).toBe(`${DEFAULT_WORKSPACE}.tar`);

		// A real tar, opened by something that is not our own reader.
		const path = await download.path();
		const entries = await unpackTar(await readFile(path), { strict: true });
		const names = entries.map((entry) => entry.header.name);

		// Rooted at a directory named after the Workspace, so `tar xf` on a computer with no browser
		// involved produces a folder a person recognises.
		expect(names[0]).toBe(`${DEFAULT_WORKSPACE}/`);

		// Both Projects, the shared map, and the Alignment.
		expect(names).toContain(`${DEFAULT_WORKSPACE}/amsterdam-1625/project.json`);
		expect(names).toContain(`${DEFAULT_WORKSPACE}/the-canal-ring/project.json`);
		expect(names).toContain(inWorkspace(DEFAULT_WORKSPACE, 'alignments/amsterdam-1625.json'));
		expect(
			names.filter((name) =>
				name.startsWith(inWorkspace(DEFAULT_WORKSPACE, 'images/amsterdam-1625/'))
			)
		).toHaveLength(2);

		// And none of the published viewer files, which is the third acceptance criterion.
		expect(names).not.toContain(`${DEFAULT_WORKSPACE}/index.html`);
		expect(names).not.toContain(`${DEFAULT_WORKSPACE}/ballastella-site.json`);
		expect(names.filter((name) => name.startsWith(`${DEFAULT_WORKSPACE}/_app/`))).toEqual([]);

		// Said in words the user can read, not only drawn (story 111), and announced (story 112).
		await expect(settings(page).getByTestId('transfer-outcome')).toContainText(
			`${DEFAULT_WORKSPACE}.tar`
		);
	});

	test('is reachable and operable from the keyboard alone', async ({ page }) => {
		// SPEC's accessibility discipline: the one way a scholar's work leaves the browser cannot be
		// mouse-only.
		await openWorkspaceSettings(page);
		const button = settings(page).getByTestId('back-up-workspace');
		await button.focus();
		await expect(button).toBeFocused();

		const downloading = page.waitForEvent('download');
		await page.keyboard.press('Enter');
		expect((await downloading).suggestedFilename()).toBe(`${DEFAULT_WORKSPACE}.tar`);
	});
});

test.describe('restoring a Workspace', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(HUB);
		await emptyBrowserStorage(page);
		await seedWorkspace(page, DEFAULT_WORKSPACE, workspaceFiles());
		await page.reload();
	});

	/** Back up the open Workspace and hand the bytes back, as a file a user could have kept. */
	async function backUpToBuffer(page: Page): Promise<Buffer> {
		await openWorkspaceSettings(page);
		const downloading = page.waitForEvent('download');
		await settings(page).getByTestId('back-up-workspace').click();
		const download = await downloading;
		const buffer = await readFile(await download.path());
		await closeWorkspaceSettings(page);
		return buffer;
	}

	test('creates a new Workspace, switches to it, and leaves the old one untouched', async ({
		page
	}) => {
		const backup = await backUpToBuffer(page);

		// The backup is now restored into the *same* browser, which is the sharper case: there is
		// already a Workspace by that name, so ticket 12's suffixing has to produce a second one
		// rather than opening the first.
		await openWorkspaceSettings(page);
		await settings(page)
			.getByTestId('restore-file')
			.setInputFiles({
				name: `${DEFAULT_WORKSPACE}.tar`,
				mimeType: 'application/x-tar',
				buffer: backup
			});

		// The notice, in words, saying a re-publish is needed (story 86) and announced (story 112).
		const outcome = settings(page).getByTestId('transfer-outcome');
		await expect(outcome).toContainText('publish', { timeout: 30_000 });
		await expect(outcome).toContainText('not been touched');

		await closeWorkspaceSettings(page);

		// **Switched to the new one**, which the bar says on every screen (SPEC story 88).
		const restoredName = `${DEFAULT_WORKSPACE} (2)`;
		await expectWorkspaceNamed(page, restoredName);

		// Read out of OPFS behind the app's back: both Workspaces exist, and the original still holds
		// everything it did — including the site files, which the backup left out but which restoring
		// must not have removed from the Workspace it was taken from.
		const paths = await everyPathInBrowserStorage(page);
		for (const path of Object.keys(workspaceFiles())) {
			expect(paths).toContain(`${DEFAULT_WORKSPACE}/${path}`);
		}

		// And the new one holds the work, with none of the build output.
		expect(paths).toContain(`${restoredName}/amsterdam-1625/project.json`);
		expect(paths).toContain(`${restoredName}/the-canal-ring/project.json`);
		expect(paths).toContain(inWorkspace(restoredName, 'alignments/amsterdam-1625.json'));
		expect(paths).toContain(inWorkspace(restoredName, 'images/amsterdam-1625/info.json'));
		expect(paths).not.toContain(`${restoredName}/index.html`);
		expect(paths).not.toContain(`${restoredName}/ballastella-site.json`);
		expect(paths.filter((path) => path.startsWith(`${restoredName}/_app/`))).toEqual([]);

		// Both Projects list on the hub of the Workspace now open, which is the criterion a path
		// comparison cannot answer: it is `listProjects` that decides what a scholar sees.
		await expect(page.getByRole('heading', { name: 'Amsterdam 1625' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'The Canal Ring' })).toBeVisible();
	});

	test('refuses a file that is not a backup, in words, and creates no Workspace', async ({
		page
	}) => {
		await openWorkspaceSettings(page);
		await settings(page)
			.getByTestId('restore-file')
			.setInputFiles({
				name: 'holiday.jpg',
				mimeType: 'image/jpeg',
				buffer: Buffer.from('this is a photograph, not a Workspace')
			});

		// An alert the user can read, ending with the promise every refusal here makes — rather than
		// the tar parser's own sentence, which names nothing anybody can act on.
		const problem = settings(page).getByTestId('transfer-problem');
		await expect(problem).toBeVisible();
		await expect(problem).toContainText('Nothing has been restored');

		await closeWorkspaceSettings(page);
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);

		// Nothing was made. Read out of OPFS, because "no second Workspace" is a claim about
		// directories and the screen cannot answer it.
		const roots = new Set(
			(await everyPathInBrowserStorage(page)).map((path) => path.split('/')[0])
		);
		expect([...roots]).toEqual([DEFAULT_WORKSPACE]);
	});

	test('refuses a backup from a newer version of the app, naming where to get it', async ({
		page
	}) => {
		// Story 114, and ADR-0010's discipline: a `formatVersion` from the future is refused with a
		// message naming where to get that version, and nothing is restored.
		const backup = await backUpToBuffer(page);
		// The manifest inside says version 1; rewriting it to 99 in the archive's bytes is enough,
		// because tar stores entries verbatim and the length is unchanged.
		const tampered = Buffer.from(
			backup
				.toString('latin1')
				.replace('"formatVersion": 1', '"formatVersion":99')
				.padEnd(backup.length, '\0'),
			'latin1'
		);

		await openWorkspaceSettings(page);
		await settings(page).getByTestId('restore-file').setInputFiles({
			name: 'from-the-future.tar',
			mimeType: 'application/x-tar',
			buffer: tampered
		});

		const problem = settings(page).getByTestId('transfer-problem');
		await expect(problem).toBeVisible({ timeout: 30_000 });
		await expect(problem).toContainText('ballastella');
		await expect(problem).toContainText('Nothing has been restored');

		await closeWorkspaceSettings(page);
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);

		// **Nothing left behind.** The destination Workspace is created before the manifests are read,
		// so this is the assertion that the discard really happened rather than leaving a half-restored
		// Workspace in the switcher.
		const roots = new Set(
			(await everyPathInBrowserStorage(page)).map((path) => path.split('/')[0])
		);
		expect([...roots]).toEqual([DEFAULT_WORKSPACE]);
	});
});

/**
 * A **folder** Workspace's name is the operating system's folder name, and it has never been through
 * `toWorkspaceName` (ticket 12).
 *
 * ⚠ **This block exists because its absence let a real defect ship.** Every other test in this file,
 * and every fixture in `workspace-tar.test.ts`, used `My Workspace` — one of the few names the
 * normaliser leaves untouched — so nothing anywhere exercised a Workspace whose name is not already a
 * legal Workspace name. `exportWorkspaceTar` wrote that raw folder name into the archive and
 * `backupWorkspaceName` refused to restore it, so a scholar with a folder called `Dave's maps` got a
 * backup that failed **only when they tried to restore it**, which is the one moment it matters.
 *
 * The stubbed picker is the one `editor-folder-workspace.e2e.ts` documents at length: the dialog is
 * simulated, the `FileSystemDirectoryHandle` it hands back is genuine, and every file operation the
 * app then performs on it is the real API. What matters here is only that the folder is called
 * something a folder may be called and a Workspace may not.
 */
test.describe('backing up a folder Workspace', () => {
	/** Ordinary on any filesystem, and illegal as a Workspace name. */
	const FOLDER = "Dave's maps, 1625";
	/** What `toWorkspaceName` makes of it: apostrophe and comma become spaces, which then collapse. */
	const LEGAL = 'Dave s maps 1625';

	test.beforeEach(async ({ page }) => {
		await page.addInitScript(
			({ folder }) => {
				Object.defineProperty(window, 'showDirectoryPicker', {
					configurable: true,
					writable: true,
					value: async () =>
						(await navigator.storage.getDirectory()).getDirectoryHandle(folder, { create: true })
				});
				// On the prototype, not the handle: a handle recalled from IndexedDB is a fresh object.
				const handles = FileSystemHandle.prototype as {
					queryPermission?: unknown;
					requestPermission?: unknown;
				};
				handles.queryPermission = async () => 'granted';
				handles.requestPermission = async () => 'granted';
			},
			{ folder: FOLDER }
		);
		await page.goto(HUB);
		await emptyBrowserStorage(page);
		await page.evaluate(
			() =>
				new Promise<void>((resolve) => {
					const request = indexedDB.deleteDatabase('ballastella');
					request.onsuccess = () => resolve();
					request.onerror = () => resolve();
					request.onblocked = () => resolve();
				})
		);
		await page.reload();

		// Seeded **before** the folder is taken, and that ordering is not incidental. A folder grant
		// does not survive a reload without a fresh user gesture (ADR-0012), so seeding after the pick
		// and then reloading drops the app back to browser storage — which is exactly what the first
		// draft of this test did, and it quietly backed up `My Workspace` instead. The directory is an
		// ordinary OPFS directory either way, so filling it first costs nothing.
		await seedWorkspace(page, FOLDER, workspaceFiles());

		// Take the folder through the real button and a real user gesture. No reload after this point.
		await openWorkspaceSettings(page);
		await settings(page).getByTestId('settings-choose-folder').click();
		await expect(settings(page).getByTestId('settings-folder-name')).toHaveText(FOLDER);
		await closeWorkspaceSettings(page);
		await expectWorkspaceNamed(page, FOLDER);
	});

	test('produces an archive that restores, rather than one that fails at restore', async ({
		page
	}) => {
		await openWorkspaceSettings(page);

		const downloading = page.waitForEvent('download');
		await settings(page).getByTestId('back-up-workspace').click();
		const download = await downloading;

		// Named after what it will restore as, not after the folder — so what lands in Downloads, what
		// `tar xf` unpacks, and what the Workspace is called afterwards all agree.
		expect(download.suggestedFilename()).toBe(`${LEGAL}.tar`);

		const archive = await readFile(await download.path());
		const entries = await unpackTar(archive, { strict: true });
		expect(entries[0]?.header.name).toBe(`${LEGAL}/`);
		// The folder's real name is not thrown away: it rides along in a PAX record.
		expect(entries[0]?.header.pax?.['BALLASTELLA.workspace']).toBe(FOLDER);
		expect(entries.every((entry) => entry.header.name.startsWith(`${LEGAL}/`))).toBe(true);

		// Said in words, because the name did change and a silent rename is what ticket 12 fixed.
		await expect(settings(page).getByTestId('transfer-outcome')).toContainText(LEGAL);

		// **And it restores** — the assertion whose absence was the defect.
		await settings(page)
			.getByTestId('restore-file')
			.setInputFiles({ name: `${LEGAL}.tar`, mimeType: 'application/x-tar', buffer: archive });

		const outcome = settings(page).getByTestId('transfer-outcome');
		await expect(outcome).toContainText('publish', { timeout: 30_000 });
		await closeWorkspaceSettings(page);

		// A folder Workspace restores into browser storage beside it, with the folder untouched.
		await expectWorkspaceNamed(page, LEGAL);
		const paths = await everyPathInBrowserStorage(page);
		expect(paths).toContain(`${LEGAL}/amsterdam-1625/project.json`);
		expect(paths).toContain(`${LEGAL}/the-canal-ring/project.json`);
		for (const path of Object.keys(workspaceFiles())) {
			expect(paths).toContain(`${FOLDER}/${path}`);
		}

		await expect(page.getByRole('heading', { name: 'Amsterdam 1625' })).toBeVisible();
	});
});
