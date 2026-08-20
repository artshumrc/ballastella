import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { seedMapLayer } from './support/project-screen';
import { openLayerRow } from './support/layers';
import { recordSaveStates } from './support/saved';
import {
	closeWorkspaceSettings,
	createWorkspace,
	expectWorkspaceNamed,
	openWorkspaceMenu,
	openWorkspaceSettings,
	switchToWorkspace,
	workspaceButton
} from './support/workspace';

/**
 * Browser-managed storage as a place that holds **several named Workspaces** (ticket 12, ADR-0024).
 *
 * SPEC's Seam 2: the running app in a real browser against real OPFS. What this file is about is the
 * thing `packages/core` cannot see — that the Workspace you are in is on screen, that moving between
 * them is one gesture, and above all **which directory the bytes land in when you move**. The store
 * layer's own containment is asserted in `opfs-workspaces.browser.test.ts` and in the shared adapter
 * suite, which a named OPFS Workspace passes unmodified.
 *
 * ⚠ Every claim about where work went is a claim about **files**, read out of OPFS behind the app's
 * back. Not the save indicator: its sequence is `saved → unsaved → saving → saved`, so "Saved" is
 * also what it says before a save begins — which is precisely the ticket-12 bug `WorkspaceStorage`'s
 * class comment records, the indicator reading "Saved" while the bytes went to the Workspace the
 * user had left.
 */

const HUB = './';
const PROJECT = 'amsterdam-1625';

// Every spec in this suite is behind the default-deny network fence, and opening a Project screen
// draws a Base Map from an archive on somebody else's host. Routed to the committed fixture for the
// whole file, on the `context` rather than the `page`, so a request that has been through a service
// worker is covered too.
test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

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

/** One file's text out of a **named** Workspace, or `null`. Retried, like every Workspace read. */
async function readInWorkspace(
	page: Page,
	workspace: string,
	path: string
): Promise<string | null> {
	return page.evaluate(
		async ([workspace, path]) => {
			const segments = path.split('/');
			const name = segments.pop() as string;
			try {
				let directory = await (
					await navigator.storage.getDirectory()
				).getDirectoryHandle(workspace);
				for (const segment of segments) directory = await directory.getDirectoryHandle(segment);
				return await (await (await directory.getFileHandle(name)).getFile()).text();
			} catch {
				return null;
			}
		},
		[workspace, path] as const
	);
}

/**
 * Stop the autosave debounce from firing, so a queued write stays queued.
 *
 * ADR-0017 rule 2 debounces `project.json` by 400 ms, and `Autosave.queue` schedules that with a
 * bare `setTimeout(…, 400)`. Swallowing exactly that delay leaves the bytes pending indefinitely —
 * which is the state "switching Workspaces with work in flight" is *about*, and the only way to
 * assert the flush rather than to race it. Nothing else is touched: every other timer runs, and a
 * `clearTimeout(0)` is a no-op, so `Autosave.flush` still finds and drains the pending bytes.
 *
 * The page is reloaded between tests, so there is nothing to restore.
 */
async function holdTheDebounce(page: Page): Promise<void> {
	await page.evaluate(() => {
		const real = window.setTimeout.bind(window);
		window.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) =>
			ms === 400 ? 0 : real(handler, ms, ...rest)) as typeof window.setTimeout;
	});
}

/** One Layer's opacity as `project.json` holds it, in a named Workspace. */
async function storedOpacity(page: Page, workspace: string): Promise<number | null> {
	const text = await readInWorkspace(page, workspace, `${PROJECT}/project.json`);
	if (text === null) return null;
	const layers = (JSON.parse(text) as { layers?: { opacity?: number }[] }).layers ?? [];
	return layers[0]?.opacity ?? null;
}

const createProject = async (page: Page, name: string) => {
	await page.getByRole('button', { name: 'New Project' }).click();
	await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill(name);
	await page.getByRole('button', { name: 'Create Project' }).click();
	await expect(page.getByRole('link', { name })).toBeVisible();
};

