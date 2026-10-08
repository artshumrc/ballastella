import { expect, type Locator, type Page } from '@playwright/test';

export const baseMapOptionsButton = (page: Page): Locator => page.getByTestId('base-map-options');

export async function openBaseMapOptions(page: Page): Promise<void> {
	const button = baseMapOptionsButton(page);
	if ((await button.getAttribute('aria-expanded')) === 'true') return;
	await button.click();
	await expect(button).toHaveAttribute('aria-expanded', 'true');
}

export const drawSwitch = (
	page: Page,
	label: 'Streets' | 'Satellite' | 'Topography' | 'High contrast'
): Locator => page.getByRole('checkbox', { name: new RegExp(`^${label} —`) });

export const borderOption = (page: Page, choice: 'none' | 'national' | 'all'): Locator =>
	page.getByTestId(`border-option-${choice}`);
