// Driving the Workspace control on the navigation bar: which Workspace you are in, moving between
// them, and what may be done to them from their own rows.
//
// One module because the bar is on every screen, and because the two-step (menu, then item) is
// exactly the kind of thing that gets copied slightly differently each time.
//
// ⚠ **There is no Workspace settings dialog and no Remote dialog** (ADR-0042). The rename dialog
// also holds Backup, Restore, the install offer, the storage warning, the journal orphans and *Move
// this Workspace into a folder…*. GitHub remains behind the one door, which {@link openTheDoor}
// reaches.

import { DEFAULT_WORKSPACE, type Download, expect, type Page } from './test.js';

/** The Workspace control on the bar. Its button carries the Workspace's name. */
export const workspaceButton = (page: Page) => page.getByTestId('workspace-switcher');

/**
 * What the bar says the current Workspace is. Visible on every screen.
 *
 * ⚠ **Asserted on the switcher button, never on the `workspace-identity` block around it.** The
 * popover is rendered *inside* that block, so `toContainText(name)` was satisfied by the menu's own
 * list of Workspaces — which meant this passed the instant the menu was open, whichever Workspace was
 * actually current. `switchToWorkspace` then returned before the switch had happened and the next
 * step read the wrong Workspace's files. The button's label is the one place that says which
 * Workspace you are *in*, so it is the only place worth asking.
 */
export async function expectWorkspaceNamed(page: Page, name: string): Promise<void> {
	await expect(workspaceButton(page)).toHaveText(name);
}

/**
 * Open the Workspace menu on the bar, if it is not already open.
 *
 * Some of what the menu opens hands it back afterwards — a rename returns to the roster it was
 * started from — so a caller that wants the menu cannot know whether pressing the button would open
 * it or be swallowed by the open one.
 */
export async function openWorkspaceMenu(page: Page): Promise<void> {
	const menu = page.getByTestId('workspace-switcher-menu');
	if (await menu.isVisible()) return;
	// The Workspace dialog is modal and sits over the bar, and several of the things it does — a
	// rename, a Backup — end by closing it. `close()` having been called is not the frame it stops
	// taking clicks on, and on a loaded machine that gap is wide enough to swallow this press.
	await expect(page.getByRole('dialog', { name: 'Rename this Workspace' })).toBeHidden();
	await workspaceButton(page).click();
	await expect(menu).toBeVisible();
}

/** Open the editing dialog for a Workspace row in the roster. */
export async function editWorkspace(page: Page, name: string): Promise<void> {
	await openWorkspaceMenu(page);
	await page.getByRole('button', { name: `Rename ${name}` }).click();
	await expect(page.getByRole('dialog', { name: 'Rename this Workspace' })).toBeVisible();
}

/** Switch to an existing named Workspace. */
export async function switchToWorkspace(page: Page, name: string): Promise<void> {
	await openWorkspaceMenu(page);
	await page.getByTestId('switch-workspace').filter({ hasText: name }).first().click();
	await expectWorkspaceNamed(page, name);
}

/**
 * Open the editing dialog for the Workspace that is **open**, whatever it is called.
 *
 * By row rather than by name: two Workspaces may share a display name — a folder and a browser one,
 * or a restored copy beside its original — and `aria-current` is the only thing that tells the open
 * one from its namesake.
 */
export async function editOpenWorkspace(page: Page): Promise<void> {
	await openWorkspaceMenu(page);
	await page
		.locator('li')
		.filter({ has: page.locator('[data-testid="switch-workspace"][aria-current="true"]') })
		.getByTestId('rename-workspace')
		.click();
	await expect(page.getByRole('dialog', { name: 'Rename this Workspace' })).toBeVisible();
}

/**
 * Take a Backup, and hand back the download.
 *
 * The dialog is left open: what the transfer says afterwards is said inside it. A caller that goes
 * on to use the bar has to {@link closeWorkspaceDialog} first, because the dialog is modal and
 * intercepts everything behind it.
 */
export async function backUpWorkspace(page: Page): Promise<Download> {
	await editOpenWorkspace(page);
	const download = page.waitForEvent('download');
	await page.getByTestId('back-up-workspace').click();
	return download;
}

/** Close the Workspace dialog, so the bar behind it can be reached again. */
export async function closeWorkspaceDialog(page: Page): Promise<void> {
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog', { name: 'Rename this Workspace' })).toBeHidden();
}

/**
 * Rename a Workspace from its own row in the roster (ADR-0042).
 *
 * The row's control opens an inline field on the bar, as the creation one does, so this is the same
 * three steps and is written once here rather than at every call.
 */
