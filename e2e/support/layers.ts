// Driving the Layer sidebar, where one Layer at a time opens in place.
//
// **Why every suite needs this.** A closed row shows the Layer's name, its visibility, its position
// controls and whatever it is warning about; everything else — the Align link, the library a
// referenced Map Image's tiles come from, the drawing tools — is behind the row's disclosure. So the
// step this file adds is a real one a user takes, not a workaround: the contents of a Layer are
// reached by opening it.
//
// It matters that this is written once. Without it, an assertion that something is *absent* —
// `toHaveCount(0)` on a referenced map's host, say — would pass for the wrong reason in every spec
// that forgot the click, which is the vacuous green this suite keeps finding.

import { expect, type Locator, type Page } from './test.js';

/** The Layer rows in the sidebar, top first. */
export const layerRows = (page: Page) => page.getByTestId('layer-row');

/**
 * Open a Layer's row and wait until its contents are on screen.
 *
 * Idempotent: the disclosure is a toggle, so a caller that has already opened this row — or reached
 * it through something else that opens it, like clicking one of its Annotations on the map — must
 * not close it again. `aria-expanded` is asked rather than a class, because that attribute is what
 * the app promises a screen reader and is therefore the thing worth depending on.
 *
 * ⚠ **Pass the row, not an index, whenever a Layer has just been added.** A new map Layer goes to
 * the *top* of the stack, so index 0 names one row before the re-render and another after it — and
 * because this is idempotent, it reads `aria-expanded="true"` off the row that was already open,
 * clicks nothing, and hands back a locator that then resolves to the new, still-closed row. Measured
 * in `editor-remote-iiif.e2e.ts`: 2 failures in 11 runs, as a child of the returned row never
 * appearing. An index is not a subject when the list can grow at the front.
 *
 * @param at the row's index in the stack, or the row itself
 * @returns the row, so the caller can scope its own queries to it
 */
export async function openLayerRow(page: Page, at: number | Locator = 0): Promise<Locator> {
	const row = typeof at === 'number' ? layerRows(page).nth(at) : at;
	const disclosure = row.getByTestId('layer-disclosure');
	await expect(disclosure).toBeVisible();
	if ((await disclosure.getAttribute('aria-expanded')) !== 'true') await disclosure.click();
	await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
	await expect(row.getByTestId('layer-contents')).toBeVisible();
	return row;
}

/**
 * Delete a Layer through its row: open the row, press Delete Layer, confirm the dialog.
 *
 * The confirmation is not optional in the app, so it is not optional here — a spec that clicked the
 * row's button alone would assert against a Project nothing had been deleted from.
 */
export async function deleteLayerRow(page: Page, at: number | Locator = 0): Promise<void> {
	const row = await openLayerRow(page, at);
	await row.getByTestId('layer-delete').click();
	await page.getByTestId('confirm-delete-layer').click();
}

/** Close whichever row is open. */
export async function closeLayerRow(page: Page, at: number | Locator = 0): Promise<void> {
	const row = typeof at === 'number' ? layerRows(page).nth(at) : at;
	const disclosure = row.getByTestId('layer-disclosure');
	if ((await disclosure.getAttribute('aria-expanded')) === 'true') await disclosure.click();
	await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
}

/**
 * Open a Map Image Layer and follow its Align link.
 *
 * The commonest two-step in the suite: nineteen specs went straight to `align-map-image`, and
 * every one of them now has to open the Layer that holds it first.
 */
export async function alignFromLayer(page: Page, at: number | Locator = 0): Promise<void> {
	const row = await openLayerRow(page, at);
	await row.getByTestId('align-map-image').click();
}
