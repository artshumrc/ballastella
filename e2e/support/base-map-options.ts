// Reaching the Base Map Options panel, from either application's suite.
//
// The panel is a popover, so **its contents are not in the accessibility tree until it is open** —
// `popover="auto"` hides them with `display: none` — and a spec that located a switch without
// opening it would fail with "element not found" rather than with the thing it meant to say. One
// helper, so that fact is stated once instead of at every call site.

import { expect, type Locator, type Page } from '@playwright/test';

/** The one button on the map that opens everything about the Base Map. */
export const baseMapOptionsButton = (page: Page): Locator => page.getByTestId('base-map-options');

/**
 * Open the panel, or leave it open if it already is.
 *
 * Idempotent deliberately: clicking the button a second time *closes* it, so a test that opened the
 * panel and then called a helper which opened it again would be operating on a panel that had just
 * gone away. `aria-expanded` is the button's own answer and is what `MenuPopover` keeps in step with
 * the popover's state.
 */
export async function openBaseMapOptions(page: Page): Promise<void> {
	const button = baseMapOptionsButton(page);
	if ((await button.getAttribute('aria-expanded')) === 'true') return;
	await button.click();
	await expect(button).toHaveAttribute('aria-expanded', 'true');
}

/**
 * One of the four switches that decide how the Base Map is drawn.
 *
 * By its visible label rather than by a test id, because "can a scholar find this" is the question
 * and the accessible name is what answers it. The name carries the consequence after an em dash —
 * ADR-0016 keeps that out of a `title` — so the pattern is anchored to the label alone.
 */
export const drawSwitch = (
	page: Page,
	label: 'Streets' | 'Satellite' | 'Topography' | 'High contrast'
): Locator => page.getByRole('checkbox', { name: new RegExp(`^${label} —`) });

/** One of the boundary choices, in the panel's radio group. */
export const borderOption = (page: Page, choice: 'none' | 'national' | 'all'): Locator =>
	page.getByTestId(`border-option-${choice}`);