export async function renameWorkspace(page: Page, from: string, to: string): Promise<void> {
	await editWorkspace(page, from);
	await page.getByTestId('rename-workspace-name').fill(to);
	await page.getByTestId('save-workspace-name').click();
	await expect(page.getByTestId('workspace-announcement')).toContainText(to);
}

/**
 * Delete a Workspace from its own row, confirming the question that names it.
 *
 * ⚠ **Deletion is in the roster and nowhere else** (ADR-0042): a Workspace is deleted from the list
 * of Workspaces, which is where a person looking for one is looking. It used to be in Workspace
 * settings, which had no second entry point and was two menus deep.
 */
export async function deleteWorkspace(page: Page, name: string): Promise<void> {
	await openWorkspaceMenu(page);
	// A browser Workspace, whose row says "Delete". A folder row says "Take … off the list", because
	// it takes the row and leaves every file where it is — a different act with a different question.
	await page.getByRole('button', { name: `Delete ${name}` }).click();
	await expect(page.getByRole('dialog', { name: 'Delete this Workspace?' })).toBeVisible();
	await page.getByTestId('confirm-delete-workspace').click();
}

/** Make a Workspace from the bar and switch into it. */
export async function createWorkspace(page: Page, name: string): Promise<void> {
	await openWorkspaceMenu(page);
	await page.getByTestId('new-workspace').click();
	await page.getByTestId('new-workspace-name').fill(name);
	await page.getByTestId('create-workspace').click();
	await expectWorkspaceNamed(page, name);
}

/**
 * Make a Workspace in a folder the browser's picker hands back, and switch into it (ADR-0042).
 *
 * ⚠ **The caller has to have installed a picker**, because a real `showDirectoryPicker` opens an
 * operating-system dialog no automated browser can answer — `editor-folder-workspace.e2e.ts`'s
 * `installDirectoryPicker` is the one that does it, and every spec that wants a folder Workspace
 * either uses it or stubs the picker itself.
 *
 * The kind is asked at creation and only where the File System Access API is present, which is what
 * keeps a browser that has no picker from being told there are two kinds at all.
 */
