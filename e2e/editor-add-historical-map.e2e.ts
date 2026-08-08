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
import {
	baseMap,
	chooseTool,
	clickAt,
	createProject,
	emptyWorkspace,
	openLayers
} from './support/annotations.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	addHistoricalMapButton,
	addHistoricalMapFromFile,
	addHistoricalMapIsOpen,
	openAddHistoricalMap,
	pickHistoricalMapFile,
	preparingCard
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

/** Write one file into the Workspace, to stand in for something another tab left there. */
const writeStoredFile = (page: Page, path: string, contents: string): Promise<void> =>
	page.evaluate(
		async ({ path, contents }) => {
			const root = await workspaceRoot();
			const segments = path.split('/');
			let handle = root;
			for (const segment of segments.slice(0, -1)) {
				handle = await handle.getDirectoryHandle(segment, { create: true });
			}
			const file = await handle.getFileHandle(segments[segments.length - 1] as string, {
				create: true
			});
			const writable = await file.createWritable();
			await writable.write(contents);
			await writable.close();
		},
		{ path, contents }
	);

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

/**
 * A `remote.json` as another tab would have left it — a referenced Historical Map that entered this
 * Workspace after this Project was opened, which is exactly what ADR-0023 invites.
 */
const remoteRecord = (service: string, label: string) =>
	JSON.stringify({
		service,
		label,
		partOf: '',
		canvas: '',
		rights: '',
		attribution: '',
		width: 800,
		height: 600
	});

