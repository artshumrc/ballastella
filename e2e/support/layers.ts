import { expect, type Locator, type Page } from './test.js';

export const layerRows = (page: Page) => page.getByTestId('layer-row');

// Pass the row rather than an index when a Layer has just been added: new Layers go to the top.
export async function openLayerRow(page: Page, at: number | Locator = 0): Promise<Locator> {
	const row = typeof at === 'number' ? layerRows(page).nth(at) : at;
	const disclosure = row.getByTestId('layer-disclosure');
	await expect(disclosure).toBeVisible();
	if ((await disclosure.getAttribute('aria-expanded')) !== 'true') await disclosure.click();
	await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
	await expect(row.getByTestId('layer-contents')).toBeVisible();
	return row;
}

export async function deleteLayerRow(page: Page, at: number | Locator = 0): Promise<void> {
	const row = await openLayerRow(page, at);
	await row.getByTestId('layer-delete').click();
	await page.getByTestId('confirm-delete-layer').click();
}

export async function alignFromLayer(page: Page, at: number | Locator = 0): Promise<void> {
	const row = await openLayerRow(page, at);
	await row.getByTestId('align-map-image').click();
}
