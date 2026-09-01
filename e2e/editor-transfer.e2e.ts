import { readFile } from 'node:fs/promises';

import {
	hashesUnder,
	waitForOpeningView,
	waitForPaintedAnnotations,
	waitForStack
} from './support/annotations.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { openProjectSettings } from './support/project-screen.js';
import { DEFAULT_WORKSPACE, expect, type Locator, test, type Page } from './support/test.js';
import {
	createWorkspace,
	backUpWorkspace,
	closeWorkspaceDialog,
	openWorkspaceMenu,
	switchToWorkspace
} from './support/workspace.js';

/**
 * Seam 2 for transfer: handing a Project over and reviewing one, driven through the UI against real
 * OPFS.
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
		// And which *folder* was the user's own, which is the third of the three and the one whose
		// absence would send this suite's "back to my Workspace" through a picker.
		localStorage.removeItem('ballastella.own-folder');
	});
}

/**
 * Every path and every byte of one named Workspace.
 *
 * ⚠ **This is the "byte-identical before and after" claim, and it is the easiest one here to fake.**
 * Asserting that the Project list is unchanged would pass while an Alignment had been overwritten, so
 * this lists every path and reads every byte — the contents, not a count, not a listing, and not a
 * size.
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

/**
 * The Annotation Layer's `FeatureCollection`, with something actually in it.
 *
 * ⚠ **An empty `{"features":[]}` makes the reading claim unassertable.** "Explore it as though it
 * were your own — pan the map, toggle Layers, read Annotations" cannot be checked against a Layer
 * with nothing in it: every assertion about reading a colleague's Annotation would pass over an empty
 * collection. The coordinates are where the Project's own Alignment puts the sheet, so the
 * Annotation is on screen when the Project opens on its own content (ADR-0026).
 */
const WAREHOUSES_GEOJSON = JSON.stringify({
	type: 'FeatureCollection',
	features: [
		{
			type: 'Feature',
			// An explicit id: `parseAnnotations` mints one otherwise and the test could not address it.
			id: '11111111-1111-4111-8111-111111111111',
			geometry: { type: 'Point', coordinates: [4.9, 52.3676] },
			properties: {
				title: 'The west quay',
				description: 'Bonded warehouses, still standing in 1625.',
				'marker-size': 'large',
				'marker-color': '#cc0000'
			}
		}
	]
});

/** A Label as another GeoJSON tool writes it: a Point with simplestyle properties. */
const ZUIDERZEE_GEOJSON = JSON.stringify({
	type: 'FeatureCollection',
	features: [
		{
			type: 'Feature',
			id: 'label',
			geometry: { type: 'Point', coordinates: [4.9, 52.3676] },
			properties: {
				'marker-symbol': 'label',
				title: 'Zuiderzee',
				'marker-color': '#ffffff',
				fill: '#1976d2',
				'fill-opacity': 0.8,
				'marker-size': 'large'
			}
		}
	]
});

/**
 * A Project that has been handed on twice: published on somebody's site, then sent as a bundle.
 *
 * Written as the file spells it, because that is how a real imported Project arrives — the editor
 * reads this history rather than being told one.
 */
const IMPORT_PROVENANCE = [
	{
		kind: 'github',
		owner: 'ada',
		repository: 'atlas',
		branch: 'main',
		directory: 'amsterdam-1625',
		commit: '9f2c1de4b7a80315c6e5d2f9a1b8c7d6e5f40312',
		observedAt: '2026-08-01T10:00:00.000Z',
		evidence: 'inherited'
	},
	{
		kind: 'project-bundle',
		filename: 'amsterdam-1625.project.tar',
		projectName: 'Amsterdam 1625',
		observedAt: '2026-08-22T09:30:00.000Z',
		evidence: 'observed'
	}
];

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
				// A map Layer, because since ADR-0023 an export gathers the Workspace Map Images a
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
	'annotations/warehouses.geojson': WAREHOUSES_GEOJSON,
	// alignment-write-is-the-fixture: the Workspace this spec exports and opens, laid down before the app starts
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'stands in for a tile',
	...overrides
});

