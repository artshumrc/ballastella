// Driving the Workspace control on the navigation bar: which Workspace you are in, moving between
// them, and the settings dialog behind them (ticket 12).
//
// One module because the bar is on every screen and every spec that used to reach for the hub's
// "Where your work is stored" section now goes through here — and because the two-step (menu, then
// item) is exactly the kind of thing that gets copied slightly differently each time.

import { expect, type Page } from './test.js';

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