test.describe('the Workspace on the bar', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(HUB);
		await emptyBrowserStorage(page);
		await page.reload();
	});

	test('asks nothing about where work is stored on a first visit', async ({ page }) => {
		// ADR-0001's own principle is that a folder Workspace is a capability upgrade and **never a
		// gate**, and the hub asked the question anyway — of everyone, including the majority of
		// browsers that have no picker to answer it with. Browser storage is the silent default now.
		await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

		// `toBeHidden` rather than `toHaveCount(0)`: the settings dialog is in the DOM from the first
		// frame — a `<dialog>` has to exist before `showModal()` can be called on it — so the question
		// is whether any of this is *on screen*, which is the question the criterion asks.
		await expect(page.getByText('Where your work lives')).toBeHidden();
		await expect(page.getByTestId('settings-choose-folder')).toBeHidden();
		await expect(page.getByTestId('install-offer')).toBeHidden();
	});

	test('names the Workspace on the hub and on the Project screen', async ({ page }) => {
		// SPEC story 88, and it must be *every* screen: from ticket 14 a user can be inside a throwaway
		// Review Workspace, and a control that says which one you are in is worth nothing on the screens
		// it is missing from.
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);

		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');

		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
	});

	test('creates a second Workspace, finds it empty, and finds the first one again', async ({
		page
	}) => {
		// The demonstration the ticket asks for, end to end.
		await createProject(page, 'Amsterdam 1625');

		await createWorkspace(page, 'Marking 2026');

		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);
		await expect(page.getByText('No Projects yet')).toBeVisible();

		await createProject(page, 'Boston 1775');
		await switchToWorkspace(page, DEFAULT_WORKSPACE);

		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Boston 1775' })).toHaveCount(0);
	});

	test('keeps the two Workspaces’ Projects in distinct OPFS directories', async ({ page }) => {
		// The containment ADR-0024 needs, asserted on files rather than on the list: without it a
		// Review Workspace would be a subdirectory *of* the user's own — invisible in the Project list,
		// counted in its size, and swept into its backup.
		await createProject(page, 'Amsterdam 1625');
		await createWorkspace(page, 'Marking 2026');
		await createProject(page, 'Boston 1775');

		expect(await everyPathInBrowserStorage(page)).toEqual(
			[
				`${DEFAULT_WORKSPACE}/amsterdam-1625/project.json`,
				'Marking 2026/boston-1775/project.json'
			].sort()
		);
	});

	test('remembers which Workspace was open across a reload', async ({ page }) => {
		await createWorkspace(page, 'Marking 2026');
		await createProject(page, 'Boston 1775');

		await page.reload();

		await expectWorkspaceNamed(page, 'Marking 2026');
		await expect(page.getByRole('link', { name: 'Boston 1775' })).toBeVisible();
	});

	test('announces a switch and a creation, which a mutating button label does not', async ({
		page
	}) => {
		// SPEC stories 111 and 112. Switching changes almost everything on screen; the only visible
		// signal is the switcher button's own label, and a control's accessible name changing is not
		// something a screen reader reports. Without this a scholar using one moves between Workspaces,
		// hears silence, and is looking at somebody else's Project list.
		const announced = page.getByTestId('workspace-announcement');

		await createWorkspace(page, 'Marking 2026');
		await expect(announced).toHaveText('Created the Workspace “Marking 2026” and switched to it.');

		await switchToWorkspace(page, DEFAULT_WORKSPACE);
		await expect(announced).toHaveText(`Switched to the Workspace “${DEFAULT_WORKSPACE}”.`);
	});

	test('announces the name a Workspace really got, not the one that was typed', async ({
		page
	}) => {
		// The one announcement that is wrong exactly when it matters: a second "Marking 2026" is
		// created as "Marking 2026 (2)", and a reader told otherwise is looking for the wrong thing in
		// the switcher.
		await createWorkspace(page, 'Marking 2026');
		await switchToWorkspace(page, DEFAULT_WORKSPACE);

		await openWorkspaceMenu(page);
		await page.getByTestId('new-workspace').click();
		await page.getByTestId('new-workspace-name').fill('Marking 2026');
		await page.getByTestId('create-workspace').click();

		await expect(page.getByTestId('workspace-announcement')).toHaveText(
			'Created the Workspace “Marking 2026 (2)” and switched to it.'
		);
		await expectWorkspaceNamed(page, 'Marking 2026 (2)');
	});

	test('gives focus back to the switcher when the inline form goes, not to the body', async ({
		page
	}) => {
		// The form unmounts with the pressed button still focused, so without a hand-back focus falls to
		// `<body>` — a keyboard user is returned to the top of the document with no idea whether
		// anything happened (WCAG 2.4.3).
		await openWorkspaceMenu(page);
		await page.getByTestId('new-workspace').click();
		await page.getByTestId('new-workspace-name').fill('Marking 2026');
		await page.getByTestId('create-workspace').click();
		await expectWorkspaceNamed(page, 'Marking 2026');
		await expect(workspaceButton(page)).toBeFocused();

		// And on the two ways out that create nothing.
		for (const dismiss of [
			async () => page.getByRole('button', { name: 'Cancel' }).click(),
			async () => page.keyboard.press('Escape')
		]) {
			await openWorkspaceMenu(page);
			await page.getByTestId('new-workspace').click();
			await expect(page.getByTestId('new-workspace-name')).toBeFocused();
			await dismiss();
			await expect(page.getByTestId('new-workspace-name')).toHaveCount(0);
			await expect(workspaceButton(page)).toBeFocused();
		}
	});

	test('is reachable and operable from the keyboard alone', async ({ page }) => {
		await workspaceButton(page).focus();
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('workspace-switcher-menu')).toBeVisible();

		// Escape dismisses the popover natively — the reason `MenuPopover` is mandated over a
		// `<details>` or CSS-`:focus` dropdown (ADR-0016).
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('workspace-switcher-menu')).toBeHidden();

		await workspaceButton(page).focus();
		await page.keyboard.press('Enter');
		await page.getByTestId('new-workspace').focus();
		await page.keyboard.press('Enter');
		await page.getByTestId('new-workspace-name').fill('Typed 2026');
		await page.keyboard.press('Enter');

		await expectWorkspaceNamed(page, 'Typed 2026');
	});
});