/**
 * Assert the Project opened on `at` and **not** on `other`.
 *
 * Bounds rather than an exact centre: the opening view fits a box with padding and a zoom cap
 * (ADR-0026), so pinning six decimal places would be asserting the arithmetic, which
 * `opening-view.test.ts` already does numerically and without a browser. The negative half is the
 * one that carries the claim — an Alignment that had leaked from the other Review Workspace would
 * put this map on the wrong continent, and only asserting the positive would pass on a map showing
 * both.
 */
/**
 * The transfer announcement.
 *
 * `[data-transfer]` rather than `getByRole('status')`: the save indicator is on the navigation bar
 * and therefore on the hub too, so the hub has one `status` role of its own and this region is an
 * `aria-live="polite"` one — this repo's settled convention wherever the two meet.
 */
const transferStatus = (page: Page) => page.locator('[data-transfer]');

test.beforeEach(async ({ page }) => {
	await page.goto('./');
	await emptyEverything(page);
	await page.reload();
	await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
});

/**
 * The Export button for one Project, with its dialog opened.
 *
 * Export is inside the Project's own Edit dialog rather than on the row: everything that takes a
 * Project out of the browser or removes it is behind that one door.
 */
async function openExportFor(page: Page, project: string): Promise<Locator> {
	await page.getByRole('button', { name: `Edit ${project}` }).click();
	return page
		.getByRole('dialog', { name: 'Edit Project' })
		.getByRole('button', { name: 'Export Project' });
}

test.describe('exporting a Project as a bundle', () => {
	test('downloads a tar named for the folder, rooted at the Project, and announces it', async ({
		page
	}) => {
		await seedProject(page, 'amsterdam-1625', projectFiles());
		await page.reload();

		const exportButton = await openExportFor(page, 'Amsterdam 1625');
		const download = page.waitForEvent('download');
		await exportButton.click();
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

		// Progress is announced, not merely drawn.
		await expect(transferStatus(page)).toHaveText(/Exported Amsterdam 1625: 5 files\./);
	});

	// A bundle carries the Project it names and the shared material *that Project's Layers reference*,
	// and not the Workspace's other maps. That is the whole difference between a handoff and a backup,
	// so it is asserted at the seam where a real Workspace holds both.
	test('leaves the Workspace’s other Map Images out of it', async ({ page }) => {
		await seedProject(page, 'amsterdam-1625', projectFiles());
		await seedProject(page, 'the-canal-ring', {
			'project.json': projectJson({ name: 'The Canal Ring', layers: [] }),
			'images/blaeu-1649/info.json': '{"width":2048,"height":2048}',
			// alignment-write-is-the-fixture: the other map's Alignment, seeded so that leaving it out of the bundle is assertable
			'alignments/blaeu-1649.json': '{"type":"Annotation","id":"blaeu-1649"}'
		});
		await page.reload();

		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Edit Amsterdam 1625' }).click();
		await page
			.getByRole('dialog', { name: 'Edit Project' })
			.getByRole('button', { name: 'Export Project' })
			.click();
		const { unpackTar } = await import('modern-tar');
		const entries = await unpackTar(new Uint8Array(await readFile(await (await download).path())), {
			strict: true
		});

		const names = entries.map((entry) => entry.header.name);
		expect(names.sort()).toEqual(Object.keys(projectFiles()).sort());
		expect(names).not.toContain('images/blaeu-1649/info.json');
		expect(names).not.toContain('alignments/blaeu-1649.json');
	});

	test('exports a Project this build refuses to open (ADR-0010)', async ({ page }) => {
		// The Project a user most needs out of a browser they cannot see into is the one that will not
		// open, so Export is deliberately not disabled for it.
		await seedProject(page, 'from-the-future', {
			'project.json': '{"formatVersion":99,"name":"Tomorrow","layers":[]}'
		});
		await page.reload();
		await expect(page.getByText('Made with a newer version of Ballastella.')).toBeVisible();

		// Listed by its folder: a Project this build cannot read has no name it can vouch for.
		const exportButton = await openExportFor(page, 'from-the-future');
		const download = page.waitForEvent('download');
		await exportButton.click();
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
		await (await openExportFor(page, 'Amsterdam 1625')).click();

		const alert = page.getByRole('alert');
		await expect(alert).toBeVisible();
		await expect(alert).toContainText('project.json');
	});
});

