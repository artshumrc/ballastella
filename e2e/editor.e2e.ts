import { expect, test } from './support/test.js';

test('the editor loads and renders its placeholder', async ({ page }) => {
	await page.goto('./');

	await expect(page.getByRole('heading', { level: 1, name: 'Ballastella Editor' })).toBeVisible();
});
