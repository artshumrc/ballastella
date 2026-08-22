// Driving the Workspace control on the navigation bar: which Workspace you are in, moving between
// them, and the settings dialog behind them (ticket 12).
//
// One module because the bar is on every screen and every spec that used to reach for the hub's
// "Where your work is stored" section now goes through here — and because the two-step (menu, then
// item) is exactly the kind of thing that gets copied slightly differently each time.

import { DEFAULT_WORKSPACE, expect, type Page } from './test.js';

/** The Workspace control on the bar. Its button carries the Workspace's name. */
export const workspaceButton = (page: Page) => page.getByTestId('workspace-switcher');

/**
 * What the bar says the current Workspace is. Visible on every screen (SPEC story 88).
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

/** Open the Workspace menu on the bar. */
export async function openWorkspaceMenu(page: Page): Promise<void> {
	await workspaceButton(page).click();
	await expect(page.getByTestId('workspace-switcher-menu')).toBeVisible();
}

/**
 * Open Workspace settings from the bar.
 *
 * A `<dialog>` opened with `showModal()` (ADR-0016), so everything behind it is inert until it is
 * closed — which is why {@link closeWorkspaceSettings} exists and why the helpers here are paired.
 */
export async function openWorkspaceSettings(page: Page): Promise<void> {
	await openWorkspaceMenu(page);
	await page.getByTestId('open-workspace-settings').click();
	await expect(page.getByRole('dialog', { name: 'Workspace settings' })).toBeVisible();
}

export async function closeWorkspaceSettings(page: Page): Promise<void> {
	await page.getByTestId('close-workspace-settings').click();
	await expect(page.getByRole('dialog', { name: 'Workspace settings' })).toBeHidden();
}

/** Do something inside Workspace settings, and close it again. */
export async function inWorkspaceSettings(
	page: Page,
	act: () => Promise<void>,
	options: { closeAfter?: boolean } = {}
): Promise<void> {
	await openWorkspaceSettings(page);
	await act();
	if (options.closeAfter !== false) await closeWorkspaceSettings(page);
}

/** Switch to an existing named Workspace. */
export async function switchToWorkspace(page: Page, name: string): Promise<void> {
	await openWorkspaceMenu(page);
	await page.getByTestId('switch-workspace').filter({ hasText: name }).first().click();
	await expectWorkspaceNamed(page, name);
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
 * Open Remote settings, which is reached **through Workspace settings**.
 *
 * The workspace menu answers one question — which Workspace am I in — so the binding is offered in
 * exactly one place, and that place is the *Where your work lives* group. Two `<dialog>`s stacked in
 * the top layer, which is why {@link closeRemoteSettings} closes both.
 */
export async function openRemoteSettings(page: Page): Promise<void> {
	await openWorkspaceSettings(page);
	await page.getByTestId('open-remote-settings').click();
	await expect(page.getByRole('dialog', { name: 'Remote repository' })).toBeVisible();
}

/**
 * Close Remote settings **and the Workspace settings it was opened from**, back to the page.
 *
 * Both, because closing only the top one leaves a modal over everything a spec goes on to touch —
 * and a `showModal()` dialog makes the page behind it inert rather than merely obscured.
 */
export async function closeRemoteSettings(page: Page): Promise<void> {
	await page.getByTestId('close-remote-settings').click();
	await expect(page.getByRole('dialog', { name: 'Remote repository' })).toBeHidden();
	await closeWorkspaceSettings(page);
}

/**
 * Read something out of the Workspace menu's header block, and close the menu again.
 *
 * The header is where the current Workspace's name, its backing and its Remote are stated together,
 * and it is only on screen while the menu is open — so every assertion about those three facts pays
 * for the two clicks around it, and pays for them once, here.
 */
async function inWorkspaceHeader(page: Page, act: () => Promise<void>): Promise<void> {
	await openWorkspaceMenu(page);
	await act();
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('workspace-switcher-menu')).toBeHidden();
}

