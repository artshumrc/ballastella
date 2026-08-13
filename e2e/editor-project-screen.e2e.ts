import { DEFAULT_WORKSPACE, expect, test } from './support/test.js';
import { type Page } from '@playwright/test';

import { gradientPng } from './support/alignment-workspace.js';
import {
	PROJECT_DIRECTORY,
	PROJECT_NAME,
	baseMap,
	chooseTool,
	clickAt,
	createProject,
	emptyWorkspace,
	readProjectFile
} from './support/annotations.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { addHistoricalMapFromFile } from './support/historical-maps.js';
import { alignFromLayer, openLayerRow } from './support/layers.js';
import { openProjectSettings } from './support/project-screen.js';

/**
 * Ticket 04: the Project screen replaces the Project page.
 *
 * SPEC Seam 2 — the running app in a real browser. Everything here is a claim that can only be made
 * against a laid-out page with a live MapLibre context and real OPFS behind it: which controls are
 * on screen, which are *not*, what has focus after a dialog closes, and how tall the map is.
 *
 * The Project name, its folder, `emptyWorkspace`, `createProject` and `readProjectFile` all come
 * from `support/annotations.ts` rather than being declared again here — they were, with the same
 * names and the same two constants, which is the duplication ticket 17 would have inherited.
 */

declare global {
	interface Window {
		/** Every `createWritable()` this page has opened, by file name. See {@link countWrites}. */
		e2eProjectWrites?: string[];
	}
}

/** A Workspace holding one empty Project, with the hub on screen. */
async function freshWorkspace(page: Page): Promise<void> {
	await page.goto('./');
	await emptyWorkspace(page);
	await page.reload();
	await createProject(page);
	await expect(page.getByRole('link', { name: PROJECT_NAME })).toBeVisible();
}

/** The Project open, with its Base Map settled. */
async function openProject(page: Page): Promise<void> {
	await page.goto(`./?p=${PROJECT_DIRECTORY}`);
	await expect(page.getByTestId('project-name')).toHaveText(PROJECT_NAME);
	await expect(page.getByTestId('opening-view')).toHaveAttribute(
		'data-opening-view',
		/^(content|default)$/,
		{ timeout: 30_000 }
	);
}

/** Add a Historical Map from a file, and return once its Layer is in the stack. */
async function addHistoricalMap(page: Page): Promise<void> {
	await addHistoricalMapFromFile(page, {
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(280, 200)
	});
}

/** Every href the page offers a user, so "nothing links there" can be a claim rather than a hope. */
const hrefs = (page: Page) =>
	page.locator('a[href]').evaluateAll((links) => links.map((link) => link.getAttribute('href')!));

/** `project.json` exactly as it sits on disk. */
const projectFile = (page: Page) => readProjectFile(page, 'project.json');

/**
 * Count every file the page opens for writing.
 *
 * Wrapped at the browser API rather than inside the app: "one edit is one write" is a claim about
 * what reaches the disk, and an app-level counter is a claim about the app agreeing with itself.
 */
const countWrites = (page: Page) =>
	page.addInitScript(() => {
		window.e2eProjectWrites = [];
		const real = FileSystemFileHandle.prototype.createWritable;
		FileSystemFileHandle.prototype.createWritable = function (
			this: FileSystemFileHandle,
			...args: Parameters<typeof real>
		) {
			window.e2eProjectWrites?.push(this.name);
			return real.apply(this, args);
		};
	});

const projectWrites = async (page: Page): Promise<number> =>
	(await page.evaluate(() => window.e2eProjectWrites ?? [])).filter((name) =>
		name.includes('project.json')
	).length;

/**
 * The Front Page choice, on the hub (SPEC stories 25–28, ADR-0032).
 *
 * On the Workspace hub rather than inside a Project, because the Workspace is what publishes: the
 * choice decides one entry in one list on the Published Site, and the list is the Workspace's.
 */
