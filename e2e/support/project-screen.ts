import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Reaching the Project's own settings (ticket 04).
 *
 * The Project name, its folder and its last-saved time used to be three fields on a page of their
 * own. They are now behind a menu on the Project screen, in a `<dialog>` opened with `showModal()`
 * (ADR-0016) — one editable value and two read-only ones did not need a page. Every suite that used
 * to type into the name field in passing goes through here, so the two extra clicks are written
 * once rather than twenty times.
 */
export async function openProjectSettings(page: Page): Promise<Locator> {
	await page.getByTestId('project-menu-button').click();
	await page.getByTestId('open-project-settings').click();
	const dialog = page.getByRole('dialog', { name: 'Project settings' });
	await expect(dialog).toBeVisible();
	return dialog;
}

/** The Project name field, with the settings dialog opened to get at it. */
export async function projectNameField(page: Page): Promise<Locator> {
	const dialog = await openProjectSettings(page);
	return dialog.getByLabel('Project name');
}