test.describe('switching Workspaces with work in flight', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(HUB);
		await emptyBrowserStorage(page);
		await page.reload();
	});

	test('flushes the pending write to the Workspace being left, and writes nothing to the one entered', async ({
		page
	}) => {
		// ┌─────────────────────────────────────────────────────────────────────────────────────┐
		// │ THE FAILURE THIS EXISTS FOR, AND WHY IT IS ASSERTED ON BYTES.                        │
		// └─────────────────────────────────────────────────────────────────────────────────────┘
		//
		// An `EditorSession` holds one `Autosave` bound to one store, and `project.json` is written on
		// a 400 ms debounce (ADR-0017 rule 2). Repoint that store while a write is queued and the bytes
		// a scholar typed into one Workspace land in another — with the indicator reading "Saved",
		// because it is reporting the *autosave's* state and not which directory it wrote to. So the
		// swap is a flush, a teardown, and a new session, in that order, and the claim here is about
		// which files exist afterwards.
		//
		// ⚠ **The debounce is held open rather than raced, and the edit is one that has no
		// commit-on-blur.** The first cut of this typed a Project name and switched Workspaces as fast as
		// Playwright can, on the theory that 400 ms is a long time. The mandated mutation check disproved
		// it twice over: with `leaving.flush()` deleted the test still passed, first because the debounce
		// had already fired on its own, and then — with the timer swallowed — because the Project name
		// field commits on `blur`, and closing the dialog blurs it. Both times the assertion was true and
		// about something else. A dragged opacity slider is the honest specimen: `oninput` queues and
		// only `onchange` commits, so dispatching `input` alone leaves a write that nothing but the flush
		// can land.
		await createProject(page, 'Amsterdam 1625');
		await createWorkspace(page, 'Marking 2026');
		await switchToWorkspace(page, DEFAULT_WORKSPACE);
		await seedMapLayer(page, 'blaeu', 'Blaeu sheet', PROJECT);

		await page.goto(`${HUB}?p=${PROJECT}`);
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		const states = await recordSaveStates(page);
		await holdTheDebounce(page);

		// The slider is inside the open card since the Layers revision.
		const row = await openLayerRow(page);

		// `input` without `change`: the drag is under way and the pointer has not been released.
		await row.getByTestId('layer-opacity').evaluate((node) => {
			(node as HTMLInputElement).value = '0.5';
			node.dispatchEvent(new Event('input', { bubbles: true }));
		});
		await expect(page.getByTestId('layer-opacity-value')).toHaveText('50%');

		// A write really is queued, and — because its timer was swallowed — it cannot land by itself.
		// Recorded with a `MutationObserver` rather than polled: `unsaved` can be over in one frame.
		await expect.poll(async () => await states()).toContain('unsaved');
		expect(
			await storedOpacity(page, DEFAULT_WORKSPACE),
			'the debounce should still be holding these bytes'
		).toBe(1);

		await switchToWorkspace(page, 'Marking 2026');

		// The dragged value is in the Workspace it was dragged in, and it got there through the flush.
		await expect.poll(async () => storedOpacity(page, DEFAULT_WORKSPACE)).toBe(0.5);

		// And the Workspace that was entered holds nothing at all. Not "holds the old name" — the
		// Project does not exist there, so a stray write would create a directory that never had one.
		expect(await everyPathInBrowserStorage(page)).toEqual([
			`${DEFAULT_WORKSPACE}/amsterdam-1625/project.json`
		]);
	});
});