test.describe('merely opening a Project leaves its files unchanged', () => {
	/**
	 * ⚠ **The Import Provenance assertions are folded in here, and the fold is the argument.**
	 *
	 * "Read-only" is two claims: that a reader can see the history, and that seeing it writes nothing.
	 * The second is exactly what this test already measures over every file in the Workspace, so the
	 * history is seeded into the same Project rather than into a spec of its own — and the metadata
	 * permutations behind it are proved at Seam 1 in `project-import-provenance.test.ts`, which is where
	 * that kind of claim belongs.
	 *
	 * The Project is seeded with a history rather than imported through the UI because Import has no UI
	 * yet. What is asserted here is the surface that does exist — the Project screen showing a transfer
	 * history it will not let anyone edit.
	 */
	test('merely opening a Project with a Label leaves every Project file hash-identical', async ({
		page
	}) => {
		await routeBaseMapArchive(page);
		await seedProject(
			page,
			'amsterdam-1625',
			projectFiles({
				'annotations/warehouses.geojson': ZUIDERZEE_GEOJSON,
				'project.json': projectJson({ importProvenance: IMPORT_PROVENANCE })
			})
		);
		await page.reload();
		const before = await hashesUnder(page, '');

		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await waitForOpeningView(page);
		await waitForStack(page);
		await waitForPaintedAnnotations(page, ['label']);

		const settings = await openProjectSettings(page);
		const history = settings.getByTestId('import-provenance');
		await expect(history).toContainText('read-only record of the transfers');
		// Not attribution, said in the words the section itself uses.
		await expect(history).toContainText('does not say who made the work');

		const entries = history.getByTestId('provenance-entry');
		await expect(entries).toHaveCount(2);
		// The carried entry first, and identified as carried rather than as something checked here.
		await expect(entries.nth(0)).toHaveAttribute('data-provenance-evidence', 'inherited');
		await expect(entries.nth(0)).toContainText('ada/atlas');
		await expect(entries.nth(0)).toContainText('9f2c1de4b7a80315c6e5d2f9a1b8c7d6e5f40312');
		await expect(entries.nth(0)).toContainText('not checked here');
		await expect(entries.nth(1)).toHaveAttribute('data-provenance-evidence', 'observed');
		await expect(entries.nth(1)).toContainText('amsterdam-1625.project.tar');
		await expect(entries.nth(1)).toContainText('Seen by Ballastella');
		// Read-only on the screen as well as on disk: the history offers nothing to change it with,
		// where the name beside it is a field.
		await expect(history.getByRole('textbox')).toHaveCount(0);
		await expect(history.getByRole('button')).toHaveCount(0);
		await expect(settings.getByTestId('project-name-input')).toBeVisible();

		// Let the 400 ms autosave debounce and any resulting flush complete.
		await page.waitForTimeout(600);

		expect(await hashesUnder(page, '')).toEqual(before);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// IMPORT: THE INVERSE OF EXPORT (ADR-0037)
//
// The engine is exhausted at Seam 1 and without a browser: fresh Map Image identities, repeated
// references, Alignment rewrites, name and directory allocation against every namespace, the
// publication reset, provenance inheritance, the atomic transaction and its quota and collision
// refusals are `project-import-source.test.ts`, `-remapping`, `-allocation`, `-provenance` and
// `-transaction`.
//
// What no seam below can falsify is that the *application* performs the operation it offers: that
// three actions on one screen mean three different things to the Workspace on disk; that the
// Workspace named in the offer is the one written to and no other is created; that a Project which
// arrives under an allocated name is reachable and ordinary afterwards; and that a refusal leaves
// every byte of real OPFS as it was. Four tests, folded as far as they go.

// ─────────────────────────────────────────────────────────────────────────────────────────────
// AN IMPORT THAT DID NOT FINISH
//
// An Import writes its provisional files straight to their final Workspace paths and makes them
// provisional by naming them in one durable marker: while that marker is unresolved the Workspace is
// unavailable, and startup recovery resolves it before anything asks the Workspace a question. Every
// decision that recovery makes — swept, finished, or refused — is asserted per durable boundary and
// without a browser in `packages/core/src/transfer/project-import-recovery.test.ts`.
//
// What only a browser can show is that the *application* is gated on it: the Project list is an
// effect over `?p=` that runs the moment the layout mounts, the Map Image list and the Workspace's
// size are walks of the same real OPFS, and a Backup is a third. So this is one test with three
// restarts in it rather than three tests — the subject is a single workflow, "what the next visit
// does with an outstanding marker", and the three markers are the three answers it can have.

test.describe('an Import that did not finish', () => {
	/** The Workspace the author already had, which a swept Import must leave exactly as it is. */
	const OWN = {
		'project.json': projectJson({ name: 'My own Amsterdam', layers: [] }),
		'annotations/quays.geojson': WAREHOUSES_GEOJSON,
		'images/blaeu-1649/info.json': '{"width":2048,"height":2048}',
		// alignment-write-is-the-fixture: the author's own Alignment, seeded so a sweep that touched it would be visible
		'alignments/blaeu-1649.json': '{"type":"Annotation","id":"blaeu-1649"}'
	};

	/**
	 * The closure an interrupted Import had written, at the fresh paths it had allocated.
	 *
	 * Project-relative, as {@link seedProject} takes them: the shared material goes to the Workspace
	 * root and the rest inside the directory, which is ADR-0023's split and therefore the layout a
	 * real Import would have left.
	 */
	const PROVISIONAL: Record<string, string> = {
		'project.json': projectJson({ name: 'Boston 1775', layers: [] }),
		'annotations/wharves.geojson': WAREHOUSES_GEOJSON,
		'images/img-imported/info.json': '{"width":1024,"height":1024}',
		// alignment-write-is-the-fixture: the incoming Alignment as an interrupted Import had already written it, at the fresh identity it allocated
		'alignments/img-imported.json': '{"type":"Annotation","id":"img-imported"}'
	};

	/** The same closure as the marker names it: Workspace-rooted, sorted, and authoritative. */
	const PROVISIONAL_PATHS = [
		'alignments/img-imported.json',
		'boston-1775/annotations/wharves.geojson',
		'boston-1775/project.json',
		'images/img-imported/info.json'
	];

	/** Write a marker naming {@link PROVISIONAL}, or any other bytes, at the Workspace root. */
	const plantMarker = (page: Page, marker: string) =>
		page.evaluate(async (marker) => {
			const handle = await (await workspaceRoot()).getFileHandle('import.json', { create: true });
			const writable = await handle.createWritable();
			await writable.write(marker);
			await writable.close();
		}, marker);

	const markerFor = (state: 'writing' | 'committed') =>
		JSON.stringify({
			formatVersion: 1,
			transaction: 'e2e-import',
			state,
			project: 'boston-1775/project.json',
			paths: PROVISIONAL_PATHS,
			startedAt: '2026-08-22T10:00:00.000Z'
		});

	const plantProvisional = (page: Page) => seedProject(page, 'boston-1775', PROVISIONAL);

	test('is swept, finished, or keeps the Workspace shut — before anything can list it', async ({
		page
	}) => {
		await seedProject(page, 'my-own-amsterdam', OWN);

		// ── A transaction that was still writing. Nothing about it is durable, so all of it goes.
		await plantProvisional(page);
		await plantMarker(page, markerFor('writing'));
		await page.reload();

		await expect(page.getByRole('link', { name: 'My own Amsterdam' })).toBeVisible();
		// Never listed, rather than listed and then removed: the Workspace does not open until the
		// marker is resolved, so there is no frame in which the half-arrived Project could appear.
		await expect(page.getByRole('link', { name: 'Boston 1775' })).toHaveCount(0);
		// Nor its Map Image, which is the reader the shared pool makes easiest to forget: `images/` holds
		// the author's own maps beside the Import's, one directory along.
		await expect(page.getByTestId('map-image')).toHaveCount(1);
		// Nor is any of it in a Backup — a second walk of the same Workspace.
		const saved = await backUpWorkspace(page);
		await closeWorkspaceDialog(page);
		const { unpackTar } = await import('modern-tar');
		const entries = await unpackTar(new Uint8Array(await readFile(await saved.path())), {
			strict: true
		});
		expect(entries.map((entry) => entry.header.name).sort()).toEqual(
			[
				// The archive's own directory entry for the Workspace it is rooted at.
				`${DEFAULT_WORKSPACE}/`,
				...Object.keys(OWN).map((path) =>
					path.startsWith('images/') || path.startsWith('alignments/')
						? `${DEFAULT_WORKSPACE}/${path}`
						: `${DEFAULT_WORKSPACE}/my-own-amsterdam/${path}`
				)
			].sort()
		);
		// The marker went last and took the whole inventory with it, so the disk is the pre-Import
		// Workspace exactly.
		expect(await everyByteOf(page, DEFAULT_WORKSPACE)).toEqual(
			Object.fromEntries(
				Object.entries(OWN).map(([path, text]) => [
					path.startsWith('images/') || path.startsWith('alignments/')
						? path
						: `my-own-amsterdam/${path}`,
					text
				])
			)
		);

		// And the Workspace weighs the author's own four files and not a byte of the Import's. This is
		// the one place a Workspace's size reaches a screen, and it is offered only for a Workspace the
		// user is *not* in — so reaching it means standing somewhere else and looking back at this one.
		await createWorkspace(page, 'Elsewhere');
		await openWorkspaceMenu(page);
		await page.getByRole('button', { name: `Delete ${DEFAULT_WORKSPACE}` }).click();
		await expect(page.getByTestId('delete-workspace-size')).toContainText(
			`It holds ${Object.keys(OWN).length} files,`
		);
		await page.getByRole('button', { name: 'Keep it' }).click();
		await switchToWorkspace(page, DEFAULT_WORKSPACE);

		// ── A transaction that had committed. Every final path is durable and nothing may be rolled
		// back, so all that is left is removing the marker that shuts the Workspace.
		await plantProvisional(page);
		await plantMarker(page, markerFor('committed'));
		await page.reload();

		await expect(page.getByRole('link', { name: 'Boston 1775' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'My own Amsterdam' })).toBeVisible();
		await expect(page.getByTestId('map-image')).toHaveCount(2);
		expect(Object.keys(await everyByteOf(page, DEFAULT_WORKSPACE))).not.toContain('import.json');

		// ── A marker that will not parse. Which of the two above it meant cannot be told, and guessing
		// wrong is either a Project silently deleted or a Workspace opened over half of one.
		await plantMarker(page, 'half a jso');
		await page.reload();

		await expect(page.getByTestId('unrecovered-import')).toBeVisible();
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Boston 1775' })).toHaveCount(0);
		// Nor is there a reader to reach: publishing is another walk of this Workspace, and it is absent
		// rather than present and refused — the arrangement a review copy already has. What Backup says
		// in this state is `keeping-your-work.dom.test.ts`'s, where the control lives.
		await expect(page.getByTestId('connect-to-github')).toHaveCount(0);
		await expect(page.getByTestId('back-up-workspace')).toHaveCount(0);
		// Staging internals are not the author's to read, and the marker is left where it is — which is
		// the durable evidence the next startup retries from.
		await expect(page.getByTestId('unrecovered-import')).not.toContainText('import.json');
		expect(await everyByteOf(page, DEFAULT_WORKSPACE)).toMatchObject({
			'import.json': 'half a jso'
		});
	});
});
