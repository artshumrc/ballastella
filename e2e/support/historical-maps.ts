// Driving the one way a Historical Map gets into a Project (ticket 06).
//
// **Why every suite needs this and did not before.** The file input used to sit in the Project's
// sidebar, so a spec could reach it the moment the screen was up. Ticket 06 makes adding a map one
// affordance offering three sources — a file, a library, or a map this Workspace already holds — and
// the three of them live in a dialog, because the sidebar is a 24rem column and the library flow
// alone is a form, a rights statement and a scrolling canvas list. So the step this file adds is a
// real one a user takes: the sources are reached by pressing the button that offers them.
//
// It matters that this is written once. Twelve suites drove the old input by its label, and a
// helper is what keeps the next change to this flow from being 95% done — which is exactly what
// ticket 16 left behind and `pnpm check` could not see.

import { expect, type Locator, type Page } from './test.js';

/** The sidebar's one add affordance. */
export const addHistoricalMapButton = (page: Page): Locator =>
	page.getByTestId('add-historical-map');

/** The `<dialog>` itself, found by something only it contains. */
const addDialog = (page: Page): Locator =>
	page.locator('dialog').filter({ has: page.getByTestId('add-from-file') });

/**
 * Whether the dialog is **open**, asked of the element rather than of its appearance.
 *
 * ⚠ **Measured, and the reason this is not `isVisible()`.** daisyUI's `.modal` animates: a closing
 * dialog spends ~300 ms translating and fading while still laid out, so `isVisible()` answers `true`
 * for a dialog that is on its way out and `false` a moment later. A caller that asked that question
 * filled the URL field of a dialog that was closing and then waited its whole timeout to click the
 * button beside it — "element is not stable", twice, then "element is not visible", 111 times.
 * `HTMLDialogElement.open` is the fact, and it flips exactly when `close()` is called.
 */
export const addHistoricalMapIsOpen = (page: Page): Promise<boolean> =>
	addDialog(page)
		.evaluate((element) => (element as HTMLDialogElement).open)
		.catch(() => false);

/**
 * Open the dialog and wait until all three sources are on screen.
 *
 * The three assertions are the ticket's contract, made on every open rather than once in a single
 * spec: a source that quietly stopped rendering would otherwise show up as a puzzling timeout in
 * whichever suite happened to use it next.
 */
export async function openAddHistoricalMap(page: Page): Promise<Locator> {
	await addHistoricalMapButton(page).click();
	const dialog = addDialog(page);
	// The element's own state first, so none of what follows can be satisfied by a dialog that is
	// merely still painted. See {@link addHistoricalMapIsOpen}.
	await expect.poll(() => addHistoricalMapIsOpen(page)).toBe(true);
	await expect(dialog.getByLabel('Add a Historical Map from a file')).toBeVisible();
	await expect(dialog.getByTestId('remote-url')).toBeVisible();
	await expect(dialog.getByRole('heading', { name: 'Already in this Workspace' })).toBeVisible();
	return dialog;
}

/** The dialog, opening it first if a successful add has closed it. */
export async function ensureAddHistoricalMapOpen(page: Page): Promise<Locator> {
	if (await addHistoricalMapIsOpen(page)) return addDialog(page);
	return openAddHistoricalMap(page);
}

/** What Playwright needs to stand in for a file the user picked. */
export interface PickedFile {
	name: string;
	mimeType: string;
	buffer: Buffer;
}

/**
 * Pick a file, from the dialog, exactly as a user does.
 *
 * Returns once the pick has been made — **not** once the pyramid is written. What happens next is
 * the point of the ticket and belongs to the caller: the dialog closes, a card appears at the top of
 * the stack, and it reports its own preparation until the Layer takes its place.
 */
export async function pickHistoricalMapFile(page: Page, file: PickedFile): Promise<void> {
	const dialog = await openAddHistoricalMap(page);
	await dialog.getByLabel('Add a Historical Map from a file').setInputFiles(file);
}

/**
 * Add a Historical Map from a file and wait until its Layer is in the stack.
 *
 * The wait is on the **preparing card being gone**, not only on a row being there: a row and a card
 * are both in the `<ol>` while an ingest runs, so a spec that went on as soon as it saw one row
 * would sometimes be looking at the card.
 */
export async function addHistoricalMapFromFile(
	page: Page,
	file: PickedFile,
	options: { layers?: number; timeout?: number } = {}
): Promise<void> {
	const { layers = 1, timeout = 30_000 } = options;
	await pickHistoricalMapFile(page, file);
	await expect(page.getByTestId('layer-row')).toHaveCount(layers, { timeout });
	await expect(page.getByTestId('preparing-layer')).toHaveCount(0, { timeout });
}

/** The card of the Historical Map being prepared right now, at the top of the stack. */
export const preparingCard = (page: Page): Locator => page.getByTestId('preparing-layer');

/** Nothing is being prepared any more. The honest "the ingest is over" wait. */
export const expectNothingPreparing = (page: Page, timeout = 60_000): Promise<void> =>
	expect(preparingCard(page)).toHaveCount(0, { timeout });