test.describe('Workspace settings', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(HUB);
		await emptyBrowserStorage(page);
		await page.reload();
	});

	test('opens as a modal from the bar, closes on Escape, and restores focus', async ({ page }) => {
		// ADR-0016 mandates `<dialog>` + `showModal()`, which is what brings the focus trap, Escape,
		// and focus restoration with it — none of which the checkbox-hack modal has.
		await openWorkspaceSettings(page);

		const dialog = page.getByRole('dialog', { name: 'Workspace settings' });
		expect(await dialog.evaluate((node) => (node as HTMLDialogElement).matches(':modal'))).toBe(
			true
		);

		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(workspaceButton(page)).toBeFocused();
	});

	test('carries the folder offer, the install offer, and what the browser said about keeping storage', async ({
		page
	}) => {
		await openWorkspaceSettings(page);
		const dialog = page.getByRole('dialog', { name: 'Workspace settings' });

		await expect(dialog.getByTestId('settings-workspace-name')).toHaveText(DEFAULT_WORKSPACE);
		await expect(dialog.getByTestId('install-offer')).toBeVisible();

		// `navigator.storage.persist()` is called nowhere before this ticket, so OPFS data was
		// evictable under disk pressure (ADR-0024). What the browser answers is its own business —
		// Chromium decides on heuristics — so what is asserted is that an answer arrives and is
		// **reported**, in one of the three honest forms, rather than being swallowed.
		await expect
			.poll(async () =>
				(
					await Promise.all(
						['persistence-granted', 'persistence-refused', 'persistence-unsupported'].map((id) =>
							dialog.getByTestId(id).count()
						)
					)
				).reduce((sum, count) => sum + count, 0)
			)
			.toBe(1);

		await closeWorkspaceSettings(page);
	});

	test('the folder choice is here rather than on the hub, and still needs a real gesture', async ({
		page
	}) => {
		// The offer moved; it did not go. Chromium has `showDirectoryPicker`, so the control is present
		// — clicking it would open an operating-system dialog, which is `editor-folder-workspace.e2e.ts`'s
		// subject with the picker stubbed. What is asserted here is only that it is reachable from
		// settings and nowhere else.
		await expect(page.getByTestId('settings-choose-folder')).toBeHidden();

		await openWorkspaceSettings(page);

		await expect(page.getByTestId('settings-choose-folder')).toBeVisible();
	});
});

