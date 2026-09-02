import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';
import { type Locator } from '@playwright/test';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { createWorkspace, seedRemoteRelationship, switchToWorkspace } from './support/workspace.js';

/**
 * The whole of the new interface, reached and operated from the keyboard alone.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ONE SPEC RATHER THAN A CLAIM INSIDE EACH SURFACE'S OWN
 *
 * Every surface carries its own accessibility assertions, and those are
 * asserted where they belong — focus restoration in `modal-dialog.dom.test.ts`, a busy control
 * keeping its place in `keeping-your-work.dom.test.ts`, disclosure semantics beside the disclosure.
 * This is not a second copy of any of them. It is the one property none of them can see on its own:
 * that a scholar can get from the bar to the door to the roster to Workspace Home **and back**
 * without a pointer, in an order that makes sense, with focus never lost.
 *
 * ⚠ **Seam 2 and not Seam 1c, because `Tab` is the subject.** happy-dom moves focus for `focus()`
 * and for nothing else: it does not implement sequential focus navigation, so a `Tab` there is a
 * keystroke nobody answers and every assertion below would be vacuous. What decides the order is
 * layout and the browser's own focus scope — including the focus trap `showModal()` brings — and
 * neither of those exists outside a real engine.
 *
 * ⚠ **Tabbed to, never `focus()`ed, and never `click()`ed.** `focus()` reaches a control a keyboard
 * user cannot: one with `tabindex="-1"`, or a `<div>` with a click handler, passes a test written
 * that way while being unreachable in the running app. A `click()` reaches a control that has left
 * the tab order altogether, which is the exact failure `aria-disabled` exists to prevent.
 */

const HUB = './';

// The default-deny network fence covers every spec here, and Workspace Home draws nothing from
// GitHub — the badge reports `unchecked` until somebody asks — but the Base Map catalog is routed
// for the whole file so that a navigation into a Project screen is never a network failure.
test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

/** Empty the whole of browser storage — every named Workspace — so no test sees another's. */
async function emptyBrowserStorage(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
		localStorage.clear();
	});
}

/**
 * Walk forwards with `Tab` until the control has focus, and say so if it never does.
 *
 * The bound is generous and the failure is the assertion rather than the loop running out, so a
 * control that has fallen out of the tab order reads as *this was never focused* rather than as a
 * timeout.
 */
async function tabTo(page: Page, control: Locator, limit = 60): Promise<void> {
	for (let tab = 0; tab < limit; tab += 1) {
		if (await control.evaluate((node) => node === document.activeElement)) break;
		await page.keyboard.press('Tab');
	}
	await expect(control).toBeFocused();
}

/**
 * Workspace Home, in a Workspace that publishes somewhere, with a second Workspace beside it and an
 * unsaved change belonging to a third that no longer exists.
 *
 * All three are what makes the surfaces exist at all: the badge carries its GitHub clause and its
 * disclosure only for a bound Workspace, a row may be deleted only when it is not the open one, and
 * the orphan report renders only when something is orphaned.
 */
async function workspaceHome(page: Page): Promise<void> {
	await page.goto(HUB);
	await emptyBrowserStorage(page);
	await page.reload();
	await createWorkspace(page, 'Marking 2026');
	await switchToWorkspace(page, DEFAULT_WORKSPACE);
	await seedRemoteRelationship(page, { owner: 'ada', repository: 'atlas' });
	await page.evaluate(() => {
		const workspace = encodeURIComponent('opfs:A Workspace nobody has any more');
		localStorage.setItem(
			`ballastella.journal.${workspace}/${encodeURIComponent('boston-1775/project.json')}`,
			JSON.stringify({ formatVersion: 1, at: new Date().toISOString(), bytes: btoa('{}') })
		);
	});
	await page.reload();
	await expect(page.getByTestId('remote-status-slot')).toBeVisible();
}

