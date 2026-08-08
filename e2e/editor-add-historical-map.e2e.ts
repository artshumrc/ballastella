import { expect, test } from './support/test.js';
import { type Page } from '@playwright/test';

import {
	gradientPng,
	makePairs,
	maskPointsAttribute,
	start,
	storedAlignment,
	waitForStored
} from './support/alignment-workspace.js';
import { createProject, emptyWorkspace, openLayers } from './support/annotations.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	addHistoricalMapButton,
	addHistoricalMapFromFile,
	openAddHistoricalMap
} from './support/historical-maps.js';
import { openLayerRow } from './support/layers.js';
import { waitForStoredLayers } from './support/saved.js';

/**
 * Ticket 06: a Historical Map comes into a Project from any of three sources, through one
 * affordance, and the third of them is new (SPEC stories 21–30, 33, 36, 106).
 *
 * SPEC Seam 2 — the running app in a real browser against real OPFS. What can only be asserted here
 * is what the file and library sources already had suites of their own for
 * (`editor-image-ingest.e2e.ts`, `editor-remote-iiif.e2e.ts`) and what neither of them could:
 * that all three are offered together, and that adding a map the Workspace already holds writes a
 * Layer and **not a byte** of anything else.
 */

test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

/** Every file under `images/`, so "nothing was copied" can be a count rather than a hope. */
const imageFiles = (page: Page): Promise<string[]> =>
	page.evaluate(async () => {
		const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<string[]> => {
			const found: string[] = [];
			for await (const [name, entry] of handle.entries()) {
				if (entry.kind === 'file') found.push(`${prefix}${name}`);
				else found.push(...(await walk(entry as FileSystemDirectoryHandle, `${prefix}${name}/`)));
			}
			return found;
		};
		const root = await workspaceRoot();
		try {
			return (await walk(await root.getDirectoryHandle('images'), 'images/')).sort();
		} catch {
			return [];
		}
	});

/** Delete one file from the Workspace, to stand in for a write that never landed. */
const deleteStoredFile = (page: Page, path: string): Promise<void> =>
	page.evaluate(async (path) => {
		const root = await workspaceRoot();
		const segments = path.split('/');
		let handle = root;
		for (const segment of segments.slice(0, -1)) {
			handle = await handle.getDirectoryHandle(segment);
		}
		await handle.removeEntry(segments[segments.length - 1] as string);
	}, path);

/** A fresh Workspace with one empty Project open. */
async function emptyProject(page: Page, name: string, directory: string): Promise<void> {
	await page.goto('/');
	await emptyWorkspace(page);
	await page.reload();
	await createProject(page, name);
	await page.getByRole('link', { name }).click();
	await openLayers(page, directory);
}