/** What the menu's header says this Workspace publishes to. */
export async function expectRemoteNamed(page: Page, remote: string): Promise<void> {
	await inWorkspaceHeader(page, async () => {
		await expect(page.getByTestId('workspace-remote')).toHaveText(remote);
	});
}

/**
 * What the menu's header says about the Synchronization Baseline (ADR-0038).
 *
 * `''` is the state where there *is* trustworthy evidence: `Cannot tell` is the determination worth
 * stating, and saying nothing when the two sides' history is known is what keeps the sentence
 * meaningful when it appears.
 */
export async function expectRemoteStatus(page: Page, sentence: string): Promise<void> {
	await inWorkspaceHeader(page, async () => {
		await expect(page.getByTestId('remote-status')).toContainText(sentence);
	});
}

/** What the menu's header says about the push credential — "Signed in to GitHub", or not. */
export async function expectCredential(page: Page, sentence: string): Promise<void> {
	await inWorkspaceHeader(page, async () => {
		await expect(page.getByTestId('workspace-credential')).toHaveText(sentence);
	});
}

/**
 * That the menu's header says this Workspace has no Remote at all.
 *
 * Stated rather than omitted, so a first-time author reads a sentence rather than a gap — and the
 * `workspace-remote` count is asserted with it, because "publishes nowhere" and "names a repository"
 * must not both be true.
 *
 * `workspace-credential` is counted too, and it is a separate claim rather than a consequence of the
 * markup: the sealed credential store is what a Review Workspace is for (ADR-0033), and a header
 * that named a signed-in identity in one would be reporting a token it must not be able to read.
 */
export async function expectNoRemote(page: Page): Promise<void> {
	await inWorkspaceHeader(page, async () => {
		await expect(page.getByTestId('workspace-publishes')).toContainText('No Remote yet');
		await expect(page.getByTestId('workspace-remote')).toHaveCount(0);
		await expect(page.getByTestId('workspace-credential')).toHaveCount(0);
	});
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
const METADATA_DATABASE_VERSION = 2;
const METADATA_STORE = 'synchronization';

/** `SYNCHRONIZATION_FORMAT_VERSION`. A record of any other version reads as no evidence at all. */
const METADATA_FORMAT_VERSION = 2;

/** The Workspace key a browser-storage Workspace is filed under — `opfsWorkspaceKey`. */
export const browserWorkspaceKey = (workspace = DEFAULT_WORKSPACE): string => `opfs:${workspace}`;

/**
 * Put an installation-local Remote relationship in place, as an Open or a bind would.
 *
 * The seam for a spec that needs a *bound* Workspace without going through GitHub. Seeding
 * `remote.json` alone no longer binds anything: a binding inside the Workspace is now only the
 * Published Site's compatibility evidence, and lifting it needs corroboration or a confirmation.
 */
export async function seedRemoteRelationship(
	page: Page,
	options: { owner: string; repository: string; branch?: string; workspace?: string }
): Promise<void> {
	await page.evaluate(
		async ([key, record, database, version, store]) => {
			const open = indexedDB.open(database as string, version as number);
			const opened = await new Promise<IDBDatabase>((resolve, reject) => {
				open.onupgradeneeded = () => {
					for (const name of ['workspace', store as string]) {
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
			METADATA_STORE
		] as const
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
		async ([key, record, database, version, store]) => {
			const open = indexedDB.open(database as string, version as number);
			const opened = await new Promise<IDBDatabase>((resolve, reject) => {
				open.onupgradeneeded = () => {
					for (const name of ['workspace', store as string]) {
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
			METADATA_STORE
		] as const
	);
}

const relationshipKey = (workspace?: string): string =>
	`synchronization/${encodeURIComponent(browserWorkspaceKey(workspace))}/remote`;

const baselineRecordKey = (workspace?: string): string =>
	`synchronization/${encodeURIComponent(browserWorkspaceKey(workspace))}/baseline`;