test.describe('the dialog itself (ADR-0016, SPEC stories 111, 112)', () => {
	test('opens as a modal dialog, closes on Escape, and gives focus back', async ({ page }) => {
		// The repo's pattern, from `editor-project-screen.e2e.ts`'s settings-dialog test, and it is
		// here because the helper this suite uses cannot stand in for it: `addHistoricalMapIsOpen`
		// reads `HTMLDialogElement.open`, which is `true` for `show()` as well as `showModal()`. So
		// the implementation was correct and nothing held it there — `:modal` is the only assertion
		// that tells the two apart, and with it goes the focus trap, Escape, and focus restoration.
		await emptyProject(page, 'Amsterdam 1625', 'amsterdam-1625');

		const button = addHistoricalMapButton(page);
		await button.click();
		const dialog = page.getByRole('dialog', { name: 'Add a Historical Map' });
		await expect(dialog).toBeVisible();
		expect(
			await dialog.evaluate((element) => element.matches(':modal')),
			'the Add a Historical Map dialog was not opened with showModal()'
		).toBe(true);

		await page.keyboard.press('Escape');
		await expect.poll(() => addHistoricalMapIsOpen(page)).toBe(false);
		// Back on the control the user reached for, which is where they can open it again.
		await expect(button).toBeFocused();
	});

	test('every control in it is reachable by keyboard', async ({ page }) => {
		// ┌───────────────────────────────────────────────────────────────────────────────────────┐
		// │ THE WALK THIS TICKET TOOK AWAY AND OWED BACK.                                         │
		// └───────────────────────────────────────────────────────────────────────────────────────┘
		//
		// `editor-project-screen.e2e.ts` walks every focusable control inside `project-screen` and
		// carves out dialogs "because they have keyboard tests of their own". Ticket 06 moved the
		// file input and the whole `AddRemoteMap` form out of that subtree and into a dialog that
		// had no such test — about five controls left the walk, and its `toBeGreaterThan(10)` guard
		// does not notice. This is the replacement, and the carve-out's justification now holds.
		await emptyProject(page, 'Amsterdam 1625', 'amsterdam-1625');
		await addHistoricalMapFromFile(page, {
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(280, 200)
		});
		await waitForStoredLayers(page, 1, 'amsterdam-1625');

		// A second Project, so the "already in this Workspace" list has a real row in it — a source
		// whose only control is a per-map button covers nothing while the list is empty.
		await page.goto('/');
		await createProject(page, 'Boston 1775');
		await page.getByRole('link', { name: 'Boston 1775' }).click();
		await openLayers(page, 'boston-1775');
		await openAddHistoricalMap(page);

		// Asked of the DOM rather than listed here, so a control added to the dialog later is
		// covered without anybody remembering to add it.
		const wanted = await page.evaluate(() => {
			const dialog = document.querySelector('dialog[open]')!;
			return [...dialog.querySelectorAll('a[href], button, input, select, textarea')]
				.filter((element) => {
					const control = element as HTMLElement & { disabled?: boolean };
					if (control.disabled) return false;
					const box = control.getBoundingClientRect();
					return box.width > 0 && box.height > 0;
				})
				.map((element, index) => {
					element.setAttribute('data-e2e-control', String(index));
					return String(index);
				});
		});
		// The file input, the URL field, the look-up button, the Workspace map, and Close, at least.
		expect(wanted.length).toBeGreaterThan(4);

		// A modal traps focus, so Tab cycles inside it and there is nothing to escape into.
		const reached = new Set<string>();
		for (let step = 0; step < wanted.length * 3 + 10; step++) {
			await page.keyboard.press('Tab');
			const seen = await page.evaluate(
				() => document.activeElement?.getAttribute('data-e2e-control') ?? null
			);
			if (seen !== null) reached.add(seen);
			if (reached.size === wanted.length) break;
		}

		expect([...wanted].filter((id) => !reached.has(id))).toEqual([]);
	});

	test('Escape that closes it does not abandon a part-drawn shape behind it', async ({ page }) => {
		// The guard the commit message advertises, which nothing asserted: `settingsOpen` has a test
		// and `addingMap` had none, so `|| addingMap` could be deleted with the whole suite green.
		// Escape closes a `<dialog>` natively **and keeps propagating**, so the window handler that
		// abandons a drawing gesture hears the keypress that only closed the dialog.
		await emptyProject(page, 'Amsterdam 1625', 'amsterdam-1625');
		await page.getByTestId('add-annotation-layer').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
		await openLayerRow(page);

		await chooseTool(page, 'polygon');
		await clickAt(baseMap(page), 0.4, 0.4);
		await clickAt(baseMap(page), 0.6, 0.4);
		const drawingStatus = page.getByTestId('annotation-status');
		await expect(drawingStatus).toHaveAttribute('data-drawing', 'true');

		await openAddHistoricalMap(page);
		await page.keyboard.press('Escape');
		await expect.poll(() => addHistoricalMapIsOpen(page)).toBe(false);
		await expect(drawingStatus).toHaveAttribute('data-drawing', 'true');

		// And Escape still cancels when the dialog is not in the way, so the guard swallowed nothing.
		await page.keyboard.press('Escape');
		await expect(drawingStatus).toHaveAttribute('data-drawing', 'false');
	});

	test('says it is looking through the Workspace before it can say what is in it', async ({
		page
	}) => {
		// The branch is transient by construction, so it is recorded rather than polled for: a
		// `MutationObserver` installed before the gesture sees a state that exists for one flush,
		// where `expect(...).toBeVisible()` is a race that reports "the branch is dead" as a flake.
		await emptyProject(page, 'Amsterdam 1625', 'amsterdam-1625');
		await addHistoricalMapFromFile(page, {
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(280, 200)
		});
		await waitForStoredLayers(page, 1, 'amsterdam-1625');

		await page.goto('/');
		await createProject(page, 'Boston 1775');
		await page.getByRole('link', { name: 'Boston 1775' }).click();
		await openLayers(page, 'boston-1775');

		await page.evaluate(() => {
			const seen = { saw: false };
			(window as unknown as { __loadingSeen: typeof seen }).__loadingSeen = seen;
			const look = () => {
				if (document.querySelector('[data-testid="workspace-maps-loading"]')) seen.saw = true;
			};
			new MutationObserver(look).observe(document.body, { subtree: true, childList: true });
			look();
		});

		const dialog = await openAddHistoricalMap(page);
		await expect(dialog.getByTestId('workspace-map')).toHaveCount(1);

		expect(
			await page.evaluate(
				() => (window as unknown as { __loadingSeen: { saw: boolean } }).__loadingSeen.saw
			),
			'the picker never said it was looking through the Workspace'
		).toBe(true);
	});
});

