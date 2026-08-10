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
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⚠ THIS FILE ONCE CLAIMED A BUG FIXED THAT IT HAD ONLY HALF FIXED. READ {@link settle} BEFORE
// ADDING ANYTHING HERE THAT ASKS WHETHER THE DIALOG IS OPEN.
//
// The first fix replaced an `isVisible()` question with `HTMLDialogElement.open`, and said so as
// though that were the end of it. It was not: the suite went on failing at roughly one full run in
// three for another epic, with the same signature — "element is not stable", twice, then "element
// is not visible", hundreds of times, on a control in a dialog the suite believed was open.
//
// `.open` was never the wrong *fact*. It was the wrong *question*. It answers "is this dialog open
// at this instant", and the callers here all meant "is this dialog mine to use". Those come apart
// for as long as an add is being written, and that window is where the whole defect lived.

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
 *
 * ⚠ **And it is still not enough on its own, which the fix above this one did not know.** `.open`
 * is the truth about *this instant*; it says nothing about a close that has already been decided
 * and is waiting on a write. See {@link settle}, which is what every caller here goes through
 * first, and do not ask this question without it.
 */
export const addHistoricalMapIsOpen = (page: Page): Promise<boolean> =>
	addDialog(page)
		.evaluate((element) => (element as HTMLDialogElement).open)
		.catch(() => false);

/**
 * Whether the dialog is part-way through something — a lookup, or an add that is still being
 * written.
 *
 * Read off the controls' own `disabled`, which is the application's `busy` (`AddRemoteMap`'s
 * `step`) and its `adding` (the Workspace picker's one-at-a-time guard) rather than a sentence
 * that could be reworded out from under this file.
 */
const addInFlight = (page: Page): Promise<boolean> =>
	page.evaluate(() => {
		const look = document.querySelector('[data-testid="remote-read"]');
		if (look instanceof HTMLButtonElement && look.disabled) return true;
		return document.querySelector('[data-testid="workspace-map"]:disabled') !== null;
	});

/**
 * Wait until no add is part-way through, before asking anything about the dialog.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ⚠ **THE DIALOG IS OPEN FOR A WHILE AFTER THE ADD IT IS DOING HAS VISIBLY SUCCEEDED, AND THAT
 * WINDOW IS WHAT MADE THIS SUITE FLAKE.**
 *
 * `EditorSession.#addMapLayer` publishes the new Layer into `openProject` — which renders the
 * `layer-row` a caller is waiting for — and only *then* awaits the trailing `project.json` write.
 * The dialog closes at the end of that write, by way of `AddRemoteMap`'s `onadded`. So there is a
 * window in which the add is done as far as the screen is concerned and the dialog is open with a
 * close already committed to it.
 *
 * **Measured, twice, rather than reasoned about.** On an idle box, an in-page `MutationObserver`
 * timed the `layer-row` at 597.2 ms and the dialog closing at 632.2 ms: a **35 ms** window. Under
 * `Emulation.setCPUThrottlingRate` at 20×, a caller that returned the moment the row appeared —
 * which is exactly what `addReferenced` in `editor-align-referenced.e2e.ts` does — then asked
 * {@link addHistoricalMapIsOpen} and was answered **`true`**.
 *
 * What followed is the failure this file's `.open` fix was supposed to have ended, and did not:
 * {@link ensureAddHistoricalMapOpen} took that `true` and handed back the dialog *without
 * re-opening it*; `fill` on the URL waited out the `disabled` and landed during daisyUI's ~300 ms
 * fade; and the click beside it reported "element is not stable" twice and then "element is not
 * visible" for 172 seconds, on a button that was present, laid out, and inside a dialog that had
 * shut. Nothing ever re-opened it, because as far as the suite was concerned it had never closed.
 *
 * `.open` was not wrong. It was answering a different question from the one the caller meant.
 */
const settle = (page: Page): Promise<void> =>
	expect.poll(() => addInFlight(page), { timeout: 30_000 }).toBe(false);

/**
 * Open the dialog and wait until all three sources are on screen.
 *
 * The three assertions are the ticket's contract, made on every open rather than once in a single
 * spec: a source that quietly stopped rendering would otherwise show up as a puzzling timeout in
 * whichever suite happened to use it next.
 */
export async function openAddHistoricalMap(page: Page): Promise<Locator> {
	// **No {@link settle} here, and that is a measurement rather than an omission.** This clicks the
	// sidebar button, which an open modal intercepts — so this function is only reachable with the
	// dialog shut, and a shut dialog has no add in flight: every source closes the dialog at the
	// *end* of its add. A wait here would be a guard no run could exercise, which is the shape the
	// last version of this fix took. The wait belongs at the one door that can be answered by an
	// open dialog, which is {@link ensureAddHistoricalMapOpen}.
	await addHistoricalMapButton(page).click();
	const dialog = addDialog(page);
	// The element's own state first, so none of what follows can be satisfied by a dialog that is
	// merely still painted. See {@link addHistoricalMapIsOpen}.
	await expect.poll(() => addHistoricalMapIsOpen(page)).toBe(true);
	await expect(dialog.getByLabel('Add a Historical Map from a file')).toBeVisible();
	await expect(dialog.getByTestId('remote-url')).toBeVisible();
	// **A heading each, as well as a control each.** "Three sources, equally visible" is partly
	// about the headings that name them: `editor-remote-iiif.e2e.ts` used to pin "Add a Historical
	// Map from a library" and stopped when the flow moved in here, so a source that quietly lost
	// its own name — folded under another heading, or left with a control and no label — would
	// have satisfied every remaining assertion.
	await expect(dialog.getByRole('heading', { name: 'From a file on this computer' })).toBeVisible();
	await expect(
		dialog.getByRole('heading', { name: 'Add a Historical Map from a library' })
	).toBeVisible();
	await expect(dialog.getByRole('heading', { name: 'Already in this Workspace' })).toBeVisible();
	return dialog;
}

/**
 * The dialog, opening it first if a successful add has closed it.
 *
 * ⚠ **The wait is the whole of this function's correctness, not politeness.** "Open right now" and
 * "open, and still yours a moment from now" are different facts while an add is being written, and
 * this used to return the first when its caller meant the second. {@link settle} carries the
 * measurement and the failure it produced.
 */
export async function ensureAddHistoricalMapOpen(page: Page): Promise<Locator> {
	await settle(page);
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