test.describe('choosing whether a Project is on the Front Page', () => {
	test.beforeEach(async ({ context }) => {
		await routeBaseMapArchive(context);
	});

	test('takes a Project off the Front Page and puts it back, and the choice survives a reload', async ({
		page
	}) => {
		await freshWorkspace(page);
		// Per directory, like the note's `id` beside it: the hub lists every Project, so a testid that
		// is only per-row is ambiguous the moment a Workspace holds two.
		const toggle = page.getByTestId(`on-front-page-${PROJECT_DIRECTORY}`);

		// On by default, and written as *absence* — so a new Project's manifest is byte-identical to one
		// from a build that had never heard of the choice, and a Workspace in git gains no diff.
		await expect(toggle).toBeChecked();
		expect(JSON.parse(await projectFile(page))).not.toHaveProperty('onFrontPage');
		const before = JSON.parse(await projectFile(page)).updatedAt;

		await toggle.uncheck();
		await expect.poll(async () => JSON.parse(await projectFile(page)).onFrontPage).toBe(false);

		// ⚠ **`updatedAt` is untouched.** The hub is ordered by it and publishing writes the Front Page in
		// that order, so stamping here would move the row out from under the cursor that just clicked it
		// and reorder the site — which ADR-0032 leaves alone.
		expect(JSON.parse(await projectFile(page)).updatedAt).toBe(before);

		// The reload is the assertion: the control reads `project.json` rather than remembering, so what
		// comes back is what is on disk.
		await page.reload();
		await expect(toggle).not.toBeChecked();

		await toggle.check();
		await expect.poll(async () => 'onFrontPage' in JSON.parse(await projectFile(page))).toBe(false);
		await page.reload();
		await expect(toggle).toBeChecked();
		expect(JSON.parse(await projectFile(page)).updatedAt).toBe(before);
	});

	/**
	 * ⚠ **The wording, asserted rather than eyeballed** (ADR-0032, SPEC stories 26 and 27).
	 *
	 * A Project off the Front Page is still published, still in the repository, and still opened by
	 * `?p=<folder>` for anyone who knows the name. Every one of "unpublished", "private", "draft", and
	 * "hidden" invites the opposite reading, and a scholar with an embargoed archival photograph or a
	 * manuscript under a library's publication restriction will act on the reading they are given. So
	 * the four words are refused by test, and the caution is required by test, in **both** states —
	 * because the state a user is about to leave is the one they are deciding from.
	 */
	test('says the Project stays readable by anyone, and never calls it private, hidden, unpublished, or a draft', async ({
		page
	}) => {
		await freshWorkspace(page);
		const toggle = page.getByRole('checkbox', { name: `On the front page — ${PROJECT_NAME}` });
		const note = page.getByTestId(`front-page-note-${PROJECT_DIRECTORY}`);

		// The caution is the control's accessible *description*, not merely a paragraph nearby: a screen
		// reader user is given it along with the control instead of having to go looking.
		await expect(toggle).toHaveAttribute('aria-describedby', (await note.getAttribute('id')) ?? '');

		for (const state of ['on', 'off'] as const) {
			if (state === 'off') {
				await toggle.uncheck();
				await expect(note).toContainText('Not on the front page');
			}
			const words = `${await toggle.evaluate((element) => element.closest('label')!.textContent)} ${await note.textContent()}`;
			expect(words.toLowerCase(), `the wording while ${state} the front page`).toContain(
				'readable by anyone with the link'
			);
			for (const forbidden of ['unpublished', 'private', 'draft', 'hidden']) {
				expect(words.toLowerCase(), `“${forbidden}” while ${state} the front page`).not.toContain(
					forbidden
				);
			}
		}
	});
});