test.describe('adding a map this Workspace already holds', () => {
	test('says so afterwards, because the dialog it happened in is gone (SPEC story 112)', async ({
		page
	}) => {
		// The file source has a preparing card and a running commentary; the library source has a
		// card and the community-Alignment notice. This one finishes in milliseconds and closes the
		// dialog, so without a sentence a screen-reader user cannot tell a successful add from a
		// dialog that closed for no reason. `remote-notice` is the live region that already exists
		// for a statement that has to outlive the dialog.
		await emptyProject(page, 'Amsterdam 1625', 'amsterdam-1625');
		await addHistoricalMapFromFile(page, {
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(280, 200)
		});
		await waitForStoredLayers(page, 1, 'amsterdam-1625');

		await page.goto('/');
		await createProject(page, 'Boston 1775');
		await page.getByRole('link', { name: 'Boston 1775' }).click();
		await openLayers(page, 'boston-1775');

		const notice = page.getByTestId('remote-notice');
		// Always rendered, which is what makes a change to its text an announcement at all.
		await expect(notice).toHaveText('');

		const dialog = await openAddHistoricalMap(page);
		await dialog.getByTestId('workspace-map').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(1);

		await expect(notice).toContainText('la-floride.png');
		await expect(notice).toContainText('Nothing was copied');
	});

	test('does not leave the last add’s sentence in the live region across an unrelated open', async ({
		page
	}) => {
		// `addNotice` was cleared when an add *started* and not when the dialog *opened*, so a
		// sentence about something that happened minutes ago sat in a live region while the user
		// opened the dialog, changed their mind, and closed it again.
		await emptyProject(page, 'Amsterdam 1625', 'amsterdam-1625');
		await addHistoricalMapFromFile(page, {
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(280, 200)
		});
		await waitForStoredLayers(page, 1, 'amsterdam-1625');

		await page.goto('/');
		await createProject(page, 'Boston 1775');
		await page.getByRole('link', { name: 'Boston 1775' }).click();
		await openLayers(page, 'boston-1775');

		const dialog = await openAddHistoricalMap(page);
		await dialog.getByTestId('workspace-map').click();
		const notice = page.getByTestId('remote-notice');
		await expect(notice).toContainText('la-floride.png');

		// Opened again and closed without adding anything: the sentence goes with the gesture that
		// made it, rather than staying true of nothing.
		await openAddHistoricalMap(page);
		await expect(notice).toHaveText('');
		await page.getByTestId('close-add-historical-map').click();
		await expect(notice).toHaveText('');
	});

	test('two clicks in one task make one Layer, not two', async ({ page }) => {
		// ┌───────────────────────────────────────────────────────────────────────────────────────┐
		// │ WHY THIS IS DISPATCHED FROM THE PAGE RATHER THAN WITH `dblclick()`.                   │
		// └───────────────────────────────────────────────────────────────────────────────────────┘
		//
		// `disabled={adding !== ''}` catches the second press once Svelte has flushed, and
		// Playwright's own double-click is slow enough that it always has. Two clicks in **one
		// task** is what a real double click is on a machine under load, and it is the only way to
		// get two `addWorkspaceMap` calls in flight together.
		//
		// ⚠ **Measured: this invariant is held twice, and each guard alone keeps this test green.**
		// Deleting `AddHistoricalMap`'s early return leaves it passing (the session's own third
		// `drawnAlready()` check catches the race); deleting that check leaves it passing (the
		// dialog's early return catches it); deleting **both** turns it red, with two Layers over
		// one pyramid. So this asserts the property rather than either guard — which is what it
		// should assert — and neither guard is dead code that a single mutation would expose.
		await emptyProject(page, 'Amsterdam 1625', 'amsterdam-1625');
		await addHistoricalMapFromFile(page, {
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(280, 200)
		});
		await waitForStoredLayers(page, 1, 'amsterdam-1625');

		await page.goto('/');
		await createProject(page, 'Boston 1775');
		await page.getByRole('link', { name: 'Boston 1775' }).click();
		await openLayers(page, 'boston-1775');

		const dialog = await openAddHistoricalMap(page);
		await expect(dialog.getByTestId('workspace-map')).toHaveCount(1);
		await page.evaluate(() => {
			const button = document.querySelector<HTMLButtonElement>('[data-testid="workspace-map"]')!;
			button.click();
			button.click();
		});

		await expect(page.getByTestId('layer-row')).toHaveCount(1);
		// And on disk, which is the half a re-render cannot make true on its own.
		await waitForStoredLayers(page, 1, 'boston-1775');
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
	});

	test('adds one that entered this Workspace after the Project was opened', async ({ page }) => {
		// ┌───────────────────────────────────────────────────────────────────────────────────────┐
		// │ THE PICKER MUST NOT LIST A MAP IT WILL THEN REFUSE.                                   │
		// └───────────────────────────────────────────────────────────────────────────────────────┘
		//
		// Opening the dialog re-walked `images/` for the *list* and not for the `remote.json`
		// records the *add* needs — those were read once, by `open()`. A referenced map that arrived
		// afterwards (another tab, a synced folder: exactly what ADR-0023 invites) was therefore
		// listed by the fresh walk and refused by the stale one, through a path nothing asserted.
		//
		// The other half this reaches: `#storedImageSize`'s `remote.json` fallback, and the
		// `{ address }` spread that keeps `target.source.id` resolvable for a referenced map.
		await emptyProject(page, 'Amsterdam 1625', 'amsterdam-1625');
		await expect(page.getByTestId('no-historical-maps')).toBeVisible();

		await writeStoredFile(
			page,
			'images/florida-from-another-tab/remote.json',
			remoteRecord('https://images.test/iiif/florida', 'Chart of the Florida coast')
		);

		const dialog = await openAddHistoricalMap(page);
		const offered = dialog.getByTestId('workspace-map');
		await expect(offered).toHaveCount(1);
		await expect(offered).toContainText('Chart of the Florida coast');
		await offered.click();

		await expect(page.getByTestId('layer-row')).toHaveCount(1);
		await waitForStoredLayers(page, 1, 'amsterdam-1625');
		await expect(page.getByTestId('add-from-workspace-error')).toHaveCount(0);

		// The Alignment was written over the sheet the `remote.json` describes — which is what says
		// the size came off that record rather than off an `info.json` that does not exist.
		const written = await storedAlignment(page, 'florida-from-another-tab');
		expect(written).not.toBeNull();
		expect(maskPointsAttribute(written!)).toBe('0,0 800,0 800,600 0,600');
		// And its `target.source.id` is the Library's service, not the ADR-0004 placeholder: that is
		// what makes a referenced Layer resolvable by Allmaps and drawable at all.
		expect(JSON.parse(written!).target.source.id).toContain('images.test');
	});

	test('refuses one whose record cannot be read, in words, with the dialog still open', async ({
		page
	}) => {
		// The refusal `addWorkspaceMap`'s own comment calls load-bearing — "refused in words rather
		// than added with a Resource Mask over nothing" — and nothing asserted it.
		//
		// A damaged `remote.json` is the reachable state: the reclaim list deliberately still lists
		// such a map, because a map nothing can read is one a user most needs to be able to delete,
		// so it is offered here and there is no size to place an Alignment over.
		await emptyProject(page, 'Amsterdam 1625', 'amsterdam-1625');

		await writeStoredFile(page, 'images/damaged-record/remote.json', '{ not json at all');

		const dialog = await openAddHistoricalMap(page);
		const offered = dialog.getByTestId('workspace-map');
		await expect(offered).toHaveCount(1);
		await offered.click();

		const refusal = dialog.getByTestId('add-from-workspace-error');
		await expect(refusal).toBeVisible();
		await expect(refusal).toContainText('images/damaged-record/');
		// The dialog stays up: a refusal whose dialog vanished with it is a refusal nobody read.
		expect(await addHistoricalMapIsOpen(page)).toBe(true);
		// And nothing was written — no Layer, and no Alignment over a sheet of unknown size.
		await expect(page.getByTestId('layer-row')).toHaveCount(0);
		expect(await storedAlignment(page, 'damaged-record')).toBeNull();
	});
});

