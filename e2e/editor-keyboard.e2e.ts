import { DEFAULT_WORKSPACE, expect, test, type Locator, type Page } from './support/test.js';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { routeGitHubHosts } from './support/github-hosts.js';
import {
	createWorkspace,
	seedRemoteRelationship,
	switchToWorkspace,
	HUB,
	emptyBrowserStorage
} from './support/workspace.js';

test.beforeEach(async ({ context, page }) => {
	await routeBaseMapArchive(context);
	await routeGitHubHosts(page, { repositories: [{ owner: 'ada', name: 'atlas' }] });
});

async function tabTo(page: Page, control: Locator, limit = 60): Promise<void> {
	for (let tab = 0; tab < limit; tab += 1) {
		if (await control.evaluate((node) => node === document.activeElement)) break;
		await page.keyboard.press('Tab');
	}
	await expect(control).toBeFocused();
}

async function workspaceHome(page: Page): Promise<void> {
	await page.goto(HUB);
	await emptyBrowserStorage(page, { forget: true });
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

	test('the status badge is the bar’s one status region, and opens on Enter', async ({ page }) => {
		const bar = page.getByRole('banner');
		await expect(bar.getByRole('status')).toHaveCount(1);
		await expect(bar.getByRole('status').getByTestId('where-your-work-is')).toBeVisible();

		const badge = page.getByTestId('where-your-work-is');
		await tabTo(page, badge);
		await expect(badge).toHaveAttribute('aria-expanded', 'false');

		await page.keyboard.press('Enter');

		await expect(badge).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByTestId('remote-status-detail')).toBeVisible();
		await expect(page.getByTestId('remote-status-determination')).toBeVisible();
		await expect(badge).toBeFocused();
	});

	test('the GitHub control opens on Enter and closing comes back to it', async ({ page }) => {
		const door = page.getByTestId('connect-to-github');
		await tabTo(page, door);
		await page.keyboard.press('Enter');

		await expect(page.getByTestId('sync-modal')).toBeVisible();
		const cancel = page.getByRole('button', { name: /^(Cancel|Close)$/ });
		await tabTo(page, cancel, 30);
		await page.keyboard.press('Enter');

		await expect(page.getByTestId('sync-modal')).toBeHidden();
		await expect(door).toBeFocused();
	});

	test('the roster and each row’s three actions are reachable, and the question comes back', async ({
		page
	}) => {
		const switcher = page.getByTestId('workspace-switcher');
		await tabTo(page, switcher);
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('workspace-switcher-menu')).toBeVisible();

		const row = page.getByRole('button', { name: /Marking 2026/ }).first();
		await tabTo(page, row, 30);
		const rename = page.getByRole('button', { name: 'Rename Marking 2026' });
		await tabTo(page, rename, 30);
		const remove = page.getByRole('button', { name: 'Delete Marking 2026' });
		await tabTo(page, remove, 30);
		await tabTo(page, page.getByTestId('new-workspace'), 30);

		await tabTo(page, remove, 30);
		await page.keyboard.press('Enter');

		const question = page.getByRole('dialog', { name: 'Delete this Workspace?' });
		await expect(question).toBeVisible();
		const keep = page.getByRole('button', { name: 'Keep it' });
		await tabTo(page, keep, 20);
		await page.keyboard.press('Enter');

		await expect(question).toBeHidden();
		await expect(switcher).toBeFocused();
		await expect(page.getByTestId('workspace-announcement')).toHaveText('');
	});
});