test.describe('deleting a Workspace', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(HUB);
		await emptyBrowserStorage(page);
		await page.reload();
	});

	test('confirms first, naming the Workspace and its size, and then removes it entirely', async ({
		page
	}) => {
		await createWorkspace(page, 'Marking 2026');
		await createProject(page, 'Boston 1775');
		await switchToWorkspace(page, DEFAULT_WORKSPACE);

		await openWorkspaceSettings(page);
		await page.getByTestId('delete-workspace').click();

		const confirm = page.getByRole('dialog', { name: 'Delete this Workspace?' });
		await expect(confirm).toBeVisible();
		await expect(confirm).toContainText('Marking 2026');
		// The size is what the user is agreeing to lose, so it is named (ADR-0016).
		// `describeBytes` says "N bytes" below a kilobyte, which one `project.json` is. The `\s+` is the
		// markup's own line break between the count and the noun, not a wildcard for a missing number.
		await expect(page.getByTestId('delete-workspace-size')).toContainText(
			/It holds 1\s+file, \d+ bytes\./
		);

		await page.getByTestId('confirm-delete-workspace').click();

		await expect(page.getByTestId('workspace-delete-outcome')).toContainText('Marking 2026');
		expect(await everyPathInBrowserStorage(page)).toEqual([]);
	});

	/**
	 * ⚠ **The record has to go with the Workspace, and it was swept by nothing** (ticket 21, review 2).
	 *
	 * `#removeWorkspace` already discards the deleted Workspace's write-ahead journal, with the reason
	 * written on the spot: entries that outlive their Workspace are "put back into somebody else's
	 * work under a name they happened to reuse". A `ballastella.deleted.` key has the same shape and
	 * the same reuse hazard, and its standing instruction is **destructive** rather than additive — so
	 * a Workspace called "Marking 2026" made next year would inherit an order to delete a folder name
	 * inside it.
	 */
	test('takes the Workspace’s unfinished deletions with it, not only its journal', async ({
		page
	}) => {
		await createWorkspace(page, 'Marking 2026');
		await createProject(page, 'Boston 1775');
		await switchToWorkspace(page, DEFAULT_WORKSPACE);
		// Exactly what an interrupted deletion in "Marking 2026" leaves behind.
		await page.evaluate(() => {
			const workspace = encodeURIComponent('opfs:Marking 2026');
			localStorage.setItem(
				`ballastella.deleted.${workspace}/${encodeURIComponent('boston-1775')}`,
				JSON.stringify({ formatVersion: 1, at: new Date().toISOString(), was: null })
			);
		});

		await openWorkspaceSettings(page);
		await page.getByTestId('delete-workspace').click();
		await page.getByTestId('confirm-delete-workspace').click();
		await expect(page.getByTestId('workspace-delete-outcome')).toContainText('Marking 2026');

		expect(
			await page.evaluate(() =>
				Object.keys(localStorage).filter((key) => key.startsWith('ballastella.deleted.'))
			)
		).toEqual([]);
	});

	/**
	 * ⚠ **And a record for a Workspace that is already gone has to be *visible*, like the journal keys
	 * beside it in the same 5 MB** (ticket 21, review 2). The orphan report walked
	 * `ballastella.journal.` only, so a deletion record naming a Workspace this browser will never
	 * open again could never be seen or discarded from settings — while the additive keys next to it
	 * could.
	 */
	test('reports and discards an unfinished deletion left by a Workspace that is gone', async ({
		page
	}) => {
		await page.evaluate(() => {
			const workspace = encodeURIComponent('opfs:A Workspace nobody has any more');
			localStorage.setItem(
				`ballastella.deleted.${workspace}/${encodeURIComponent('boston-1775')}`,
				JSON.stringify({ formatVersion: 1, at: new Date().toISOString(), was: null })
			);
		});
		await page.reload();

		await openWorkspaceSettings(page);

		await expect(page.getByTestId('orphaned-journals')).toContainText(
			'A Workspace nobody has any more'
		);
		await page.getByTestId('discard-orphaned-journal').click();

		// ⚠ **What went is an unfinished deletion, and the sentence used to call it an unsaved change**
		// (ticket 21, round 4). Round 2 added the deletion records to this button and *summed* their
		// count into the journal's, so this Workspace — which holds exactly one deletion note and no
		// edits at all — reported "Threw away 1 unsaved change": false in both nouns, and silent about
		// the one of the two that carries a standing instruction to delete a Project.
		await expect(page.getByTestId('workspace-delete-outcome')).toContainText(
			'Threw away 1 unfinished deletion'
		);
		await expect(page.getByTestId('workspace-delete-outcome')).not.toContainText('unsaved');
	});

	/**
	 * The other shape of the same sentence, which nothing exercised: **both** kinds at once, and both
	 * plural. The join and the two plural arms are three separate ways to produce a sentence that is
	 * wrong about what the user just threw away, and the singular-deletion case above reaches none of
	 * them.
	 */
	test('names both kinds when an absent Workspace held edits and deletions', async ({ page }) => {
		await page.evaluate(() => {
			const workspace = encodeURIComponent('opfs:A Workspace nobody has any more');
			for (const directory of ['boston-1775', 'amsterdam-1625']) {
				localStorage.setItem(
					`ballastella.deleted.${workspace}/${encodeURIComponent(directory)}`,
					JSON.stringify({ formatVersion: 1, at: new Date().toISOString(), was: null })
				);
			}
			for (const path of ['boston-1775/project.json', 'boston-1775/annotations/one.geojson']) {
				localStorage.setItem(
					`ballastella.journal.${workspace}/${encodeURIComponent(path)}`,
					JSON.stringify({ formatVersion: 1, at: new Date().toISOString(), bytes: btoa('{}') })
				);
			}
		});
		await page.reload();

		await openWorkspaceSettings(page);
		await page.getByTestId('discard-orphaned-journal').click();

		await expect(page.getByTestId('workspace-delete-outcome')).toContainText(
			'Threw away 2 unsaved changes and 2 unfinished deletions'
		);

		await expect(page.getByTestId('orphaned-journals')).toHaveCount(0);
		expect(
			await page.evaluate(() =>
				Object.keys(localStorage).filter((key) => key.startsWith('ballastella.deleted.'))
			)
		).toEqual([]);
	});

	test('keeps the Workspace when the confirmation is declined', async ({ page }) => {
		await createWorkspace(page, 'Marking 2026');
		await createProject(page, 'Boston 1775');
		await switchToWorkspace(page, DEFAULT_WORKSPACE);

		await openWorkspaceSettings(page);
		await page.getByTestId('delete-workspace').click();
		await page.getByRole('button', { name: 'Keep it' }).click();

		expect(await readInWorkspace(page, 'Marking 2026', 'boston-1775/project.json')).not.toBeNull();
	});

	test('never offers the Workspace you are inside', async ({ page }) => {
		// Deleting it out from under a live `EditorSession` leaves an `Autosave` whose next flush
		// recreates the directory — the store's resolver creates what is not there — so the user would
		// watch their Workspace come back holding one file.
		await createWorkspace(page, 'Marking 2026');

		await openWorkspaceSettings(page);

		await expect(page.getByTestId('delete-workspace')).toHaveCount(1);
		await expect(page.getByTestId('delete-workspace')).toContainText(DEFAULT_WORKSPACE);
		await expect(page.getByTestId('delete-workspace')).not.toContainText('Marking 2026');
	});

	test('lists no Workspace to delete when there is only one', async ({ page }) => {
		await openWorkspaceSettings(page);

		await expect(page.getByTestId('no-other-workspaces')).toBeVisible();
		await expect(page.getByTestId('delete-workspace')).toHaveCount(0);
	});
});

