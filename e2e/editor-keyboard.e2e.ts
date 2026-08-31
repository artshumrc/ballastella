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
 * Every UI slice in this Epic carries its own accessibility acceptance criteria, and those are
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
 * Every `data-testid` `Tab` lands on, in the order it lands on them, starting from the top.
 *
 * Stops when focus comes back to where it started, which is what a full cycle of the document is —
 * so the answer is *the tab order*, and a control absent from it is absent from the list rather
 * than merely late in it.
 */
async function tabOrder(page: Page, limit = 120): Promise<string[]> {
	const seen: string[] = [];
	let first = '';
	for (let tab = 0; tab < limit; tab += 1) {
		await page.keyboard.press('Tab');
		const stop = await page.evaluate(
			() => document.activeElement?.getAttribute('data-testid') ?? ''
		);
		if (stop === '') continue;
		if (stop === first) break;
		if (first === '') first = stop;
		seen.push(stop);
	}
	return seen;
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
	 * ⚠ **One `role="status"` in the bar, and it is the badge** (user story 133).
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
	 * The door, and back out of it onto itself. Closing a modal has to return the keyboard to the
	 * control that opened it or every visit to the door costs a walk from the top of the document
	 * (WCAG 2.4.3, user story 129).
	 */
	test('the door opens on Enter and closing it comes back to the door', async ({ page }) => {
		const door = page.getByTestId('connect-to-github');
		await tabTo(page, door);
		await page.keyboard.press('Enter');

		await expect(page.getByTestId('connect-sequence')).toBeVisible();
		// `showModal()` traps focus, so this walk cannot leave the dialog — which is itself the claim
		// that the door is a real `<dialog>` rather than one of the two spellings ADR-0016 bans.
		const close = page.getByTestId('close-connect-sequence');
		await tabTo(page, close, 30);
		await page.keyboard.press('Enter');

		await expect(page.getByTestId('connect-sequence')).toBeHidden();
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

	/**
	 * Everything ADR-0042 re-homed onto this screen, in one walk of the document.
	 *
	 * Asserted as membership of the tab order rather than one `tabTo` each, because what is being
	 * claimed is that the *screen* is operable: a control missing from this list is one a keyboard
	 * user cannot get to at all, whatever else is true of it.
	 */
	test('carries every re-homed control in the tab order', async ({ page }) => {
		// The browser does not offer to install a site it has already decided about, and headless
		// Chromium never fires this — so the offer's *control* exists only once the event has been
		// delivered. Without it the offer is a sentence saying where to look, which is `editor-pwa`'s.
		await page.evaluate(() => window.dispatchEvent(new Event('beforeinstallprompt')));
		await expect(page.getByTestId('install-app')).toBeVisible();

		const order = await tabOrder(page);

		for (const control of [
			// The bar: the badge's disclosure, the door, the roster.
			'remote-status-explain',
			'connect-to-github',
			'workspace-switcher',
			// What the browser promised, and the lever that answers it.
			'durability-learn-more',
			'install-app',
			// Backup, Restore and the one way existing work reaches a folder.
			'back-up-workspace',
			'restore-workspace',
			// Off-screen rather than `hidden`, precisely so that it is a stop.
			'restore-file',
			'move-into-folder',
			// Unsaved work with nowhere to go, and the deliberate act that throws it away.
			'discard-orphaned-journal'
		]) {
			expect(order, `${control} is not in the tab order`).toContain(control);
		}
	});

	test("the storage warning's disclosure opens on Enter", async ({ page }) => {
		const disclosure = page.getByTestId('durability-learn-more');
		await tabTo(page, disclosure);
		await expect(page.getByTestId('durability-detail')).toBeHidden();

		await page.keyboard.press('Enter');

		await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByTestId('durability-detail')).toBeVisible();
	});

	/**
	 * The one press on this screen that destroys something, driven with `Enter` — and the outcome
	 * read from the live region rather than from the list, because what a screen reader hears is the
	 * whole of what a keyboard user gets back.
	 */
	test('throws away an orphaned journal on Enter, and says what went', async ({ page }) => {
		await tabTo(page, page.getByTestId('discard-orphaned-journal'));
		await page.keyboard.press('Enter');

		await expect(page.getByTestId('discard-outcome')).toContainText('Threw away 1 unsaved change');
		await expect(page.getByTestId('orphaned-journals')).toHaveCount(0);
	});

	/**
	 * A transfer under way must not take the keyboard's place away (user story 130). The Backup runs
	 * to completion in milliseconds against an empty Workspace, so what is asserted is the shape the
	 * control keeps rather than a frame mid-transfer: `aria-disabled` and never `disabled`, which is
	 * the attribute that would remove it from the tab order the instant it was pressed.
	 */
	test('the Backup control is never removed from the tab order by being pressed', async ({
		page
	}) => {
		const backUp = page.getByTestId('back-up-workspace');
		await tabTo(page, backUp);
		await expect(backUp).not.toHaveAttribute('disabled', /.*/);

		const download = page.waitForEvent('download');
		await page.keyboard.press('Enter');
		await (await download).cancel();

		await expect(page.getByTestId('transfer-outcome')).toContainText('Backed up');
		await expect(backUp).toBeFocused();
	});
});