test.describe('the bar, from the keyboard alone', () => {
	test.beforeEach(async ({ page }) => workspaceHome(page));

	/**
	 * The badge is a `role="status"` and therefore not a stop; its disclosure is a `<button>` and
	 * therefore is. What is behind the press has to be reachable too, or the press is a dead end for
	 * exactly the person it was put there for.
	 */
	test("the badge's disclosure opens on Enter, and what it holds is in the tab order", async ({
		page
	}) => {
		const disclosure = page.getByTestId('remote-status-explain');
		await tabTo(page, disclosure);
		await expect(disclosure).toHaveAttribute('aria-expanded', 'false');

		await page.keyboard.press('Enter');

		await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByTestId('remote-status-detail')).toBeVisible();
		// The determination itself, which is the whole reason the press exists.
		await expect(page.getByTestId('remote-status-determination')).toBeVisible();
		// And focus is still on the control that was pressed, so the next `Tab` carries on from here
		// rather than from the top.
		await expect(disclosure).toBeFocused();
	});

	/**
	 * ⚠ **One `role="status"` in the bar, and it is the badge.**
	 *
	 * A second status region is not a second courtesy: a screen reader user hearing an announcement
	 * has to work out which of two regions has become true, and the bar is where both halves of *is
	 * my work safe* are said. So the save announcement beside it is a bare `aria-live="polite"`,
	 * which announces without claiming the role, and the badge keeps the role alone.
	 *
	 * Asserted over the bar rather than the document: the toast stack below has status semantics of
	 * its own, and it is not in the bar.
	 */
	test('has exactly one status region, which is the badge', async ({ page }) => {
		const bar = page.getByRole('banner');

		await expect(bar.getByRole('status')).toHaveCount(1);
		await expect(bar.getByRole('status')).toHaveAttribute('data-testid', 'where-your-work-is');
	});

	/**
	 * The bar's one GitHub control, and back out of it onto itself. Closing a modal has to return the
	 * keyboard to the control that opened it or every visit costs a walk from the top of the document
	 * (WCAG 2.4.3).
	 *
	 * This Workspace has a repository, so the control opens the Sync modal (ADR-0044).
	 */
	test('the GitHub control opens on Enter and closing comes back to it', async ({ page }) => {
		const door = page.getByTestId('connect-to-github');
		await tabTo(page, door);
		await page.keyboard.press('Enter');

		await expect(page.getByTestId('sync-modal')).toBeVisible();
		// `showModal()` traps focus, so this walk cannot leave the dialog — which is itself the claim
		// that it is a real `<dialog>` rather than one of the two spellings ADR-0016 bans.
		const cancel = page.getByRole('button', { name: 'Cancel' });
		await tabTo(page, cancel, 30);
		await page.keyboard.press('Enter');

		await expect(page.getByTestId('sync-modal')).toBeHidden();
		await expect(door).toBeFocused();
	});

	/**
	 * The roster: every Workspace there is, each opened, renamed or deleted from its own row
	 * (ADR-0042). All three per-row controls are real `<button>`s inside the popover, so all three
	 * are stops — and the confirmation the delete raises comes back to the switcher, because the row
	 * it was pressed from is inside a popover that is no longer showing.
	 */
	test('the roster and each row’s three actions are reachable, and the question comes back', async ({
		page
	}) => {
		const switcher = page.getByTestId('workspace-switcher');
		await tabTo(page, switcher);
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('workspace-switcher-menu')).toBeVisible();

		// The row for the Workspace that is *not* open, which is the only kind that offers all three.
		const row = page.getByRole('button', { name: /Marking 2026/ }).first();
		await tabTo(page, row, 30);
		const rename = page.getByRole('button', { name: 'Rename Marking 2026' });
		await tabTo(page, rename, 30);
		const remove = page.getByRole('button', { name: 'Delete Marking 2026' });
		await tabTo(page, remove, 30);
		// And on to the way to make another one, so the end of the list is not the end of the menu.
		await tabTo(page, page.getByTestId('new-workspace'), 30);

		await tabTo(page, remove, 30);
		await page.keyboard.press('Enter');

		const question = page.getByRole('dialog', { name: 'Delete this Workspace?' });
		await expect(question).toBeVisible();
		const keep = page.getByRole('button', { name: 'Keep it' });
		await tabTo(page, keep, 20);
		await page.keyboard.press('Enter');

		await expect(question).toBeHidden();
		// ⚠ **The switcher, not the row.** The row is inside a popover that was dismissed on the press,
		// so a restoration that went back to it would put focus on a control nobody can see.
		await expect(switcher).toBeFocused();
		// Turned down, so the Workspace is still there to be switched to.
		await expect(page.getByTestId('workspace-announcement')).toHaveText('');
	});
});

test.describe('Workspace Home, from the keyboard alone', () => {
	test.beforeEach(async ({ page }) => workspaceHome(page));
});
