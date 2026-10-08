import { DEFAULT_DARK_THEME, DEFAULT_THEME, type Theme } from '@ballastella/core';

export const systemTheme = (dark: boolean): Theme => (dark ? DEFAULT_DARK_THEME : DEFAULT_THEME);

export function applyThemeToDocument(theme: Theme): void {
	if (typeof document === 'undefined') return;
	document.documentElement.dataset.theme = theme;
	const base = getComputedStyle(document.documentElement)
		.getPropertyValue('--color-base-100')
		.trim();
	if (base !== '')
		document.querySelector('meta[name="theme-color"]')?.setAttribute('content', base);
}
