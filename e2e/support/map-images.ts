import { expect, type Locator, type Page } from './test.js';

import { PROJECT_NAME, openNewProject } from './annotations.js';
import { emptyWorkspace } from './workspace.js';

export const addMapImageButton = (page: Page): Locator => page.getByTestId('add-map-image');

const addDialog = (page: Page): Locator =>
	page.locator('dialog').filter({ has: page.getByTestId('add-from-file') });

export const addMapImageIsOpen = (page: Page): Promise<boolean> =>
	addDialog(page)
		.evaluate((element) => (element as HTMLDialogElement).open)
		.catch(() => false);

const addInFlight = (page: Page): Promise<boolean> =>
	page.evaluate(() => {
		const look = document.querySelector('[data-testid="remote-read"]');
		if (look instanceof HTMLButtonElement && look.disabled) return true;
		return document.querySelector('[data-testid="workspace-map"]:disabled') !== null;
	});

const settle = (page: Page): Promise<void> =>
	expect.poll(() => addInFlight(page), { timeout: 30_000 }).toBe(false);

export async function openAddMapImage(page: Page): Promise<Locator> {
	await addMapImageButton(page).click();
	const dialog = addDialog(page);
	await expect.poll(() => addMapImageIsOpen(page)).toBe(true);
	await expect(dialog.getByLabel('Add a Map Image from a file')).toBeVisible();
	await expect(dialog.getByTestId('remote-url')).toBeVisible();
	return dialog;
}

export async function ensureAddMapImageOpen(page: Page): Promise<Locator> {
	await settle(page);
	if (await addMapImageIsOpen(page)) return addDialog(page);
	return openAddMapImage(page);
}

interface PickedFile {
	name: string;
	mimeType: string;
	buffer: Buffer;
}

export async function pickMapImageFile(page: Page, file: PickedFile): Promise<void> {
	const dialog = await openAddMapImage(page);
	await dialog.getByLabel('Add a Map Image from a file').setInputFiles(file);
}

export async function addMapImageFromFile(
	page: Page,
	file: PickedFile,
	options: { layers?: number; timeout?: number } = {}
): Promise<void> {
	const { layers = 1, timeout = 30_000 } = options;
	await pickMapImageFile(page, file);
	await expect(page.getByTestId('layer-row')).toHaveCount(layers, { timeout });
	await expect(page.getByTestId('preparing-layer')).toHaveCount(0, { timeout });
}

export const preparingCard = (page: Page): Locator => page.getByTestId('preparing-layer');

export const expectNothingPreparing = (page: Page, timeout = 60_000): Promise<void> =>
	expect(preparingCard(page)).toHaveCount(0, { timeout });

export async function freshProject(page: Page, name = PROJECT_NAME): Promise<void> {
	await page.goto('/');
	await emptyWorkspace(page);
	await page.reload();
	await openNewProject(page, name);
	await expect(addMapImageButton(page)).toBeVisible();
}