test.describe('adding a Historical Map', () => {
	test('offers all three sources at once, with none of them behind a further step', async ({
		page
	}) => {
		// The ticket's contract: "A user who has a map on their laptop, a map at a library, and a map
		// they prepared last week should see all three answers at once." Asserted as three *operable*
		// controls in one open dialog — not three headings, since a heading over a collapsed section
		// would satisfy a weaker version of this and is exactly what was ruled out.
		await emptyProject(page, 'Amsterdam 1625', 'amsterdam-1625');

		// One affordance in the sidebar, with words on it (SPEC story 111).
		const button = addHistoricalMapButton(page);
		await expect(button).toBeVisible();
		await expect(button).toHaveText('Add a Historical Map');

		const dialog = await openAddHistoricalMap(page);
		// Each of the three is ready to use with no further click: a file can be picked, an address
		// typed, and the Workspace's answer is already on screen.
		await expect(dialog.getByLabel('Add a Historical Map from a file')).toBeEnabled();
		await expect(dialog.getByTestId('remote-url')).toBeEditable();
		await expect(dialog.getByTestId('no-workspace-maps')).toContainText(
			'This Workspace holds no Historical Maps yet'
		);
	});

	test('the empty Project names the button that fills it', async ({ page }) => {
		// SPEC story 106, and the ticket's rule about it: the thing the sentence names has to be the
		// thing that is there. Asserted against the button's own text, so renaming one and not the
		// other is a failure rather than a drift nobody notices.
		await emptyProject(page, 'Amsterdam 1625', 'amsterdam-1625');

		const label = await addHistoricalMapButton(page).textContent();
		await expect(page.getByTestId('no-layers')).toContainText(label!.trim());
		await expect(page.getByTestId('no-historical-maps')).toContainText(label!.trim());
	});

	test('lists the Workspace’s other maps with their sizes, and leaves out the ones this Project has', async ({
		page
	}) => {
		await emptyProject(page, 'Amsterdam 1625', 'amsterdam-1625');
		await addHistoricalMapFromFile(page, {
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(280, 200)
		});
		await waitForStoredLayers(page, 1, 'amsterdam-1625');

		// In the Project that draws it, it is not on offer: adding it again would do nothing, and an
		// affordance that does nothing is worse than one that is not there.
		let dialog = await openAddHistoricalMap(page);
		await expect(dialog.getByTestId('workspace-map')).toHaveCount(0);
		await expect(dialog.getByTestId('no-workspace-maps')).toContainText('already in this Project');
		await page.getByTestId('close-add-historical-map').click();

		// In a second Project it is, with the name it was given and what it weighs.
		await page.goto('/');
		await createProject(page, 'Boston 1775');
		await page.getByRole('link', { name: 'Boston 1775' }).click();
		await openLayers(page, 'boston-1775');

		dialog = await openAddHistoricalMap(page);
		const offered = dialog.getByTestId('workspace-map');
		await expect(offered).toHaveCount(1);
		await expect(offered).toContainText('la-floride.png');
		// A real size in real units, from the same figure the hub's reclaim list states — and the file
		// count beside it, because "3 files" and "31 000 files" are different news about one number.
		await expect(offered).toContainText(/\d+(\.\d+)?\s?(B|kB|MB|GB)/);
		await expect(offered).toContainText(/\d+ files/);
	});

	test('adds an aligned Workspace map to another Project, drawing it and copying nothing', async ({
		page
	}) => {
		// ┌───────────────────────────────────────────────────────────────────────────────────────┐
		// │ THE WHOLE POINT OF ADR-0023, END TO END.                                              │
		// └───────────────────────────────────────────────────────────────────────────────────────┘
		//
		// One pyramid, prepared once and placed once, drawn by a second Project with no preparation,
		// no alignment and no copy. The two halves are asserted separately because they fail
		// separately: the map is *drawn* (so the Alignment really did apply), and `images/` holds
		// exactly the files it held before (so nothing was copied to make that happen).
		const imageId = await start(page);
		await makePairs(page, 3);
		await waitForStored(page, imageId, 3);
		const alignedBytes = await storedAlignment(page, imageId);
		const before = await imageFiles(page);
		expect(before.length).toBeGreaterThan(0);

		await page.goto('/');
		await createProject(page, 'Boston 1775');
		await page.getByRole('link', { name: 'Boston 1775' }).click();
		await openLayers(page, 'boston-1775');

		const dialog = await openAddHistoricalMap(page);
		await dialog.getByTestId('workspace-map').click();

		// The Layer is there, and it is **not** "not aligned yet": the Alignment made in Amsterdam is
		// this Layer's Alignment, because it belongs to the Historical Map and not to a Project.
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
		await expect(page.getByTestId('layer-row').first()).toHaveAttribute('data-image-id', imageId);
		const row = await openLayerRow(page);
		await expect(row.getByTestId('layer-not-aligned')).toHaveCount(0);

		// And it is on the map with no further action — one of one Layer drawn.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1', {
			timeout: 30_000
		});

		// Nothing was copied. The file list is identical, not merely the same size.
		expect(await imageFiles(page)).toEqual(before);
		// And the Alignment was not rewritten either — byte for byte the one Amsterdam left.
		expect(await storedAlignment(page, imageId)).toBe(alignedBytes);
	});

	test('offers a pyramid whose Alignment never landed, and adding it writes one', async ({
		page
	}) => {
		// ┌───────────────────────────────────────────────────────────────────────────────────────┐
		// │ THE STATE TICKET 04 LEFT WITHOUT A PERSISTENT EXPLANATION.                            │
		// └───────────────────────────────────────────────────────────────────────────────────────┘
		//
		// A Historical Map whose starter Alignment could not be written arrives with its pyramid and
		// *without* its Layer — ADR-0023 writes the Alignment first on purpose. `session.ingestError`
		// says so while it is on screen and `EditorSession.open()` clears it, so after a reload the
		// sidebar said "This Project has no Historical Maps yet" while a pyramid the scholar watched
		// land sat in the Workspace with nothing connecting the two.
		//
		// The state is reproduced from its consequences rather than by failing a write: the Alignment
		// and the Layer are removed, which is exactly the pair of files that add would have left.
		await emptyProject(page, 'Amsterdam 1625', 'amsterdam-1625');
		await addHistoricalMapFromFile(page, {
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(280, 200)
		});
		await waitForStoredLayers(page, 1, 'amsterdam-1625');
		const imageId = (await page.getByTestId('layer-row').first().getAttribute('data-image-id'))!;

		await page.getByTestId('layer-delete').click();
		await waitForStoredLayers(page, 0, 'amsterdam-1625');
		await deleteStoredFile(page, `alignments/${imageId}.json`);

		// After a reload nothing on this screen mentions the pyramid — which is the whole complaint.
		await page.reload();
		await openLayers(page, 'amsterdam-1625');
		await expect(page.getByTestId('no-historical-maps')).toBeVisible();

		// Except here, which is the answer: the orphan is on offer, and adding it is the repair.
		const dialog = await openAddHistoricalMap(page);
		const offered = dialog.getByTestId('workspace-map');
		await expect(offered).toHaveCount(1);
		await offered.click();

		await expect(page.getByTestId('layer-row')).toHaveCount(1);
		await waitForStoredLayers(page, 1, 'amsterdam-1625');
		// The starter Alignment is on disk again, over the whole sheet — so the Project is exportable
		// rather than one `assertReferencesPresent` refuses.
		const written = await storedAlignment(page, imageId);
		expect(written).not.toBeNull();
		expect(JSON.parse(written!).body.features).toEqual([]);
		// Over the whole sheet, which is what says the size came off the pyramid's own `info.json`
		// rather than being invented: a starter Alignment's Resource Mask is the image's rectangle.
		expect(maskPointsAttribute(written!)).toBe('0,0 280,0 280,200 0,200');
	});
});
