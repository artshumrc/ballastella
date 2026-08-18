import { expect, type Locator, type Page } from './test.js';

import { PROJECT_DIRECTORY } from './annotations';

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

/**
 * Put a Map Image Layer for `imageId` into a Project's `project.json`, behind the app's back.
 *
 * Fixtures that write a Workspace `remote.json` directly are writing what a *Workspace* holds; since
 * ticket 04 the Project screen shows a Map Image only where a Layer of this Project draws it
 * (ADR-0023: the Workspace owns the map, the Project owns how it is presented). So a fixture that
 * wants the map on the Project screen has to say which Project draws it, which is what this does —
 * the same thing `addReferencedMap` writes, minus the network.
 */
export const seedMapLayer = (
	page: Page,
	imageId: string,
	name: string,
	directory = PROJECT_DIRECTORY
): Promise<void> =>
	page.evaluate(
		async ([directory, imageId, name]) => {
			const root = await workspaceRoot();
			const project = await root.getDirectoryHandle(directory as string);
			const handle = await project.getFileHandle('project.json');
			const document = JSON.parse(await (await handle.getFile()).text());
			document.layers = [
				...(document.layers ?? []),
				{
					kind: 'map',
					id: crypto.randomUUID(),
					name,
					visible: true,
					order: (document.layers ?? []).length,
					opacity: 1,
					imageId
				}
			];
			const writable = await handle.createWritable();
			await writable.write(JSON.stringify(document));
			await writable.close();
		},
		[directory, imageId, name]
	);