test.describe('the stack while a Historical Map is being prepared', () => {
	test('does not say the Project has no Layers over a Layer that is being prepared', async ({
		page
	}) => {
		// `LayerList`'s empty state is `layers.length === 0 && !preparing`, and without the second
		// half "No Layers yet. Press Add a Historical Map…" renders directly above the card of the
		// map the user is watching being prepared.
		await emptyProject(page, 'Amsterdam 1625', 'amsterdam-1625');
		await pickHistoricalMapFile(page, {
			name: 'la-floride.png',
			mimeType: 'image/png',
			// Big enough that the preparation is a state to look at rather than a frame — the same
			// fixture `editor-image-ingest.e2e.ts` uses for its own progress assertions.
			buffer: gradientPng(2600, 2600)
		});

		await expect(preparingCard(page)).toBeVisible();
		await expect(page.getByTestId('no-layers')).toHaveCount(0);
		// The Historical Map empty state beside it is the same rule and already had its guard.
		await expect(page.getByTestId('no-historical-maps')).toHaveCount(0);

		await page.getByRole('button', { name: 'Cancel preparing la-floride.png' }).click();
		// And it comes back when there is genuinely nothing, so the guard hid nothing permanently.
		await expect(page.getByTestId('no-layers')).toBeVisible();
	});
});