export async function createFolderWorkspace(page: Page, name: string): Promise<void> {
	await openWorkspaceMenu(page);
	await page.getByTestId('new-workspace').click();
	await page.getByTestId('new-workspace-name').fill(name);
	await page.getByTestId('new-workspace-folder').check();
	await page.getByTestId('create-workspace').click();
	await expectWorkspaceNamed(page, name);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHERE THE WORK IS, READ FROM THE ONE PLACE THAT SAYS SO (ADR-0041)
//
// ⚠ **The Workspace menu's header no longer restates the repository, the credential or the Remote
// Status**, so none of the four assertions below reads it. All three were said in the eyebrow at the
// same time, and a scholar asking *is my work safe* had five candidates and no way to choose between
// them. What each fact is now read from is named on its own helper, and each is the surface a
// scholar would actually be looking at.

/** The bar's one GitHub control, which is the whole relationship behind one press (ADR-0041). */
export const doorButton = (page: Page) => page.getByTestId('connect-to-github');

/**
 * Open the door, and wait for whichever of its landings is true.
 *
 * A `<dialog>` opened with `showModal()`, so everything behind it is inert until it is closed —
 * which is why this and {@link closeTheDoor} are paired, and why the two gestures inside it
 * ({@link checkRemoteStatus}, {@link updateFromGitHub}) close it on the press rather than reporting
 * from behind it.
 */
export async function openTheDoor(page: Page): Promise<void> {
	await doorButton(page).click();
	await expect(page.getByTestId('connect-sequence')).toBeVisible();
}

export async function closeTheDoor(page: Page): Promise<void> {
	await page.getByTestId('close-connect-sequence').click();
	await expect(page.getByTestId('connect-sequence')).toBeHidden();
}

/** Do something behind the door, and close it again unless the press closed it itself. */
export async function inTheDoor(
	page: Page,
	act: () => Promise<void>,
	options: { closeAfter?: boolean } = {}
): Promise<void> {
	await openTheDoor(page);
	await act();
	if (options.closeAfter !== false) await closeTheDoor(page);
}

/**
 * Ask GitHub what it holds now, from the one place that asks.
 *
 * The door closes on the press, because the answer is the badge's: a `showModal()` dialog makes the
 * bar inert, and a check whose result is behind the dialog that asked for it is a full stop.
 */
export async function checkRemoteStatus(page: Page): Promise<void> {
	await openTheDoor(page);
	await page.getByTestId('check-remote-status').click();
	await expect(page.getByTestId('connect-sequence')).toBeHidden();
}

/** Bring the Remote's changes in, from the same place, which closes for the same reason. */
export async function updateFromGitHub(page: Page): Promise<void> {
	await openTheDoor(page);
	await page.getByTestId('update-from-github').click();
	await expect(page.getByTestId('connect-sequence')).toBeHidden();
}

/** Open the Publish dialog, which is a landing of the door rather than a control beside it. */
export async function openPublishFromTheDoor(page: Page): Promise<void> {
	await openTheDoor(page);
	await page.getByTestId('connect-publish').click();
	await expect(page.getByRole('dialog', { name: /Publish/ })).toBeVisible();
}

/** What the bar's door says this Workspace publishes to — a standing fact, not unfinished work. */
export async function expectRemoteNamed(page: Page, remote: string): Promise<void> {
	await expect(doorButton(page)).toHaveText(`Synced with ${remote}`);
}

/**
 * What the door says about the Synchronization Baseline (ADR-0038).
 *
 * `''` is the state where there *is* trustworthy evidence: `Cannot tell` is the determination worth
 * stating, and saying nothing when the two sides' history is known is what keeps the sentence
 * meaningful when it appears.
 */
export async function expectRemoteStatus(page: Page, sentence: string): Promise<void> {
	await inTheDoor(page, async () => {
		await expect(page.getByTestId('remote-baseline')).toContainText(sentence);
	});
}

/**
 * What the door says about the sign-in this computer holds — "Signed in to GitHub", or not.
 *
 * ⚠ **Read from the door and nowhere else** (ADR-0041, ADR-0042). Which account is held, and the
 * choice about keeping it past the tab, were in the Remote dialog; they are on the door now, which
 * is where every other gesture about a sign-in already was.
 */
export async function expectCredential(page: Page, sentence: string): Promise<void> {
	await inTheDoor(page, async () => {
		await expect(page.getByTestId('connect-credential')).toContainText(sentence);
	});
}

/**
 * Connect this Workspace to the repository GitHub says the author has granted.
 *
 * ⚠ **The door's own path, and the only one there is on a deployment with an App.** Binding used to
 * mean typing an address and pasting a token into a settings dialog; the sequence picks the
 * repository out of what GitHub answers, so nothing has to be typed correctly from memory. The
 * caller is responsible for a held credential — `seedGitHubCredential` where the subject is not the
 * sign-in itself — and for a `routeGitHubHosts` that grants the repository.
 *
 * Leaves the door open, because what a bind said is said inside it.
 */
export async function bindThroughTheDoor(page: Page): Promise<void> {
	await openTheDoor(page);
	await page.getByTestId('choose-repository').first().click();
}

/**
 * That this Workspace has no Remote at all.
 *
 * Read from the door, which offers connecting rather than naming a repository, and from the badge,
 * which carries no GitHub clause because there is nothing to compare against. Two claims rather than
 * one: "publishes nowhere" and "names a repository" must not both be true.
 */
export async function expectNoRemote(page: Page): Promise<void> {
	await expect(doorButton(page)).toHaveText('Sync with GitHub');
	await expect(page.getByTestId('remote-status-slot')).toHaveCount(0);
}

/**
 * That a Review Workspace names no Remote, which is a stronger claim than having none.
 *
 * The door is absent rather than offering to connect: a Review Workspace holds somebody else's work
 * and is never published (ADR-0024), so there is no gesture here to refuse.
 */
export async function expectNoRemoteInReview(page: Page): Promise<void> {
	await expect(doorButton(page)).toHaveCount(0);
	await expect(page.getByTestId('remote-status-slot')).toHaveCount(0);
}

/**
 * Open the badge's disclosure, which is where the determination, the reading's time and the Baseline
 * live (ADR-0041). The gestures are not here: they are behind the door.
 *
 * Idempotent, because a check leaves it open: pressing a disclosure that is already expanded would
 * close the panel the caller is about to reach into.
 */
export async function showRemoteStatusDetail(page: Page): Promise<void> {
	const disclosure = page.getByTestId('remote-status-explain');
	if ((await disclosure.getAttribute('aria-expanded')) !== 'true') await disclosure.click();
	await expect(page.getByTestId('remote-status-detail')).toBeVisible();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// INSTALLATION-LOCAL SYNCHRONIZATION METADATA (ADR-0038)
//
// ⚠ **The record shape is spelled once, here.** It is the app's own — `synchronization-metadata.ts`
// owns the keys, the format version and the fields — and a second copy per spec is a second thing
// that drifts from it. A drifted copy fails in the direction that is hardest to read: the app answers
// `Cannot tell` about a record a test believes it wrote.

/** The installation database and the store the synchronization records live in. */
const METADATA_DATABASE = 'ballastella';
/**
 * ⚠ **`DATABASE_VERSION` in `installation-database.ts`, and it has to be exactly that.**
 * A seeder that opens at an older version meets `VersionError` in every spec that ran the app first,
 * and one that opens at a newer version runs the app's upgrade with this file's idea of the stores.
 * So when the app bumps it, this bumps with it — and {@link METADATA_STORES} gains the new store.
 */
const METADATA_DATABASE_VERSION = 3;
const METADATA_STORE = 'synchronization';

/** Every object store the app's own upgrade creates, so a seeded database has the shape it expects. */
const METADATA_STORES = ['workspace', 'synchronization', 'credential'];

/** `SYNCHRONIZATION_FORMAT_VERSION`. A record of any other version reads as no evidence at all. */
const METADATA_FORMAT_VERSION = 2;

/** The Workspace key a browser-storage Workspace is filed under — `opfsWorkspaceKey`. */
export const browserWorkspaceKey = (workspace = DEFAULT_WORKSPACE): string => `opfs:${workspace}`;

/**
 * Put an installation-local Remote relationship in place, as an Open or a bind would.
 *
 * The seam for a spec that needs a *connected* Workspace without going through GitHub, and the only
 * one there is: the relationship is installation-local and nothing in a Workspace's own files names a
 * repository (ADR-0044), so there is nothing else a fixture could seed.
 */
export async function seedRemoteRelationship(
	page: Page,
	options: { owner: string; repository: string; branch?: string; workspace?: string }
): Promise<void> {
	await page.evaluate(
		async ([key, record, database, version, store, stores]) => {
			const open = indexedDB.open(database as string, version as number);
			const opened = await new Promise<IDBDatabase>((resolve, reject) => {
				open.onupgradeneeded = () => {
					for (const name of stores as string[]) {
						if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name);
					}
				};
				open.onsuccess = () => resolve(open.result);
				open.onerror = () => reject(open.error);
			});
			await new Promise<void>((resolve, reject) => {
				const transaction = opened.transaction(store as string, 'readwrite');
				transaction.objectStore(store as string).put(record, key as string);
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
			});
			opened.close();
		},
		[
			relationshipKey(options.workspace),
			{
				formatVersion: METADATA_FORMAT_VERSION,
				at: new Date().toISOString(),
				owner: options.owner,
				repository: options.repository,
				branch: options.branch ?? 'main'
			},
			METADATA_DATABASE,
			METADATA_DATABASE_VERSION,
			METADATA_STORE,
			METADATA_STORES
		] as const
	);
}

/**
 * Put a push credential in this tab's `sessionStorage`, the way a paste would have.
 *
 * ⚠ **Behind the app's back, and on purpose** — the companion to {@link seedRemoteRelationship}. A
 * spec whose subject is the bytes that arrive at a Remote needs a signed-in Workspace, not a
 * sign-in, and on a deployment with a GitHub App the publish dialog offers no token field to type
 * one into: the door there is a redirect off the page. Driving the real door for
 * every such spec would make each of them a test of the door, and it is asserted once, in
 * `editor-github-signin.e2e.ts`, where the real `isGitHubAppConfigured` is legible.
 *
 * `CREDENTIAL_KEY`, and no grant record beside it: a pasted token has none, and `ensureCredentialFresh`
 * therefore has nothing to read, no expiry to judge and no refresh token to spend.
 *
 * The credential is read when the app starts, so a reload is what makes it held.
 */
export async function seedGitHubCredential(page: Page, token: string): Promise<void> {
	await page.evaluate(
		(held) => sessionStorage.setItem('ballastella.github-credential', held),
		token
	);
}

/** The stored relationship record, or `null` — for asserting a Workspace arrived unbound. */
export async function readRemoteRelationship(
	page: Page,
	workspace?: string
): Promise<{ owner: string; repository: string; branch: string } | null> {
	return page.evaluate(
		async ([key, database, store]) => {
			const open = indexedDB.open(database as string);
			const opened = await new Promise<IDBDatabase | null>((resolve) => {
				open.onsuccess = () => resolve(open.result);
				open.onerror = () => resolve(null);
			});
			if (!opened || !opened.objectStoreNames.contains(store as string)) {
				opened?.close();
				return null;
			}
			const record = await new Promise<unknown>((resolve) => {
				const request = opened
					.transaction(store as string, 'readonly')
					.objectStore(store as string)
					.get(key as string);
				request.onsuccess = () => resolve(request.result ?? null);
				request.onerror = () => resolve(null);
			});
			opened.close();
			return (record ?? null) as { owner: string; repository: string; branch: string } | null;
		},
		[relationshipKey(workspace), METADATA_DATABASE, METADATA_STORE] as const
	);
}

/**
 * The stored Synchronization Baseline's commit and paths, or `null` — the evidence a transfer leaves.
 *
 * Read out of the installation database behind the app's back, because the point of the assertion is
 * that the record is durable and *outside* the Workspace: a copy inside it would be packed into a
 * Backup, uploaded by the very publish it describes, and downloaded by a Clone.
 */
export async function readBaseline(
	page: Page,
	workspace?: string
): Promise<{ commit: string; files: string[] } | null> {
	return page.evaluate(
		async ([key, database, store]) => {
			const open = indexedDB.open(database as string);
			const opened = await new Promise<IDBDatabase | null>((resolve) => {
				open.onsuccess = () => resolve(open.result);
				open.onerror = () => resolve(null);
			});
			if (!opened || !opened.objectStoreNames.contains(store as string)) {
				opened?.close();
				return null;
			}
			const record = await new Promise<unknown>((resolve) => {
				const request = opened
					.transaction(store as string, 'readonly')
					.objectStore(store as string)
					.get(key as string);
				request.onsuccess = () => resolve(request.result ?? null);
				request.onerror = () => resolve(null);
			});
			opened.close();
			if (record === null) return null;
			const held = record as { commit: string; files: Map<string, string> };
			return { commit: held.commit, files: [...held.files.keys()] };
		},
		[baselineRecordKey(workspace), METADATA_DATABASE, METADATA_STORE] as const
	);
}

/**
 * Put a Synchronization Baseline in place, as a successful Open, Update or Publish would.
 *
 * The seam for a spec about *status* rather than about a transfer: the six Remote Status states are a
 * comparison against this record, so a spec that had to reach each of them through a real Publish
 * would be testing publishing over and over to arrive at the state it wanted to assert. The record
 * shape is `synchronization-metadata.ts`'s, spelled once beside the two readers above.
 *
 * `files` is `path → blob SHA` for the source paths the two sides last shared. `gitBlobSha` over the
 * bytes a spec seeded on the Remote is how those SHAs are arrived at, so the record agrees with the
 * fake exactly rather than by a literal a later fixture edit would silently invalidate.
 */
export async function seedBaseline(
	page: Page,
	options: {
		owner: string;
		repository: string;
		branch?: string;
		commit?: string;
		files: Readonly<Record<string, string>>;
		workspace?: string;
	}
): Promise<void> {
	await page.evaluate(
		async ([key, record, database, version, store, stores]) => {
			const open = indexedDB.open(database as string, version as number);
			const opened = await new Promise<IDBDatabase>((resolve, reject) => {
				open.onupgradeneeded = () => {
					for (const name of stores as string[]) {
						if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name);
					}
				};
				open.onsuccess = () => resolve(open.result);
				open.onerror = () => reject(open.error);
			});
			await new Promise<void>((resolve, reject) => {
				const transaction = opened.transaction(store as string, 'readwrite');
				// ⚠ A `Map`, not an object: the store keeps structured-clone data and the reader asks
				// `files instanceof Map`, so an object here is a record this build reads as no evidence.
				const held = record as { files: Record<string, string> };
				transaction
					.objectStore(store as string)
					.put({ ...held, files: new Map(Object.entries(held.files)) }, key as string);
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
			});
			opened.close();
		},
		[
			baselineRecordKey(options.workspace),
			{
				formatVersion: METADATA_FORMAT_VERSION,
				at: new Date().toISOString(),
				owner: options.owner,
				repository: options.repository,
				branch: options.branch ?? 'main',
				commit: options.commit ?? 'seeded-commit',
				files: options.files
			},
			METADATA_DATABASE,
			METADATA_DATABASE_VERSION,
			METADATA_STORE,
			METADATA_STORES
		] as const
	);
}

const relationshipKey = (workspace?: string): string =>
	`synchronization/${encodeURIComponent(browserWorkspaceKey(workspace))}/remote`;

const baselineRecordKey = (workspace?: string): string =>
	`synchronization/${encodeURIComponent(browserWorkspaceKey(workspace))}/baseline`;