test.describe('an unreachable Workspace', () => {
	test('is surfaced on the hub rather than hidden in settings', async ({ page }) => {
		// ADR-0008: a Workspace that cannot be reached is a normal state with a recovery, and it must
		// never fall back to browser storage without saying so — a Workspace that quietly became
		// browser storage looks exactly like the tool having lost the user's folder. So the recovery
		// deliberately did **not** move into settings with the rest of the storage question, and it is
		// on the hub, which is the screen it was previously reachable from.
		//
		// Injected at the browser API rather than through a hook in the app: the app cannot tell it is
		// being lied to, which is the point. `editor-folder-workspace.e2e.ts` reaches the same state by
		// really deleting a real folder.
		await page.addInitScript(() => {
			navigator.storage.getDirectory = () =>
				Promise.reject(new DOMException('The Workspace could not be found', 'NotFoundError'));
		});
		await page.goto(HUB);

		// **Exactly one** alert, which is itself the assertion: the hub used to carry a second one of its
		// own, saying the same thing with a recovery that only works for browser storage.
		const alert = page.getByRole('alert').filter({ hasText: 'Workspace not reachable' });
		await expect(alert).toHaveCount(1);
		await expect(alert).toContainText('Nothing has been lost');
		// The hub is still the hub; SvelteKit's error boundary would have replaced it.
		await expect(page.getByRole('heading', { level: 1, name: 'Ballastella Editor' })).toBeVisible();
	});
});