test.describe('the Project screen', () => {
	test.beforeEach(async ({ context }) => {
		await routeBaseMapArchive(context);
	});

	test('is a Base Map with the Layer stack beside it, and the map has the larger share', async ({
		page
	}) => {
		await freshWorkspace(page);
		await openProject(page);
		// A Layer, so the stack is a stack: `LayerList` renders its empty state rather than an `<ol>`
		// when there is nothing in it, and the claim here is about the two columns *with work in them*.
		await addHistoricalMap(page);

		const sidebar = page.getByTestId('layer-sidebar');
		const map = page.getByTestId('project-map');
		await expect(sidebar).toBeVisible();
		await expect(map).toBeVisible();
		// The stack is really in the sidebar rather than merely somewhere on the page.
		await expect(sidebar.getByRole('list', { name: 'Layers, top first' })).toHaveCount(1);
		// And the map is really a live MapLibre canvas, not a placeholder.
		await expect(map.locator('canvas.maplibregl-canvas')).toBeVisible();

		const sidebarBox = (await sidebar.boundingBox())!;
		const mapBox = (await map.boundingBox())!;
		// The ticket's own measurement of "the map gets the larger share": it is taller than the
		// sidebar is wide, and it is beside the sidebar rather than under it.
		expect(mapBox.height).toBeGreaterThan(sidebarBox.width);
		expect(mapBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width - 1);
		// And wider than the fixed column, which is what "fixed column, map takes the rest" means.
		expect(mapBox.width).toBeGreaterThan(sidebarBox.width);
	});

	test('every control on it is reachable by keyboard', async ({ page }) => {
		await freshWorkspace(page);
		await openProject(page);
		await addHistoricalMap(page);
		await page.getByTestId('add-annotation-layer').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(2);
		// **With a Layer open**, because since ticket 05 the drawing tools, the Annotation list and the
		// Layer's default style are inside an open Annotation Layer's row. Walked with the row closed
		// this test would still pass and would cover a dozen fewer controls, which is the vacuous shape
		// of green this suite keeps finding.
		await openLayerRow(page, 0);

		// Every visible, enabled, natively focusable control **inside `project-screen`** — asked of the
		// DOM rather than listed here, so a control added to the screen later is covered without anybody
		// remembering to add it.
		//
		// **The settings dialog and the Project menu are deliberately outside that subtree** and are
		// therefore outside this walk: both render into the top layer, and a modal dialog's whole point
		// is that the rest of the page is inert while it is up, so one tab order cannot cover both. They
		// have keyboard tests of their own — the dialog's Escape-and-focus test below, and the menu's
		// Escape test above, which both drive it from the keyboard.
		const wanted = await page.evaluate(() => {
			const inside = document.querySelector('[data-testid="project-screen"]')!;
			return [...inside.querySelectorAll('a[href], button, input, select, textarea')]
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
		expect(wanted.length).toBeGreaterThan(10);

		// Tab from the top of the document. Capped generously: the walk has to pass through the
		// navigation bar and the browser's own chrome stops as well.
		await page.evaluate(() => document.body.focus());
		const reached = new Set<string>();
		for (let step = 0; step < wanted.length * 3 + 20; step++) {
			await page.keyboard.press('Tab');
			const seen = await page.evaluate(
				() => document.activeElement?.getAttribute('data-e2e-control') ?? null
			);
			if (seen !== null) reached.add(seen);
			if (reached.size === wanted.length) break;
		}

		expect([...wanted].filter((id) => !reached.has(id))).toEqual([]);
	});

	test('Escape that closes the Project menu does not abandon a part-drawn shape', async ({
		page
	}) => {
		// Escape dismisses a popover natively **and keeps propagating**, so the window handler that
		// abandons a drawing gesture hears the keypress that only closed the menu. The dialog already
		// had a guard for exactly this; the menu is new in this ticket and did not.
		await freshWorkspace(page);
		await openProject(page);
		await page.getByTestId('add-annotation-layer').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
		// The tools are inside the Layer that is drawn into (ticket 05).
		await openLayerRow(page);

		await chooseTool(page, 'polygon');
		await clickAt(baseMap(page), 0.4, 0.4);
		await clickAt(baseMap(page), 0.6, 0.4);
		const drawingStatus = page.getByTestId('annotation-status');
		await expect(drawingStatus).toHaveAttribute('data-drawing', 'true');

		// Open the menu and press Escape. The menu closes; the two vertices stay.
		await page.getByTestId('project-menu-button').click();
		await expect(page.getByTestId('open-project-settings')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('open-project-settings')).toBeHidden();
		await expect(drawingStatus).toHaveAttribute('data-drawing', 'true');

		// And Escape still cancels when the menu is not in the way, so the guard did not swallow it.
		await page.keyboard.press('Escape');
		await expect(drawingStatus).toHaveAttribute('data-drawing', 'false');
	});

	test('Align on a Historical Map Layer goes to /align/, and coming back reopens the Project', async ({
		page
	}) => {
		await freshWorkspace(page);
		await openProject(page);
		await addHistoricalMap(page);

		const row = page.getByTestId('layer-row').first();
		await expect(row).toHaveAttribute('data-layer-kind', 'map');
		await alignFromLayer(page, row);

		await expect(page).toHaveURL(/\/align\/?\?p=amsterdam-1625&layer=[^&]+/);
		await expect(page.getByRole('heading', { name: 'Align', exact: true })).toBeVisible();

		await page.getByTestId('back-to-project').click();

		await expect(page).toHaveURL(/\?p=amsterdam-1625$/);
		await expect(page.getByTestId('project-name')).toHaveText(PROJECT_NAME);
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
	});
});

test.describe('the Layer stack and the Base Map are not pages of their own', () => {
	test.beforeEach(async ({ context }) => {
		await routeBaseMapArchive(context);
	});

	test('/layers/ and /base-map/ answer no page at all', async ({ page }) => {
		// Not "renders an empty screen" — *absent*. A prerendered SvelteKit route is a file in the
		// build, so a route that still exists would answer 200 with the app inside it, and a page that
		// merely looked empty is exactly what a half-done deletion produces.
		//
		// **Both spellings of each, and the bare one matters most.** `trailingSlash: 'never'` makes the
		// build emit flat files — `base-map.html`, never `base-map/index.html` — so asking only for
		// `./base-map/index.html` would 404 against a build where the route was still there. `./layers`
		// and `./base-map` are the canonical paths: what `prerendered` carries, what the service worker
		// precaches, and what a bookmark holds.
		for (const path of ['./layers', './layers/', './base-map', './base-map/index.html']) {
			const response = await page.goto(path);
			expect(response?.status(), `${path} still answers a page`).toBe(404);
		}
	});

	test('nothing in the app links to /layers/, /base-map/ or /image-pane/', async ({ page }) => {
		await freshWorkspace(page);
		const gone = /(^|\/)(layers|base-map|image-pane)(\/|$|\?)/;

		// The hub.
		expect((await hrefs(page)).filter((href) => gone.test(href))).toEqual([]);

		// The Project.
		await openProject(page);
		await addHistoricalMap(page);
		expect((await hrefs(page)).filter((href) => gone.test(href))).toEqual([]);

		// And the alignment route.
		await alignFromLayer(page);
		await expect(page.getByRole('heading', { name: 'Align', exact: true })).toBeVisible();
		expect((await hrefs(page)).filter((href) => gone.test(href))).toEqual([]);
	});

	test('/image-pane/ is retained and still renders the fixture pane', async ({ page }) => {
		// Kept deliberately: it is the only coverage that exercises the synthetic projection
		// independently of the storage layer, and deleting the route deletes that.
		const response = await page.goto('./image-pane/');
		expect(response?.status()).toBe(200);
		await expect(page.getByTestId('image-pane')).toBeVisible({ timeout: 30_000 });
	});
});

test.describe('the navigation bar', () => {
	test.beforeEach(async ({ context }) => {
		await routeBaseMapArchive(context);
	});

	test('is on the hub, the Project and the alignment route, carrying exactly its things', async ({
		page
	}) => {
		const bar = page.getByTestId('navigation-bar');
		const assertBar = async (where: string) => {
			await expect(bar, `no navigation bar on ${where}`).toHaveCount(1);
			// Which Workspace, the theme, undo, and whether the work is kept.
			await expect(bar.getByTestId('workspace-identity')).toHaveCount(1);
			await expect(bar.getByTestId('theme-toggle')).toHaveCount(1);
			await expect(bar.getByTestId('undo-slot')).toHaveCount(1);
			await expect(bar.getByTestId('save-slot')).toHaveCount(1);
			// And nothing about *a Project*: the name, the Base Map switcher and the settings menu belong
			// to the screen that has a Project. The screen's own name and way back are a different thing —
			// generic, set by whichever route is on, and asserted below.
			await expect(bar.getByTestId('project-name')).toHaveCount(0);
			await expect(bar.getByTestId('project-menu-button')).toHaveCount(0);
			await expect(bar.getByRole('combobox', { name: 'Base Map' })).toHaveCount(0);
		};

		await freshWorkspace(page);
		await assertBar('the hub');
		// Browser storage is the silent default, and the bar names the **Workspace** rather than the
		// backing (ticket 12): with several named Workspaces on one backing, "Browser storage" would
		// identify nothing, and from ticket 14 a throwaway Review Workspace is browser-backed too.
		await expect(bar.getByTestId('workspace-identity')).toContainText(DEFAULT_WORKSPACE);

		await openProject(page);
		await assertBar('the Project screen');
		await addHistoricalMap(page);

		await alignFromLayer(page);
		await expect(page.getByRole('heading', { name: 'Align', exact: true })).toBeVisible();
		await assertBar('the alignment route');

		// The alignment route's name and its way out are **on the bar**, not in a header strip of its
		// own: that strip cost 60 pixels above two live map panes, which is the one screen with no height
		// to spare. The heading is the document's `<h1>` and the bar is before the page content, so it is
		// still the first heading a screen reader reaches.
		const chrome = bar.getByTestId('page-chrome');
		await expect(chrome.getByTestId('page-heading')).toHaveText('Align');
		await expect(chrome.getByTestId('back-to-project')).toBeVisible();
		await expect(page.locator('h1')).toHaveCount(1);

		// And it is given back on the way out, rather than following the user to a screen it is not
		// about — the failure a route-specific bar has, and the reason the slot is cleared by its holder.
		await chrome.getByTestId('back-to-project').click();
		await expect(page.getByTestId('project-screen')).toBeVisible();
		await expect(bar.getByTestId('page-chrome')).toHaveCount(0);
	});

	test('holds the app’s only theme toggle', async ({ page }) => {
		await freshWorkspace(page);
		// One in the whole document, on every screen — the toggle used to be on three routes and not
		// on the hub, which is three controls that had to agree and one place that never heard.
		await expect(page.getByRole('button', { name: /switch to .* theme/i })).toHaveCount(1);
		await openProject(page);
		await expect(page.getByRole('button', { name: /switch to .* theme/i })).toHaveCount(1);
		await page.goto('./align/?p=amsterdam-1625&layer=none');
		await expect(page.getByRole('button', { name: /switch to .* theme/i })).toHaveCount(1);
	});
});

test.describe('the theme (SPEC stories 109, 110)', () => {
	test.beforeEach(async ({ context }) => {
		await routeBaseMapArchive(context);
	});

	/** The Base Map's background paint, which is the flavour showing through. */
	const backgroundPaint = (page: Page) =>
		page.evaluate(() =>
			JSON.stringify(
				(
					window as unknown as {
						ballastellaBaseMap?: {
							getStyle(): { layers: { id: string; paint?: unknown }[] };
						};
					}
				).ballastellaBaseMap
					?.getStyle()
					.layers.find((layer) => layer.id === 'background')?.paint ?? null
			)
		);

	test('changes the interface and the Base Map flavour in one action', async ({ page }) => {
		await freshWorkspace(page);
		await openProject(page);
		await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
		await expect.poll(() => backgroundPaint(page), { timeout: 30_000 }).not.toBe('null');

		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		const light = await backgroundPaint(page);

		await page.getByTestId('theme-toggle').click();

		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await expect.poll(() => backgroundPaint(page), { timeout: 30_000 }).not.toBe(light);
	});

	test('a chosen theme survives a reload', async ({ page }) => {
		await freshWorkspace(page);
		await page.getByTestId('theme-toggle').click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

		await page.reload();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

		// And on another screen, because the choice is the person's and not the page's.
		await openProject(page);
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	});

	test('with no theme ever chosen, the operating system moves it live', async ({ page }) => {
		// **The emulation is changed while the page is open, and there is no reload.** Reading
		// `prefers-color-scheme` once at construction — which is what this did — passes an
		// assert-at-load test perfectly and leaves a desktop that switches to dark at sunset with a
		// bright white application until the scholar reloads. A scholar mid-alignment does not reload.
		await page.emulateMedia({ colorScheme: 'light' });
		await freshWorkspace(page);
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

		await page.emulateMedia({ colorScheme: 'dark' });
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

		await page.emulateMedia({ colorScheme: 'light' });
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	});

	test('an explicit choice stops the operating system moving it', async ({ page }) => {
		// The third state's whole point: once chosen, it is *kept*, and the machine no longer wins.
		await page.emulateMedia({ colorScheme: 'light' });
		await freshWorkspace(page);
		await page.getByTestId('theme-toggle').click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

		// **The operating system has to actually move, twice.** Re-emulating the scheme the page is
		// already under fires no `change` event at all, so an assertion that only re-states the
		// starting preference passes against an implementation where the OS overrides the choice —
		// verified: with the explicit preference ignored entirely, this test still went green.
		await page.emulateMedia({ colorScheme: 'dark' });
		await expect
			.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
			.toBe(true);
		await page.emulateMedia({ colorScheme: 'light' });
		await expect
			.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
			.toBe(false);
		// A settle, because this asserts an absence: nothing must move it back.
		await page.waitForTimeout(500);
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	});
});

test.describe('what the app says when something is wrong (SPEC stories 111, 112)', () => {
	test.beforeEach(async ({ context }) => {
		await routeBaseMapArchive(context);
	});

	test('the save indicator is the only role="status" in the app, on every screen', async ({
		page,
		context
	}) => {
		// **This is a consequence of ticket 04 and not a general tidiness rule.** `SaveIndicator` owns
		// `role="status"` and is now in the root layout, so it is on screen everywhere — which turns
		// every *other* `status` role in the app into an ambiguity that did not exist before. The repo's
		// answer is one `status` per page and `aria-live="polite"` for everything else; a screen reader
		// user who has to disambiguate is the same user `getByRole('status')` cannot serve.
		await freshWorkspace(page);
		// The hub, which carries the transfer announcement.
		await expect(page.getByRole('status')).toHaveCount(1);
		await expect(page.getByRole('status')).toHaveAttribute('data-save-state');

		// The Project screen, with a Historical Map on it.
		await openProject(page);
		await addHistoricalMap(page);
		await expect(page.getByRole('status')).toHaveCount(1);

		// **Offline**, which is where the second one was: the Base Map notice. It still has to be
		// announced — it is inserted at the moment it becomes true, which is what `alert` is for and
		// what a `polite` region inserted with its own text is not.
		await context.setOffline(true);
		const notice = page.getByTestId('base-map-offline');
		await expect(notice).toBeVisible();
		await expect(notice).toHaveAttribute('role', 'alert');
		await expect(page.getByRole('status')).toHaveCount(1);
		await context.setOffline(false);

		// And the alignment route.
		await alignFromLayer(page);
		await expect(page.getByRole('heading', { name: 'Align', exact: true })).toBeVisible();
		await expect(page.getByRole('status')).toHaveCount(1);
	});

	test('a save that failed says why, in a region a screen reader is given', async ({ page }) => {
		// `SaveIndicator` says "Unsaved changes"; the *reason* — a full disk, a lapsed folder grant — is
		// a sentence beside it and outside its live region. Without a role of its own it is inserted
		// silently, so a screen-reader user is told that something went wrong and never what.
		await freshWorkspace(page);
		await openProject(page);
		await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');

		// Chromium reports OPFS quota exhaustion from `close()`. Injected at the browser API, so the
		// app cannot tell it is being lied to.
		await page.evaluate(() => {
			FileSystemWritableFileStream.prototype.close = () =>
				Promise.reject(new DOMException('Quota exceeded', 'QuotaExceededError'));
		});
		// **The Base Map switcher rather than the name field**, because only a write the app awaits
		// produces a reason at all: `chooseBaseMap` is a discrete choice and is written now, while
		// typing a name is debounced and its failure surfaces inside the autosave timer, where
		// `EditorSession.#write` is not the thing that catches it. That gap is real and is not this
		// ticket's — what is this ticket's is that the reason, once there is one, is announced.
		await page.getByRole('combobox', { name: 'Base Map' }).selectOption('physical');

		await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'unsaved');
		const reason = page.getByTestId('save-error');
		await expect(reason).toBeVisible();
		await expect(reason).not.toBeEmpty();
		// Announced, and as an `alert` rather than a second `status` — see the test above.
		await expect(reason).toHaveAttribute('role', 'alert');
	});
});

test.describe('Project settings (SPEC stories 10, 11)', () => {
	test.beforeEach(async ({ context }) => {
		await routeBaseMapArchive(context);
	});

	test('opens as a modal dialog, closes on Escape, and gives focus back', async ({ page }) => {
		await freshWorkspace(page);
		await openProject(page);

		const menu = page.getByTestId('project-menu-button');
		await menu.click();
		await page.getByTestId('open-project-settings').click();

		const dialog = page.getByRole('dialog', { name: 'Project settings' });
		await expect(dialog).toBeVisible();
		// `showModal()` and not `show()`, which is what ADR-0016 mandates and what brings the focus
		// trap and Escape with it. `:modal` is true only for a dialog opened modally, so this tells
		// the two apart — a `<dialog open>` rendered by hand would pass a visibility check.
		expect(
			await dialog.evaluate((element) => element.matches(':modal')),
			'the settings dialog was not opened with showModal()'
		).toBe(true);

		// The folder and the last-saved time, read-only, beside the one editable field.
		await expect(dialog.getByTestId('project-folder')).toHaveText(PROJECT_DIRECTORY);
		await expect(dialog.getByTestId('project-updated-at')).not.toBeEmpty();
		await expect(dialog.getByLabel('Project name')).toHaveValue(PROJECT_NAME);

		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		// Back where the user was, which is the half of ADR-0016 a hand-rolled modal always drops.
		await expect(menu).toBeFocused();
	});

	test('focusing the name field and tabbing away writes nothing', async ({ page }) => {
		// ADR-0010: merely looking at a Project must not modify a byte of it. `commitProjectName` is a
		// no-op unless a write is pending, because the write stamps a fresh `updatedAt` — and an
		// unexplained diff in a git working tree, or a sync to every other machine from a Dropbox
		// folder, is what an unconditional `onblur` costs.
		await countWrites(page);
		await freshWorkspace(page);
		await openProject(page);
		await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');

		const before = await projectFile(page);
		const writesBefore = await projectWrites(page);

		const dialog = await openProjectSettings(page);
		const field = dialog.getByLabel('Project name');
		await field.focus();
		await expect(field).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(field).not.toBeFocused();

		// And with the pointer, which is the same gesture through a different event order.
		await field.click();
		await dialog.getByRole('heading', { name: 'Project settings' }).click();
		await expect(field).not.toBeFocused();

		// An absence, so it needs a settle: past the debounce, and past the flush `pagehide` forces.
		await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
		await page.waitForTimeout(700);

		expect(await projectFile(page)).toBe(before);
		expect(await projectWrites(page), 'looking at the name field wrote project.json').toBe(
			writesBefore
		);
	});

	test('typing a name coalesces into one write, committed when the edit ends', async ({ page }) => {
		await countWrites(page);
		await freshWorkspace(page);
		await openProject(page);
		await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');

		const dialog = await openProjectSettings(page);
		const field = dialog.getByLabel('Project name');
		const writesBefore = await projectWrites(page);

		// Keystroke by keystroke, which is what coalescing is about: `pressSequentially` fires one
		// `input` per character, and an implementation that wrote on each would put eleven documents
		// on disk for one rename (ADR-0017 rule 2).
		await field.fill('');
		await field.pressSequentially('Amsterdam 1626', { delay: 20 });
		await field.blur();

		await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');
		await page.waitForTimeout(700);

		expect(JSON.parse(await projectFile(page)).name).toBe('Amsterdam 1626');
		const writes = (await projectWrites(page)) - writesBefore;
		expect(writes, `one rename wrote project.json ${writes} times`).toBeLessThanOrEqual(2);
		expect(writes).toBeGreaterThan(0);

		// And it is on screen without a reload, because the screen reads the one in-memory document.
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1626');
	});
});
