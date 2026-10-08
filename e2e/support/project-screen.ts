import { expect, type Locator, type Page } from './test.js';

import { PROJECT_DIRECTORY } from './annotations';

export async function openProjectSettings(page: Page): Promise<Locator> {
	await page.getByTestId('edit-project-name').click();
	const dialog = page.getByRole('dialog', { name: 'Project settings' });
	await expect(dialog).toBeVisible();
	return dialog;
}

export async function projectNameField(page: Page): Promise<Locator> {
	const dialog = await openProjectSettings(page);
	return dialog.getByLabel('Project name');
}

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
