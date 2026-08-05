import { expect, test } from '@playwright/test';

test('the viewer loads and renders its placeholder', async ({ page }) => {
	await page.goto('./');

	await expect(page.getByRole('heading', { level: 1, name: 'Ballastella Viewer' })).toBeVisible();
});
